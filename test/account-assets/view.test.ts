import { describe, expect, it } from "vitest";

import {
  accountAssetApplicationContracts,
  accountAssetClassificationSchema,
  accountAssetViewRevisionSchema,
  createAccountAssetAmount,
} from "../../src/account-assets/contracts.js";
import type { AccountAssetRowView } from "../../src/account-assets/view.js";
import {
  assetIdentityWarnings,
  classificationLabel,
  classificationUnavailableReasonLabel,
  officialSnapshotFresh,
  officialSnapshotStatusText,
  projectAccountAssetCollectionView,
} from "../../src/account-assets/view.js";
import {
  chainAnchorSchema,
  parseEvmAddressInput,
  parseEvmChainId,
  parseUtcTimestamp,
  requiredErc8056ObservationSchema,
} from "../../src/core/index.js";
import { stockFactoryAdmissionManifest } from "../../src/registry/browser.js";
import {
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
} from "../../src/token-catalog/index.js";

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
const snapshot = {
  sourceUri: "https://api.robinhood.com/rhj/assets",
  sourceObservedAt: at,
  rawResponseDigest: hash,
  memberSetDigest: hash,
  revision,
};

const stockToken = accountAssetClassificationSchema.parse({
  kind: "robinhood_stock_token",
  snapshot,
  member: { assetUid: hash, contractAddress: address, sourceName: "Apple Inc.", sourceSymbol: "AAPL" },
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
});
const customErc20 = accountAssetClassificationSchema.parse({ kind: "custom_erc20", snapshot });
const unavailable = accountAssetClassificationSchema.parse({
  kind: "classification_unavailable",
  storedRevision: null,
  snapshot: null,
  member: null,
  reason: "token_code_missing",
});

describe("account asset browser view", () => {
  it("labels each classification kind from one source", () => {
    expect(classificationLabel(stockToken)).toBe("Robinhood Stock Token");
    expect(classificationLabel(customErc20)).toBe("Custom ERC-20");
    expect(classificationLabel(unavailable)).toBe("Classification unavailable");
  });

  it("maps an unavailable classification reason to one human explanation", () => {
    expect(classificationUnavailableReasonLabel("token_code_missing"))
      .toContain("No contract code");
    expect(classificationUnavailableReasonLabel("source_unavailable"))
      .toContain("official asset source was unavailable");
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
      selectionSetRevision: null,
    });
    expect(officialSnapshotFresh(current)).toBe(true);
    expect(officialSnapshotStatusText(current)).toBe("Official data current");
    expect(officialSnapshotFresh(stale)).toBe(false);
    expect(officialSnapshotStatusText(stale)).toBe("Official data unavailable");
  });

  it("warns when an unsafe identity string is withheld", () => {
    const row = { nameIssue: "unsafe_text", symbolIssue: null } as AccountAssetRowView;
    const warnings = assetIdentityWarnings(row);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unsafe text");
    expect(assetIdentityWarnings({ nameIssue: null, symbolIssue: null } as AccountAssetRowView)).toHaveLength(0);
  });

  it("projects exact admitted decimals without reconstructing the amount", () => {
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
          name: { status: "available", value: "Example" },
          symbol: { status: "available", value: "EXT" },
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
    expect(view.assets[0]?.quantity).toMatchObject({
      raw: "1234500",
      decimals: "6",
      formattedRaw: "1.2345",
    });
  });
});
