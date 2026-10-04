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
} from "../../src/account-assets/view.js";
import {chainAnchorSchema} from "../../src/evm/primitives.js";
import {parseEvmAddressInput} from "../../src/evm/address-input.js";
import {parseEvmChainId} from "../../src/evm/identities.js";
import {parseUtcTimestamp} from "../../src/core/index.js";
import {requiredErc8056ObservationSchema} from "../../src/evm/token-standards.js";
import {
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
} from "../../src/token-catalog/index.js";
import { officialAssetSourceDefinition } from "../../src/registry/client.js";

const chainId = parseEvmChainId("eip155:4663");
const at = parseUtcTimestamp("2026-07-21T00:00:00.000Z");
const hash = `0x${"ab".repeat(32)}`;
const address = parseEvmAddressInput(`0x${"12".repeat(20)}`);
const accountAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
const account = Object.freeze({ chainId, address: accountAddress });
const target = Object.freeze({ kind: "address" as const, address: accountAddress });
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

describe("account asset human projection", () => {
  it("derives official-snapshot freshness from an account-bound view revision", () => {
    const current = accountAssetViewRevisionSchema.parse({
      account,
      officialSnapshotStatus: "current",
      officialSnapshotRevision: revision,
      selectionSetRevision: setRevision,
    });
    const stale = accountAssetViewRevisionSchema.parse({
      account,
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

  it("projects one admitted collection identity, classification, and amount", () => {
    const asset = { kind: "erc20" as const, chainId, address };
    const requiredStandards = requiredErc8056ObservationSchema.parse({
      asset,
      block,
      erc165: { standardId: "erc165", status: "not_supported" },
      erc8056: { standardId: "erc8056", status: "unknown" },
      pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: "unknown" },
    });
    const unavailable = accountAssetClassificationSchema.parse({
      kind: "classification_unavailable",
      cause: {
        kind: "official_snapshot_unavailable",
        storedRevision: null,
        reason: "source_unavailable",
      },
    });
    const result = accountAssetApplicationContracts.collection.parsePublicSuccess(
      { account: target, limit: 5, cursor: null },
      {
        account,
        block,
        viewRevision: {
          account,
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
            account,
            asset,
            included: true,
            revision: selectionRevision,
            createdAt: at,
            updatedAt: at,
          },
          name: { status: "unavailable", reason: "unsafe_text" },
          symbol: { status: "unavailable", reason: "call_failed" },
          classification: unavailable,
          amount: createAccountAssetAmount({ raw: "1234500", decimals: "6", multiplier: null }),
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
    const factoryUnavailable = accountAssetApplicationContracts.collection.parsePublicSuccess(
      { account: target, limit: 5, cursor: null },
      {
        ...result,
        viewRevision: {
          account,
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
    const factoryView = projectAccountAssetCollectionView(factoryUnavailable);
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
