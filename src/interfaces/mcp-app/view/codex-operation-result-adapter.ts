import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  utf8ByteLength,
  type CanonicalJson,
} from "../../../core/client.js";
import {
  admitOperationToolResultDescriptor,
  operationToolResultEvidence,
  operationToolResultMetadataKey,
  type OperationToolResultDescriptor,
} from "../contracts.js";
import { codexViewHostName } from "./host-identities.js";
import { admitMcpToolResultValue, maximumMcpToolResultUtf8Bytes } from "../../mcp-result.js";

const oneText = (content: unknown): string | undefined => {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const item = content[0] as unknown;
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const record = item as Readonly<Record<string, unknown>>;
  return record["type"] === "text" && typeof record["text"] === "string"
    ? record["text"]
    : undefined;
};

const canonicalTextValue = (content: unknown): CanonicalJson | undefined => {
  const text = oneText(content);
  if (text === undefined) return undefined;
  // This text is contained in the bounded server result; check before parsing.
  if (utf8ByteLength(text) > maximumMcpToolResultUtf8Bytes) {
    throw new TypeError("The Codex operation result text exceeds its source bound.");
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return undefined; }
  const admitted = captureCanonicalJson(value);
  return canonicalJsonStringify(admitted) === text ? admitted : undefined;
};

const removeObjectNullProperties = (
  value: CanonicalJson,
): Readonly<{ value: CanonicalJson; omissions: number }> => {
  if (Array.isArray(value)) {
    let omissions = 0;
    const entries = value.map((entry) => {
      const projected = removeObjectNullProperties(entry);
      omissions += projected.omissions;
      return projected.value;
    });
    return Object.freeze({ value: entries, omissions });
  }
  if (value === null || typeof value !== "object") {
    return Object.freeze({ value, omissions: 0 });
  }
  let omissions = 0;
  const output: Record<string, CanonicalJson> = Object.create(null) as Record<string, CanonicalJson>;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) {
      omissions += 1;
      continue;
    }
    const projected = removeObjectNullProperties(entry);
    omissions += projected.omissions;
    output[key] = projected.value;
  }
  return Object.freeze({ value: output, omissions });
};

const descriptorMatches = (
  descriptor: OperationToolResultDescriptor,
  toolName: string,
  inputEvidence: Readonly<{ utf8Bytes: number; sha256: string }>,
  candidate: CanonicalJson,
  isError: boolean,
): boolean => {
  const resultEvidence = operationToolResultEvidence(candidate);
  return descriptor.toolName === toolName &&
    descriptor.inputUtf8Bytes === inputEvidence.utf8Bytes &&
    descriptor.inputSha256 === inputEvidence.sha256 &&
    descriptor.resultUtf8Bytes === resultEvidence.utf8Bytes &&
    descriptor.resultSha256 === resultEvidence.sha256 &&
    descriptor.isError === isError;
};

export const recoverCodexOperationToolResult = (input: Readonly<{
  hostName: string | undefined;
  toolName: string;
  inputEvidence: Readonly<{ utf8Bytes: number; sha256: string }>;
  result: CallToolResult;
}>): CanonicalJson => {
  if (input.hostName !== codexViewHostName) {
    throw new TypeError("The operation result failed standard admission.");
  }

  const descriptorValue = input.result._meta?.[operationToolResultMetadataKey];
  if (descriptorValue === undefined) {
    throw new TypeError("The Codex operation result omitted its descriptor.");
  }
  const descriptor = admitOperationToolResultDescriptor(descriptorValue);
  const outerIsError = input.result.isError === true;
  if (descriptor.isError !== outerIsError) {
    throw new TypeError("The Codex operation result changed error meaning.");
  }

  const wire = canonicalTextValue(input.result.content);
  if (wire === undefined) {
    throw new TypeError("The Codex operation result has no complete measured carrier.");
  }
  const canonical = admitMcpToolResultValue(input.toolName, wire, outerIsError);
  if (!descriptorMatches(descriptor, input.toolName, input.inputEvidence, canonical, outerIsError)) {
    throw new TypeError("The Codex operation result does not match its descriptor.");
  }

  const delivered = captureCanonicalJson(input.result.structuredContent);
  const projected = removeObjectNullProperties(wire);
  if (
    projected.omissions < 1 ||
    canonicalJsonStringify(projected.value) !== canonicalJsonStringify(delivered)
  ) throw new TypeError("The Codex operation result changed more than object null properties.");

  // This reverses only the measured accidental Host transform. The descriptor
  // correlates carriers inside the already admitted Host boundary; it is not a
  // signature, MAC, or authentication of the Host.
  return canonical;
};
