import { z } from "zod";

import {
  canonicalSha256,
  compareCodePointSequences,
  deepFreezeValue,
  parseEvmAddressInput,
  parseHash32,
  parseUtcTimestamp,
  sha256Bytes,
  type EvmAddress,
  type Hash32,
} from "../core/index.js";
import {
  committedOfficialAssetSnapshotSchema,
  officialAssetSourceLabelSchema,
  officialAssetSourceManifest,
  officialAssetSourceMemberSchema,
  officialAssetSourceSnapshotSchema,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSnapshotRevision,
  type OfficialAssetSourceMember,
  type OfficialAssetSourceSnapshot,
} from "./official-asset-contract.js";

const admittedSourceObservations = new WeakSet<object>();

declare const officialAssetSourceObservationBrand: unique symbol;
export interface OfficialAssetSourceObservation extends OfficialAssetSourceSnapshot {
  readonly [officialAssetSourceObservationBrand]: true;
}

export interface OfficialAssetSnapshotStore {
  readSnapshot(): CommittedOfficialAssetSnapshot | undefined;
  replaceSnapshot(
    snapshot: OfficialAssetSourceObservation,
    expectedRevision: OfficialAssetSnapshotRevision | null,
  ): CommittedOfficialAssetSnapshot;
}

export const findOfficialAssetMember = (
  snapshot: OfficialAssetSourceSnapshot,
  contractAddress: EvmAddress,
): OfficialAssetSourceMember | undefined => snapshot.members.find(
  (member) => member.contractAddress === contractAddress,
);

export type OfficialAssetSourceErrorCode =
  | "request_aborted"
  | "source_inconsistent"
  | "source_unavailable";

const sourceErrorCodes = new WeakMap<object, OfficialAssetSourceErrorCode>();

export class OfficialAssetSourceError extends Error {
  override readonly name = "OfficialAssetSourceError";
  readonly code: OfficialAssetSourceErrorCode;

  constructor(code: OfficialAssetSourceErrorCode) {
    super(code);
    this.code = code;
    sourceErrorCodes.set(this, code);
    Object.freeze(this);
  }
}

export const getOfficialAssetSourceErrorCode = (
  error: unknown,
): OfficialAssetSourceErrorCode | undefined =>
  typeof error === "object" && error !== null ? sourceErrorCodes.get(error) : undefined;

const responseDeploymentSchema = z.object({
  chainId: z.number().int().positive().safe(),
  contractAddress: z.unknown(),
}).strip();

const responseAssetSchema = z.object({
  id: z.unknown(),
  status: z.unknown(),
  deployments: z.array(responseDeploymentSchema)
    .max(officialAssetSourceManifest.deploymentLimit),
  tokenName: z.unknown().optional(),
  tokenSymbol: z.unknown().optional(),
}).strip();

const sourceResponseSchema = z.object({
  assets: z.array(responseAssetSchema)
    .min(1)
    .max(officialAssetSourceManifest.memberLimit),
}).strip();

const normalizedSourceLabel = (value: unknown): string | undefined =>
  officialAssetSourceLabelSchema.safeParse(value).data;

const compareMembers = (
  left: OfficialAssetSourceMember,
  right: OfficialAssetSourceMember,
): number => compareCodePointSequences(left.assetUid, right.assetUid) ||
  compareCodePointSequences(left.contractAddress, right.contractAddress);

export const assertOfficialAssetSourceMember = (
  input: OfficialAssetSourceMember,
): OfficialAssetSourceMember =>
  deepFreezeValue(officialAssetSourceMemberSchema.parse(input));

const memberSetPayload = (
  members: readonly OfficialAssetSourceMember[],
) => ({
  version: "1",
  chainId: officialAssetSourceManifest.chainId,
  sourceUri: officialAssetSourceManifest.sourceUri,
  members: members.map((member) => ({
    assetUid: member.assetUid,
    contractAddress: member.contractAddress,
  })),
}) as const;

const candidateListPayload = (
  members: readonly OfficialAssetSourceMember[],
) => ({
  version: "1",
  chainId: officialAssetSourceManifest.chainId,
  sourceUri: officialAssetSourceManifest.sourceUri,
  members: members.map((member) => ({
    assetUid: member.assetUid,
    contractAddress: member.contractAddress,
    sourceName: member.sourceName ?? null,
    sourceSymbol: member.sourceSymbol ?? null,
  })),
}) as const;

export const officialAssetMemberSetDigest = (
  members: readonly OfficialAssetSourceMember[],
): Hash32 => parseHash32(`0x${canonicalSha256(memberSetPayload(members))}`);

export const officialAssetCandidateListDigest = (
  members: readonly OfficialAssetSourceMember[],
): Hash32 => parseHash32(`0x${canonicalSha256(candidateListPayload(members))}`);

const normalizeSourceResponse = (
  parsed: unknown,
): readonly OfficialAssetSourceMember[] => {
  const response = sourceResponseSchema.parse(parsed);
  const members = response.assets.map((entry): OfficialAssetSourceMember => {
    if (entry.status !== officialAssetSourceManifest.activeStatus) {
      throw new TypeError("The official asset response contains a non-active status.");
    }
    const assetUid = parseHash32(entry.id);
    const normalizedDeployments = entry.deployments.map((deployment) => ({
      chainId: deployment.chainId,
      contractAddress: parseEvmAddressInput(deployment.contractAddress),
    }));
    const deployments = normalizedDeployments.filter(
      (deployment) =>
        deployment.chainId === officialAssetSourceManifest.deploymentChainId,
    );
    if (deployments.length !== 1) {
      throw new TypeError("The official asset response requires one Robinhood Chain deployment.");
    }
    const contractAddress = deployments[0]?.contractAddress;
    if (contractAddress === undefined) {
      throw new TypeError("The official asset response requires one Robinhood Chain deployment.");
    }
    const sourceName = normalizedSourceLabel(entry.tokenName);
    const sourceSymbol = normalizedSourceLabel(entry.tokenSymbol);
    return assertOfficialAssetSourceMember({
      assetUid,
      contractAddress,
      ...(sourceName === undefined ? {} : { sourceName }),
      ...(sourceSymbol === undefined ? {} : { sourceSymbol }),
    });
  }).sort(compareMembers);

  for (let index = 1; index < members.length; index += 1) {
    const previous = members[index - 1] as OfficialAssetSourceMember;
    const current = members[index] as OfficialAssetSourceMember;
    if (previous.assetUid === current.assetUid) {
      throw new TypeError("The official asset response contains a duplicate UID.");
    }
  }
  const addresses = new Set<string>();
  for (const member of members) {
    if (addresses.has(member.contractAddress)) {
      throw new TypeError("The official asset response contains a duplicate token address.");
    }
    addresses.add(member.contractAddress);
  }
  return deepFreezeValue(members);
};

const exactResponseDigest = (bytes: Uint8Array): Hash32 =>
  parseHash32(`0x${sha256Bytes(bytes)}`);

const parseOfficialAssetSourceResponse = (
  bytesInput: Uint8Array,
  observedAtInput: unknown,
): OfficialAssetSourceSnapshot => {
  if (
    !(bytesInput instanceof Uint8Array) ||
    bytesInput.byteLength > officialAssetSourceManifest.responseByteLimit
  ) {
    throw new TypeError("The official asset response exceeds its byte limit.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytesInput);
  } catch {
    throw new TypeError("The official asset response is not valid UTF-8.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("The official asset response is not valid JSON.");
  }
  const members = normalizeSourceResponse(parsed);
  return deepFreezeValue(officialAssetSourceSnapshotSchema.parse({
    sourceUri: officialAssetSourceManifest.sourceUri,
    sourceObservedAt: parseUtcTimestamp(observedAtInput),
    rawResponseDigest: exactResponseDigest(bytesInput),
    memberSetDigest: officialAssetMemberSetDigest(members),
    candidateListDigest: officialAssetCandidateListDigest(members),
    chainId: officialAssetSourceManifest.chainId,
    members,
  }));
};

export const assertOfficialAssetSourceSnapshot = (
  input: OfficialAssetSourceSnapshot,
): OfficialAssetSourceSnapshot => {
  const parsed = officialAssetSourceSnapshotSchema.parse(input);
  const members = parsed.members.map(assertOfficialAssetSourceMember);
  for (let index = 0; index < members.length; index += 1) {
    const original = parsed.members[index] as OfficialAssetSourceMember;
    const member = members[index] as OfficialAssetSourceMember;
    if (compareMembers(original, member) !== 0 ||
      (index > 0 && compareMembers(members[index - 1] as OfficialAssetSourceMember, member) >= 0)) {
      throw new TypeError("Official asset snapshot members are not in canonical order.");
    }
  }
  const addresses = new Set(members.map((member) => member.contractAddress));
  const uids = new Set(members.map((member) => member.assetUid));
  if (addresses.size !== members.length || uids.size !== members.length) {
    throw new TypeError("Official asset snapshot contains a duplicate identity.");
  }
  const memberSetDigest = parsed.memberSetDigest;
  const candidateListDigest = parsed.candidateListDigest;
  if (
    memberSetDigest !== officialAssetMemberSetDigest(members) ||
    candidateListDigest !== officialAssetCandidateListDigest(members)
  ) throw new TypeError("Official asset snapshot digests are invalid.");
  return deepFreezeValue(officialAssetSourceSnapshotSchema.parse({
    sourceUri: officialAssetSourceManifest.sourceUri,
    sourceObservedAt: parsed.sourceObservedAt,
    rawResponseDigest: parsed.rawResponseDigest,
    memberSetDigest,
    candidateListDigest,
    chainId: officialAssetSourceManifest.chainId,
    members,
  }));
};

export const assertOfficialAssetSourceObservation = (
  input: OfficialAssetSourceObservation,
): OfficialAssetSourceObservation => {
  if (!admittedSourceObservations.has(input)) {
    throw new TypeError("The official asset snapshot was not admitted from the source response.");
  }
  return assertOfficialAssetSourceSnapshot(input) as OfficialAssetSourceObservation;
};

const cancelResponseBody = (response: Response): void => {
  if (response.body !== null) void response.body.cancel().catch(() => undefined);
};

const assertContentType = (response: Response): void => {
  const contentType = response.headers.get("content-type");
  if (contentType === null || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    cancelResponseBody(response);
    throw new OfficialAssetSourceError("source_inconsistent");
  }
};

const readBoundedResponse = async (
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      BigInt(contentLength) > BigInt(officialAssetSourceManifest.responseByteLimit)) {
      cancelResponseBody(response);
      throw new OfficialAssetSourceError("source_inconsistent");
    }
  }
  if (response.body === null) throw new OfficialAssetSourceError("source_inconsistent");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new OfficialAssetSourceError("request_aborted");
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          action();
        };
        const onAbort = (): void => finish(() => reject(new OfficialAssetSourceError("request_aborted")));
        signal.addEventListener("abort", onAbort, { once: true });
        reader.read().then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
      });
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw new OfficialAssetSourceError("source_inconsistent");
      }
      if (part.value.byteLength === 0) continue;
      total += part.value.byteLength;
      if (!Number.isSafeInteger(total) ||
        total > officialAssetSourceManifest.responseByteLimit) {
        throw new OfficialAssetSourceError("source_inconsistent");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export interface OfficialAssetSourceClient {
  read(signal: AbortSignal): Promise<OfficialAssetSourceObservation>;
}

export interface OfficialAssetSourceClientOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export const createOfficialAssetSourceClient = (
  options: OfficialAssetSourceClientOptions = {},
): OfficialAssetSourceClient => {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  if (typeof fetchFn !== "function" || typeof now !== "function") {
    throw new TypeError("Official asset source dependencies are invalid.");
  }
  return Object.freeze({
    async read(callerSignal: AbortSignal): Promise<OfficialAssetSourceObservation> {
      if (!(callerSignal instanceof AbortSignal)) {
        throw new TypeError("Official asset source abort signal is invalid.");
      }
      if (callerSignal.aborted) throw new OfficialAssetSourceError("request_aborted");
      const deadline = new AbortController();
      let deadlineReached = false;
      const timer = setTimeout(() => {
        deadlineReached = true;
        deadline.abort();
      }, officialAssetSourceManifest.responseDeadlineMs);
      timer.unref();
      const signal = AbortSignal.any([callerSignal, deadline.signal]);
      try {
        const response = await fetchFn(officialAssetSourceManifest.sourceUri, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          credentials: "omit",
          signal,
        });
        if (!(response instanceof Response)) {
          throw new OfficialAssetSourceError("source_inconsistent");
        }
        if (response.status !== 200) {
          cancelResponseBody(response);
          throw new OfficialAssetSourceError("source_unavailable");
        }
        assertContentType(response);
        const bytes = await readBoundedResponse(response, signal);
        const observedAt = now();
        if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
          throw new OfficialAssetSourceError("source_inconsistent");
        }
        try {
          const snapshot = parseOfficialAssetSourceResponse(bytes, observedAt.toISOString());
          admittedSourceObservations.add(snapshot);
          return snapshot as OfficialAssetSourceObservation;
        } catch {
          throw new OfficialAssetSourceError("source_inconsistent");
        }
      } catch (error) {
        if (callerSignal.aborted) throw new OfficialAssetSourceError("request_aborted");
        if (deadlineReached) throw new OfficialAssetSourceError("source_unavailable");
        if (getOfficialAssetSourceErrorCode(error) !== undefined) throw error;
        throw new OfficialAssetSourceError("source_unavailable");
      } finally {
        clearTimeout(timer);
      }
    },
  });
};

export const assertCommittedOfficialAssetSnapshot = (
  input: CommittedOfficialAssetSnapshot,
): CommittedOfficialAssetSnapshot => {
  const parsed = committedOfficialAssetSnapshotSchema.parse(input);
  const snapshot = assertOfficialAssetSourceSnapshot({
    sourceUri: parsed.sourceUri,
    sourceObservedAt: parsed.sourceObservedAt,
    rawResponseDigest: parsed.rawResponseDigest,
    memberSetDigest: parsed.memberSetDigest,
    candidateListDigest: parsed.candidateListDigest,
    chainId: parsed.chainId,
    members: parsed.members,
  });
  return deepFreezeValue({
    ...snapshot,
    revision: parsed.revision,
    updatedAt: parsed.updatedAt,
  });
};
