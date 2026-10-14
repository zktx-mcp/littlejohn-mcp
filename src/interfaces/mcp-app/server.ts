import { productDisplayName } from "../../registry/client.js";
import { admitSnapshotRecord, admitSnapshotMetadata } from "./snapshot-record.js";
import { cardReferenceSchema, presentationCardMetadataKey, presentationCardUri } from "./card-contract.js";
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
  operationIdSchema,
  type CanonicalJson,
} from "../../core/index.js";
import type {
  PresentationSnapshotStore,
  PresentationSnapshotReadPort,
} from "../../runtime/presentation-snapshot.js";
import {
  admitPresentationSnapshotReference,
  admitPresentationSnapshotResource,
  canonicalBase64FromBytes,
  createPresentationUnavailable,
  mcpAppResourceMimeType,
  presentationSnapshotResourceMimeType,
  presentationSnapshotUriSchema,
  snapshotIdFromUri,
  type PresentationSnapshotResource,
  type PresentationUnavailable,
  reviewOperationFromSnapshotUri,
  presentationResultPartBytes,
  presentationResultPartInputSchema,
  presentationResultPartSchema,
  presentationSnapshotResourceLink,
} from "./contracts.js";

const appResourceUriPrefix = "ui://littlejohn/presentation/" as const;
const codexMcpClientName = "codex-mcp-client" as const;
const mcpAppsExtensionId = "io.modelcontextprotocol/ui" as const;

export interface McpAppResource {
  readonly uri: string;
  readonly html: string;
  readonly utf8Bytes: number;
  readonly sha256: string;
}

export const chartAppResourceTemplate = (resource: McpAppResource): string =>
  `${appResourceUriPrefix}${resource.sha256}/cards/{cardId}.html`;
export const chartAppResourceUri = (resource: McpAppResource, cardId: string): string =>
  `${appResourceUriPrefix}${resource.sha256}/cards/${operationIdSchema.parse(cardId)}.html`;
export const chartCardIdFromAppResourceUri = (resource: McpAppResource, uri: string): string | undefined => {
  const prefix = `${appResourceUriPrefix}${resource.sha256}/cards/`;
  if (!uri.startsWith(prefix)) return undefined;
  if (!uri.endsWith(".html")) throw new TypeError("Chart App resource URI is invalid.");
  return operationIdSchema.parse(uri.slice(prefix.length, -".html".length));
};

export type McpAppConnection =
  | Readonly<{ status: "ordinary" }>
  | Readonly<{ status: "app"; serverAdapter: "standard" | "codex_result_association" }>;

const exactUtf8 = (value: CanonicalJson): Uint8Array =>
  new TextEncoder().encode(canonicalJsonStringify(value));

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
    return Object.freeze({ status: "app", serverAdapter: client?.name === codexMcpClientName ? "codex_result_association" : "standard" });
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
    ...(createsView && connection.serverAdapter === "standard" ? { resourceUri: resource.uri } : {}),
    visibility,
  });
  return Object.freeze({ ui });
};

const cardLinks = (result: CallToolResult): CallToolResult["content"] => {
  const value = result._meta?.[presentationCardMetadataKey];
  if (value === null || value === undefined) return [];
  const reference = cardReferenceSchema.parse(value);
  if (reference.kind !== "card") throw new TypeError("A stateful card reference is required.");
  return [{ type: "resource_link", name: `presentation_card_${reference.cardId}`,
    title: `${productDisplayName} card state`, description: "Saved state of this exact card.",
    uri: presentationCardUri(reference.cardId), mimeType: presentationSnapshotResourceMimeType }];
};

export const withCardReference = (result: CallToolResult): CallToolResult => ({
  ...result, content: [...result.content, ...cardLinks(result)],
});

export class McpAppPresentationService {
  readonly #store: PresentationSnapshotReadPort;
  readonly #reviews: LiveReviewPresentationPort;
  readonly resource: McpAppResource;

  constructor(store: PresentationSnapshotReadPort, resource: McpAppResource, reviews: LiveReviewPresentationPort) {
    this.#reviews = reviews;
    this.#store = store;
    this.resource = resource;
    Object.freeze(this);
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

  async #readAdmittedSnapshot(snapshotUri: unknown): Promise<ReturnType<typeof admitSnapshotRecord> | ReturnType<typeof admitSnapshotMetadata> | PresentationUnavailable> {
    const operationId = reviewOperationFromSnapshotUri(snapshotUri);
    if (operationId !== undefined) {
      const live = await this.#readLive(operationId);
      if ("kind" in live) return live;
      return live.resource.descriptor.snapshotUri === snapshotUri ? live : createPresentationUnavailable("snapshot_inconsistent");
    }
    let snapshotId: string;
    try { snapshotId = snapshotIdFromUri(snapshotUri); }
    catch { throw new TypeError("Presentation snapshot URI is invalid."); }
    let stored: ReturnType<PresentationSnapshotStore["readMetadata"]>;
    try { stored = await this.#store.readMetadata(snapshotId); }
    catch { return createPresentationUnavailable("runtime_unavailable"); }
    if (stored.status === "unavailable") return createPresentationUnavailable(stored.reason);
    try { return admitSnapshotMetadata(stored.value); }
    catch { return createPresentationUnavailable("snapshot_inconsistent"); }
  }

  async getSnapshotResult(snapshotUri: unknown): Promise<CallToolResult> {
    const admitted = await this.#readAdmittedSnapshot(snapshotUri);
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
    };
    if (value.kind === "presentation_unavailable") return result;
    if ("kind" in admitted) return result;
    return { ...result, content: [...result.content, presentationSnapshotResourceLink(admitted.resource)] };
  }

  async getResultChunk(snapshotUri: string, index: number): Promise<CanonicalJson> {
    if (reviewOperationFromSnapshotUri(snapshotUri) === undefined) {
      try {
        const chunk = await this.#store.readResultChunk({ snapshotId: snapshotIdFromUri(snapshotUri), index });
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
    if (!("admittedResult" in admitted)) return captureCanonicalJson(createPresentationUnavailable("snapshot_inconsistent"));
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

  async readImmutableResource(snapshotUri: unknown): Promise<PresentationSnapshotResource | PresentationUnavailable> {
    const input = presentationResultPartInputSchema.shape.snapshotUri.parse(snapshotUri);
    const admitted = await this.#readAdmittedSnapshot(input);
    if ("kind" in admitted) return admitted;
    if (admitted.entry.presentationKind !== "immutable_result" || admitted.entry.retention !== "sqlite" ||
      admitted.resource.descriptor.source.kind !== "sqlite") throw new TypeError("Only exact immutable data is available to models.");
    return admitted.resource;
  }

  async getResultPart(value: unknown): Promise<CanonicalJson> {
    const input = presentationResultPartInputSchema.parse(value);
    const resource = await this.readImmutableResource(input.snapshotUri);
    if (resource.kind === "presentation_unavailable") return captureCanonicalJson(resource);
    const descriptor = resource.descriptor;
    if (input.index >= descriptor.resultChunkCount) return captureCanonicalJson(createPresentationUnavailable("snapshot_inconsistent"));
    const chunk = await this.#store.readResultChunk({snapshotId: descriptor.snapshotId, index: input.index});
    if (chunk.status === "unavailable") return captureCanonicalJson(createPresentationUnavailable(chunk.reason));
    const expected = Math.min(descriptor.resultChunkBytes, descriptor.resultUtf8Bytes - input.index * descriptor.resultChunkBytes);
    if (chunk.value.snapshotId !== descriptor.snapshotId || chunk.value.index !== input.index || chunk.value.bytes.length !== expected) {
      return captureCanonicalJson(createPresentationUnavailable("snapshot_inconsistent"));
    }
    const partCount = Math.ceil(expected / presentationResultPartBytes);
    if (input.partIndex >= partCount) return captureCanonicalJson(createPresentationUnavailable("snapshot_inconsistent"));
    return captureCanonicalJson(presentationResultPartSchema.parse({kind: "presentation_result_part", snapshotId: descriptor.snapshotId,
      index: input.index, partIndex: input.partIndex, partCount,
      canonicalBase64: canonicalBase64FromBytes(chunk.value.bytes.slice(input.partIndex * presentationResultPartBytes,
        (input.partIndex + 1) * presentationResultPartBytes))}));
  }

  async readResource(uri: string): Promise<Readonly<{
    uri: string;
    mimeType: string;
    text: string;
    _meta?: Readonly<Record<string, unknown>>;
  }>> {
    const chartCardId = chartCardIdFromAppResourceUri(this.resource, uri);
    if (uri === this.resource.uri || chartCardId !== undefined) {
      return Object.freeze({
        uri,
        mimeType: mcpAppResourceMimeType,
        text: this.resource.html,
        _meta: Object.freeze({
          ...(chartCardId === undefined ? {} : { [presentationCardMetadataKey]: {kind: "card", cardId: chartCardId} }),
          ui: Object.freeze({
            prefersBorder: true,
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
  store: PresentationSnapshotReadPort,
  resource: McpAppResource,
  reviews: LiveReviewPresentationPort,
): Readonly<{
  service: McpAppPresentationService;
  connection(): McpAppConnection;
}> => {
  const service = new McpAppPresentationService(store, resource, reviews);
  return Object.freeze({
    service,
    connection: (): McpAppConnection =>
      admitMcpAppConnection(server.getClientCapabilities(), server.getClientVersion()),
  });
};
