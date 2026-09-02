import { describe, expect, it } from "vitest";

import {
  accountAssetApplicationContracts,
  accountAssetLimits,
  accountAssetOverviewQueryContract,
  createAccountAssetAmount,
} from "../../src/account-assets/contracts.js";
import {
  canonicalJsonStringify,
  captureCanonicalJson,
  maximumEvmBalanceRaw,
  parseEvmAddressInput,
  parseEvmChainId,
  parseHash32,
  parseUtcTimestamp,
} from "../../src/core/index.js";
import {
  officialAssetSourceDefinition,
  stockFactoryAdmissionManifest,
} from "../../src/registry/client.js";
import {
  officialAssetCandidateListDigest,
  officialAssetMemberSetDigest,
} from "../../src/registry/official-asset-contract.js";
import {
  internalResponseLimitBytes,
  publicReadResponseLimitBytes,
} from "../../src/runtime/http-boundary.js";

const chainId = parseEvmChainId("eip155:4663");
const accountAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
const at = parseUtcTimestamp("2026-07-21T00:00:00.000Z");
const block = {
  chainId,
  blockNumber: maximumEvmBalanceRaw,
  blockHash: `0x${"ff".repeat(32)}`,
  blockTimestamp: at,
};
const snapshotRevision = Buffer.alloc(16, 1).toString("base64url");
const selectionSetRevision = Buffer.alloc(16, 2).toString("base64url");
const maximumText = "🧪".repeat(128);

const maximumAssets = (count: number) => {
  const members = Array.from({ length: count }, (_, index) => {
    const identity = (index + 1).toString(16);
    return {
      assetUid: parseHash32(`0x${identity.padStart(64, "0")}`),
      contractAddress: parseEvmAddressInput(`0x${identity.padStart(40, "0")}`),
      sourceName: maximumText,
      sourceSymbol: maximumText,
    };
  });
  const candidateListDigest = officialAssetCandidateListDigest(members);
  const memberSetDigest = officialAssetMemberSetDigest(members);
  return members.map((member, index) => {
    const address = member.contractAddress;
    const asset = { kind: "erc20" as const, chainId, address };
    const currentMultiplier = maximumEvmBalanceRaw;
    return {
      kind: "erc20" as const,
      selection: {
        account: { chainId, address: accountAddress },
        asset,
        included: true,
        revision: Buffer.alloc(16, index + 3).toString("base64url"),
        createdAt: at,
        updatedAt: at,
      },
      name: { status: "available" as const, value: maximumText },
      symbol: { status: "available" as const, value: maximumText },
      classification: {
        kind: "robinhood_stock_token" as const,
        snapshot: {
          sourceUri: officialAssetSourceDefinition.sourceUri,
          sourceObservedAt: at,
          rawResponseDigest: `0x${"11".repeat(32)}`,
          memberSetDigest,
          candidateListDigest,
          revision: snapshotRevision,
        },
        member,
        verification: {
          assetUid: member.assetUid,
          contractAddress: address,
          block,
          proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
          proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
          implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
          implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
          tokenCodeHash: `0x${"ee".repeat(32)}`,
        },
      },
      amount: createAccountAssetAmount({ raw: maximumEvmBalanceRaw, decimals: "0", multiplier: currentMultiplier }),
      requiredStandards: {
        asset,
        block,
        erc165: { standardId: "erc165" as const, status: "supported" as const },
        erc8056: { standardId: "erc8056" as const, status: "supported" as const },
        pendingMultiplier: { standardId: "erc8056_pending_multiplier" as const, status: "supported" as const },
        values: {
          currentMultiplier,
          pendingMultiplier: maximumEvmBalanceRaw,
          pendingEffectiveAt: maximumEvmBalanceRaw,
        },
      },
    };
  });
};

export const verifyMaximumAccountAssetEnvelope = (): number => {
  const assets = maximumAssets(accountAssetLimits.maximumPageSize);
  const result = accountAssetApplicationContracts.collection.parsePublicSuccess(
    { limit: 5, cursor: null },
    {
      account: { chainId, address: accountAddress },
      block,
      viewRevision: {
        officialSnapshotStatus: "current",
        officialSnapshotRevision: snapshotRevision,
        selectionSetRevision,
      },
      native: {
        kind: "native",
        asset: { kind: "native", chainId },
        rawBalance: maximumEvmBalanceRaw,
        classification: "native",
      },
      assets,
      nextCursor: null,
    },
  );
  return Buffer.byteLength(canonicalJsonStringify(captureCanonicalJson(result)), "utf8");
};

const maximumOverviewEnvelopeBytes = (): number => {
  const assets = maximumAssets(officialAssetSourceDefinition.memberLimit);
  const candidateListDigest = officialAssetCandidateListDigest(
    assets.map((entry) => ({
      assetUid: entry.classification.member.assetUid,
      contractAddress: entry.classification.member.contractAddress,
      sourceName: entry.classification.member.sourceName,
      sourceSymbol: entry.classification.member.sourceSymbol,
    })),
  );
  const result = accountAssetOverviewQueryContract.parsePublicSuccess({}, {
    account: { chainId, address: accountAddress },
    block,
    viewRevision: {
      officialSnapshotStatus: "current",
      officialSnapshotRevision: snapshotRevision,
      selectionSetRevision,
    },
    native: {
      kind: "native",
      asset: { kind: "native", chainId },
      rawBalance: maximumEvmBalanceRaw,
      classification: "native",
    },
    stockTokens: {
      status: "current",
      candidateListDigest,
      members: assets.map((asset) => ({ status: "selected", asset })),
    },
  });
  return Buffer.byteLength(canonicalJsonStringify(captureCanonicalJson(result)), "utf8");
};

describe("maximum account asset envelope", () => {
  it("keeps the actual maximum five-card public result within the HTTP boundary", () => {
    const bytes = verifyMaximumAccountAssetEnvelope();
    expect(bytes).toBeGreaterThan(10_000);
    expect(bytes).toBeLessThanOrEqual(internalResponseLimitBytes);
  });

  it("keeps the complete official partition within the public read boundary", () => {
    const overviewBytes = maximumOverviewEnvelopeBytes();
    expect(overviewBytes).toBeGreaterThan(internalResponseLimitBytes);
    expect(overviewBytes).toBeLessThanOrEqual(publicReadResponseLimitBytes);
  });
});
