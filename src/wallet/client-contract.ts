import type { EvmChainId } from "../evm/identities.js";
import type { WalletSessionSource } from "../runtime/source-identity.js";
import type { WalletPeerRefusalCode, WalletQrMatrix } from "./contracts.js";
import type { WalletRequestInput, WalletRequestAttempt } from "./request-contract.js";

export interface WalletConnectNamespaceSnapshot {
  readonly chains?: readonly string[];
  readonly accounts: readonly string[];
  readonly methods: readonly string[];
  readonly events: readonly string[];
}

export type WalletConnectSessionSnapshot =
  | Readonly<{
      status: "valid";
      source: WalletSessionSource;
      expiry: number;
      namespaces: Readonly<Record<string, WalletConnectNamespaceSnapshot>>;
    }>
  | Readonly<{
      status: "invalid";
      source: WalletSessionSource;
    }>;

export interface WalletConnectStableObservation {
  readonly proposalCount: number;
  readonly sessions: readonly WalletConnectSessionSnapshot[];
  readonly revision: bigint;
}

export type WalletConnectAttemptOutcome =
  | { readonly status: "approved"; readonly session: WalletConnectSessionSnapshot }
  | { readonly status: "rejected"; readonly peerRefusalCode: WalletPeerRefusalCode }
  | { readonly status: "failed"; readonly failure: "sdk" }
  | { readonly status: "cancelled" };

export interface WalletConnectConnectionAttemptPort {
  readonly qr: WalletQrMatrix;
  wait(): Promise<WalletConnectAttemptOutcome>;
  cancel(): Promise<WalletConnectAttemptOutcome>;
}

export type WalletConnectAccountReference = `${EvmChainId}:${string}`;

export type WalletConnectClientEvent =
  | Readonly<{
      kind: "observation_changed";
      sessionSourceId?: string;
    }>
  | Readonly<{
      kind: "accounts_changed";
      sessionSourceId: string;
      chainId: EvmChainId;
      accounts: readonly WalletConnectAccountReference[];
    }>
  | Readonly<{
      kind: "chain_changed";
      sessionSourceId: string;
      chainId: EvmChainId;
    }>
  | Readonly<{
      kind: "identity_invalid";
      sessionSourceId: string;
    }>
  | Readonly<{
      kind: "identity_unattributed";
    }>;

export interface WalletConnectClientActivation {
  readonly initialObservation:
    | Readonly<{ status: "available"; observation: WalletConnectStableObservation }>
    | Readonly<{ status: "unavailable" }>;
  releaseEvents(): void;
  unsubscribe(): void;
}

export const walletConnectClientErrorCodes = Object.freeze([
  "module_loading",
  "configuration",
  "qr_encoding",
  "local_admission",
  "deadline",
  "sdk",
  "observation",
] as const);
export type WalletConnectClientErrorCode = typeof walletConnectClientErrorCodes[number];

const clientErrorMessages = Object.freeze({
  module_loading: "WalletConnect modules could not be loaded.",
  configuration: "WalletConnect configuration is invalid.",
  qr_encoding: "The WalletConnect QR code could not be encoded.",
  local_admission: "The WalletConnect action cannot be admitted locally.",
  deadline: "WalletConnect did not become available before the local deadline.",
  sdk: "WalletConnect is unavailable.",
  observation: "WalletConnect state could not be observed.",
} satisfies Readonly<Record<WalletConnectClientErrorCode, string>>);

const walletConnectClientErrors = new WeakSet<object>();

export class WalletConnectClientError extends Error {
  readonly code: WalletConnectClientErrorCode;

  constructor(code: WalletConnectClientErrorCode) {
    super(clientErrorMessages[code]);
    this.name = "WalletConnectClientError";
    this.code = code;
    walletConnectClientErrors.add(this);
    Object.freeze(this);
  }
}

export const isWalletConnectClientError = (
  error: unknown,
): error is WalletConnectClientError =>
  typeof error === "object" && error !== null && walletConnectClientErrors.has(error);

export const clientError = (code: WalletConnectClientErrorCode): WalletConnectClientError =>
  new WalletConnectClientError(code);

export interface WalletConnectClientPort {
  observe(signal?: AbortSignal): Promise<WalletConnectStableObservation>;
  startConnection(): Promise<WalletConnectConnectionAttemptPort>;
  containPendingConnectionState(): Promise<void>;
  disconnectSession(sessionSourceId: string): Promise<void>;
  startRequest(input: WalletRequestInput): Promise<WalletRequestAttempt>;
  hasPendingRequest(): boolean;
  activate(listener: (event: WalletConnectClientEvent) => void): WalletConnectClientActivation;
  contain(): Promise<void>;
}


export interface WalletConnectLocalClientPort extends Omit<WalletConnectClientPort, "observe"> {
  observe(): WalletConnectStableObservation;
}
