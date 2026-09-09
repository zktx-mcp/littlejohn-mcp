import { EventEmitter, once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openWalletConnectStorage } from "../../src/wallet/walletconnect-storage.js";
import {
  createWalletConnectTransactionResources,
  type WalletConnectProtocolResources,
} from "../../src/wallet/transaction-resources.js";

const require = createRequire(import.meta.url);
type SdkHistory = WalletConnectProtocolResources["history"] & {
  init(): Promise<void>; set(topic: string, value: unknown): void;
  exists(topic: string, id: number): Promise<boolean>;
};
type SdkMessages = WalletConnectProtocolResources["messages"] & {
  init(): Promise<void>; set(topic: string, message: string, direction: "inbound" | "outbound"): Promise<string>;
  get(topic: string): Record<string, string>;
};
type SdkCrypto = WalletConnectProtocolResources["crypto"] & {
  init(): Promise<void>; setSymKey(key: string, topic: string): Promise<string>;
  encode(topic: string, payload: unknown): Promise<string>;
};
const { Core } = require("@walletconnect/core") as {
  Core: new (options: unknown) => {
    history: SdkHistory; crypto: SdkCrypto;
    relayer: {
      events: EventEmitter; messages: SdkMessages;
      publisher: WalletConnectProtocolResources["publisher"];
      request(input: unknown): Promise<unknown>;
    };
  };
};
const { JsonRpcProvider } = require("@walletconnect/jsonrpc-provider") as {
  JsonRpcProvider: new (connection: unknown) => {
    events: EventEmitter; request(input: unknown): Promise<unknown>;
  };
};
const topic = "a".repeat(64);
const cleanups: (() => Promise<void>)[] = [];
const noLog = () => undefined;
const logger = { level: "warn", child: () => logger, trace: noLog, debug: noLog, info: noLog, warn: noLog, error: noLog, fatal: noLog };

const fixture = async (publicationFails = false) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
  const root = await mkdtemp(resolve(tmpdir(), "littlejohn-request-resources-"));
  if (process.platform !== "win32") await chmod(root, 0o700);
  const owner = await openWalletConnectStorage(root);
  vi.stubEnv("DISABLE_GLOBAL_CORE", "true");
  // Construct the public SDK Core without starting its network or heartbeat.
  // Its Relayer supplies the actual (non-exported) Publisher instance.
  const core = new Core({ storage: owner.storage, telemetryEnabled: false, logger });
  const history = core.history;
  const messages = core.relayer.messages;
  const crypto = core.crypto;
  await history.init(); await messages.init(); await crypto.init();
  await crypto.setSymKey("11".repeat(32), topic);
  const connectionEvents = new EventEmitter();
  const connection = {
    connected: true, url: "wss://example.invalid", connecting: false,
    on: connectionEvents.on.bind(connectionEvents),
    open: async () => undefined, close: async () => undefined,
    send: async (request: { id: string }) => {
      if (publicationFails) throw new Error("Offline test transport.");
      connectionEvents.emit("payload", { id: request.id, jsonrpc: "2.0", result: true });
    },
  };
  const provider = new JsonRpcProvider(connection);
  const relayerEvents = core.relayer.events;
  const engineEvents = new EventEmitter();
  core.relayer.request = provider.request.bind(provider);
  const publisher = core.relayer.publisher;
  const failed = vi.fn();
  const tracker = createWalletConnectTransactionResources({
    storageOwner: owner, history, messages, crypto, publisher,
    relayerEvents, engineEvents, providerEvents: provider.events,
  }, failed);
  cleanups.push(async () => {
    await tracker.close();
    relayerEvents.removeAllListeners();
    connectionEvents.removeAllListeners();
    owner.close();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });
  const payload = (id: number, params: object) => ({
    id, jsonrpc: "2.0", method: "wc_sessionRequest", params: {
      chainId: "eip155:4663",
      request: { method: "eth_sendTransaction", params, expiryTimestamp: Math.floor(Date.now() / 1_000) + 300 },
    },
  });
  const admit = async (id: number, params: object) => {
    const ready = once(history.events, "history_sync");
    history.set(topic, payload(id, params));
    await ready;
  };
  return { owner, history, messages, crypto, publisher, relayerEvents, provider, engineEvents, tracker, failed, admit, payload };
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("WalletConnect transaction protocol resources", () => {
  it("retires only the owned request and ciphertext at protocol expiry", async () => {
    const test = await fixture();
    const prior = await test.crypto.encode(topic, { id: 1, result: true });
    const priorKey = await test.messages.set(topic, prior, "inbound");
    const params = [{ data: "0x12345678", nonce: "0x7" }];
    const request = test.tracker.begin(topic, params);
    const outgoing = await test.crypto.encode(topic, test.payload(7, params));
    await test.admit(7, params);
    expect(request.entered).toBe(true);
    const options = { id: "77", tag: 1108, ttl: 300, internal: { throwOnFailedPublish: true } };
    await test.publisher.publish(topic, outgoing, options);
    const outgoingKey = await test.messages.set(topic, outgoing, "outbound");
    const response = await test.crypto.encode(topic, { id: 7, result: `0x${"ab".repeat(32)}` });
    const responseKey = await test.messages.set(topic, response, "inbound");
    await test.crypto.decode(topic, response);
    test.engineEvents.on("session_request:7", noLog);
    test.engineEvents.on("session_request:8", noLog);
    request.finish();
    expect(await test.history.exists(topic, 7)).toBe(false);
    expect(test.engineEvents.listenerCount("session_request:7")).toBe(0);
    expect(test.engineEvents.listenerCount("session_request:8")).toBe(1);
    expect(test.messages.get(topic)[outgoingKey]).toBe(outgoing);
    expect(test.messages.get(topic)[responseKey]).toBe(response);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(test.messages.get(topic)).toEqual({ [priorKey]: prior });
    expect(await test.owner.storage.getItem("wc@2:core:0.3//messages"))
      .toEqual({ [topic]: { [priorKey]: prior } });
    expect(await test.owner.storage.getItem("wc@2:core:0.3//messages_withoutClientAck"))
      .toEqual({ [topic]: { [priorKey]: prior } });
    expect((await test.owner.storage.getKeys()).some((key) => key.startsWith("littlejohn:wallet_request:"))).toBe(false);
    expect(test.failed).not.toHaveBeenCalled();
  });

  it("releases the actual publisher's failed-publication listener without removing other work", async () => {
    const test = await fixture(true);
    const unrelated = vi.fn();
    test.relayerEvents.on("relayer_publish", unrelated);
    test.provider.events.on("88", unrelated);
    const params = [{ data: "0x12345678" }];
    const request = test.tracker.begin(topic, params);
    const outgoing = await test.crypto.encode(topic, test.payload(7, params));
    await test.admit(7, params);
    const options = { id: "77", tag: 1108, ttl: 300, internal: { throwOnFailedPublish: true } };
    const work = test.publisher.publish(topic, outgoing, options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await work).toBeInstanceOf(Error);
    expect(test.relayerEvents.listenerCount("relayer_publish")).toBe(2);
    request.finish();
    expect(test.relayerEvents.listeners("relayer_publish")).toEqual([unrelated]);
    expect(test.provider.events.listenerCount("77")).toBe(0);
    expect(test.provider.events.listeners("88")).toEqual([unrelated]);
    expect(test.publisher.queue.size).toBe(0);
    expect(test.failed).not.toHaveBeenCalled();
  });

  it("does not correlate an independently created request by equal payload text", async () => {
    const test = await fixture();
    const params = [{ data: "0x1234" }];
    const request = test.tracker.begin(topic, params);
    await test.admit(8, [{ data: "0x1234" }]);
    expect(request.entered).toBe(false);
    await test.admit(7, params);
    request.finish();
    expect(await test.history.exists(topic, 7)).toBe(false);
    expect(await test.history.exists(topic, 8)).toBe(true);
    await test.tracker.close();
    expect(() => test.tracker.begin(topic, params)).toThrow("unavailable");
  });

  it("refuses a delayed SDK continuation after its request lifetime while another request is active", async () => {
    const test = await fixture();
    const params = [{ data: "0x1234" }];
    test.tracker.begin(topic, params);
    const oldPayload = test.payload(7, params);
    await vi.advanceTimersByTimeAsync(300_000);
    const current = [{ data: "0xabcd" }];
    test.tracker.begin(topic, current);
    await expect(test.crypto.encode(topic, oldPayload)).rejects.toThrow("no active local owner");
    await expect(test.crypto.encode(topic, test.payload(8, current))).resolves.toEqual(expect.any(String));
    await test.tracker.close();
    await expect(test.crypto.encode(topic, test.payload(8, current))).rejects.toThrow("no active local owner");
  });
});
