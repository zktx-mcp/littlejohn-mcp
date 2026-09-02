import { describe, expect, it } from "vitest";

import {
  accountAssetApplicationContracts,
  accountAssetClassificationSchema,
  accountAssetViewRevisionSchema,
  createAccountAssetAmount,
} from "../../src/account-assets/contracts.js";
import {
  officialSnapshotFresh,
  officialSnapshotStatusText,
  projectAccountAssetCollectionView,
  projectAccountAssetExactView,
} from "../../src/account-assets/view.js";
import {
  chainAnchorSchema,
  parseEvmAddressInput,
  parseEvmChainId,
  parseUtcTimestamp,
  requiredErc8056ObservationSchema,
  scaledUiAmountScale,
  tokenStandardObservationResultSchema,
} from "../../src/core/index.js";
import {
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
} from "../../src/token-catalog/index.js";
import {
  officialAssetSourceDefinition,
  stockFactoryAdmissionManifest,
} from "../../src/registry/client.js";

const chainId = parseEvmChainId("eip155:4663");
const at = parseUtcTimestamp("2026-07-21T00:00:00.000Z");
const hash = `0x${"ab".repeat(32)}`;
const address = parseEvmAddressInput(`0x${"12".repeat(20)}`);
const accountAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
const revision = Buffer.alloc(16, 1).toString("base64url");
const setRevision = tokenSelectionSetRevisionSchema.parse(Buffer.alloc(16, 2).toString("base64url"));
const selectionRevision = tokenSelectionRevisionSchema.parse(
  Buffer.alloc(16, 3).toString("base64url"),
);
const block = chainAnchorSchema.parse({
  chainId,
  blockNumber: "42",
  blockHash: hash,
  blockTimestamp: at,
});
const unavailable = accountAssetClassificationSchema.parse({
  kind: "classification_unavailable",
  cause: {
    kind: "official_snapshot_unavailable",
    storedRevision: null,
    reason: "source_unavailable",
  },
});

const exactAsset = { kind: "erc20" as const, chainId, address };
const exactViewRevision = accountAssetViewRevisionSchema.parse({
  officialSnapshotStatus: "current",
  officialSnapshotRevision: revision,
  selectionSetRevision: setRevision,
});
const exactRequiredStandards = requiredErc8056ObservationSchema.parse({
  asset: exactAsset,
  block,
  erc165: { standardId: "erc165", status: "supported" },
  erc8056: { standardId: "erc8056", status: "supported" },
  pendingMultiplier: {
    standardId: "erc8056_pending_multiplier",
    status: "supported",
  },
  values: {
    currentMultiplier: scaledUiAmountScale,
    pendingMultiplier: scaledUiAmountScale,
    pendingEffectiveAt: "0",
  },
});

const exactResultWithBalanceRelation = (
  balanceStatus: "supported" | "inconsistent" | "unknown" | "not_supported",
) => accountAssetApplicationContracts.exact.parsePublicSuccess(
  { asset: exactAsset, viewRevision: exactViewRevision },
  {
    account: { chainId, address: accountAddress },
    block,
    viewRevision: exactViewRevision,
    asset: {
      kind: "erc20",
      selection: {
        account: { chainId, address: accountAddress },
        asset: exactAsset,
        included: true,
        revision: selectionRevision,
        createdAt: at,
        updatedAt: at,
      },
      name: { status: "available", value: "Example Stock Token" },
      symbol: { status: "available", value: "EXT" },
      classification: {
        kind: "robinhood_stock_token",
        snapshot: {
          sourceUri: officialAssetSourceDefinition.sourceUri,
          sourceObservedAt: at,
          rawResponseDigest: hash,
          memberSetDigest: hash,
          candidateListDigest: hash,
          revision,
        },
        member: {
          assetUid: hash,
          contractAddress: address,
          sourceName: null,
          sourceSymbol: null,
        },
        verification: {
          assetUid: hash,
          contractAddress: address,
          block,
          proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
          proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
          implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
          implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
          tokenCodeHash: hash,
        },
      },
      amount: createAccountAssetAmount({
        raw: "5",
        decimals: "0",
        multiplier: scaledUiAmountScale,
      }),
      requiredStandards: exactRequiredStandards,
    },
    totalSupply: "10",
    standards: tokenStandardObservationResultSchema.parse({
      asset: exactAsset,
      account: { chainId, address: accountAddress },
      block,
      standards: [
        { standardId: "erc20_read_surface", status: "observed" },
        { standardId: "erc165", status: "supported" },
        { standardId: "erc8056", status: "supported" },
        { standardId: "erc8056_pending_multiplier", status: "supported" },
        { standardId: "erc8056_conversion", status: "not_supported" },
        { standardId: "erc8056_balances", status: balanceStatus },
      ],
      requiredErc8056: exactRequiredStandards.values,
      ...(balanceStatus === "supported"
        ? { balanceOfUi: "5" }
        : balanceStatus === "inconsistent"
          ? { balanceOfUi: "6" }
          : {}),
      calculatedBalance: {
        status: "available",
        raw: "5",
        multiplier: scaledUiAmountScale,
        scale: scaledUiAmountScale,
        adjustedRaw: "5",
      },
    }),
  },
);

describe("account asset human projection", () => {
  it("projects only an admitted inconsistent ERC-8056 balance relation as an exact limitation", () => {
    const expectedLimitation = [{
      code: "erc8056_balance_evidence_inconsistent",
      message: "ERC-8056 balance evidence is inconsistent with the adjusted balance.",
    }];

    for (const [balanceStatus, expected] of [
      ["inconsistent", expectedLimitation],
      ["supported", []],
      ["unknown", []],
      ["not_supported", []],
    ] as const) {
      expect(
        projectAccountAssetExactView(
          exactResultWithBalanceRelation(balanceStatus),
        ).limitations,
      ).toEqual(expected);
    }
  });

  it("derives official-snapshot freshness from the view revision", () => {
    const current = accountAssetViewRevisionSchema.parse({
      officialSnapshotStatus: "current",
      officialSnapshotRevision: revision,
      selectionSetRevision: setRevision,
    });
    const stale = accountAssetViewRevisionSchema.parse({
      officialSnapshotStatus: "unavailable",
      officialSnapshotRevision: null,
      officialSnapshotUnavailableReason: "source_unavailable",
      selectionSetRevision: null,
    });
    expect(officialSnapshotFresh(current)).toBe(true);
    expect(officialSnapshotStatusText(current)).toBe("Official data current");
    expect(officialSnapshotFresh(stale)).toBe(false);
    expect(officialSnapshotStatusText(stale)).toBe("Official data unavailable");
  });

  it("projects one admitted human identity, classification, and amount", () => {
    const asset = { kind: "erc20" as const, chainId, address };
    const requiredStandards = requiredErc8056ObservationSchema.parse({
      asset,
      block,
      erc165: { standardId: "erc165", status: "not_supported" },
      erc8056: { standardId: "erc8056", status: "unknown" },
      pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: "unknown" },
    });
    const result = accountAssetApplicationContracts.collection.parsePublicSuccess(
      { limit: 5, cursor: null },
      {
        account: { chainId, address: accountAddress },
        block,
        viewRevision: {
          officialSnapshotStatus: "unavailable",
          officialSnapshotRevision: null,
          officialSnapshotUnavailableReason: "source_unavailable",
          selectionSetRevision: setRevision,
        },
        native: {
          kind: "native",
          asset: { kind: "native", chainId },
          rawBalance: "7",
          classification: "native",
        },
        assets: [{
          kind: "erc20",
          selection: {
            account: { chainId, address: accountAddress },
            asset,
            included: true,
            revision: selectionRevision,
            createdAt: at,
            updatedAt: at,
          },
          name: { status: "unavailable", reason: "unsafe_text" },
          symbol: { status: "unavailable", reason: "call_failed" },
          classification: unavailable,
          amount: createAccountAssetAmount({
            raw: "1234500",
            decimals: "6",
            multiplier: null,
          }),
          requiredStandards,
        }],
        nextCursor: null,
      },
    );

    const view = projectAccountAssetCollectionView(result);
    expect(view.native.decimals).toBeNull();
    expect(view.assets[0]?.identity).toEqual({
      address,
      label: address,
      name: null,
      symbol: null,
      warnings: [
        "Token name contained unsafe text and was withheld.",
        "Token symbol read call failed.",
      ],
    });
    expect(view.assets[0]?.classification).toEqual({
      kind: "official_snapshot_unavailable",
      label: "Classification unavailable",
      limitation: "The current official Stock Token list was unavailable.",
    });
    const currentRevision = Buffer.alloc(16, 4).toString("base64url");
    const factoryUnavailableResult = accountAssetApplicationContracts.collection.parsePublicSuccess(
      { limit: 5, cursor: null },
      {
        ...result,
        viewRevision: {
          officialSnapshotStatus: "current",
          officialSnapshotRevision: currentRevision,
          selectionSetRevision: result.viewRevision.selectionSetRevision,
        },
        assets: [{
          ...result.assets[0]!,
          classification: {
            kind: "classification_unavailable",
            cause: {
              kind: "stock_factory_verification_unavailable",
              snapshot: {
                sourceUri: officialAssetSourceDefinition.sourceUri,
                sourceObservedAt: at,
                rawResponseDigest: hash,
                memberSetDigest: hash,
                candidateListDigest: hash,
                revision: currentRevision,
              },
              member: {
                assetUid: hash,
                contractAddress: address,
                sourceName: null,
                sourceSymbol: null,
              },
              reason: "source_unavailable",
            },
          },
        }],
      },
    );
    const factoryView = projectAccountAssetCollectionView(factoryUnavailableResult);
    expect(factoryView.assets[0]?.classification).toEqual({
      kind: "stock_factory_verification_unavailable",
      label: "Classification unavailable",
      limitation: "Chain evidence required for StockFactory verification was unavailable.",
    });
    expect(factoryView.assets[0]?.classification.limitation)
      .not.toBe(view.assets[0]?.classification.limitation);
    expect(view.assets[0]?.quantity).toMatchObject({
      raw: "1234500",
      decimals: "6",
      formattedRaw: "1.2345",
    });
  });
});
