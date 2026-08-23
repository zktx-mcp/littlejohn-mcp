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
import {
  internalResponseLimitBytes,
} from "../../runtime/http-boundary.js";
import type {
  PresentationSnapshotRecord,
  PresentationSnapshotStore,
} from "../../runtime/presentation-snapshot.js";
import {
  admitPresentationSnapshotReference,
  admitPresentationSnapshotResource,
  canonicalBase64FromBytes,
  createPresentationSnapshotResource,
  createPresentationUnavailable,
  descriptorForPresentationSnapshot,
  mcpAppResourceMimeType,
  presentationSnapshotMetadataKey,
  presentationSnapshotResourceMimeType,
  presentationSnapshotUriSchema,
  snapshotIdFromUri,
  type PresentationSnapshotReference,
  type PresentationSnapshotResource,
  type PresentationUnavailable,
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

const readCanonicalBytes = (bytes: Uint8Array): CanonicalJson => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = captureCanonicalJson(JSON.parse(text));
  if (canonicalJsonStringify(value) !== text) {
    throw new TypeError("Stored presentation value is not canonical JSON.");
  }
  return value;
};

const exactRecord = (
  left: PresentationSnapshotRecord,
  right: PresentationSnapshotRecord,
): boolean => left.snapshotId === right.snapshotId &&
  left.contractId === right.contractId && left.contractVersion === right.contractVersion &&
  left.inputDigest === right.inputDigest && left.resultDigest === right.resultDigest &&
  Buffer.compare(Buffer.from(left.inputBytes), Buffer.from(right.inputBytes)) === 0 &&
  Buffer.compare(Buffer.from(left.resultBytes), Buffer.from(right.resultBytes)) === 0;

const boundedResource = (
  record: PresentationSnapshotRecord,
  normalizedInput: CanonicalJson,
): PresentationSnapshotResource => {
  const resource = createPresentationSnapshotResource(record, normalizedInput);
  if (exactUtf8(captureCanonicalJson(resource)).length > internalResponseLimitBytes) {
    throw new RangeError("Presentation snapshot resource exceeds its response bound.");
  }
  return resource;
};

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
      content: [...result.content, snapshotLink(resource)],
      _meta: { ...result._meta, [presentationSnapshotMetadataKey]: resource },
    };

const snapshotHandoff = (
  resource: PresentationSnapshotResource,
): CallToolResult => Object.freeze({
  content: [snapshotLink(resource)],
  _meta: Object.freeze({ [presentationSnapshotMetadataKey]: resource }),
});

export type McpAppPresentationHandoff =
  | Readonly<{ status: "available"; result: CallToolResult }>
  | PresentationUnavailable;

const reAdmitRecord = (record: PresentationSnapshotRecord): Readonly<{
  entry: PresentationContractEntry;
  normalizedInput: CanonicalJson;
  admittedResult: CanonicalJson;
  resource: PresentationSnapshotResource;
}> => {
  const entry = presentationContractRegistry.requireIdentity(
    record.contractId,
    record.contractVersion,
  );
  const normalizedInput = entry.parseNormalizedInput(readCanonicalBytes(record.inputBytes));
  const admittedResult = entry.parseResult(
    normalizedInput,
    readCanonicalBytes(record.resultBytes),
  );
  if (
    Buffer.compare(Buffer.from(exactUtf8(normalizedInput)), Buffer.from(record.inputBytes)) !== 0 ||
    Buffer.compare(Buffer.from(exactUtf8(admittedResult)), Buffer.from(record.resultBytes)) !== 0
  ) throw new TypeError("Stored presentation pair changed during canonical re-admission.");
  return Object.freeze({
    entry,
    normalizedInput,
    admittedResult,
    resource: boundedResource(record, normalizedInput),
  });
};

export class McpAppPresentationService {
  readonly #store: PresentationSnapshotStore;
  readonly resource: McpAppResource;

  constructor(store: PresentationSnapshotStore, resource: McpAppResource) {
    this.#store = store;
    this.resource = resource;
    Object.freeze(this);
  }

  present(
    contract: object,
    input: unknown,
    result: unknown,
  ): McpAppPresentationHandoff {
    const entry = presentationContractRegistry.forContract(contract);
    if (entry === undefined) return createPresentationUnavailable("snapshot_inconsistent");
    let normalizedInput: CanonicalJson;
    let admittedResult: CanonicalJson;
    try {
      normalizedInput = entry.parseInput(input);
      admittedResult = entry.parseResult(normalizedInput, result);
    } catch {
      return createPresentationUnavailable("snapshot_inconsistent");
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
    try { boundedResource(candidate.value, normalizedInput); }
    catch {
      return createPresentationUnavailable("capacity_exceeded");
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
      result: snapshotHandoff(boundedResource(committed.value, normalizedInput)),
    });
  }

  #readAdmittedSnapshot(snapshotUri: unknown):
    | ReturnType<typeof reAdmitRecord>
    | PresentationUnavailable {
    let snapshotId: string;
    try { snapshotId = snapshotIdFromUri(snapshotUri); }
    catch { throw new TypeError("Presentation snapshot URI is invalid."); }
    let stored: ReturnType<PresentationSnapshotStore["read"]>;
    try { stored = this.#store.read(snapshotId); }
    catch { return createPresentationUnavailable("runtime_unavailable"); }
    if (stored.status === "unavailable") return createPresentationUnavailable(stored.reason);
    try { return reAdmitRecord(stored.value); }
    catch { return createPresentationUnavailable("snapshot_inconsistent"); }
  }

  getSnapshot(snapshotUri: unknown): PresentationSnapshotReference | PresentationUnavailable {
    const admitted = this.#readAdmittedSnapshot(snapshotUri);
    if ("kind" in admitted) return admitted;
    return admitPresentationSnapshotReference({
      kind: "presentation_snapshot_reference",
      snapshotUri: admitted.resource.descriptor.snapshotUri,
      descriptor: admitted.resource.descriptor,
    });
  }

  getSnapshotResult(snapshotUri: unknown): CallToolResult {
    const admitted = this.#readAdmittedSnapshot(snapshotUri);
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
    return withSnapshot(result, admitted.resource);
  }

  getResultChunk(snapshotId: string, index: number): CanonicalJson {
    let chunk: ReturnType<PresentationSnapshotStore["readResultChunk"]>;
    try { chunk = this.#store.readResultChunk({ snapshotId, index }); }
    catch {
      return captureCanonicalJson(createPresentationUnavailable("runtime_unavailable"));
    }
    if (chunk.status === "unavailable") return captureCanonicalJson(
      createPresentationUnavailable(chunk.reason),
    );
    return captureCanonicalJson({
      kind: "presentation_snapshot_chunk",
      snapshotId: chunk.value.snapshotId,
      index: chunk.value.index,
      canonicalBase64: canonicalBase64FromBytes(chunk.value.bytes),
    });
  }

  readSnapshotResource(snapshotUri: unknown): PresentationSnapshotResource | PresentationUnavailable {
    const admitted = this.#readAdmittedSnapshot(snapshotUri);
    return "kind" in admitted
      ? admitted
      : admitPresentationSnapshotResource(admitted.resource);
  }

  readResource(uri: string): Readonly<{
    uri: string;
    mimeType: string;
    text: string;
    _meta?: Readonly<Record<string, unknown>>;
  }> {
    if (uri === this.resource.uri) {
      return Object.freeze({
        uri,
        mimeType: mcpAppResourceMimeType,
        text: this.resource.html,
        _meta: Object.freeze({
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
    const snapshot = this.readSnapshotResource(parsedUri);
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
): Readonly<{
  service: McpAppPresentationService;
  connection(): McpAppConnection;
}> => {
  const service = new McpAppPresentationService(store, resource);
  return Object.freeze({
    service,
    connection: (): McpAppConnection =>
      admitMcpAppConnection(server.getClientCapabilities(), server.getClientVersion()),
  });
};
