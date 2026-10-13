import {readFileSync} from "node:fs";
import {resolve} from "node:path";
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {presentationContractRegistry, presentationContracts} from "../../../src/interfaces/mcp-app/registry.js";
import {renderApplicationFailure, renderOperation, renderPresentation, renderWalletDisconnectTargets, renderCardOperation, renderWalletAccountControls, renderReviewControls} from "../../../src/interfaces/mcp-app/view/renderers.js";
import {operationReviewContext} from "../../../src/interfaces/mcp-app/view/operation-lifecycle.js";
import {walletAccountSelectionSchema} from "../../../src/wallet/account-selection-contract.js";
import {cardOperationProjectionSchema} from "../../../src/interfaces/mcp-app/card-contract.js";
import {
  stockTokenTradeHistoryAvailableFixture,
  stockTokenTradeHistoryUnavailableFixture,
} from "../stock-token-trade-history-fixture.js";
import { createTokenOperation } from "../../token-catalog/harness.js";
import { createExactResolvedAnalysis } from "../../core/contract-analysis-fixtures.js";
import { parseWalletManagementOperation, parseWalletReview, walletReviewDigest } from "../../../src/wallet/contracts.js";
import { createWalletFailure } from "../../../src/wallet/operation-error.js";
import { captureCanonicalJson } from "../../../src/core/client.js";
import {createFieldIssue} from "../../../src/core/evidence.js";
import { createPriceFixture } from "../../stock-token-prices/fixture.js";
import { stockTokenPricesCapability, stockTokensCapability } from "../../../src/stock-token-prices/contracts.js";
import { createApplicationFailure } from "../../../src/core/client.js";
import { stockTokenPricesErrorRegistry } from "../../../src/stock-token-prices/contracts.js";
import {walletConnectionCapability} from "../../../src/wallet/connection-capability.js";
import {walletConnectionEvidence} from "../../../src/wallet/connection-evidence.js";
import {walletErrorRegistry} from "../../../src/wallet/errors.js";
import {bindForHarness, createCapabilityHarness, invokeBinding} from "../../core/capability-harness.js";
import {exchangeReviewSchema} from "../../../src/review/contracts.js";
import {exchangeErrorRegistry} from "../../../src/review/errors.js";
import {exchangeReviewSections, transactionSectionsText} from "../../../src/interfaces/exchange-presentation.js";
import { accountAssetsPresentationFixture } from "../../account-assets/presentation-fixture.js";
import { tokenReviewFixture } from "../../token-catalog/review-fixture.js";

const address = `0x${"1".repeat(40)}`;

describe("account balance meaning", () => {
  it.each([
    { options: {}, label: "Adjusted balance", amount: "2 TOK", limitation: null },
    { options: { adjustment: "unknown" as const }, label: "Token balance", amount: "1 TOK", limitation: "The token's display adjustment could not be confirmed." },
    { options: { adjustment: "inconsistent" as const }, label: "Token balance", amount: "1 TOK", limitation: "The token's display-adjustment data could not be verified." },
    { options: { decimals: null }, label: "Token balance", amount: "Amount unavailable", limitation: "Token unit information is unavailable for nonzero amounts." },
  ])("renders $label $amount with its actual interpretation limits", ({ options, label, amount, limitation }) => {
    const { input, result } = accountAssetsPresentationFixture(options);
    const before = JSON.stringify(result);
    const entry = presentationContracts.accountAssets;
    const admitted = entry.parseResult(entry.parseInput(input), result);
    const rendered = renderPresentation(entry, admitted).node;
    const item = rendered.querySelector("li")!;
    expect(fields(item.querySelector("dl")).get(label)).toBe(amount);
    if (limitation !== null) expect([...item.querySelectorAll(":scope > p")].map(p => p.textContent)).toContain(limitation);
    const details = item.querySelector("details");
    if (label === "Adjusted balance") {
      expect(details?.querySelector("summary")?.textContent).toBe("Asset details");
      expect(fields(details?.querySelector("dl") ?? null).get("Token balance")).toBe("1 TOK");
      expect(details?.textContent).toContain("2000000000000000000 / 1000000000000000000");
    }
    if (options.decimals === null) {
      expect([...details!.querySelectorAll("h3")].map(h => h.textContent)).toEqual(["Token balance", "Adjusted balance"]);
      expect([...details!.querySelectorAll("dd")].map(d => d.textContent)).toContain("2000000");
    }
    expect(rendered.textContent).not.toMatch(/Pending|3000000000000000000|1900000000/);
    expect(rendered.querySelectorAll("button, select")).toHaveLength(0);
    expect(JSON.stringify(result)).toBe(before);
  });
});

describe("Wallet decision and result meaning", () => {
  it.each(["1", "2"])("does not infer multiple connections from an unresolved result with count %s", async (sessionCount) => {
    const data = {status: "unresolved", sessionCount};
    const harness = createCapabilityHarness();
    const binding = bindForHarness(walletConnectionCapability, harness, async (_input, context, observations) => {
      const sdk = observations.bind(walletConnectionEvidence.targets.sdk);
      observations.record(sdk.slot, {source: context.ports.observations.get("wallet_sdk"), claims: [{role: sdk.roles.state, value: data}]});
      return {status: "success", data};
    }, walletErrorRegistry);
    const result = await invokeBinding(walletConnectionCapability, binding, {});
    if (!result.ok) throw new Error(JSON.stringify(result));
    const entry = presentationContracts.walletConnection;
    const admitted = entry.parseResult(entry.parseInput({}), result);
    const rendered = renderPresentation(entry, admitted).node;
    expect(rendered.textContent).toContain("Needs attention");
    expect(rendered.textContent).toContain("A usable wallet connection could not be confirmed.");
    expect(rendered.textContent?.includes("More than one wallet connection was found.")).toBe(sessionCount === "2");
    expect([...rendered.querySelectorAll("dt")].map(node => node.textContent)).not.toContain("Account");
    expect(rendered.querySelectorAll("button, select")).toHaveLength(0);
  });

  it.each([
    {path: "/amount", field: '"/amount"'},
    {path: "/amount\u001b[31m\u202e", field: '"/amount\\u001b[31m\\u202e"'},
  ])("preserves input issues in application and Review details and shared text ($field)", ({path, field}) => {
    const failure = createApplicationFailure(exchangeErrorRegistry, "invalid_input", [createFieldIssue("invalid_value", path)]);
    const review = exchangeReviewSchema.parse({state: "refresh_required", operationId: Buffer.alloc(32, 4).toString("base64url"), failure});
    const before = captureCanonicalJson(review);
    for (const rendered of [renderApplicationFailure(failure), renderPresentation(presentationContracts.transactionReview, before).node]) {
      const details = rendered.querySelector("details")!;
      expect(details.querySelector("summary")?.textContent).toBe("Error details");
      expect([...details.querySelectorAll("dt")].map(node => node.textContent)).toEqual(["Error code", "Reported reason", "Field", "Error code", "Reported reason"]);
      expect([...details.querySelectorAll("dd")].map(node => node.textContent)).toEqual(["invalid_input", "The request input is invalid.", field, "invalid_value", "The field value is invalid."]);
    }
    expect(transactionSectionsText(exchangeReviewSections(review))).toBe(`Request failed\nSome request details are invalid. Check the fields listed in Error details.\n\nError details\nError code: invalid_input\nReported reason: The request input is invalid.\nField: ${field}\nError code: invalid_value\nReported reason: The field value is invalid.`);
    expect(captureCanonicalJson(review)).toEqual(before);
  });
  it("describes a sole effective account without claiming a stored preference", () => {
    const state = walletAccountSelectionSchema.parse({connectionId: `wallet-session:${Buffer.alloc(32, 1).toString("base64url")}`,
      chainId: "eip155:4663", connectionRevision: "1", selectionRevision: "0",
      account: {chainId: "eip155:4663", address}, eligibleAccounts: [{chainId: "eip155:4663", address}]});
    const rendered = renderWalletAccountControls(state, state, null);
    expect(rendered.node.textContent).toContain(`Current account: ${address}`);
    expect(rendered.node.textContent).not.toContain("Current preference");
    const original = renderPresentation(presentationContracts.walletSelection, captureCanonicalJson(state));
    expect(original.node.textContent).toContain("Existing requests keep their original account.");
    expect(original.node.querySelector("ul")).toBeNull();
    expect(original.node.textContent).not.toContain("Preference when this card was created");
    expect(state.selectionRevision).toBe("0");
    expect(rendered.node.querySelectorAll("select")).toHaveLength(1);
    expect(rendered.node.querySelectorAll("option")).toHaveLength(2);
  });

  it.each([
    ["internal_error", "The request could not be completed."],
    ["runtime_state_unavailable", "Local runtime state is unavailable."],
    ["state_conflict", "Local state changed before the request completed."],
    ["wallet_pairing_code_unavailable", "The wallet pairing code could not be created."],
    ["wallet_session_unusable", "The WalletConnect session cannot satisfy this request."],
    ["wallet_timeout", "The wallet action exceeded Little John's local action deadline."],
    ["walletconnect_unavailable", "WalletConnect could not complete the wallet action."],
  ] as const)("presents the owner failure %s for the original connection request in full and compact results", (code, message) => {
    const operationId = Buffer.alloc(32, 1).toString("base64url");
    const actionExpiresAt = "2026-08-12T00:05:00.000Z";
    const unsigned = {contractVersion: "1", domain: "wallet", kind: "connect", operationId,
      createdAt: "2026-08-12T00:00:00.000Z", actionExpiresAt, target: {chainId: "eip155:4663"},
      decision: {requiredMethods: ["eth_sendTransaction"], optionalMethods: ["personal_sign", "eth_signTypedData_v4"], requiredEvents: ["accountsChanged", "chainChanged"]},
      precondition: {connectionRevision: "1", connection: {status: "disconnected", reason: "no_session"}}, fixedEvidence: {sessionSourceIds: []}};
    const review = parseWalletReview({...unsigned, reviewDigest: walletReviewDigest(unsigned)});
    const operation = parseWalletManagementOperation({contractVersion: "1", domain: "wallet", kind: "connect", operationId,
      initiatedBy: "mcp_app", review, state: "failed", terminationTarget: null, result: null,
      peerRefusalCode: null, failure: createWalletFailure(code)});
    const entry = presentationContracts.walletOperation;
    const full = renderOperation(entry, entry.parseResult(entry.parseInput({operationId}), operation)).node;
    const compact = renderCardOperation(cardOperationProjectionSchema.parse({kind: "wallet", operationId,
      resultSha256: "a".repeat(64), initiatedBy: "mcp_app", actionExpiresAt,
      action: "connect", state: "failed", account: null, connectionRevision: null, peerRefusalCode: null, failureCode: code}));
    for (const rendered of [full, compact]) {
      expect(rendered.querySelector("h2")?.textContent).toBe("Request failed");
      const details = rendered.querySelector("details");
      expect(details?.querySelector("summary")?.textContent).toBe("Error details");
      const summary = fields(details?.querySelector("dl") ?? null);
      expect(summary.get("Error code")).toBe(code);
      expect(summary.get("Reported reason")).toBe(message);
      expect(rendered.textContent).not.toContain(operationId);
      expect(rendered.textContent).not.toContain("A wallet connection was established for this request.");
      expect(rendered.querySelectorAll("button, svg")).toHaveLength(0);
      expect(rendered.textContent).not.toContain("disconnect it, then connect again");
    }
    expect(operation.review).toEqual(review);
  });
});

describe("Stock Token price and catalog presentation", () => {
  it("displays the owning candidate-response failure without reporting a canonical result overflow", () => {
    const admitted = presentationContracts.stockTokenPrices.parseFailure(createApplicationFailure(
      stockTokenPricesErrorRegistry, "pool_candidate_response_too_large",
    ));
    const rendered = renderApplicationFailure(admitted);
    expect(rendered.getAttribute("role")).toBe("alert");
    expect(rendered.querySelector("h1")?.textContent).toBe("Request failed");
    expect(rendered.textContent).toContain("pool_candidate_response_too_large");
    expect(rendered.textContent).toContain("The pool candidate response exceeds the supported size.");
    expect(rendered.textContent).not.toContain("canonical result");
    expect(rendered.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows the pool comparison and exact values as immutable data", async () => {
    const fixture = createPriceFixture();
    try {
      const prices = await fixture.bindings.invoke(stockTokenPricesCapability, { symbol: "AAPL" }, { signal: new AbortController().signal });
      if (!prices.ok) throw new Error(JSON.stringify(prices));
      const rendered = renderPresentation(presentationContracts.stockTokenPrices, captureCanonicalJson(prices));
      expect(rendered.node.querySelector("h1")?.textContent).toBe("Stock Token prices");
      expect(rendered.node.textContent).toContain("USDG per Stock Token");
      expect(rendered.node.textContent).toContain("0.05%");
      expect(rendered.node.textContent).toContain("1 / 1");
      expect(rendered.node.textContent).toContain("not a complete pool list");
      expect(rendered.node.querySelectorAll("button")).toHaveLength(0);
      const tokens = await fixture.bindings.invoke(stockTokensCapability, {}, { signal: new AbortController().signal });
      if (!tokens.ok) throw new Error(JSON.stringify(tokens));
      const catalog = renderPresentation(presentationContracts.stockTokens, captureCanonicalJson(tokens));
      expect(catalog.node.textContent).toContain("Official listing does not confirm a pool");
      expect(catalog.node.textContent).toContain("AAPL");
      expect(catalog.node.querySelectorAll("button")).toHaveLength(0);
    } finally { await fixture.close(); }
  });
});
const block = {
  chainId: "eip155:4663",
  blockNumber: "42",
  blockHash: `0x${"a".repeat(64)}`,
  blockTimestamp: "2026-07-24T00:00:00.000Z",
} as const;

const fields = (list: Element | null): ReadonlyMap<string, string> => {
  if (!(list instanceof HTMLDListElement)) throw new TypeError("Summary is unavailable.");
  const labels = [...list.querySelectorAll("dt")];
  const values = [...list.querySelectorAll("dd")];
  return new Map(labels.map((label, index) => [label.textContent ?? "", values[index]?.querySelector(".identifier-full")?.textContent ?? values[index]?.textContent ?? ""]));
};

describe("Wallet disconnect Review presentation", () => {
  it("shows the complete unresolved session set without inventing an account", () => {
    const sourceIds = [1, 2].map((value) => `wallet-session:${Buffer.alloc(32, value).toString("base64url")}`).sort();
    const input = {
      contractVersion: "1", domain: "wallet", kind: "disconnect", operationId: Buffer.alloc(32, 3).toString("base64url"),
      createdAt: "2026-07-14T00:00:00.000Z", actionExpiresAt: "2026-07-14T00:05:00.000Z",
      target: { chainId: "eip155:4663" }, decision: { action: "disconnect_session" },
      precondition: { connectionRevision: "3", targetSet: {kind: "inline", targets: sourceIds.map((sourceId) => ({status: "unavailable", sourceId, reason: "adapter_invalid"}))} },
    };
    const review = parseWalletReview({ ...input, reviewDigest: walletReviewDigest(input) });
    const rendered = renderPresentation(presentationContracts.walletReview, captureCanonicalJson({ status: "review", review }));
    if (review.kind !== "disconnect" || review.precondition.targetSet.kind !== "inline") throw new Error("Inline disconnect targets required.");
    rendered.node.append(renderWalletDisconnectTargets(review.precondition.targetSet.targets));
    expect(rendered.node.textContent).toContain("including their approved accounts and networks");
    expect(rendered.node.textContent).toContain("does not transfer assets");
    for (const id of sourceIds) expect(rendered.node.textContent).toContain(id);
    const labels = [...rendered.node.querySelectorAll("dt")].map((label) => label.textContent);
    expect(labels).not.toContain("Account");
    expect(labels).not.toContain("Session expires");
  });
});

describe("Address inspection presentation", () => {
  const success = (data: unknown) => ({
    ok: true,
    meta: {
      capabilityId: "address.inspect",
      contractVersion: "1",
      chainId: "eip155:4663",
      evaluatedAt: "2026-07-24T00:00:00.000Z",
    },
    data,
    evidence: {
      sources: [],
      conclusions: [],
      coverage: { status: "complete", established: [], notApplicable: [], unavailable: [] },
    },
    warnings: [],
  });

  it("renders empty code without an analysis panel or address-type claim", () => {
    const entry = presentationContracts.addressInspection;
    const rendered = renderPresentation(entry, success({
      status: "no_runtime_code_observed",
      address,
      block,
      runtimeCode: "0x",
    }) as never);

    expect(rendered.node.querySelector("h1")?.textContent).toBe("Address information");
    expect(fields(rendered.node.querySelector("dl"))).toEqual(new Map<string, string>([
      ["Account", address],
    ]));
    expect(rendered.node.textContent).not.toMatch(/Source checks|Declared functions/iu);
    expect(rendered.node.textContent).toContain(
      "does not establish an enduring EOA or contract classification",
    );
  });

  it("renders the existing analysis details only for observed runtime code", () => {
    const entry = presentationContracts.addressInspection;
    const analysis = createExactResolvedAnalysis(address as never, block as never);
    const rendered = renderPresentation(entry, success({
      status: "runtime_code_observed",
      address,
      block,
      runtimeCode: "0x6000",
      analysis,
    }) as never);

    const summaryFields = fields(rendered.node.querySelector("dl"));
    expect(summaryFields.get("Account")).toBe(address);
    const identifier = rendered.node.querySelector<HTMLElement>(".identifier")!;
    expect(identifier.tabIndex).toBe(0);
    expect(identifier.querySelector(".identifier-preview")?.getAttribute("aria-hidden")).toBe("true");
    expect(identifier.querySelector(".identifier-full")?.textContent).toBe(address);
    expect(rendered.node.textContent).toContain("Contract code found");
    expect(fields(rendered.node.querySelector("details dl")).get("Block")).toBe("42");
    expect(rendered.node.textContent).toContain("Proxy");
    expect(rendered.node.textContent).not.toContain("Source checks");
    expect(rendered.node.textContent).toContain("Declared functions");
  });
});

describe("Stock Token trade-history presentation", () => {
  it("keeps exact chart values accessible without exposing machine correlations", () => {
    const entry = presentationContracts.stockTokenTradeHistory;
    const input = entry.parseInput({ symbol: "AAPL", period: { count: 1, unit: "day" } });
    const value = stockTokenTradeHistoryAvailableFixture();
    if (value.data.status !== "available") throw new TypeError("Trade-history fixture is unavailable.");
    const data = value.data;
    const admitted = entry.parseResult(input, value);
    const rendered = renderPresentation(entry, admitted);
    const card = rendered.node;

    expect(card.querySelector("h1")?.textContent).toBe("Stock Token trade history");
    expect(fields(card.querySelector("dl"))).toEqual(new Map<string, string>([
      ["Token", "Apple • Robinhood Token · AAPL"],
      ["Requested period", `1 day\n${data.requestedStart} to ${data.requestedEnd}`],
    ]));
    expect(card.textContent).toContain("Trades in USDG");
    expect(card.textContent).not.toContain("StatusAvailable");
    expect(card.textContent).toContain(
      `Data freshness${data.freshness === "current" ? "Current" : "Stale"}`,
    );
    expect(card.textContent).toContain(
      `Data coverage${data.coverage.status === "complete" ? "Complete" : "Partial"}`,
    );
    expect(card.textContent).toContain(
      `Published through${data.archive.root.currentUntil.timestamp}`,
    );
    for (const limitation of data.coverage.limitations) {
      expect(card.textContent).toContain(limitation === "before_published_coverage"
        ? "Data starts after the requested period begins."
        : "Data ends before the requested period ends.");
    }
    expect(card.textContent).not.toContain("Chainlink");
    expect(card.textContent).not.toContain("oracle");
    expect(card.textContent).not.toContain("Reference value");
    expect(card.querySelector(".eyebrow")).toBeNull();
    expect(rendered.tradeHistoryChart).not.toBeNull();
    expect(card.querySelector('.trade-history-chart[role="img"]')?.getAttribute("aria-label"))
      .toContain("Apple • Robinhood Token · AAPL");
    expect(card.querySelector('.trade-history-chart[role="img"]')?.getAttribute("aria-label"))
      .toContain("Trades in USDG");
    expect(card.querySelector('.trade-history-chart[role="img"]')?.getAttribute("aria-label"))
      .toContain("Chart data");
    expect(card.querySelector('.trade-history-chart[role="img"]')?.getAttribute("aria-label"))
      .toContain(`${data.requestedStart} inclusive to ${data.requestedEnd} exclusive`);

    const disclosures = [...card.querySelectorAll("details")];
    expect(disclosures.map((details) => details.querySelector("summary")?.textContent)).toEqual([
      "Asset details",
      "Chart data",
      "Data source",
    ]);
    expect(disclosures.every((details) => !details.open)).toBe(true);
    expect([...card.querySelectorAll("dt")].filter(node => node.textContent === "Requested period")).toHaveLength(1);
    expect(card.textContent).toContain(`1 day\n${data.requestedStart} to ${data.requestedEnd}`);
    const sourceValues = [...disclosures[2]!.querySelectorAll("dd")].map(node => node.textContent);
    expect(sourceValues.filter(text => text === "Fixture RPC · https://rpc.example/")).toHaveLength(1);
    expect(value.evidence.sources.filter(source => source.reference.kind === "public" && source.reference.uri === "https://rpc.example/")).toHaveLength(2);
    expect(card.textContent).not.toContain("Exact chart data");

    const token = disclosures[0]!;
    expect(fields(token.querySelector("dl"))).toEqual(new Map<string, string>([
      ["Token address", data.officialAsset.member.contractAddress],
      ["USDG contract", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"],
      ["Uniswap V4 PoolManager", "0x8366a39cc670b4001a1121b8f6a443a643e40951"],
      ["Uniswap V4 Pool IDs", Object.keys(data.archive.pools).join(", ")],
    ]));

    const developer = disclosures[1]!;
    developer.open = true;
    developer.dispatchEvent(new Event("toggle"));
    expect(developer.textContent).not.toContain(data.officialAsset.member.contractAddress);
    expect(developer.textContent).not.toContain("One-minute trade candles");
    expect(card.textContent).not.toContain("Source publication sequence");
    const tables = [...developer.querySelectorAll("table")];
    expect(tables.map(table => table.querySelector("caption")?.textContent)).toEqual([
      "Intervals include the start time and stop before the end time.",
    ]);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.querySelectorAll("tbody tr")).toHaveLength(data.positions.length);
    const headings = [...(tables[0]?.querySelectorAll("th") ?? [])].map(heading => heading.textContent);
    expect(headings).toEqual([
      "Interval start", "Interval end", "Displayed from", "Displayed until", "Data coverage", "Data limits", "Pool ID",
      "First price (USDG)", "Highest price (USDG)", "Lowest price (USDG)", "Last price (USDG)", "USDG volume", "Token volume (AAPL)",
      "Trade count", "Observed from", "Observed until",
    ]);
    expect(new Set(headings).size).toBe(headings.length);
    const firstCandle = data.positions.find((position) => position.candle !== null)?.candle;
    if (firstCandle === undefined || firstCandle === null) {
      throw new TypeError("Trade-history fixture has no candle.");
    }
    expect(developer.textContent).toContain(
      `${firstCandle.open.numerator} / ${firstCandle.open.denominator}`,
    );
    for (const position of data.positions) {
      expect(developer.textContent).toContain(position.naturalStart);
      expect(developer.textContent).toContain(position.representedEnd);
      if (position.candle !== null) {
        expect(developer.textContent).toContain(position.candle.observedStart);
        expect(developer.textContent).toContain(position.candle.observedEnd);
        expect(developer.textContent).toContain(position.candle.tradeCount);
      }
    }
    expect(developer.textContent).not.toContain(firstCandle.firstSource.blockHash);
    expect(developer.textContent).not.toContain(firstCandle.firstSource.transactionHash);
    for (const source of value.evidence.sources) {
      expect(card.textContent).not.toContain(source.invocationId);
      expect(card.textContent).not.toContain(source.observationId);
      expect(card.textContent).not.toContain(source.recordDigest);
    }
    // Presentation omission is not canonical evidence removal.
    expect(entry.parseResult(input, value)).toEqual(admitted);
    expect(JSON.stringify(admitted)).toContain(firstCandle.firstSource.transactionHash);
  });

  it("states trade-history unavailability without reviving removed reference data", () => {
    const entry = presentationContracts.stockTokenTradeHistory;
    const admitted = entry.parseResult(
      entry.parseInput({ symbol: "AAPL", period: { count: 1, unit: "day" } }),
      stockTokenTradeHistoryUnavailableFixture(),
    );
    const rendered = renderPresentation(entry, admitted);

    expect(rendered.tradeHistoryChart).toBeNull();
    expect(rendered.node.textContent).toContain("Trades in USDG");
    expect(rendered.node.textContent).toContain("Unavailable");
    expect(rendered.node.textContent).not.toMatch(/Chainlink|oracle|reference price/iu);
    const details = [...rendered.node.querySelectorAll("details")];
    expect(details.map((value) => value.querySelector("summary")?.textContent))
      .toEqual(["Data source", "Asset details"]);
    expect([...fields(details[1]?.querySelector("dl") ?? null).keys()])
      .toEqual(["Token address"]);
  });

  it("keeps the closed presentation registry as the View classifier", () => {
    expect(presentationContractRegistry.forContract(
      presentationContracts.stockTokenTradeHistory.contract,
    )).toBe(presentationContracts.stockTokenTradeHistory);
    expect(presentationContractRegistry.values()).toContain(
      presentationContracts.stockTokenTradeHistory,
    );
    expect(presentationContractRegistry.values().some((entry) =>
      /reference|market portfolio/iu.test(entry.title))).toBe(false);
  });
});

describe("Token selection operation presentation", () => {
  it.each(["official", "unlisted"] as const)("keeps %s classification and unavailable metadata in the admitted Review", (classification) => {
    const review = tokenReviewFixture({ classification, missingMetadata: true });
    const before = JSON.stringify(review);
    const entry = presentationContracts.tokenSelectionReview;
    const input = entry.parseInput({ kind: "add", account: { kind: "address", address: review.target.account.address }, asset: review.target.asset });
    const rendered = renderPresentation(entry, entry.parseResult(input, { review })).node;
    const data = new Map([...rendered.querySelectorAll("dl")].flatMap(dl => [...fields(dl)]));
    expect(data.get("Official listing")).toBe(classification === "official" ? "Robinhood Stock Token" : "Custom token");
    expect(data.get("Name")).toBe("Unavailable");
    expect(rendered.textContent).toContain("The token name contains unsupported text and is not shown.");
    expect(rendered.textContent).toContain("Official listing does not prove token safety or ownership of underlying shares.");
    expect(rendered.textContent).toContain("Some of the requested data is unavailable.");
    expect(JSON.stringify(review)).toBe(before);
  });
  it.each(["add", "remove"] as const)("keeps %s local visibility meaning in its Review, action and recorded result", async (kind) => {
    const entry = presentationContracts.tokenSelectionOperation;
    const operation = await createTokenOperation({kind});
    if (kind === "remove") expect(operation.result.selection.historicalInspection).toBeNull();
    const reviewEntry = presentationContracts.tokenSelectionReview;
    const input = reviewEntry.parseInput({kind, account: {kind: "active_wallet"}, asset: operation.review.target.asset,
      ...(kind === "remove" ? {expectedRevision: operation.review.precondition.previousSelection!.revision} : {})});
    const result = reviewEntry.parseResult(input, {review: operation.review});
    const context = operationReviewContext({entry: reviewEntry, normalizedInput: input, result});
    if (context?.domain !== "token_selection") throw new Error("Token Review context required.");
    const review = renderPresentation(reviewEntry, result).node;
    const controls = renderReviewControls(context.acceptLabel, context.destructive, context.review.actionExpiresAt);
    expect(controls.accept.textContent).toBe(kind === "add" ? "Show token" : "Hide token");
    expect(review.textContent).toContain("This only changes the tokens shown for this account. It does not transfer or delete tokens.");
    expect(fields(review.querySelector("dl")).get("Token visibility")).toBe(kind === "add" ? "Hidden" : "Shown");

    const admitted = entry.parseResult(
      entry.parseInput({ operationId: operation.operationId }),
      operation,
    );
    const rendered = renderOperation(entry, admitted);

    expect(fields(rendered.node.querySelector("dl"))).toEqual(new Map<string, string>([
      ["Account", operation.result.selection.selection.account.address],
      ["Token", operation.result.selection.selection.asset.address],
      ["Completed at", operation.completedAt],
    ]));
    if (kind === "remove") expect(rendered.node.querySelector("details")).toBeNull();
    expect(rendered.node.textContent).toContain(kind === "add" ? "This request set the token to Shown for this account." : "This request set the token to Hidden for this account.");
  });
});


describe("exact text presentation", () => {
  it("preserves spaces in exact values without changing their selectable text", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve("src/interfaces/mcp-app/view/visual-tokens.css"), "utf8");
    const value = document.createElement("dd");
    value.className = "field-value";
    value.textContent = '"one  two"';
    document.head.append(style); document.body.append(value);
    try {
      expect(getComputedStyle(value).whiteSpace).toBe("pre-wrap");
      expect(value.textContent).toBe('"one  two"');
    } finally {style.remove(); value.remove();}
  });
});
