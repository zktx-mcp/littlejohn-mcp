import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJsonStringify, captureCanonicalJson, decodeCanonicalBase64Url } from "../core/index.js";
import { deriveControlCredentialKey, type LocalControlCredentialAuthority } from "./control-credential.js";
import { createOwnerOnlyStateFileForWrite, ensureOwnerOnlyDirectory, openOwnerOnlyStateFileForRead, syncDirectory } from "./paths.js";
import { parseOwnerInstanceId, parseProfileId, parseRuntimeRevision } from "./runtime-identity.js";
import { runtimeShutdownRecordSchema, runtimeShutdownRecordMaximumBytes,
  type RuntimeShutdownObservation, type RuntimeShutdownRecord, type RuntimeShutdownTarget } from "./management-contract.js";

type UnsignedRecord = Omit<RuntimeShutdownRecord, "proof">;
const resultDirectory = (directory: string): string => join(directory, "runtime-shutdown");
const resultPath = (directory: string, id: string): string =>
  join(resultDirectory(directory), `${parseOwnerInstanceId(id)}.json`);

const proof = (credential: LocalControlCredentialAuthority, value: UnsignedRecord): string => {
  const key = deriveControlCredentialKey(credential, "littlejohn/runtime-shutdown/v1");
  try { return createHmac("sha256", key).update(canonicalJsonStringify(captureCanonicalJson(value))).digest("base64url"); }
  finally { key.fill(0); }
};

const readRecord = async (directory: string, id: string): Promise<RuntimeShutdownRecord> => {
  const maximum = runtimeShutdownRecordMaximumBytes + 1; // canonical carrier plus line feed
  const file = await openOwnerOnlyStateFileForRead(resultPath(directory, id), { maximum });
  try {
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > maximum) throw new TypeError("Runtime shutdown result exceeds its carrier.");
    return runtimeShutdownRecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))));
  } finally { await file.close(); }
};

export const readRuntimeShutdownResult = async (input: {
  directory: string; credential: LocalControlCredentialAuthority;
  target: Readonly<{ profileId: string; ownerInstanceId: string; ownerRevision?: string }>;
}): Promise<RuntimeShutdownObservation> => {
  const target = { profileId: parseProfileId(input.target.profileId),
    ownerInstanceId: parseOwnerInstanceId(input.target.ownerInstanceId),
    ...(input.target.ownerRevision === undefined ? {} : { ownerRevision: parseRuntimeRevision(input.target.ownerRevision) }) };
  try {
    const value = await readRecord(input.directory, target.ownerInstanceId);
    const { proof: signed, ...unsigned } = value;
    if (value.profileId !== target.profileId || value.ownerInstanceId !== target.ownerInstanceId ||
        (target.ownerRevision !== undefined && value.ownerRevision !== target.ownerRevision) ||
        !timingSafeEqual(decodeCanonicalBase64Url(signed, 32), decodeCanonicalBase64Url(proof(input.credential, unsigned), 32))) {
      throw new TypeError("Runtime shutdown result does not match its target.");
    }
    return Object.freeze({ status: "released", target: Object.freeze({ profileId: value.profileId,
      ownerInstanceId: value.ownerInstanceId, ownerRevision: value.ownerRevision }) });
  } catch { return Object.freeze({ status: "shutdown_unconfirmed", target: Object.freeze(target) }); }
};

export const publishRuntimeShutdownResult = async (input: {
  directory: string; credential: LocalControlCredentialAuthority; record: UnsignedRecord;
}): Promise<void> => {
  const value = runtimeShutdownRecordSchema.parse({ ...input.record, proof: proof(input.credential, input.record) });
  const text = `${canonicalJsonStringify(captureCanonicalJson(value))}\n`;
  if (Buffer.byteLength(text) > runtimeShutdownRecordMaximumBytes + 1) throw new TypeError("Runtime shutdown result exceeds its carrier.");
  const directory = resultDirectory(input.directory);
  await ensureOwnerOnlyDirectory(directory);
  const path = resultPath(input.directory, value.ownerInstanceId);
  const pending = `${path}.pending-${process.pid}-${randomBytes(16).toString("hex")}`;
  let created = false;
  try {
    const handle = await createOwnerOnlyStateFileForWrite(pending);
    created = true;
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    try { await link(pending, path); await syncDirectory(directory); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const existing = await readRecord(input.directory, value.ownerInstanceId);
      if (canonicalJsonStringify(captureCanonicalJson(existing)) !== canonicalJsonStringify(captureCanonicalJson(value))) {
        throw new TypeError("An immutable shutdown result already has another value.");
      }
    }
  } finally {
    if (created) { await unlink(pending); await syncDirectory(directory); }
  }
};

export const waitForRuntimeShutdownResult = async (input: {
  directory: string; credential: LocalControlCredentialAuthority; target: RuntimeShutdownTarget;
  deadline: number; signal?: AbortSignal;
}): Promise<RuntimeShutdownObservation> => {
  const read = () => readRuntimeShutdownResult(input);
  const first = await read();
  if (first.status === "released" || input.signal?.aborted) return first;
  return new Promise<RuntimeShutdownObservation>((resolve) => {
    let ended = false;
    let reading = false;
    let again = false;
    let finalRead = false;
    let resultWatcher: FSWatcher | undefined;
    let parentWatcher: FSWatcher | undefined;
    const done = (value: RuntimeShutdownObservation): void => {
      if (ended) return;
      ended = true; clearTimeout(timer); resultWatcher?.close(); parentWatcher?.close();
      input.signal?.removeEventListener("abort", abort); resolve(value);
    };
    const inspect = async (): Promise<void> => {
      if (ended) return;
      if (reading) { again = true; return; }
      reading = true;
      do {
        again = false;
        if (resultWatcher === undefined) {
          try {
            resultWatcher = watch(resultDirectory(input.directory), { persistent: false }, (_event, name) => {
              if (name === null || name.toString() === `${input.target.ownerInstanceId}.json`) void inspect();
            });
            resultWatcher.on("error", () => { resultWatcher?.close(); resultWatcher = undefined; });
          } catch { /* The backend may not have created its result directory yet. */ }
        }
        // A read already in flight when the deadline fires may still return
        // its earlier missing-file observation. Only a read started after the
        // final request can consume that request; inspect() coalesces another.
        const terminalObservation = finalRead || input.signal?.aborted === true;
        const value = await read();
        if (value.status === "released" || terminalObservation) done(value);
      } while (again && !ended);
      reading = false;
    };
    const abort = (): void => { finalRead = true; void inspect(); };
    const timer = setTimeout(() => { finalRead = true; void inspect(); }, Math.max(0, input.deadline - performance.now()));
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      parentWatcher = watch(input.directory, { persistent: false }, (_event, name) => {
        if (name === null || name.toString() === "runtime-shutdown") void inspect();
      });
      parentWatcher.on("error", () => { parentWatcher?.close(); parentWatcher = undefined; });
    } catch { /* The final bounded read still distinguishes a result from an unavailable path. */ }
    void inspect();
  });
};
