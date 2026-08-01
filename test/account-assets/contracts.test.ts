import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  accountAssetApplicationContracts,
  accountAssetClassificationSchema,
  filterAccountAssetOfficialCandidates,
  accountAssetOverviewQueryContract,
  contractAccountAssetSchema,
  createAccountAssetAmount,
} from "../../src/account-assets/contracts.js";
import {
  officialAssetCandidateSchema,
  officialAssetSourceDefinition,
  stockFactoryAdmissionManifest,
} from "../../src/registry/browser.js";
import {
  officialAssetCandidateListDigest,
} from "../../src/registry/official-asset-contract.js";
import {
  calculateScaledUiAmount,
  canonicalJsonStringify,
  parseEvmAddressInput,
  parseEvmChainId,
  parseHash32,
  parseUtcTimestamp,
  requiredErc8056ObservationSchema,
  tokenStandardObservationResultSchema,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
} from "../../src/token-catalog/index.js";
import { tokenCatalogErrorRegistry } from "../../src/token-catalog/error-registry.js";

const chainId = parseEvmChainId("eip155:4663");
const accountAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
const tokenAddress = parseEvmAddressInput(`0x${"12".repeat(20)}`);
const at = parseUtcTimestamp("2026-07-21T00:00:00.000Z");
const revision = tokenSelectionRevisionSchema.parse(Buffer.alloc(16, 1).toString("base64url"));
const setRevision = tokenSelectionSetRevisionSchema.parse(Buffer.alloc(16, 2).toString("base64url"));
const block = Object.freeze({
  chainId,
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: at,
});
const asset = Object.freeze({ kind: "erc20" as const, chainId, address: tokenAddress });
const requiredStandards = requiredErc8056ObservationSchema.parse({
  asset,
  block,
  erc165: { standardId: "erc165", status: "not_supported" },
  erc8056: { standardId: "erc8056", status: "unknown" },
  pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: "unknown" },
});
const viewRevision = Object.freeze({
  officialSnapshotStatus: "unavailable" as const,
  officialSnapshotRevision: null,
  selectionSetRevision: setRevision,
});
const selection = Object.freeze({
  account: { chainId, address: accountAddress },
  asset,
  included: true,
  revision,
  createdAt: at,
  updatedAt: at,
});
const contractAsset = Object.freeze({
  kind: "erc20" as const,
  selection,
  name: { status: "available" as const, value: "Example" },
  symbol: { status: "available" as const, value: "EXT" },
  classification: {
    kind: "classification_unavailable" as const,
    storedRevision: null,
    snapshot: null,
    member: null,
    reason: "source_unavailable" as const,
  },
  amount: createAccountAssetAmount({ raw: "1234500", decimals: "6", multiplier: null }),
  requiredStandards,
});

const currentSnapshotRevision = Buffer.alloc(16, 3).toString("base64url");
const selectedCandidate = Object.freeze({
  assetUid: parseHash32(`0x${"03".repeat(32)}`),
  contractAddress: tokenAddress,
  sourceName: "Example",
  sourceSymbol: "EXT",
});
const availableCandidate = Object.freeze({
  assetUid: parseHash32(`0x${"04".repeat(32)}`),
  contractAddress: parseEvmAddressInput(`0x${"13".repeat(20)}`),
  sourceName: "Available",
  sourceSymbol: "AVL",
});
const currentViewRevision = Object.freeze({
  officialSnapshotStatus: "current" as const,
  officialSnapshotRevision: currentSnapshotRevision,
  selectionSetRevision: setRevision,
});
const currentContractAsset = Object.freeze({
  ...contractAsset,
  classification: {
    kind: "robinhood_stock_token" as const,
    snapshot: {
      sourceUri: officialAssetSourceDefinition.sourceUri,
      sourceObservedAt: at,
      rawResponseDigest: `0x${"01".repeat(32)}`,
      memberSetDigest: `0x${"02".repeat(32)}`,
      revision: currentSnapshotRevision,
    },
    member: selectedCandidate,
    verification: {
      assetUid: selectedCandidate.assetUid,
      contractAddress: selectedCandidate.contractAddress,
      block,
      proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
      proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
      implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
      implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
      tokenCodeHash: `0x${"04".repeat(32)}`,
    },
  },
});
const partitionDigest = officialAssetCandidateListDigest([
  {
    assetUid: selectedCandidate.assetUid,
    contractAddress: selectedCandidate.contractAddress,
    sourceName: selectedCandidate.sourceName,
    sourceSymbol: selectedCandidate.sourceSymbol,
  },
  {
    assetUid: availableCandidate.assetUid,
    contractAddress: availableCandidate.contractAddress,
    sourceName: availableCandidate.sourceName,
    sourceSymbol: availableCandidate.sourceSymbol,
  },
]);
const currentOverview = Object.freeze({
  account: selection.account,
  block,
  viewRevision: currentViewRevision,
  native: {
    kind: "native" as const,
    asset: { kind: "native" as const, chainId },
    rawBalance: "7",
    classification: "native" as const,
  },
  stockTokens: {
    status: "current" as const,
    candidateListDigest: partitionDigest,
    members: [
      { status: "selected" as const, asset: currentContractAsset },
      { status: "available_to_add" as const, candidate: availableCandidate },
    ],
  },
});

const canonicalOutputSchema = (schema: z.ZodType): string =>
  canonicalJsonStringify(JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io: "output",
  }))) as CanonicalJson);

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

describe("account asset contracts", () => {
  it("uses the token-catalog error registry without an account-assets alias", () => {
    expect(accountAssetOverviewQueryContract.contractVersion).toBe("1");
    for (const contract of Object.values(accountAssetApplicationContracts)) {
      expect(contract.applicationContract.errorRegistry).toBe(tokenCatalogErrorRegistry);
      expect(contract.contractVersion).toBe(contract.applicationContract.contractVersion);
      expect(contract.contractVersion).toBe("1");
    }
  });

  it("preserves every independent official and account schema projection", () => {
    for (const [schema, expectedBytes, expectedDigest] of [
      [
        officialAssetCandidateSchema,
        431,
        "a2a3edd7a20f92e8f7584e67a3a348b310fe70386dcebf98e910ad70b5e87ffa",
      ],
      [
        accountAssetClassificationSchema,
        5_238,
        "587af3298cacd8d65c438718e62d58848acabf25c9e00c7bbcc18780da301558",
      ],
      [
        contractAccountAssetSchema,
        11_509,
        "330297af987c0e932cb9efe1f069e7188d005494e3750b134444baff7e0f264a",
      ],
      [
        accountAssetApplicationContracts.collection.successSchema,
        14_772,
        "4c7bc1ed8bad5205fa61c8562be9cb8fe6feffb9633368318bc7bf62c157b05b",
      ],
      [
        accountAssetApplicationContracts.exact.successSchema,
        16_033,
        "02641a7b914a895e9db0ce6c1c0577f5c1f8ea4581e969edd86a9da1db6c334f",
      ],
      [
        accountAssetOverviewQueryContract.successSchema,
        14_718,
        "73cceff450ebe10c46a49491b6ab83178b6d2cca9e757f07b02d59f6e462a90d",
      ],
    ] as const) {
      const canonical = canonicalOutputSchema(schema);
      expect(Buffer.byteLength(canonical, "utf8")).toBe(expectedBytes);
      expect(sha256(canonical)).toBe(expectedDigest);
    }
  });

  it("binds a collection to one account, block, selection view, and amount model", () => {
    const result = accountAssetApplicationContracts.collection.parsePublicSuccess(
      { limit: 5, cursor: null },
      {
        account: selection.account,
        block,
        viewRevision,
        native: {
          kind: "native",
          asset: { kind: "native", chainId },
          rawBalance: "7",
          classification: "native",
        },
        assets: [contractAsset],
        nextCursor: null,
      },
    );
    expect(result.assets[0]?.amount).toEqual({
      raw: "1234500",
      decimals: "6",
      formattedRaw: "1.2345",
      uiAdjusted: null,
      formattedUiAdjusted: null,
    });
    expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
      { limit: 5, cursor: null },
      { ...result, block: { ...block, blockHash: `0x${"cd".repeat(32)}` } },
    )).toThrow();
    expect(() => accountAssetApplicationContracts.collection.parsePublicSuccess(
      { limit: 5, cursor: null },
      { ...result, assets: [{ ...contractAsset, selection: { ...selection, included: false } }] },
    )).toThrow();
  });

  it("rejects foreign official evidence and forged fixed factory identity at the public schema", () => {
    const currentRevision = Buffer.alloc(16, 3).toString("base64url");
    const official = {
      kind: "robinhood_stock_token",
      snapshot: {
        sourceUri: officialAssetSourceDefinition.sourceUri,
        sourceObservedAt: at,
        rawResponseDigest: `0x${"01".repeat(32)}`,
        memberSetDigest: `0x${"02".repeat(32)}`,
        revision: currentRevision,
      },
      member: {
        assetUid: `0x${"03".repeat(32)}`,
        contractAddress: tokenAddress,
        sourceName: "Example",
        sourceSymbol: "EXT",
      },
      verification: {
        assetUid: `0x${"03".repeat(32)}`,
        contractAddress: tokenAddress,
        block,
        proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
        proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
        implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
        implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
        tokenCodeHash: `0x${"04".repeat(32)}`,
      },
    } as const;
    expect(accountAssetClassificationSchema.parse(official)).toEqual(official);
    expect(() => accountAssetClassificationSchema.parse({
      ...official,
      snapshot: { ...official.snapshot, sourceUri: "https://example.invalid/assets" },
    })).toThrow();
    expect(() => accountAssetClassificationSchema.parse({
      ...official,
      verification: {
        ...official.verification,
        proxyAddress: parseEvmAddressInput(`0x${"05".repeat(20)}`),
      },
    })).toThrow();
  });

  it("binds exact standard and adjusted-balance evidence to the same block and account", () => {
    const values = {
      currentMultiplier: "2000000000000000000",
      pendingMultiplier: "3000000000000000000",
      pendingEffectiveAt: "1800000000",
    };
    const supportedRequired = requiredErc8056ObservationSchema.parse({
      asset,
      block,
      erc165: { standardId: "erc165", status: "supported" },
      erc8056: { standardId: "erc8056", status: "supported" },
      pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: "supported" },
      values,
    });
    const standards = tokenStandardObservationResultSchema.parse({
      asset,
      account: selection.account,
      block,
      standards: [
        { standardId: "erc20_read_surface", status: "observed" },
        { standardId: "erc165", status: "supported" },
        { standardId: "erc8056", status: "supported" },
        { standardId: "erc8056_pending_multiplier", status: "supported" },
        { standardId: "erc8056_conversion", status: "not_supported" },
        { standardId: "erc8056_balances", status: "not_supported" },
      ],
      requiredErc8056: values,
      calculatedBalance: calculateScaledUiAmount("5", values.currentMultiplier),
    });
    const exactAsset = {
      ...contractAsset,
      amount: createAccountAssetAmount({ raw: "5", decimals: "0", multiplier: values.currentMultiplier }),
      requiredStandards: supportedRequired,
    };
    const result = accountAssetApplicationContracts.exact.parsePublicSuccess(
      { asset, viewRevision },
      {
        account: selection.account,
        block,
        viewRevision,
        asset: exactAsset,
        totalSupply: "100",
        standards,
      },
    );
    expect(result.asset.amount.formattedUiAdjusted).toBe("10");
    expect(() => accountAssetApplicationContracts.exact.parsePublicSuccess(
      { asset, viewRevision },
      { ...result, asset: { ...exactAsset, amount: createAccountAssetAmount({ raw: "6", decimals: "0", multiplier: values.currentMultiplier }) } },
    )).toThrow();
  });

  it("bounds, normalizes, and locally filters the admitted complete candidate set", () => {
    const candidates = [{
      assetUid: parseHash32(`0x${"11".repeat(32)}`),
      contractAddress: tokenAddress,
      sourceName: "Tesla Stock",
      sourceSymbol: "TSLA",
    }, {
      assetUid: parseHash32(`0x${"12".repeat(32)}`),
      contractAddress: parseEvmAddressInput(`0x${"13".repeat(20)}`),
      sourceName: "Apple Stock",
      sourceSymbol: "AAPL",
    }];
    expect(filterAccountAssetOfficialCandidates(
      candidates,
      "  Ｔｅｓｌａ\u00a0 ",
    )).toEqual([candidates[0]]);
    expect(filterAccountAssetOfficialCandidates(candidates, "0x12")).toEqual([]);
    expect(filterAccountAssetOfficialCandidates(candidates, " ")).toEqual(candidates);
    const atInputLimit = "🧪".repeat(128);
    expect(filterAccountAssetOfficialCandidates(candidates, atInputLimit)).toEqual([]);
    for (const search of [
      `${atInputLimit}a`,
      "a".repeat(129),
      "\uFB03".repeat(43),
      "line\nbreak",
    ]) {
      expect(() => filterAccountAssetOfficialCandidates(candidates, search)).toThrow();
    }
  });

  it("admits one exhaustive digest-bound official partition", () => {
    const result = accountAssetOverviewQueryContract.parsePublicSuccess(
      {},
      currentOverview,
    );
    expect(result.stockTokens).toEqual(currentOverview.stockTokens);
    if (result.stockTokens.status !== "current") {
      throw new TypeError("Expected current Stock Tokens.");
    }
    expect(() => accountAssetOverviewQueryContract.parsePublicSuccess({}, {
      ...currentOverview,
      stockTokens: {
        ...currentOverview.stockTokens,
        members: currentOverview.stockTokens.members.slice(0, 1),
      },
    })).toThrow();
    expect(() => accountAssetOverviewQueryContract.parsePublicSuccess({}, {
      ...currentOverview,
      stockTokens: {
        ...currentOverview.stockTokens,
        members: [...currentOverview.stockTokens.members].reverse(),
      },
    })).toThrow();
    expect(() => accountAssetOverviewQueryContract.parsePublicSuccess({}, {
      ...currentOverview,
      stockTokens: {
        ...currentOverview.stockTokens,
        members: [
          currentOverview.stockTokens.members[0],
          {
            status: "available_to_add",
            candidate: { ...availableCandidate, sourceName: "Changed" },
          },
        ],
      },
    })).toThrow();
  });
});
