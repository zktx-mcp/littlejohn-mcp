import { describe, expect, it, vi } from "vitest";

import { createBrowserSessionRecovery } from
  "../../../src/interfaces/web/browser-session-recovery.js";
import { BrowserResponseError } from "../../../src/interfaces/web/browser-client.js";

describe("browser session recovery", () => {
  it("requests one root reload for repeated authenticated-session loss", () => {
    const reload = vi.fn();
    const recovery = createBrowserSessionRecovery(reload);
    const unauthorized = new BrowserResponseError(
      "The request is not authorized.",
      "unauthorized",
    );

    expect(recovery(unauthorized)).toBe(true);
    expect(recovery(unauthorized)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves retryable transport failures to the caller", () => {
    const reload = vi.fn();
    const recovery = createBrowserSessionRecovery(reload);

    expect(recovery(new BrowserResponseError(
      "Local runtime state is unavailable.",
      "runtime_state_unavailable",
    ))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
