import {
  type ContractAnalysis,
  type ContractControlFailureReason,
  type ContractProxyResult,
  type ContractSourceVerificationStatus,
  type Coverage,
  type ReferenceHistoryLimitationCode,
  type ReferenceHistorySuccess,
  type ReferenceMarketWarningCode,
  type ReferencePriceSuccess,
} from "../../core/browser.js";
import {
  classificationLabel,
  officialSnapshotStatusText,
  tokenOptionalTextUnavailableReasonLabel,
  type AccountAssetExactSuccess,
} from "../../account-assets/browser.js";

type ReferencePriceUnavailableReason = Extract<
  ReferencePriceSuccess,
  { readonly status: "unavailable" }
>["reason"];
type ReferenceHistoryUnavailableReason = Extract<
  ReferenceHistorySuccess,
  { readonly status: "unavailable" }
>["reason"];
type ContractProxyMethod = Extract<
  ContractProxyResult,
  { readonly status: "resolved" }
>["method"];
type ContractProxyAdminStatus = Extract<
  ContractProxyResult,
  { readonly status: "resolved" }
>["admin"]["status"];
type ContractProxyUnresolvedReason = Extract<
  ContractProxyResult,
  { readonly status: "unresolved" }
>["reason"];
type ContractProxyTerminality = Extract<
  ContractProxyResult,
  {
    readonly status: "unresolved";
    readonly reason: "implementation_terminality_unresolved";
  }
>["terminality"];
type ContractSourceRole = ContractAnalysis["sources"][number]["role"];
type ContractControlStatus =
  | ContractAnalysis["declaredFunctions"]["status"]
  | ContractAnalysis["controls"]["owner"]["status"]
  | ContractAnalysis["controls"]["paused"]["status"]
  | ContractAnalysis["controls"]["defaultAdmins"]["status"];
export {
  classificationLabel,
  officialSnapshotStatusText,
  tokenOptionalTextUnavailableReasonLabel,
};

type TokenStandardStatus =
  AccountAssetExactSuccess["standards"]["standards"][number]["status"];

export const tokenStandardStatusLabel = (
  value: TokenStandardStatus,
): string => {
  switch (value) {
    case "observed": return "Observed";
    case "supported": return "Supported";
    case "not_supported": return "Not supported";
    case "unknown": return "Unknown";
    case "inconsistent": return "Inconsistent";
  }
};

export const evidenceCoverageLabel = (value: Coverage["status"]): string => {
  switch (value) {
    case "complete": return "Complete";
    case "partial": return "Partial";
    case "unavailable": return "Unavailable";
  }
};

export const referencePriceStatusLabel = (
  value: ReferencePriceSuccess["status"],
): string => {
  switch (value) {
    case "current": return "Current";
    case "stale": return "Stale";
    case "unavailable": return "Unavailable";
  }
};

export const referencePriceUnavailableReasonLabel = (
  value: ReferencePriceUnavailableReason,
): string => {
  switch (value) {
    case "derived_sources_not_fresh":
      return "The required source observations are not all current.";
  }
};

export const referenceHistoryStatusLabel = (
  value: ReferenceHistorySuccess["status"],
): string => {
  switch (value) {
    case "partial": return "Partial history";
    case "unavailable": return "History unavailable";
  }
};

export const referenceHistoryUnavailableReasonLabel = (
  value: ReferenceHistoryUnavailableReason,
): string => {
  switch (value) {
    case "no_valid_observation":
      return "No valid source observation is available in this window.";
  }
};

export const referenceWarningLabel = (
  value: ReferenceMarketWarningCode,
): string => {
  switch (value) {
    case "no_trade_volume":
      return "Trade volume is not available from this reference feed.";
    case "partial_history":
      return "The available history does not cover the complete requested window.";
    case "reference_price_not_trade_price":
      return "This reference price is not a trade or executable quote.";
    case "sequencer_status_unavailable":
      return "Sequencer status is not available from the current sources.";
    case "source_listing_not_revalidated":
      return "The source listing was not revalidated during this read.";
  }
};

export const referenceHistoryLimitationLabel = (
  value: ReferenceHistoryLimitationCode,
): string => {
  switch (value) {
    case "source_history_not_exhaustive":
      return "The source history is not exhaustive.";
    case "traversal_incomplete":
      return "The source traversal did not reach the complete requested window.";
    case "phase_boundary":
      return "The history reached a source phase boundary.";
    case "malformed_round":
      return "A malformed source round limited the available history.";
    case "retention_limited":
      return "Source retention limits the available history.";
  }
};

export const contractProxyStatusLabel = (
  value: ContractProxyResult["status"],
): string => {
  switch (value) {
    case "resolved": return "Proxy resolved";
    case "no_supported_proxy_observed": return "No supported proxy observed";
    case "unresolved": return "Proxy unresolved";
  }
};

export const contractProxyMethodLabel = (
  value: ContractProxyMethod,
): string => {
  switch (value) {
    case "eip1967_implementation": return "EIP-1967 implementation";
    case "eip1967_beacon": return "EIP-1967 beacon";
    case "erc1167": return "ERC-1167 minimal proxy";
  }
};

export const contractProxyAdminStatusLabel = (
  value: ContractProxyAdminStatus,
): string => {
  switch (value) {
    case "observed": return "Observed";
    case "not_present": return "Not present";
    case "not_applicable": return "Not applicable";
  }
};

export const contractProxyUnresolvedReasonLabel = (
  value: ContractProxyUnresolvedReason,
): string => {
  switch (value) {
    case "conflicting_supported_proxy_markers":
      return "Supported proxy markers conflict.";
    case "admin_without_supported_implementation":
      return "A proxy administrator was observed without a supported implementation.";
    case "malformed_eip1967_address_storage":
      return "The EIP-1967 address storage is malformed.";
    case "beacon_implementation_reverted":
      return "The beacon implementation read reverted.";
    case "malformed_beacon_implementation":
      return "The beacon returned a malformed implementation address.";
    case "implementation_runtime_code_empty":
      return "The resolved implementation has no runtime code.";
    case "implementation_terminality_unresolved":
      return "The observed first-hop implementation is not terminal within the supported proxy boundary.";
  }
};

export const contractProxyTerminalityLabel = (
  value: ContractProxyTerminality,
): string => {
  switch (value.status) {
    case "supported_proxy_marker_observed":
      return `Another ${contractProxyMethodLabel(value.method)} marker was observed.`;
    case "conflicting_supported_proxy_markers":
      return "Supported proxy markers conflict at the observed first-hop implementation.";
    case "malformed_eip1967_address_storage":
      return "EIP-1967 address storage is malformed at the observed first-hop implementation.";
    case "admin_without_supported_implementation":
      return "A proxy administrator was observed there without a supported implementation marker.";
  }
};

export const contractSourceVerificationLabel = (
  value: ContractSourceVerificationStatus,
): string => {
  switch (value) {
    case "exact_match": return "Exact source match";
    case "non_exact_match": return "Source record is not an exact match";
    case "no_record_observed": return "No source record observed";
    case "unavailable": return "Source verification unavailable";
    case "inconsistent": return "Source verification inconsistent";
  }
};

export const contractSourceRoleLabel = (
  value: ContractSourceRole,
): string => {
  switch (value) {
    case "target": return "Target";
    case "implementation": return "Implementation";
  }
};

export const contractControlStatusLabel = (
  value: ContractControlStatus,
): string => {
  switch (value) {
    case "observed": return "Observed";
    case "not_declared": return "Not declared";
    case "not_enumerable": return "Not enumerable";
    case "limit_exceeded": return "Result limit exceeded";
    case "unavailable": return "Unavailable";
  }
};

export const contractControlFailureReasonLabel = (
  value: ContractControlFailureReason,
): string => {
  switch (value) {
    case "deployment_unresolved":
      return "The contract deployment is unresolved.";
    case "exact_abi_unavailable":
      return "An exact ABI is unavailable.";
    case "source_inconsistent":
      return "The source evidence is inconsistent.";
    case "call_reverted":
      return "The control read reverted.";
    case "malformed_return":
      return "The control read returned malformed data.";
  }
};
