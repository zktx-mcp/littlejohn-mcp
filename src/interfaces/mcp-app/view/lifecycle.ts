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
  type CanonicalJson,
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
  presentationUnavailableSchema,
  type PresentationSnapshotReference,
  type PresentationSnapshotResource,
} from "../contracts.js";
import {
  presentationContractRegistry,
  type PresentationContractEntry,
} from "../registry.js";
import { admitCreatingToolError } from "./creating-tool-error.js";
import { claudeViewHostName, codexViewHostName } from "./host-identities.js";

const claudeFlattenedSnapshotLinkPattern =
  /^\[Resource link: presentation_snapshot_([0-9a-f]{64})\] (littlejohn:\/\/presentation\/snapshots\/sha256\/([0-9a-f]{64})) \(Exact immutable presentation input and descriptor\.\)$/u;

export interface AdmittedPresentation {
  readonly entry: PresentationContractEntry;
  readonly normalizedInput: CanonicalJson;
  readonly result: CanonicalJson;
}

export type PresentationToolResultAdmission =
  | Readonly<{
      status: "presentation";
      presentation: AdmittedPresentation;
    }>
  | Readonly<{
      status: "tool_error";
      message: string;
    }>;

export interface PresentationViewApp {
  getHostCapabilities(): Readonly<{
    readonly serverResources?: unknown;
    readonly serverTools?: unknown;
  }> | undefined;
  getHostVersion(): Implementation | undefined;
  callServerTool(
    params: CallToolRequest["params"],
    options?: RequestOptions,
  ): Promise<CallToolResult>;
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
      item.uri.startsWith(presentationSnapshotUriPrefix) &&
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

const readExactSnapshotResource = async (
  app: PresentationViewApp,
  uri: string,
  signal: AbortSignal,
): Promise<PresentationSnapshotResource> => {
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
  return admitPresentationSnapshotResource(captured);
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
): Promise<PresentationSnapshotResource> => {
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
      return privateResource;
    }
    return readExactSnapshotResource(app, links[0].uri, signal);
  }
  if (links.length > 1) throw new TypeError("The result contains multiple presentation resources.");
  if (privateResource !== undefined && app.getHostVersion()?.name === claudeViewHostName) {
    if (privateResource.descriptor.snapshotUri !== reference.snapshotUri) {
      throw new TypeError("Presentation resource metadata and reference differ.");
    }
    return privateResource;
  }
  return readExactSnapshotResource(app, reference.snapshotUri, signal);
};

const reconstructResult = async (
  app: PresentationViewApp,
  resource: PresentationSnapshotResource,
  signal: AbortSignal,
): Promise<CanonicalJson> => {
  if (!app.getHostCapabilities()?.serverTools) {
    throw new TypeError("The Host cannot read exact presentation chunks.");
  }
  const descriptor = resource.descriptor;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < descriptor.resultChunkCount; index += 1) {
    const response = await app.callServerTool({
      name: presentationMcpTools.getSnapshotChunk,
      arguments: { snapshotId: descriptor.snapshotId, index },
    }, { signal });
    if (response.isError) throw new TypeError("Presentation chunk read failed.");
    const chunk = presentationSnapshotChunkSchema.parse(
      captureCanonicalJson(response.structuredContent),
    );
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
  return canonicalFromBytes(joined);
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
    });
  }
  const privateValue = result._meta?.[presentationSnapshotMetadataKey];
  const unavailable = presentationUnavailableSchema.safeParse(privateValue);
  if (unavailable.success) {
    throw new TypeError(`Presentation unavailable: ${unavailable.data.reason}.`);
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
  const resource = reference === undefined
    ? directResourceForResult(app, result)
    : await replayResourceForResult(app, result, reference, signal);
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
    candidate = await reconstructResult(app, resource, signal);
  } else {
    candidate = structured;
  }

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
  if (!sameBytes(exactBytes(normalizedInput), inputBytes) ||
    !sameBytes(exactBytes(admittedResult), resultBytes)) {
    throw new TypeError("Presentation pair changed during canonical re-admission.");
  }
  return Object.freeze({
    status: "presentation",
    presentation: Object.freeze({ entry, normalizedInput, result: admittedResult }),
  });
};
