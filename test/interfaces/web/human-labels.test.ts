import { describe, expect, it } from "vitest";

import {
  contractControlFailureReasonLabel,
  contractControlStatusLabel,
  contractProxyAdminStatusLabel,
  contractProxyMethodLabel,
  contractProxyStatusLabel,
  contractProxyTerminalityLabel,
  contractProxyUnresolvedReasonLabel,
  contractSourceVerificationLabel,
  contractSourceRoleLabel,
  evidenceCoverageLabel,
  referenceHistoryLimitationLabel,
  referenceHistoryStatusLabel,
  referenceHistoryUnavailableReasonLabel,
  referencePriceStatusLabel,
  referencePriceUnavailableReasonLabel,
  referenceWarningLabel,
  tokenOptionalTextUnavailableReasonLabel,
} from "../../../src/interfaces/web/human-labels.js";

describe("browser human labels", () => {
  it("maps every evidence and reference status through explicit domain text", () => {
    expect((["complete", "partial", "unavailable"] as const).map(evidenceCoverageLabel))
      .toEqual(["Complete", "Partial", "Unavailable"]);
    expect((["current", "stale", "unavailable"] as const).map(referencePriceStatusLabel))
      .toEqual(["Current", "Stale", "Unavailable"]);
    expect((["partial", "unavailable"] as const).map(referenceHistoryStatusLabel))
      .toEqual(["Partial history", "History unavailable"]);
    expect(referencePriceUnavailableReasonLabel("derived_sources_not_fresh"))
      .toContain("not all current");
    expect(referenceHistoryUnavailableReasonLabel("no_valid_observation"))
      .toContain("No valid source observation");
  });

  it("maps every reference warning and history limitation without string rewriting", () => {
    expect(([
      "no_trade_volume",
      "partial_history",
      "reference_price_not_trade_price",
      "sequencer_status_unavailable",
      "source_listing_not_revalidated",
    ] as const).map(referenceWarningLabel)).toEqual([
      "Trade volume is not available from this reference feed.",
      "The available history does not cover the complete requested window.",
      "This reference price is not a trade or executable quote.",
      "Sequencer status is not available from the current sources.",
      "The source listing was not revalidated during this read.",
    ]);
    expect(([
      "source_history_not_exhaustive",
      "traversal_incomplete",
      "phase_boundary",
      "malformed_round",
      "retention_limited",
    ] as const).map(referenceHistoryLimitationLabel)).toEqual([
      "The source history is not exhaustive.",
      "The source traversal did not reach the complete requested window.",
      "The history reached a source phase boundary.",
      "A malformed source round limited the available history.",
      "Source retention limits the available history.",
    ]);
  });

  it("maps every contract-analysis status and failure reason", () => {
    expect(([
      "resolved",
      "no_supported_proxy_observed",
      "unresolved",
    ] as const).map(contractProxyStatusLabel)).toEqual([
      "Proxy resolved",
      "No supported proxy observed",
      "Proxy unresolved",
    ]);
    expect(([
      "eip1967_implementation",
      "eip1967_beacon",
      "erc1167",
    ] as const).map(contractProxyMethodLabel)).toEqual([
      "EIP-1967 implementation",
      "EIP-1967 beacon",
      "ERC-1167 minimal proxy",
    ]);
    expect((["observed", "not_present", "not_applicable"] as const)
      .map(contractProxyAdminStatusLabel)).toEqual([
        "Observed",
        "Not present",
        "Not applicable",
      ]);
    expect(([
      "conflicting_supported_proxy_markers",
      "admin_without_supported_implementation",
      "malformed_eip1967_address_storage",
      "beacon_implementation_reverted",
      "malformed_beacon_implementation",
      "implementation_runtime_code_empty",
      "implementation_terminality_unresolved",
    ] as const).map(contractProxyUnresolvedReasonLabel)).toHaveLength(7);
    expect(contractProxyTerminalityLabel({
      status: "supported_proxy_marker_observed",
      method: "erc1167",
    })).toBe("Another ERC-1167 minimal proxy marker was observed.");
    expect(([
      { status: "conflicting_supported_proxy_markers" },
      { status: "malformed_eip1967_address_storage" },
      { status: "admin_without_supported_implementation" },
    ] as const).map(contractProxyTerminalityLabel)).toHaveLength(3);
    expect(([
      "exact_match",
      "non_exact_match",
      "no_record_observed",
      "unavailable",
      "inconsistent",
    ] as const).map(contractSourceVerificationLabel)).toHaveLength(5);
    expect((["target", "implementation"] as const).map(contractSourceRoleLabel))
      .toEqual(["Target", "Implementation"]);
    expect(([
      "observed",
      "not_declared",
      "not_enumerable",
      "limit_exceeded",
      "unavailable",
    ] as const).map(contractControlStatusLabel)).toHaveLength(5);
    expect(([
      "deployment_unresolved",
      "exact_abi_unavailable",
      "source_inconsistent",
      "call_reverted",
      "malformed_return",
    ] as const).map(contractControlFailureReasonLabel)).toHaveLength(5);
  });

  it("uses the account presentation owner for every unavailable token-text reason", () => {
    expect(([
      "call_failed",
      "malformed",
      "unsafe_text",
    ] as const).map(tokenOptionalTextUnavailableReasonLabel)).toEqual([
      "read call failed",
      "returned malformed data",
      "contained unsafe text and was withheld",
    ]);
  });
});
