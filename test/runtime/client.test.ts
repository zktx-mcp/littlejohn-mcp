import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../../src/runtime/client.js";
import { PeerUnavailableError, type AuthenticatedOwnerConnection } from "../../src/runtime/owner-transport.js";

const clock = vi.hoisted(() => ({ now: undefined as number | undefined }));
vi.mock("node:timers/promises", async original => {
  const actual = await original<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: async (milliseconds: number, value?: unknown, options?: { signal?: AbortSignal }) => {
    if (clock.now === undefined) return actual.setTimeout(milliseconds, value, options);
    if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    clock.now += milliseconds; return value;
  } };
});
const peer = vi.hoisted(() => ({ probe: undefined as undefined | (() => Promise<AuthenticatedOwnerConnection>) }));
vi.mock("../../src/runtime/owner-transport.js", async original => ({
  ...await original<typeof import("../../src/runtime/owner-transport.js")>(),
  openAuthenticatedOwnerChannel: () => peer.probe!(),
}));
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); peer.probe = undefined; clock.now = undefined; });

const fixture = async (spawnBackend: (environment: Readonly<Record<string, string>>) => ChildProcess) => {
  const directory = await mkdtemp(join(tmpdir(), "littlejohn-client-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const client = await RuntimeClient.create({ environment: { LITTLEJOHN_MCP_DATA_DIR: directory,
    PATH: "/test-node-path", NODE_OPTIONS: "--invalid-loader", UNRELATED_HOST_SECRET: "excluded" }, spawnBackend });
  cleanup.push(() => client.stop());
  return { client, directory };
};

// These tests isolate the client lifecycle from the external authenticated
// socket driver. The HTTP tests independently exercise that driver's proof,
// framing and exact-socket admission; compiled tests exercise the full chain.
describe("Runtime client ownership", () => {
  it("shares a startup candidate, isolates caller cancellation, and closes a late acquired socket without stopping the candidate", async () => {
    const candidate = new EventEmitter() as ChildProcess;
    candidate.kill = vi.fn(() => { throw new Error("A client cannot kill its backend."); });
    const spawned: Readonly<Record<string, string>>[] = [];
    let release!: (value: AuthenticatedOwnerConnection) => void;
    const socket = new Promise<AuthenticatedOwnerConnection>(resolve => { release = resolve; });
    let probes = 0;
    peer.probe = () => ++probes === 1 ? Promise.reject(new PeerUnavailableError("refused", true)) : socket;
    const { client, directory } = await fixture(environment => { spawned.push(environment); return candidate; });
    await client.start();
    const firstCaller = new AbortController();
    const first = client.openOwnerSession(firstCaller.signal).then(() => "unexpected", error => error.failure.error.code);
    const second = client.openOwnerSession().then(() => "unexpected", error => error.failure.error.code);
    await vi.waitFor(() => expect(probes).toBe(2));
    firstCaller.abort();
    expect(await first).toBe("request_aborted");
    expect(spawned).toEqual([{ NODE_ENV: "production", LITTLEJOHN_MCP_DATA_DIR: directory, PATH: "/test-node-path" }]);
    const closeSocket = vi.fn(async () => undefined);
    const closing = client.stop();
    release({ ready: true, ownerIdentity: { phase: "running" }, channel: { close: closeSocket } } as unknown as AuthenticatedOwnerConnection);
    expect(await second).toBe("request_aborted");
    expect(await closing).toEqual({ kind: "released" });
    expect(closeSocket).toHaveBeenCalledTimes(1);
    expect(candidate.kill).not.toHaveBeenCalled();
  });

  it("ends the 60-second startup observation without closing MCP or duplicating a live candidate", async () => {
    const candidates: ChildProcess[] = [];
    peer.probe = () => Promise.reject(new PeerUnavailableError("refused", true));
    const { client } = await fixture(() => {
      const child = new EventEmitter() as ChildProcess;
      child.kill = vi.fn(() => { throw new Error("Observation timeout cannot kill a backend."); });
      candidates.push(child); return child;
    });
    clock.now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock.now!);
    let fatalStartup = false;
    void client.startupFailure.then(() => { fatalStartup = true; });
    await client.start();
    await expect(client.openOwnerSession()).rejects.toMatchObject({ failure: { error: { code: "runtime_state_unavailable" } } });
    // The accepted 60-second budget may stop before a final 2-second probe
    // minimum can fit. Neither the old 2-second nor a reset deadline satisfies it.
    expect(clock.now).toBeGreaterThanOrEqual(60000 - 2000);
    expect(clock.now).toBeLessThanOrEqual(60000);
    expect(candidates).toHaveLength(1);
    await expect(client.openOwnerSession()).rejects.toMatchObject({ failure: { error: { code: "runtime_state_unavailable" } } });
    expect(candidates).toHaveLength(1);
    expect(fatalStartup).toBe(false);
    candidates[0]!.emit("exit", 1, null);
    await expect(client.openOwnerSession()).rejects.toMatchObject({ failure: { error: { code: "runtime_state_unavailable" } } });
    expect(candidates).toHaveLength(2);
    for (const child of candidates) expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not spawn for an incompatible owner or silently convert its failure to readiness", async () => {
    const { PeerIncompatibleError } = await import("../../src/runtime/owner-transport.js");
    peer.probe = () => Promise.reject(new PeerIncompatibleError("foreign"));
    const spawn = vi.fn(() => { throw new Error("Foreign ownership must not spawn a contender."); });
    const { client } = await fixture(spawn);
    await client.start();
    await expect(client.startupFailure).resolves.toMatchObject({ failure: { error: { code: "port_conflict" } } });
    await expect(client.openOwnerSession()).rejects.toMatchObject({ failure: { error: { code: "port_conflict" } } });
    expect(spawn).not.toHaveBeenCalled();
  });
});
