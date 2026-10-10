import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ServerResponse } from "node:http";
import { LocalRuntime } from "../../src/runtime/composition.js";
import { openRuntimeProfileReader, ProductDatabase } from "../../src/runtime/database.js";
import { runtimeIdentityPath } from "../../src/runtime/http-boundary.js";
import { parseUtcTimestamp } from "../../src/core/index.js";
import { runRuntimeManagement } from "../../src/runtime/management-client.js";
import { runCli, type CliTerminalPort } from "../../src/cli.js";

const filesystem = vi.hoisted(() => ({
  beforePublish: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, link: async (source: string, destination: string) => {
    if (destination.includes(`${sep}runtime-shutdown${sep}`)) await filesystem.beforePublish?.();
    return actual.link(source, destination);
  } };
});
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  filesystem.beforePublish = undefined;
  vi.restoreAllMocks();
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length !== 0) throw new AggregateError(failures, "Management verification cleanup failed.");
});

const executeCli = (args: string[], directory: string, signal = new AbortController().signal) => {
  const output: string[] = [];
  const errors: string[] = [];
  const forbidden = (): never => { throw new Error("Management must not construct a foreground backend client or request a decision."); };
  const terminal: CliTerminalPort = {
    inputIsTTY: false, outputIsTTY: false, columns: undefined, rows: undefined, interruptSignal: signal,
    writeOutput: value => { output.push(value); }, writeError: value => { errors.push(value); },
    writeSignature: forbidden, showQr: forbidden, hideQr: forbidden, readLine: forbidden,
    dispose: () => undefined,
  };
  const completion = runCli(args, { terminal, createRuntime: forbidden, createMcp: forbidden,
    waitForPoll: forbidden,
    runRuntimeManagement: (command, callerSignal) => runRuntimeManagement(command, callerSignal, { LITTLEJOHN_DATA_DIR: directory }),
  });
  return { output, errors, completion };
};

describe("Runtime management result handoff", () => {
  it("distinguishes an absent listener from unavailable local state without creating a profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-management-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const missing = join(directory, "absent");
    for (const command of ["status", "stop"]) {
      const result = executeCli(["runtime", command, "--json"], missing);
      expect((await result.completion).exitCode).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.output.map(value => JSON.parse(value))).toEqual([{ status: "not_running" }]);
    }
    const historical = executeCli(["runtime", "status", "--shutdown", "AAAAAAAAAAAAAAAAAAAAAA", "--json"], missing);
    expect((await historical.completion).exitCode).toBe(7);
    expect(historical.errors).toEqual([]);
    expect(historical.output).toHaveLength(1);
    expect(JSON.parse(historical.output[0]!)).toMatchObject({ ok: false, error: { code: "runtime_state_unavailable" } });
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects an absent management profile without stopping the existing owner or creating state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-management-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    let stopAdmissions = 0;
    const runtime = await LocalRuntime.create({ environment: { LITTLEJOHN_DATA_DIR: directory },
      onShutdownRequested: () => { stopAdmissions += 1; },
    });
    cleanup.push(() => runtime.stop());
    expect(await runtime.startExclusive()).toBe(true);
    const missing = join(directory, "absent");
    for (const command of ["status", "stop"]) {
      const result = executeCli(["runtime", command, "--json"], missing);
      expect((await result.completion).exitCode).toBe(7);
      expect(result.errors).toEqual([]);
      expect(result.output).toHaveLength(1);
      expect(JSON.parse(result.output[0]!)).toMatchObject({ ok: false, error: { code: "runtime_state_unavailable" } });
    }
    expect(stopAdmissions).toBe(0);
    expect(runtime.ownerState).toBe("owner");
    await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing", "malformed"] as const)("reports %s credentials as local state failure after valid DB admission", async state => {
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-management-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const database = await ProductDatabase.open(join(directory, "littlejohn.sqlite3"), parseUtcTimestamp("2026-07-12T10:16:02.000Z"));
    database.close();
    const credential = join(directory, "local-control-credential");
    if (state === "malformed") await writeFile(credential, "invalid\n", { mode: 0o600 });
    const before = state === "malformed" ? await lstat(credential) : undefined;
    const result = executeCli(["runtime", "status", "--shutdown", "AAAAAAAAAAAAAAAAAAAAAA", "--json"], directory);
    expect((await result.completion).exitCode).toBe(7);
    expect(result.errors).toEqual([]);
    expect(result.output).toHaveLength(1);
    expect(JSON.parse(result.output[0]!)).toMatchObject({ ok: false, error: { code: "runtime_state_unavailable" } });
    if (before === undefined) await expect(lstat(credential)).rejects.toMatchObject({ code: "ENOENT" });
    else {
      expect((await lstat(credential)).ino).toBe(before.ino);
      expect(await readFile(credential, "utf8")).toBe("invalid\n");
    }
  });

  it.skipIf(process.platform === "win32")("preserves a local reader failure during authentication instead of blaming the peer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-management-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const runtime = await LocalRuntime.create({ environment: { LITTLEJOHN_DATA_DIR: directory } });
    cleanup.push(() => runtime.stop());
    expect(await runtime.startExclusive()).toBe(true);
    const path = join(directory, "littlejohn.sqlite3");
    const end = ServerResponse.prototype.end;
    let changed = false;
    vi.spyOn(ServerResponse.prototype, "end").mockImplementation(function (this: ServerResponse, ...args: Parameters<typeof end>) {
      if (this.req.url === runtimeIdentityPath && !changed) {
        // The valid proof has been constructed, but the client's admitted file
        // loses its permission invariant before its own profile/owner read.
        changed = true;
        chmodSync(path, 0o644);
      }
      return Reflect.apply(end, this, args);
    });
    try {
      const result = executeCli(["runtime", "status", "--json"], directory);
      expect((await result.completion).exitCode).toBe(7);
      expect(changed).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.output).toHaveLength(1);
      expect(JSON.parse(result.output[0]!)).toMatchObject({ ok: false, error: { code: "runtime_state_unavailable" } });
    } finally { chmodSync(path, 0o600); }
    expect(runtime.ownerState).toBe("owner");
  });

  it.each(["late", "failed"] as const)("preserves one exact CLI target after a lost acknowledgement when publication is %s", async publication => {
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-management-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    let entered!: () => void;
    let resume!: () => void;
    const publishing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    filesystem.beforePublish = async () => {
      entered(); await gate;
      if (publication === "failed") throw new Error("Test filesystem publication failure.");
    };
    let stopped: Promise<unknown> | undefined;
    let stopAdmissions = 0;
    const runtime = await LocalRuntime.create({ environment: { LITTLEJOHN_DATA_DIR: directory },
      onShutdownRequested: () => {
        stopAdmissions += 1;
        stopped ??= runtime.stop();
        void stopped.catch(() => undefined);
      },
    });
    cleanup.push(async () => { resume(); filesystem.beforePublish = undefined; await stopped?.catch(() => undefined); await runtime.stop(); });
    expect(await runtime.startExclusive()).toBe(true);
    const reader = await openRuntimeProfileReader(join(directory, "littlejohn.sqlite3"));
    const owner = reader.readOwner()!;
    const target = { profileId: owner.profileId, ownerInstanceId: owner.ownerInstanceId, ownerRevision: owner.ownerRevision };
    reader.close();

    const end = ServerResponse.prototype.end;
    let lostAcknowledgements = 0;
    vi.spyOn(ServerResponse.prototype, "end").mockImplementation(function (this: ServerResponse, ...args: Parameters<typeof end>) {
      if (this.req.url === "/api/v1/internal/control/runtime/shutdown") {
        lostAcknowledgements += 1; this.destroy(); return this;
      }
      return Reflect.apply(end, this, args);
    });
    const observer = new AbortController();
    const stop = executeCli(["runtime", "stop", "--json"], directory, observer.signal);
    try {
      await publishing;
      const live = await runRuntimeManagement({ kind: "status", json: true }, undefined, { LITTLEJOHN_DATA_DIR: directory });
      try { expect(live.result).toEqual({ status: "not_running" }); } finally { await live.close(); }
      // The backend has released its resources, but the exact final result has
      // not reached publication. Cancelling this observer cannot undo stop.
      observer.abort();
      expect((await stop.completion).exitCode).not.toBe(0);
      expect(stop.errors).toEqual([]);
      expect(stop.output).toHaveLength(1);
      expect(JSON.parse(stop.output[0]!)).toEqual({ status: "shutdown_unconfirmed", target });
      expect(lostAcknowledgements).toBe(1);
      expect(stopAdmissions).toBe(1);
      resume();
      if (publication === "failed") await expect(stopped).rejects.toThrow();
      else await expect(stopped).resolves.toEqual({ kind: "released" });
      filesystem.beforePublish = undefined;

      // A newer live owner cannot replace the old result or become its target.
      const next = await LocalRuntime.create({ environment: { LITTLEJOHN_DATA_DIR: directory } });
      cleanup.push(() => next.stop());
      expect(await next.startExclusive()).toBe(true);
      const current = await openRuntimeProfileReader(join(directory, "littlejohn.sqlite3"));
      try { expect(current.readOwner()!.ownerInstanceId).not.toBe(target.ownerInstanceId); } finally { current.close(); }
      const historical = executeCli(["runtime", "status", "--shutdown", target.ownerInstanceId, "--json"], directory);
      const result = await historical.completion;
      expect(historical.errors).toEqual([]);
      expect(historical.output).toHaveLength(1);
      const reported = JSON.parse(historical.output[0]!);
      if (publication === "failed") {
        expect(result.exitCode).not.toBe(0);
        expect(reported).toEqual({ status: "shutdown_unconfirmed", target: {
          profileId: target.profileId, ownerInstanceId: target.ownerInstanceId,
        } });
      } else {
        expect(result.exitCode).toBe(0);
        expect(reported).toEqual({ status: "released", target });
      }
      expect(stopAdmissions).toBe(1);
      expect(next.ownerState).toBe("owner");
    } finally { observer.abort(); resume(); await stop.completion; }
  });
});
