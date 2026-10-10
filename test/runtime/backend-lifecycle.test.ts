import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkerRelay } from "../wallet/worker-relay.js";

const packageRoot = process.env["LITTLEJOHN_TEST_PACKAGE_ROOT"];
const dist = packageRoot ? new URL("dist/", pathToFileURL(`${packageRoot}/`)) : new URL("../../dist/", import.meta.url);
const { RuntimeClient } = await import(new URL("runtime/client.js", dist).href) as typeof import("../../src/runtime/client.js");
const { LocalOperationClient } = await import(new URL("interfaces/operation-client.js", dist).href) as typeof import("../../src/interfaces/operation-client.js");
const { operationInterfaceBindings: bindings, walletOperationPresentationIdentity } = await import(new URL("interfaces/operation-bindings.js", dist).href) as typeof import("../../src/interfaces/operation-bindings.js");
const { runRuntimeManagement } = await import(new URL("runtime/management-client.js", dist).href) as typeof import("../../src/runtime/management-client.js");
const { openRuntimeProfileReader } = await import(new URL("runtime/database.js", dist).href) as typeof import("../../src/runtime/database.js");
const cleanup: (() => Promise<unknown>)[] = [];
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw error; }
};
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length !== 0) throw new AggregateError(failures, "Compiled backend qualification cleanup failed.");
});

const command = async (kind: "status" | "stop", directory: string) => {
  const call = await runRuntimeManagement({ kind, json: true }, undefined, { LITTLEJOHN_DATA_DIR: directory });
  try { return call.result; } finally { await call.close(); }
};

describe("compiled independent backend", () => {
  it.each(["EOF", "SIGTERM", "SIGKILL"] as const)("keeps the admitted Wallet connection and SDK source after launcher %s", async termination => {
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-backend-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const relay = await createWorkerRelay(packageRoot ? new URL("package.json", pathToFileURL(`${packageRoot}/`)) : undefined);
    cleanup.push(() => relay.close());
    const gate = join(directory, "bootstrap-gate");
    const createTransport = () => new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("./backend-client-entry.mjs", import.meta.url))], stderr: "ignore",
      env: { PATH: process.env["PATH"] ?? "", ...(packageRoot ? { LITTLEJOHN_TEST_PACKAGE_ROOT: packageRoot } : {}), LITTLEJOHN_DATA_DIR: directory,
        LITTLEJOHN_TEST_RELAY_PORT: String(relay.port),
        ...(termination === "EOF" ? { LITTLEJOHN_TEST_BACKEND_GATE: gate } : {}) } });
    const transport = createTransport();
    const client = new Client({ name: "backend-lifetime-test", version: "1" });
    cleanup.push(async () => {
      if (termination === "EOF") await writeFile(gate, "continue");
      // Foreground cleanup precedes this step; a detached bootstrap may still be
      // finishing. Do not remove its profile after a premature port-absence read.
      let candidates: number[] = [];
      let backendAvailable = false;
      await vi.waitFor(async () => {
        candidates = (await readdir(directory)).filter(name => name.startsWith("backend-candidate-"))
          .map(name => Number(name.slice("backend-candidate-".length)));
        if (!candidates.some(alive)) { backendAvailable = false; return; }
        const status = await command("status", directory);
        backendAvailable = "phase" in status;
        expect(backendAvailable).toBe(true);
      }, { timeout: 15000 });
      if (backendAvailable) {
        const result = await command("stop", directory);
        expect("status" in result && result.status).toBe("released");
      }
      await vi.waitFor(() => { expect(candidates.some(alive)).toBe(false); }, { timeout: 10000 });
    });
    cleanup.push(async () => { await client.close(); await transport.close(); });
    await client.connect(transport);
    expect((await client.listTools()).tools.length > 0).toBe(true);
    // This fresh local ledger is available at application readiness and does
    // not require SDK readiness. Wallet evidence is admitted separately below.
    const localAccount = { chainId: "eip155:4663", address: "0x1111111111111111111111111111111111111111" };
    const readLocalLedger = (mcp: Client) => mcp.callTool({ name: "activity_list_transactions", arguments: { account: localAccount, cursor: null } });
    const initial = readLocalLedger(client);
    void initial.catch(() => undefined);
    let contender: Client | undefined;
    let competingCall: ReturnType<Client["callTool"]> | undefined;
    let candidatePids: number[] = [];
    if (termination === "EOF") {
      const competingTransport = createTransport();
      contender = new Client({ name: "competing-client-test", version: "1" });
      const captured = contender;
      cleanup.push(async () => { await captured.close(); await competingTransport.close(); });
      await contender.connect(competingTransport);
      expect((await contender.listTools()).tools.length > 0).toBe(true);
      competingCall = readLocalLedger(contender);
      void competingCall.catch(() => undefined);
      await vi.waitFor(async () => {
        candidatePids = (await readdir(directory)).filter(name => name.startsWith("bootstrap-gate.waiting-"))
          .map(name => Number(name.slice("bootstrap-gate.waiting-".length)));
        expect(candidatePids).toHaveLength(2);
      }, { timeout: 10000 });
      // An explicit input delay longer than the old 2-second contention budget.
      await delay(2001);
      await writeFile(gate, "continue");
    }
    const initialResult = await initial;
    expect(initialResult.isError === true, initialResult.isError === true ? JSON.stringify(initialResult.structuredContent) : undefined).toBe(false);
    expect(initialResult.structuredContent).toEqual({ account: localAccount, records: [], nextCursor: null });
    if (competingCall !== undefined) expect((await competingCall).structuredContent).toEqual(initialResult.structuredContent);
    const before = await command("status", directory);
    if (!("phase" in before)) throw new Error("An authenticated running backend is required.");
    expect(before.phase).toBe("running");
    const profile = await openRuntimeProfileReader(join(directory, "littlejohn.sqlite3"));
    const backendPid = profile.readOwner()!.processId; profile.close();
    if (termination === "EOF") {
      expect(candidatePids).toContain(backendPid);
      expect(before.target.ownerRevision).toBe("1"); // Only the successful binder can publish an owner.
      const loser = candidatePids.find(pid => pid !== backendPid)!;
      await vi.waitFor(() => { expect(alive(loser)).toBe(false); }, { timeout: 10000 });
    }

    const peer = await RuntimeClient.create({ environment: { LITTLEJOHN_DATA_DIR: directory },
      spawnBackend: () => { throw new Error("The peer must use the existing backend."); } });
    await peer.start(); cleanup.push(() => peer.stop());
    const operations = new LocalOperationClient({ ownerSessions: peer }); cleanup.push(() => operations.close());
    let review: unknown;
    await vi.waitFor(async () => {
      const value = await operations.invoke(bindings.walletReview.identity, { kind: "connect" });
      const found = "ok" in value && value.ok && value.value.status === "review";
      expect(found).toBe(true);
      if (found && "ok" in value && value.ok && value.value.status === "review") review = value.value.review;
    }, { timeout: 20000 });
    const started = await operations.invoke(bindings.walletConnect.identity, { review, initiatedBy: "cli" } as never);
    if (!("ok" in started) || !started.ok) throw new Error("The exact test connection was not admitted.");
    const operationId = started.value.operationId;
    let originalExpiry = "";
    await vi.waitFor(async () => {
      const value = await operations.invoke(walletOperationPresentationIdentity, { operationId });
      const ready = "ok" in value && value.ok && value.value.operation.state === "awaiting_wallet_approval" && value.value.qr !== undefined;
      expect(ready).toBe(true); // Never print a QR value into the test log.
      if ("ok" in value && value.ok) originalExpiry = value.value.operation.review.actionExpiresAt;
    }, { timeout: 20000 });
    const publishes = relay.methods.filter(method => method === "irn_publish").length;
    if (termination === "EOF") await client.close();
    else { if (transport.pid === null) throw new Error("The launcher PID is unavailable."); process.kill(transport.pid, termination); await client.close(); }
    const after = await command("status", directory);
    expect("phase" in after && after.phase).toBe("running");
    if ("phase" in after) expect(after.target).toEqual(before.target);
    const observed = await operations.invoke(walletOperationPresentationIdentity, { operationId });
    const retained = "ok" in observed && observed.ok && observed.value.operation.state === "awaiting_wallet_approval" && observed.value.qr !== undefined;
    expect(retained).toBe(true);
    if ("ok" in observed && observed.ok) expect(observed.value.operation.review.actionExpiresAt).toBe(originalExpiry);
    expect(relay.methods.filter(method => method === "irn_publish").length).toBe(publishes);
    await operations.close(); await peer.stop();
    await contender?.close();
    const stillRunning = await command("status", directory);
    expect("phase" in stillRunning && stillRunning.target).toEqual(before.target);
    const stopped = await command("stop", directory);
    expect("status" in stopped && stopped.status).toBe("released");
    await vi.waitFor(() => { expect(alive(backendPid)).toBe(false); }, { timeout: 10000 });
    const result = await runRuntimeManagement({ kind: "shutdown_result", ownerInstanceId: before.target.ownerInstanceId, json: true }, undefined, { LITTLEJOHN_DATA_DIR: directory });
    try { expect(result.result).toEqual({ status: "released", target: before.target }); } finally { await result.close(); }
  }, 60000);
});
