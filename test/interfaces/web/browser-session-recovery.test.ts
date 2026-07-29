import { describe, expect, it, vi } from "vitest";

import { createBrowserSessionRecovery } from
  "../../../src/interfaces/web/browser-session-recovery.js";
import { BrowserRequestError } from "../../../src/interfaces/web/browser-client.js";

describe("browser session recovery", () => {
  it("requests one root reload for repeated authenticated-session loss", () => {
    const reload = vi.fn();
    const recovery = createBrowserSessionRecovery(reload);
    const unauthorized = new BrowserRequestError({
      kind: "response_problem",
      problem: {
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        code: "unauthorized",
        detail: "The request is not authorized.",
        retryable: false,
        issues: [],
      },
    });

    expect(recovery(unauthorized)).toBe(true);
    expect(recovery(unauthorized)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves retryable transport failures to the caller", () => {
    const reload = vi.fn();
    const recovery = createBrowserSessionRecovery(reload);

    expect(recovery(new BrowserRequestError({
      kind: "local_failure",
      code: "runtime_state_unavailable",
      detail: "Local runtime state is unavailable.",
      retryable: false,
      issues: [],
    }))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
