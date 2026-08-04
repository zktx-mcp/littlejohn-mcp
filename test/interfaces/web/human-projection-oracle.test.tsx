// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chainAnchorSchema,
  contractInspectCapability,
  createExactRational,
  getCapabilityDefinitionSnapshot,
  referenceHistorySuccessSchema,
  referenceHistoryWarnings,
  referenceMarketManifest,
  referenceMarketMappingEvidence,
  referencePriceSuccessSchema,
  referencePriceWarnings,
  referenceRoundObservationSchema,
} from "../../../src/core/browser.js";
import {
  browserLocations,
  browserWalletApiPaths,
  referenceMarketPublicRoutes,
} from "../../../src/interfaces/browser-contract.js";
import { App } from "../../../src/interfaces/web/app.js";
import { ContractAnalysisDetails } from "../../../src/interfaces/web/analysis-details.js";
import {
  AnalysisDialogContent,
  createAnalysisTarget,
} from "../../../src/interfaces/web/analysis-dialog.js";
import type { ReferenceChartPort } from "../../../src/interfaces/web/reference-chart.js";
import { ReferencePricePage } from "../../../src/interfaces/web/reference-price-page.js";
import { StockTokenAddDialog } from "../../../src/interfaces/web/stock-token-add-dialog.js";
import { StockTokenRemoveDialog } from "../../../src/interfaces/web/stock-token-remove-dialog.js";
import { presentStockTokenOperationTask } from "../../../src/interfaces/web/stock-token-task-presentation.js";
import { WalletTaskDialog } from "../../../src/interfaces/web/wallet-task-dialog.js";
import {
  tokenCatalogBrowserRoutes,
} from "../../../src/token-catalog/browser.js";
import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationPresentation,
} from "../../../src/wallet/operation-contract.js";
import {
  createExactResolvedAnalysis,
} from "../../core/contract-analysis-fixtures.js";
import { createTokenOperation, createInspectionSuccess, tokenAddress } from "../../token-catalog/harness.js";
import {
  stockTokenCandidate,
  stockTokenSelection,
} from "./stock-token-fixtures.js";

const fixedCapabilities = Object.freeze([
  "contract.inspect",
  "market.reference_history",
  "market.reference_price",
  "token.cancel_operation",
  "token.operation",
  "token.start_addition",
  "token.start_removal",
  "wallet.cancel_operation",
  "wallet.connect",
  "wallet.disconnect",
  "wallet.operation",
] as const);
type FixedCapability = typeof fixedCapabilities[number];

const unavailableChart: ReferenceChartPort = Object.freeze({
  mount: async () => Object.freeze({ status: "unavailable" }),
});
const pair = referenceMarketManifest.pairs[0]!;
const feed = referenceMarketManifest.feeds[0]!;
const block = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: "2026-07-22T00:07:00.000Z",
});
const analysisBlock = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: "2026-07-18T00:00:00.000Z",
});
const observedAt = "2026-07-22T00:02:00.000Z";
const observation = referenceRoundObservationSchema.parse({
  fact: {
    manifestVersion: 1,
    feedId: feed.feedId,
    proxyAddress: feed.standardProxy,
    decimals: 8,
    roundId: String((1n << 64n) | 1n),
    answeredInRound: String((1n << 64n) | 1n),
    answer: "193384405462",
    startedAtUnixSeconds: String(Date.parse(observedAt) / 1_000),
    updatedAtUnixSeconds: String(Date.parse(observedAt) / 1_000),
    value: createExactRational(193384405462n, 100000000n),
  },
  readEvidence: {
    observedAt: "2026-07-22T00:07:01.000Z",
    sourceOwner: "user_configured",
    sourceClass: "chain_rpc",
    sourceReference: {
      kind: "configured_rpc",
      sourceId: `rpc:${"A".repeat(43)}`,
      publicOrigin: "https://rpc.example",
      configurationDigest: "A".repeat(43),
    },
    block,
  },
});
const price = referencePriceSuccessSchema.parse({
  status: "current",
  pair,
  block,
  mappingEvidence: referenceMarketMappingEvidence,
  sources: [observation],
  warnings: referencePriceWarnings,
  currentPrice: observation.fact.value,
});
const requestedStart = "2026-07-21T00:07:00.000Z";
const firstBucket = Date.parse("2026-07-21T00:15:00.000Z");
const finalBucket = Date.parse("2026-07-22T00:00:00.000Z");
const bucketMilliseconds = 15 * 60 * 1_000;
const emptyBucketStarts = Object.freeze(Array.from(
  { length: (finalBucket - firstBucket) / bucketMilliseconds },
  (_, index) => new Date(firstBucket + index * bucketMilliseconds).toISOString(),
));
const history = referenceHistorySuccessSchema.parse({
  status: "partial",
  pair,
  window: "1d",
  block,
  mappingEvidence: referenceMarketMappingEvidence,
  coverage: {
    basis: "observed_rounds",
    requestedStart,
    requestedEnd: block.blockTimestamp,
    emptyBucketStarts,
    limitations: [
      "source_history_not_exhaustive",
      "traversal_incomplete",
      "phase_boundary",
      "malformed_round",
      "retention_limited",
    ],
  },
  candles: [{
    openedAt: new Date(finalBucket).toISOString(),
    closedAt: block.blockTimestamp,
    openBucket: true,
    open: observation.fact.value,
    high: observation.fact.value,
    low: observation.fact.value,
    close: observation.fact.value,
    openSourcePointers: [{ feedId: feed.feedId, roundId: observation.fact.roundId }],
    openSourceSkewSeconds: "0",
    highSourcePointers: [{ feedId: feed.feedId, roundId: observation.fact.roundId }],
    highSourceSkewSeconds: "0",
    lowSourcePointers: [{ feedId: feed.feedId, roundId: observation.fact.roundId }],
    lowSourceSkewSeconds: "0",
    closeSourcePointers: [{ feedId: feed.feedId, roundId: observation.fact.roundId }],
    closeSourceSkewSeconds: "0",
  }],
  sourceObservations: [observation],
  warnings: [...referenceHistoryWarnings, "partial_history"],
});

const response = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

describe("fixed browser human-projection oracle", () => {
  it("answers every proposed capability through current production components", async () => {
    const verified = new Set<FixedCapability>();
    const verify = (capability: FixedCapability, assertion: () => void): void => {
      assertion();
      verified.add(capability);
    };

    const analysis = await createInspectionSuccess(undefined, {
      analysis: createExactResolvedAnalysis(tokenAddress, analysisBlock),
    });
    const targetMarkup = renderToStaticMarkup(createElement(AnalysisDialogContent, {
      target: createAnalysisTarget({
        kind: "contract",
        address: tokenAddress,
        blockNumber: analysisBlock.blockNumber,
        expectedBlockHash: analysisBlock.blockHash,
      }),
      recoverSession: () => false,
    }));
    const analysisMarkup = renderToStaticMarkup(createElement(ContractAnalysisDetails, {
      analysis: analysis.data.analysis,
      coverage: analysis.evidence.coverage,
      warnings: analysis.warnings,
      limitations:
        getCapabilityDefinitionSnapshot(contractInspectCapability).staticScopeExclusions,
    }));
    verify("contract.inspect", () => {
      expect(targetMarkup).toContain(tokenAddress);
      expect(targetMarkup).toContain(`>${analysisBlock.blockNumber}<`);
      expect(analysisMarkup).toContain("Scam status");
      expect(analysisMarkup).toContain("Not established");
      expect(analysisMarkup).toContain("Control summary");
      expect(analysisMarkup).toContain("What this analysis cannot establish");
      expect(analysisMarkup).not.toContain(analysisBlock.blockHash);
    });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === referenceMarketPublicRoutes.priceQueries) return response(price);
      if (path === referenceMarketPublicRoutes.historyQueries) return response(history);
      throw new Error(`Unexpected reference-market request: ${path}`);
    }));
    const reference = render(createElement(ReferencePricePage, {
      chartPort: unavailableChart,
      pageLocation: browserLocations.referencePrice(pair.pairId, "1d"),
      onNavigate: () => undefined,
      onAnalyze: () => undefined,
    }));
    await waitFor(() => {
      expect(reference.container.textContent).toContain("Trade volume is not available");
    });
    const referenceText = reference.container.textContent ?? "";
    verify("market.reference_price", () => {
      expect(referenceText).toContain(pair.label);
      expect(reference.container.querySelector(".primary-financial-value .human-rational")
        ?.getAttribute("aria-label")).toBe("Approximately $1933.8441");
      expect(referenceText).not.toContain("193384405462");
      expect(referenceText).toContain("Current");
      expect(referenceText).toContain("not a trade or executable quote");
      expect(referenceText).toContain("source listing was not revalidated");
      expect(referenceText).toContain("Sequencer status is not available");
    });
    verify("market.reference_history", () => {
      expect(referenceText).toContain("One reference value is available");
      expect(referenceText).toContain("1 of 96 chart intervals contain reference values");
      expect(referenceText).toContain("Trade volume is not available");
      expect(referenceText).toContain("complete requested window");
      expect(referenceText).toContain("source history is not exhaustive");
      expect(referenceText).toContain("source traversal did not reach");
      expect(referenceText).toContain("source phase boundary");
      expect(referenceText).toContain("malformed source round");
      expect(referenceText).toContain("Source retention limits");
    });
    reference.unmount();
    vi.unstubAllGlobals();

    const addMarkup = renderToStaticMarkup(createElement(StockTokenAddDialog, {
      presentation: {
        candidates: [stockTokenCandidate],
        addStatus: { status: "idle" },
        inputsLocked: false,
        dismissible: true,
      },
      onClose: () => undefined,
      onAdd: () => undefined,
      onRetry: () => undefined,
    }));
    verify("token.start_addition", () => {
      expect(addMarkup).toContain("Search the official Stock Token list");
      expect(addMarkup).toContain("Example Stock Token");
      expect(addMarkup).toContain('aria-label="Add Example Stock Token"');
      expect(addMarkup).not.toContain("Continue");
    });

    const removal = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
    });
    if (removal.kind !== "remove") throw new TypeError("Expected removal operation.");
    const removalTask = presentStockTokenOperationTask({
      operation: removal,
      account: {
        chainId: removal.account.chainId,
        address: removal.account.address,
        connectionRevision: removal.connectionRevision,
      },
      pending: false,
      actionIntent: undefined,
      delivery: undefined,
    });
    if (removalTask === undefined) throw new TypeError("Expected removal task.");
    const removalMarkup = renderToStaticMarkup(createElement(StockTokenRemoveDialog, {
      presentation: {
        status: "ready",
        subject: { selection: stockTokenSelection, name: "Example Stock Token" },
        operation: removal,
        operationTask: removalTask,
      },
      onClose: () => undefined,
      onConfirm: () => undefined,
      onRetry: () => undefined,
    }));
    verify("token.start_removal", () => {
      expect(removalMarkup).toContain("Remove Example Stock Token from Assets?");
      expect(removalMarkup).toContain("does not transfer or dispose of the token");
      expect(removalMarkup).toContain(">Remove<");
    });
    const cliRemoval = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
      interactionInterface: "cli",
    });
    const disconnectedWallet = parseWalletCurrentOperationProjection({
      status: "absent",
      connectionRevision: "7",
      connection: { status: "disconnected", reason: "no_session" },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function showModal(this: HTMLDialogElement): void {
        this.setAttribute("open", "");
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: function close(this: HTMLDialogElement): void {
        this.removeAttribute("open");
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : input.toString();
      if (path === browserWalletApiPaths.currentOperation) {
        return response(disconnectedWallet);
      }
      if (path === tokenCatalogBrowserRoutes.currentOperation) {
        return response({ operation: cliRemoval });
      }
      if (path === tokenCatalogBrowserRoutes.operation(cliRemoval.operationId)) {
        return response({ operation: cliRemoval });
      }
      throw new Error(`Unexpected Browser projection request: ${path}`);
    }));
    const cliApp = render(createElement(App, {
      referenceChart: unavailableChart,
      locationState: { status: "valid", location: browserLocations.assets() },
      navigationFocusVisible: false,
      onNavigate: () => undefined,
    }));
    const cliDialog = await cliApp.findByRole("dialog", {
      name: "Remove Stock Token",
    });
    verify("token.operation", () => {
      expect(removalTask.operation).toBe(removal);
      expect(removalTask.account).toEqual({ status: "exact" });
      expect(removalTask.request).toEqual({ status: "idle" });
      expect(removalMarkup).toContain("connected account");
      expect(within(cliDialog).getByText("Read-only review")).toBeTruthy();
      expect(within(cliDialog).getByText("Continue this token change in the CLI."))
        .toBeTruthy();
      expect(cliDialog.textContent).toContain(cliRemoval.asset.address);
    });
    verify("token.cancel_operation", () => {
      expect(removalTask.actions).toEqual(["confirm", "cancel"]);
      expect(removalMarkup).toContain(">Cancel<");
      expect(within(cliDialog).queryByRole("button", { name: "Keep token" }))
        .toBeNull();
      expect(within(cliDialog).queryByRole("button", { name: "Remove token" }))
        .toBeNull();
    });
    cliApp.unmount();
    vi.unstubAllGlobals();

    const operationId = "A".repeat(43);
    const walletBase = Object.freeze({
      operationId,
      connectionRevision: "7",
      actionExpiresAt: "2099-12-31T23:59:59.000Z",
      interactionInterface: "web" as const,
      result: null,
      failure: null,
      peerRefusalCode: null,
    });
    const connectOperation = parseWalletManagementOperation({
      ...walletBase,
      kind: "connect",
      state: "awaiting_wallet_approval",
    });
    const connectPresentation = parseWalletOperationPresentation({
      operation: connectOperation,
      access: "interactive",
      qr: { size: 21, rows: Array.from({ length: 21 }, () => "1".repeat(21)) },
    });
    const connectMarkup = renderToStaticMarkup(createElement(WalletTaskDialog, {
      task: "wallet_connect",
      connectionRevision: "7",
      operationId,
      operationPresentation: connectPresentation,
      pending: false,
      pendingAction: undefined,
      pendingOperationId: undefined,
      delivery: undefined,
      actionFailure: undefined,
      onClose: () => undefined,
      onAction: () => undefined,
    }));
    const mismatchedConnectMarkup = renderToStaticMarkup(createElement(WalletTaskDialog, {
      task: "wallet_connect",
      connectionRevision: "7",
      operationId: `${"B".repeat(42)}A`,
      operationPresentation: connectPresentation,
      pending: false,
      pendingAction: undefined,
      pendingOperationId: undefined,
      delivery: undefined,
      actionFailure: undefined,
      onClose: () => undefined,
      onAction: () => undefined,
    }));
    const absentDisconnectMarkup = renderToStaticMarkup(createElement(
      WalletTaskDialog,
      {
        task: "wallet_disconnect",
        connectionRevision: "7",
        operationId: `${"D".repeat(42)}A`,
        operationPresentation: undefined,
        pending: false,
        pendingAction: undefined,
        pendingOperationId: undefined,
        delivery: undefined,
        actionFailure: undefined,
        onClose: () => undefined,
        onAction: () => undefined,
      },
    ));
    verify("wallet.connect", () => {
      expect(connectMarkup).toContain(">Connect wallet<");
      expect(connectMarkup).toContain("Scan with Robinhood Wallet");
      expect(connectMarkup).toContain('aria-label="Robinhood Wallet pairing code"');
      expect(connectMarkup).not.toContain("signature");
      expect(connectMarkup).not.toContain("transaction");
    });
    verify("wallet.operation", () => {
      expect(connectMarkup).toContain("Scan with Robinhood Wallet");
      expect(mismatchedConnectMarkup).toContain("Starting wallet connection");
      expect(mismatchedConnectMarkup).not.toContain("Scan with Robinhood Wallet");
      expect(mismatchedConnectMarkup).not.toContain(
        "The Robinhood Chain wallet session is ready.",
      );
      expect(absentDisconnectMarkup).toContain("Preparing wallet disconnection");
      expect(absentDisconnectMarkup).not.toContain(
        "No wallet session remains in this local profile.",
      );
    });
    verify("wallet.cancel_operation", () => {
      expect(connectMarkup).toContain(">Cancel connection<");
      expect(mismatchedConnectMarkup).not.toContain(">Cancel connection<");
    });

    const disconnectOperation = parseWalletManagementOperation({
      ...walletBase,
      operationId: `${"C".repeat(42)}A`,
      kind: "disconnect",
      state: "awaiting_confirmation",
    });
    const disconnectPresentation = parseWalletOperationPresentation({
      operation: disconnectOperation,
      access: "interactive",
    });
    const disconnectMarkup = renderToStaticMarkup(createElement(WalletTaskDialog, {
      task: "wallet_disconnect",
      connectionRevision: "7",
      operationId: disconnectOperation.operationId,
      operationPresentation: disconnectPresentation,
      pending: false,
      pendingAction: undefined,
      pendingOperationId: undefined,
      delivery: undefined,
      actionFailure: undefined,
      onClose: () => undefined,
      onAction: () => undefined,
    }));
    verify("wallet.disconnect", () => {
      expect(disconnectMarkup).toContain(">Disconnect wallet<");
      expect(disconnectMarkup).toContain("Remove every wallet session from this local profile");
      expect(disconnectMarkup).toContain("Every existing wallet session");
      expect(disconnectMarkup).toContain("will be disconnected");
      expect(disconnectMarkup).toContain(">Disconnect<");
    });

    expect([...verified].sort()).toEqual([...fixedCapabilities].sort());
  });
});
