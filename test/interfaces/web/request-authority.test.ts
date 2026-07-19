import { describe, expect, it } from "vitest";

import { createBrowserRequestAuthority } from
  "../../../src/interfaces/web/request-authority.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
};

describe("browser request authority", () => {
  it("makes only the newest read authoritative", () => {
    const authority = createBrowserRequestAuthority();
    const first = authority.beginRead();
    const second = authority.beginRead();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.signal?.aborted).toBe(true);
    expect(first === undefined ? true : authority.isCurrent(first)).toBe(false);
    expect(second === undefined ? false : authority.isCurrent(second)).toBe(true);

    if (second !== undefined) authority.cancelRead(second);
    expect(second === undefined ? true : authority.isCurrent(second)).toBe(false);
  });

  it("invalidates reads and rejects duplicate controls until completion", () => {
    const authority = createBrowserRequestAuthority();
    const read = authority.beginRead();
    const control = authority.beginControl();

    expect(read?.signal?.aborted).toBe(true);
    expect(read === undefined ? true : authority.isCurrent(read)).toBe(false);
    expect(control === undefined ? false : authority.isCurrent(control)).toBe(true);
    expect(authority.beginControl()).toBeUndefined();
    expect(authority.beginRead()).toBeUndefined();

    if (control !== undefined) authority.finishControl(control);
    const next = authority.beginControl();
    expect(next).toBeDefined();
    expect(next === undefined ? false : authority.isCurrent(next)).toBe(true);
  });

  it("does not let a late read overwrite the admitted control result", async () => {
    const authority = createBrowserRequestAuthority();
    const readResult = deferred<"completed">();
    const controlResult = deferred<never>();
    const events: string[] = [];
    const read = authority.beginRead();
    if (read === undefined) throw new Error("Expected a read request.");
    const readCompletion = readResult.promise.then((value) => {
      if (authority.isCurrent(read)) events.push(`read:${value}`);
    });

    const control = authority.beginControl();
    if (control === undefined) throw new Error("Expected a control request.");
    const controlCompletion = controlResult.promise.catch(() => {
      if (authority.isCurrent(control)) events.push("control:error");
    });

    readResult.resolve("completed");
    await readCompletion;
    controlResult.reject(new Error("control failed"));
    await controlCompletion;

    expect(read.signal?.aborted).toBe(true);
    expect(events).toEqual(["control:error"]);
  });

  it("keeps a new account page after an older load-more resolves", async () => {
    const authority = createBrowserRequestAuthority();
    const oldPage = deferred<readonly string[]>();
    const newPage = deferred<readonly string[]>();
    let registrations: readonly string[] = ["old-first-page"];
    const oldRead = authority.beginRead();
    if (oldRead === undefined) throw new Error("Expected the old account read.");
    const oldCompletion = oldPage.promise.then((page) => {
      if (authority.isCurrent(oldRead)) registrations = [...registrations, ...page];
    });

    const newRead = authority.beginRead();
    if (newRead === undefined) throw new Error("Expected the new account read.");
    const newCompletion = newPage.promise.then((page) => {
      if (authority.isCurrent(newRead)) registrations = page;
    });

    newPage.resolve(["new-account"]);
    await newCompletion;
    oldPage.resolve(["stale-load-more"]);
    await oldCompletion;

    expect(oldRead.signal?.aborted).toBe(true);
    expect(registrations).toEqual(["new-account"]);
  });

  it("keeps a refreshed page after an older same-account append resolves", async () => {
    const authority = createBrowserRequestAuthority();
    const oldAppend = deferred<readonly string[]>();
    const refresh = deferred<readonly string[]>();
    let registrations: readonly string[] = ["before-refresh"];
    const appendRead = authority.beginRead();
    if (appendRead === undefined) throw new Error("Expected the append read.");
    const appendCompletion = oldAppend.promise.then((page) => {
      if (authority.isCurrent(appendRead)) registrations = [...registrations, ...page];
    });

    const refreshRead = authority.beginRead();
    if (refreshRead === undefined) throw new Error("Expected the refresh read.");
    const refreshCompletion = refresh.promise.then((page) => {
      if (authority.isCurrent(refreshRead)) registrations = page;
    });

    refresh.resolve(["after-refresh"]);
    await refreshCompletion;
    oldAppend.resolve(["stale-append"]);
    await appendCompletion;

    expect(registrations).toEqual(["after-refresh"]);
  });

  it("invalidates an active read without closing the authority", () => {
    const authority = createBrowserRequestAuthority();
    const read = authority.beginRead();
    authority.invalidateRead();

    expect(read?.signal?.aborted).toBe(true);
    expect(read === undefined ? true : authority.isCurrent(read)).toBe(false);
    expect(authority.beginRead()).toBeDefined();
  });

  it("invalidates requests across close and Strict Mode reactivation", () => {
    const authority = createBrowserRequestAuthority();
    const beforeClose = authority.beginRead();
    authority.close();

    expect(beforeClose?.signal?.aborted).toBe(true);
    expect(beforeClose === undefined ? true : authority.isCurrent(beforeClose)).toBe(false);
    expect(authority.beginRead()).toBeUndefined();

    authority.activate();
    const afterActivate = authority.beginRead();
    expect(afterActivate).toBeDefined();
    expect(afterActivate === undefined ? false : authority.isCurrent(afterActivate)).toBe(true);
  });
});
