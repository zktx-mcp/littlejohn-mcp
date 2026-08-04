import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  accountAssetOverviewQueryContract,
} from "../../../src/account-assets/browser.js";
import {
  evmChainIdSchema,
  parseEvmAddressInput,
  parseHash32,
  requiredErc8056ObservationSchema,
  utcTimestampSchema,
} from "../../../src/core/browser.js";
import { AccountAssetsPage } from "../../../src/interfaces/web/account-assets-page.js";
import {
  officialAssetSourceDefinition,
  stockFactoryAdmissionManifest,
} from "../../../src/registry/browser.js";
import {
  officialAssetCandidateListDigest,
} from "../../../src/registry/official-asset-contract.js";
import {
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
} from "../../../src/token-catalog/browser.js";

const chainId = evmChainIdSchema.parse("eip155:4663");
const accountAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
const tokenAddress = parseEvmAddressInput(`0x${"12".repeat(20)}`);
const observedAt = utcTimestampSchema.parse("2026-07-21T00:00:00.000Z");
const selectionRevision = tokenSelectionRevisionSchema.parse(
  Buffer.alloc(16, 1).toString("base64url"),
);
const selectionSetRevision = tokenSelectionSetRevisionSchema.parse(
  Buffer.alloc(16, 2).toString("base64url"),
);
const officialRevision = Buffer.alloc(16, 3).toString("base64url");
const digest = `0x${"ab".repeat(32)}`;
const assetUid = parseHash32(`0x${"cd".repeat(32)}`);
const block = Object.freeze({
  chainId,
  blockNumber: "42",
  blockHash: digest,
  blockTimestamp: observedAt,
});
const asset = Object.freeze({
  kind: "erc20" as const,
  chainId,
  address: tokenAddress,
});
const selection = Object.freeze({
  account: { chainId, address: accountAddress },
  asset,
  included: true,
  revision: selectionRevision,
  createdAt: observedAt,
  updatedAt: observedAt,
});
const viewRevision = Object.freeze({
  officialSnapshotStatus: "current" as const,
  officialSnapshotRevision: officialRevision,
  selectionSetRevision,
});
const requiredStandards = requiredErc8056ObservationSchema.parse({
  asset,
  block,
  erc165: { standardId: "erc165", status: "not_supported" },
  erc8056: { standardId: "erc8056", status: "unknown" },
  pendingMultiplier: {
    standardId: "erc8056_pending_multiplier",
    status: "unknown",
  },
});
const classification = Object.freeze({
  kind: "robinhood_stock_token" as const,
  snapshot: {
    sourceUri: officialAssetSourceDefinition.sourceUri,
    sourceObservedAt: observedAt,
    rawResponseDigest: digest,
    memberSetDigest: digest,
    revision: officialRevision,
  },
  member: {
    assetUid,
    contractAddress: tokenAddress,
    sourceName: "Example",
    sourceSymbol: "EXT",
  },
  verification: {
    assetUid,
    contractAddress: tokenAddress,
    block,
    proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
    proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
    implementationAddress: stockFactoryAdmissionManifest.implementationAddress,
    implementationCodeHash: stockFactoryAdmissionManifest.implementationCodeHash,
    tokenCodeHash: digest,
  },
});
const candidateListDigest = officialAssetCandidateListDigest([{
  assetUid,
  contractAddress: tokenAddress,
  sourceName: "Example",
  sourceSymbol: "EXT",
}]);

const collectionResult = (
  raw: "0" | "5",
  options: Readonly<{ nativeRaw?: string; tokenDecimals?: string | null }> = {},
) => accountAssetOverviewQueryContract.parsePublicSuccess(
  {},
  {
    account: selection.account,
    block,
    viewRevision,
    native: {
      kind: "native",
      asset: { kind: "native", chainId },
      rawBalance: options.nativeRaw ?? "0",
      classification: "native",
    },
    stockTokens: {
      status: "current",
      candidateListDigest,
      members: [{
        status: "selected",
        asset: {
          kind: "erc20",
          selection,
          name: { status: "available", value: "Example" },
          symbol: { status: "available", value: "EXT" },
          classification,
          amount: {
            raw,
            decimals: options.tokenDecimals === undefined
              ? "0"
              : options.tokenDecimals,
            formattedRaw: options.tokenDecimals === null ? null : raw,
            uiAdjusted: null,
            formattedUiAdjusted: null,
          },
          requiredStandards,
        },
      }],
    },
  },
);

const callbacks = Object.freeze({
  onRefresh: vi.fn(),
  onAddStockToken: vi.fn(),
  onInfo: vi.fn(),
});

const renderCollection = (
  raw: "0" | "5",
  options: Readonly<{
    loading?: boolean;
    nativeRaw?: string;
  }> = {},
): string => renderToStaticMarkup(
  createElement(AccountAssetsPage, {
    snapshot: {
      result: collectionResult(raw, options),
    },
    loading: options.loading ?? false,
    staleMessage: undefined,
    mutationDisabled: false,
    ...callbacks,
  }),
);

describe("account asset human presentation", () => {
  it("keeps token dialogs outside the page presentation owner", () => {
    const markup = renderToStaticMarkup(createElement(AccountAssetsPage, {
      snapshot: undefined,
      loading: false,
      staleMessage: undefined,
      mutationDisabled: false,
      ...callbacks,
    }));

    expect(markup).toContain("Assets unavailable");
    expect(markup).not.toContain("<dialog");
    expect(markup).not.toContain("Token details");
    expect(markup).not.toContain("Remove token");
  });

  it("presents Native and Stock Tokens with one row hierarchy and no machine evidence", () => {
    const markup = renderCollection("5");

    expect(markup.match(/class="asset-row"/gu)).toHaveLength(2);
    expect(markup).toContain(">Native<");
    expect(markup).toContain(">Stock Tokens<");
    expect(markup).toContain(">Example<");
    expect(markup).toContain(">Account<");
    expect(markup).toContain(">Robinhood Chain<");
    expect(markup).toContain(accountAddress);
    expect(markup).toContain(">5 EXT<");
    expect(markup).toContain('aria-label="Add Stock Token"');
    expect(markup.match(/>Example</gu)).toHaveLength(1);
    expect(markup).toContain('aria-label="Open Example information"');
    expect(markup).not.toContain('aria-label="Analyze Example"');
    expect(markup).not.toContain('aria-label="Remove Example"');
    expect(markup).not.toContain(tokenAddress);
    expect(markup).not.toContain(chainId);
    expect(markup).not.toContain("As of block");
    expect(markup).not.toContain(block.blockHash);
    expect(markup).not.toContain("Raw");
  });

  it("keeps a selected zero-balance Stock Token visible without a warning panel", () => {
    const markup = renderCollection("0");

    expect(markup).toContain(">0<");
    expect(markup).not.toContain("0 ETH");
    expect(markup).toContain(">0 EXT<");
    expect(markup).not.toContain("No included token");
    expect(markup).not.toContain("Tracked tokens with zero balance");
    expect(markup).not.toContain("Manage tracked tokens");
    expect(markup).not.toContain("Previous asset page");
    expect(markup).not.toContain("Next asset page");
  });

  it("does not invent a native human amount when nonzero decimals are unavailable", () => {
    const markup = renderCollection("5", { nativeRaw: "7" });

    expect(markup).toContain("Human amount unavailable");
    expect(markup).toContain(
      "Native decimals are not provided by this overview.",
    );
    expect(markup).not.toContain("7 ETH");
    expect(markup).not.toContain("7 raw");
  });

  it("uses scale-independent zero and distinguishes unavailable token decimals", () => {
    const zero = renderToStaticMarkup(createElement(AccountAssetsPage, {
      snapshot: { result: collectionResult("0", { tokenDecimals: null }) },
      loading: false,
      staleMessage: undefined,
      mutationDisabled: false,
      ...callbacks,
    }));
    const nonzero = renderToStaticMarkup(createElement(AccountAssetsPage, {
      snapshot: { result: collectionResult("5", { tokenDecimals: null }) },
      loading: false,
      staleMessage: undefined,
      mutationDisabled: false,
      ...callbacks,
    }));

    expect(zero).toContain(">0 EXT<");
    expect(zero).not.toContain("Human amount unavailable");
    expect(nonzero).toContain("Human amount unavailable");
    expect(nonzero).toContain("Token decimals are unavailable for this balance.");
    expect(nonzero).not.toContain(">5<");
  });

  it("locks every visible asset action while a collection read is active", () => {
    const markup = renderCollection("5", { loading: true });

    for (const label of [
      "Add Stock Token",
      "Open Example information",
    ]) {
      expect(markup).toMatch(
        new RegExp(`<button[^>]*aria-label="${label}"[^>]*disabled=""`, "u"),
      );
    }
    expect(markup).toMatch(
      /<button[^>]*class="[^"]*asset-refresh-button-active[^"]*"[^>]*aria-label="Refreshing assets"[^>]*disabled=""/u,
    );
    expect(markup).toContain('class="visually-hidden" role="status">Refreshing assets');
    expect(markup).not.toContain("Updating assets");
  });

  it("keeps refresh available after a failed read while blocking stale asset actions", () => {
    const initialFailure = renderToStaticMarkup(createElement(AccountAssetsPage, {
      snapshot: undefined,
      loading: false,
      staleMessage: "Assets could not be loaded. Try again.",
      mutationDisabled: false,
      ...callbacks,
    }));
    const retainedFailure = renderToStaticMarkup(createElement(AccountAssetsPage, {
      snapshot: { result: collectionResult("5") },
      loading: false,
      staleMessage: "Assets could not be loaded. Try again.",
      mutationDisabled: false,
      ...callbacks,
    }));

    for (const markup of [initialFailure, retainedFailure]) {
      expect(markup).toMatch(/<button[^>]*aria-label="Refresh assets"/u);
      expect(markup).not.toMatch(
        /<button[^>]*aria-label="Refresh assets"[^>]*disabled=""/u,
      );
    }
    for (const label of ["Add Stock Token", "Open Example information"]) {
      expect(retainedFailure).toMatch(
        new RegExp(`<button[^>]*aria-label="${label}"[^>]*disabled=""`, "u"),
      );
    }
  });
});
