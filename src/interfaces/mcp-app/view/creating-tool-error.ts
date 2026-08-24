import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  applicationFailureSchema,
  canonicalJsonStringify,
  captureCanonicalJson,
} from "../../../core/client.js";
import {
  admitMcpToolResultDeliveryError,
  admitMcpToolResultDeliveryErrorContent,
} from "../../mcp-result.js";
import { codexViewHostName } from "./host-identities.js";

export interface AdmittedCreatingToolError {
  readonly message: string;
}

const genericToolError = Object.freeze({
  message: "The tool call ended with an error before a displayable result was available.",
});

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
};

const exactText = (value: unknown): string | undefined => {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const content = value[0] as unknown;
  if (
    typeof content !== "object" || content === null || Array.isArray(content) ||
    !exactKeys(content, ["text", "type"])
  ) return undefined;
  const record = content as Readonly<Record<string, unknown>>;
  return record["type"] === "text" && typeof record["text"] === "string"
    ? record["text"]
    : undefined;
};

const admitCodexApplicationFailure = (
  result: CallToolResult,
): AdmittedCreatingToolError | undefined => {
  if (!exactKeys(result, ["content", "structuredContent"])) return undefined;
  const text = exactText(result.content);
  if (text === undefined) return undefined;
  try {
    const value = captureCanonicalJson(result.structuredContent);
    if (!applicationFailureSchema.safeParse(value).success) return undefined;
    return canonicalJsonStringify(value) === text ? genericToolError : undefined;
  } catch {
    return undefined;
  }
};

export const admitCreatingToolError = (
  hostName: string | undefined,
  result: CallToolResult,
): AdmittedCreatingToolError | undefined => {
  if (result.isError === true) {
    return admitMcpToolResultDeliveryError(result) ?? genericToolError;
  }
  if (hostName !== codexViewHostName) return undefined;
  if (exactKeys(result, ["content"])) {
    return admitMcpToolResultDeliveryErrorContent(result.content);
  }
  return admitCodexApplicationFailure(result);
};
