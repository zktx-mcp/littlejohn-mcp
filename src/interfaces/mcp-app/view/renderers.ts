import { presentationCopy as copy, statusCopy, connectionCopy, connectionStatusCopy, walletOperationCopy, failureCopy, failureDetailsFields, visibilityText, networkText, permissionText, tokenTextIssue, freshnessText, coverageText, addressCodeCopy, savedSignatureText, type StatusCopy, type PresentationRole } from "../../presentation-copy.js";
import { projectAccountAssetCollectionView, officialSnapshotStatusText } from "../../account-assets-presentation.js";
import { tokenReviewPresentation } from "../../token-presentation.js";
import type { ViewIssue } from "./tool-result.js";
import {
  poolPriceValueText, poolPriceFeeText, poolPriceStatusText,
  stockTokenPriceLimitations, stockTokenPriceUnavailableText,
} from "../../stock-token-price-presentation.js";
import type { ApplicationFailure } from "../../../core/client.js";
import { exchangeReviewSections, transactionRecordSections, type TransactionPresentationSection } from "../../exchange-presentation.js";
import { signingReviewFields, signingOutcomeText } from "../../signing-presentation.js";
import { walletOutcomeText } from "../../exchange-presentation.js";
import { cardErrorRegistry, type CardRecord, type CardOperationProjection } from "../card-contract.js";
import type { SigningOutcome } from "../../../review/signing-contracts.js";
import {addressInspectCapability, type AddressInspectData} from "../../../chain/read-contracts.js";
import {formatAmount} from "../../../evm/amounts.js";
import {getCapabilityDefinitionSnapshot, canonicalJsonStringify, captureCanonicalJson, type CanonicalJson, type CapabilitySuccess} from "../../../core/client.js";
import {type ContractAnalysis, type ContractControlFailureReason} from "../../../intelligence/analysis-contract.js";
import {type WalletConnectionData} from "../../../wallet/connection-contract.js";
import {walletAccountChain} from "../../../wallet/account-admission.js";
import {deriveCaip10Account, type EvmAccountIdentity} from "../../../evm/identities.js";
import type {WalletAccountSelection, WalletSelectAccountSuccess} from "../../../wallet/account-selection-contract.js";
import {
  type AccountAssetCollectionSuccess,
} from "../../../account-assets/client.js";
import {
  tokenInspectCapability,
  type TokenCatalogOperation,
  type TokenInspectionSuccess,
  type TokenSelectionDetail,
  type TokenSelectionListResult,
  type TokenSelectionReviewResult,
} from "../../../token-catalog/client.js";
import type {
  StockTokenTradeHistoryAvailableData,
  StockTokenTradeHistoryData,
} from "../../../stock-token-trade-history/result.js";
import {
  createTradeHistoryChartPresentation,
  type TradeHistoryChartMountDescription,
} from "./trade-history-chart.js";
import type {
  WalletManagementOperation,
  WalletQrMatrix,
  WalletReviewResult,
  WalletDisconnectTarget,
} from "../../../wallet/contracts.js";
import {
  presentationContractRegistry,
  presentationContracts,
  type PresentationContractEntry,
  type PresentationContractResult,
} from "../registry.js";
import {
  stockTokenTradeCoverageLimitationLabel,
  stockTokenTradeHistoryLabel,
  stockTokenTradeHistoryNoTradeLabel,
  stockTokenTradeHistoryPeriodLabel,
  stockTokenTradeHistoryRequestCutCandleWarning,
  stockTokenTradeHistoryRequestedCoverageLabel,
  stockTokenTradeHistoryUnavailableReason,
  stockTokenTradeHistoryUnavailableReasonLabel,
} from "../../stock-token-trade-history-presentation.js";

type AddressInspectionResult = CapabilitySuccess<AddressInspectData>;
type WalletConnectionResult = CapabilitySuccess<WalletConnectionData>;

const element = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[Tag] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

type EvidenceStatus = "current" | "stale" | "complete" | "partial" | "unavailable";

type SummaryField = readonly [label: string, value: string, evidenceRole?: EvidenceStatus];

interface PresentationRenderContext {
  registerTradeHistoryChart(description: TradeHistoryChartMountDescription): void;
}

const appendField = (list: HTMLDListElement, [label, value, evidenceRole]: SummaryField): void => {
  const rendered = element("dd", evidenceRole === undefined ? "field-value" : `field-value status-${evidenceRole}`);
  if ([copy.label.account, copy.label.token, copy.label.tokenAddress, copy.label.transactionHash].some(subject => subject === label) && /^0x[0-9a-f]+$/iu.test(value)) {
    const identifier = element("span", "identifier");
    identifier.tabIndex = 0;
    identifier.title = value;
    const preview = element("span", "identifier-preview", `${value.slice(0, 6)}…${value.slice(-4)}`);
    preview.setAttribute("aria-hidden", "true");
    identifier.append(preview, element("span", "identifier-full", value));
    rendered.append(identifier);
  } else rendered.textContent = value;
  list.append(element("dt", "field-label", label), rendered);
};

const summary = (fields: readonly SummaryField[]): HTMLDListElement => {
  const list = element("dl", "summary-grid");
  for (const field of fields) appendField(list, field);
  return list;
};

const exactRationalText = (value: Readonly<{
  readonly numerator: string;
  readonly denominator: string;
}>): string =>
  `${value.numerator} / ${value.denominator}`;

const coverageLabels = copy.coverage;

const contractControlFailureLabels = Object.freeze({
  deployment_unresolved: "The contract deployment is unresolved.",
  exact_abi_unavailable: "An exact ABI is unavailable.",
  source_inconsistent: "The source evidence is inconsistent.",
  call_reverted: "The control read reverted.",
  malformed_return: "The control read returned malformed data.",
} satisfies Readonly<Record<ContractControlFailureReason, string>>);

const contractProxyReasonLabels = Object.freeze({
  conflicting_supported_proxy_markers: "Supported proxy markers conflict.",
  admin_without_supported_implementation:
    "A proxy administrator was observed without a supported implementation.",
  malformed_eip1967_address_storage: "The EIP-1967 address storage is malformed.",
  beacon_implementation_reverted: "The beacon implementation read reverted.",
  malformed_beacon_implementation: "The beacon returned a malformed implementation address.",
  implementation_runtime_code_empty: "The resolved implementation has no runtime code.",
  implementation_terminality_unresolved:
    "The first-hop implementation is not terminal within the supported proxy boundary.",
} satisfies Readonly<Record<
  Extract<ContractAnalysis["proxy"], { status: "unresolved" }>["reason"],
  string
>>);

const tokenStandardStatusLabels = copy.standard;

const addressScopeLimitations = getCapabilityDefinitionSnapshot(
  addressInspectCapability,
).staticScopeExclusions.map((value) => value.message);
const tokenScopeLimitations = getCapabilityDefinitionSnapshot(
  tokenInspectCapability,
).staticScopeExclusions.map((value) => value.message);

const noticeList = (
  heading: "Warnings" | "Limitations",
  values: readonly string[],
): HTMLUListElement => {
  const list = element("ul", heading === "Warnings" ? "warning-list" : "limitation-list");
  list.setAttribute("aria-label", heading);
  for (const value of values) {
    const item = element("li", heading === "Warnings" ? "warning-item" : "limitation-item");
    item.append(
      element(
        "strong",
        "notice-label",
        heading === "Warnings" ? "Warning: " : "Limitation: ",
      ),
      document.createTextNode(value),
    );
    list.append(item);
  }
  return list;
};

const noticeSection = (
  heading: "Warnings" | "Limitations",
  values: readonly string[],
): HTMLElement | undefined => {
  if (values.length === 0) return undefined;
  const region = element("section", heading === "Warnings" ? "warning-group" : "limitation-group");
  region.append(element("h2", "section-title", heading));
  region.append(noticeList(heading, values));
  return region;
};

const appendNotices = (
  output: DocumentFragment,
  heading: "Warnings" | "Limitations",
  values: readonly string[],
): void => {
  const region = noticeSection(heading, values);
  if (region !== undefined) output.append(region);
};

const appendWarnings = (output: DocumentFragment, warnings: readonly string[]): void => {
  appendNotices(output, "Warnings", warnings);
};

const disclosure = (
  label: string,
  content: readonly HTMLElement[],
): HTMLDetailsElement => {
  const details = element("details", "disclosure");
  details.append(element("summary", "disclosure-label", label), ...content);
  return details;
};

const deferredDisclosure = (
  label: string,
  content: () => readonly HTMLElement[],
): HTMLDetailsElement => {
  const details = element("details", "disclosure");
  details.append(element("summary", "disclosure-label", label));
  const materialize = (): void => {
    if (!details.open) return;
    details.append(...content());
    details.removeEventListener("toggle", materialize);
  };
  details.addEventListener("toggle", materialize);
  return details;
};

const appendCapabilityContext = <Data>(
  output: DocumentFragment,
  result: CapabilitySuccess<Data>,
  limitations: readonly string[] = [],
): void => {
  if (result.evidence.coverage.status !== "complete") {
    output.append(summary([[
      copy.label.coverage,
      coverageLabels[result.evidence.coverage.status],
      result.evidence.coverage.status,
    ]]));
  }
  appendWarnings(output, result.warnings.map((warning) => warning.message));
  appendNotices(output, "Limitations", limitations);
};

const exactValueTable = (
  captionText: string,
  headings: readonly string[],
  rows: readonly (readonly string[])[],
): HTMLTableElement => {
  const table = element("table", "history-values");
  const caption = element("caption", "section-title", captionText);
  const head = element("thead");
  const headingRow = element("tr");
  for (const label of headings) headingRow.append(element("th", undefined, label));
  head.append(headingRow);
  const body = element("tbody");
  for (const values of rows) {
    const row = element("tr");
    for (const value of values) row.append(element("td", "exact-cell", value));
    body.append(row);
  }
  table.append(caption, head, body);
  return table;
};

const tradeHistoryCoverageMeaning = (
  coverage: StockTokenTradeHistoryAvailableData["positions"][number]["coverage"], hasCandle: boolean,
): string => coverage === "complete" ? hasCandle ? coverageText("complete", true) : copy.chart.emptyComplete
  : coverage === "partial" ? hasCandle ? copy.chart.partialCandle : copy.chart.emptyPartial : copy.chart.emptyUnavailable;

const tradeHistoryValues = (series: StockTokenTradeHistoryAvailableData): HTMLTableElement => exactValueTable(
  copy.chart.intervals,
  [copy.label.intervalStart, copy.label.intervalEnd, copy.label.displayedFrom, copy.label.displayedUntil,
    copy.label.coverage, copy.label.dataLimits, "Pool ID", `${copy.label.firstPrice} (USDG)`, `${copy.label.highestPrice} (USDG)`,
    `${copy.label.lowestPrice} (USDG)`, `${copy.label.lastPrice} (USDG)`, copy.label.usdgVolume, `${copy.label.tokenVolume} (${series.symbol})`,
    copy.label.tradeCount, copy.label.observedFrom, copy.label.observedUntil],
  series.positions.map(position => {
    const candle = position.candle;
    const absent = copy.label.notApplicable;
    return [position.naturalStart, position.naturalEnd, position.representedStart, position.representedEnd,
      coverageLabels[position.coverage], tradeHistoryCoverageMeaning(position.coverage, candle !== null), position.poolId ?? copy.label.unavailable,
      ...[candle?.open, candle?.high, candle?.low, candle?.close].map(price => price === undefined ? absent : exactRationalText(price)),
      candle === null ? absent : `${formatAmount(candle.quoteVolumeRaw, String(series.archive.root.usdgDecimals))} USDG`,
      candle === null ? absent : `${formatAmount(candle.baseVolumeRaw, String(series.tokenDecimals.value))} ${series.symbol}`,
      candle?.tradeCount ?? absent, candle?.observedStart ?? absent, candle?.observedEnd ?? absent];
  }),
);

const renderAccountAssets = (value: AccountAssetCollectionSuccess): DocumentFragment => {
  const view = projectAccountAssetCollectionView(value);
  const output = document.createDocumentFragment();
  output.append(summary([[copy.label.account, view.account.address], [copy.label.balance, view.nativeBalance]]),
    element("p", "supporting-copy", copy.scope.selectedTokens));
  for (const explanation of view.balanceExplanations) output.append(element("p", "supporting-copy", explanation));
  const list = element("ul", "item-list");
  for (const asset of view.assets) {
    const item = element("li", "item");
    item.append(element("h2", "section-title", asset.identity.label), summary([
      ...asset.quantity.fields,
      [copy.label.tokenAddress, asset.identity.address], [copy.label.officialListing, asset.classification.label],
    ]));
    for (const limitation of asset.quantity.limitations) item.append(element("p", "supporting-copy", limitation));
    for (const warning of asset.identity.warnings) item.append(element("p", "supporting-copy", warning));
    if (asset.classification.limitation !== null) item.append(element("p", "supporting-copy", asset.classification.limitation));
    if (asset.quantity.details.length > 0) item.append(disclosure(copy.label.assetDetails, asset.quantity.details.flatMap(group => [
      ...(group.title === null ? [] : [element("h3", "section-title", group.title)]), summary(group.fields),
    ])));
    list.append(item);
  }
  output.append(list);
  if (view.assets.length === 0) output.append(element("p", "supporting-copy", copy.scope.empty));
  if (view.nextCursor !== null) output.append(element("p", "supporting-copy", copy.scope.moreItems));
  output.append(disclosure(copy.label.dataSource, [summary([[copy.label.asOf, view.block.blockTimestamp], [copy.label.block, view.block.blockNumber],
    [copy.label.officialListing, officialSnapshotStatusText(view.viewRevision)]])]));
  return output;
};

const contractControlText = (
  value:
    | ContractAnalysis["controls"]["owner"]
    | ContractAnalysis["controls"]["paused"]
    | ContractAnalysis["controls"]["defaultAdmins"],
): string => {
  if (value.status === "observed") {
    if ("members" in value) return value.members.length === 0
      ? "No members observed"
      : `${value.members.length} observed`;
    return typeof value.value === "boolean" ? value.value ? "Yes" : "No" : String(value.value);
  }
  if (value.status === "not_declared") return copy.standard.not_declared;
  if (value.status === "not_enumerable") return copy.standard.not_enumerable;
  if (value.status === "limit_exceeded") return `${copy.standard.limit_exceeded} (${value.count})`;
  return `Unavailable: ${contractControlFailureLabels[value.reason]}`;
};

const contractProxyText = (proxy: ContractAnalysis["proxy"]): string => {
  if (proxy.status === "resolved") return `Resolved to ${proxy.implementation}`;
  if (proxy.status === "no_supported_proxy_observed") return "No supported proxy observed";
  return `Unresolved: ${contractProxyReasonLabels[proxy.reason]}`;
};

const renderAddressInspection = (result: AddressInspectionResult): DocumentFragment => {
  const data = result.data;
  const output = document.createDocumentFragment();
  const answer = addressCodeCopy[data.status];
  output.append(summary([[copy.label.account, data.address]]), element("h2", "section-title", answer.label), element("p", "supporting-copy", answer.message));
  if (data.status === "runtime_code_observed") {
    const analysis = data.analysis;
    const functions = analysis.declaredFunctions.status === "observed" ? analysis.declaredFunctions.signatures.join("\n")
      : `${copy.label.unavailable}: ${contractControlFailureLabels[analysis.declaredFunctions.reason]}`;
    output.append(disclosure(copy.label.contractDetails, [summary([
      [copy.label.proxy, contractProxyText(analysis.proxy)], [copy.label.declaredFunctions, functions],
      [copy.label.owner, contractControlText(analysis.controls.owner)], [copy.label.pauseStatus, contractControlText(analysis.controls.paused)],
      [copy.label.administrator, contractControlText(analysis.controls.defaultAdmins)], [copy.label.block, analysis.block.blockNumber],
    ])]));
  } else output.append(disclosure(copy.label.contractDetails, [summary([[copy.label.block, data.block.blockNumber]])]));
  appendCapabilityContext(output, result, addressScopeLimitations);
  return output;
};

const renderStockTokenTradeHistory = (
  result: CapabilitySuccess<StockTokenTradeHistoryData>,
  context: PresentationRenderContext,
): DocumentFragment => {
  const value = result.data;
  const output = document.createDocumentFragment();
  const label = stockTokenTradeHistoryLabel(value);
  output.append(summary([
    [copy.label.token, label],
    [copy.label.requestedPeriod, stockTokenTradeHistoryPeriodLabel(value.period) +
      (value.status === "available" ? `\n${value.requestedStart} to ${value.requestedEnd}` : "")],
  ]));
  output.append(element("p", "supporting-copy", copy.chart.unit));
  if (value.status === "unavailable") {
    const reason = stockTokenTradeHistoryUnavailableReason(value);
    output.append(summary([
      [copy.label.status, copy.label.unavailable, "unavailable"],
      ["Reason", stockTokenTradeHistoryUnavailableReasonLabel(reason)],
      ...("archive" in value
        ? [
            [
              copy.label.freshness,
              value.freshness === "unknown"
                ? "Unknown"
                : value.freshness === "current" ? "Current" : "Stale",
              value.freshness === "unknown" ? "unavailable" : value.freshness,
            ] as SummaryField,
            ...(value.archive.scope === "catalog_root"
              ? []
              : [[copy.label.publishedThrough, value.archive.root.currentUntil.timestamp] as SummaryField]),
          ]
        : []),
    ]));
    if ("archive" in value) {
      output.append(element("p", "supporting-copy", freshnessText(value.freshness, result.meta.evaluatedAt)));
      output.append(disclosure(copy.label.dataSource, [summary([[copy.label.dataLimits, value.archive.scope]])]));
    }
    if ("officialAsset" in value) {
      output.append(disclosure(copy.label.assetDetails, [summary([
        [copy.label.tokenAddress, value.officialAsset.member.contractAddress],
      ])]));
    }
    return output;
  }

  output.append(summary([
        [copy.label.freshness, value.freshness === "current" ? "Current" : "Stale", value.freshness],
    [copy.label.publishedThrough, value.archive.root.currentUntil.timestamp],
    [copy.label.coverage, value.coverage.status === "complete" ? "Complete" : "Partial", value.coverage.status],
    [copy.label.availablePeriod, stockTokenTradeHistoryRequestedCoverageLabel(value)],
  ]));
  if (value.coverage.limitations.length > 0) {
    output.append(noticeList(
      "Limitations",
      value.coverage.limitations.map(stockTokenTradeCoverageLimitationLabel),
    ));
  }
  const noTrade = stockTokenTradeHistoryNoTradeLabel(value);
  if (noTrade !== undefined) output.append(element("p", "supporting-copy", noTrade));
  const requestCutWarning = stockTokenTradeHistoryRequestCutCandleWarning(value);
  if (requestCutWarning !== undefined) {
    output.append(noticeList("Warnings", [requestCutWarning]));
  }

  output.append(element("p", "supporting-copy", freshnessText(value.freshness, result.meta.evaluatedAt)),
    element("p", "supporting-copy", coverageText(value.coverage.status, true)));

  const chart = createTradeHistoryChartPresentation(
    value,
    `${label} · ${copy.chart.unit}`,
  );
  context.registerTradeHistoryChart(chart.mount);
  output.append(chart.node);
  output.append(disclosure(copy.label.assetDetails, [summary([
    [copy.label.tokenAddress, value.officialAsset.member.contractAddress],
    ["USDG contract", value.archive.root.usdgAddress],
    ["Uniswap V4 PoolManager", value.archive.root.poolManager],
    ["Uniswap V4 Pool IDs", Object.keys(value.archive.pools).join(", ")],
  ])]));
  output.append(deferredDisclosure(copy.label.chartData, () => [tradeHistoryValues(value)]));
  const sources = new Map<string, SummaryField>();
  for (const source of result.evidence.sources) {
    const identity = canonicalJsonStringify(captureCanonicalJson({owner: source.owner, sourceClass: source.sourceClass, reference: source.reference}));
    if (!sources.has(identity)) sources.set(identity, [copy.label.source,
      `${source.owner} · ${source.reference.kind === "public" ? source.reference.uri : source.reference.kind === "configured_rpc" ? source.reference.publicOrigin : source.reference.sourceId}`]);
  }
  output.append(disclosure(copy.label.dataSource, [summary([[copy.label.asOf, result.meta.evaluatedAt], [copy.label.block, value.block.blockNumber],
    ...sources.values()])]));
  return output;
};
const renderTokenInspection = (result: TokenInspectionSuccess): DocumentFragment => {
  const value = result.data;
  const output = document.createDocumentFragment();
  const unit = value.totalSupply.decimals;
  const symbol = value.metadata.symbol.status === "available" ? value.metadata.symbol.value : "";
  const supply = unit.status === "available" ? formatAmount(value.totalSupply.raw, unit.value) : value.totalSupply.raw === "0" ? "0" : undefined;
  output.append(summary([[copy.label.tokenAddress, value.asset.address],
    [copy.label.name, value.metadata.name.status === "available" ? value.metadata.name.value : copy.label.unavailable],
    [copy.label.symbol, symbol || copy.label.unavailable],
    [copy.label.totalSupply, supply === undefined ? copy.label.amountUnavailable : `${supply}${symbol === "" ? "" : ` ${symbol}`}`]]));
  for (const field of ["name", "symbol"] as const) { const text = value.metadata[field]; if (text.status === "unavailable") output.append(element("p", "supporting-copy", tokenTextIssue(field, text.reason))); }
  if (supply === undefined) output.append(element("p", "supporting-copy", copy.scope.amountUnavailable));
  output.append(disclosure(copy.label.assetDetails, [summary([
    ...(supply === undefined ? [[copy.label.rawAmount, value.totalSupply.raw] as SummaryField] : []),
    ["Standards", value.standards.standards.map(entry => `${entry.standardId}: ${tokenStandardStatusLabels[entry.status]}`).join(", ")],
    [copy.label.block, value.analysis.block.blockNumber],
  ])]));
  appendCapabilityContext(output, result, tokenScopeLimitations);
  return output;
};

const selectionFields = (selection: TokenSelectionDetail["selection"]): readonly SummaryField[] => [
  [copy.label.account, selection.account.address], [copy.label.token, selection.asset.address],
  [copy.title.tokenVisibility, visibilityText(selection.included)],
];
const renderTokenSelection = (value: TokenSelectionDetail): DocumentFragment => {
  const output = document.createDocumentFragment(); output.append(summary(selectionFields(value.selection)), element("p", "supporting-copy", copy.scope.tokenVisibility)); return output;
};
const renderTokenSelections = (value: TokenSelectionListResult): DocumentFragment => {
  const output = document.createDocumentFragment();
  if (value.selections[0] !== undefined) output.append(summary([[copy.label.account, value.selections[0].account.address]]));
  const list = element("ul", "item-list");
  for (const selection of value.selections) list.append(element("li", "item", `${selection.asset.address} · ${visibilityText(selection.included)}`));
  output.append(list, element("p", "supporting-copy", value.selections.length === 0 ? copy.scope.empty : copy.scope.tokenVisibility));
  if (value.nextCursor !== null) output.append(element("p", "supporting-copy", copy.scope.moreItems));
  return output;
};

const renderWalletNamespaces = (connection: Extract<WalletConnectionData, {status: "connected"}>): DocumentFragment => {
  const output = document.createDocumentFragment();
  for (const namespace of connection.namespaces) {
    const region = element("section", "result-section");
    const known = namespace.methods.filter(method => Object.hasOwn(copy.permission, method));
    const other = namespace.methods.filter(method => !Object.hasOwn(copy.permission, method));
    if (known.length > 0) region.append(summary([[copy.label.approvedPermissions, known.map(permissionText).join(", ")]]));
    if (other.length > 0) region.append(disclosure(copy.label.connectionDetails, [summary([[copy.label.otherPermissions, other.join(", ")]])]));
    for (const account of namespace.accounts) region.append(summary([[copy.label.account, account], [copy.label.network, networkText(walletAccountChain(account))]]));
    if (namespace.accounts.length === 0) region.append(element("p", "supporting-copy", copy.scope.empty));
    output.append(region);
  }
  return output;
};

const renderWalletConnection = (result: WalletConnectionResult): DocumentFragment => {
  const value = result.data;
  const status = connectionStatusCopy(value);
  const output = document.createDocumentFragment();
  output.append(renderStatus(status), summary([[copy.label.asOf, result.meta.evaluatedAt]]));
  if (value.status === "unresolved" && BigInt(value.sessionCount) > 1n) output.append(element("p", "supporting-copy", copy.scope.multipleConnections));
  if (value.status === "connected") output.append(renderWalletNamespaces(value), disclosure(copy.label.connectionDetails, [summary([[copy.label.availableUntil, value.expiresAt]])]));
  appendCapabilityContext(output, result);
  return output;
};

const renderWalletReview = (value: WalletReviewResult): DocumentFragment => {
  const output = document.createDocumentFragment();
  if (value.status === "current_connection") { output.append(renderStatus(connectionCopy.connected)); return output; }
  if (value.status === "already_disconnected") { output.append(renderStatus(value.reason === "expired" ? connectionCopy.expired : connectionCopy.disconnected)); return output; }
  const review = value.review;
  output.append(summary([[copy.label.network, networkText(review.target.chainId)]]));
  if (review.kind === "connect") {
    output.append(element("h2", "section-title", copy.label.requestedPermissions), summary([
      [copy.label.required, review.decision.requiredMethods.map(permissionText).join(", ")],
      [copy.label.optional, review.decision.optionalMethods.map(permissionText).join(", ")],
    ]), element("p", "supporting-copy", copy.scope.connect), disclosure(copy.label.connectionDetails, [summary([
      [copy.label.network, review.target.chainId], [copy.label.required, [...review.decision.requiredMethods, ...review.decision.requiredEvents].join(", ")],
      [copy.label.optional, review.decision.optionalMethods.join(", ")],
    ])]));
  }
  return output;
};

export const renderWalletDisconnectTargets = (targets: readonly WalletDisconnectTarget[]): HTMLElement => {
  const region = element("section", "wallet-disconnect-targets");
  region.append(element("p", "supporting-copy", copy.scope.disconnect));
  for (const target of targets) {
    const session = element("section", "result-section");
    // The exact identifier is necessary to distinguish disconnection targets.
    session.append(summary([[copy.label.wallet, target.sourceId]]));
    if (target.status === "available") session.append(renderWalletNamespaces(target.connection));
    else session.append(element("p", "supporting-copy", copy.label.unavailable), disclosure(copy.label.connectionDetails, [summary([[copy.label.reportedReason, target.reason]])]));
    region.append(session);
  }
  return region;
};

const renderWalletAccountSelection = (selection: WalletAccountSelection): DocumentFragment => {
  const output = document.createDocumentFragment();
  output.append(summary([[copy.label.network, networkText(selection.chainId)]]), element("p", "supporting-copy", copy.scope.accountSelection));
  return output;
};

export const renderReadOnlyAccountSelection = (selection: WalletAccountSelection): HTMLElement => {
  const region = element("div", "account-context");
  region.append(summary([[copy.label.account, selection.account?.address ?? copy.label.noAccount]]));
  const accounts = element("ul", "item-list");
  accounts.setAttribute("aria-label", copy.label.accountToUse);
  for (const account of selection.eligibleAccounts) accounts.append(element("li", "item", account.address));
  region.append(accounts);
  return region;
};

const renderTokenSelectionReview = (value: TokenSelectionReviewResult): DocumentFragment => {
  const view = tokenReviewPresentation(value.review);
  const output = document.createDocumentFragment();
  output.append(summary(view.targetFields), element("p", "supporting-copy", view.effect));
  for (const limitation of view.metadataLimitations) output.append(element("p", "supporting-copy", limitation));
  if (view.metadataFields.length > 0) output.append(summary(view.metadataFields));
  if (view.classificationLimitation !== null) output.append(element("p", "supporting-copy", view.classificationLimitation));
  appendWarnings(output, view.warnings);
  return output;
};

const renderFailureDetails = (error: Pick<ApplicationFailure["error"], "code" | "message"> & Partial<Pick<ApplicationFailure["error"], "issues">>): HTMLElement =>
  disclosure(copy.label.errorDetails, [summary(failureDetailsFields(error))]);

const renderWalletOperationValue = (value: Readonly<{
  state: WalletManagementOperation["state"]; action: "connect" | "disconnect";
  deadline: string; account?: EvmAccountIdentity; network?: string;
  failure?: Pick<ApplicationFailure["error"], "code" | "category" | "message">;
}>): HTMLElement => {
  const result = renderStatus(value.failure === undefined ? walletOperationCopy(value.state, value.action) : failureCopy(value.failure));
  const fields: SummaryField[] = [];
  if (value.account !== undefined) fields.push([copy.label.account, value.account.address]);
  if (value.network !== undefined) fields.push([copy.label.network, networkText(value.network)]);
  if (["starting_connection", "awaiting_wallet_approval", "validating_session", "cancelling", "disconnecting"].includes(value.state)) fields.push([copy.label.availableUntil, value.deadline]);
  if (fields.length > 0) result.append(summary(fields));
  if (value.failure !== undefined) result.append(renderFailureDetails(value.failure));
  return result;
};
const renderWalletOperation = (operation: WalletManagementOperation): DocumentFragment => {
  const output = document.createDocumentFragment();
  output.append(renderWalletOperationValue({state: operation.state, action: operation.kind, deadline: operation.review.actionExpiresAt,
    network: operation.review.target.chainId, ...(operation.state === "failed" ? {failure: operation.failure.error} : {})}));
  return output;
};
const renderTokenResult = (value: Readonly<{action: "add" | "remove"; account: EvmAccountIdentity; token: string; included: boolean; completedAt: string}>): HTMLElement => {
  const output = renderStatus(value.action === "add" ? statusCopy.shown : statusCopy.hidden);
  output.append(summary([[copy.label.account, value.account.address], [copy.label.token, value.token],
    [copy.label.completedAt, value.completedAt]]));
  return output;
};
const renderTokenSelectionOperation = (operation: TokenCatalogOperation): DocumentFragment => {
  const selection = operation.result.selection.selection;
  const output = document.createDocumentFragment();
  output.append(renderTokenResult({action: operation.kind, account: selection.account, token: selection.asset.address, included: selection.included, completedAt: operation.completedAt}));
  return output;
};

interface PresentationRendererBinding {
  readonly entry: PresentationContractEntry;
  render(value: CanonicalJson, context: PresentationRenderContext): DocumentFragment;
}

const bindRenderer = <Entry extends PresentationContractEntry>(
  entry: Entry,
  renderer: (
    value: PresentationContractResult<Entry>,
    context: PresentationRenderContext,
  ) => DocumentFragment,
): PresentationRendererBinding => Object.freeze({
  entry,
  render: (value: CanonicalJson, context: PresentationRenderContext) =>
    renderer(value as PresentationContractResult<Entry>, context),
});

export const renderTransactionSections = (sections: readonly TransactionPresentationSection[], individual = true): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  for (const section of sections) {
    const content = section.lines.map(line => element("p", "status-copy", line));
    const fields = section.fields === undefined ? [] : [summary(section.fields)];
    if (section.pendingQuery === true && individual) content.push(element("p", "supporting-copy", copy.scope.pendingQuery));
    if (section.details === true) fragment.append(disclosure(section.title, [...content, ...fields]));
    else {
      const group = element("section", section.role === undefined ? "result-section" : `result-section status-${section.role}`);
      group.append(element("h2", "section-title", section.title), ...content, ...fields);
      fragment.append(group);
    }
  }
  return fragment;
};

const renderStockTokenPrices = (result: PresentationContractResult<typeof presentationContracts.stockTokenPrices>): DocumentFragment => {
  const output = document.createDocumentFragment();
  const value = result.data;
  if (value.status !== "available") {
    output.append(element("p", "status-copy status-unavailable", stockTokenPriceUnavailableText(value)));
    if (value.status === "selection_unavailable") for (const member of value.candidates) {
      output.append(summary([[copy.label.symbol, member.sourceSymbol ?? copy.label.unavailable], [copy.label.tokenAddress, member.contractAddress]]));
    }
    return output;
  }
  output.append(summary([
    [copy.label.token, value.member.sourceSymbol ?? value.member.contractAddress],
    [copy.label.priceUnit, "USDG per Stock Token"], [copy.label.block, value.block.blockNumber],
    [copy.label.asOf, value.block.blockTimestamp], [copy.label.source, value.source.sourceOwner],
      ]));
  appendNotices(output, "Limitations", stockTokenPriceLimitations);
  if (value.pools.length === 0) output.append(element("p", "status-copy", copy.scope.empty));
  for (const row of value.pools) {
    const section = element("section", "result-section");
    section.append(element("h2", "section-title", row.candidate.protocol ?? row.candidate.sourceDexId));
    section.append(summary([
      [copy.label.price, poolPriceValueText(row)], [copy.label.status, poolPriceStatusText(row)],
      [copy.label.poolFee, poolPriceFeeText(row)], ["Pool", row.candidate.poolId],
    ]));
    if (row.status === "verified") {
      if (row.state.protocol === "uniswap_v4" && row.state.dynamicFee) {
        section.append(element("p", "status-copy", copy.scope.dynamicFee));
      }
      section.append(disclosure(copy.label.priceDetails, [summary([["USDG per Stock Token", exactRationalText(row.price)]])]));
    }
    output.append(section);
  }
  return output;
};
const renderStockTokens = (result: PresentationContractResult<typeof presentationContracts.stockTokens>): DocumentFragment => {
  const output = document.createDocumentFragment();
  output.append(element("p", "status-copy", copy.scope.officialListing));
  output.append(summary([[copy.label.asOf, result.data.snapshot.sourceObservedAt]]));
  for (const member of result.data.members) {
    const section = element("section", "result-section");
    section.append(element("h2", "section-title", member.sourceSymbol ?? "Symbol unavailable"));
    section.append(summary([[copy.label.name, member.sourceName ?? copy.label.unavailable], [copy.label.tokenAddress, member.contractAddress]]));
    output.append(section);
  }
  return output;
};

const rendererBindings = Object.freeze([
  bindRenderer(presentationContracts.stockTokenPrices, renderStockTokenPrices),
  bindRenderer(presentationContracts.stockTokens, renderStockTokens),
  bindRenderer(presentationContracts.transactionReview, (review) => renderTransactionSections(exchangeReviewSections(review))),
  bindRenderer(presentationContracts.signingReview, (review) => {
    const fragment = document.createDocumentFragment();
    fragment.append(summary(signingReviewFields(review)));
    return fragment;
  }),
  bindRenderer(presentationContracts.activityTransaction, (record) => renderTransactionSections(transactionRecordSections(record))),
  bindRenderer(presentationContracts.activityTransactions, (page) => renderTransactionSections(page.records.length === 0 ?
    [{ title: copy.title.transactions, lines: [copy.scope.empty, copy.scope.history] }] : page.records.flatMap(transactionRecordSections), false)),
  bindRenderer(presentationContracts.accountAssets, renderAccountAssets),
  bindRenderer(presentationContracts.addressInspection, renderAddressInspection),
  bindRenderer(presentationContracts.stockTokenTradeHistory, renderStockTokenTradeHistory),
  bindRenderer(presentationContracts.tokenAnalysis, renderTokenInspection),
  bindRenderer(presentationContracts.tokenSelection, renderTokenSelection),
  bindRenderer(presentationContracts.tokenSelectionOperation, renderTokenSelectionOperation),
  bindRenderer(presentationContracts.tokenSelectionReview, renderTokenSelectionReview),
  bindRenderer(presentationContracts.tokenSelections, renderTokenSelections),
  bindRenderer(presentationContracts.walletConnection, renderWalletConnection),
  bindRenderer(presentationContracts.walletOperation, renderWalletOperation),
  bindRenderer(presentationContracts.walletReview, renderWalletReview),
  bindRenderer(presentationContracts.walletSelection, renderWalletAccountSelection),
]);

const renderByEntry = new Map<PresentationContractEntry, PresentationRendererBinding["render"]>();
for (const binding of rendererBindings) {
  if (renderByEntry.has(binding.entry)) throw new TypeError("Presentation renderer is duplicated.");
  renderByEntry.set(binding.entry, binding.render);
}
if (
  renderByEntry.size !== presentationContractRegistry.values().length ||
  presentationContractRegistry.values().some((entry) => !renderByEntry.has(entry))
) throw new TypeError("Presentation renderer registry coverage is incomplete.");

const operationRegion = (content: Node): HTMLElement => {
  const region = element("section", "operation-region");
  region.setAttribute("aria-live", "polite");
  region.append(content);
  return region;
};

export const replaceOperationRegion = (article: HTMLElement, content: Node): void => {
  const current = article.querySelector<HTMLElement>(".operation-region");
  if (current === null) throw new TypeError("Review operation region is unavailable.");
  current.replaceWith(operationRegion(content));
};

export interface RenderedReviewControls {
  readonly node: HTMLElement;
  readonly accept: HTMLButtonElement;
  readonly dismiss: HTMLButtonElement;
}

export const renderReviewControls = (
  acceptLabel: string,
  destructive: boolean,
  actionExpiresAt: string | null,
): RenderedReviewControls => {
  const group = element("div", "decision-group");
  group.append(renderStatus(statusCopy.decision));
  if (actionExpiresAt !== null) group.append(element("p", "deadline-copy", `Available until ${actionExpiresAt}`));
  const controls = element("div", "action-row");
  const accept = element("button", destructive ? "action destructive" : "action primary", acceptLabel);
  accept.type = "button";
  const dismiss = element("button", "action secondary", copy.action.closeRequest);
  dismiss.type = "button";
  controls.append(accept, dismiss);
  group.append(controls);
  return Object.freeze({ node: group, accept, dismiss });
};

export const renderWalletAccountControls = (
  initial: WalletAccountSelection, current: WalletAccountSelection, actionExpiresAt: string | null,
): RenderedReviewControls & Readonly<{selectedAccount(): EvmAccountIdentity | undefined}> => {
  const controls = renderReviewControls(copy.action.selectAccount, false, actionExpiresAt);
  const label = element("label", "field-label", copy.label.accountToUse);
  const select = element("select", "field-value");
  label.append(select);
  const placeholder = element("option", undefined, copy.action.chooseAccount); placeholder.value = "";
  select.append(placeholder);
  for (const account of initial.eligibleAccounts) {
    const option = element("option", undefined, account.address); option.value = deriveCaip10Account(account); select.append(option);
  }
  const notice = element("p", "status-copy", `${copy.label.currentAccount}: ${current.account?.address ?? copy.label.noAccount}`);
  controls.node.insertBefore(notice, controls.node.querySelector(".action-row"));
  controls.node.insertBefore(label, controls.node.querySelector(".action-row"));
  controls.accept.disabled = true;
  select.addEventListener("change", () => { controls.accept.disabled = select.value === ""; });
  return {...controls, selectedAccount: () => initial.eligibleAccounts.find((account) => deriveCaip10Account(account) === select.value)};
};

export const renderWalletSelectedAccount = (value: WalletSelectAccountSuccess): HTMLElement => {
  const result = renderStatus(statusCopy.accountSelected);
  result.append(summary([[copy.label.account, value.account.address], [copy.label.network, networkText(value.chainId)]]));
  return result;
};

export const renderOperationMessage = (
  title: string,
  message: string,
  status: PresentationRole = "pending",
): HTMLElement => {
  const region = element("div", `operation-message status-${status}`);
  region.append(
    element("h2", "section-title", title),
    element("p", "status-copy", message),
  );
  return region;
};

type StatusPlacement = "page" | "inline";
export const renderStatus = (value: StatusCopy, placement: StatusPlacement = "inline"): HTMLElement => {
  if (placement === "inline") return renderOperationMessage(value.label, value.message, value.role);
  const article = element("article", `card status-${value.role}`);
  article.setAttribute("role", value.role === "error" ? "alert" : "status");
  article.append(element("h1", "title", value.label), element("p", "status-copy", value.message));
  return article;
};

// Only confirmed outcomes move the immutable original facts into this disclosure.
// These DOM facts are never read back as decision or result authority.
export const presentTerminalResult = (article: HTMLElement, content: Node): void => {
  const facts = article.querySelector<HTMLElement>(":scope > .request-facts");
  replaceOperationRegion(article, content);
  if (facts !== null) {
    const details = disclosure(copy.label.yourRequest, [facts]);
    article.append(details);
  }
};

export const renderReadFailure = (
  context: "opening" | "saved_state" | "details", issue: ViewIssue | undefined, placement: StatusPlacement = "inline",
): HTMLElement => {
  if (issue?.kind === "operation_delivery" || context === "opening" && issue !== undefined) return renderViewIssue(issue, placement);
  const region = renderStatus(context === "details" ? statusCopy.detailsUnavailable
    : context === "saved_state" ? statusCopy.savedReadFailed : statusCopy.presentationUnavailable, placement);
  region.setAttribute("role", "alert");
  if (issue?.kind === "application") region.append(renderFailureDetails(issue.failure.error));
  return region;
};

const renderQr = (matrix: WalletQrMatrix): HTMLElement => {
  const region = element("section", "qr-region");
  region.append(
    element("h3", "section-title", statusCopy.awaiting_wallet_approval.label),
    element("p", "qr-instruction", copy.scope.scan),
  );
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "qr-matrix");
  svg.setAttribute("viewBox", `-4 -4 ${matrix.size + 8} ${matrix.size + 8}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Active WalletConnect pairing code");
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("class", "qr-background");
  background.setAttribute("x", "-4");
  background.setAttribute("y", "-4");
  background.setAttribute("width", String(matrix.size + 8));
  background.setAttribute("height", String(matrix.size + 8));
  svg.append(background);
  for (const [rowIndex, row] of matrix.rows.entries()) {
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      if (row[columnIndex] !== "1") continue;
      const module = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      module.setAttribute("class", "qr-module");
      module.setAttribute("x", String(columnIndex));
      module.setAttribute("y", String(rowIndex));
      module.setAttribute("width", "1");
      module.setAttribute("height", "1");
      svg.append(module);
    }
  }
  region.append(svg);
  return region;
};

export interface RenderedOperation {
  readonly node: HTMLElement;
  readonly cancel?: HTMLButtonElement;
}

export const renderOperation = (
  entry: PresentationContractEntry,
  result: CanonicalJson,
  options: Readonly<{ qr?: WalletQrMatrix; cancellable?: boolean }> = {},
): RenderedOperation => {
  if (entry.presentationKind !== "operation") {
    throw new TypeError("Presentation entry is not an operation.");
  }
  const renderer = renderByEntry.get(entry);
  if (renderer === undefined) throw new TypeError("Operation renderer is not registered.");
  const region = element("div", "operation-result");
  region.append(renderer(result, {
    registerTradeHistoryChart: () => {
      throw new TypeError("An operation cannot register a trade-history chart.");
    },
  }));
  if (options.qr !== undefined) {
    region.append(renderQr(options.qr));
  }
  if (options.cancellable !== true) return Object.freeze({ node: region });
  const cancel = element("button", "action secondary", copy.action.cancelConnection);
  cancel.type = "button";
  region.append(cancel);
  return Object.freeze({ node: region, cancel });
};

export interface RenderedPresentation {
  readonly node: HTMLElement;
  readonly tradeHistoryChart: TradeHistoryChartMountDescription | null;
}

export const renderSigningResult = (outcome: SigningOutcome, signature: string) => {
  const node = element("div", "operation-result");
  node.append(element("h2", "section-title status-completed", statusCopy.verified.label), element("p", "status-copy", signingOutcomeText(outcome)));
  node.append(element("p", "field-label", copy.label.signature), element("p", "field-value", signature),
    element("p", "field-label", copy.scope.manualCopy),
    element("p", "status-copy", copy.scope.signing));
  const dismiss = element("button", "action secondary", copy.action.closeSignature); dismiss.type = "button";
  node.append(dismiss);
  return { node, dismiss };
};

export const renderPresentation = (
  entry: PresentationContractEntry,
  result: CanonicalJson,
): RenderedPresentation => {
  if (entry.presentationKind === "operation") {
    throw new TypeError("An operation cannot create a top-level presentation.");
  }
  const article = element("article", "card");
  const header = element("header", "card-header");
  const title = entry === presentationContracts.transactionReview
    ? (() => { const review = result as unknown as import("../../../review/contracts.js").ExchangeReview;
      return review.state !== "ready_for_wallet_review" ? copy.title.transaction
        : "replacement" in review.observation.data || review.observation.data.predecessor !== undefined ? copy.title.replacement
          : review.expectedEffect.kind === "swap" ? copy.title.transaction : copy.title.approval; })()
    : entry.title;
  header.append(element("h1", "title", title));
  const renderer = renderByEntry.get(entry);
  if (renderer === undefined) throw new TypeError("Presentation renderer is not registered.");
  let tradeHistoryChart: TradeHistoryChartMountDescription | null = null;
  const facts = element("div", entry.cardKind === undefined ? "result-facts" : "request-facts");
  facts.append(renderer(result, {
    registerTradeHistoryChart: (description) => {
      if (tradeHistoryChart !== null) {
        throw new TypeError("A presentation cannot register more than one trade-history chart.");
      }
      tradeHistoryChart = description;
    },
  }));
  article.append(header, facts);
  if (entry.cardKind !== undefined) article.append(operationRegion(renderStatus(statusCopy.loading)));
  return Object.freeze({ node: article, tradeHistoryChart });
};

export const renderCardStateMessage = (record: CardRecord): HTMLElement => {
  if (record.kind === "preparing") return renderStatus(record.creationState === "creating" ? statusCopy.loading : statusCopy.owner_lost);
  if (record.kind === "read") {
    if (record.preparationState === "pending") return renderStatus(statusCopy.loading);
    if (record.outcome?.kind === "failure") return renderSavedFailure(record.outcome.failureCode);
    return renderOperationMessage(statusCopy.presentationUnavailable.label, statusCopy.savedReadFailed.message, "unavailable");
  }
  const outcome = record.outcome;
  if (outcome === null) {
    if (record.inputState === "input_pending") return renderStatus(statusCopy.notSubmitted);
    if (record.closeReason === "submitted") return renderStatus(statusCopy.checkingResult);
    return renderStatus(statusCopy[record.closeReason!]);
  }
  if (outcome.kind === "signing") {
    const state = outcome.status === "wallet_rejected" ? statusCopy.rejected : statusCopy[outcome.status];
    const node = renderStatus(state); node.append(element("p", "supporting-copy", savedSignatureText)); return node;
  }
  if (outcome.kind === "transaction") return renderStatus(outcome.result.status === "wallet_rejected" ? statusCopy.rejected : statusCopy[outcome.result.status]);
  if (outcome.kind === "failure" || outcome.kind === "review") return renderSavedFailure(outcome.failureCode);
  if (outcome.kind === "delivery") return renderStatus(statusCopy.actionUnknown);
  if (outcome.kind === "operation") return renderStatus(statusCopy.ended);
  return renderWalletSelectedAccount(outcome.value);
};
const renderSavedFailure = (code: string): HTMLElement => {
  const error = cardErrorRegistry.get(code);
  const node = renderStatus(failureCopy(error)); node.append(renderFailureDetails(error)); return node;
};

export const presentCardState = (article: HTMLElement, record: CardRecord): void => {
  replaceOperationRegion(article, renderCardStateMessage(record));
  if (record.kind === "read" || record.kind === "preparing" || record.inputState !== "input_closed") return;
  const facts = article.querySelector<HTMLElement>(":scope > .request-facts");
  const region = article.querySelector<HTMLElement>(":scope > .operation-region");
  if (facts !== null && region !== null) article.insertBefore(region, facts);
};

export const renderSavedCard = (record: CardRecord): HTMLElement => {
  const article = element("article", "card");
  const header = element("header", "card-header");
  header.append(element("h1", "title", record.kind === "preparing" ? statusCopy.loading.label : record.kind === "read"
    ? presentationContractRegistry.requireIdentity(record.contractId, record.contractVersion).title : presentationContractRegistry.requireCardKind(record.kind).title));
  article.append(header);
  if (record.kind === "wallet_selection" && record.outcome?.kind !== "wallet_selection") article.append(summary([[copy.label.network, networkText(record.context.chainId)]]));
  else if (record.kind === "signing" || record.kind === "transaction") {
    const account = record.context.account;
    const fields: SummaryField[] = [];
    if (account !== null) fields.push([copy.label.account, account.address], [copy.label.network, networkText(account.chainId)]);
    if (record.kind === "signing") fields.push([copy.label.signingMethod, copy.method[record.context.method]]);
    article.append(summary(fields));
  }
  article.append(operationRegion(renderCardStateMessage(record)));
  return article;
};

export const renderCardOperation = (value: CardOperationProjection, qr?: WalletQrMatrix): HTMLElement => {
  const node = value.kind === "wallet" ? renderWalletOperationValue({state: value.state, action: value.action, deadline: value.actionExpiresAt,
    ...(value.account === null ? {} : {account: value.account, network: value.account.chainId}),
    ...(value.failureCode === null ? {} : {failure: cardErrorRegistry.get(value.failureCode)})})
    : renderTokenResult({action: value.action, account: value.account, token: value.asset.address, included: value.included, completedAt: value.completedAt});
  if (qr !== undefined) node.append(renderQr(qr));
  return node;
};

export const renderViewIssue = (issue: ViewIssue, placement: StatusPlacement = "inline"): HTMLElement => {
  if (issue.kind === "application") return renderApplicationFailure(issue.failure, placement);
  if (issue.kind === "operation_delivery") return renderStatus(statusCopy.actionUnknown, placement);
  return renderPresentationFailure(placement);
};

export const renderApplicationFailure = (failure: ApplicationFailure, placement: StatusPlacement = "page"): HTMLElement => {
  const region = renderStatus(failureCopy(failure.error), placement);
  region.setAttribute("role", "alert");
  region.append(renderFailureDetails(failure.error));
  return region;
};
export const renderPresentationFailure = (placement: StatusPlacement = "page"): HTMLElement => {
  const region = renderStatus(statusCopy.presentationUnavailable, placement);
  region.setAttribute("role", "alert");
  return region;
};
export const renderPresentationPending = (): HTMLElement => renderStatus(statusCopy.loading, "page");
