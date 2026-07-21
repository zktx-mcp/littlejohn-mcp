import { describe, expect, it } from "vitest";

import {
  accountAssetApplicationContracts,
  accountAssetOfficialCandidateQueryContract,
  createAccountAssetAmount,
} from "../../src/account-assets/contracts.js";
import {
  calculateScaledUiAmount,
  parseEvmAddressInput,
  parseEvmChainId,
  parseUtcTimestamp,
  requiredErc8056ObservationSchema,
  tokenStandardObservationResultSchema,
} from "../../src/core/index.js";
import {
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
} from "../../src/token-catalog/index.js";

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

describe("account asset contracts", () => {
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

  it("rejects candidate cursors that do not belong to the exact view", () => {
    expect(() => accountAssetOfficialCandidateQueryContract.parseInput({
      viewRevision,
    })).toThrow();
    const currentRevision = Buffer.alloc(16, 3).toString("base64url");
    const currentView = {
      officialSnapshotStatus: "current",
      officialSnapshotRevision: currentRevision,
      selectionSetRevision: setRevision,
    } as const;
    expect(accountAssetOfficialCandidateQueryContract.parseInput({ viewRevision: currentView })).toEqual({
      viewRevision: currentView,
      cursor: null,
    });
    expect(() => accountAssetOfficialCandidateQueryContract.parseInput({
      viewRevision: currentView,
      cursor: {
        assetUid: `0x${"11".repeat(32)}`,
        contractAddress: tokenAddress,
        officialSnapshotRevision: Buffer.alloc(16, 4).toString("base64url"),
        selectionSetRevision: setRevision,
      },
    })).toThrow();
  });
});
