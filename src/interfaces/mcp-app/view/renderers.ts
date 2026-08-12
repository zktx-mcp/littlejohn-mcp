import {
  contractInspectCapability,
  getCapabilityDefinitionSnapshot,
  type CanonicalJson,
  type CapabilitySuccess,
  type ContractAnalysis,
  type ContractControlFailureReason,
  type ContractInspectData,
  type ExactRational,
  type ReferenceCandle,
  type ReferenceHistoryLimitationCode,
  type ReferenceHistorySuccess,
  type ReferenceMarketWarningCode,
  type ReferencePriceSuccess,
  type ReferenceWatchlistSuccess,
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
  ReferenceWatchlistOperation,
  ReferenceWatchlistReviewResult,
} from "../../../market-portfolio/contracts.js";
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

type ContractInspectionResult = CapabilitySuccess<ContractInspectData>;
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

type SummaryField = readonly [label: string, value: string, status?: "current" | "stale" | "partial" | "unavailable"];

const appendField = (list: HTMLDListElement, [label, value, status]: SummaryField): void => {
  list.append(
    element("dt", "field-label", label),
    element("dd", status === undefined ? "field-value" : `field-value status-${status}`, value),
  );
};

const summary = (fields: readonly SummaryField[]): HTMLDListElement => {
  const list = element("dl", "summary-grid");
  for (const field of fields) appendField(list, field);
  return list;
};

const exactRationalText = (value: ExactRational): string =>
  `${value.numerator} / ${value.denominator}`;

interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const rational = (value: ExactRational): Rational => {
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  if (denominator <= 0n) throw new TypeError("Chart denominator is invalid.");
  return { numerator, denominator };
};

const compareRational = (left: Rational, right: Rational): number => {
  const difference = left.numerator * right.denominator -
    right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};

const scaledY = (
  value: Rational,
  minimum: Rational,
  maximum: Rational,
  height: number,
): number => {
  if (compareRational(minimum, maximum) === 0) return Math.floor(height / 2);
  const differenceNumerator = value.numerator * minimum.denominator -
    minimum.numerator * value.denominator;
  const differenceDenominator = value.denominator * minimum.denominator;
  const rangeNumerator = maximum.numerator * minimum.denominator -
    minimum.numerator * maximum.denominator;
  const rangeDenominator = maximum.denominator * minimum.denominator;
  const scaled = differenceNumerator * rangeDenominator * BigInt(height) /
    (differenceDenominator * rangeNumerator);
  return height - Number(scaled);
};

const svgLine = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  className: string,
): SVGLineElement => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "line");
  node.setAttribute("x1", String(x1));
  node.setAttribute("y1", String(y1));
  node.setAttribute("x2", String(x2));
  node.setAttribute("y2", String(y2));
  node.setAttribute("class", className);
  return node;
};

const historyChart = (candlesInput: readonly ReferenceCandle[], label: string): SVGSVGElement => {
  const candles = candlesInput.map((candle) => Object.freeze({
    openedAt: candle.openedAt,
    open: rational(candle.open),
    high: rational(candle.high),
    low: rational(candle.low),
    close: rational(candle.close),
  }));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "history-chart");
  svg.setAttribute("viewBox", "0 0 640 200");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${label}; ${candles.length} fixed candles.`);
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = `${label}; ${candles.length} fixed candles`;
  svg.append(title);
  if (candles.length === 0) return svg;
  let minimum = candles[0]!.low;
  let maximum = candles[0]!.high;
  for (const candle of candles.slice(1)) {
    if (compareRational(candle.low, minimum) < 0) minimum = candle.low;
    if (compareRational(candle.high, maximum) > 0) maximum = candle.high;
  }
  const plotTop = 10;
  const plotHeight = 180;
  const step = 620 / candles.length;
  for (const [index, candle] of candles.entries()) {
    const x = 10 + step * (index + 0.5);
    const highY = plotTop + scaledY(candle.high, minimum, maximum, plotHeight);
    const lowY = plotTop + scaledY(candle.low, minimum, maximum, plotHeight);
    const openY = plotTop + scaledY(candle.open, minimum, maximum, plotHeight);
    const closeY = plotTop + scaledY(candle.close, minimum, maximum, plotHeight);
    svg.append(
      svgLine(x, highY, x, lowY, "candle-range"),
      svgLine(x - Math.min(5, step / 3), openY, x, openY, "candle-open"),
      svgLine(x, closeY, x + Math.min(5, step / 3), closeY, "candle-close"),
    );
  }
  return svg;
};

type EvidenceStatus = "current" | "stale" | "partial" | "unavailable";

const statusFor = (status: EvidenceStatus): EvidenceStatus => status;

const coverageLabels = Object.freeze({
  complete: "Complete",
  partial: "Partial",
  unavailable: "Unavailable",
} as const);

const referenceStatusLabels = Object.freeze({
  current: "Current",
  stale: "Stale",
  partial: "Partial history",
  unavailable: "Unavailable",
} as const);

const referenceWarningLabels = Object.freeze({
  no_trade_volume: "Trade volume is not available from this reference feed.",
  partial_history: "The available history does not cover the complete requested window.",
  reference_price_not_trade_price: "This reference price is not a trade or executable quote.",
  sequencer_status_unavailable: "Sequencer status is not available from the current sources.",
  source_listing_not_revalidated: "The source listing was not revalidated during this read.",
} satisfies Readonly<Record<ReferenceMarketWarningCode, string>>);

const referenceHistoryLimitationLabels = Object.freeze({
  source_history_not_exhaustive: "The source history is not exhaustive.",
  traversal_incomplete: "The source traversal did not reach the complete requested window.",
  phase_boundary: "The history reached a source phase boundary.",
  malformed_round: "A malformed source round limited the available history.",
  retention_limited: "Source retention limits the available history.",
} satisfies Readonly<Record<ReferenceHistoryLimitationCode, string>>);

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

const contractScopeLimitations = getCapabilityDefinitionSnapshot(
  contractInspectCapability,
).staticScopeExclusions.map((value) => value.message);
const tokenScopeLimitations = getCapabilityDefinitionSnapshot(
  tokenInspectCapability,
).staticScopeExclusions.map((value) => value.message);

const appendNotices = (
  output: DocumentFragment,
  heading: "Warnings" | "Limitations",
  values: readonly string[],
): void => {
  if (values.length === 0) return;
  const region = element("section", heading === "Warnings" ? "warning-group" : "limitation-group");
  region.append(element("h2", "section-title", heading));
  const list = element("ul", heading === "Warnings" ? "warning-list" : "limitation-list");
  for (const value of values) {
    list.append(element("li", heading === "Warnings" ? "warning-item" : "limitation-item", value));
  }
  region.append(list);
  output.append(region);
};

const appendWarnings = (output: DocumentFragment, warnings: readonly string[]): void => {
  appendNotices(output, "Warnings", warnings);
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

const historyValues = (candles: readonly ReferenceCandle[]): HTMLTableElement => {
  const table = element("table", "history-values");
  const caption = element("caption", "section-title", "Exact candle values");
  const head = element("thead");
  const headingRow = element("tr");
  for (const label of ["Opened", "Closed", "Open", "High", "Low", "Close"] as const) {
    headingRow.append(element("th", undefined, label));
  }
  head.append(headingRow);
  const body = element("tbody");
  for (const candle of candles) {
    const row = element("tr");
    for (const value of [
      candle.openedAt,
      candle.closedAt,
      exactRationalText(candle.open),
      exactRationalText(candle.high),
      exactRationalText(candle.low),
      exactRationalText(candle.close),
    ]) row.append(element("td", "exact-cell", value));
    body.append(row);
  }
  table.append(caption, head, body);
  return table;
};

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

const renderContractAnalysis = (result: ContractInspectionResult): DocumentFragment => {
  const analysis = result.data.analysis;
  const declaredFunctions = analysis.declaredFunctions.status === "observed"
    ? `${analysis.declaredFunctions.signatures.length} observed`
    : `Unavailable: ${contractControlFailureLabels[analysis.declaredFunctions.reason]}`;
  const output = document.createDocumentFragment();
  output.append(summary([
    ["Contract", analysis.target],
    ["Proxy", contractProxyText(analysis.proxy)],
    ["Source checks", String(analysis.sources.length)],
    ["Declared functions", declaredFunctions],
    ["Owner control", contractControlText(analysis.controls.owner)],
    ["Pause control", contractControlText(analysis.controls.paused)],
    ["Default administrators", contractControlText(analysis.controls.defaultAdmins)],
    ["Block", analysis.block.blockNumber],
  ]));
  appendCapabilityContext(output, result, contractScopeLimitations);
  return output;
};

const renderReferencePrice = (value: ReferencePriceSuccess): DocumentFragment => {
  const price = value.status === "current"
    ? value.currentPrice
    : value.status === "stale" ? value.lastObserved : undefined;
  const output = document.createDocumentFragment();
  output.append(summary([
    ["Pair", value.pair.label],
    ["Status", referenceStatusLabels[value.status], statusFor(value.status)],
    ["Exact value", price === undefined ? "Unavailable" : exactRationalText(price)],
    ["Observed at", value.block.blockTimestamp],
    ...(value.status === "unavailable"
      ? [["Reason", "The required source observations are not all current."] as const]
      : []),
  ]));
  appendWarnings(output, value.warnings.map((warning) => referenceWarningLabels[warning]));
  return output;
};

const renderReferenceHistory = (value: ReferenceHistorySuccess): DocumentFragment => {
  const label = value.pair.label;
  const output = document.createDocumentFragment();
  output.append(summary([
    ["Pair", label],
    ["Status", referenceStatusLabels[value.status], statusFor(value.status)],
    ["Window", value.window],
    ["Candles", String(value.candles.length)],
    ["Empty intervals", String(value.coverage.emptyBucketStarts.length)],
  ]));
  output.append(historyChart(value.candles, `${label} reference history`));
  if (value.candles.length > 0) output.append(historyValues(value.candles));
  appendWarnings(output, value.warnings.map((warning) => referenceWarningLabels[warning]));
  appendNotices(
    output,
    "Limitations",
    value.coverage.limitations.map((limitation) => referenceHistoryLimitationLabels[limitation]),
  );
  return output;
};

const renderWatchlist = (value: ReferenceWatchlistSuccess): DocumentFragment => {
  const output = document.createDocumentFragment();
  output.append(summary([
    ["Account", value.account.address],
    ["Revision", value.revision],
    ["Pairs", String(value.entries.length)],
  ]));
  const list = element("ul", "item-list");
  for (const entry of value.entries) {
    list.append(element("li", "item", `${entry.label} · ${entry.pairId}`));
  }
  output.append(list);
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
          ["Required events", review.decision.requiredEvents.join(", ")],
        ] satisfies SummaryField[]
      : [
          ["Account", review.precondition.connection.address],
          ["Session expires", review.precondition.connection.expiresAt],
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
    ["Account", review.precondition.account.address],
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

const watchlistDecisionLabel = (
  kind: ReferenceWatchlistReviewResult["review"]["kind"],
): string => kind === "add"
  ? "Add this reference pair"
  : kind === "remove"
    ? "Remove this reference pair"
    : "Use this reference-pair order";

const renderReferenceWatchlistReview = (
  value: ReferenceWatchlistReviewResult,
): DocumentFragment => {
  const review = value.review;
  const target = review.kind === "reorder"
    ? review.target.entries.map((entry) => entry.label).join(" → ")
    : `${review.target.pair.label} · ${review.target.pair.pairId}`;
  const output = document.createDocumentFragment();
  output.append(summary([
    ["Action", watchlistDecisionLabel(review.kind)],
    ["Account", review.precondition.account.address],
    ["Target", target],
    ["Current revision", review.precondition.watchlistRevision],
    ["Current pairs", String(review.precondition.currentEntries.length)],
    ["Action deadline", review.actionExpiresAt],
    ["Operation ID", review.operationId],
  ]));
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

const renderReferenceWatchlistOperation = (
  operation: ReferenceWatchlistOperation,
): DocumentFragment => {
  const output = document.createDocumentFragment();
  output.append(summary([
    ["Operation ID", operation.operationId],
    ["Decision", watchlistDecisionLabel(operation.kind)],
    ["Status", "Completed"],
    ["Decision interface", decisionProvenanceLabels[operation.initiatedBy]],
    ["Account", operation.result.watchlist.account.address],
    ["Pairs", String(operation.result.watchlist.entries.length)],
    ["Watchlist revision", operation.result.watchlist.revision],
    ["Completed at", operation.completedAt],
  ]));
  return output;
};

interface PresentationRendererBinding {
  readonly entry: PresentationContractEntry;
  render(value: CanonicalJson): DocumentFragment;
}

const bindRenderer = <Entry extends PresentationContractEntry>(
  entry: Entry,
  renderer: (value: PresentationContractResult<Entry>) => DocumentFragment,
): PresentationRendererBinding => Object.freeze({
  entry,
  render: (value: CanonicalJson) => renderer(value as PresentationContractResult<Entry>),
});

const rendererBindings = Object.freeze([
  bindRenderer(presentationContracts.accountAssets, renderAccountAssets),
  bindRenderer(presentationContracts.contractAnalysis, renderContractAnalysis),
  bindRenderer(presentationContracts.referenceHistory, renderReferenceHistory),
  bindRenderer(presentationContracts.referencePrice, renderReferencePrice),
  bindRenderer(presentationContracts.referenceWatchlist, renderWatchlist),
  bindRenderer(presentationContracts.referenceWatchlistOperation, renderReferenceWatchlistOperation),
  bindRenderer(presentationContracts.referenceWatchlistReview, renderReferenceWatchlistReview),
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
  region.append(element("h2", "section-title", "Operation"), renderer(result));
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

export const renderPresentation = (
  entry: PresentationContractEntry,
  result: CanonicalJson,
): HTMLElement => {
  if (entry.presentationKind === "operation") {
    throw new TypeError("An operation cannot create a top-level presentation.");
  }
  const article = element("article", "card");
  const header = element("header", "card-header");
  header.append(
    element("p", "eyebrow", entry.presentationKind === "review" ? "Decision" : "Immutable result"),
    element("h1", "title", entry.title),
  );
  const renderer = renderByEntry.get(entry);
  if (renderer === undefined) throw new TypeError("Presentation renderer is not registered.");
  article.append(header, renderer(result));
  if (entry.presentationKind === "review") {
    article.append(operationRegion(renderOperationMessage(
      "Operation",
      "Little John is reading the reserved operation ID.",
    )));
  }
  return article;
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
