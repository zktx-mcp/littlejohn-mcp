import { exchangeReviewSections, transactionRecordSections, type TransactionPresentationSection } from "../../exchange-presentation.js";
import { signingReviewFields, signingOutcomeText } from "../../signing-presentation.js";
import type { SigningOutcome } from "../../../review/signing-contracts.js";
import {
  addressInspectCapability,
  formatAmount,
  getCapabilityDefinitionSnapshot,
  type CanonicalJson,
  type CapabilitySuccess,
  type ContractAnalysis,
  type ContractControlFailureReason,
  type AddressInspectData,
  type WalletConnectionData,
} from "../../../core/client.js";
import {
  officialSnapshotStatusText,
  projectAccountAssetCollectionView,
  tokenOptionalTextUnavailableReasonLabel,
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
  stockTokenTradeHistoryResolutionLabel,
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
  list.append(
    element("dt", "field-label", label),
    element(
      "dd",
      evidenceRole === undefined ? "field-value" : `field-value status-${evidenceRole}`,
      value,
    ),
  );
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

const coverageLabels = Object.freeze({
  complete: "Complete",
  partial: "Partial",
  unavailable: "Unavailable",
} as const);

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

const walletStatusLabels = Object.freeze({
  unknown: "Unknown",
  disconnected: "Disconnected",
  unresolved: "Unresolved",
  connected: "Connected",
} satisfies Readonly<Record<WalletConnectionData["status"], string>>);

const walletReasonLabels = Object.freeze({
  reconciling: "Wallet session state is being reconciled.",
  observation_unavailable: "Wallet session observation is unavailable.",
  no_session: "No wallet session is connected.",
  expired: "The wallet session expired.",
  disconnected: "The wallet session was disconnected.",
} as const);

const walletOperationStateLabels = Object.freeze({
  starting_connection: "Starting connection",
  awaiting_wallet_approval: "Waiting for approval in the external wallet",
  validating_session: "Validating the approved wallet session",
  cancelling: "Cancelling the connection attempt",
  disconnecting: "Disconnecting the wallet session",
  completed: "Completed",
  cancelled: "Cancelled",
  rejected: "Rejected by the external wallet",
  expired: "Expired",
  failed: "Failed",
} as const);

const decisionProvenanceLabels = Object.freeze({
  cli: "CLI",
  mcp_app: "MCP App",
} as const);

const tokenReviewWarningLabels = Object.freeze({
  decimals_unavailable: "Token decimals were unavailable during the fixed inspection.",
  partial_result: "The fixed token inspection was partial.",
} as const);

const tokenStandardStatusLabels = Object.freeze({
  observed: "Observed",
  supported: "Supported",
  not_supported: "Not supported",
  unknown: "Unknown",
  inconsistent: "Inconsistent",
} satisfies Readonly<Record<
  TokenInspectionSuccess["data"]["standards"]["standards"][number]["status"],
  string
>>);

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
      "Coverage",
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
  coverage: StockTokenTradeHistoryAvailableData["positions"][number]["coverage"],
  hasCandle: boolean,
): string => {
  if (coverage === "complete") return hasCandle
    ? "Complete admitted source coverage."
    : "Complete admitted natural-interval coverage and exact resolution member; no qualifying Swap occurred.";
  if (coverage === "partial") return hasCandle
    ? "Partial request position with an unchanged full stored natural-interval candle; activity may lie outside represented request bounds."
    : "Partial admitted coverage; trade absence is not established.";
  return "Source coverage is unavailable; trade absence is not established.";
};

const tradeHistoryAggregationMeaning = (
  position: StockTokenTradeHistoryAvailableData["positions"][number],
): string => {
  if (position.candle !== null) return position.coverage === "partial"
    ? "The complete stored aggregate is retained without clipping to represented request bounds."
    : "OHLC, USDG volume, Stock Token volume, and trade count use the same admitted Swap set.";
  if (position.coverage === "complete") {
    return "The exact resolution member was admitted and contained no aggregate for this eligible natural interval.";
  }
  return "No absence claim is made because complete aggregate eligibility was not established.";
};

const tradeHistorySourcePosition = (value: NonNullable<
  StockTokenTradeHistoryAvailableData["positions"][number]["candle"]
>["firstSource"]): string => [
  `block ${value.blockNumber}`,
  `block hash ${value.blockHash}`,
  `transaction ${value.transactionHash}`,
  `transaction index ${value.transactionIndex}`,
  `log index ${value.logIndex}`,
].join(" · ");

const tradeHistoryDeveloperValues = (
  series: StockTokenTradeHistoryAvailableData,
): HTMLTableElement => exactValueTable(
  `Chart values and processing by display position from ${series.requestedStart} to ${series.requestedEnd} (exclusive)`,
  [
    "Natural interval start",
    "Natural interval end",
    "Represented start",
    "Represented end",
    "Position coverage",
    "Coverage meaning",
    "Pool ID",
    "Position state",
    "Open in USDG",
    "High in USDG",
    "Low in USDG",
    "Close in USDG",
    "USDG volume",
    `${series.symbol} volume`,
    "Trade count",
    "USDG volume raw",
    `${series.symbol} volume raw`,
    "Observed start",
    "Observed end",
    "First source position",
    "Last source position",
    "Aggregation source",
  ],
  series.positions.map((position) => {
    const candle = position.candle;
    const unavailable = "Not applicable";
    return [
      position.naturalStart,
      position.naturalEnd,
      position.representedStart,
      position.representedEnd,
      coverageLabels[position.coverage],
      tradeHistoryCoverageMeaning(position.coverage, candle !== null),
      position.poolId ?? "Not established",
      candle === null
        ? "Whitespace"
        : "Candlestick and volume histogram",
      candle === null ? unavailable : exactRationalText(candle.open),
      candle === null ? unavailable : exactRationalText(candle.high),
      candle === null ? unavailable : exactRationalText(candle.low),
      candle === null ? unavailable : exactRationalText(candle.close),
      candle === null
        ? unavailable
        : `${formatAmount(
            candle.quoteVolumeRaw,
            String(series.archive.root.usdgDecimals),
          )} USDG`,
      candle === null
        ? unavailable
        : `${formatAmount(
            candle.baseVolumeRaw,
            String(series.tokenDecimals.value),
          )} ${series.symbol}`,
      candle === null ? unavailable : candle.tradeCount,
      candle === null ? unavailable : candle.quoteVolumeRaw,
      candle === null ? unavailable : candle.baseVolumeRaw,
      candle === null ? "Not observed" : candle.observedStart,
      candle === null ? "Not observed" : candle.observedEnd,
      candle === null ? "Not observed" : tradeHistorySourcePosition(candle.firstSource),
      candle === null ? "Not observed" : tradeHistorySourcePosition(candle.lastSource),
      tradeHistoryAggregationMeaning(position),
    ];
  }),
);

const tradeHistoryEvidenceCorrelation = (
  result: CapabilitySuccess<StockTokenTradeHistoryData>,
): HTMLTableElement => exactValueTable(
  "Evidence source correlation",
  [
    "Purpose",
    "Source owner",
    "Source class",
    "Source reference",
    "Observed at",
    "Chain block",
    "Invocation ID",
    "Observation ID",
    "Record digest",
  ],
  result.evidence.sources.map((source) => [
    source.purpose,
    source.owner,
    source.sourceClass,
    source.reference.kind === "public" ? source.reference.uri : source.reference.sourceId,
    source.observedAt,
    source.chainAnchor?.blockNumber ?? "Not applicable",
    source.invocationId,
    source.observationId,
    source.recordDigest,
  ]),
);

const renderAccountAssets = (value: AccountAssetCollectionSuccess): DocumentFragment => {
  const view = projectAccountAssetCollectionView(value);
  const output = document.createDocumentFragment();
  output.append(summary([
    ["Account", view.account.address],
    ["Native balance", `${view.native.raw} raw units`],
    ["Tokens shown", String(view.assets.length)],
    ["More tokens available", view.nextCursor === null ? "No" : "Yes"],
    ["Official data", officialSnapshotStatusText(view.viewRevision),
      view.viewRevision.officialSnapshotStatus === "current" ? "current" : "unavailable"],
    ["Block", view.block.blockNumber],
  ]));
  const list = element("ul", "item-list");
  for (const asset of view.assets) {
    const amount = asset.quantity.formattedAdjusted ?? asset.quantity.formattedRaw ??
      `${asset.quantity.raw} raw units`;
    const context = [
      ...asset.identity.warnings,
      ...(asset.classification.limitation === null ? [] : [asset.classification.limitation]),
    ];
    list.append(element("li", "item", [
      asset.identity.label,
      amount,
      asset.identity.address,
      asset.classification.label,
      ...context,
    ].join(" · ")));
  }
  output.append(list);
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
  if (value.status === "not_declared") return "Not declared";
  if (value.status === "not_enumerable") return "Not enumerable";
  if (value.status === "limit_exceeded") return `Result limit exceeded (${value.count})`;
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
  if (data.status === "no_runtime_code_observed") {
    output.append(summary([
      ["Address", data.address],
      ["Runtime code", "None observed"],
      ["Block", data.block.blockNumber],
    ]));
    appendCapabilityContext(output, result, addressScopeLimitations);
    return output;
  }
  const analysis = data.analysis;
  const declaredFunctions = analysis.declaredFunctions.status === "observed"
    ? `${analysis.declaredFunctions.signatures.length} observed`
    : `Unavailable: ${contractControlFailureLabels[analysis.declaredFunctions.reason]}`;
  output.append(summary([
    ["Address", data.address],
    ["Runtime code", "Observed"],
    ["Proxy", contractProxyText(analysis.proxy)],
    ["Source checks", String(analysis.sources.length)],
    ["Declared functions", declaredFunctions],
    ["Owner control", contractControlText(analysis.controls.owner)],
    ["Pause control", contractControlText(analysis.controls.paused)],
    ["Default administrators", contractControlText(analysis.controls.defaultAdmins)],
    ["Block", analysis.block.blockNumber],
  ]));
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
    ["Stock Token", label],
    ["Requested period", stockTokenTradeHistoryPeriodLabel(value.period)],
  ]));
  output.append(element("h2", "section-title", "Trades in USDG"));
  if (value.status === "unavailable") {
    const reason = stockTokenTradeHistoryUnavailableReason(value);
    output.append(summary([
      ["Status", "Unavailable", "unavailable"],
      ["Reason", stockTokenTradeHistoryUnavailableReasonLabel(reason)],
      ...("archive" in value
        ? [
            [
              "Freshness",
              value.freshness === "unknown"
                ? "Unknown"
                : value.freshness === "current" ? "Current" : "Stale",
              value.freshness === "unknown" ? "unavailable" : value.freshness,
            ] as SummaryField,
            ...(value.archive.scope === "catalog_root"
              ? []
              : [["Published through", value.archive.root.currentUntil.timestamp] as SummaryField]),
          ]
        : []),
    ]));
    if ("archive" in value) {
      output.append(summary([["Reached scope", value.archive.scope]]));
    }
    if ("officialAsset" in value) {
      output.append(disclosure("Token details", [summary([
        ["Stock Token contract", value.officialAsset.member.contractAddress],
      ])]));
    }
    return output;
  }

  output.append(summary([
    ["Status", "Available", "current"],
    ["Freshness", value.freshness === "current" ? "Current" : "Stale", value.freshness],
    ["Published through", value.archive.root.currentUntil.timestamp],
    ["Coverage", value.coverage.status === "complete" ? "Complete" : "Partial", value.coverage.status],
    ["Requested coverage", stockTokenTradeHistoryRequestedCoverageLabel(value)],
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

  const chart = createTradeHistoryChartPresentation(
    value,
    `${label} trades in USDG`,
  );
  context.registerTradeHistoryChart(chart.mount);
  output.append(chart.node);
  output.append(disclosure("Token details", [summary([
    ["Stock Token contract", value.officialAsset.member.contractAddress],
    ["USDG contract", value.archive.root.usdgAddress],
    ["Uniswap V4 PoolManager", value.archive.root.poolManager],
    ["Uniswap V4 Pool IDs", Object.keys(value.archive.pools).join(", ")],
  ])]));
  output.append(deferredDisclosure("Developer details", () => [
    summary([
      ["Capability", result.meta.capabilityId],
      ["Contract version", result.meta.contractVersion],
      ["Evaluated at", result.meta.evaluatedAt],
      ["Evidence coverage", coverageLabels[result.evidence.coverage.status],
        result.evidence.coverage.status],
      ["Result block", value.block.blockNumber],
      ["Stored resolution", `${value.resolution.label} (${stockTokenTradeHistoryResolutionLabel(
        value.resolution.intervalSeconds,
      )})`],
      ["Chart positions", String(value.positions.length)],
      ["Source publication sequence", String(value.archive.root.publicationSequence)],
      ["Source coverage ends", value.archive.root.currentUntil.timestamp],
    ]),
    tradeHistoryDeveloperValues(value),
    tradeHistoryEvidenceCorrelation(result),
  ]));
  return output;
};
const renderTokenInspection = (result: TokenInspectionSuccess): DocumentFragment => {
  const value = result.data;
  const decimals = value.totalSupply.decimals.status === "available"
    ? value.totalSupply.decimals.value
    : value.metadata.decimalsReadFailure === "call_failed"
      ? "Unavailable: read call failed"
      : "Unavailable: malformed return value";
  const output = document.createDocumentFragment();
  output.append(summary([
    ["Token", value.asset.address],
    ["Name", value.metadata.name.status === "available"
      ? value.metadata.name.value
      : `Unavailable: token name ${tokenOptionalTextUnavailableReasonLabel(value.metadata.name.reason)}`],
    ["Symbol", value.metadata.symbol.status === "available"
      ? value.metadata.symbol.value
      : `Unavailable: token symbol ${tokenOptionalTextUnavailableReasonLabel(value.metadata.symbol.reason)}`],
    ["Total supply", `${value.totalSupply.raw} raw units`],
    ["Decimals", decimals],
    ["Standards", value.standards.standards.map((entry) =>
      `${entry.standardId}: ${tokenStandardStatusLabels[entry.status]}`).join(", ")],
    ["Block", value.analysis.block.blockNumber],
  ]));
  appendCapabilityContext(output, result, tokenScopeLimitations);
  return output;
};

const selectionFields = (
  selection: TokenSelectionDetail["selection"],
): readonly SummaryField[] => {
  return [
    ["Account", selection.account.address],
    ["Token", selection.asset.address],
    ["Included", selection.included ? "Yes" : "No"],
    ["Revision", selection.revision],
    ["Updated at", selection.updatedAt],
  ];
};

const renderTokenSelection = (value: TokenSelectionDetail): DocumentFragment => {
  const output = document.createDocumentFragment();
  output.append(summary(selectionFields(value.selection)));
  return output;
};

const renderTokenSelections = (value: TokenSelectionListResult): DocumentFragment => {
  const output = document.createDocumentFragment();
  output.append(summary([
    ["Selections", String(value.selections.length)],
    ...(value.selections[0] === undefined
      ? []
      : [["Account", value.selections[0].account.address] as const]),
    ["More selections available", value.nextCursor === null ? "No" : "Yes"],
  ]));
  const list = element("ul", "item-list");
  for (const selection of value.selections) {
    list.append(element(
      "li",
      "item",
      `${selection.asset.address} · ${selection.included ? "Included" : "Excluded"}`,
    ));
  }
  output.append(list);
  return output;
};

const renderWalletConnection = (result: WalletConnectionResult): DocumentFragment => {
  const value = result.data;
  const fields: SummaryField[] = [["Status", walletStatusLabels[value.status]]];
  if (value.status === "connected") {
    fields.push(
      ["Account", value.address],
      ["Chain", value.chainId],
      ["Approved methods", value.approvedMethods.join(", ")],
      ["Approved events", value.approvedEvents.join(", ")],
      ["Expires", value.expiresAt],
    );
  } else if (value.status === "unresolved") {
    fields.push(["Sessions", value.sessionCount]);
  } else {
    fields.push(["Reason", walletReasonLabels[value.reason]]);
  }
  const output = document.createDocumentFragment();
  output.append(summary(fields));
  appendCapabilityContext(output, result);
  return output;
};

const walletReviewFields = (value: WalletReviewResult): readonly SummaryField[] => {
  if (value.status === "current_connection") {
    return [
      ["Result", "The wallet is already connected."],
      ["Account", value.connection.address],
      ["Chain", value.connection.chainId],
      ["Connection revision", value.connectionRevision],
    ];
  }
  if (value.status === "already_disconnected") {
    return [
      ["Result", "The wallet is already disconnected."],
      ["Reason", walletReasonLabels[value.connection.reason]],
      ["Connection revision", value.connectionRevision],
    ];
  }
  const review = value.review;
  return [
    ["Action", review.kind === "connect" ? "Connect the external wallet" : "Disconnect the external wallet"],
    ["Chain", review.target.chainId],
    ["Current state", walletStatusLabels[review.precondition.connection.status]],
    ["Connection revision", review.precondition.connectionRevision],
    ["Action deadline", review.actionExpiresAt],
    ["Operation ID", review.operationId],
    ...(review.kind === "connect"
      ? [
          ["Required request", review.decision.requiredMethods.join(", ")],
          ["Requested optional methods", review.decision.optionalMethods.join(", ")],
          ["Required events", review.decision.requiredEvents.join(", ")],
        ] satisfies SummaryField[]
      : [
          ["Decision", "Disconnect the listed WalletConnect sessions from this profile"],
          ["Session count", String(review.fixedEvidence.sessionSourceIds.length)],
          ...review.fixedEvidence.sessionSourceIds.map((sourceId): SummaryField => ["Session source", sourceId]),
          ...(review.precondition.connection.status === "connected" ? [
            ["Account", review.precondition.connection.address],
            ["Session expires", review.precondition.connection.expiresAt],
          ] satisfies SummaryField[] : []),
        ] satisfies SummaryField[]),
  ];
};

const renderWalletReview = (value: WalletReviewResult): DocumentFragment => {
  const output = document.createDocumentFragment();
  output.append(summary(walletReviewFields(value)));
  return output;
};

const renderTokenSelectionReview = (value: TokenSelectionReviewResult): DocumentFragment => {
  const review = value.review;
  const previous = review.precondition.previousSelection;
  const output = document.createDocumentFragment();
  output.append(summary([
    ["Action", review.kind === "add" ? "Add this token selection" : "Remove this token selection"],
    ["Account", review.target.account.address],
    ["Token", review.target.asset.address],
    ["Current selection", previous?.included === true ? "Included" : "Not included"],
    ["Current revision", previous?.revision ?? "None"],
    ["Action deadline", review.actionExpiresAt],
    ["Operation ID", review.operationId],
    ...(review.kind === "add"
      ? [
          ["Name", review.decision.name.status === "available"
            ? review.decision.name.value
            : `Unavailable: token name ${tokenOptionalTextUnavailableReasonLabel(review.decision.name.reason)}`],
          ["Symbol", review.decision.symbol.status === "available"
            ? review.decision.symbol.value
            : `Unavailable: token symbol ${tokenOptionalTextUnavailableReasonLabel(review.decision.symbol.reason)}`],
          ["Official classification", review.decision.officialClassification === "official"
            ? "Verified official asset"
            : "Not listed in the fixed official snapshot"],
        ] satisfies SummaryField[]
      : []),
  ]));
  if (review.kind === "add") {
    appendWarnings(output, review.decision.warningCodes.map((code) => tokenReviewWarningLabels[code]));
  }
  return output;
};

const renderWalletOperation = (operation: WalletManagementOperation): DocumentFragment => {
  const output = document.createDocumentFragment();
  const fields: SummaryField[] = [
    ["Operation ID", operation.operationId],
    ["Decision", operation.kind === "connect" ? "Connect wallet" : "Disconnect wallet"],
    ["Status", walletOperationStateLabels[operation.state]],
    ["Decision interface", decisionProvenanceLabels[operation.initiatedBy]],
    ["Action deadline", operation.review.actionExpiresAt],
  ];
  if (operation.state === "completed" && operation.result !== null) {
    fields.push(
      ["Outcome", operation.kind === "connect" ? "Wallet connected" : "Wallet disconnected"],
      ["Connection revision", operation.result.connectionRevision],
    );
    if (operation.result.connection.status === "connected") {
      fields.push(
        ["Account", operation.result.connection.address],
        ["Chain", operation.result.connection.chainId],
      );
    }
  } else if (operation.state === "rejected") {
    fields.push(["Outcome", `The external wallet rejected the request (code ${operation.peerRefusalCode}).`]);
  } else if (operation.state === "cancelled") {
    fields.push(["Outcome", "The connection attempt was cancelled."]);
  } else if (operation.state === "expired") {
    fields.push(["Outcome", "The connection attempt expired."]);
  } else if (operation.state === "failed" && operation.failure !== null) {
    fields.push(["Failure", operation.failure.error.message]);
  }
  output.append(summary(fields));
  return output;
};

const renderTokenSelectionOperation = (operation: TokenCatalogOperation): DocumentFragment => {
  const selection = operation.result.selection.selection;
  const output = document.createDocumentFragment();
  output.append(summary([
    ["Operation ID", operation.operationId],
    ["Decision", operation.kind === "add" ? "Add token selection" : "Remove token selection"],
    ["Status", "Completed"],
    ["Decision interface", decisionProvenanceLabels[operation.initiatedBy]],
    ["Account", selection.account.address],
    ["Token", selection.asset.address],
    ["Included", selection.included ? "Yes" : "No"],
    ["Selection revision", selection.revision],
    ["Completed at", operation.completedAt],
  ]));
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

export const renderTransactionSections = (sections: readonly TransactionPresentationSection[]): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  for (const section of sections) {
    const group = element("section", "result-section");
    group.append(element("h2", "section-title", section.title));
    for (const line of section.lines) group.append(element("p", "status-copy", line));
    fragment.append(group);
  }
  return fragment;
};

const rendererBindings = Object.freeze([
  bindRenderer(presentationContracts.transactionReview, (review) => renderTransactionSections(exchangeReviewSections(review))),
  bindRenderer(presentationContracts.signingReview, (review) => {
    const fragment = document.createDocumentFragment();
    fragment.append(summary(signingReviewFields(review)));
    return fragment;
  }),
  bindRenderer(presentationContracts.activityTransaction, (record) => renderTransactionSections(transactionRecordSections(record))),
  bindRenderer(presentationContracts.activityTransactions, (page) => renderTransactionSections(page.records.length === 0 ?
    [{ title: "No recorded transactions", lines: ["This local ledger is not an account-wide chain history."] }] : page.records.flatMap(transactionRecordSections))),
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
  actionExpiresAt: string,
): RenderedReviewControls => {
  const group = element("div", "decision-group");
  group.append(
    element("h2", "section-title", "Choose an action"),
    element("p", "deadline-copy", `Available until ${actionExpiresAt}`),
  );
  const controls = element("div", "action-row");
  const accept = element("button", destructive ? "action destructive" : "action primary", acceptLabel);
  accept.type = "button";
  const dismiss = element("button", "action secondary", "Dismiss");
  dismiss.type = "button";
  controls.append(accept, dismiss);
  group.append(controls);
  return Object.freeze({ node: group, accept, dismiss });
};

export const renderOperationMessage = (
  title: string,
  message: string,
  status: "pending" | "unavailable" | "error" = "pending",
): HTMLElement => {
  const region = element("div", `operation-message status-${status}`);
  region.append(
    element("h2", "section-title", title),
    element("p", "status-copy", message),
  );
  return region;
};

export interface RenderedExactReadFailure {
  readonly node: HTMLElement;
  readonly retry: HTMLButtonElement;
}

export const renderExactReadFailure = (message: string): RenderedExactReadFailure => {
  const region = renderOperationMessage(
    "Operation unavailable",
    message,
    "error",
  );
  const retry = element("button", "action secondary", "Read exact operation again");
  retry.type = "button";
  region.append(retry);
  return Object.freeze({ node: region, retry });
};

const renderQr = (matrix: WalletQrMatrix, actionExpiresAt: string): HTMLElement => {
  const region = element("section", "qr-region");
  region.append(
    element("h3", "section-title", "Approve in the external wallet"),
    element("p", "qr-instruction", "Scan this code with the external wallet while this connection attempt is active."),
    element("p", "deadline-copy", `Server deadline: ${actionExpiresAt}`),
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
  region.append(element("h2", "section-title", "Operation"), renderer(result, {
    registerTradeHistoryChart: () => {
      throw new TypeError("An operation cannot register a trade-history chart.");
    },
  }));
  if (options.qr !== undefined) {
    const operation = result as unknown as WalletManagementOperation;
    region.append(renderQr(options.qr, operation.review.actionExpiresAt));
  }
  if (options.cancellable !== true) return Object.freeze({ node: region });
  const cancel = element("button", "action secondary", "Cancel connection attempt");
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
  node.append(element("h2", "section-title", "Verified signature"), element("p", "status-copy", signingOutcomeText(outcome)));
  node.append(element("p", "field-label", "Signature"), element("p", "field-value", signature),
    element("p", "status-copy", "This result is available only in this panel. The Host, terminal or copies you make may retain it; dismissal does not revoke it."));
  const copy = element("button", "action primary", "Copy signature"); copy.type = "button";
  const dismiss = element("button", "action secondary", "Dismiss signature"); dismiss.type = "button";
  const copyStatus = element("p", "status-copy"); copyStatus.setAttribute("role", "status");
  node.append(copy, dismiss, copyStatus);
  return { node, copy, dismiss, copyStatus };
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
  if (entry.presentationKind === "review" || entry.presentationKind === "transaction_review" || entry.presentationKind === "signing_review") {
    header.append(element("p", "eyebrow", "Decision"));
  }
  header.append(element("h1", "title", entry.title));
  const renderer = renderByEntry.get(entry);
  if (renderer === undefined) throw new TypeError("Presentation renderer is not registered.");
  let tradeHistoryChart: TradeHistoryChartMountDescription | null = null;
  article.append(header, renderer(result, {
    registerTradeHistoryChart: (description) => {
      if (tradeHistoryChart !== null) {
        throw new TypeError("A presentation cannot register more than one trade-history chart.");
      }
      tradeHistoryChart = description;
    },
  }));
  if (entry.presentationKind === "review" || entry.presentationKind === "transaction_review" || entry.presentationKind === "signing_review") {
    article.append(operationRegion(renderOperationMessage(
      "Operation",
      entry.presentationKind !== "review" ? "Little John is checking this live decision." : "Little John is reading the reserved operation ID.",
    )));
  }
  return Object.freeze({ node: article, tradeHistoryChart });
};

export const renderPresentationFailure = (message: string): HTMLElement => {
  const article = element("article", "card status-error");
  article.setAttribute("role", "alert");
  article.append(
    element("p", "eyebrow", "Presentation unavailable"),
    element("h1", "title", "Little John could not display this result"),
    element("p", "status-copy", message),
  );
  return article;
};

export const renderPresentationPending = (): HTMLElement => {
  const article = element("article", "card status-pending");
  article.setAttribute("role", "status");
  article.append(
    element("p", "eyebrow", "Immutable result"),
    element("h1", "title", "Little John is receiving this result"),
    element("p", "status-copy", "The admitted result has not arrived yet."),
  );
  return article;
};
