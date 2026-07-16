import { describe, expect, it } from "vitest";

import { createWalletOperationRequestAuthority } from
  "../../../src/interfaces/web/request-authority.js";

describe("wallet operation browser request authority", () => {
  it("makes only the newest poll authoritative", () => {
    const authority = createWalletOperationRequestAuthority();
    const first = authority.beginPoll();
    const second = authority.beginPoll();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.signal?.aborted).toBe(true);
    expect(first === undefined ? true : authority.isCurrent(first)).toBe(false);
    expect(second === undefined ? false : authority.isCurrent(second)).toBe(true);

    if (second !== undefined) authority.cancelPoll(second);
    expect(second === undefined ? true : authority.isCurrent(second)).toBe(false);
  });

  it("invalidates polling and rejects duplicate controls until completion", () => {
    const authority = createWalletOperationRequestAuthority();
    const poll = authority.beginPoll();
    const control = authority.beginControl();

    expect(poll?.signal?.aborted).toBe(true);
    expect(poll === undefined ? true : authority.isCurrent(poll)).toBe(false);
    expect(control === undefined ? false : authority.isCurrent(control)).toBe(true);
    expect(authority.beginControl()).toBeUndefined();
    expect(authority.beginPoll()).toBeUndefined();

    if (control !== undefined) authority.finishControl(control);
    const next = authority.beginControl();
    expect(next).toBeDefined();
    expect(next === undefined ? false : authority.isCurrent(next)).toBe(true);
  });

  it("invalidates requests across close and Strict Mode reactivation", () => {
    const authority = createWalletOperationRequestAuthority();
    const beforeClose = authority.beginPoll();
    authority.close();

    expect(beforeClose?.signal?.aborted).toBe(true);
    expect(beforeClose === undefined ? true : authority.isCurrent(beforeClose)).toBe(false);
    expect(authority.beginPoll()).toBeUndefined();

    authority.activate();
    const afterActivate = authority.beginPoll();
    expect(afterActivate).toBeDefined();
    expect(afterActivate === undefined ? false : authority.isCurrent(afterActivate)).toBe(true);
  });
});
