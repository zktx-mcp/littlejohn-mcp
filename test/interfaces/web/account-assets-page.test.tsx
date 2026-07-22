import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  accountAssetApplicationContracts,
} from "../../../src/account-assets/browser.js";
import {
  evmChainIdSchema,
  parseEvmAddressInput,
  requiredErc8056ObservationSchema,
  tokenStandardObservationResultSchema,
  utcTimestampSchema,
} from "../../../src/core/browser.js";
import {
  AccountAssetsPage,
  type AccountAssetExactReadPresentation,
} from "../../../src/interfaces/web/account-assets-page.js";
import {
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
} from "../../../src/token-catalog/browser.js";

const chainId = evmChainIdSchema.parse("eip155:4663");
const accountAddress = parseEvmAddressInput(`0x${"34".repeat(20)}`);
const tokenAddress = parseEvmAddressInput(`0x${"12".repeat(20)}`);
const observedAt = utcTimestampSchema.parse("2026-07-21T00:00:00.000Z");
const selectionRevision = tokenSelectionRevisionSchema.parse(Buffer.alloc(16, 1).toString("base64url"));
const selectionSetRevision = tokenSelectionSetRevisionSchema.parse(Buffer.alloc(16, 2).toString("base64url"));
const block = Object.freeze({
  chainId,
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: observedAt,
});
const asset = Object.freeze({ kind: "erc20" as const, chainId, address: tokenAddress });
const selection = Object.freeze({
  account: { chainId, address: accountAddress },
  asset,
  included: true,
  revision: selectionRevision,
  createdAt: observedAt,
  updatedAt: observedAt,
});
const viewRevision = Object.freeze({
  officialSnapshotStatus: "unavailable" as const,
  officialSnapshotRevision: null,
  selectionSetRevision,
});
const requiredStandards = requiredErc8056ObservationSchema.parse({
  asset,
  block,
  erc165: { standardId: "erc165", status: "not_supported" },
  erc8056: { standardId: "erc8056", status: "unknown" },
  pendingMultiplier: { standardId: "erc8056_pending_multiplier", status: "unknown" },
});
const exactResult = accountAssetApplicationContracts.exact.parsePublicSuccess(
  { asset, viewRevision },
  {
    account: selection.account,
    block,
    viewRevision,
    asset: {
      kind: "erc20",
      selection,
      name: { status: "available", value: "Example" },
      symbol: { status: "available", value: "EXT" },
      classification: {
        kind: "classification_unavailable",
        storedRevision: null,
        snapshot: null,
        member: null,
        reason: "source_unavailable",
      },
      amount: {
        raw: "5",
        decimals: "0",
        formattedRaw: "5",
        uiAdjusted: null,
        formattedUiAdjusted: null,
      },
      requiredStandards,
    },
    totalSupply: "100",
    standards: tokenStandardObservationResultSchema.parse({
      asset,
      account: selection.account,
      block,
      standards: [
        { standardId: "erc20_read_surface", status: "observed" },
        { standardId: "erc165", status: "not_supported" },
        { standardId: "erc8056", status: "unknown" },
        { standardId: "erc8056_pending_multiplier", status: "unknown" },
        { standardId: "erc8056_conversion", status: "unknown" },
        { standardId: "erc8056_balances", status: "unknown" },
      ],
    }),
  },
);

const callbacks = Object.freeze({
  onRefresh: vi.fn(),
  onRetryExact: vi.fn(),
  onAdd: vi.fn(),
  onInfo: vi.fn(),
  onCloseInfo: vi.fn(),
  onRemove: vi.fn(),
  onPrevious: vi.fn(),
  onNext: vi.fn(),
});

const renderPage = (exactRead: AccountAssetExactReadPresentation): string => renderToStaticMarkup(
  createElement(AccountAssetsPage, {
    snapshot: undefined,
    loading: false,
    staleMessage: undefined,
    exactRead,
    mutationDisabled: false,
    ...callbacks,
  }),
);

describe("account asset token action state presentation", () => {
  it("renders no token action dialog while closed", () => {
    const markup = renderPage({ status: "idle" });
    expect(markup).not.toContain("Token details and actions");
    expect(markup).not.toContain("Remove token");
  });

  it("retains removal and selection identity while exact information is loading", () => {
    const markup = renderPage({ status: "loading", selection });
    expect(markup).toContain("Reading token information");
    expect(markup).toContain(tokenAddress);
    expect(markup).toContain("Remove token");
    expect(markup).toContain("Close");
  });

  it("retains removal and retry after exact information fails", () => {
    const markup = renderPage({ status: "error", selection, message: "RPC unavailable" });
    expect(markup).toContain("Token information unavailable");
    expect(markup).toContain("RPC unavailable");
    expect(markup).toContain(tokenAddress);
    expect(markup).toContain("Retry");
    expect(markup).toContain("Remove token");
    expect(markup).toContain("Close");
  });

  it("renders canonical exact information without changing the removal identity", () => {
    const markup = renderPage({ status: "available", selection: exactResult.asset.selection, result: exactResult });
    expect(markup).toContain("Example");
    expect(markup).toContain("Formatted / raw balance");
    expect(markup).toContain(tokenAddress);
    expect(markup).toContain("Remove token");
    expect(markup).toContain("Close");
  });
});
