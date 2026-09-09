import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type CanonicalJson,
} from "../../../core/client.js";
import {
  admitOperationToolResultDescriptor,
  operationToolResultEvidence,
  operationToolResultMetadataKey,
  type OperationToolResultDescriptor,
} from "../contracts.js";
import { codexViewHostName } from "./host-identities.js";

const callToolResultKeys = new Set(["_meta", "content", "isError", "structuredContent"]);

type ResultEnvelope = Readonly<{
  content: CallToolResult["content"];
  structuredContent: unknown;
  isError?: boolean | undefined;
  _meta?: Readonly<Record<string, unknown>> | undefined;
}>;

const oneText = (content: unknown): string | undefined => {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const item = content[0] as unknown;
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const record = item as Readonly<Record<string, unknown>>;
  return record["type"] === "text" && typeof record["text"] === "string"
    ? record["text"]
    : undefined;
};

const parseExactWrapper = (result: CallToolResult): ResultEnvelope | undefined => {
  const text = oneText(result.content);
  if (text === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    !Object.keys(record).every((key) => callToolResultKeys.has(key)) ||
    !Array.isArray(record["content"]) ||
    !("structuredContent" in record) ||
    (record["isError"] !== undefined && typeof record["isError"] !== "boolean") ||
    (record["_meta"] !== undefined &&
      (typeof record["_meta"] !== "object" || record["_meta"] === null ||
        Array.isArray(record["_meta"])))
  ) return undefined;
  return record as ResultEnvelope;
};

const resultIsError = (result: Readonly<{ isError?: boolean | undefined }>): boolean =>
  result.isError === true;

const descriptorFrom = (envelope: Readonly<{
  _meta?: Readonly<Record<string, unknown>> | undefined;
}> | undefined):
OperationToolResultDescriptor | undefined => {
  const value = envelope?._meta?.[operationToolResultMetadataKey];
  return value === undefined ? undefined : admitOperationToolResultDescriptor(value);
};

const uniqueDescriptor = (
  result: CallToolResult,
  wrapper: ResultEnvelope | undefined,
): OperationToolResultDescriptor => {
  const descriptors = [descriptorFrom(result), descriptorFrom(wrapper)]
    .filter((value): value is OperationToolResultDescriptor => value !== undefined);
  if (descriptors.length === 0 || descriptors[0] === undefined) {
    throw new TypeError("The Codex operation result omitted its descriptor.");
  }
  const expected = canonicalJsonStringify(captureCanonicalJson(descriptors[0]));
  if (descriptors.some((descriptor) =>
    canonicalJsonStringify(captureCanonicalJson(descriptor)) !== expected)) {
    throw new TypeError("The Codex operation result carried conflicting descriptors.");
  }
  return descriptors[0];
};

const canonicalTextValue = (content: unknown): CanonicalJson | undefined => {
  const text = oneText(content);
  if (text === undefined) return undefined;
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

  const wrapper = parseExactWrapper(input.result);
  const descriptor = uniqueDescriptor(input.result, wrapper);
  const outerIsError = resultIsError(input.result);
  if (descriptor.isError !== outerIsError) {
    throw new TypeError("The Codex operation result changed error meaning.");
  }

  const candidates: Readonly<{
    value: CanonicalJson;
    envelope: ResultEnvelope | CallToolResult;
  }>[] = [];
  if (wrapper !== undefined) {
    try {
      candidates.push({
        value: captureCanonicalJson(wrapper.structuredContent),
        envelope: wrapper,
      });
    } catch {
      // Continue to the exact canonical text carried by the same wrapper.
    }
  }
  const textValue = canonicalTextValue(wrapper?.content ?? input.result.content);
  if (textValue !== undefined) {
    candidates.push({ value: textValue, envelope: wrapper ?? input.result });
  }
  const selected = candidates.find((candidate) =>
    resultIsError(candidate.envelope) === outerIsError &&
    descriptorMatches(
      descriptor,
      input.toolName,
      input.inputEvidence,
      candidate.value,
      outerIsError,
    ));
  if (selected === undefined) {
    throw new TypeError("The Codex operation result has no complete measured carrier.");
  }

  const delivered = captureCanonicalJson(input.result.structuredContent);
  const projected = removeObjectNullProperties(selected.value);
  if (
    projected.omissions < 1 ||
    canonicalJsonStringify(projected.value) !== canonicalJsonStringify(delivered)
  ) throw new TypeError("The Codex operation result changed more than object null properties.");

  // This reverses only the measured accidental Host transform. The descriptor
  // correlates carriers inside the already admitted Host boundary; it is not a
  // signature, MAC, or authentication of the Host.
  return selected.value;
};
