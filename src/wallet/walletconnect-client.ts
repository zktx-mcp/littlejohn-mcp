import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";

import {codePointLength, compareCodePointSequences, fixedIdentifierSchema, isSafeSingleLineText, parseHash32, parseUtcTimestamp, captureCanonicalJson, canonicalJsonStringify, deepFreezeValue} from "../core/index.js";
import {deriveCaip10Account, parseEvmChainId, sameEvmAccountIdentity, type EvmAccountIdentity, type EvmChainId} from "../evm/identities.js";
import {parseCaip10EvmAccount, parseEvmAddressInput} from "../evm/address-input.js";
import {dynamicFeeRequestCommitment} from "../evm/transaction-request.js";
import { createSigningCodec } from "../chain/evm-standard.js";
import { hashSigningPayload } from "../review/signing-hash.js";
import { personalSigningHex } from "../review/signing-payload.js";
import { dataSignatureSchema } from "../intelligence/signature-contract.js";
import { serializeDynamicFeeRequest } from "../chain/transaction-reads.js";
import { admitWalletSession } from "./session-admission.js";
import { walletSdkCollectionLimit, walletSdkNamespaceLimit, walletSdkNamespaceArrayLimit, walletSdkTextCodePoints, walletSdkPendingEventLimit, walletSdkAcquisitionMilliseconds } from "./session-limits.js";
import { walletIdentityEventContradictsAccount } from "./identity-event.js";
import {
  walletRequestInputSchema, walletRequestResponseSchema,
  type WalletRequestInput, type WalletRequestAttempt, type WalletRequestResponse,
} from "./request-contract.js";
import {
  createWalletConnectRequestTracker, walletConnectRequestExpirySeconds,
  type WalletConnectProtocolResources, type WalletConnectRequestTracker,
  type WalletConnectRequestResources,
} from "./request-resources.js";
import {
  createResourceOwnershipScope,
  type OwnedResource,
  type OwnedResourceRegistration,
  type ResourceOwnershipScope,
} from "../runtime/resource-ownership.js";
import { requireProcessTermination } from "../runtime/shutdown.js";
import type { WalletSessionSource } from "../runtime/source-identity.js";
import {
  parseWalletQrMatrix,
  walletPeerRefusalCodes,
  walletQrMatrixSizeLimits,
  type WalletPeerRefusalCode,
  type WalletQrMatrix,
} from "./contracts.js";
import {
  readWalletConnectConfiguration,
  type WalletConnectConfiguration,
} from "./walletconnect-configuration.js";
import type {
  WalletConnectSdkStorage,
  WalletConnectStorageOwner,
} from "./walletconnect-storage.js";
import * as walletExternalModulesNamespace from "./external-modules.cjs";

type WalletConnectConfigurationState = ReturnType<typeof readWalletConnectConfiguration>;

const sdkEventNames = Object.freeze([
  "session_connect",
  "session_update",
  "session_extend",
  "session_delete",
  "session_expire",
  "session_event",
  "proposal_expire",
] as const);
const topicPattern = /^[0-9a-f]{64}$/u;
const pairingUriPattern = /^wc:([0-9a-f]{64})@2\?([^\s#]+)$/u;
const maximumPendingSdkEventCount = walletSdkPendingEventLimit;
const maximumNamespaceCount = walletSdkNamespaceLimit;
const maximumNamespaceArrayLength = walletSdkNamespaceArrayLimit;
const maximumSdkTextLength = walletSdkTextCodePoints;
const pairingParameterNames = new Set([
  "expiryTimestamp",
  "methods",
  "relay-data",
  "relay-protocol",
  "symKey",
]);
const acquisitionDeadlineMilliseconds = walletSdkAcquisitionMilliseconds;
const approvalSettlementMilliseconds = 300_000;
const approvedSessionDisconnectReason = Object.freeze({
  code: 6000,
  message: "User disconnected.",
});

const settleBooleanWithin = (
  work: Promise<boolean>,
  milliseconds: number,
): Promise<boolean> => new Promise((resolve) => {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolve(false);
  }, milliseconds);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  work.then(
    (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    },
    () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    },
  );
});

import { clientError, isWalletConnectClientError, type WalletConnectLocalClientPort, type WalletConnectNamespaceSnapshot, type WalletConnectSessionSnapshot, type WalletConnectStableObservation, type WalletConnectAttemptOutcome, type WalletConnectConnectionAttemptPort, type WalletConnectAccountReference, type WalletConnectClientEvent, type WalletConnectClientActivation, type WalletConnectClientError, type WalletConnectClientErrorCode } from "./client-contract.js";

type CapturedWalletConnectClientEvent =
  | Readonly<{
      kind: "observation_changed";
      topic?: string;
    }>
  | Readonly<{
      kind: "accounts_changed";
      topic: string;
      chainId: EvmChainId;
      accounts: readonly WalletConnectAccountReference[];
    }>
  | Readonly<{
      kind: "chain_changed";
      topic: string;
      chainId: EvmChainId;
    }>
  | Readonly<{
      kind: "identity_invalid";
      topic: string;
    }>
  | Readonly<{
      kind: "identity_unattributed";
    }>;

export interface WalletConnectClientConfiguration {
  readonly wallet: WalletConnectConfiguration;
  readonly storageOwner: WalletConnectStorageOwner;
  readonly createSessionSource: (topic: string) => WalletSessionSource;
}

export type WalletConnectAcquisitionResource = OwnedResource;
export type WalletConnectAcquisitionRegistration = OwnedResourceRegistration;
export type WalletConnectAcquisitionScope = ResourceOwnershipScope;
export const createWalletConnectAcquisitionScope = createResourceOwnershipScope;

export interface WalletConnectClientAcquisition {
  readonly client: WalletConnectLocalClientPort;
  replace(resource: WalletConnectAcquisitionResource): void;
  transfer(): void;
}

export interface WalletConnectSdkLogger {
  level: string;
  child(bindings: unknown): WalletConnectSdkLogger;
  trace(...arguments_: readonly unknown[]): void;
  debug(...arguments_: readonly unknown[]): void;
  info(...arguments_: readonly unknown[]): void;
  warn(...arguments_: readonly unknown[]): void;
  error(...arguments_: readonly unknown[]): void;
  fatal(...arguments_: readonly unknown[]): void;
}

export interface WalletConnectSdkInitOptions {
  readonly projectId: string;
  readonly name: WalletConnectConfigurationState["metadata"]["name"];
  readonly metadata: WalletConnectConfigurationState["metadata"];
  readonly storage: WalletConnectSdkStorage;
  readonly storageOwner: WalletConnectStorageOwner;
  readonly telemetryEnabled: false;
  readonly logger: WalletConnectSdkLogger;
}

export interface WalletConnectSdkConnectInput {
  readonly optionalNamespaces: {
    readonly eip155: {
      readonly chains: readonly EvmChainId[];
      readonly methods: readonly string[];
      readonly events: WalletConnectConfigurationState["requiredEvents"];
    };
  };
}

export type WalletConnectSdkEventName = typeof sdkEventNames[number];
export type WalletConnectSdkEventListener = (event: unknown) => void;

export interface WalletConnectSdkPort {
  assertHealthy(): void;
  listProposals(): readonly unknown[];
  listSessions(): readonly unknown[];
  listPairings(): readonly unknown[];
  startConnection(input: WalletConnectSdkConnectInput): Promise<unknown>;
  expireProposal(id: number): void;
  disconnectPairing(topic: string): Promise<void>;
  disconnectSession(topic: string): Promise<void>;
  request(topic: string, input: WalletRequestInput): WalletRequestAttempt;
  closeRequestResources(): Promise<void>;
  on(event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener): void;
  off(event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener): void;
}

export type WalletConnectSdkFactory = (
  options: WalletConnectSdkInitOptions,
) => Promise<WalletConnectSdkPort>;
export type WalletQrEncoder = (uri: string) => WalletQrMatrix;

export interface WalletConnectProductionDependencies {
  readonly sdkFactory: WalletConnectSdkFactory;
  readonly qrEncoder: WalletQrEncoder;
}

export type WalletExternalModuleLoader = (
  key: "signClient" | "qrCode",
) => Promise<unknown>;

const walletExternalModules = (
  walletExternalModulesNamespace as unknown as Readonly<{ default: unknown }>
).default as Readonly<{
  loadSignClientModule(): Promise<unknown>;
  loadQrCodeModule(): Promise<unknown>;
}>;

const loadWalletExternalModule: WalletExternalModuleLoader = (key) => key === "signClient"
  ? walletExternalModules.loadSignClientModule()
  : walletExternalModules.loadQrCodeModule();

const isObjectLike = (value: unknown): value is object | ((...args: never[]) => unknown) =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const readOwnData = (value: unknown, key: string): unknown => {
  if (!isObjectLike(value)) throw clientError("sdk");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw clientError("sdk");
  }
  return descriptor.value;
};

const readOptionalOwnData = (
  value: unknown,
  key: string,
): { readonly present: false } | { readonly present: true; readonly value: unknown } => {
  if (!isObjectLike(value)) throw clientError("sdk");
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return Object.freeze({ present: false as const });
  if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw clientError("sdk");
  }
  return Object.freeze({ present: true as const, value: descriptor.value });
};

interface CapturedMethod {
  readonly receiver: object | ((...args: never[]) => unknown);
  readonly callable: (...arguments_: readonly unknown[]) => unknown;
}

const captureMethod = (value: unknown, key: string): CapturedMethod => {
  if (!isObjectLike(value)) throw clientError("sdk");
  let owner: object | null = value;
  const visited = new Set<object>();
  while (owner !== null && !visited.has(owner)) {
    visited.add(owner);
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || typeof descriptor.value !== "function") {
        throw clientError("sdk");
      }
      return Object.freeze({
        receiver: value,
        callable: descriptor.value as (...arguments_: readonly unknown[]) => unknown,
      });
    }
    owner = Reflect.getPrototypeOf(owner) as object | null;
  }
  throw clientError("sdk");
};

const invoke = (method: CapturedMethod, arguments_: readonly unknown[]): unknown =>
  Reflect.apply(method.callable, method.receiver, arguments_);

const validSdkText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= maximumSdkTextLength * 2 &&
  codePointLength(value) <= maximumSdkTextLength &&
  isSafeSingleLineText(value);

const copyArray = (value: unknown, maximumLength: number): readonly unknown[] => {
  if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) {
    throw clientError("sdk");
  }
  const readLength = (): number => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    const length: unknown = descriptor?.value;
    if (
      descriptor === undefined || !("value" in descriptor) ||
      descriptor.enumerable !== false ||
      descriptor.get !== undefined || descriptor.set !== undefined ||
      typeof length !== "number" || !Number.isSafeInteger(length) ||
      length < 0 || length > maximumLength
    ) throw clientError("sdk");
    return length;
  };
  const length = readLength();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) {
    throw clientError("sdk");
  }
  const ownKeys = new Set(keys);
  if (!ownKeys.has("length")) throw clientError("sdk");
  for (let index = 0; index < length; index += 1) {
    if (!ownKeys.has(String(index))) throw clientError("sdk");
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined || !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined || descriptor.set !== undefined
    ) {
      throw clientError("sdk");
    }
    output.push(descriptor.value);
  }
  if (readLength() !== length) throw clientError("sdk");
  return Object.freeze(output);
};

const copyStringArray = (value: unknown): readonly string[] => {
  const values = copyArray(value, maximumNamespaceArrayLength);
  if (!values.every(validSdkText)) throw clientError("sdk");
  return values as readonly string[];
};

const normalizeNamespace = (value: unknown): WalletConnectNamespaceSnapshot => {
  const accounts = copyStringArray(readOwnData(value, "accounts"));
  const methods = copyStringArray(readOwnData(value, "methods"));
  const events = copyStringArray(readOwnData(value, "events"));
  const chains = readOptionalOwnData(value, "chains");
  return Object.freeze({
    ...(chains.present ? { chains: copyStringArray(chains.value) } : {}),
    accounts,
    methods,
    events,
  });
};

const normalizeNamespaces = (
  value: unknown,
): Readonly<Record<string, WalletConnectNamespaceSnapshot>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw clientError("sdk");
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw clientError("sdk");
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximumNamespaceCount || keys.some((key) => typeof key !== "string")) {
    throw clientError("sdk");
  }
  const names = (keys as string[]).sort(compareCodePointSequences);
  const normalized = Object.create(null) as Record<string, WalletConnectNamespaceSnapshot>;
  for (const name of names) {
    if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(name)) throw clientError("sdk");
    const descriptor = Reflect.getOwnPropertyDescriptor(value, name);
    if (
      descriptor === undefined || !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined || descriptor.set !== undefined
    ) {
      throw clientError("sdk");
    }
    normalized[name] = normalizeNamespace(descriptor.value);
  }
  return Object.freeze(normalized);
};

const readTopic = (value: unknown): string => {
  const topic = readOwnData(value, "topic");
  if (typeof topic !== "string" || !topicPattern.test(topic)) throw clientError("sdk");
  return topic;
};

const sourceForRawSession = (
  value: unknown,
  createSessionSource: (topic: string) => WalletSessionSource,
): { readonly topic: string; readonly source: WalletSessionSource } => {
  let topic: string;
  try {
    topic = readTopic(value);
  } catch {
    throw clientError("observation");
  }
  try {
    return Object.freeze({ topic, source: createSessionSource(topic) });
  } catch {
    throw clientError("observation");
  }
};

interface PairingReference {
  readonly topic: string;
}

const normalizePairings = (value: unknown): readonly PairingReference[] => {
  const pairings = copyArray(value, walletSdkCollectionLimit).map((pairing) => {
    const topic = readOwnData(pairing, "topic");
    const expiry = readOwnData(pairing, "expiry");
    const active = readOwnData(pairing, "active");
    if (
      typeof topic !== "string" || !topicPattern.test(topic) ||
      typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry <= 0 ||
      typeof active !== "boolean"
    ) throw clientError("sdk");
    return Object.freeze({ topic });
  });
  const topics = new Set<string>();
  for (const pairing of pairings) {
    if (topics.has(pairing.topic)) throw clientError("sdk");
    topics.add(pairing.topic);
  }
  return Object.freeze(pairings.sort((left, right) =>
    compareCodePointSequences(left.topic, right.topic)));
};

const normalizeSession = (
  value: unknown,
  createSessionSource: (topic: string) => WalletSessionSource,
): {
  readonly public: WalletConnectSessionSnapshot;
  readonly topic: string;
  readonly pairingTopic: string;
} => {
  const identity = sourceForRawSession(value, createSessionSource);
  const pairingTopic = readOwnData(value, "pairingTopic");
  if (typeof pairingTopic !== "string" || !topicPattern.test(pairingTopic)) {
    throw clientError("observation");
  }
  try {
    const expiry = readOwnData(value, "expiry");
    if (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry <= 0) {
      throw clientError("sdk");
    }
    return Object.freeze({
      topic: identity.topic,
      pairingTopic,
      public: Object.freeze({
        status: "valid" as const,
        source: identity.source,
        expiry,
        namespaces: normalizeNamespaces(readOwnData(value, "namespaces")),
      }),
    });
  } catch {
    return Object.freeze({
      topic: identity.topic,
      pairingTopic,
      public: Object.freeze({ status: "invalid" as const, source: identity.source }),
    });
  }
};

interface ProposalReference {
  readonly id: number;
  readonly pairingTopic: string;
}

const normalizeProposals = (value: unknown): readonly ProposalReference[] => {
  const proposals = copyArray(value, walletSdkCollectionLimit).map((proposal) => {
    const id = readOwnData(proposal, "id");
    const pairingTopic = readOwnData(proposal, "pairingTopic");
    const expiryTimestamp = readOwnData(proposal, "expiryTimestamp");
    if (
      typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 ||
      typeof pairingTopic !== "string" || !topicPattern.test(pairingTopic) ||
      typeof expiryTimestamp !== "number" || !Number.isSafeInteger(expiryTimestamp) || expiryTimestamp <= 0
    ) throw clientError("sdk");
    return Object.freeze({ id, pairingTopic });
  });
  const ids = new Set<number>();
  for (const proposal of proposals) {
    if (ids.has(proposal.id)) throw clientError("sdk");
    ids.add(proposal.id);
  }
  return Object.freeze(proposals.sort((left, right) => left.id - right.id));
};

const exactProposal = (value: unknown): ProposalReference => {
  const proposals = normalizeProposals(value);
  const proposal = proposals[0];
  if (proposals.length !== 1 || proposal === undefined) throw clientError("sdk");
  return proposal;
};

const containProposal = async (
  proposal: ProposalReference,
  expireProposal: (id: number) => void,
  disconnectPairing: (topic: string) => Promise<void>,
): Promise<boolean> => {
  let contained = true;
  try { expireProposal(proposal.id); }
  catch { contained = false; }
  try { await disconnectPairing(proposal.pairingTopic); }
  catch { contained = false; }
  return contained;
};

const pairingTopicFromUri = (uri: unknown): string => {
  if (
    typeof uri !== "string" ||
    !isSafeSingleLineText(uri)
  ) throw clientError("sdk");
  const match = pairingUriPattern.exec(uri);
  const topic = match?.[1];
  const query = match?.[2];
  if (topic === undefined || query === undefined) throw clientError("sdk");
  const values = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(query)) {
    if (!pairingParameterNames.has(name) || values.has(name) || !validSdkText(value)) {
      throw clientError("sdk");
    }
    values.set(name, value);
  }
  if (values.get("relay-protocol") !== "irn") throw clientError("sdk");
  const symmetricKey = values.get("symKey");
  if (symmetricKey === undefined || !topicPattern.test(symmetricKey)) throw clientError("sdk");
  const relayData = values.get("relay-data");
  if (relayData !== undefined && relayData.length === 0) throw clientError("sdk");
  const expiryTimestamp = values.get("expiryTimestamp");
  if (expiryTimestamp !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(expiryTimestamp)) throw clientError("sdk");
    const parsed = Number(expiryTimestamp);
    if (!Number.isSafeInteger(parsed)) throw clientError("sdk");
  }
  const methods = values.get("methods");
  if (methods !== undefined) {
    const methodValues = methods.split(",");
    if (
      methodValues.length === 0 || methodValues.length > maximumNamespaceArrayLength ||
      methodValues.some((method) => !fixedIdentifierSchema.safeParse(method).success) ||
      new Set(methodValues).size !== methodValues.length
    ) throw clientError("sdk");
  }
  return topic;
};

interface StartedConnection {
  readonly uri: unknown;
  readonly approval: Promise<unknown>;
}

const beginConnectionStart = (value: unknown): StartedConnection => {
  const approval = readOwnData(value, "approval");
  if (typeof approval !== "function") throw clientError("sdk");
  let approvalSettlement: Promise<unknown>;
  try {
    approvalSettlement = Promise.resolve(Reflect.apply(approval, value, []));
  } catch (error) {
    approvalSettlement = Promise.reject(error);
  }
  void approvalSettlement.catch(() => undefined);
  let uri: unknown;
  try {
    const candidate = readOptionalOwnData(value, "uri");
    uri = candidate.present ? candidate.value : undefined;
  } catch { uri = undefined; }
  return Object.freeze({
    uri,
    approval: approvalSettlement,
  });
};

const peerRefusalCodeSet = new Set<number>(walletPeerRefusalCodes);

const peerRefusal = (error: unknown): WalletPeerRefusalCode | undefined => {
  try {
    const code = readOwnData(error, "code");
    return typeof code === "number" && peerRefusalCodeSet.has(code)
      ? code as WalletPeerRefusalCode
      : undefined;
  } catch {
    return undefined;
  }
};

const createDroppingLogger = (): WalletConnectSdkLogger => {
  const drop = (..._arguments: readonly unknown[]): void => undefined;
  return {
    level: "warn",
    child: () => createDroppingLogger(),
    trace: drop,
    debug: drop,
    info: drop,
    warn: drop,
    error: drop,
    fatal: drop,
  };
};

interface WalletConnectAcquisitionBudget {
  run<Value>(operation: () => Promise<Value>): Promise<Value>;
}

const createWalletConnectAcquisitionBudget = (
  signal: AbortSignal,
): WalletConnectAcquisitionBudget => {
  const deadline = performance.now() + acquisitionDeadlineMilliseconds;

  const boundaryError = (): WalletConnectClientError =>
    clientError(signal.aborted ? "local_admission" : "deadline");
  const assertCurrent = (): void => {
    if (signal.aborted || performance.now() >= deadline) throw boundaryError();
  };

  return Object.freeze({
    run<Value>(operation: () => Promise<Value>): Promise<Value> {
      try { assertCurrent(); }
      catch (error) { return Promise.reject(error); }

      const pending = Promise.resolve().then(() => {
        assertCurrent();
        return operation();
      });

      return new Promise<Value>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const clear = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          signal.removeEventListener("abort", onAbort);
        };
        const rejectBoundary = (): void => {
          if (settled) return;
          settled = true;
          clear();
          reject(boundaryError());
        };
        const onAbort = (): void => rejectBoundary();
        const onDeadline = (): void => rejectBoundary();

        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          rejectBoundary();
        } else {
          const remaining = Math.max(0, deadline - performance.now());
          timer = setTimeout(onDeadline, remaining);
          timer.unref();
        }

        void pending.then(
          (value) => {
            if (settled) return;
            try { assertCurrent(); }
            catch {
              rejectBoundary();
              return;
            }
            settled = true;
            clear();
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            try { assertCurrent(); }
            catch {
              rejectBoundary();
              return;
            }
            settled = true;
            clear();
            reject(error);
          },
        );
      });
    },
  });
};

const normalizeChangedAccounts = (
  value: unknown,
  rawChainId: unknown,
): Readonly<{ chainId: EvmChainId; accounts: readonly WalletConnectAccountReference[] }> => {
  const chainId = parseEvmChainId(rawChainId);
  const accounts = copyStringArray(value).map((account) => {
    const identity = account.startsWith("eip155:")
      ? parseCaip10EvmAccount(account)
      : Object.freeze({ chainId, address: parseEvmAddressInput(account) });
    if (identity.chainId !== chainId) throw clientError("sdk");
    return deriveCaip10Account(identity) as WalletConnectAccountReference;
  });
  return Object.freeze({ chainId, accounts: Object.freeze(accounts) });
};

const normalizeChangedChain = (value: unknown): EvmChainId => {
  if (!validSdkText(value) || !/^(?:0x[0-9a-fA-F]+|[1-9][0-9]*)$/u.test(value)) {
    throw clientError("sdk");
  }
  const reference = BigInt(value).toString(10);
  return parseEvmChainId(`eip155:${reference}`);
};

const copyQrMatrix = (value: unknown): WalletQrMatrix => {
  const modules = readOwnData(value, "modules");
  const size = readOwnData(modules, "size");
  const data = readOwnData(modules, "data");
  if (
    typeof size !== "number" || !Number.isSafeInteger(size) ||
    size < walletQrMatrixSizeLimits.minimum || size > walletQrMatrixSizeLimits.maximum ||
    !(data instanceof Uint8Array) || !ArrayBuffer.isView(data) ||
    Reflect.getPrototypeOf(data) !== Uint8Array.prototype ||
    data.length !== size * size
  ) throw clientError("qr_encoding");
  const rows: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let output = "";
    for (let column = 0; column < size; column += 1) {
      const module = data[(row * size) + column];
      if (module !== 0 && module !== 1) throw clientError("qr_encoding");
      output += module === 0 ? "0" : "1";
    }
    rows.push(output);
  }
  return parseWalletQrMatrix({ size, rows });
};

const observeSdkRequest = (
  work: unknown,
  resource: WalletConnectRequestResources,
  kind: WalletRequestInput["kind"],
  failed: () => void,
): WalletRequestAttempt => {
  let waiting = true;
  let resolve!: (value: WalletRequestResponse) => void;
  const response = new Promise<WalletRequestResponse>((done) => { resolve = done; });
  const finish = (outcome: WalletRequestResponse): void => {
    if (!waiting) return;
    waiting = false;
    clearTimeout(timer);
    try { resource.finish(); } catch { failed(); }
    resolve(Object.freeze(outcome));
  };
  const timer = setTimeout(() => finish({ status: "delivery_unknown", reason: "request_expired" }),
    walletConnectRequestExpirySeconds * 1_000);
  timer.unref();
  const settlement = Promise.resolve(work).then((value: unknown): WalletRequestResponse => {
    if (kind === "signing" && !waiting) return { status: "delivery_unknown", reason: "request_expired" };
    if (kind === "signing" && typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) {
      const signature = value.toLowerCase();
      return dataSignatureSchema.safeParse(signature).success ? { status: "signature_returned", signature } : { status: "unsupported_signature" };
    }
    if (kind === "transaction" && typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value)) {
      return { status: "hash_returned", transactionHash: parseHash32(value.toLowerCase()) };
    }
    return { status: "delivery_unknown", reason: "invalid_response" };
  }, (error: unknown): WalletRequestResponse => {
    let code: unknown;
    try { code = readOwnData(error, "code"); } catch { /* Unclassified errors remain unknown. */ }
    if (code === 4001 || code === 5000) return { status: "wallet_rejected" };
    return resource.entered ? { status: "delivery_unknown", reason: "sdk_error" } : { status: "not_sent" };
  }).then((outcome) => { finish(outcome); return Object.freeze(outcome); });
  return Object.freeze({ response, settlement });
};

const createProductionSdkFactory = (signClientModule: unknown, relayUrl?: string): WalletConnectSdkFactory => {
  const signClient = readOwnData(signClientModule, "SignClient");
  const initialize = captureMethod(signClient, "init");
  return async (options) => {
    if (options.storage !== options.storageOwner.storage) throw clientError("configuration");
    let client: unknown;
    try {
      client = await invoke(initialize, [{
        projectId: options.projectId,
        name: options.name,
        metadata: {
          name: options.metadata.name,
          description: options.metadata.description,
          url: options.metadata.url,
          icons: [...options.metadata.icons],
        },
        storage: options.storage,
        ...(relayUrl === undefined ? {} : { relayUrl }),
        telemetryEnabled: options.telemetryEnabled,
        logger: options.logger,
      }]);
    } catch {
      throw clientError("sdk");
    }
    try {
      const core = readOwnData(client, "core");
      const proposal = readOwnData(client, "proposal");
      const session = readOwnData(client, "session");
      const expirer = readOwnData(core, "expirer");
      const pairing = readOwnData(core, "pairing");
      const proposalGetAll = captureMethod(proposal, "getAll");
      const sessionGetAll = captureMethod(session, "getAll");
      const connect = captureMethod(client, "connect");
      const disconnect = captureMethod(client, "disconnect");
      const expirerSet = captureMethod(expirer, "set");
      const pairingDisconnect = captureMethod(pairing, "disconnect");
      const pairingGetAll = captureMethod(pairing, "getPairings");
      const on = captureMethod(client, "on");
      const off = captureMethod(client, "off");
      let requestResources: WalletConnectRequestTracker | undefined;
      let requestFailure = false;
      const failRequests = (): void => { requestFailure = true; };
      const eventEmitter = (value: unknown): EventEmitter => {
        if (!(value instanceof EventEmitter)) throw clientError("sdk");
        return value;
      };
      const getRequestResources = (): WalletConnectRequestTracker => {
        if (requestFailure) throw clientError("sdk");
        if (requestResources !== undefined) return requestResources;
        const history = readOwnData(core, "history");
        const relayer = readOwnData(core, "relayer");
        const messages = readOwnData(relayer, "messages");
        const publisher = readOwnData(relayer, "publisher");
        const crypto = readOwnData(core, "crypto");
        if (readOwnData(core, "storage") !== options.storage) throw clientError("sdk");
        for (const [value, names] of [[publisher, ["publish"]], [crypto, ["encode", "decode"]]] as const) {
          for (const name of names) {
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            if (descriptor === undefined || !("value" in descriptor) || !descriptor.writable ||
                typeof descriptor.value !== "function") throw clientError("sdk");
          }
        }
        captureMethod(history, "delete");
        for (const [value, name] of [[messages, "messages"], [messages, "messagesWithoutClientAck"], [publisher, "queue"]] as const) {
          if (!(readOwnData(value, name) instanceof Map)) throw clientError("sdk");
        }
        eventEmitter(readOwnData(history, "events"));
        requestResources = createWalletConnectRequestTracker({
          storageOwner: options.storageOwner,
          history: history as WalletConnectProtocolResources["history"],
          messages: messages as WalletConnectProtocolResources["messages"],
          publisher: publisher as WalletConnectProtocolResources["publisher"],
          crypto: crypto as WalletConnectProtocolResources["crypto"],
          relayerEvents: eventEmitter(readOwnData(relayer, "events")),
          engineEvents: eventEmitter(readOwnData(readOwnData(client, "engine"), "events")),
          providerEvents: eventEmitter(readOwnData(readOwnData(relayer, "provider"), "events")),
        }, failRequests);
        return requestResources;
      };
      return Object.freeze({
        assertHealthy: () => { if (requestFailure) throw clientError("sdk"); },
        listProposals: () => invoke(proposalGetAll, []) as readonly unknown[],
        listSessions: () => invoke(sessionGetAll, []) as readonly unknown[],
        listPairings: () => invoke(pairingGetAll, []) as readonly unknown[],
        startConnection: async (input: WalletConnectSdkConnectInput) =>
          invoke(connect, [{
            optionalNamespaces: {
              eip155: {
                chains: [...input.optionalNamespaces.eip155.chains],
                methods: [...input.optionalNamespaces.eip155.methods],
                events: [...input.optionalNamespaces.eip155.events],
              },
            },
          }]),
        expireProposal: (id: number) => {
          invoke(expirerSet, [id, Math.floor(Date.now() / 1_000) - 1]);
        },
        disconnectPairing: async (topic: string) => {
          await invoke(pairingDisconnect, [{ topic }]);
        },
        disconnectSession: async (topic: string) => {
          await invoke(disconnect, [{ topic, reason: approvedSessionDisconnectReason }]);
        },
        request: (topic: string, input: WalletRequestInput) => {
          const call = captureMethod(client, "request");
          const tracker = getRequestResources();
          const method = input.kind === "transaction" ? "eth_sendTransaction" : input.context.method;
          const chainId = input.kind === "transaction" ? input.request.chainId : input.context.account.chainId;
          const params = input.kind === "transaction" ? [serializeDynamicFeeRequest(input.request)]
            : input.payload.kind === "personal" ? [personalSigningHex(input.payload), input.context.account.address]
              : [input.context.account.address, canonicalJsonStringify(captureCanonicalJson({ types: input.payload.types, primaryType: input.payload.primaryType, domain: input.payload.domain, message: input.payload.message }))];
          const resource = tracker.begin(topic, params);
          if (Date.now() >= Date.parse(input.sendExpiresAt)) {
            resource.finish();
            const response = Promise.resolve(Object.freeze({ status: "not_sent" as const }));
            return { response, settlement: response };
          }
          let work: unknown;
          try {
            work = invoke(call, [{ topic, chainId,
              request: { method, params }, expiry: walletConnectRequestExpirySeconds }]);
          } catch {
            const entered = resource.entered;
            resource.finish();
            const response = Promise.resolve(Object.freeze(entered
              ? { status: "delivery_unknown" as const, reason: "sdk_error" as const }
              : { status: "not_sent" as const }));
            return { response, settlement: response };
          }
          return observeSdkRequest(work, resource, input.kind, failRequests);
        },
        closeRequestResources: async () => { await requestResources?.close(); },
        on: (event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener) => {
          invoke(on, [event, listener]);
        },
        off: (event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener) => {
          invoke(off, [event, listener]);
        },
      });
    } catch {
      throw clientError("sdk");
    }
  };
};

const createProductionQrEncoder = (qrCodeModule: unknown): WalletQrEncoder => {
  const create = captureMethod(qrCodeModule, "create");
  return (uri) => {
    try {
      return copyQrMatrix(invoke(create, [uri, { errorCorrectionLevel: "L" }]));
    } catch {
      throw clientError("qr_encoding");
    }
  };
};

export const loadWalletConnectProductionDependencies = async (
  moduleLoader: WalletExternalModuleLoader = loadWalletExternalModule,
  relayUrl?: string,
): Promise<WalletConnectProductionDependencies> => {
  let signClientModule: unknown;
  let qrCodeModule: unknown;
  try {
    [signClientModule, qrCodeModule] = await Promise.all([
      moduleLoader("signClient"),
      moduleLoader("qrCode"),
    ]);
  } catch {
    throw clientError("module_loading");
  }
  try {
    return Object.freeze({
      sdkFactory: createProductionSdkFactory(signClientModule, relayUrl),
      qrEncoder: createProductionQrEncoder(qrCodeModule),
    });
  } catch (error) {
    if (isWalletConnectClientError(error) && error.code === "qr_encoding") throw error;
    throw clientError("module_loading");
  }
};

type ConnectionAdmission = "published" | "withdrawn";

class WalletConnectConnectionAttempt {
  readonly #result: Promise<WalletConnectAttemptOutcome>;
  readonly #approvalSettlement: Promise<boolean>;
  readonly #admission: Promise<ConnectionAdmission>;
  #resolve!: (outcome: WalletConnectAttemptOutcome) => void;
  #resolveAdmission!: (admission: ConnectionAdmission) => void;
  #terminal: WalletConnectAttemptOutcome | undefined;
  #admissionState: "preparing" | ConnectionAdmission = "preparing";
  #proposal: ProposalReference | undefined;
  #cancellationRequested = false;
  #containment: Promise<boolean> | undefined;
  #cancellation: Promise<WalletConnectAttemptOutcome> | undefined;
  #released = false;

  constructor(
    private readonly approval: Promise<unknown>,
    private readonly normalizeApproved: (session: unknown) => {
      readonly public: WalletConnectSessionSnapshot;
      readonly topic: string;
    },
    private readonly expireProposal: (id: number) => void,
    private readonly disconnectPairing: (topic: string) => Promise<void>,
    private readonly disconnectLateSession: (topic: string) => Promise<void>,
    private readonly settled: () => void,
    private readonly poison: () => void,
  ) {
    this.#result = new Promise<WalletConnectAttemptOutcome>((resolve) => {
      this.#resolve = resolve;
    });
    this.#admission = new Promise<ConnectionAdmission>((resolve) => {
      this.#resolveAdmission = resolve;
    });
    this.#approvalSettlement = this.#observeApproval();
    Object.seal(this);
  }

  publish(qr: WalletQrMatrix, proposal: ProposalReference): WalletConnectConnectionAttemptPort {
    if (this.#admissionState !== "preparing") throw clientError("local_admission");
    this.#proposal = proposal;
    this.#admissionState = "published";
    this.#resolveAdmission("published");
    return Object.freeze({
      qr,
      wait: () => this.wait(),
      cancel: () => this.cancel(),
    });
  }

  async withdraw(proposal?: ProposalReference): Promise<boolean> {
    if (this.#admissionState !== "preparing") throw clientError("local_admission");
    this.#proposal = proposal;
    this.#admissionState = "withdrawn";
    this.#resolveAdmission("withdrawn");
    const contained = await this.#requestContainment();
    this.#release();
    return contained;
  }

  wait(): Promise<WalletConnectAttemptOutcome> {
    return this.#result;
  }

  cancel(): Promise<WalletConnectAttemptOutcome> {
    if (this.#terminal !== undefined) return Promise.resolve(this.#terminal);
    if (this.#cancellation !== undefined) return this.#cancellation;
    if (this.#admissionState !== "published") {
      return Promise.reject(clientError("local_admission"));
    }
    let resolveCancellation!: (outcome: WalletConnectAttemptOutcome) => void;
    let rejectCancellation!: (reason: unknown) => void;
    const cancellation = new Promise<WalletConnectAttemptOutcome>((resolve, reject) => {
      resolveCancellation = resolve;
      rejectCancellation = reject;
    });
    this.#cancellation = cancellation;
    void (async (): Promise<void> => {
      try {
        const contained = await this.#requestContainment();
        resolveCancellation(this.#settle(contained
          ? Object.freeze({ status: "cancelled" as const })
          : Object.freeze({ status: "failed" as const, failure: "sdk" as const })));
      } catch (error) {
        rejectCancellation(error);
      }
    })();
    return cancellation;
  }

  #requestContainment(): Promise<boolean> {
    if (this.#containment !== undefined) return this.#containment;
    this.#cancellationRequested = true;
    let resolveContainment!: (contained: boolean) => void;
    let rejectContainment!: (reason: unknown) => void;
    const containment = new Promise<boolean>((resolve, reject) => {
      resolveContainment = resolve;
      rejectContainment = reject;
    });
    this.#containment = containment;
    void this.#performContainment().then(resolveContainment, rejectContainment);
    return containment;
  }

  async #performContainment(): Promise<boolean> {
    let cleanupContained = true;
    const proposal = this.#proposal;
    if (proposal !== undefined) {
      cleanupContained = await containProposal(
        proposal,
        this.expireProposal,
        this.disconnectPairing,
      );
      if (!cleanupContained) this.poison();
    }
    const approvalContained = await settleBooleanWithin(
      this.#approvalSettlement,
      approvalSettlementMilliseconds,
    );
    if (!approvalContained) this.poison();
    return cleanupContained && approvalContained;
  }

  async #observeApproval(): Promise<boolean> {
    let approved: { readonly status: "approved"; readonly session: unknown } |
      { readonly status: "rejected"; readonly error: unknown };
    try {
      approved = Object.freeze({ status: "approved" as const, session: await this.approval });
    } catch (error) {
      approved = Object.freeze({ status: "rejected" as const, error });
    }
    const admission = await this.#admission;
    if (admission === "withdrawn" || this.#cancellationRequested) {
      if (approved.status === "rejected") return true;
      try {
        const normalized = this.normalizeApproved(approved.session);
        await this.disconnectLateSession(normalized.topic);
        return true;
      } catch {
        this.poison();
        return false;
      }
    }
    if (approved.status === "approved") {
      try {
        const normalized = this.normalizeApproved(approved.session);
        this.#settle(Object.freeze({ status: "approved", session: normalized.public }));
      } catch {
        this.poison();
        this.#settle(Object.freeze({ status: "failed", failure: "sdk" }));
      }
      return true;
    }
    try {
      const peerRefusalCode = peerRefusal(approved.error);
      if (peerRefusalCode !== undefined) {
        this.#settle(Object.freeze({ status: "rejected", peerRefusalCode }));
      } else {
        this.poison();
        this.#settle(Object.freeze({ status: "failed", failure: "sdk" }));
      }
      return true;
    } catch {
      this.poison();
      this.#settle(Object.freeze({ status: "failed", failure: "sdk" }));
      return true;
    }
  }

  #settle(outcome: WalletConnectAttemptOutcome): WalletConnectAttemptOutcome {
    if (this.#terminal !== undefined) return this.#terminal;
    this.#terminal = outcome;
    this.#resolve(outcome);
    this.#release();
    return outcome;
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.settled();
  }
}

interface ActiveWalletRequest {
  readonly kind: WalletRequestInput["kind"];
  readonly sessionSourceId: string;
  readonly topic: string;
  readonly account: EvmAccountIdentity;
  ended: boolean;
  close(): void;
}

class WalletConnectClient implements WalletConnectLocalClientPort {
  readonly #listeners = new Set<(event: WalletConnectClientEvent) => void>();
  readonly #sdkListeners = new Map<WalletConnectSdkEventName, WalletConnectSdkEventListener>();
  #pendingEvents: CapturedWalletConnectClientEvent[] | undefined = [];
  #activationCreated = false;
  #sourceToTopic = new Map<string, string>();
  #topicToSource = new Map<string, string>();
  #activeAttempt: WalletConnectConnectionAttempt | undefined;
  #commandTail: Promise<void> = Promise.resolve();
  #lastObservationRevision: bigint | undefined;
  #callbacksStopped = false;
  #contained = false;
  #sdkUsable = true;
  #activeRequest: ActiveWalletRequest | undefined;
  #containment: Promise<void> | undefined;

  constructor(
    private readonly sdk: WalletConnectSdkPort,
    private readonly qrEncoder: WalletQrEncoder,
    private readonly configuration: WalletConnectConfigurationState,
    private readonly storageOwner: WalletConnectStorageOwner,
    private readonly createSessionSource: (topic: string) => WalletSessionSource,
  ) {}

  startCallbacks(): void {
    this.#attachCallbacks();
  }

  observe(): WalletConnectStableObservation {
    this.#assertObservable();
    try {
      const r0 = this.storageOwner.checkpoint();
      const proposals = normalizeProposals(this.sdk.listProposals());
      const rawSessions = copyArray(this.sdk.listSessions(), walletSdkCollectionLimit);
      const normalized = rawSessions.map((session) => normalizeSession(session, this.createSessionSource));
      const r1 = this.storageOwner.checkpoint();
      if (r0 !== r1) throw clientError("observation");
      const sourceToTopic = new Map<string, string>();
      const topicToSource = new Map<string, string>();
      for (const session of normalized) {
        const source = session.public.source;
        if (sourceToTopic.has(source.sourceId) || topicToSource.has(session.topic)) {
          throw clientError("observation");
        }
        sourceToTopic.set(source.sourceId, session.topic);
        topicToSource.set(session.topic, source.sourceId);
      }
      this.#sourceToTopic = sourceToTopic;
      this.#topicToSource = topicToSource;
      this.#lastObservationRevision = r1;
      return Object.freeze({
        proposalCount: proposals.length,
        sessions: Object.freeze(normalized.map(({ public: snapshot }) => snapshot)),
        revision: r1,
      });
    } catch {
      throw clientError("observation");
    }
  }

  startConnection(): Promise<WalletConnectConnectionAttemptPort> {
    this.#assertCommandAdmission();
    return this.#runCommand(async () => {
      this.#assertCommandAdmission();
      if (this.#activeAttempt !== undefined) throw clientError("local_admission");
      const current = this.observe();
      if (current.proposalCount !== 0 || current.sessions.length !== 0) {
        throw clientError("local_admission");
      }
      let rawStarted: unknown;
      try {
        rawStarted = await this.sdk.startConnection({
          optionalNamespaces: Object.freeze({
            eip155: Object.freeze({
              chains: Object.freeze([this.configuration.chain.chainId]),
              methods: [...this.configuration.requiredMethods, ...this.configuration.optionalMethods],
              events: this.configuration.requiredEvents,
            }),
          }),
        });
      } catch {
        this.#sdkUsable = false;
        throw clientError("sdk");
      }

      let started: StartedConnection | undefined;
      try { started = beginConnectionStart(rawStarted); }
      catch { this.#sdkUsable = false; }
      let proposal: ProposalReference | undefined;
      try { proposal = exactProposal(this.sdk.listProposals()); }
      catch { this.#sdkUsable = false; }

      if (started === undefined) {
        if (proposal !== undefined) {
          await containProposal(
            proposal,
            (id) => this.sdk.expireProposal(id),
            (topic) => this.sdk.disconnectPairing(topic),
          );
        }
        throw clientError("sdk");
      }

      let attempt!: WalletConnectConnectionAttempt;
      attempt = new WalletConnectConnectionAttempt(
        started.approval,
        (session) => normalizeSession(session, this.createSessionSource),
        (id) => this.sdk.expireProposal(id),
        (topic) => this.sdk.disconnectPairing(topic),
        (topic) => this.sdk.disconnectSession(topic),
        () => { if (this.#activeAttempt === attempt) this.#activeAttempt = undefined; },
        () => { this.#sdkUsable = false; },
      );
      this.#activeAttempt = attempt;

      if (proposal === undefined) {
        await attempt.withdraw();
        throw clientError("sdk");
      }

      if (typeof started.uri !== "string") {
        this.#sdkUsable = false;
        await attempt.withdraw(proposal);
        throw clientError("sdk");
      }
      const uri = started.uri;
      let qr: WalletQrMatrix;
      try { qr = this.qrEncoder(uri); }
      catch {
        await attempt.withdraw(proposal);
        throw clientError("qr_encoding");
      }

      let pairingTopic: string;
      try { pairingTopic = pairingTopicFromUri(uri); }
      catch {
        this.#sdkUsable = false;
        await attempt.withdraw(proposal);
        throw clientError("sdk");
      }
      if (proposal.pairingTopic !== pairingTopic) {
        this.#sdkUsable = false;
        await attempt.withdraw(proposal);
        throw clientError("sdk");
      }
      return attempt.publish(qr, proposal);
    });
  }

  disconnectSession(sessionSourceId: string): Promise<void> {
    this.#assertCommandAdmission();
    if (typeof sessionSourceId !== "string") throw clientError("local_admission");
    return this.#runCommand(async () => {
      this.#assertCommandAdmission();
      const topic = this.#sourceToTopic.get(sessionSourceId);
      if (topic === undefined) throw clientError("local_admission");
      if (this.#activeRequest?.kind === "signing" && this.#activeRequest.sessionSourceId === sessionSourceId) this.#activeRequest.close();
      try { await this.sdk.disconnectSession(topic); }
      catch { throw clientError("sdk"); }
    });
  }

  hasPendingRequest(): boolean {
    this.#assertCommandAdmission();
    return this.#activeRequest !== undefined;
  }

  startRequest(input: WalletRequestInput): Promise<WalletRequestAttempt> {
    this.#assertCommandAdmission();
    const admitted = deepFreezeValue(walletRequestInputSchema.parse(captureCanonicalJson(input)));
    return this.#runCommand(async () => {
      this.#assertCommandAdmission();
      if (this.#activeAttempt !== undefined || this.#activeRequest !== undefined ||
          Date.now() >= Date.parse(admitted.sendExpiresAt)) throw clientError("local_admission");
      const current = this.observe();
      const account = admitted.kind === "transaction" ? admitted.reference.account : admitted.context.account;
      const method = admitted.kind === "transaction" ? "eth_sendTransaction" : admitted.context.method;
      const matches = current.sessions.filter((item) => item.source.sourceId === admitted.sessionSourceId);
      const session = matches[0];
      const namespace = session?.status === "valid" ? session.namespaces["eip155"] : undefined;
      if (current.proposalCount !== 0 || matches.length !== 1 || session?.status !== "valid" ||
          namespace === undefined || session.expiry * 1_000 <= Date.now() ||
          account.chainId !== this.configuration.chain.chainId ||
          !namespace.accounts.some((value) => sameEvmAccountIdentity(parseCaip10EvmAccount(value), account)) ||
          (namespace.chains !== undefined && !namespace.chains.includes(account.chainId)) ||
          !namespace.methods.includes(method)) throw clientError("local_admission");
      if (admitted.kind === "transaction" ?
          admitted.request.chainId !== account.chainId || admitted.request.from !== account.address ||
            dynamicFeeRequestCommitment(admitted.request) !== admitted.reference.walletRequestCommitment :
          hashSigningPayload(createSigningCodec(), admitted.payload) !== admitted.context.messageHash) {
        throw clientError("local_admission");
      }
      const topic = this.#sourceToTopic.get(admitted.sessionSourceId);
      if (topic === undefined) throw clientError("local_admission");
      const token = { kind: admitted.kind, sessionSourceId: admitted.sessionSourceId, topic, account, ended: false,
        close(): void { this.ended = true; } };
      this.#activeRequest = token;
      let work: WalletRequestAttempt;
      try { work = this.sdk.request(topic, admitted); }
      catch (error) { this.#activeRequest = undefined; throw error; }
      return this.#trackRequest(work, token);
    });
  }

  #trackRequest(work: WalletRequestAttempt, token: ActiveWalletRequest): WalletRequestAttempt {
    let resolve!: (value: WalletRequestResponse) => void;
    let ended = false;
    const response = new Promise<WalletRequestResponse>((done) => { resolve = done; });
    const admit = (value: unknown): WalletRequestResponse => {
      try {
        const result = walletRequestResponseSchema.parse(captureCanonicalJson(value));
        if (token.kind === "transaction" ? result.status === "signature_returned" || result.status === "unsupported_signature" : result.status === "hash_returned") throw clientError("sdk");
        return token.kind === "signing" && token.ended ? { status: "delivery_unknown", reason: "shutdown" } : deepFreezeValue(result);
      } catch { return { status: "delivery_unknown", reason: "invalid_response" }; }
    };
    const finish = (value: WalletRequestResponse): void => {
      if (ended) return;
      ended = true;
      resolve(value);
    };
    token.close = () => { token.ended = true; finish(Object.freeze({ status: "delivery_unknown", reason: "shutdown" })); };
    void work.response.then((value) => finish(admit(value)), () => finish({ status: "delivery_unknown", reason: "sdk_error" }));
    const settlement = work.settlement.then(admit, (): WalletRequestResponse => ({ status: "delivery_unknown", reason: "sdk_error" }))
      .then((value) => {
        if (this.#activeRequest === token) this.#activeRequest = undefined;
        finish(value);
        return value;
      });
    if (this.#contained || token.ended) token.close();
    return Object.freeze({ response, settlement });
  }

  containPendingConnectionState(): Promise<void> {
    this.#assertCommandAdmission();
    return this.#runCommand(async () => {
      this.#assertCommandAdmission();
      if (this.#activeAttempt !== undefined) throw clientError("local_admission");
      let proposals: readonly ProposalReference[];
      let pairings: readonly PairingReference[];
      let sessionPairingTopics: ReadonlySet<string>;
      try {
        proposals = normalizeProposals(this.sdk.listProposals());
        pairings = normalizePairings(this.sdk.listPairings());
        sessionPairingTopics = new Set(copyArray(
          this.sdk.listSessions(),
          walletSdkCollectionLimit,
        ).map((session) => normalizeSession(session, this.createSessionSource).pairingTopic));
      }
      catch { throw clientError("observation"); }
      let complete = true;
      for (const proposal of proposals) {
        try { this.sdk.expireProposal(proposal.id); }
        catch { complete = false; }
      }
      const orphanTopics = new Set<string>([
        ...pairings.map((pairing) => pairing.topic),
        ...proposals.map((proposal) => proposal.pairingTopic),
      ].filter((topic) => !sessionPairingTopics.has(topic)));
      for (const topic of [...orphanTopics].sort(compareCodePointSequences)) {
        try { await this.sdk.disconnectPairing(topic); }
        catch { complete = false; }
      }
      if (!complete) throw clientError("sdk");
      try {
        if (normalizeProposals(this.sdk.listProposals()).length !== 0) {
          throw clientError("observation");
        }
        const remainingSessionTopics = new Set(copyArray(
          this.sdk.listSessions(),
          walletSdkCollectionLimit,
        ).map((session) => normalizeSession(session, this.createSessionSource).pairingTopic));
        if (normalizePairings(this.sdk.listPairings()).some((pairing) =>
          !remainingSessionTopics.has(pairing.topic))) {
          throw clientError("observation");
        }
      } catch { throw clientError("observation"); }
    });
  }

  activate(listener: (event: WalletConnectClientEvent) => void): WalletConnectClientActivation {
    if (
      typeof listener !== "function" || this.#callbacksStopped || this.#activationCreated ||
      this.#pendingEvents === undefined
    ) throw clientError("local_admission");
    this.#activationCreated = true;
    this.#listeners.add(listener);
    let active = true;
    const unsubscribe = (): void => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
    let initialObservation: WalletConnectClientActivation["initialObservation"];
    try {
      initialObservation = Object.freeze({
        status: "available" as const,
        observation: this.observe(),
      });
    } catch {
      initialObservation = Object.freeze({ status: "unavailable" as const });
    }
    let released = false;
    return Object.freeze({
      initialObservation,
      releaseEvents: () => {
        if (released || !active || this.#pendingEvents === undefined) {
          throw clientError("local_admission");
        }
        released = true;
        const pending = this.#pendingEvents;
        this.#pendingEvents = undefined;
        for (const event of pending) this.#publishCapturedEvent(event);
        if (!this.#sdkUsable) throw clientError("observation");
      },
      unsubscribe,
    });
  }

  contain(): Promise<void> {
    if (this.#containment !== undefined) return this.#containment;
    this.#contained = true;
    this.#activeRequest?.close();
    this.#lastObservationRevision = undefined;
    this.#stopCallbacks();
    this.#containment = this.sdk.closeRequestResources();
    return this.#containment;
  }

  #stopCallbacks(): void {
    if (this.#callbacksStopped) return;
    this.#callbacksStopped = true;
    for (const [event, listener] of this.#sdkListeners) {
      try { this.sdk.off(event, listener); }
      catch { /* The local callback gate remains closed until process teardown. */ }
      this.#sdkListeners.delete(event);
    }
    this.#listeners.clear();
  }

  #assertObservable(): void {
    if (!this.#sdkUsable || this.#callbacksStopped || this.#contained) {
      throw clientError("observation");
    }
    try { this.sdk.assertHealthy(); }
    catch { this.#sdkUsable = false; throw clientError("observation"); }
  }

  #assertCommandAdmission(): void {
    if (!this.#sdkUsable || this.#contained) {
      throw clientError("local_admission");
    }
    try { this.sdk.assertHealthy(); }
    catch { this.#sdkUsable = false; throw clientError("local_admission"); }
  }

  #runCommand<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#commandTail.then(operation, operation);
    this.#commandTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #attachCallbacks(): void {
    try {
      for (const event of sdkEventNames) {
        const listener: WalletConnectSdkEventListener = (value) => this.#onSdkEvent(event, value);
        this.sdk.on(event, listener);
        this.#sdkListeners.set(event, listener);
      }
    } catch {
      try { this.#stopCallbacks(); } catch { /* Preserve SDK callback admission failure. */ }
      throw clientError("sdk");
    }
  }

  #onSdkEvent(eventName: WalletConnectSdkEventName, event: unknown): void {
    if (this.#callbacksStopped) return;
    const captured = this.#captureSdkEvent(eventName, event);
    if (captured === undefined) return;
    const request = this.#activeRequest;
    if (request?.kind === "signing") {
      const relevant = captured.kind === "identity_unattributed" ||
        captured.topic === undefined || captured.topic === request.topic;
      if (relevant && (eventName === "session_delete" || eventName === "session_expire" ||
        captured.kind === "identity_unattributed" ||
        (captured.kind !== "observation_changed" &&
          walletIdentityEventContradictsAccount(captured, request.account)))) {
        // Ending local delivery does not free the unsettled SDK request lane.
        request.close();
      }
    }
    const pending = this.#pendingEvents;
    if (pending !== undefined) {
      if (pending.length >= maximumPendingSdkEventCount) {
        this.#sdkUsable = false;
        pending.length = 0;
        return;
      }
      pending.push(captured);
      return;
    }
    this.#publishCapturedEvent(captured);
  }

  #captureSdkEvent(
    eventName: WalletConnectSdkEventName,
    event: unknown,
  ): CapturedWalletConnectClientEvent | undefined {
    if (eventName !== "session_event") {
      let topic: string | undefined;
      try { topic = readTopic(event); }
      catch { /* A wake-up need not claim an event source. */ }
      return Object.freeze({
        kind: "observation_changed",
        ...(topic === undefined ? {} : { topic }),
      });
    }
    let topic: string;
    let name: unknown;
    let parameters: unknown;
    let walletEvent: unknown;
    try { topic = readTopic(event); }
    catch { return Object.freeze({ kind: "identity_unattributed" }); }
    try {
      parameters = readOwnData(event, "params");
      walletEvent = readOwnData(parameters, "event");
      name = readOwnData(walletEvent, "name");
    } catch {
      return Object.freeze({ kind: "identity_invalid", topic });
    }
    if (name !== "accountsChanged" && name !== "chainChanged") {
      if (typeof name !== "string" || !validSdkText(name)) {
        return Object.freeze({ kind: "identity_invalid", topic });
      }
      return undefined;
    }
    try {
      const chainId = readOwnData(parameters, "chainId");
      const data = readOwnData(walletEvent, "data");
      if (name === "accountsChanged") {
        const normalized = normalizeChangedAccounts(data, chainId);
        return Object.freeze({
          kind: "accounts_changed",
          topic,
          chainId: normalized.chainId,
          accounts: normalized.accounts,
        });
      }
      const parameterChainId = parseEvmChainId(chainId);
      const changedChainId = normalizeChangedChain(data);
      if (parameterChainId !== changedChainId) throw clientError("sdk");
      return Object.freeze({ kind: "chain_changed", topic, chainId: changedChainId });
    } catch {
      return Object.freeze({ kind: "identity_invalid", topic });
    }
  }

  #publishCapturedEvent(event: CapturedWalletConnectClientEvent): void {
    if (event.kind === "identity_unattributed") {
      this.#emit(event);
      return;
    }
    if (event.kind === "observation_changed") {
      const sessionSourceId = event.topic === undefined
        ? undefined
        : this.#topicToSource.get(event.topic);
      this.#emit(Object.freeze({
        kind: "observation_changed",
        ...(sessionSourceId === undefined ? {} : { sessionSourceId }),
      }));
      return;
    }
    const sessionSourceId = this.#topicToSource.get(event.topic);
    if (sessionSourceId === undefined) {
      this.#emit(Object.freeze({ kind: "identity_unattributed" }));
      return;
    }
    if (event.kind === "identity_invalid") {
      this.#emit(Object.freeze({ kind: "identity_invalid", sessionSourceId }));
    } else if (event.kind === "accounts_changed") {
      this.#emit(Object.freeze({
        kind: "accounts_changed",
        sessionSourceId,
        chainId: event.chainId,
        accounts: event.accounts,
      }));
    } else {
      this.#emit(Object.freeze({
        kind: "chain_changed",
        sessionSourceId,
        chainId: event.chainId,
      }));
    }
  }

  #emit(event: WalletConnectClientEvent): void {
    let listenerFailed = false;
    for (const listener of this.#listeners) {
      try { listener(event); }
      catch { listenerFailed = true; }
    }
    if (listenerFailed) this.#sdkUsable = false;
  }
}

class AcquisitionOwner implements WalletConnectAcquisitionResource {
  #client: WalletConnectClient | undefined;
  #closeWork: Promise<void> | undefined;
  #sdkAcquisitionStarted = false;
  #closed = false;

  constructor(
    private readonly storageOwner: WalletConnectStorageOwner,
    private readonly signal: AbortSignal,
  ) {}

  beginSdkAcquisition(): void {
    if (this.#sdkAcquisitionStarted || this.#closed) {
      throw clientError("local_admission");
    }
    this.#sdkAcquisitionStarted = true;
  }

  setClient(client: WalletConnectClient): void {
    if (!this.#sdkAcquisitionStarted || this.#client !== undefined || this.#closed) {
      throw clientError("local_admission");
    }
    this.#client = client;
  }

  current(): boolean {
    return (
      this.#client !== undefined && !this.#closed &&
      !this.signal.aborted
    );
  }

  processTerminationRequired(): boolean {
    return this.#sdkAcquisitionStarted;
  }

  async contain(): Promise<void> {
    await this.#client?.contain();
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closeWork !== undefined) return this.#closeWork;
    let work: Promise<void>;
    work = Promise.resolve().then(async () => {
      if (this.#sdkAcquisitionStarted) {
        await this.contain();
        throw requireProcessTermination();
      }
      try { this.storageOwner.close(); }
      catch { throw clientError("observation"); }
      this.#closed = true;
    }).finally(() => {
      if (!this.#sdkAcquisitionStarted && this.#closeWork === work) {
        this.#closeWork = undefined;
      }
    });
    this.#closeWork = work;
    return work;
  }
}

export const createWalletConnectClient = async (
  configuration: WalletConnectClientConfiguration,
  registration: WalletConnectAcquisitionRegistration,
  signal: AbortSignal,
  sdkFactory?: WalletConnectSdkFactory,
  moduleLoader: WalletExternalModuleLoader = loadWalletExternalModule,
  relayUrl?: string,
): Promise<WalletConnectClientAcquisition> => {
  const storageOwner = configuration?.storageOwner;
  if (
    typeof storageOwner !== "object" || storageOwner === null ||
    typeof storageOwner.checkpoint !== "function" ||
    typeof storageOwner.close !== "function"
  ) throw clientError("configuration");

  const owner = new AcquisitionOwner(storageOwner, signal);
  try { registration.replace(storageOwner, owner); }
  catch {
    try { await owner.close(); } catch { /* Preserve local ownership admission failure. */ }
    throw clientError("local_admission");
  }
  const abort = (): void => { void owner.contain(); };
  signal.addEventListener("abort", abort, { once: true });
  const acquisitionBudget = createWalletConnectAcquisitionBudget(signal);
  try {
    if (signal.aborted) throw clientError("local_admission");
    if (typeof configuration.createSessionSource !== "function") {
      throw clientError("configuration");
    }
    let wallet: WalletConnectConfigurationState;
    try { wallet = readWalletConnectConfiguration(configuration.wallet); }
    catch { throw clientError("configuration"); }
    const dependencies = await acquisitionBudget.run(
      () => loadWalletConnectProductionDependencies(moduleLoader, relayUrl),
    );
    owner.beginSdkAcquisition();
    const sdkWork = Promise.resolve().then(() =>
      (sdkFactory ?? dependencies.sdkFactory)({
        projectId: wallet.projectId,
        name: wallet.metadata.name,
        metadata: wallet.metadata,
        storage: storageOwner.storage,
        storageOwner,
        telemetryEnabled: false,
        logger: createDroppingLogger(),
      }));
    const sdk = await acquisitionBudget.run(() => sdkWork);
    const client = new WalletConnectClient(
      sdk,
      dependencies.qrEncoder,
      wallet,
      storageOwner,
      configuration.createSessionSource,
    );
    owner.setClient(client);
    if (signal.aborted) throw clientError("local_admission");
    client.startCallbacks();
    if (signal.aborted) throw clientError("local_admission");
    const publicClient: WalletConnectLocalClientPort = Object.freeze({
      observe: () => client.observe(),
      startConnection: () => client.startConnection(),
      containPendingConnectionState: () => client.containPendingConnectionState(),
      disconnectSession: (sourceId: string) => client.disconnectSession(sourceId),
      startRequest: (input: WalletRequestInput) => client.startRequest(input),
      hasPendingRequest: () => client.hasPendingRequest(),
      activate: (listener: (event: WalletConnectClientEvent) => void) =>
        client.activate(listener),
      contain: () => client.contain(),
    });
    let adopted = false;
    let controlled = true;
    let ownedResource: WalletConnectAcquisitionResource = owner;
    return Object.freeze({
      client: publicClient,
      replace(resource: WalletConnectAcquisitionResource): void {
        if (!controlled || (!adopted && !owner.current())) {
          throw clientError("local_admission");
        }
        try { registration.replace(ownedResource, resource); }
        catch { throw clientError("local_admission"); }
        ownedResource = resource;
        if (!adopted) {
          adopted = true;
          signal.removeEventListener("abort", abort);
        }
      },
      transfer(): void {
        if (!adopted || !controlled) throw clientError("local_admission");
        try { registration.transfer(); }
        catch { throw clientError("local_admission"); }
        controlled = false;
      },
    });
  } catch (error) {
    signal.removeEventListener("abort", abort);
    if (owner.processTerminationRequired()) {
      try { await owner.contain(); } catch { /* Process teardown remains terminal. */ }
      throw requireProcessTermination(
        isWalletConnectClientError(error) ? error : clientError("sdk"),
      );
    }
    try { await owner.close(); } catch { /* Preserve the owning creation failure. */ }
    if (isWalletConnectClientError(error)) throw error;
    throw clientError("sdk");
  }
};
