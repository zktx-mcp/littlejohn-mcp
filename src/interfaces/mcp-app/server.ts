import { CardError } from "./card-errors.js";
import { admitSnapshotRecord, boundedSnapshotResource } from "./snapshot-record.js";
import { requestReviewPresentationIdentity } from "../../review/presentation-contract.js";
import { cardReferenceSchema, cardReferenceContract, presentationCardMetadataKey, presentationCardUri, type CardReferenceReader } from "./card-contract.js";
import { CardDomainError, cardSources } from "./card-sources.js";
import type { LiveReviewPresentationPort } from "../../review/presentation-contract.js";
import { createPresentationSnapshot } from "../../runtime/presentation-snapshot-server.js";
import { readFileSync } from "node:fs";

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  CallToolResult,
  ClientCapabilities,
  Implementation,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  sha256Bytes,
  type CanonicalJson,
} from "../../core/index.js";
import type {
  PresentationSnapshotRecord,
  PresentationSnapshotStore,
} from "../../runtime/presentation-snapshot.js";
import {
  admitMcpToolResultForDelivery,
  type McpToolResultDelivery,
} from "../mcp-result.js";
import {
  admitPresentationSnapshotReference,
  admitPresentationSnapshotResource,
  canonicalBase64FromBytes,
  createPresentationUnavailable,
  descriptorForPresentationSnapshot,
  mcpAppResourceMimeType,
  presentationSnapshotMetadataKey,
  presentationSnapshotResourceMimeType,
  presentationSnapshotUriSchema,
  presentationSourceSchema,
  snapshotIdFromUri,
  type PresentationSnapshotReference,
  type PresentationSnapshotResource,
  type PresentationUnavailable,
  reviewOperationFromSnapshotUri,
} from "./contracts.js";
import {
  presentationContractRegistry,
  type PresentationContractEntry,
} from "./registry.js";

const appResourceUriPrefix = "ui://littlejohn/presentation/" as const;
const codexMcpClientName = "codex-mcp-client" as const;
const mcpAppsExtensionId = "io.modelcontextprotocol/ui" as const;

export interface McpAppResource {
  readonly uri: string;
  readonly html: string;
  readonly utf8Bytes: number;
  readonly sha256: string;
}

export type McpAppConnection =
  | Readonly<{ status: "ordinary" }>
  | Readonly<{ status: "app"; serverAdapter: "standard" | "codex_ui_capability" }>;

const exactUtf8 = (value: CanonicalJson): Uint8Array =>
  new TextEncoder().encode(canonicalJsonStringify(value));

const exactRecord = (
  left: PresentationSnapshotRecord,
  right: PresentationSnapshotRecord,
): boolean => left.snapshotId === right.snapshotId &&
  left.contractId === right.contractId && left.contractVersion === right.contractVersion &&
  left.inputDigest === right.inputDigest && left.resultDigest === right.resultDigest &&
  Buffer.compare(Buffer.from(left.inputBytes), Buffer.from(right.inputBytes)) === 0 &&
  Buffer.compare(Buffer.from(left.resultBytes), Buffer.from(right.resultBytes)) === 0;

export const createMcpAppResource = (html: string): McpAppResource => {
  if (typeof html !== "string" || html.length === 0 || html.includes("\0")) {
    throw new TypeError("MCP App resource is invalid.");
  }
  const bytes = new TextEncoder().encode(html);
  const sha256 = sha256Bytes(bytes);
  return Object.freeze({
    uri: `${appResourceUriPrefix}${sha256}.html`,
    html,
    utf8Bytes: bytes.length,
    sha256,
  });
};

export const loadMcpAppResource = (): McpAppResource => createMcpAppResource(
  readFileSync(new URL("../../../dist/mcp-app/index.html", import.meta.url), "utf8"),
);

export const admitMcpAppConnection = (
  capabilities: ClientCapabilities | undefined,
  client: Implementation | undefined,
): McpAppConnection => {
  const standardCapability = capabilities?.extensions?.[mcpAppsExtensionId];
  if (
    typeof standardCapability === "object" && standardCapability !== null &&
    !Array.isArray(standardCapability) &&
    Array.isArray((standardCapability as Readonly<Record<string, unknown>>)["mimeTypes"]) &&
    ((standardCapability as Readonly<Record<string, unknown>>)["mimeTypes"] as readonly unknown[])
      .includes(mcpAppResourceMimeType)
  ) {
    return Object.freeze({ status: "app", serverAdapter: "standard" });
  }
  if (client?.name === codexMcpClientName) {
    // Codex qualification showed that this exact client carries MCP Apps while
    // omitting the standard UI capability. Delete this adapter when Codex
    // advertises the standard capability; the standard branch above then wins.
    return Object.freeze({ status: "app", serverAdapter: "codex_ui_capability" });
  }
  return Object.freeze({ status: "ordinary" });
};

export const appToolMetadata = (
  connection: McpAppConnection,
  resource: McpAppResource,
  visibility: readonly ["model"] | readonly ["app"] | readonly ["model", "app"],
  createsView: boolean,
): Tool["_meta"] | undefined => {
  if (connection.status === "ordinary") return undefined;
  const ui = Object.freeze({
    ...(createsView ? { resourceUri: resource.uri } : {}),
    visibility,
  });
  return Object.freeze({
    ui,
    ...(connection.serverAdapter === "codex_ui_capability" && createsView
      ? { "openai/outputTemplate": resource.uri }
      : {}),
  });
};

const snapshotLink = (resource: PresentationSnapshotResource): CallToolResult["content"][number] => ({
  type: "resource_link",
  name: `presentation_snapshot_${resource.descriptor.snapshotId.slice("sha256:".length)}`,
  title: "Little John presentation snapshot",
  description: "Exact immutable presentation input and descriptor.",
  uri: resource.descriptor.snapshotUri,
  mimeType: presentationSnapshotResourceMimeType,
});

const cardLinks = (result: CallToolResult): CallToolResult["content"] => {
  const value = result._meta?.[presentationCardMetadataKey];
  if (value === null || value === undefined) return [];
  const reference = cardReferenceSchema.parse(value);
  if (reference.kind !== "card") throw new TypeError("A stateful card reference is required.");
  return [{ type: "resource_link", name: `presentation_card_${reference.cardId}`,
    title: "Little John card state", description: "Saved state of this exact card.",
    uri: presentationCardUri(reference.cardId), mimeType: presentationSnapshotResourceMimeType }];
};

export const withCardReference = (result: CallToolResult): CallToolResult => ({
  ...result, content: [...result.content, ...cardLinks(result)],
});

const withSnapshot = (
  result: CallToolResult,
  resource: PresentationSnapshotResource | PresentationUnavailable,
): CallToolResult => resource.kind === "presentation_unavailable"
  ? {
      ...result,
      _meta: { ...result._meta, [presentationSnapshotMetadataKey]: resource },
    }
  : {
      ...result,
      content: [...result.content, ...cardLinks(result), snapshotLink(resource)],
      _meta: { ...result._meta, [presentationSnapshotMetadataKey]: resource },
    };

export type McpAppPresentationHandoff =
  | Readonly<{
      status: "available";
      delivery: Extract<McpToolResultDelivery, { status: "admitted" }>;
    }>
  | Readonly<{
      status: "delivery_error";
      delivery: Extract<McpToolResultDelivery, { status: "too_large" }>;
    }>
  | PresentationUnavailable;

const admitCanonicalToolSuccess = (
  entry: PresentationContractEntry,
  normalizedInput: CanonicalJson,
  result: CallToolResult,
): CanonicalJson => {
  if (result.isError === true || result.structuredContent === undefined) {
    throw new TypeError("Presentation requires a canonical successful tool result.");
  }
  const candidate = captureCanonicalJson(result.structuredContent);
  const admitted = entry.parseResult(normalizedInput, candidate);
  if (
    canonicalJsonStringify(candidate) !== canonicalJsonStringify(admitted) ||
    result.content.length !== 1 ||
    result.content[0]?.type !== "text" ||
    result.content[0].text.length === 0
  ) throw new TypeError("Presentation tool result is not one canonical result.");
  return admitted;
};

export class McpAppPresentationService {
  readonly #store: PresentationSnapshotStore;
  readonly #reviews: LiveReviewPresentationPort;
  readonly #readCardReference: CardReferenceReader;
  readonly resource: McpAppResource;

  constructor(store: PresentationSnapshotStore, resource: McpAppResource, reviews: LiveReviewPresentationPort, readCardReference: CardReferenceReader) {
    this.#reviews = reviews;
    this.#store = store;
    this.#readCardReference = readCardReference;
    this.resource = resource;
    Object.freeze(this);
  }

  async present(
    contract: object,
    input: unknown,
    result: CallToolResult,
  ): Promise<McpAppPresentationHandoff> {
    const entry = presentationContractRegistry.forContract(contract);
    if (entry === undefined) return createPresentationUnavailable("snapshot_inconsistent");
    let normalizedInput: CanonicalJson;
    let admittedResult: CanonicalJson;
    try {
      normalizedInput = entry.parseInput(input);
      admittedResult = admitCanonicalToolSuccess(entry, normalizedInput, result);
      if (entry.cardKind !== undefined) {
        const description = cardSources[entry.cardKind].describe(admittedResult);
        const reference = result._meta?.[presentationCardMetadataKey];
        if (description === null) {
          if (reference !== null) throw new TypeError("A non-decision cannot carry card state.");
        } else if (cardReferenceSchema.parse(reference).kind !== "card") {
          throw new TypeError("The creating decision omitted its saved card reference.");
        }
      }
    } catch {
      return createPresentationUnavailable("snapshot_inconsistent");
    }
    if (entry.retention === "review_memory") {
      const review = requestReviewPresentationIdentity(admittedResult);
      // The creating result is already admitted. Reopening reads the card's
      // durable state before deciding whether temporary detail is still usable.
      const snapshot = createPresentationSnapshot({ contractId: entry.contractId, contractVersion: entry.contractVersion, normalizedInput, admittedResult });
      if (snapshot.status === "unavailable") return createPresentationUnavailable(snapshot.reason);
      const source = presentationSourceSchema.parse(review === null ? { kind: "response_memory" }
        : { kind: "review_memory", operationId: review.operationId, expiresAt: review.expiresAt });
      const resource = boundedSnapshotResource(snapshot.value, normalizedInput, source);
      const delivery = admitMcpToolResultForDelivery(withSnapshot(result, resource));
      return delivery.status === "too_large" ? { status: "delivery_error", delivery } : { status: "available", delivery };
    }
    let candidate: ReturnType<PresentationSnapshotStore["prepare"]>;
    try {
      candidate = this.#store.prepare({
        contractId: entry.contractId,
        contractVersion: entry.contractVersion,
        normalizedInput,
        admittedResult,
      });
    } catch {
      return createPresentationUnavailable("runtime_unavailable");
    }
    if (candidate.status === "unavailable") {
      return createPresentationUnavailable(candidate.reason);
    }
    let resource: PresentationSnapshotResource;
    try { resource = boundedSnapshotResource(candidate.value, normalizedInput); }
    catch {
      return createPresentationUnavailable("capacity_exceeded");
    }
    const delivery = admitMcpToolResultForDelivery(withSnapshot(result, resource));
    if (delivery.status === "too_large") {
      return Object.freeze({ status: "delivery_error", delivery });
    }
    let committed: ReturnType<PresentationSnapshotStore["commit"]>;
    try {
      committed = this.#store.commit({
        contractId: entry.contractId,
        contractVersion: entry.contractVersion,
        normalizedInput,
        admittedResult,
      });
    } catch {
      return createPresentationUnavailable("runtime_unavailable");
    }
    if (committed.status === "unavailable") {
      return createPresentationUnavailable(committed.reason);
    }
    if (!exactRecord(candidate.value, committed.value)) {
      return createPresentationUnavailable("snapshot_inconsistent");
    }
    return Object.freeze({
      status: "available",
      delivery,
    });
  }

  async #readLive(operationId: string): Promise<ReturnType<typeof admitSnapshotRecord> | PresentationUnavailable> {
    try {
      const live = await this.#reviews.read(operationId);
      if (live.status === "unavailable") return createPresentationUnavailable(live.reason);
      if (live.operationId !== operationId) return createPresentationUnavailable("snapshot_inconsistent");
      const snapshot = createPresentationSnapshot({ contractId: live.contractId, contractVersion: "1",
        normalizedInput: captureCanonicalJson(live.input), admittedResult: captureCanonicalJson(live.result) });
      if (snapshot.status === "unavailable") return createPresentationUnavailable(snapshot.reason);
      return admitSnapshotRecord(snapshot.value, { kind: "review_memory", operationId: live.operationId, expiresAt: live.expiresAt });
    } catch { return createPresentationUnavailable("runtime_unavailable"); }
  }

  async #readAdmittedSnapshot(snapshotUri: unknown): Promise<ReturnType<typeof admitSnapshotRecord> | PresentationUnavailable> {
    if (typeof snapshotUri === "string" && snapshotUri.startsWith("littlejohn://presentation/responses/")) return createPresentationUnavailable("snapshot_missing");
    const operationId = reviewOperationFromSnapshotUri(snapshotUri);
    if (operationId !== undefined) {
      const live = await this.#readLive(operationId);
      if ("kind" in live) return live;
      return live.resource.descriptor.snapshotUri === snapshotUri ? live : createPresentationUnavailable("snapshot_inconsistent");
    }
    let snapshotId: string;
    try { snapshotId = snapshotIdFromUri(snapshotUri); }
    catch { throw new TypeError("Presentation snapshot URI is invalid."); }
    let stored: ReturnType<PresentationSnapshotStore["read"]>;
    try { stored = this.#store.read(snapshotId); }
    catch { return createPresentationUnavailable("runtime_unavailable"); }
    if (stored.status === "unavailable") return createPresentationUnavailable(stored.reason);
    try { return admitSnapshotRecord(stored.value); }
    catch { return createPresentationUnavailable("snapshot_inconsistent"); }
  }

  async getSnapshotResult(snapshotUri: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    let admitted = await this.#readAdmittedSnapshot(snapshotUri);
    let reference: ReturnType<typeof cardReferenceContract.parsePublicSuccess> | undefined;
    if (!("kind" in admitted) && admitted.entry.cardKind !== undefined) {
      const description = cardSources[admitted.entry.cardKind].describe(admitted.admittedResult);
      if (description !== null) {
        const input = cardReferenceContract.parseInput({ operationId: description.operationId, descriptor: admitted.resource.descriptor });
        try { reference = cardReferenceContract.parsePublicSuccess(input, await this.#readCardReference(input, signal)); }
        catch (error) {
          if (!(error instanceof CardDomainError || error instanceof CardError)) throw error;
          switch (error.failure.error.code) {
            case "presentation_not_found": admitted = createPresentationUnavailable("snapshot_missing"); break;
            case "presentation_inconsistent": admitted = createPresentationUnavailable("snapshot_inconsistent"); break;
            case "presentation_capacity_exceeded": admitted = createPresentationUnavailable("capacity_exceeded"); break;
            case "runtime_state_unavailable": admitted = createPresentationUnavailable("runtime_unavailable"); break;
            default: throw error;
          }
        }
      }
    }
    const value = "kind" in admitted
      ? admitted
      : admitPresentationSnapshotReference({
          kind: "presentation_snapshot_reference",
          snapshotUri: admitted.resource.descriptor.snapshotUri,
          descriptor: admitted.resource.descriptor,
        });
    const result: CallToolResult = {
      structuredContent: captureCanonicalJson(value) as Record<string, unknown>,
      content: [{ type: "text", text: canonicalJsonStringify(captureCanonicalJson(value)) }],
      ...(reference === undefined ? {} : { _meta: { [presentationCardMetadataKey]: reference } }),
    };
    if (value.kind === "presentation_unavailable") return result;
    if ("kind" in admitted) return result;
    return withSnapshot(result, admitted.resource);
  }

  async getResultChunk(snapshotUri: string, index: number): Promise<CanonicalJson> {
    if (snapshotUri.startsWith("littlejohn://presentation/responses/")) return captureCanonicalJson(createPresentationUnavailable("snapshot_missing"));
    if (reviewOperationFromSnapshotUri(snapshotUri) === undefined) {
      try {
        const chunk = this.#store.readResultChunk({ snapshotId: snapshotIdFromUri(snapshotUri), index });
        return chunk.status === "unavailable" ? captureCanonicalJson(createPresentationUnavailable(chunk.reason)) :
          captureCanonicalJson({ kind: "presentation_snapshot_chunk", snapshotId: chunk.value.snapshotId, index: chunk.value.index,
            canonicalBase64: canonicalBase64FromBytes(chunk.value.bytes) });
      } catch { return captureCanonicalJson(createPresentationUnavailable("runtime_unavailable")); }
    }
    const admitted = await this.#readAdmittedSnapshot(snapshotUri);
    if ("kind" in admitted) return captureCanonicalJson(admitted);
    const descriptor = admitted.resource.descriptor;
    if (!Number.isSafeInteger(index) || index < 0 || index >= descriptor.resultChunkCount) {
      return captureCanonicalJson(createPresentationUnavailable("snapshot_inconsistent"));
    }
    const bytes = exactUtf8(admitted.admittedResult);
    return captureCanonicalJson({ kind: "presentation_snapshot_chunk", snapshotId: descriptor.snapshotId, index,
      canonicalBase64: canonicalBase64FromBytes(bytes.slice(index * descriptor.resultChunkBytes, (index + 1) * descriptor.resultChunkBytes)) });
  }

  async readSnapshotResource(snapshotUri: unknown): Promise<PresentationSnapshotResource | PresentationUnavailable> {
    const admitted = await this.#readAdmittedSnapshot(snapshotUri);
    return "kind" in admitted
      ? admitted
      : admitPresentationSnapshotResource(admitted.resource);
  }

  async readResource(uri: string): Promise<Readonly<{
    uri: string;
    mimeType: string;
    text: string;
    _meta?: Readonly<Record<string, unknown>>;
  }>> {
    if (uri === this.resource.uri) {
      return Object.freeze({
        uri,
        mimeType: mcpAppResourceMimeType,
        text: this.resource.html,
        _meta: Object.freeze({
          ui: Object.freeze({
            prefersBorder: true,
            permissions: Object.freeze({
              clipboardWrite: Object.freeze({}),
            }),
            csp: Object.freeze({
              connectDomains: Object.freeze([]),
              resourceDomains: Object.freeze([]),
              frameDomains: Object.freeze([]),
              baseUriDomains: Object.freeze([]),
            }),
          }),
        }),
      });
    }
    const parsedUri = presentationSnapshotUriSchema.parse(uri);
    const snapshot = await this.readSnapshotResource(parsedUri);
    return Object.freeze({
      uri: parsedUri,
      mimeType: presentationSnapshotResourceMimeType,
      text: canonicalJsonStringify(captureCanonicalJson(snapshot)),
    });
  }
}

export const createMcpAppPresentationService = (
  server: Server,
  store: PresentationSnapshotStore,
  resource: McpAppResource,
  reviews: LiveReviewPresentationPort,
  readCardReference: CardReferenceReader,
): Readonly<{
  service: McpAppPresentationService;
  connection(): McpAppConnection;
}> => {
  const service = new McpAppPresentationService(store, resource, reviews, readCardReference);
  return Object.freeze({
    service,
    connection: (): McpAppConnection =>
      admitMcpAppConnection(server.getClientCapabilities(), server.getClientVersion()),
  });
};
