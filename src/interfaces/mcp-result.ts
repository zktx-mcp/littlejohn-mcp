import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const maximumMcpToolResultUtf8Bytes = 1_048_575 as const;

const deliveryTooLargeMessage =
  "Little John could not deliver this MCP result because it exceeds the supported response size.";
const deliveryTooLargeResult: CallToolResult = {
  isError: true,
  content: [{
    type: "text" as const,
    text: deliveryTooLargeMessage,
  }],
};
Object.freeze(deliveryTooLargeResult.content[0]);
Object.freeze(deliveryTooLargeResult.content);
Object.freeze(deliveryTooLargeResult);

export type McpToolResultDelivery =
  | Readonly<{ status: "admitted"; result: CallToolResult }>
  | Readonly<{ status: "too_large"; result: CallToolResult }>;

export interface AdmittedMcpToolResultDeliveryError {
  readonly message: string;
}

const admittedDeliveryTooLargeError: AdmittedMcpToolResultDeliveryError = Object.freeze({
  message: deliveryTooLargeMessage,
});
const utf8Encoder = new TextEncoder();

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
};

const serializedUtf8Bytes = (result: CallToolResult): number => {
  const serialized = JSON.stringify(result);
  if (typeof serialized !== "string") throw new TypeError("MCP tool result is not serializable.");
  return utf8Encoder.encode(serialized).length;
};

if (serializedUtf8Bytes(deliveryTooLargeResult) > maximumMcpToolResultUtf8Bytes) {
  throw new TypeError("MCP delivery-size error exceeds its own boundary.");
}

export const admitMcpToolResultForDelivery = (
  result: CallToolResult,
): McpToolResultDelivery => serializedUtf8Bytes(result) <= maximumMcpToolResultUtf8Bytes
  ? Object.freeze({ status: "admitted", result })
  : Object.freeze({ status: "too_large", result: deliveryTooLargeResult });

export const admitMcpToolResultDeliveryError = (
  result: CallToolResult,
): AdmittedMcpToolResultDeliveryError | undefined => {
  if (
    !exactKeys(result, ["content", "isError"]) ||
    result.isError !== true ||
    !Array.isArray(result.content) ||
    result.content.length !== 1
  ) return undefined;
  return admitMcpToolResultDeliveryErrorContent(result.content);
};

export const admitMcpToolResultDeliveryErrorContent = (
  value: unknown,
): AdmittedMcpToolResultDeliveryError | undefined => {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const content = value[0] as unknown;
  return typeof content === "object" && content !== null && !Array.isArray(content) &&
    exactKeys(content, ["text", "type"]) &&
    (content as Readonly<Record<string, unknown>>)["type"] === "text" &&
    (content as Readonly<Record<string, unknown>>)["text"] === deliveryTooLargeMessage
    ? admittedDeliveryTooLargeError
    : undefined;
};
