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
  getRobinhoodOfficialAssetSourceErrorCode,
  RobinhoodOfficialAssetSourceError,
  type RobinhoodOfficialAssetSourceClient,
  type RobinhoodOfficialAssetSourceObservation,
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

const parseOfficialAssetSourceResponse = (
  bytesInput: Uint8Array,
  observedAtInput: unknown,
): OfficialAssetSourceSnapshot => {
  if (
    !(bytesInput instanceof Uint8Array) ||
    bytesInput.byteLength > robinhoodOfficialAssetSourceSettings.responseByteLimit
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
    sourceUri: officialAssetSourceDefinition.sourceUri,
    sourceObservedAt: parseUtcTimestamp(observedAtInput),
    rawResponseDigest: exactResponseDigest(bytesInput),
    memberSetDigest: officialAssetMemberSetDigest(members),
    candidateListDigest: officialAssetCandidateListDigest(members),
    chainId: officialAssetSourceDefinition.chainId,
    members,
  }));
};

const cancelResponseBody = (response: Response): void => {
  if (response.body !== null) void response.body.cancel().catch(() => undefined);
};

const assertContentType = (response: Response): void => {
  const contentType = response.headers.get("content-type");
  if (contentType === null || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    cancelResponseBody(response);
    throw new RobinhoodOfficialAssetSourceError("source_inconsistent");
  }
};

const readBoundedResponse = async (
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      BigInt(contentLength) > BigInt(robinhoodOfficialAssetSourceSettings.responseByteLimit)) {
      cancelResponseBody(response);
      throw new RobinhoodOfficialAssetSourceError("source_inconsistent");
    }
  }
  if (response.body === null) throw new RobinhoodOfficialAssetSourceError("source_inconsistent");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new RobinhoodOfficialAssetSourceError("request_aborted");
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          action();
        };
        const onAbort = (): void => finish(() => reject(new RobinhoodOfficialAssetSourceError("request_aborted")));
        signal.addEventListener("abort", onAbort, { once: true });
        reader.read().then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
      });
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw new RobinhoodOfficialAssetSourceError("source_inconsistent");
      }
      if (part.value.byteLength === 0) continue;
      total += part.value.byteLength;
      if (!Number.isSafeInteger(total) ||
        total > robinhoodOfficialAssetSourceSettings.responseByteLimit) {
        throw new RobinhoodOfficialAssetSourceError("source_inconsistent");
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

interface RobinhoodOfficialAssetSourceClientOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export const createRobinhoodOfficialAssetSourceClient = (
  options: RobinhoodOfficialAssetSourceClientOptions = {},
): RobinhoodOfficialAssetSourceClient => {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  if (typeof fetchFn !== "function" || typeof now !== "function") {
    throw new TypeError("Official asset source dependencies are invalid.");
  }
  return Object.freeze({
    async read(callerSignal: AbortSignal): Promise<RobinhoodOfficialAssetSourceObservation> {
      if (!(callerSignal instanceof AbortSignal)) {
        throw new TypeError("Official asset source abort signal is invalid.");
      }
      if (callerSignal.aborted) throw new RobinhoodOfficialAssetSourceError("request_aborted");
      const deadline = new AbortController();
      let deadlineReached = false;
      const timer = setTimeout(() => {
        deadlineReached = true;
        deadline.abort();
      }, robinhoodOfficialAssetSourceSettings.responseDeadlineMs);
      timer.unref();
      const signal = AbortSignal.any([callerSignal, deadline.signal]);
      try {
        const response = await fetchFn(officialAssetSourceDefinition.sourceUri, {
          ...robinhoodOfficialAssetSourceSettings.request,
          signal,
        });
        if (!(response instanceof Response)) {
          throw new RobinhoodOfficialAssetSourceError("source_inconsistent");
        }
        if (response.status !== 200) {
          cancelResponseBody(response);
          throw new RobinhoodOfficialAssetSourceError("source_unavailable");
        }
        assertContentType(response);
        const bytes = await readBoundedResponse(response, signal);
        const observedAt = now();
        if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
          throw new RobinhoodOfficialAssetSourceError("source_inconsistent");
        }
        try {
          const snapshot = parseOfficialAssetSourceResponse(bytes, observedAt.toISOString());
          return admitRobinhoodOfficialAssetSourceObservation(snapshot);
        } catch {
          throw new RobinhoodOfficialAssetSourceError("source_inconsistent");
        }
      } catch (error) {
        if (callerSignal.aborted) throw new RobinhoodOfficialAssetSourceError("request_aborted");
        if (deadlineReached) throw new RobinhoodOfficialAssetSourceError("source_unavailable");
        if (getRobinhoodOfficialAssetSourceErrorCode(error) !== undefined) throw error;
        throw new RobinhoodOfficialAssetSourceError("source_unavailable");
      } finally {
        clearTimeout(timer);
      }
    },
  });
};
