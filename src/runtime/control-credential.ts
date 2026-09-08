import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { link, readdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { decodeCanonicalBase64Url } from "../core/index.js";
import {
  readConfiguredRpcEndpoint,
  readRuntimeChainConfiguration,
  type RuntimeConfiguration,
} from "./configuration.js";
import { readWalletConnectConfigurationIdentity } from "../wallet/walletconnect-configuration.js";
import {
  syncDirectory,
  createOwnerOnlyStateFileForWrite,
  ensureOwnerOnlyDirectory,
  openOwnerOnlyStateFileForRead,
  OwnerOnlyStateFileError,
} from "./paths.js";
import { RuntimeOperationError } from "./errors.js";
import {
  parseRuntimeConfigurationMac,
  type RuntimeConfigurationMac,
} from "./runtime-identity.js";

export interface LocalControlCredentialAuthority {
  readonly __localControlCredentialAuthority: unique symbol;
}

export interface ControlCredentialVerifier {
  readonly __controlCredentialVerifier: unique symbol;
}

const credentialStates = new WeakMap<object, Uint8Array>();
const verifierStates = new WeakMap<object, LocalControlCredentialAuthority>();

const authorityBytes = (authority: LocalControlCredentialAuthority): Uint8Array => {
  const bytes = typeof authority === "object" && authority !== null
    ? credentialStates.get(authority)
    : undefined;
  if (bytes === undefined) throw new TypeError("Local control credential authority provenance is invalid.");
  return bytes;
};

const createAuthority = (bytes: Uint8Array): LocalControlCredentialAuthority => {
  if (bytes.length !== 32) throw new TypeError("A local control credential contains exactly 32 bytes.");
  const authority = Object.freeze({}) as LocalControlCredentialAuthority;
  credentialStates.set(authority, new Uint8Array(bytes));
  return authority;
};

export const createControlCredentialVerifier = (
  authority: LocalControlCredentialAuthority,
): ControlCredentialVerifier => {
  authorityBytes(authority);
  const verifier = Object.freeze({}) as ControlCredentialVerifier;
  verifierStates.set(verifier, authority);
  return verifier;
};

const parseCredentialContent = (content: string): LocalControlCredentialAuthority => {
  if (content.length !== 44 || content.at(-1) !== "\n") {
    throw new Error("The local control credential is malformed.");
  }
  try {
    return createAuthority(decodeCanonicalBase64Url(content.slice(0, -1), 32));
  } catch {
    throw new Error("The local control credential is malformed.");
  }
};

const readCredentialFile = async (credentialPath: string): Promise<LocalControlCredentialAuthority> => {
  let handle;
  try {
    handle = await openOwnerOnlyStateFileForRead(credentialPath, { exact: 44 });
  } catch (error) {
    if (
      error instanceof OwnerOnlyStateFileError &&
      (error.failure === "owner" || error.failure === "permissions")
    ) throw new Error("The local control credential permissions are invalid.");
    if (error instanceof OwnerOnlyStateFileError) {
      throw new Error("The local control credential is malformed.");
    }
    throw error;
  }
  try {
    const content = Buffer.alloc(45);
    let bytesRead = 0;
    while (bytesRead < content.length) {
      const result = await handle.read(content, bytesRead, content.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== 44) throw new Error("The local control credential is malformed.");
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, bytesRead));
    } catch {
      throw new Error("The local control credential is malformed.");
    }
    return parseCredentialContent(decoded);
  } finally {
    await handle.close();
  }
};

const removePublishedPendingFiles = async (credentialPath: string): Promise<void> => {
  const directory = dirname(credentialPath);
  const prefix = `${basename(credentialPath)}.pending-`;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    try { await unlink(resolve(directory, entry.name)); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "EPERM" && error.code !== "EBUSY")) throw error;
    }
  }
};

const existingCredential = async (credentialPath: string): Promise<LocalControlCredentialAuthority | undefined> => {
  try { return await readCredentialFile(credentialPath); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
};

const loadOrCreateControlCredentialState = async (
  dataDirectory: string,
  credentialPath: string,
): Promise<LocalControlCredentialAuthority> => {
  await ensureOwnerOnlyDirectory(dataDirectory);
  const current = await existingCredential(credentialPath);
  if (current !== undefined) {
    await removePublishedPendingFiles(credentialPath);
    return current;
  }

  const bytes = randomBytes(32);
  const encoded = bytes.toString("base64url");
  const pendingPath = `${credentialPath}.pending-${process.pid}-${randomBytes(16).toString("base64url")}`;
  let published = false;
  let pendingCreated = false;
  let handle: FileHandle | undefined;
  try {
    handle = await createOwnerOnlyStateFileForWrite(pendingPath);
    pendingCreated = true;
    try {
      await handle.writeFile(`${encoded}\n`, { encoding: "utf8" });
      await handle.sync();
    } finally {
      const opened = handle;
      handle = undefined;
      await opened.close();
    }
    try {
      await link(pendingPath, credentialPath);
      published = true;
      await syncDirectory(dirname(credentialPath));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) ||
        (error.code !== "EEXIST" && error.code !== "ENOENT")) throw error;
    }
  } finally {
    try { await handle?.close(); } catch { /* Preserve the publication failure. */ }
    if (pendingCreated) {
      try { await unlink(pendingPath); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    if (published) await syncDirectory(dirname(credentialPath));
  }
  const authority = await readCredentialFile(credentialPath);
  await removePublishedPendingFiles(credentialPath);
  return authority;
};

export const loadOrCreateControlCredential = async (
  dataDirectory: string,
  credentialPath: string,
): Promise<LocalControlCredentialAuthority> => {
  try { return await loadOrCreateControlCredentialState(dataDirectory, credentialPath); }
  catch (error) {
    if (error instanceof RuntimeOperationError) throw error;
    throw new RuntimeOperationError("runtime_state_unavailable");
  }
};

export const validateControlCredential = (
  verifier: ControlCredentialVerifier,
  candidate: string,
): boolean => {
  const authority = typeof verifier === "object" && verifier !== null
    ? verifierStates.get(verifier)
    : undefined;
  if (authority === undefined) throw new TypeError("Control credential verifier provenance is invalid.");
  try {
    return timingSafeEqual(Buffer.from(authorityBytes(authority)), decodeCanonicalBase64Url(candidate, 32));
  } catch {
    return false;
  }
};

export const createControlAuthorizationHeader = (
  authority: LocalControlCredentialAuthority,
): string => `Bearer ${Buffer.from(authorityBytes(authority)).toString("base64url")}`;

export const signControlPayload = (
  authority: LocalControlCredentialAuthority,
  payload: Uint8Array,
): string => createHmac("sha256", authorityBytes(authority)).update(payload).digest("base64url");

export const verifyControlPayload = (
  authority: LocalControlCredentialAuthority,
  payload: Uint8Array,
  candidate: string,
): boolean => {
  try {
    return timingSafeEqual(
      decodeCanonicalBase64Url(signControlPayload(authority, payload), 32),
      decodeCanonicalBase64Url(candidate, 32),
    );
  } catch {
    return false;
  }
};

export const deriveControlCredentialKey = (
  authority: LocalControlCredentialAuthority,
  label: string,
): Uint8Array => new Uint8Array(hkdfSync(
  "sha256",
  authorityBytes(authority),
  new Uint8Array(),
  Buffer.from(label, "utf8"),
  32,
));

const encodeLengthPrefixedFields = (fields: readonly Uint8Array[]): Uint8Array => {
  const totalLength = fields.reduce((sum, field) => sum + 4 + field.length, 0);
  const output = Buffer.alloc(totalLength);
  let offset = 0;
  for (const field of fields) {
    output.writeUInt32BE(field.length, offset);
    offset += 4;
    Buffer.from(field).copy(output, offset);
    offset += field.length;
  }
  return output;
};

export const deriveRuntimeConfigurationMac = (
  credential: LocalControlCredentialAuthority,
  configuration: RuntimeConfiguration,
): RuntimeConfigurationMac => {
  if (
    configuration.rpc.chain !== configuration.chain
  ) throw new TypeError("Runtime configuration chain authority is inconsistent.");
  const chain = readRuntimeChainConfiguration(configuration.chain);
  const rpc = readConfiguredRpcEndpoint(configuration.rpc.endpoint);
  const wallet = readWalletConnectConfigurationIdentity(configuration.wallet, chain);
  const key = deriveControlCredentialKey(credential, "littlejohn/runtime-configuration/v1");
  const payload = encodeLengthPrefixedFields([
    Buffer.from(chain.chainId, "utf8"),
    rpc.exactUtf8,
    wallet.projectIdUtf8,
  ]);
  try {
    return parseRuntimeConfigurationMac(
      createHmac("sha256", key).update(payload).digest("base64url"),
    );
  } finally {
    key.fill(0);
    payload.fill(0);
  }
};
