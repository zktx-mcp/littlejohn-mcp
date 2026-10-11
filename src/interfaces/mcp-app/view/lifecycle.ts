import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolRequest,
  CallToolResult,
  Implementation,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  applicationFailureSchema,
  canonicalJsonStringify,
  captureCanonicalJson,
  sha256Bytes,
  utf8ByteLength,
  type CanonicalJson, type ApplicationFailure,
} from "../../../core/client.js";
import {
  admitPresentationSnapshotResource,
  bytesFromCanonicalBase64,
  presentationMcpTools,
  presentationSnapshotChunkSchema,
  presentationSnapshotResourceMimeType,
  presentationUnavailableSchema,
  presentationReadFailureSchema,
  operationToolInputEvidence,
  type PresentationSnapshotResource,
} from "../contracts.js";
import {
  presentationContractRegistry,
  assertPresentationSource,
  type PresentationContractEntry,
} from "../registry.js";
import { admitToolReply, applicationIssue, registeredFailure, type ViewResult, type ViewIssue } from "./tool-result.js";
import { claudeViewHostName, codexViewHostName } from "./host-identities.js";
import { cardReferenceSchema, cardIdFromPresentationUri, presentationCardMetadataKey,
  presentationCardUriPrefix, cardCreationResultSchema, type CardRecord } from "../card-contract.js";
import { admitMcpToolResultDeliveryErrorContent, maximumMcpToolResultUtf8Bytes } from "../../mcp-result.js";

export interface AdmittedPresentation {
  readonly entry: PresentationContractEntry;
  readonly normalizedInput: CanonicalJson;
  readonly result: CanonicalJson;
}

export type PresentationToolResultAdmission =
  | Readonly<{ status: "card"; card: CreatingCard }>
  | Readonly<{
      status: "tool_error";
      message: string;
      failure?: ApplicationFailure;
    }>;

export const sameCreatingResult = (left: PresentationToolResultAdmission, right: PresentationToolResultAdmission): boolean =>
  left.status === "card" && right.status === "card" ? left.card.cardId === right.card.cardId
    : left.status === "tool_error" && right.status === "tool_error" &&
      canonicalJsonStringify(captureCanonicalJson(left)) === canonicalJsonStringify(captureCanonicalJson(right));

export interface PresentationViewApp {
  getHostCapabilities(): Readonly<{
    readonly serverResources?: unknown;
    readonly serverTools?: unknown;
    readonly openLinks?: Readonly<Record<string, never>>;
  }> | undefined;
  getHostVersion(): Implementation | undefined;
  callServerTool(
    params: CallToolRequest["params"],
    options?: RequestOptions,
  ): Promise<CallToolResult>;
  openLink?(params: Readonly<{ url: string }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{ isError?: boolean | undefined; [key: string]: unknown }>>;
  readServerResource(
    params: ReadResourceRequest["params"],
    options?: RequestOptions,
  ): Promise<ReadResourceResult>;
}

const exactBytes = (value: CanonicalJson): Uint8Array =>
  new TextEncoder().encode(canonicalJsonStringify(value));

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const canonicalFromBytes = (bytes: Uint8Array): CanonicalJson => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = captureCanonicalJson(JSON.parse(text));
  if (canonicalJsonStringify(value) !== text) {
    throw new TypeError("Presentation result bytes are not canonical JSON.");
  }
  return value;
};

export interface CreatingCard {
  readonly cardId: string;
}

type CreatingEnvelope = Readonly<{
  content: CallToolResult["content"];
  structured: unknown;
  metadata: Record<string, unknown> | undefined;
  isError: boolean | undefined;
  keys: readonly string[];
}>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: object, key: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (property === undefined) return undefined;
  if (!("value" in property)) throw new TypeError("Creating fields must be data properties.");
  return property.value;
};
const optionalEnvelopeKeys = new Set(["structuredContent", "_meta", "isError"]);
const creatingEnvelope = (value: unknown): CreatingEnvelope => {
  if (!record(value)) throw new TypeError("A creating response object is required.");
  const fields = { content: own(value, "content"), structuredContent: own(value, "structuredContent"),
    _meta: own(value, "_meta"), isError: own(value, "isError") };
  const checked = CallToolResultSchema.parse(fields);
  return { content: checked.content, structured: fields.structuredContent,
    metadata: checked._meta, isError: checked.isError,
    // Unknown fields still prevent the exact missing-error adapter, but their
    // values are not read, copied, or treated as canonical product data.
    keys: Object.keys(value).filter(key => !optionalEnvelopeKeys.has(key) || own(value, key) !== undefined).sort() };
};
const exactEnvelopeKeys = (value: CreatingEnvelope, expected: readonly string[]): boolean =>
  value.keys.length === expected.length && value.keys.every((key, index) => key === expected[index]);
const parseCreatingText = (text: string): Readonly<{ parsed: true; value: unknown } | { parsed: false }> => {
  if (utf8ByteLength(text) > maximumMcpToolResultUtf8Bytes) throw new TypeError("Creating text exceeds its source bound.");
  try { return { parsed: true, value: JSON.parse(text) as unknown }; }
  catch { return { parsed: false }; }
};
const isCreatingWrapper = (value: unknown): value is Record<string, unknown> =>
  record(value) && Object.hasOwn(value, "content");
const sameCanonical = (left: unknown, right: unknown): boolean =>
  canonicalJsonStringify(captureCanonicalJson(left)) === canonicalJsonStringify(captureCanonicalJson(right));
const genericCreatingError = Object.freeze({ status: "tool_error" as const,
  message: "The tool call ended with an error before a displayable result was available." });
const creatingFailure = (value: unknown): PresentationToolResultAdmission => {
  const failure = registeredFailure(value);
  return failure === undefined ? genericCreatingError : {status: "tool_error", message: failure.error.message, failure};
};
const exactErrorText = (envelope: CreatingEnvelope): string | undefined => {
  if (envelope.content.length !== 1) return undefined;
  const item = envelope.content[0]!;
  if (item.type !== "text" || Object.keys(item).sort().join(",") !== "text,type") return undefined;
  return item.text;
};

export const assertCreatingCardState = (creating: CreatingCard, record: CardRecord): void => {
  if (record.cardId !== creating.cardId) throw new TypeError("Saved card differs from its creating reference.");
};

const reconstructResult = async (
  app: PresentationViewApp,
  resource: PresentationSnapshotResource,
  signal: AbortSignal,
): Promise<ViewResult<CanonicalJson>> => {
  if (!app.getHostCapabilities()?.serverTools) {
    throw new TypeError("The Host cannot read exact presentation chunks.");
  }
  const descriptor = resource.descriptor;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < descriptor.resultChunkCount; index += 1) {
    const input = { snapshotUri: descriptor.snapshotUri, index };
    const response = await app.callServerTool({ name: presentationMcpTools.getSnapshotChunk, arguments: input }, { signal });
    const admitted = admitToolReply(response, { hostName: app.getHostVersion()?.name,
      toolName: presentationMcpTools.getSnapshotChunk, inputEvidence: operationToolInputEvidence(input) }, {
      success: (value) => {
        const unavailable = presentationUnavailableSchema.safeParse(value);
        return unavailable.success ? unavailable.data : presentationSnapshotChunkSchema.parse(value);
      },
      failure: (value) => applicationIssue(presentationReadFailureSchema.parse(value)),
    });
    if (!admitted.ok) return admitted;
    if (admitted.value.kind === "presentation_unavailable") return { ok: false, issue: { kind: "presentation", unavailable: admitted.value } };
    const chunk = admitted.value;
    if (chunk.snapshotId !== descriptor.snapshotId || chunk.index !== index) {
      throw new TypeError("Presentation chunk identity is inconsistent.");
    }
    const bytes = bytesFromCanonicalBase64(chunk.canonicalBase64);
    const expected = index + 1 === descriptor.resultChunkCount
      ? descriptor.resultUtf8Bytes - descriptor.resultChunkBytes * index
      : descriptor.resultChunkBytes;
    if (bytes.length !== expected) throw new TypeError("Presentation chunk length is inconsistent.");
    chunks.push(bytes);
    total += bytes.length;
  }
  if (total !== descriptor.resultUtf8Bytes) {
    throw new TypeError("Presentation result length is inconsistent.");
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  if (sha256Bytes(joined) !== descriptor.resultSha256) {
    throw new TypeError("Presentation result digest is inconsistent.");
  }
  return { ok: true, value: canonicalFromBytes(joined) };
};

// One admission owns creating-envelope interpretation, supplied-copy agreement,
// failure precedence and exact card identity. It never reads saved state.
export const admitPresentationToolResult = async (
  app: PresentationViewApp,
  result: CallToolResult,
  _signal: AbortSignal,
): Promise<PresentationToolResultAdmission> => {
  const host = app.getHostVersion()?.name;
  const outer = creatingEnvelope(result);
  const first = outer.content[0];
  let inner: CreatingEnvelope | undefined;
  if (host === codexViewHostName && outer.content.length === 1 && first?.type === "text") {
    const text = parseCreatingText(first.text);
    if (text.parsed && isCreatingWrapper(text.value)) inner = creatingEnvelope(text.value);
  }
  const envelopes = inner === undefined ? [outer] : [outer, inner];
  const content = inner?.content ?? outer.content;
  if (outer.isError !== undefined && inner?.isError !== undefined && outer.isError !== inner.isError) {
    throw new TypeError("Creating error flags differ.");
  }
  const isError = envelopes.some(envelope => envelope.isError === true);
  const ids: string[] = [];
  const values: unknown[] = envelopes.flatMap(envelope => envelope.structured === undefined ? [] : [envelope.structured]);
  const texts: string[] = [];
  let links = 0;
  for (const envelope of envelopes) {
    const metadata = envelope.metadata;
    const raw = metadata === undefined ? undefined : own(metadata, presentationCardMetadataKey);
    if (raw === undefined) continue;
    const reference = cardReferenceSchema.parse(captureCanonicalJson(raw));
    if (reference.kind !== "card") throw new TypeError("A creating card reference is required.");
    ids.push(reference.cardId);
  }
  for (const item of content) {
    if (item.type === "resource_link") {
      if (!item.uri.startsWith(presentationCardUriPrefix)) continue;
      const id = cardIdFromPresentationUri(item.uri);
      if (item.mimeType !== presentationSnapshotResourceMimeType || item.name !== `presentation_card_${id}`) {
        throw new TypeError("Card resource identity or type differs.");
      }
      ids.push(id); links++;
    } else if (item.type === "text") {
      if (host === claudeViewHostName && item.text.startsWith("presentation_card_")) {
        const match = /^presentation_card_([A-Za-z0-9_-]{43}): (littlejohn:\/\/presentation\/cards\/[A-Za-z0-9_-]{43})$/u.exec(item.text);
        if (match === null || match[0] !== item.text || cardIdFromPresentationUri(match[2]!) !== match[1]) {
          throw new TypeError("Card link name and URI differ.");
        }
        ids.push(match[1]!); links++; continue;
      }
      const text = parseCreatingText(item.text);
      if (text.parsed && isCreatingWrapper(text.value)) throw new TypeError("A nested or mixed creating wrapper is not admitted.");
      if (text.parsed) values.push(text.value);
      else texts.push(item.text);
    }
  }
  if (links > 1) throw new TypeError("Creating card links are duplicated.");
  if (values.length > 1 && values.slice(1).some(value => !sameCanonical(values[0], value))) {
    throw new TypeError("Creating result copies differ.");
  }
  const value = values[0];
  if (isError) {
    if (ids.some(id => id !== ids[0])) throw new TypeError("Creating card references differ.");
    if (values.some(candidate => cardCreationResultSchema.safeParse(candidate).success)) {
      throw new TypeError("A creating error cannot carry a successful acknowledgement.");
    }
    for (const envelope of envelopes) {
      if (envelope.isError === true && exactEnvelopeKeys(envelope, ["content", "isError"])) {
        const delivery = admitMcpToolResultDeliveryErrorContent(envelope.content);
        if (delivery !== undefined) return {status: "tool_error", message: delivery.message};
      }
    }
    return creatingFailure(envelopes.find(envelope => envelope.structured !== undefined)?.structured);
  }
  // Preserve only the measured outer missing-flag forms. Do not manufacture
  // their shape by merging inner fields or removing defined outer fields.
  if (outer.isError === undefined && inner?.isError === undefined && host === codexViewHostName) {
    if (exactEnvelopeKeys(outer, ["content"])) {
      const delivery = admitMcpToolResultDeliveryErrorContent(outer.content);
      if (delivery !== undefined) return {status: "tool_error", message: delivery.message};
    }
    if (exactEnvelopeKeys(outer, ["content", "structuredContent"]) && applicationFailureSchema.safeParse(outer.structured).success &&
        exactErrorText(outer) === canonicalJsonStringify(captureCanonicalJson(outer.structured))) return creatingFailure(outer.structured);
  }
  if (texts.length !== 0) throw new TypeError("The creating result has an invalid acknowledgement text.");
  if (value !== undefined) {
    const acknowledgement = cardCreationResultSchema.safeParse(captureCanonicalJson(value));
    if (!acknowledgement.success) throw new TypeError("The creating result has an invalid card acknowledgement.");
    ids.push(acknowledgement.data.cardId);
  }
  if (ids.length === 0) throw new TypeError("The creating result omitted its card acknowledgement or reference.");
  if (ids.some(id => id !== ids[0])) throw new TypeError("Creation acknowledgement differs from its card.");
  return Object.freeze({status: "card", card: Object.freeze({cardId: ids[0]!})});
};

const admitResourceValue = (resource: PresentationSnapshotResource, candidate: CanonicalJson): AdmittedPresentation => {
  const resultBytes = exactBytes(candidate);
  if (
    resultBytes.length !== resource.descriptor.resultUtf8Bytes ||
    sha256Bytes(resultBytes) !== resource.descriptor.resultSha256
  ) throw new TypeError("Presentation result does not match its descriptor.");
  const entry = presentationContractRegistry.requireIdentity(
    resource.descriptor.contractId,
    resource.descriptor.contractVersion,
  );
  const normalizedInput = entry.parseNormalizedInput(resource.normalizedInput);
  const admittedResult = entry.parseResult(normalizedInput, candidate);
  assertPresentationSource(entry, admittedResult, resource.descriptor.source);
  if (!sameBytes(exactBytes(normalizedInput), exactBytes(resource.normalizedInput)) ||
    !sameBytes(exactBytes(admittedResult), resultBytes)) {
    throw new TypeError("Presentation pair changed during canonical re-admission.");
  }
  return Object.freeze({ entry, normalizedInput, result: admittedResult });
};

export const readPresentationResource = async (
  app: PresentationViewApp, input: unknown, signal: AbortSignal,
): Promise<ViewResult<AdmittedPresentation>> => {
  const resource = admitPresentationSnapshotResource(input);
  const reconstructed = await reconstructResult(app, resource, signal);
  return reconstructed.ok ? { ok: true, value: admitResourceValue(resource, reconstructed.value) } : reconstructed;
};
