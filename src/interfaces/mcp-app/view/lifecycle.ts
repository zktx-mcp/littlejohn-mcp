import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolRequest,
  CallToolResult,
  Implementation,
  ReadResourceRequest,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
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
import { admitCreatingToolError } from "./creating-tool-error.js";
import { admitToolReply, applicationIssue, type ViewResult, type ViewIssue } from "./tool-result.js";
import { claudeViewHostName, codexViewHostName } from "./host-identities.js";
import { cardReferenceSchema, cardIdFromPresentationUri, presentationCardMetadataKey,
  presentationCardUriPrefix, cardCreationResultSchema, type CardRecord } from "../card-contract.js";
import { maximumMcpToolResultUtf8Bytes } from "../../mcp-result.js";

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

const directContent = (result: CallToolResult): readonly CallToolResult["content"][number][] =>
  Array.isArray(result.content) ? result.content : [];

const contentForResourceLink = (
  app: PresentationViewApp,
  result: CallToolResult,
): readonly CallToolResult["content"][number][] => {
  const standard = directContent(result);
  if (standard.some((item) => item.type === "resource_link")) return standard;
  if (
    app.getHostVersion()?.name !== codexViewHostName || standard.length !== 1 ||
    standard[0]?.type !== "text"
  ) return standard;

  // Codex currently wraps the standard result content in one JSON text block.
  // Admit only the nested standard content. Delete this adapter when Codex
  // forwards resource_link blocks directly; the standard branch above wins.
  // The wrapper text is the bounded server result, not the expanded Host packet.
  if (utf8ByteLength(standard[0].text) > maximumMcpToolResultUtf8Bytes) return standard;
  try {
    const wrapped = JSON.parse(standard[0].text) as unknown;
    if (typeof wrapped !== "object" || wrapped === null || Array.isArray(wrapped)) return standard;
    const content = (wrapped as Readonly<Record<string, unknown>>)["content"];
    return Array.isArray(content) ? content as CallToolResult["content"] : standard;
  } catch { return standard; }
};

export interface CreatingCard {
  readonly cardId: string;
}

export const admitCreatingCard = (app: PresentationViewApp, result: CallToolResult): CreatingCard | null => {
  const value = result._meta?.[presentationCardMetadataKey];
  const content = contentForResourceLink(app, result);
  const ids = content.flatMap((item): string[] => {
    if (item.type === "resource_link" && item.uri.startsWith(presentationCardUriPrefix)) {
      if (item.mimeType !== presentationSnapshotResourceMimeType) throw new TypeError("Card resource type differs.");
      return [cardIdFromPresentationUri(item.uri)];
    }
    if (app.getHostVersion()?.name === claudeViewHostName && item.type === "text") {
      const match = /^\[Resource link: presentation_card_([A-Za-z0-9_-]{43})\] (littlejohn:\/\/presentation\/cards\/[A-Za-z0-9_-]{43}) \(Saved state of this exact card\.\)$/u.exec(item.text);
      if (match !== null) {
        const id = cardIdFromPresentationUri(match[2]!);
        if (id !== match[1]) throw new TypeError("Card link name and URI differ.");
        return [id];
      }
    }
    return [];
  });
  if (value === undefined || value === null) {
    if (ids.length !== 0) throw new TypeError("Card link omitted its creating reference.");
    return null;
  }
  const reference = cardReferenceSchema.parse(captureCanonicalJson(value));
  if (reference.kind !== "card" || ids.length > 1 || ids.some((id) => id !== reference.cardId)) {
    throw new TypeError("Creating card references differ.");
  }
  if (ids.length === 0 && app.getHostVersion()?.name !== claudeViewHostName) {
    throw new TypeError("The creating result omitted its card resource link.");
  }
  const acknowledgement = cardCreationResultSchema.parse(captureCanonicalJson(result.structuredContent));
  if (acknowledgement.cardId !== reference.cardId) throw new TypeError("Creation acknowledgement differs from its card.");
  return Object.freeze({ cardId: reference.cardId });
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

export const admitPresentationToolResult = async (
  app: PresentationViewApp,
  result: CallToolResult,
  _signal: AbortSignal,
): Promise<PresentationToolResultAdmission> => {
  const toolError = admitCreatingToolError(app.getHostVersion()?.name, result);
  if (toolError !== undefined) {
    return Object.freeze({
      status: "tool_error",
      message: toolError.message,
      ...(toolError.failure === undefined ? {} : { failure: toolError.failure }),
    });
  }
  const card = admitCreatingCard(app, result);
  if (card === null) throw new TypeError("The creating result omitted its card acknowledgement.");
  return Object.freeze({ status: "card", card });
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
