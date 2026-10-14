import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac, hkdfSync } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, copyFile, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { loadOrCreateControlCredential } from "../../src/runtime/control-credential.js";
import { publishRuntimeShutdownResult, readRuntimeShutdownResult, waitForRuntimeShutdownResult } from "../../src/runtime/shutdown-results.js";
import { runtimeShutdownRecordMaximumBytes, runtimeShutdownTargetSchema } from "../../src/runtime/management-contract.js";
import { runtimePackageIdentity } from "../../src/runtime/package-identity.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { parseUtcTimestamp } from "../../src/core/index.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import { parseRuntimeManagementCommand, runRuntimeManagement } from "../../src/runtime/management-client.js";

const readBarrier = vi.hoisted(() => ({ path: "", reads: 0,
  entered: undefined as undefined | (() => void), wait: undefined as undefined | Promise<void> }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const result = await actual.lstat(...args).then(value => ({ value }), (error: unknown) => ({ error }));
    if (args[0] === readBarrier.path && ++readBarrier.reads === 2) {
      readBarrier.entered?.(); await readBarrier.wait;
    }
    if ("error" in result) throw result.error;
    return result.value;
  } };
});

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); readBarrier.path = ""; readBarrier.reads = 0; readBarrier.entered = undefined; readBarrier.wait = undefined; vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "littlejohn-shutdown-")); directories.push(directory);
  const paths = runtimePaths(directory);
  const credential = await loadOrCreateControlCredential(directory, paths.controlCredential);
  const database = await ProductDatabase.open(paths.database, parseUtcTimestamp("2026-10-09T00:00:00.000Z"));
  const profileId = database.ownerStore().readProfile().profileId; database.close();
  const target = (n: number) => runtimeShutdownTargetSchema.parse({ profileId,
    ownerInstanceId: Buffer.alloc(16, n).toString("base64url"), ownerRevision: String(n) });
  const record = (n: number) => ({ ...target(n), configurationMac: Buffer.alloc(32, 7).toString("base64url"),
    packageName: runtimePackageIdentity.name, packageVersion: runtimePackageIdentity.version,
    controlProtocolVersion: "1" as const, outcome: "released" as const });
  return { directory, paths, credential, target, record,
    path: (n: number) => join(directory, "runtime-shutdown", `${target(n).ownerInstanceId}.json`) };
};

describe("exact Runtime shutdown results", () => {
  it("preserves both generations when the older publisher finishes last, including idempotent publication", async () => {
    const f = await fixture();
    await publishRuntimeShutdownResult({ ...f, record: f.record(2) });
    await publishRuntimeShutdownResult({ ...f, record: f.record(1) });
    await publishRuntimeShutdownResult({ ...f, record: f.record(1) });
    for (const n of [1, 2]) expect(await readRuntimeShutdownResult({ ...f, target: f.target(n) }))
      .toEqual({ status: "released", target: f.target(n) });
    const raw = JSON.parse(await readFile(f.path(1), "utf8"));
    const { proof, ...unsigned } = raw;
    const ordered = Object.fromEntries(Object.keys(unsigned).sort().map(key => [key, unsigned[key]]));
    const credentialBytes = Buffer.from((await readFile(f.paths.controlCredential, "utf8")).trim(), "base64url");
    const key = hkdfSync("sha256", credentialBytes, Buffer.alloc(0), "littlejohn/runtime-shutdown/v1", 32);
    expect(proof).toBe(createHmac("sha256", Buffer.from(key)).update(JSON.stringify(ordered)).digest("base64url"));
  });

  it("never replaces an admitted generation with different content", async () => {
    const f = await fixture();
    await publishRuntimeShutdownResult({ ...f, record: f.record(1) });
    const before = await readFile(f.path(1));
    await expect(publishRuntimeShutdownResult({ ...f, record: { ...f.record(1), configurationMac: Buffer.alloc(32, 8).toString("base64url") } })).rejects.toThrow();
    expect(await readFile(f.path(1))).toEqual(before);
  });

  it("rejects a valid signed record under another filename, profile, or key", async () => {
    const f = await fixture(); const other = await fixture();
    await publishRuntimeShutdownResult({ ...f, record: f.record(1) });
    await copyFile(f.path(1), f.path(2));
    expect((await readRuntimeShutdownResult({ ...f, target: { ...f.target(2), ownerRevision: f.target(1).ownerRevision } })).status).toBe("shutdown_unconfirmed");
    expect((await readRuntimeShutdownResult({ ...f, target: { ...f.target(1), profileId: other.target(1).profileId } })).status).toBe("shutdown_unconfirmed");
    expect((await readRuntimeShutdownResult({ ...f, target: { ...f.target(1), ownerRevision: f.target(2).ownerRevision } })).status).toBe("shutdown_unconfirmed");
    expect((await readRuntimeShutdownResult({ ...f, credential: other.credential, target: f.target(1) })).status).toBe("shutdown_unconfirmed");
  });

  it("bounds the file before parsing otherwise-valid whitespace and refuses symlinks", async () => {
    const f = await fixture();
    await publishRuntimeShutdownResult({ ...f, record: f.record(1) });
    const valid = await readFile(f.path(1), "utf8");
    await writeFile(f.path(1), valid + " ".repeat(runtimeShutdownRecordMaximumBytes + 2 - Buffer.byteLength(valid)));
    expect((await readRuntimeShutdownResult({ ...f, target: f.target(1) })).status).toBe("shutdown_unconfirmed");
    await writeFile(f.path(1), valid);
    const target = join(f.directory, "signed-result.json");
    await rename(f.path(1), target);
    await symlink(target, f.path(1));
    // The pointed-to bytes have the exact requested generation and valid proof.
    // Only the unsafe file type distinguishes this from an admitted record.
    expect((await readRuntimeShutdownResult({ ...f, target: f.target(1) })).status).toBe("shutdown_unconfirmed");
  });

  it("performs a fresh deadline read when an earlier missing-file observation completes late", async () => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    readBarrier.path = f.path(1);
    readBarrier.reads = 0;
    readBarrier.entered = entered;
    readBarrier.wait = new Promise<void>(resolve => { release = resolve; });
    const observer = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const waiting = waitForRuntimeShutdownResult({ ...f, target: f.target(1),
      deadline: performance.now() + 1000, signal: observer.signal });
    try {
      await held;
      await publishRuntimeShutdownResult({ ...f, record: f.record(1) });
      await vi.advanceTimersByTimeAsync(1000);
      release();
      expect(await waiting).toEqual({ status: "released", target: f.target(1) });
      expect(readBarrier.reads).toBeGreaterThanOrEqual(3);
    } finally { release(); observer.abort(); await waiting; }
  });

  it("allows the user to read a late exact result after timeout without a listener or a new command", async () => {
    const f = await fixture();
    const first = await waitForRuntimeShutdownResult({ ...f, target: f.target(1), deadline: performance.now() - 1 });
    expect(first).toEqual({ status: "shutdown_unconfirmed", target: f.target(1) });
    await publishRuntimeShutdownResult({ ...f, record: f.record(2) });
    await publishRuntimeShutdownResult({ ...f, record: f.record(1) });
    const socket = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => { throw new Error("Historical reads must not access a listener."); });
    const command = parseRuntimeManagementCommand(["runtime", "status", "--shutdown", f.target(1).ownerInstanceId, "--json"]);
    const call = await runRuntimeManagement(command, undefined, { LITTLEJOHN_MCP_DATA_DIR: f.directory });
    try { expect(call.result).toEqual({ status: "released", target: f.target(1) }); }
    finally { await call.close(); }
    expect(socket).not.toHaveBeenCalled();
    const missing = await runRuntimeManagement(parseRuntimeManagementCommand(["runtime", "status", "--shutdown", f.target(3).ownerInstanceId]), undefined, { LITTLEJOHN_MCP_DATA_DIR: f.directory });
    try { expect("status" in missing.result && missing.result.status).toBe("shutdown_unconfirmed"); }
    finally { await missing.close(); }
    expect(() => parseRuntimeManagementCommand(["runtime", "status", "--shutdown", "../other.json"])).toThrow();
  });
});
