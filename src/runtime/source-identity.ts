import { createHmac } from "node:crypto";

import {
  createObservationAuthority,
  sourceReferenceSchema,
  type CanonicalClock,
  type ObservationAuthority,
} from "../core/index.js";
import {
  deriveControlCredentialKey,
  type LocalControlCredentialAuthority,
} from "./control-credential.js";
import {
  readConfiguredRpcEndpoint,
  type ConfiguredRpcEndpoint,
} from "./configuration.js";
import type { ProfileId } from "./runtime-identity.js";

export interface RpcSourceAuthorityPort {
  readonly sourceOwner: ConfiguredRpcEndpoint["sourceOwner"];
  readonly publicOrigin: string;
  readonly sourceId: string;
  readonly configurationDigest: string;
  readonly observationAuthority: ObservationAuthority;
}

export interface WalletSourceAuthorityPort {
  readonly sdkStoreSourceId: string;
  readonly sdkStoreAuthority: ObservationAuthority;
  createSessionSource(topic: string): WalletSessionSource;
}

export interface WalletSessionSource {
  readonly sourceId: string;
  readonly candidateId: string;
  readonly topicDigest: string;
  readonly observationAuthority: ObservationAuthority;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const scalarUtf8 = (value: string, name: string): Uint8Array => {
  const bytes = utf8Encoder.encode(value);
  if (bytes.length === 0 || bytes.length > 4_096 || utf8Decoder.decode(bytes) !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid.`);
  }
  return bytes;
};

const digest = (key: Uint8Array, value: Uint8Array): string =>
  createHmac("sha256", key).update(value).digest("base64url");

export const createRpcSourceAuthority = (input: {
  readonly credential: LocalControlCredentialAuthority;
  readonly endpoint: ConfiguredRpcEndpoint;
  readonly clock: CanonicalClock;
}): RpcSourceAuthorityPort => {
  const configured = readConfiguredRpcEndpoint(input.endpoint);
  const key = deriveControlCredentialKey(input.credential, "littlejohn/source-identity/rpc/v1");
  const configurationDigest = digest(key, configured.exactUtf8);
  key.fill(0);
  const sourceId = `rpc:${configurationDigest}`;
  const reference = sourceReferenceSchema.parse({
    kind: "configured_rpc",
    sourceId,
    publicOrigin: input.endpoint.publicOrigin,
    configurationDigest,
  });
  return Object.freeze({
    sourceOwner: input.endpoint.sourceOwner,
    publicOrigin: input.endpoint.publicOrigin,
    sourceId,
    configurationDigest,
    observationAuthority: createObservationAuthority({
      clock: input.clock,
      sourceClass: "chain_rpc",
      owner: input.endpoint.sourceOwner,
      reference,
    }),
  });
};

const walletKeys = new WeakMap<WalletSourceAuthorityPort, Uint8Array>();

export const exportWalletSourceKey = (authority: WalletSourceAuthorityPort): string => {
  const key = walletKeys.get(authority);
  if (key === undefined) throw new TypeError("Wallet source provenance is invalid.");
  return Buffer.from(key).toString("base64url");
};

export const restoreWalletSessionSource = (
  clock: CanonicalClock,
  topicDigest: string,
): WalletSessionSource => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(topicDigest) || Buffer.from(topicDigest, "base64url").toString("base64url") !== topicDigest) {
    throw new TypeError("Wallet session source is invalid.");
  }
  const sourceId = `wallet-session:${topicDigest}`;
  return Object.freeze({
    sourceId, candidateId: sourceId, topicDigest,
    observationAuthority: createObservationAuthority({
      clock, sourceClass: "wallet_session", owner: "WalletConnect session",
      reference: sourceReferenceSchema.parse({ kind: "wallet_session", sourceId, topicDigest }),
    }),
  });
};

export const createWalletSourceAuthorityFromKey = (input: {
  readonly key: Uint8Array;
  readonly profileId: string;
  readonly clock: CanonicalClock;
}): WalletSourceAuthorityPort => {
  if (input.key.byteLength !== 32) throw new TypeError("Wallet source key is invalid.");
  const key = new Uint8Array(input.key);
  const sdkStoreSourceId = `wallet-sdk:${input.profileId}`;
  const sdkStoreAuthority = createObservationAuthority({
    clock: input.clock, sourceClass: "wallet_sdk", owner: "WalletConnect SDK",
    reference: sourceReferenceSchema.parse({ kind: "wallet_sdk", sourceId: sdkStoreSourceId }),
  });
  const authority = Object.freeze({
    sdkStoreSourceId, sdkStoreAuthority,
    createSessionSource(topic: string): WalletSessionSource {
      return restoreWalletSessionSource(input.clock, digest(key, scalarUtf8(topic, "Wallet session topic")));
    },
  });
  walletKeys.set(authority, key);
  return authority;
};

export const createWalletSourceAuthority = (input: {
  readonly credential: LocalControlCredentialAuthority;
  readonly profileId: ProfileId;
  readonly clock: CanonicalClock;
}): WalletSourceAuthorityPort => {
  const key = deriveControlCredentialKey(input.credential, "littlejohn/source-identity/wallet-session/v1");
  try { return createWalletSourceAuthorityFromKey({ key, profileId: input.profileId, clock: input.clock }); }
  finally { key.fill(0); }
};
