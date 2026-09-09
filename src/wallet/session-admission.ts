import {
  compareCodePointSequences, fixedIdentifierSchema, parseCaip10EvmAccount,
  parseCapabilityDataAt, parseEvmChainId, parseUtcTimestamp, walletConnectionCapability,
  type UtcTimestamp, type WalletConnectionData,
} from "../core/index.js";
import type { WalletSessionSource } from "../runtime/source-identity.js";
import type { WalletConnectSessionSnapshot } from "./walletconnect-client.js";
import type { WalletConnectSessionRequirements } from "./walletconnect-configuration.js";

const orderedUnique = (values: readonly string[]): readonly string[] | undefined => {
  const ordered = [...values].sort(compareCodePointSequences);
  if (ordered.some((value, index) => index !== 0 && ordered[index - 1] === value)) {
    return undefined;
  }
  return Object.freeze(ordered);
};

export interface AdmittedWalletSession {
  readonly status: "valid";
  readonly source: WalletSessionSource;
  readonly connection: Extract<WalletConnectionData, { readonly status: "connected" }>;
}

export interface RefusedWalletSession {
  readonly status: "invalid";
  readonly source: WalletSessionSource;
  readonly reason:
    | "adapter_invalid"
    | "namespace"
    | "chain"
    | "account"
    | "methods"
    | "events"
    | "expiry";
}

export type WalletSessionAdmission = AdmittedWalletSession | RefusedWalletSession;

export const admitWalletSession = (
  session: WalletConnectSessionSnapshot,
  requirements: WalletConnectSessionRequirements,
  evaluatedAt: UtcTimestamp,
): WalletSessionAdmission => {
  if (session.status !== "valid") {
    return Object.freeze({
      status: "invalid" as const,
      reason: "adapter_invalid" as const,
      source: session.source,
    });
  }
  const keys = Object.keys(session.namespaces).sort(compareCodePointSequences);
  const namespace = session.namespaces["eip155"];
  if (keys.length !== 1 || keys[0] !== "eip155" || namespace === undefined) {
    return Object.freeze({ status: "invalid", reason: "namespace", source: session.source });
  }
  if (namespace.accounts.length !== 1) {
    return Object.freeze({ status: "invalid", reason: "account", source: session.source });
  }
  let account: ReturnType<typeof parseCaip10EvmAccount>;
  try { account = parseCaip10EvmAccount(namespace.accounts[0]); }
  catch { return Object.freeze({ status: "invalid", reason: "account", source: session.source }); }
  if (account.chainId !== requirements.chain.chainId) {
    return Object.freeze({ status: "invalid", reason: "chain", source: session.source });
  }
  if (namespace.chains !== undefined) {
    if (namespace.chains.length !== 1) {
      return Object.freeze({ status: "invalid", reason: "chain", source: session.source });
    }
    try {
      if (parseEvmChainId(namespace.chains[0]) !== account.chainId) {
        return Object.freeze({ status: "invalid", reason: "chain", source: session.source });
      }
    } catch {
      return Object.freeze({ status: "invalid", reason: "chain", source: session.source });
    }
  }
  let admittedMethods: readonly string[];
  try { admittedMethods = namespace.methods.map((method) => fixedIdentifierSchema.parse(method)); }
  catch { return Object.freeze({ status: "invalid", reason: "methods", source: session.source }); }
  const methods = orderedUnique(admittedMethods);
  if (
    methods === undefined ||
    !requirements.requiredMethods.every((method) => methods.includes(method))
  ) return Object.freeze({ status: "invalid", reason: "methods", source: session.source });
  let admittedEvents: readonly string[];
  try { admittedEvents = namespace.events.map((event) => fixedIdentifierSchema.parse(event)); }
  catch { return Object.freeze({ status: "invalid", reason: "events", source: session.source }); }
  const events = orderedUnique(admittedEvents);
  if (
    events === undefined ||
    !requirements.requiredEvents.every((event) => events.includes(event))
  ) return Object.freeze({ status: "invalid", reason: "events", source: session.source });
  if (!Number.isSafeInteger(session.expiry) || session.expiry <= 0) {
    return Object.freeze({ status: "invalid", reason: "expiry", source: session.source });
  }
  let expiresAt: UtcTimestamp;
  try { expiresAt = parseUtcTimestamp(new Date(session.expiry * 1_000).toISOString()); }
  catch { return Object.freeze({ status: "invalid", reason: "expiry", source: session.source }); }
  try {
    const connection = parseCapabilityDataAt(walletConnectionCapability, {
      status: "connected",
      address: account.address,
      chainId: account.chainId,
      approvedMethods: methods,
      approvedEvents: events,
      expiresAt,
    }, evaluatedAt);
    if (connection.status !== "connected") throw new TypeError("Connected projection expected.");
    return Object.freeze({ status: "valid", source: session.source, connection });
  } catch {
    return Object.freeze({ status: "invalid", reason: "expiry", source: session.source });
  }
};
