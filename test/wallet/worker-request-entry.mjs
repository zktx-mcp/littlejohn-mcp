import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { runWalletSdkWorker } from "../../dist/wallet/sdk-worker.js";

// Only the raw external SignClient module is replaced. The worker, SQLite,
// SDK adapter, request tracker, source admission and native codecs are real.
const control = new Socket({ fd: 4 });
let pending;
let calls = 0;
let buffer = "";
control.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    if (command.kind === "resolve" && pending !== undefined) { pending.resolve(command.value); pending = undefined; }
    else if (command.kind === "reject" && pending !== undefined) { pending.reject({ code: command.code }); pending = undefined; }
  }
});
const emit = (value) => control.write(JSON.stringify(value) + "\n");
const topic = "3".repeat(64);
const pairingTopic = "2".repeat(64);
const address = "0x1111111111111111111111111111111111111111";
const history = new EventEmitter();
const emitter = new EventEmitter();
class SignClient {
  static async init(options) {
    return {
      proposal: { getAll: () => [] },
      session: { getAll: () => [{ topic, pairingTopic, expiry: Math.floor(Date.now() / 1000) + 3600,
        namespaces: { eip155: { chains: ["eip155:4663"], accounts: [`eip155:4663:${address}`], methods: ["eth_sendTransaction", "personal_sign", "eth_signTypedData_v4"], events: ["accountsChanged", "chainChanged"] } } }] },
      engine: { events: new EventEmitter() },
      core: { storage: options.storage, expirer: { set() {} }, pairing: { getPairings: () => [], disconnect: async () => {} },
        history: { events: history, delete() {} }, crypto: { encode: async () => "opaque", decode: async () => ({}) },
        relayer: { events: new EventEmitter(), provider: { events: new EventEmitter() }, messages: { messages: new Map(), messagesWithoutClientAck: new Map() }, publisher: { queue: new Map(), publish: async () => {} } } },
      connect: async () => { throw new Error("Connection is outside the request fixture."); },
      disconnect: async () => {}, on: (...args) => emitter.on(...args), off: (...args) => emitter.off(...args),
      request(input) {
        calls += 1;
        history.emit("history_created", { topic, id: calls, request: { method: "wc_sessionRequest", params: { request: { ...input.request, expiryTimestamp: Math.floor(Date.now() / 1000) + input.expiry } } } });
        emit({ kind: "requested", calls, input });
        return new Promise((resolve, reject) => { pending = { resolve, reject }; });
      },
    };
  }
}
const require = createRequire(import.meta.url);
runWalletSdkWorker({ send: (message, callback) => process.send(message, callback), on: (event, listener) => process.on(event, listener) },
  (code) => process.exit(code), { moduleLoader: async (key) => key === "signClient" ? { SignClient } : require("qrcode") });
