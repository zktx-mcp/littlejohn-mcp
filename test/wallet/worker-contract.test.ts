import { describe, expect, it } from "vitest";
import { decodeWalletWorkerMessage, encodeWalletWorkerMessage, workerMessageSchema, createWalletWorkerSender, walletWorkerMessageByteLimit, walletWorkerQueueLimit } from "../../src/wallet/worker-contract.js";
import { walletSdkNamespaceLimit, walletSdkNamespaceArrayLimit, walletSdkTextCodePoints } from "../../src/wallet/session-limits.js";

const generation = Buffer.alloc(32, 1).toString("base64url");
const source = { topicDigest: generation, sourceId: `wallet-session:${generation}`, candidateId: `wallet-session:${generation}` };
describe("Wallet worker transport admission", () => {
  it("preserves a maximum scalar/namespace session frame and rejects excess bytes before parsing", () => {
    const text = "𐀀".repeat(walletSdkTextCodePoints);
    const values = Array.from({ length: walletSdkNamespaceArrayLimit }, () => text);
    const namespaces = Object.fromEntries(Array.from({ length: walletSdkNamespaceLimit }, (_, i) => [text.slice(0, -2) + String.fromCodePoint(0x10000 + i), { accounts: values, methods: values, events: values, chains: values }]));
    const frame = { version: "1", generation, kind: "observation_session", id: 1, index: 0, session: { status: "valid", source, expiry: Number.MAX_SAFE_INTEGER, namespaces } };
    const encoded = encodeWalletWorkerMessage(workerMessageSchema, frame);
    expect(decodeWalletWorkerMessage(workerMessageSchema, encoded)).toEqual(frame);
    // Trailing whitespace is valid JSON, so its rejection proves the byte
    // boundary rather than an unrelated JSON syntax failure.
    const excess = encoded + " ".repeat(walletWorkerMessageByteLimit - Buffer.byteLength(encoded) + 1);
    expect(() => decodeWalletWorkerMessage(workerMessageSchema, excess)).toThrow("invalid");
    expect(() => encodeWalletWorkerMessage(workerMessageSchema, { ...frame, session: { ...frame.session, namespaces: { ...namespaces, additional: namespaces[Object.keys(namespaces)[0]!] } } })).toThrow();
  });
  it("bounds queued writes while respecting backpressure and closes all pending send promises", async () => {
    const callbacks: ((error: Error | null) => void)[] = [];
    const sent: string[] = [];
    const sender = createWalletWorkerSender((value, callback) => { sent.push(value); callbacks.push(callback); }, () => { throw new Error("Unexpected transport failure."); });
    const frame = { version: "1", generation, kind: "ready", id: 1 };
    const pending = Array.from({ length: walletWorkerQueueLimit }, () => sender.send(workerMessageSchema, frame).catch(() => undefined));
    expect(sent).toHaveLength(1);
    expect(() => sender.send(workerMessageSchema, frame)).toThrow("unavailable");
    callbacks.shift()!(null);
    expect(sent).toHaveLength(2);
    sender.close();
    await Promise.all(pending);
  });
});
