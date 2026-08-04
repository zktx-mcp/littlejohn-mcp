import { describe, expect, it } from "vitest";

import {
  browserErrorCodes,
  type BrowserErrorCode,
} from "../../../src/interfaces/browser-error-response.js";
import {
  browserLocalFailureCodes,
  type BrowserRequestFailure,
} from "../../../src/interfaces/web/browser-client.js";
import {
  humanFailureTaskContexts,
  humanFailureText,
  presentBrowserRequestFailure,
  presentHumanFailure,
} from "../../../src/interfaces/web/human-failures.js";

const responseFailure = (
  code: BrowserErrorCode,
  retryable = false,
): BrowserRequestFailure => Object.freeze({
  kind: "response_problem",
  problem: Object.freeze({
    type: "about:blank",
    title: "Canonical problem title",
    status: 400,
    code,
    detail: "CANONICAL_DETAIL_MUST_NOT_REACH_THE_PERSON",
    retryable,
    issues: Object.freeze([]),
  }),
});

describe("human browser failure projection", () => {
  it("covers every current browser code in every task context without copying canonical detail", () => {
    for (const context of humanFailureTaskContexts) {
      for (const code of browserErrorCodes) {
        const retryable = code === "chain_response_unavailable" || code === "source_unavailable";
        const presentation = presentHumanFailure(
          context,
          responseFailure(code, retryable),
        );

        expect(presentation.code).toBe(code);
        expect(presentation.retryable).toBe(retryable);
        expect(presentation.summary.length).toBeGreaterThan(0);
        expect(humanFailureText(presentation))
          .not.toContain("CANONICAL_DETAIL_MUST_NOT_REACH_THE_PERSON");
      }
    }
  });

  it("covers each local failure without exposing an unexpected exception", () => {
    for (const code of browserLocalFailureCodes) {
      const retryable = code === "request_aborted" || code === "response_timeout";
      const presentation = presentHumanFailure("analysis", {
        kind: "local_failure",
        code,
        detail: "LOCAL_DETAIL_MUST_NOT_REACH_THE_PERSON",
        retryable,
        issues: [],
      });
      expect(presentation.code).toBe(code);
      expect(presentation.retryable).toBe(retryable);
      expect(humanFailureText(presentation))
        .not.toContain("LOCAL_DETAIL_MUST_NOT_REACH_THE_PERSON");
    }

    const unexpected = presentBrowserRequestFailure(
      "analysis",
      new Error("PRIVATE_EXCEPTION_TEXT"),
    );
    expect(unexpected).toEqual({
      summary: "Little John could not complete analysis read.",
      retryable: false,
      fields: [],
      code: "internal_error",
    });
    expect(humanFailureText(unexpected)).not.toContain("PRIVATE_EXCEPTION_TEXT");
  });

  it("keeps the local response deadline distinct from caller cancellation", () => {
    const timeout = presentHumanFailure("price_history", {
      kind: "local_failure",
      code: "response_timeout",
      detail: "LOCAL_DETAIL_MUST_NOT_REACH_THE_PERSON",
      retryable: true,
      issues: [],
    });
    const aborted = presentHumanFailure("price_history", {
      kind: "local_failure",
      code: "request_aborted",
      detail: "LOCAL_DETAIL_MUST_NOT_REACH_THE_PERSON",
      retryable: true,
      issues: [],
    });

    expect(timeout).toEqual({
      summary: "Little John did not complete the price history read in time.",
      recovery: "Try again.",
      retryable: true,
      fields: [],
      code: "response_timeout",
    });
    expect(timeout.summary).not.toBe(aborted.summary);
  });

  it("attributes wallet operation failures to their actual owner without inventing a retry", () => {
    const deadline = presentHumanFailure(
      "wallet_connection",
      responseFailure("wallet_timeout", false),
    );
    const pairingCode = presentHumanFailure(
      "wallet_connection",
      responseFailure("wallet_pairing_code_unavailable", false),
    );
    const walletConnect = presentHumanFailure(
      "wallet_disconnection",
      responseFailure("walletconnect_unavailable", false),
    );

    expect(deadline).toEqual({
      summary: "Wallet connection did not complete before Little John's local action deadline.",
      retryable: false,
      fields: [],
      code: "wallet_timeout",
    });
    expect(pairingCode).toEqual({
      summary: "Little John could not create the wallet pairing code.",
      retryable: false,
      fields: [],
      code: "wallet_pairing_code_unavailable",
    });
    expect(walletConnect).toEqual({
      summary: "WalletConnect could not complete wallet disconnection.",
      retryable: false,
      fields: [],
      code: "walletconnect_unavailable",
    });
    expect(humanFailureText(deadline)).not.toContain("Robinhood Wallet");
  });

  it("describes unusable wallet recovery as the profile-wide disconnect effect", () => {
    expect(presentHumanFailure(
      "wallet_connection",
      responseFailure("wallet_session_unusable", false),
    )).toEqual({
      summary: "The current Robinhood Wallet state cannot complete this request.",
      recovery: "Disconnect every wallet session in this local profile, then connect the wallet again.",
      retryable: false,
      fields: [],
      code: "wallet_session_unusable",
    });
  });

  it("maps admitted field paths to controls without copying issue messages", () => {
    const presentation = presentHumanFailure(
      "analysis",
      {
        kind: "response_problem",
        problem: {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          code: "invalid_input",
          detail: "The request input is invalid.",
          retryable: false,
          issues: [{
            path: "/address",
            code: "invalid_value",
            message: "CANONICAL_ISSUE_TEXT",
          }],
        },
      },
      [{
        path: "/address",
          label: "address",
          controlId: "analysis-address",
          errorId: "analysis-address-error",
      }],
    );

    expect(presentation).toEqual({
      summary: "Check the highlighted fields.",
      retryable: false,
      fields: [{
        path: "/address",
        label: "address",
        controlId: "analysis-address",
        errorId: "analysis-address-error",
        summary: "Check address.",
      }],
      code: "invalid_input",
    });
    expect(JSON.stringify(presentation)).not.toContain("CANONICAL_ISSUE_TEXT");
  });

  it("does not turn inconsistent source evidence into a product conclusion", () => {
    const presentation = presentHumanFailure(
      "analysis",
      responseFailure("source_inconsistent", false),
    );
    const text = humanFailureText(presentation).toLowerCase();

    expect(text).toBe(
      "little john could not verify the data required for analysis read, so no result was accepted.",
    );
    expect(text).not.toMatch(
      /\b(pair absent|unregistered|safe|unsafe|liquidity|retry)\b/u,
    );
    expect(presentation.retryable).toBe(false);
  });

  it("uses the same owner for HTTP and admitted operation failures", () => {
    const fromHttp = presentHumanFailure(
      "stock_token_remove",
      responseFailure("state_conflict", false),
    );
    const fromOperation = presentHumanFailure("stock_token_remove", {
      ok: false,
      error: {
        code: "state_conflict",
        retryable: false,
        issues: [],
      },
    });

    expect(fromOperation).toEqual(fromHttp);
  });

  it("rejects an operation code outside browser error authority", () => {
    expect(() => presentHumanFailure("stock_token_change", {
      ok: false,
      error: {
        code: "invented_operation_failure",
        retryable: false,
        issues: [],
      },
    })).toThrow("outside browser authority");
  });
});
