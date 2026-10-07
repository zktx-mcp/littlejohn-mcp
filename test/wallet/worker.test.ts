import { afterEach, describe, expect, it, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once, EventEmitter } from "node:events";
import type { Duplex } from "node:stream";





import type { WalletOwnerBootstrapPort } from "../../src/runtime/application-context.js";


import { walletRequestInputSchema } from "../../src/wallet/request-contract.js";
import { admitSigningPayload } from "../../src/review/signing-payload.js";
import { hashSigningPayload } from "../../src/review/signing-hash.js";
import { createSigningCodec } from "../../src/chain/evm-standard.js";
import { encodeWalletWorkerMessage, decodeWalletWorkerMessage, workerCommandSchema, workerMessageSchema } from "../../src/wallet/worker-contract.js";
import { createWorkerRelay } from "./worker-relay.js";

// Physical and package checks consume one compiled module graph, including
// opaque configuration and source-key provenance. A source .ts parent would
// resolve the executable under src instead of the distributed dist directory.
const packageRoot = process.env["LITTLEJOHN_TEST_PACKAGE_ROOT"];
const distRoot = packageRoot === undefined ? new URL("../../dist/", import.meta.url) : new URL("dist/", pathToFileURL(packageRoot + "/"));
const { createCanonicalClock, createCapabilityInvocationAuthority, ObservationAuthorityRegistry, CapabilityRegistry, CapabilityBindingRegistry } = await import(new URL("core/index.js", distRoot).href) as typeof import("../../src/core/index.js");
const { loadOrCreateControlCredential } = await import(new URL("runtime/control-credential.js", distRoot).href) as typeof import("../../src/runtime/control-credential.js");
const { createWalletSourceAuthority, exportWalletSourceKey } = await import(new URL("runtime/source-identity.js", distRoot).href) as typeof import("../../src/runtime/source-identity.js");
const { parseProfileId } = await import(new URL("runtime/runtime-identity.js", distRoot).href) as typeof import("../../src/runtime/runtime-identity.js");
const { readRuntimeConfiguration } = await import(new URL("runtime/configuration.js", distRoot).href) as typeof import("../../src/runtime/configuration.js");
const { WalletSdkWorkerClient } = await import(new URL("wallet/worker-client.js", distRoot).href) as typeof import("../../src/wallet/worker-client.js");
const { openWalletConnectStorage } = await import(new URL("wallet/walletconnect-storage.js", distRoot).href) as typeof import("../../src/wallet/walletconnect-storage.js");
const { ProductDatabase } = await import(new URL("runtime/database.js", distRoot).href) as typeof import("../../src/runtime/database.js");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const bootstrap = async () => {
  const directory = await mkdtemp(join(tmpdir(), "littlejohn-worker-"));
  await chmod(directory, 0o700);
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const credential = await loadOrCreateControlCredential(directory, join(directory, "control-credential"));
  const store = join(directory, "wallet");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(store, { mode: 0o700 }));
  const clock = createCanonicalClock(() => new Date().toISOString());
  const configuration = readRuntimeConfiguration({});
  const sourceAuthority = createWalletSourceAuthority({ credential, profileId: parseProfileId(Buffer.alloc(16, 1).toString("base64url")), clock });
  const database = await ProductDatabase.open(join(directory, "product.sqlite3"), clock.now());
  cleanup.push(async () => database.close());
  const wallet = { projection: database.walletStore(), operations: database.walletOperationStore(), configuration: configuration.wallet, privateStoreDirectory: { ensureDirectory: async () => store }, sourceAuthority,
    capabilityAuthority: { clock, invocationAuthority: createCapabilityInvocationAuthority(clock, configuration.chain.chainId), createInvocationPorts: () => ({ observations: new ObservationAuthorityRegistry(clock, [sourceAuthority.sdkStoreAuthority]) }) },
  } as WalletOwnerBootstrapPort;
  return { wallet, store, database, credential, configuration };
};
const ready = (client: InstanceType<typeof WalletSdkWorkerClient>): Promise<void> => new Promise((resolve) => {
  const activation = client.activate(() => resolve()); activation.releaseEvents();
});
const signingInput = (sourceId: string, kind: "personal" | "typed_data" = "personal") => {
  const payload = admitSigningPayload(kind === "personal" ? { kind, encoding: "utf8", value: "hello" } : {
    kind, types: { EIP712Domain: [{ name: "chainId", type: "uint256" }], Message: [{ name: "value", type: "string" }] }, primaryType: "Message", domain: { chainId: "4663" }, message: { value: "hello" },
  });
  return walletRequestInputSchema.parse({ kind: "signing", payload, context: { operationId: Buffer.alloc(32, 5).toString("base64url"), account: { chainId: "eip155:4663", address: "0x1111111111111111111111111111111111111111" }, method: kind === "personal" ? "personal_sign" : "eth_signTypedData_v4", messageHash: hashSigningPayload(createSigningCodec(), payload) }, sessionSourceId: sourceId, sendExpiresAt: new Date(Date.now() + 5000).toISOString() });
};

describe("compiled Wallet SDK ownership", () => {
  it("initializes the pinned SDK offline, retains its exclusive store until actual close, and admits a successor", async () => {
    const relay = await createWorkerRelay(new URL("../package.json", distRoot)); cleanup.push(relay.close);
    const { wallet, store } = await bootstrap();
    let child!: ChildProcess;
    const client = new WalletSdkWorkerClient(wallet, new AbortController().signal, { relayUrl: relay.url,
      spawn: (entry) => (child = fork(fileURLToPath(entry), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: ["--import", fileURLToPath(new URL("./worker-egress.mjs", import.meta.url))], env: { LITTLEJOHN_TEST_RELAY_PORT: String(relay.port) } })) });
    cleanup.push(() => client.contain());
    const starting = ready(client);
    await expect(client.observe()).rejects.toMatchObject({ code: "observation" });
    await starting;
    expect((await client.observe()).sessions).toEqual([]);
    await expect(openWalletConnectStorage(store)).rejects.toThrow("unavailable");
    const attempt = await client.startConnection();
    expect(attempt.qr.size).toBeGreaterThanOrEqual(21);
    expect(relay.methods).toContain("wc_proposeSession");
    await client.contain();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    const successor = await openWalletConnectStorage(store); successor.close();
  }, 30_000);

  it("holds one SDK request lane across local waiting and IPC, then releases only on original settlement or actual child close", async () => {
    const { wallet } = await bootstrap();
    let child!: ChildProcess;
    const client = new WalletSdkWorkerClient(wallet, new AbortController().signal, {
      spawn: () => (child = fork(fileURLToPath(new URL("./worker-request-entry.mjs", import.meta.url)), [], { stdio: ["ignore", "ignore", "ignore", "ipc", "pipe"], execArgv: [], env: { NODE_ENV: "test" } })) });
    cleanup.push(() => client.contain());
    await ready(client);
    const source = (await client.observe()).sessions[0]!.source;
    expect(source.sourceId).toBe(wallet.sourceAuthority.createSessionSource("3".repeat(64)).sourceId);
    const control = child.stdio[4] as Duplex;
    const requested = once(control, "data");
    const attempt = await client.startRequest(signingInput(source.sourceId));
    const [chunk] = await requested;
    const message = JSON.parse(String(chunk).trim());
    expect(message.input.request).toEqual({ method: "personal_sign", params: ["0x68656c6c6f", "0x1111111111111111111111111111111111111111"] });
    expect(client.hasPendingRequest()).toBe(true);
    await expect(client.startRequest(signingInput(source.sourceId, "typed_data"))).rejects.toMatchObject({ code: "local_admission" });
    control.write(JSON.stringify({ kind: "reject", code: 4001 }) + "\n");
    expect(await attempt.settlement).toEqual({ status: "wallet_rejected" });
    expect(client.hasPendingRequest()).toBe(false);
    const second = await client.startRequest(signingInput(source.sourceId, "typed_data"));
    await client.contain();
    expect(await second.settlement).toEqual({ status: "delivery_unknown", reason: "shutdown" });
    expect(client.hasPendingRequest()).toBe(false);
  }, 15_000);
  it("releases a real partially acquired SDK only after actual worker close", async () => {
    const relay = await createWorkerRelay(new URL("../package.json", distRoot)); cleanup.push(relay.close);
    const { wallet, store, database, credential, configuration } = await bootstrap();
    let child!: ChildProcess;
    let initialized!: Promise<unknown[]>;
    const client = new WalletSdkWorkerClient(wallet, new AbortController().signal, { relayUrl: relay.url,
      spawn: (entry) => {
        child = fork(fileURLToPath(entry), [], { stdio: ["ignore", "ignore", "ignore", "ipc", "pipe"], execArgv: ["--import", fileURLToPath(new URL("./worker-egress.mjs", import.meta.url)), "--import", fileURLToPath(new URL("./worker-partial-init.mjs", import.meta.url))], env: { LITTLEJOHN_TEST_RELAY_PORT: String(relay.port) } });
        initialized = once(child.stdio[4] as Duplex, "data");
        return child;
      } });
    cleanup.push(() => client.contain());
    const spawned = new Promise<void>((resolve) => {
      const create = wallet.privateStoreDirectory.ensureDirectory;
      wallet.privateStoreDirectory.ensureDirectory = async () => { const path = await create(); queueMicrotask(() => resolve()); return path; };
    });
    await spawned;
    const { createWalletOwnerApplicationFactory } = await import(new URL("wallet/application.js", distRoot).href) as typeof import("../../src/wallet/application.js");
    const { createResourceOwnershipScope } = await import(new URL("runtime/resource-ownership.js", distRoot).href) as typeof import("../../src/runtime/resource-ownership.js");
    const { createRuntimeRouteRegistry } = await import(new URL("runtime/http-routing.js", distRoot).href) as typeof import("../../src/runtime/http-routing.js");
    const { createControlCredentialVerifier } = await import(new URL("runtime/control-credential.js", distRoot).href) as typeof import("../../src/runtime/control-credential.js");
    const { createInitialRuntimeSupportManifest } = await import(new URL("runtime/support-manifest.js", distRoot).href) as typeof import("../../src/runtime/support-manifest.js");
    const application = await createWalletOwnerApplicationFactory(() => client)({ wallet, signal: new AbortController().signal, routes: createRuntimeRouteRegistry({ controlVerifier: createControlCredentialVerifier(credential) }), startupResources: createResourceOwnershipScope().resources, supportManifest: createInitialRuntimeSupportManifest(configuration.chain) });
    const { createAddressTargetResolver } = await import(new URL("chain/address-target.js", distRoot).href) as typeof import("../../src/chain/address-target.js");
    const { createTokenCatalogApplication } = await import(new URL("token-catalog/application.js", distRoot).href) as typeof import("../../src/token-catalog/application.js");
    const addressTargets = createAddressTargetResolver({ chainId: configuration.chain.chainId, activeWallet: application.activeWallet });
    const unexpected = async (): Promise<never> => { throw new Error("This read does not authorize a Token decision."); };
    const queries = createTokenCatalogApplication({ dependencies: { addressTargets, store: database.tokenCatalogReadStore() }, operations: { review: unexpected, decide: unexpected, getOperation: () => { throw new Error("Unexpected operation."); } } });
    const explicit = { kind: "address" as const, address: "0x1111111111111111111111111111111111111111" };
    expect(await queries.listSelections({ account: explicit, limit: 25 })).toMatchObject({ selections: [], nextCursor: null });
    const { walletConnectionCapability } = await import(new URL("wallet/connection-capability.js", distRoot).href) as typeof import("../../src/wallet/connection-capability.js");
    const bindings = new CapabilityBindingRegistry(new CapabilityRegistry([walletConnectionCapability]), [application.walletConnection.connection]);
    expect(await bindings.invoke(walletConnectionCapability, {}, { signal: new AbortController().signal })).toMatchObject({ ok: false, error: { code: "runtime_state_unavailable" } });
    const initializedData = await initialized;
    expect(String(initializedData[0]).trim()).toBe("sdk_initialized");
    await expect(client.observe()).rejects.toMatchObject({ code: "observation" });
    const actualClose = once(child, "close");
    await expect(application.shutdown()).resolves.toEqual({ kind: "released" });
    await actualClose;
    const successor = await openWalletConnectStorage(store); successor.close();
  }, 30_000);

  it("contains parent loss through real IPC disconnect and proves private-store reentry", async () => {
    const relay = await createWorkerRelay(new URL("../package.json", distRoot)); cleanup.push(relay.close);
    const { wallet, store } = await bootstrap();
    const child = fork(fileURLToPath(new URL("wallet/sdk-worker-entry.js", distRoot)), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: ["--import", fileURLToPath(new URL("./worker-egress.mjs", import.meta.url))], env: { LITTLEJOHN_TEST_RELAY_PORT: String(relay.port) } });
    const actualExit = once(child, "exit");
    cleanup.push(async () => { if (child.exitCode !== null || child.signalCode !== null) return; const closed = once(child, "close"); child.kill("SIGKILL"); await closed; });
    const initialized = new Promise<void>((resolve, reject) => {
      child.on("message", (input) => { const message = decodeWalletWorkerMessage(workerMessageSchema, input); if (message.kind === "ready") resolve(); else if (message.kind === "failure") reject(new Error(message.code)); });
      child.once("error", reject);
      child.once("close", (code, signal) => reject(new Error(`Worker exited before ready (${code ?? signal}).`)));
    });
    const { serializeWalletConnectConfiguration } = await import(new URL("wallet/walletconnect-configuration.js", distRoot).href) as typeof import("../../src/wallet/walletconnect-configuration.js");
    child.send(encodeWalletWorkerMessage(workerCommandSchema, { version: "1", generation: Buffer.alloc(32, 2).toString("base64url"), kind: "bootstrap", id: 1, directory: store, sourceKey: exportWalletSourceKey(wallet.sourceAuthority), storeSourceId: wallet.sourceAuthority.sdkStoreSourceId, configuration: serializeWalletConnectConfiguration(wallet.configuration), relayUrl: relay.url }));
    await initialized;
    child.disconnect();
    await actualExit;

    const successor = await openWalletConnectStorage(store); successor.close();
  }, 30_000);

  it("keeps an uncertain request reserved after lost IPC and an unconfirmed kill until actual close", async () => {
    const { wallet } = await bootstrap();
    class Driver extends EventEmitter {
      kills = 0;
      generation = "";
      send(input: string, callback: (error: Error | null) => void): void {
        const message = decodeWalletWorkerMessage(workerCommandSchema, input);
        this.generation = message.generation;
        callback(null);
        if (message.kind === "bootstrap") this.emit("message", encodeWalletWorkerMessage(workerMessageSchema, { version: "1", generation: this.generation, kind: "ready", id: message.id }));
      }
      kill(): boolean { this.kills += 1; return false; }
    }
    const driver = new Driver();
    const client = new WalletSdkWorkerClient(wallet, new AbortController().signal, { spawn: () => driver as unknown as ChildProcess });
    const initialization = ready(client);
    await initialization;
    const source = wallet.sourceAuthority.createSessionSource("3".repeat(64));
    const attempt = await client.startRequest(signingInput(source.sourceId));
    driver.emit("message", "{}");
    expect(await attempt.response).toEqual({ status: "delivery_unknown", reason: "sdk_error" });
    expect(client.hasPendingRequest()).toBe(true);
    let actualSettled = false;
    void attempt.settlement.then(() => { actualSettled = true; });
    vi.useFakeTimers();
    try {
      const closing = client.contain();
      const failure = closing.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(await failure).toMatchObject({ name: "ProcessTerminalRequiredError" });
      expect(actualSettled).toBe(false);
      expect(driver.kills).toBe(2);
      driver.emit("close");
      expect(await attempt.settlement).toEqual({ status: "delivery_unknown", reason: "shutdown" });
      expect(client.hasPendingRequest()).toBe(false);
    } finally { driver.emit("close"); vi.useRealTimers(); }
  });

});
