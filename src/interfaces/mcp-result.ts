import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { canonicalJsonStringify, captureCanonicalJson, type CanonicalJson } from "../core/client.js";
import { activityToolContracts, exchangeToolContracts } from "./exchange-tool-contracts.js";
import {createOperationToolResultDescriptor, operationToolResultMetadataKey,
  presentationSnapshotResourceLink, type PresentationSnapshotResource} from "./mcp-app/contracts.js";

// These existing bindings own the nullable successes. Schema projection,
// serialization and View admission consume this same transport definition.
const nullableSuccessTransports = Object.freeze([
  ...Object.values(activityToolContracts), ...Object.values(exchangeToolContracts),
].filter(({ contract }) => contract.successSchema.safeParse(null).success).map(({ contract, mcp }) => ({
  toolName: mcp.name,
  canonicalSchema: contract.successSchema,
  wireSchema: z.object({ value: contract.successSchema as z.ZodType }).strict(),
})));

export const projectMcpSuccessSchema = (schema: z.ZodType): z.ZodType =>
  nullableSuccessTransports.find((transport) => transport.canonicalSchema === schema)?.wireSchema ?? schema;

const canonicalObject = (value: CanonicalJson): Readonly<Record<string, CanonicalJson>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MCP structured content must be an object.");
  }
  return value as Readonly<Record<string, CanonicalJson>>;
};

export const admitMcpToolResultValue = (
  toolName: string,
  structuredContent: unknown,
  isError: boolean,
): CanonicalJson => {
  const wire = canonicalObject(captureCanonicalJson(structuredContent));
  if (isError || !nullableSuccessTransports.some((transport) => transport.toolName === toolName)) return wire;
  if (Object.keys(wire).length !== 1 || !Object.hasOwn(wire, "value")) {
    throw new TypeError("The nullable MCP success envelope is invalid.");
  }
  return wire["value"]!;
};

export const createMcpToolResult = (
  toolName: string,
  value: CanonicalJson,
  isError: boolean,
  successText?: string,
): CallToolResult => {
  const wire = !isError && nullableSuccessTransports.some((transport) => transport.toolName === toolName)
    ? { value }
    : canonicalObject(value);
  return {
    ...(isError ? { isError: true } : {}),
    structuredContent: wire,
    content: [{ type: "text", text: successText ?? canonicalJsonStringify(wire) }],
  };
};

export const withOperationToolResultDescriptor = (toolName: string, normalizedInput: unknown, result: CallToolResult): CallToolResult => {
  if (result._meta?.[operationToolResultMetadataKey] !== undefined) throw new TypeError("Operation result descriptor is duplicated.");
  const descriptor = createOperationToolResultDescriptor({toolName, normalizedInput,
    result: admitMcpToolResultValue(toolName, result.structuredContent, result.isError === true), isError: result.isError === true});
  return Object.freeze({...result, _meta: Object.freeze({...result._meta, [operationToolResultMetadataKey]: descriptor})});
};

// A source reference is a sibling transport, never a canonical nullable result.
export const createMcpSnapshotResult = (resource: PresentationSnapshotResource): CallToolResult => ({
  structuredContent: captureCanonicalJson(resource) as Record<string, CanonicalJson>,
  content: [{type: "text", text: canonicalJsonStringify(captureCanonicalJson(resource))}, presentationSnapshotResourceLink(resource)],
});

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
