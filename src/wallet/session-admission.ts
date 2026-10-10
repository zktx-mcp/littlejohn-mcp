import { parseCapabilityDataAt, parseUtcTimestamp, type UtcTimestamp} from "../core/index.js";
import {normalizeWalletNamespaces} from "./account-admission.js";
import {walletConnectionCapability} from "./connection-capability.js";
import {type WalletConnectionData} from "./connection-contract.js";
import type { WalletSessionSource } from "../runtime/source-identity.js";
import type { WalletConnectSessionSnapshot } from "./client-contract.js";
import type { WalletConnectSessionRequirements } from "./walletconnect-configuration.js";

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
  _requirements: WalletConnectSessionRequirements,
  evaluatedAt: UtcTimestamp,
): WalletSessionAdmission => {
  if (session.status !== "valid") {
    return Object.freeze({
      status: "invalid" as const,
      reason: "adapter_invalid" as const,
      source: session.source,
    });
  }
  let namespaces;
  try { namespaces = normalizeWalletNamespaces(session.namespaces); }
  catch { return Object.freeze({ status: "invalid", reason: "namespace", source: session.source }); }
  if (!Number.isSafeInteger(session.expiry) || session.expiry <= 0) {
    return Object.freeze({ status: "invalid", reason: "expiry", source: session.source });
  }
  let expiresAt: UtcTimestamp;
  try { expiresAt = parseUtcTimestamp(new Date(session.expiry * 1_000).toISOString()); }
  catch { return Object.freeze({ status: "invalid", reason: "expiry", source: session.source }); }
  try {
    const connection = parseCapabilityDataAt(walletConnectionCapability, {
      status: "connected",
      connectionId: session.source.sourceId,
      namespaces,
      expiresAt,
    }, evaluatedAt);
    if (connection.status !== "connected") throw new TypeError("Connected projection expected.");
    return Object.freeze({ status: "valid", source: session.source, connection });
  } catch {
    return Object.freeze({ status: "invalid", reason: "expiry", source: session.source });
  }
};
