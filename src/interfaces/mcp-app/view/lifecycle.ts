import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolRequest,
  CallToolResult,
  Implementation,
  ReadResourceRequest,
  ReadResourceResult,
  ResourceLink,
} from "@modelcontextprotocol/sdk/types.js";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  sha256Bytes,
  type CanonicalJson, type ApplicationFailure,
} from "../../../core/client.js";
import {
  admitPresentationSnapshotReference,
  admitPresentationSnapshotResource,
  bytesFromCanonicalBase64,
  presentationMcpTools,
  presentationSnapshotChunkSchema,
  presentationSnapshotMetadataKey,
  presentationSnapshotResourceMimeType,
  presentationSnapshotUriPrefix,
  presentationSnapshotUriSchema,
  presentationUnavailableSchema,
  presentationReadFailureSchema,
  operationToolInputEvidence,
  type PresentationSnapshotReference,
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
  presentationCardUriPrefix, cardReadStartContract, assertCardPresentationSource, type CardRecord } from "../card-contract.js";
import type { PresentationSnapshotDescriptor } from "../contracts.js";

const claudeFlattenedSnapshotLinkPattern =
  /^\[Resource link: presentation_snapshot_([0-9a-f]{64})\] (littlejohn:\/\/presentation\/(?:snapshots|responses|reviews\/[A-Za-z0-9_-]+)\/sha256\/([0-9a-f]{64})) \(Exact immutable presentation input and descriptor\.\)$/u;

export interface AdmittedPresentation {
  readonly entry: PresentationContractEntry;
  readonly normalizedInput: CanonicalJson;
  readonly result: CanonicalJson;
}

export type PresentationToolResultAdmission =
  | Readonly<{ status: "card"; card: CreatingCard }>
  | Readonly<{ status: "read_error"; issue: ViewIssue }>
  | Readonly<{
      status: "presentation";
      presentation: AdmittedPresentation;
    }>
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
  try {
    const wrapped = JSON.parse(standard[0].text) as unknown;
    if (typeof wrapped !== "object" || wrapped === null || Array.isArray(wrapped)) return standard;
    const content = (wrapped as Readonly<Record<string, unknown>>)["content"];
    return Array.isArray(content) ? content as CallToolResult["content"] : standard;
  } catch { return standard; }
};

const exactResourceLinks = (
  app: PresentationViewApp,
  result: CallToolResult,
): readonly ResourceLink[] => {
  const content = contentForResourceLink(app, result);
  const standard = content.flatMap((item) =>
    item.type === "resource_link" &&
      presentationSnapshotUriSchema.safeParse(item.uri).success &&
      item.mimeType === presentationSnapshotResourceMimeType
      ? [item]
      : []);
  if (standard.length > 0 || app.getHostVersion()?.name !== claudeViewHostName) {
    return standard;
  }

  // Claude local-agent-mode currently flattens resource_link blocks into one
  // exact text form and may redeliver only that form after an App remount.
  // Reverse only this measured transport encoding, require the name and URI
  // digests to agree, and then rejoin the standard resource admission path.
  // Delete this adapter when Claude preserves resource_link blocks on remount.
  return content.flatMap((item): readonly ResourceLink[] => {
    if (item.type !== "text") return [];
    const match = claudeFlattenedSnapshotLinkPattern.exec(item.text);
    if (match === null || match[1] !== match[3] || match[2] === undefined) return [];
    return [{
      type: "resource_link",
      name: `presentation_snapshot_${match[1]}`,
      uri: match[2],
      mimeType: presentationSnapshotResourceMimeType,
    }];
  });
};

const privateSnapshotResource = (result: CallToolResult): PresentationSnapshotResource | undefined => {
  const value = result._meta?.[presentationSnapshotMetadataKey];
  if (value === undefined) return undefined;
  try { return admitPresentationSnapshotResource(value); }
  catch { return undefined; }
};

export interface CreatingCard {
  readonly entry: "decision" | "snapshot" | "read";
  readonly cardId: string;
  readonly descriptor?: PresentationSnapshotDescriptor;
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
  const resource = privateSnapshotResource(result);
  if (resource === undefined) {
    const acknowledgement = cardReadStartContract.successSchema.parse(result.structuredContent);
    if (acknowledgement.reference.cardId !== reference.cardId) throw new TypeError("Read acknowledgement differs from its card.");
    return Object.freeze({ cardId: reference.cardId, entry: "read" as const });
  }
  const publicValue = captureCanonicalJson(result.structuredContent);
  if (typeof publicValue === "object" && publicValue !== null && !Array.isArray(publicValue) &&
      "kind" in publicValue && publicValue["kind"] === "presentation_snapshot_reference") {
    const replay = admitPresentationSnapshotReference(publicValue);
    if (canonicalJsonStringify(captureCanonicalJson(replay.descriptor)) !== canonicalJsonStringify(captureCanonicalJson(resource.descriptor))) {
      throw new TypeError("Replay reference differs from its saved source.");
    }
    return Object.freeze({ cardId: reference.cardId, descriptor: resource.descriptor, entry: "snapshot" as const });
  }
  const entry = presentationContractRegistry.requireIdentity(resource.descriptor.contractId, resource.descriptor.contractVersion);
  const bytes = exactBytes(publicValue);
  if (entry.cardKind === undefined || bytes.length !== resource.descriptor.resultUtf8Bytes || sha256Bytes(bytes) !== resource.descriptor.resultSha256) {
    throw new TypeError("The creating decision differs from its admitted source.");
  }
  return Object.freeze({ cardId: reference.cardId, descriptor: resource.descriptor, entry: "decision" as const });
};

export const assertCreatingCardState = (creating: CreatingCard, record: CardRecord): void => {
  if (record.cardId !== creating.cardId) throw new TypeError("Saved card differs from its creating reference.");
  if (record.kind === "read") {
    if (creating.descriptor !== undefined) throw new TypeError("A read acknowledgement cannot pretend to be a completed result.");
    return;
  }
  const descriptor = creating.descriptor;
  if (descriptor === undefined) {
    throw new TypeError("Saved card state differs from its creating result.");
  }
  assertCardPresentationSource(record, descriptor);
};

const readExactSnapshotResource = async (
  app: PresentationViewApp,
  uri: string,
  signal: AbortSignal,
): Promise<ViewResult<PresentationSnapshotResource>> => {
  if (!app.getHostCapabilities()?.serverResources) {
    throw new TypeError("The Host cannot read the exact presentation resource.");
  }
  const response = await app.readServerResource({ uri }, { signal });
  const contents = response.contents.filter((content) =>
    content.uri === uri && content.mimeType === presentationSnapshotResourceMimeType &&
    "text" in content && typeof content.text === "string");
  if (contents.length !== 1 || contents[0] === undefined || !("text" in contents[0])) {
    throw new TypeError("The exact presentation resource is not unique.");
  }
  const captured = captureCanonicalJson(JSON.parse(contents[0].text));
  if (canonicalJsonStringify(captured) !== contents[0].text) {
    throw new TypeError("The exact presentation resource is not canonical JSON.");
  }
  const unavailable = presentationUnavailableSchema.safeParse(captured);
  return unavailable.success ? { ok: false, issue: { kind: "presentation", unavailable: unavailable.data } }
    : { ok: true, value: admitPresentationSnapshotResource(captured) };
};

const directResourceForResult = (
  app: PresentationViewApp,
  result: CallToolResult,
): PresentationSnapshotResource => {
  const links = exactResourceLinks(app, result);
  const privateResource = privateSnapshotResource(result);
  if (links.length === 1 && links[0] !== undefined) {
    if (privateResource === undefined) {
      throw new TypeError("The direct result omitted its private presentation resource.");
    }
    if (privateResource.descriptor.snapshotUri !== links[0].uri) {
      throw new TypeError("Presentation resource link and metadata differ.");
    }
    return privateResource;
  }
  if (links.length > 1) throw new TypeError("The result contains multiple presentation resources.");
  if (privateResource !== undefined && app.getHostVersion()?.name === claudeViewHostName) {
    // Claude local-agent-mode currently removes or flattens resource_link
    // blocks before View delivery. Admit only the complete snapshot resource
    // carried by this same result. Delete this adapter when Claude preserves
    // the standard link; the link branch above then wins.
    return privateResource;
  }
  throw new TypeError("The result omitted its exact presentation resource.");
};

const replayResourceForResult = async (
  app: PresentationViewApp,
  result: CallToolResult,
  reference: PresentationSnapshotReference,
  signal: AbortSignal,
): Promise<ViewResult<PresentationSnapshotResource>> => {
  const links = exactResourceLinks(app, result);
  const privateResource = privateSnapshotResource(result);
  if (links.length === 1 && links[0] !== undefined) {
    if (reference.snapshotUri !== links[0].uri) {
      throw new TypeError("Presentation resource link and reference differ.");
    }
    if (privateResource !== undefined) {
      if (privateResource.descriptor.snapshotUri !== links[0].uri) {
        throw new TypeError("Presentation resource link and metadata differ.");
      }
      return { ok: true, value: privateResource };
    }
    return readExactSnapshotResource(app, links[0].uri, signal);
  }
  if (links.length > 1) throw new TypeError("The result contains multiple presentation resources.");
  if (privateResource !== undefined && app.getHostVersion()?.name === claudeViewHostName) {
    if (privateResource.descriptor.snapshotUri !== reference.snapshotUri) {
      throw new TypeError("Presentation resource metadata and reference differ.");
    }
    return { ok: true, value: privateResource };
  }
  return readExactSnapshotResource(app, reference.snapshotUri, signal);
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
  signal: AbortSignal,
): Promise<PresentationToolResultAdmission> => {
  const toolError = admitCreatingToolError(app.getHostVersion()?.name, result);
  if (toolError !== undefined) {
    return Object.freeze({
      status: "tool_error",
      message: toolError.message,
      ...(toolError.failure === undefined ? {} : { failure: toolError.failure }),
    });
  }
  for (const value of [result._meta?.[presentationSnapshotMetadataKey], result.structuredContent]) {
    const unavailable = presentationUnavailableSchema.safeParse(value);
    if (unavailable.success) return { status: "read_error", issue: { kind: "presentation", unavailable: unavailable.data } };
  }
  const card = admitCreatingCard(app, result);
  if (card !== null) return Object.freeze({ status: "card", card });
  const data = await admitPresentationData(app, result, signal);
  if (!data.ok) return { status: "read_error", issue: data.issue };
  const presentation = data.value;
  if (presentation.entry.cardKind !== undefined &&
      (presentation.entry.presentationKind !== "review" ||
        typeof presentation.result === "object" && presentation.result !== null && "review" in presentation.result)) {
    throw new TypeError("The decision omitted its saved card reference.");
  }
  return Object.freeze({ status: "presentation", presentation });
};

export const admitPresentationData = async (
  app: PresentationViewApp, result: CallToolResult, signal: AbortSignal,
): Promise<ViewResult<AdmittedPresentation>> => {
  if (result.isError === true) throw new TypeError("A failed tool result has no presentation data.");
  const privateValue = result._meta?.[presentationSnapshotMetadataKey];
  const unavailable = presentationUnavailableSchema.safeParse(privateValue);
  if (unavailable.success) {
    return { ok: false, issue: { kind: "presentation", unavailable: unavailable.data } };
  }
  const structured = result.structuredContent === undefined
    ? undefined
    : captureCanonicalJson(result.structuredContent);
  const reference =
    typeof structured === "object" && structured !== null && !Array.isArray(structured) &&
    structured["kind"] === "presentation_snapshot_reference"
      ? admitPresentationSnapshotReference(structured)
      : undefined;
  if (structured === undefined) throw new TypeError("The App result omitted its canonical result.");
  const selected = reference === undefined
    ? { ok: true as const, value: directResourceForResult(app, result) }
    : await replayResourceForResult(app, result, reference, signal);
  if (!selected.ok) return selected;
  const resource = selected.value;
  const inputBytes = exactBytes(resource.normalizedInput);
  if (
    inputBytes.length !== resource.descriptor.inputUtf8Bytes ||
    sha256Bytes(inputBytes) !== resource.descriptor.inputSha256
  ) throw new TypeError("Presentation input does not match its descriptor.");

  let candidate: CanonicalJson;
  if (reference !== undefined) {
    if (reference.snapshotUri !== resource.descriptor.snapshotUri ||
      canonicalJsonStringify(captureCanonicalJson(reference.descriptor)) !==
        canonicalJsonStringify(captureCanonicalJson(resource.descriptor))) {
      throw new TypeError("Presentation reference and resource differ.");
    }
    const reconstructed = await reconstructResult(app, resource, signal);
    if (!reconstructed.ok) return reconstructed;
    candidate = reconstructed.value;
  } else {
    candidate = structured;
  }

  return { ok: true, value: admitResourceValue(resource, candidate) };
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
