import { z } from "zod";
import { captureCanonicalJson, deepFreezeValue, fixedIdentifierSchema, unsignedDecimalSchema, canonicalBase64UrlSchema, isSafeSingleLineText, fixedIdentifierAsciiLengthLimit } from "../core/index.js";
import { parseEvmChainId } from "../evm/identities.js";
import { walletQrMatrixSchema, walletPeerRefusalCodes, walletQrMatrixSizeLimits } from "./operation-contract.js";
import { walletRequestInputSchema, walletRequestResponseSchema } from "./request-contract.js";
import { walletConnectClientErrorCodes } from "./client-contract.js";
import { walletSdkCollectionLimit, walletSdkNamespaceLimit, walletSdkNamespaceArrayLimit, walletSdkTextCodePoints, walletSdkPendingEventLimit } from "./session-limits.js";
import { walletConnectStorageLimits } from "./storage-limits.js";
import { requestReviewLimits } from "../review/request-limits.js";

const text = z.string().max(walletSdkTextCodePoints * 2).refine((v) => [...v].length <= walletSdkTextCodePoints && isSafeSingleLineText(v));
const namespace = z.object({ chains: z.array(text).max(walletSdkNamespaceArrayLimit).optional(), accounts: z.array(text).max(walletSdkNamespaceArrayLimit), methods: z.array(text).max(walletSdkNamespaceArrayLimit), events: z.array(text).max(walletSdkNamespaceArrayLimit) }).strict();
const digest = canonicalBase64UrlSchema(32);
const checkpoint = unsignedDecimalSchema.refine((value) => value.length <= walletConnectStorageLimits.revision.toString().length && BigInt(value) <= walletConnectStorageLimits.revision);
const source = z.object({ topicDigest: digest, sourceId: fixedIdentifierSchema, candidateId: fixedIdentifierSchema }).strict().refine((v) => v.sourceId === `wallet-session:${v.topicDigest}` && v.candidateId === v.sourceId);
export const workerSessionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid"), source, expiry: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), namespaces: z.record(text, namespace).refine((v) => Object.keys(v).length <= walletSdkNamespaceLimit) }).strict(),
  z.object({ status: z.literal("invalid"), source }).strict(),
]);
export const workerObservationSchema = z.object({ proposalCount: z.number().int().min(0).max(walletSdkCollectionLimit), sessions: z.array(workerSessionSchema).max(walletSdkCollectionLimit), revision: checkpoint }).strict().refine((v) => new Set(v.sessions.map((s) => s.source.sourceId)).size === v.sessions.length);
export const workerOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("approved"), session: workerSessionSchema }).strict(),
  z.object({ status: z.literal("rejected"), peerRefusalCode: z.number().refine((v) => (walletPeerRefusalCodes as readonly number[]).includes(v)) }).strict(),
  z.object({ status: z.literal("failed"), failure: z.literal("sdk") }).strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
]);
const chainId = z.string().transform(parseEvmChainId);
export const workerEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observation_changed"), sessionSourceId: fixedIdentifierSchema.optional() }).strict(),
  z.object({ kind: z.literal("accounts_changed"), sessionSourceId: fixedIdentifierSchema, chainId, accounts: z.array(text).max(walletSdkNamespaceArrayLimit) }).strict(),
  z.object({ kind: z.literal("chain_changed"), sessionSourceId: fixedIdentifierSchema, chainId }).strict(),
  z.object({ kind: z.literal("identity_invalid"), sessionSourceId: fixedIdentifierSchema }).strict(),
  z.object({ kind: z.literal("identity_unattributed") }).strict(),
]);
const loopbackRelay = z.string().refine((value) => {
  try { const url = new URL(value); return url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port !== "" && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === ""; } catch { return false; }
});
const header = { version: z.literal("1"), generation: digest };
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const workerCommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...header, kind: z.literal("bootstrap"), id, directory: z.string().min(1), sourceKey: digest, storeSourceId: fixedIdentifierSchema, configuration: z.unknown(), relayUrl: loopbackRelay.optional() }).strict(),
  z.object({ ...header, kind: z.literal("observe"), id }).strict(),
  z.object({ ...header, kind: z.literal("connect"), id }).strict(),
  z.object({ ...header, kind: z.literal("contain_pending"), id }).strict(),
  z.object({ ...header, kind: z.literal("shutdown"), id }).strict(),
  z.object({ ...header, kind: z.literal("cancel"), id, attemptId: id }).strict(),
  z.object({ ...header, kind: z.literal("disconnect"), id, sourceId: fixedIdentifierSchema }).strict(),
  z.object({ ...header, kind: z.literal("request"), id, input: walletRequestInputSchema }).strict(),
]);
export const workerMessageSchema = z.discriminatedUnion("kind", [
  z.object({ ...header, kind: z.literal("ready"), id }).strict(),
  z.object({ ...header, kind: z.literal("failure"), id, code: z.enum(walletConnectClientErrorCodes) }).strict(),
  z.object({ ...header, kind: z.literal("observation_start"), id, proposalCount: z.number().int().min(0).max(walletSdkCollectionLimit), sessionCount: z.number().int().min(0).max(walletSdkCollectionLimit), revision: checkpoint }).strict(),
  z.object({ ...header, kind: z.literal("observation_session"), id, index: z.number().int().min(0).max(walletSdkCollectionLimit - 1), session: workerSessionSchema }).strict(),
  z.object({ ...header, kind: z.literal("observed"), id }).strict(),
  z.object({ ...header, kind: z.literal("connected"), id, qr: walletQrMatrixSchema }).strict(),
  z.object({ ...header, kind: z.literal("connection_outcome"), id, outcome: workerOutcomeSchema }).strict(),
  z.object({ ...header, kind: z.literal("acknowledged"), id }).strict(),
  z.object({ ...header, kind: z.literal("response"), id, outcome: walletRequestResponseSchema }).strict(),
  z.object({ ...header, kind: z.literal("settlement"), id, outcome: walletRequestResponseSchema }).strict(),
  z.object({ ...header, kind: z.literal("event"), event: workerEventSchema }).strict(),
]);
export type WalletWorkerCommand = z.infer<typeof workerCommandSchema>;
export type WalletWorkerMessage = z.infer<typeof workerMessageSchema>;
export type WalletWorkerSession = z.infer<typeof workerSessionSchema>;

// Safe scalar text uses at most four UTF-8 bytes per code point. These bounds cover
// the owning SDK collections, keys, optional chains, QR and request envelopes.
const quoted = (characters: number): number => characters * 4 + 2;
const arrayBytes = (count: number, item: number): number => 2 + count * (item + 1);
const objectBytes = (fields: readonly [number, number][]): number => 2 + fields.reduce((n, [key, value]) => n + quoted(key) + 1 + value + 1, 0);
const namespaceBytes = objectBytes([ [6, arrayBytes(walletSdkNamespaceArrayLimit, quoted(walletSdkTextCodePoints))], [8, arrayBytes(walletSdkNamespaceArrayLimit, quoted(walletSdkTextCodePoints))], [7, arrayBytes(walletSdkNamespaceArrayLimit, quoted(walletSdkTextCodePoints))], [6, arrayBytes(walletSdkNamespaceArrayLimit, quoted(walletSdkTextCodePoints))] ]);
const sourceBytes = objectBytes([[11, quoted(43)], [8, quoted(fixedIdentifierAsciiLengthLimit)], [11, quoted(fixedIdentifierAsciiLengthLimit)]]);
const sessionBytes = objectBytes([[6, quoted(7)], [6, sourceBytes], [6, 16], [10, objectBytes(Array.from({ length: walletSdkNamespaceLimit }, () => [walletSdkTextCodePoints, namespaceBytes] as [number, number]))]]);
const observationHeaderBytes = objectBytes([[13, 3], [12, 3], [8, quoted(walletConnectStorageLimits.revision.toString().length)]]);
const envelopeBytes = objectBytes([[7, quoted(1)], [10, quoted(43)], [4, quoted(32)], [2, 16]]);
const qrBytes = objectBytes([[4, 3], [4, arrayBytes(walletQrMatrixSizeLimits.maximum, quoted(walletQrMatrixSizeLimits.maximum))]]);
export const walletWorkerMessageByteLimit = envelopeBytes + Math.max(sessionBytes + quoted(7) + 3, observationHeaderBytes, qrBytes, requestReviewLimits.reviewUtf8Bytes);
// One lifecycle reply, one observation frame, three management completions
// (QR, outcome, cancellation), and two financial completions, plus SDK events.
export const walletWorkerQueueLimit = walletSdkPendingEventLimit + 1 + 1 + 3 + 2;

export const encodeWalletWorkerMessage = (schema: typeof workerCommandSchema | typeof workerMessageSchema, input: unknown): string => {
  const data = schema.parse(captureCanonicalJson(input));
  const encoded = JSON.stringify(data);
  if (Buffer.byteLength(encoded) > walletWorkerMessageByteLimit) throw new TypeError("Wallet worker message exceeds its byte boundary.");
  return encoded;
};
export const decodeWalletWorkerMessage = <Schema extends typeof workerCommandSchema | typeof workerMessageSchema>(schema: Schema, input: unknown): z.infer<Schema> => {
  if (typeof input !== "string" || Buffer.byteLength(input) > walletWorkerMessageByteLimit) throw new TypeError("Wallet worker message is invalid.");
  return deepFreezeValue(schema.parse(JSON.parse(input))) as z.infer<Schema>;
};

export const createWalletWorkerSender = (send: (message: string, callback: (error: Error | null) => void) => void, fail: () => void) => {
  type Entry = { value: string; resolve(): void; reject(error: Error): void };
  const queue: Entry[] = [];
  let active: Entry | undefined;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    const error = new Error("Wallet worker IPC is unavailable.");
    active?.reject(error);
    active = undefined;
    for (const entry of queue.splice(0)) entry.reject(error);
  };
  const flush = (): void => {
    if (closed || active !== undefined || queue.length === 0) return;
    const entry = queue.shift()!;
    active = entry;
    try { send(entry.value, (error) => {
      if (closed) return;
      active = undefined;
      if (error !== null) { entry.reject(error); close(); fail(); }
      else { entry.resolve(); flush(); }
    }); }
    catch { close(); fail(); }
  };
  return Object.freeze({
    send(schema: typeof workerCommandSchema | typeof workerMessageSchema, message: unknown): Promise<void> {
      if (closed || queue.length + Number(active !== undefined) >= walletWorkerQueueLimit) throw new TypeError("Wallet worker IPC is unavailable.");
      const value = encodeWalletWorkerMessage(schema, message);
      return new Promise<void>((resolve, reject) => { queue.push({ value, resolve, reject }); flush(); });
    },
    close,
  });
};
