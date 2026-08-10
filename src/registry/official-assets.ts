import type { ReadableStreamReadResult } from "node:stream/web";
import { z } from "zod";

import {
  compareCodePointSequences,
  deepFreezeValue,
  parseEvmAddressInput,
  parseHash32,
  parseUtcTimestamp,
  productChainNumericId,
  sha256Bytes,
  type Hash32,
} from "../core/index.js";
import {
  assertOfficialAssetSourceMember,
  officialAssetCandidateListDigest,
  officialAssetMemberSetDigest,
  officialAssetSourceDefinition,
  officialAssetSourceLabelSchema,
  officialAssetSourceSnapshotSchema,
  type OfficialAssetSourceMember,
  type OfficialAssetSourceSnapshot,
} from "./official-asset-contract.js";
import {
  admitRobinhoodOfficialAssetSourceObservation,
  officialAssetSourceObserved,
  officialAssetSourceUnavailable,
  type RobinhoodOfficialAssetSourceClient,
  type RobinhoodOfficialAssetSourceReadResult,
  type RobinhoodOfficialAssetSourceUnavailableResult,
} from "./official-asset-source-contract.js";

const robinhoodOfficialAssetSourceSettings = deepFreezeValue({
  activeStatus: "ASSET_STATUS_ACTIVE",
  deploymentChainId: productChainNumericId,
  responseByteLimit: 1_048_576,
  deploymentLimit: 8,
  responseDeadlineMs: 10_000,
  request: {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    credentials: "omit",
  },
} as const);

const responseDeploymentSchema = z.object({
  chainId: z.number().int().positive().safe(),
  contractAddress: z.unknown(),
}).strip();

const responseAssetSchema = z.object({
  id: z.unknown(),
  status: z.unknown(),
  deployments: z.array(responseDeploymentSchema)
    .max(robinhoodOfficialAssetSourceSettings.deploymentLimit),
  tokenName: z.unknown().optional(),
  tokenSymbol: z.unknown().optional(),
}).strip();

const sourceResponseSchema = z.object({
  assets: z.array(responseAssetSchema)
    .min(1)
    .max(officialAssetSourceDefinition.memberLimit),
}).strip();

const normalizedSourceLabel = (value: unknown): string | undefined =>
  officialAssetSourceLabelSchema.safeParse(value).data;

const compareMembers = (
  left: OfficialAssetSourceMember,
  right: OfficialAssetSourceMember,
): number => compareCodePointSequences(left.assetUid, right.assetUid) ||
  compareCodePointSequences(left.contractAddress, right.contractAddress);

const normalizeSourceResponse = (
  parsed: unknown,
): readonly OfficialAssetSourceMember[] => {
  const response = sourceResponseSchema.parse(parsed);
  const members = response.assets.map((entry): OfficialAssetSourceMember => {
    if (entry.status !== robinhoodOfficialAssetSourceSettings.activeStatus) {
      throw new TypeError("The official asset response contains a non-active status.");
    }
    const assetUid = parseHash32(entry.id);
    const normalizedDeployments = entry.deployments.map((deployment) => ({
      chainId: deployment.chainId,
      contractAddress: parseEvmAddressInput(deployment.contractAddress),
    }));
    const deployments = normalizedDeployments.filter(
      (deployment) =>
        deployment.chainId === robinhoodOfficialAssetSourceSettings.deploymentChainId,
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

const parseProviderMembers = (
  bytes: Uint8Array,
): readonly OfficialAssetSourceMember[] | undefined => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return normalizeSourceResponse(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
};

const constructOfficialAssetSourceSnapshot = (
  bytes: Uint8Array,
  members: readonly OfficialAssetSourceMember[],
  observedAtInput: unknown,
): OfficialAssetSourceSnapshot => {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("The official asset response body is invalid.");
  }
  return deepFreezeValue(officialAssetSourceSnapshotSchema.parse({
    sourceUri: officialAssetSourceDefinition.sourceUri,
    sourceObservedAt: parseUtcTimestamp(observedAtInput),
    rawResponseDigest: exactResponseDigest(bytes),
    memberSetDigest: officialAssetMemberSetDigest(members),
    candidateListDigest: officialAssetCandidateListDigest(members),
    chainId: officialAssetSourceDefinition.chainId,
    members,
  }));
};

const cancelResponseBody = (response: Response): void => {
  if (response.body !== null) void response.body.cancel().catch(() => undefined);
};

const hasJsonContentType = (response: Response): boolean => {
  const contentType = response.headers.get("content-type");
  return contentType !== null &&
    contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
};

type BoundedResponseResult =
  | Readonly<{ status: "complete"; bytes: Uint8Array }>
  | RobinhoodOfficialAssetSourceUnavailableResult;

const readBoundedResponse = async (
  response: Response,
  signal: AbortSignal,
  callerSignal: AbortSignal,
  deadlineReached: () => boolean,
): Promise<BoundedResponseResult> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      cancelResponseBody(response);
      return officialAssetSourceUnavailable("source_inconsistent");
    }
    if (BigInt(contentLength) > BigInt(robinhoodOfficialAssetSourceSettings.responseByteLimit)) {
      cancelResponseBody(response);
      return officialAssetSourceUnavailable("official_asset_response_too_large");
    }
  }
  if (response.body === null) {
    return officialAssetSourceUnavailable("source_inconsistent");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (callerSignal.aborted) {
        void reader.cancel().catch(() => undefined);
        return officialAssetSourceUnavailable("request_aborted");
      }
      if (deadlineReached()) {
        void reader.cancel().catch(() => undefined);
        return officialAssetSourceUnavailable("official_asset_response_unavailable");
      }
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          let settled = false;
          const finish = (action: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            action();
          };
          const onAbort = (): void => finish(() => reject(new DOMException(
            "The official asset response was interrupted.",
            "AbortError",
          )));
          signal.addEventListener("abort", onAbort, { once: true });
          reader.read().then(
            (value) => finish(() => resolve(value)),
            (error: unknown) => finish(() => reject(error)),
          );
        });
      } catch {
        void reader.cancel().catch(() => undefined);
        if (callerSignal.aborted) {
          return officialAssetSourceUnavailable("request_aborted");
        }
        return officialAssetSourceUnavailable("official_asset_response_unavailable");
      }
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw new TypeError("The official asset response stream produced a non-byte value.");
      }
      if (part.value.byteLength === 0) continue;
      total += part.value.byteLength;
      if (!Number.isSafeInteger(total) ||
        total > robinhoodOfficialAssetSourceSettings.responseByteLimit) {
        void reader.cancel().catch(() => undefined);
        return officialAssetSourceUnavailable("official_asset_response_too_large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Object.freeze({ status: "complete", bytes });
};

interface RobinhoodOfficialAssetSourceClientOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export const createRobinhoodOfficialAssetSourceClient = (
  options: RobinhoodOfficialAssetSourceClientOptions = {},
): RobinhoodOfficialAssetSourceClient => {
  const fetchFn = options.fetch === undefined ? fetch : options.fetch;
  const now = options.now === undefined ? () => new Date() : options.now;
  if (typeof fetchFn !== "function" || typeof now !== "function") {
    throw new TypeError("Official asset source dependencies are invalid.");
  }
  return Object.freeze({
    async read(callerSignal: AbortSignal): Promise<RobinhoodOfficialAssetSourceReadResult> {
      if (!(callerSignal instanceof AbortSignal)) {
        throw new TypeError("Official asset source abort signal is invalid.");
      }
      if (callerSignal.aborted) return officialAssetSourceUnavailable("request_aborted");
      const deadline = new AbortController();
      let deadlineReached = false;
      const timer = setTimeout(() => {
        deadlineReached = true;
        deadline.abort();
      }, robinhoodOfficialAssetSourceSettings.responseDeadlineMs);
      timer.unref();
      const signal = AbortSignal.any([callerSignal, deadline.signal]);
      let response: Response;
      try {
        response = await fetchFn(officialAssetSourceDefinition.sourceUri, {
          ...robinhoodOfficialAssetSourceSettings.request,
          signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (callerSignal.aborted) return officialAssetSourceUnavailable("request_aborted");
        if (deadlineReached) {
          return officialAssetSourceUnavailable("official_asset_response_unavailable");
        }
        return officialAssetSourceUnavailable("official_asset_response_unavailable");
      }
      if (!(response instanceof Response)) {
        clearTimeout(timer);
        throw new TypeError("Official asset source returned an invalid response.");
      }
      if (response.status !== 200) {
        cancelResponseBody(response);
        clearTimeout(timer);
        return officialAssetSourceUnavailable(
          response.status === 429 ? "rate_limited" : "source_unavailable",
        );
      }
      if (!hasJsonContentType(response)) {
        cancelResponseBody(response);
        clearTimeout(timer);
        return officialAssetSourceUnavailable("source_inconsistent");
      }
      let body: BoundedResponseResult;
      try {
        body = await readBoundedResponse(
          response,
          signal,
          callerSignal,
          () => deadlineReached,
        );
      } finally {
        clearTimeout(timer);
      }
      if (body.status === "unavailable") return body;
      const members = parseProviderMembers(body.bytes);
      if (members === undefined) {
        return officialAssetSourceUnavailable("source_inconsistent");
      }
      const observedAt = now();
      if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
        throw new TypeError("Official asset source clock returned an invalid value.");
      }
      const snapshot = constructOfficialAssetSourceSnapshot(
        body.bytes,
        members,
        observedAt.toISOString(),
      );
      return officialAssetSourceObserved(
        admitRobinhoodOfficialAssetSourceObservation(snapshot),
      );
    },
  });
};
