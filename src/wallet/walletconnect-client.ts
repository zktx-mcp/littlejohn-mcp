import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

import {
  canonicalJsonStringify,
  codePointLength,
  compareCodePointSequences,
  fixedIdentifierSchema,
  isSafeSingleLineText,
  parseEvmAddressInput,
} from "../core/index.js";
import type { CanonicalJson, EvmAddress, EvmChainId } from "../core/index.js";
import {
  createResourceOwnershipScope,
  type OwnedResource,
  type OwnedResourceRegistration,
  type OwnedResourceRegistry,
  type ResourceOwnershipScope,
} from "../runtime/resource-ownership.js";
import {
  readWalletConnectConfiguration,
  type WalletConnectConfiguration,
} from "./walletconnect-configuration.js";
import {
  parseWalletQrMatrix,
  walletQrMatrixSizeLimits,
  type WalletQrMatrix,
} from "./contracts.js";
import walletExternalModulesValue from "./external-modules.cjs";

type WalletConnectConfigurationState =
  ReturnType<typeof readWalletConnectConfiguration>;

export type WalletExternalModuleLoader = (
  key: "signClient" | "qrCode",
) => Promise<unknown>;

const walletExternalModules = walletExternalModulesValue as unknown as Readonly<{
  loadSignClientModule(): Promise<unknown>;
  loadQrCodeModule(): Promise<unknown>;
}>;

const loadWalletExternalModule: WalletExternalModuleLoader = (key) => key === "signClient"
  ? walletExternalModules.loadSignClientModule()
  : walletExternalModules.loadQrCodeModule();

const sdkEventNames = Object.freeze([
  "session_update",
  "session_extend",
  "session_delete",
  "session_expire",
  "session_event",
] as const);

const topicPatternSource = "[0-9a-f]{64}";
const topicPattern = new RegExp(`^${topicPatternSource}$`, "u");
const pairingUriPattern = new RegExp(`^wc:(${topicPatternSource})@2\\?([^\\s#]+)$`, "u");
const maximumNamespaceCount = 16;
const maximumNamespaceArrayLength = 64;
const maximumSdkStoreRecordCount = 256;
const maximumSdkTextLength = 512;
const userRejectedCode = 5000;
const acquisitionDeadlineMilliseconds = 5 * 60 * 1_000;

const approvedSessionDisconnectReason = Object.freeze({
  code: 6000,
  message: "User disconnected.",
});

export interface WalletConnectNamespaceSnapshot {
  readonly chains: readonly string[];
  readonly accounts: readonly string[];
  readonly methods: readonly string[];
  readonly events: readonly string[];
}

export interface WalletConnectSessionSnapshot {
  readonly topic: string;
  readonly expiry: number;
  readonly namespaces: Readonly<Record<string, WalletConnectNamespaceSnapshot>>;
}

export type WalletConnectAccountReference =
  `${EvmChainId}:${EvmAddress}`;

export type WalletConnectAttemptOutcome =
  | { readonly status: "approved"; readonly session: WalletConnectSessionSnapshot }
  | { readonly status: "rejected" }
  | { readonly status: "failed" }
  | { readonly status: "cancelled" };

export interface WalletConnectConnectionAttemptPort {
  readonly qr: WalletQrMatrix;
  wait(): Promise<WalletConnectAttemptOutcome>;
  cancel(): Promise<WalletConnectAttemptOutcome>;
}

export type WalletConnectClientEvent =
  | { readonly kind: "session_changed"; readonly topic: string }
  | { readonly kind: "session_deleted"; readonly topic: string }
  | { readonly kind: "session_expired"; readonly topic: string }
  | {
      readonly kind: "session_event";
      readonly topic: string;
      readonly eventName: "accountsChanged";
      readonly data: readonly WalletConnectAccountReference[];
    }
  | {
      readonly kind: "session_event";
      readonly topic: string;
      readonly eventName: "chainChanged";
      readonly data: string;
    }
  | { readonly kind: "session_quarantined" }
  | { readonly kind: "invalid_session_event"; readonly topic: string | null };

export const walletConnectClientErrorCodes = Object.freeze([
  "client_closed",
  "connection_attempt_active",
  "invalid_configuration",
  "invalid_sdk_data",
  "sdk_unavailable",
] as const);

export type WalletConnectClientErrorCode = typeof walletConnectClientErrorCodes[number];

const walletConnectClientErrors = new WeakSet<object>();

const walletConnectClientErrorMessages = Object.freeze({
  client_closed: "The WalletConnect client is closed.",
  connection_attempt_active: "A WalletConnect connection attempt is already active.",
  invalid_configuration: "WalletConnect client configuration is invalid.",
  invalid_sdk_data: "WalletConnect returned invalid data.",
  sdk_unavailable: "WalletConnect is unavailable.",
} satisfies Readonly<Record<WalletConnectClientErrorCode, string>>);

export class WalletConnectClientError extends Error {
  readonly code: WalletConnectClientErrorCode;

  constructor(code: WalletConnectClientErrorCode) {
    super(walletConnectClientErrorMessages[code]);
    this.name = "WalletConnectClientError";
    this.code = code;
    walletConnectClientErrors.add(this);
    Object.freeze(this);
  }
}

export const isWalletConnectClientError = (
  error: unknown,
): error is WalletConnectClientError => {
  return typeof error === "object" && error !== null && walletConnectClientErrors.has(error);
};

export interface WalletConnectClientPort {
  listSessions(): readonly WalletConnectSessionSnapshot[];
  startConnection(): Promise<WalletConnectConnectionAttemptPort>;
  disconnectSession(topic: string): Promise<readonly WalletConnectSessionSnapshot[]>;
  subscribe(listener: (event: WalletConnectClientEvent) => void): () => void;
  close(): Promise<void>;
}

export interface WalletConnectClientConfiguration {
  readonly wallet: WalletConnectConfiguration;
  readonly privateStoreDirectory: string;
}

export type WalletConnectAcquisitionResource = OwnedResource;
export type WalletConnectAcquisitionRegistration = OwnedResourceRegistration;
export type WalletConnectAcquisitionRegistry = OwnedResourceRegistry;
export type WalletConnectAcquisitionScope = ResourceOwnershipScope;
export const createWalletConnectAcquisitionScope = createResourceOwnershipScope;

export interface WalletConnectClientAcquisition {
  readonly client: WalletConnectClientPort;
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
  readonly storageOptions: { readonly database: string };
  readonly telemetryEnabled: false;
  readonly logger: WalletConnectSdkLogger;
}

export interface WalletConnectSdkConnectInput {
  readonly requiredNamespaces: {
    readonly eip155: {
      readonly chains: readonly EvmChainId[];
      readonly methods: WalletConnectConfigurationState["requiredMethods"];
      readonly events: WalletConnectConfigurationState["requiredEvents"];
    };
  };
}

export type WalletConnectSdkEventName = typeof sdkEventNames[number];
export type WalletConnectSdkEventListener = (event: unknown) => void;

interface WalletConnectSdkConnectionLifecycle {
  readonly pairingTopic: string;
  waitForApproval(): Promise<unknown>;
  finishApproval(sessionTopic: string): Promise<void>;
  cancel(): Promise<void>;
}

interface WalletConnectSdkConnectionStart {
  readonly uri: string;
  readonly lifecycle: WalletConnectSdkConnectionLifecycle;
}

export interface WalletConnectSdkPort {
  listSessions(): readonly unknown[];
  listPairings(): readonly unknown[];
  initializeConnectionAttempts(): Promise<void>;
  startConnection(
    input: WalletConnectSdkConnectInput,
  ): Promise<WalletConnectSdkConnectionStart>;
  disconnectPairing(topic: string): Promise<void>;
  disconnectSession(topic: string): Promise<void>;
  on(event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener): void;
  off(event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener): void;
  close(): Promise<void>;
}

export interface WalletConnectSdkAcquisitionAuthority {
  retainCleanup(cleanup: () => Promise<void>): void;
}

export type WalletConnectSdkFactory = (
  options: WalletConnectSdkInitOptions,
  acquisition: WalletConnectSdkAcquisitionAuthority,
) => Promise<WalletConnectSdkPort>;

export type WalletQrEncoder = (uri: string) => WalletQrMatrix;

export interface WalletConnectProductionDependencies {
  readonly sdkFactory: WalletConnectSdkFactory;
  readonly qrEncoder: WalletQrEncoder;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

type ApprovalDisposition = "approved" | "rejected" | "failed";

const createDeferred = <Value>(): Deferred<Value> => {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("WalletConnect result initialization failed.");
  return Object.freeze({ promise, resolve: resolvePromise });
};

const clientError = (code: WalletConnectClientErrorCode): WalletConnectClientError =>
  new WalletConnectClientError(code);

const invalidSdkData = (): WalletConnectClientError => clientError("invalid_sdk_data");
const sdkUnavailable = (): WalletConnectClientError => clientError("sdk_unavailable");
const clientClosed = (): WalletConnectClientError => clientError("client_closed");
const connectionAttemptActive = (): WalletConnectClientError =>
  clientError("connection_attempt_active");

interface WalletConnectAcquisitionBudget {
  run<Value>(operation: () => Promise<Value>): Promise<Value>;
}

const createWalletConnectAcquisitionBudget = (
  signal: AbortSignal,
): WalletConnectAcquisitionBudget => {
  const deadline = performance.now() + acquisitionDeadlineMilliseconds;

  const assertAvailable = (): void => {
    if (signal.aborted || performance.now() >= deadline) throw sdkUnavailable();
  };

  return Object.freeze({
    run<Value>(operation: () => Promise<Value>): Promise<Value> {
      try {
        assertAvailable();
      } catch (error) {
        return Promise.reject(error);
      }

      const pending = Promise.resolve().then(() => {
        assertAvailable();
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
        const rejectUnavailable = (): void => {
          if (settled) return;
          settled = true;
          clear();
          reject(sdkUnavailable());
        };
        const scheduleWakeup = (): void => {
          if (settled) return;
          const remaining = deadline - performance.now();
          if (remaining <= 0) {
            rejectUnavailable();
            return;
          }
          timer = setTimeout(onWakeup, remaining);
          timer.unref();
        };
        const onWakeup = (): void => {
          timer = undefined;
          if (signal.aborted || performance.now() >= deadline) {
            rejectUnavailable();
            return;
          }
          scheduleWakeup();
        };
        const onAbort = (): void => rejectUnavailable();

        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) rejectUnavailable();
        else scheduleWakeup();

        void pending.then(
          (value) => {
            if (settled) return;
            try {
              assertAvailable();
            } catch {
              rejectUnavailable();
              return;
            }
            settled = true;
            clear();
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            try {
              assertAvailable();
            } catch {
              rejectUnavailable();
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

class TrackedWalletConnectAcquisition implements WalletConnectAcquisitionResource {
  readonly authority: WalletConnectSdkAcquisitionAuthority;

  private readonly signal: AbortSignal;
  private readonly onAbort: () => void;
  private cleanup: (() => Promise<void>) | undefined = async () => undefined;
  private activeCleanup: Promise<void> | undefined;
  private observingAbort = true;
  private shutdownRequested = false;
  private released = false;
  private ready = false;

  constructor(signal: AbortSignal) {
    this.signal = signal;
    this.onAbort = () => this.requestShutdown();
    this.authority = Object.freeze({
      retainCleanup: (cleanup: () => Promise<void>) => this.retainCleanup(cleanup),
    });
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.requestShutdown();
  }

  beginSdkAcquisition(): void {
    if (this.shutdownRequested || this.released || this.activeCleanup !== undefined) {
      throw sdkUnavailable();
    }
    this.cleanup = undefined;
    this.ready = false;
  }

  retainCleanup(cleanup: () => Promise<void>): void {
    if (typeof cleanup !== "function") throw sdkUnavailable();
    if (this.released || this.activeCleanup !== undefined) throw sdkUnavailable();
    this.cleanup = cleanup;
    if (this.shutdownRequested) {
      void this.startCleanup().catch(() => undefined);
      throw sdkUnavailable();
    }
  }

  finishSdkAcquisitionWithoutHandle(): void {
    if (this.released || this.activeCleanup !== undefined || this.cleanup !== undefined) return;
    this.cleanup = async () => undefined;
    if (this.shutdownRequested) void this.startCleanup().catch(() => undefined);
  }

  markReady(): void {
    if (
      this.shutdownRequested ||
      this.released ||
      this.activeCleanup !== undefined ||
      this.cleanup === undefined
    ) {
      throw sdkUnavailable();
    }
    this.ready = true;
  }

  adoptionIsCurrent(): boolean {
    return this.ready && !this.signal.aborted && !this.shutdownRequested && !this.released;
  }

  markAdopted(): void {
    this.stopObservingAbort();
  }

  requestShutdown(): void {
    this.shutdownRequested = true;
    this.stopObservingAbort();
    if (this.cleanup !== undefined && this.activeCleanup === undefined && !this.released) {
      void this.startCleanup().catch(() => undefined);
    }
  }

  close(): Promise<void> {
    this.shutdownRequested = true;
    this.stopObservingAbort();
    return this.startCleanup();
  }

  private stopObservingAbort(): void {
    if (!this.observingAbort) return;
    this.observingAbort = false;
    this.signal.removeEventListener("abort", this.onAbort);
  }

  private startCleanup(): Promise<void> {
    if (this.released) return Promise.resolve();
    if (this.activeCleanup !== undefined) return this.activeCleanup;
    const cleanup = this.cleanup;
    if (cleanup === undefined) return Promise.reject(sdkUnavailable());

    let tracked: Promise<void>;
    tracked = Promise.resolve()
      .then(cleanup)
      .then(
        () => {
          this.released = true;
          this.cleanup = undefined;
        },
        () => {
          if (this.activeCleanup === tracked) this.activeCleanup = undefined;
          throw sdkUnavailable();
        },
      );
    this.activeCleanup = tracked;
    return tracked;
  }
}

const isObjectLike = (value: unknown): value is object | ((...args: never[]) => unknown) =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const readOwnDataProperty = (value: unknown, key: string): unknown => {
  if (!isObjectLike(value)) throw invalidSdkData();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.enumerable !== true ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    throw invalidSdkData();
  }
  return descriptor.value;
};

const readOptionalOwnDataProperty = (value: unknown, key: string): unknown => {
  if (!isObjectLike(value)) throw invalidSdkData();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (
    !("value" in descriptor) ||
    descriptor.enumerable !== true ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    throw invalidSdkData();
  }
  return descriptor.value;
};

const assertExactOwnDataProperties = (
  value: unknown,
  expectedKeys: readonly string[],
): void => {
  if (!isObjectLike(value) || Reflect.getPrototypeOf(value) !== Object.prototype) {
    throw invalidSdkData();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw invalidSdkData();
  }
  const actualKeys = (keys as string[]).sort(compareCodePointSequences);
  const canonicalExpectedKeys = [...expectedKeys].sort(compareCodePointSequences);
  for (let index = 0; index < canonicalExpectedKeys.length; index += 1) {
    const key = canonicalExpectedKeys[index];
    const descriptor = key === undefined ? undefined : descriptors[key];
    if (
      actualKeys[index] !== key ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw invalidSdkData();
    }
  }
};

interface CapturedMethod {
  readonly callable: (...arguments_: readonly unknown[]) => unknown;
  readonly receiver: object | ((...args: never[]) => unknown);
}

const captureDataMethod = (
  value: unknown,
  key: string,
  prototypeDepth: 0 | 1 = 0,
  enumerable = true,
): CapturedMethod => {
  if (!isObjectLike(value)) throw invalidSdkData();
  const owner = prototypeDepth === 0 ? value : Reflect.getPrototypeOf(value) as object | null;
  if (owner === null) throw invalidSdkData();
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== enumerable ||
    typeof descriptor.value !== "function"
  ) {
    throw invalidSdkData();
  }
  return Object.freeze({
    callable: descriptor.value as (...arguments_: readonly unknown[]) => unknown,
    receiver: value,
  });
};

const invokeMethod = (
  method: CapturedMethod,
  arguments_: readonly unknown[],
): unknown => Reflect.apply(method.callable, method.receiver, arguments_);

const normalizeRawSdkConnection = (
  value: unknown,
): { readonly uri: string | undefined; readonly approval: () => Promise<unknown> } => {
  const uri = readOptionalOwnDataProperty(value, "uri");
  const approval = readOwnDataProperty(value, "approval");
  if ((uri !== undefined && typeof uri !== "string") || typeof approval !== "function") {
    throw invalidSdkData();
  }
  return Object.freeze({
    uri,
    approval: async () => Reflect.apply(approval, value, []) as Promise<unknown>,
  });
};

const normalizeSdkConnectionLifecycle = (
  value: unknown,
): WalletConnectSdkConnectionLifecycle => {
  assertExactOwnDataProperties(value, [
    "pairingTopic",
    "waitForApproval",
    "finishApproval",
    "cancel",
  ]);
  const pairingTopic = readOwnDataProperty(value, "pairingTopic");
  const waitForApproval = captureDataMethod(value, "waitForApproval");
  const finishApproval = captureDataMethod(value, "finishApproval");
  const cancel = captureDataMethod(value, "cancel");
  if (typeof pairingTopic !== "string" || !topicPattern.test(pairingTopic)) {
    throw invalidSdkData();
  }
  return Object.freeze({
    pairingTopic,
    waitForApproval: async () => invokeMethod(waitForApproval, []),
    finishApproval: async (sessionTopic: string) => {
      await invokeMethod(finishApproval, [sessionTopic]);
    },
    cancel: async () => {
      await invokeMethod(cancel, []);
    },
  });
};

const normalizeSdkConnectionStart = (
  value: unknown,
): WalletConnectSdkConnectionStart => {
  assertExactOwnDataProperties(value, ["uri", "lifecycle"]);
  const uri = readOwnDataProperty(value, "uri");
  const rawLifecycle = readOwnDataProperty(value, "lifecycle");
  if (typeof uri !== "string" || rawLifecycle === value) throw invalidSdkData();
  const lifecycle = normalizeSdkConnectionLifecycle(rawLifecycle);
  if (pairingTopicFromUri(uri) !== lifecycle.pairingTopic) throw invalidSdkData();
  return Object.freeze({ uri, lifecycle });
};

const validSdkText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= maximumSdkTextLength * 2 &&
  codePointLength(value) <= maximumSdkTextLength &&
  isSafeSingleLineText(value);

const copySdkArray = (value: unknown, maximumLength: number): readonly unknown[] => {
  if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) {
    throw invalidSdkData();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as
    Record<PropertyKey, PropertyDescriptor>;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol")) throw invalidSdkData();
  const lengthDescriptor = descriptors["length"];
  const length = lengthDescriptor?.value as unknown;
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable !== false ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximumLength
  ) {
    throw invalidSdkData();
  }

  const permittedKeys = new Set<string>(["length"]);
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    permittedKeys.add(key);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw invalidSdkData();
    }
    output.push(descriptor.value);
  }
  if (keys.some((key) => typeof key !== "string" || !permittedKeys.has(key))) {
    throw invalidSdkData();
  }
  return Object.freeze(output);
};

const copySdkStringArray = (value: unknown): readonly string[] => {
  const values = copySdkArray(value, maximumNamespaceArrayLength);
  if (!values.every(validSdkText)) throw invalidSdkData();
  return values as readonly string[];
};

const copyOptionalSdkStringArray = (value: unknown): readonly string[] =>
  value === undefined ? Object.freeze([] as string[]) : copySdkStringArray(value);

const normalizeNamespace = (value: unknown): WalletConnectNamespaceSnapshot => {
  const accounts = copySdkStringArray(readOwnDataProperty(value, "accounts"));
  const methods = copySdkStringArray(readOwnDataProperty(value, "methods"));
  const events = copySdkStringArray(readOwnDataProperty(value, "events"));
  const chains = readOptionalOwnDataProperty(value, "chains");
  return Object.freeze({
    chains: copyOptionalSdkStringArray(chains),
    accounts,
    methods,
    events,
  });
};

const normalizeNamespaces = (
  value: unknown,
): Readonly<Record<string, WalletConnectNamespaceSnapshot>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidSdkData();
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidSdkData();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol") || keys.length > maximumNamespaceCount) {
    throw invalidSdkData();
  }
  const namespaceNames = (keys as string[]).sort(compareCodePointSequences);
  const output = Object.create(null) as Record<string, WalletConnectNamespaceSnapshot>;
  for (const namespace of namespaceNames) {
    if (!fixedIdentifierSchema.safeParse(namespace).success) throw invalidSdkData();
    const descriptor = descriptors[namespace];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw invalidSdkData();
    }
    output[namespace] = normalizeNamespace(descriptor.value);
  }
  return Object.freeze(output);
};

const readTopic = (value: unknown): string => {
  const topic = readOwnDataProperty(value, "topic");
  if (typeof topic !== "string" || !topicPattern.test(topic)) throw invalidSdkData();
  return topic;
};

const readTopicOrNull = (value: unknown): string | null => {
  try {
    return readTopic(value);
  } catch {
    return null;
  }
};

const normalizeSession = (value: unknown): WalletConnectSessionSnapshot => {
  const topic = readTopic(value);
  const expiry = readOwnDataProperty(value, "expiry");
  if (
    typeof expiry !== "number" ||
    !Number.isSafeInteger(expiry) ||
    expiry <= 0
  ) {
    throw invalidSdkData();
  }
  return Object.freeze({
    topic,
    expiry,
    namespaces: normalizeNamespaces(readOwnDataProperty(value, "namespaces")),
  });
};

interface WalletConnectSessionInternalSnapshot {
  readonly pairingTopic: string;
  readonly public: WalletConnectSessionSnapshot;
}

const normalizeSessionInternal = (value: unknown): WalletConnectSessionInternalSnapshot => {
  const publicSnapshot = normalizeSession(value);
  const pairingTopic = readOwnDataProperty(value, "pairingTopic");
  if (typeof pairingTopic !== "string" || !topicPattern.test(pairingTopic)) {
    throw invalidSdkData();
  }
  return Object.freeze({ pairingTopic, public: publicSnapshot });
};

const sessionIdentity = (session: WalletConnectSessionInternalSnapshot): string =>
  canonicalJsonStringify(session as unknown as CanonicalJson);

interface RawTopicStoreIndex {
  readonly records: readonly unknown[];
  readonly recordsByTopic: ReadonlyMap<string, readonly unknown[]>;
  readonly hasUnknownTopic: boolean;
}

const indexRawTopicStore = (value: unknown): RawTopicStoreIndex => {
  const records = copySdkArray(value, maximumSdkStoreRecordCount);
  const mutableRecordsByTopic = new Map<string, unknown[]>();
  let hasUnknownTopic = false;
  for (const record of records) {
    const topic = readTopicOrNull(record);
    if (topic === null) {
      hasUnknownTopic = true;
      continue;
    }
    const topicRecords = mutableRecordsByTopic.get(topic) ?? [];
    topicRecords.push(record);
    mutableRecordsByTopic.set(topic, topicRecords);
  }
  const recordsByTopic = new Map<string, readonly unknown[]>();
  for (const [topic, topicRecords] of mutableRecordsByTopic) {
    recordsByTopic.set(topic, Object.freeze([...topicRecords]));
  }
  return Object.freeze({ records, recordsByTopic, hasUnknownTopic });
};

const canProveTopicAbsent = (index: RawTopicStoreIndex, topic: string): boolean =>
  !index.hasUnknownTopic && !index.recordsByTopic.has(topic);

interface NormalizedSessionStore {
  readonly sessions: readonly WalletConnectSessionInternalSnapshot[];
  readonly malformedTopics: ReadonlySet<string>;
  readonly hasUnknownMalformedSession: boolean;
}

const normalizeSessionStore = (index: RawTopicStoreIndex): NormalizedSessionStore => {
  const sessions: WalletConnectSessionInternalSnapshot[] = [];
  const malformedTopics = new Set<string>();
  const hasUnknownMalformedSession = index.hasUnknownTopic;
  for (const [topic, records] of index.recordsByTopic) {
    if (records.length !== 1) {
      malformedTopics.add(topic);
      continue;
    }
    try {
      const session = normalizeSessionInternal(records[0]);
      if (session.public.topic !== topic) throw invalidSdkData();
      sessions.push(session);
    } catch {
      malformedTopics.add(topic);
    }
  }
  sessions.sort((left, right) =>
    compareCodePointSequences(left.public.topic, right.public.topic));
  return Object.freeze({
    sessions: Object.freeze(sessions),
    malformedTopics,
    hasUnknownMalformedSession,
  });
};

interface WalletConnectProposalReference {
  readonly id: number;
  readonly pairingTopic: string;
  readonly expiryTimestamp: number;
}

const normalizeProposalReference = (value: unknown): WalletConnectProposalReference => {
  const id = readOwnDataProperty(value, "id");
  const pairingTopic = readOwnDataProperty(value, "pairingTopic");
  const expiryTimestamp = readOwnDataProperty(value, "expiryTimestamp");
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof pairingTopic !== "string" ||
    !topicPattern.test(pairingTopic) ||
    typeof expiryTimestamp !== "number" ||
    !Number.isSafeInteger(expiryTimestamp) ||
    expiryTimestamp <= 0
  ) {
    throw invalidSdkData();
  }
  return Object.freeze({ id, pairingTopic, expiryTimestamp });
};

const normalizeProposalStore = (value: unknown): readonly WalletConnectProposalReference[] => {
  const proposals = copySdkArray(value, maximumSdkStoreRecordCount)
    .map(normalizeProposalReference);
  const ids = new Set<number>();
  for (const proposal of proposals) {
    if (ids.has(proposal.id)) throw invalidSdkData();
    ids.add(proposal.id);
  }
  return Object.freeze(proposals.sort((left, right) => left.id - right.id));
};

interface PendingSessionReference {
  readonly proposalId: number;
  readonly pairingTopic: string;
  readonly sessionTopic: string;
  readonly publicKey: string;
}

const normalizePendingSessionReference = (value: unknown): PendingSessionReference => {
  const proposalId = readOwnDataProperty(value, "proposalId");
  const pairingTopic = readOwnDataProperty(value, "pairingTopic");
  const sessionTopic = readOwnDataProperty(value, "sessionTopic");
  const publicKey = readOwnDataProperty(value, "publicKey");
  if (
    typeof proposalId !== "number" ||
    !Number.isSafeInteger(proposalId) ||
    proposalId <= 0 ||
    typeof pairingTopic !== "string" ||
    !topicPattern.test(pairingTopic) ||
    typeof sessionTopic !== "string" ||
    !topicPattern.test(sessionTopic) ||
    typeof publicKey !== "string" ||
    !topicPattern.test(publicKey)
  ) {
    throw invalidSdkData();
  }
  return Object.freeze({ proposalId, pairingTopic, sessionTopic, publicKey });
};

const replaceOwnDataMethod = (
  value: unknown,
  key: string,
  replacement: (...arguments_: readonly unknown[]) => unknown,
): CapturedMethod => {
  if (!isObjectLike(value)) throw invalidSdkData();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true ||
    descriptor.configurable !== true ||
    descriptor.writable !== true ||
    typeof descriptor.value !== "function"
  ) {
    throw invalidSdkData();
  }
  const captured = Object.freeze({
    callable: descriptor.value as (...arguments_: readonly unknown[]) => unknown,
    receiver: value,
  });
  Object.defineProperty(value, key, { ...descriptor, value: replacement });
  return captured;
};

const restoreOwnDataMethod = (
  value: unknown,
  key: string,
  captured: CapturedMethod | undefined,
): void => {
  if (captured === undefined || !isObjectLike(value)) return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return;
  Object.defineProperty(value, key, { ...descriptor, value: captured.callable });
};

interface ProductionProposalState {
  readonly id: number;
  readonly pairingTopic: string;
  readonly expiryTimestamp: number;
  readonly preservePairing: boolean;
  readonly preservedSessions: ReadonlyMap<string, string>;
  phase:
    | "owned"
    | "approval_observed"
    | "approval_rejected"
    | "cancelling"
    | "cancelled_complete"
    | "finishing_approval"
    | "approved_complete"
    | "poisoned";
  approval: Promise<unknown> | undefined;
  transitionWork: Promise<void> | undefined;
  approvedSessionTopic: string | undefined;
}

interface ProductionProposalAttempt {
  waitForApproval(): Promise<unknown>;
  finishApproval(sessionTopic: string): Promise<void>;
  cancel(): Promise<void>;
}

const createProductionConnectionLifecycle = (
  pairingTopic: string,
  proposalAttempt: ProductionProposalAttempt,
  assertAvailable: () => void,
  poison: () => Promise<never>,
): WalletConnectSdkConnectionLifecycle => Object.freeze({
  pairingTopic,
  waitForApproval: () => proposalAttempt.waitForApproval(),
  finishApproval: async (sessionTopic: string) => {
    assertAvailable();
    try {
      await proposalAttempt.finishApproval(sessionTopic);
    } catch {
      await poison();
    }
  },
  cancel: async () => {
    assertAvailable();
    try {
      await proposalAttempt.cancel();
    } catch {
      await poison();
    }
  },
});

class ProductionProposalController {
  private readonly proposalGetAll: CapturedMethod;
  private readonly expirerSet: CapturedMethod;
  private readonly clientOn: CapturedMethod;
  private readonly clientOff: CapturedMethod;
  private readonly pairingDisconnect: CapturedMethod;
  private readonly pairingGetAll: CapturedMethod;
  private readonly sessionDisconnect: CapturedMethod;
  private readonly sessionGetAll: CapturedMethod;
  private readonly pendingSessions: Map<unknown, unknown>;
  private readonly originalProposalResponse: CapturedMethod;
  private readonly originalSessionSettle: CapturedMethod;
  private readonly originalSessionSet: CapturedMethod;
  private readonly proposalActivities = new Map<number, Set<Promise<void>>>();
  private readonly sessionWriteActivities = new Map<string, Set<Promise<void>>>();
  private readonly states = new Map<number, ProductionProposalState>();

  constructor(client: unknown, core: unknown) {
    const proposal = readOwnDataProperty(client, "proposal");
    const engine = readOwnDataProperty(client, "engine");
    const session = readOwnDataProperty(client, "session");
    const expirer = readOwnDataProperty(core, "expirer");
    const pairing = readOwnDataProperty(core, "pairing");
    const pendingSessions = readOwnDataProperty(engine, "pendingSessions");
    if (!(pendingSessions instanceof Map) || Reflect.getPrototypeOf(pendingSessions) !== Map.prototype) {
      throw invalidSdkData();
    }
    this.pendingSessions = pendingSessions;
    this.proposalGetAll = captureDataMethod(proposal, "getAll");
    this.expirerSet = captureDataMethod(expirer, "set");
    this.clientOn = captureDataMethod(client, "on");
    this.clientOff = captureDataMethod(client, "off");
    this.pairingDisconnect = captureDataMethod(pairing, "disconnect");
    this.pairingGetAll = captureDataMethod(pairing, "getPairings");
    this.sessionDisconnect = captureDataMethod(client, "disconnect");
    this.sessionGetAll = captureDataMethod(session, "getAll");

    let proposalResponse: CapturedMethod | undefined;
    let sessionSettle: CapturedMethod | undefined;
    let sessionSet: CapturedMethod | undefined;
    try {
      proposalResponse = replaceOwnDataMethod(
        engine,
        "onSessionProposeResponse",
        (...arguments_) => this.onSessionProposeResponse(arguments_),
      );
      sessionSettle = replaceOwnDataMethod(
        engine,
        "onSessionSettleRequest",
        (...arguments_) => this.onSessionSettleRequest(arguments_),
      );
      sessionSet = replaceOwnDataMethod(
        session,
        "set",
        (...arguments_) => this.onSessionSet(arguments_),
      );
      this.originalProposalResponse = proposalResponse;
      this.originalSessionSettle = sessionSettle;
      this.originalSessionSet = sessionSet;
    } catch {
      try { restoreOwnDataMethod(session, "set", sessionSet); }
      catch { /* The SDK handle remains owned by acquisition cleanup and is never exposed. */ }
      try { restoreOwnDataMethod(engine, "onSessionSettleRequest", sessionSettle); }
      catch { /* The SDK handle remains owned by acquisition cleanup and is never exposed. */ }
      try { restoreOwnDataMethod(engine, "onSessionProposeResponse", proposalResponse); }
      catch { /* The SDK handle remains owned by acquisition cleanup and is never exposed. */ }
      throw invalidSdkData();
    }
  }

  assertConnectionReady(): void {
    this.pruneFinishedStates();
    if (this.readProposals().length !== 0 || this.pendingSessions.size !== 0) {
      throw sdkUnavailable();
    }
  }

  async bindConnection(
    pairingTopic: string,
    approval: () => Promise<unknown>,
  ): Promise<ProductionProposalAttempt> {
    this.pruneFinishedStates();
    const proposals = this.readProposals();
    const proposal = proposals[0];
    if (proposals.length !== 1 || proposal === undefined || proposal.pairingTopic !== pairingTopic) {
      throw invalidSdkData();
    }
    if (
      this.states.has(proposal.id) ||
      [...this.states.values()].some((state) => state.pairingTopic === pairingTopic) ||
      this.states.size >= maximumSdkStoreRecordCount
    ) {
      throw invalidSdkData();
    }
    const state: ProductionProposalState = {
      id: proposal.id,
      pairingTopic,
      expiryTimestamp: proposal.expiryTimestamp,
      preservePairing: false,
      preservedSessions: new Map<string, string>(),
      phase: "owned",
      approval: undefined,
      transitionWork: undefined,
      approvedSessionTopic: undefined,
    };
    this.states.set(proposal.id, state);
    let rawApproval: Promise<unknown>;
    try {
      rawApproval = approval();
    } catch {
      await this.cancel(state);
      throw sdkUnavailable();
    }
    const observedApproval = Promise.resolve(rawApproval).then(
      (value) => {
        if (state.phase === "owned") state.phase = "approval_observed";
        return value;
      },
      (error: unknown) => {
        if (state.phase === "owned") state.phase = "approval_rejected";
        throw error;
      },
    );
    state.approval = observedApproval;
    void observedApproval.catch(() => undefined);
    return Object.freeze({
      waitForApproval: () => observedApproval,
      finishApproval: (sessionTopic: string) => this.finishApproval(state, sessionTopic),
      cancel: () => this.cancel(state),
    });
  }

  async initialize(): Promise<void> {
    const sessions = normalizeSessionStore(indexRawTopicStore(
      invokeMethod(this.sessionGetAll, []),
    ));
    if (sessions.hasUnknownMalformedSession || sessions.malformedTopics.size !== 0) {
      throw invalidSdkData();
    }
    const proposals = this.readProposals();
    for (const proposal of proposals) {
      const preservedSessions = new Map(sessions.sessions
        .filter((session) => session.pairingTopic === proposal.pairingTopic)
        .map((session) => [session.public.topic, sessionIdentity(session)] as const));
      const state: ProductionProposalState = {
        id: proposal.id,
        pairingTopic: proposal.pairingTopic,
        expiryTimestamp: proposal.expiryTimestamp,
        preservePairing: preservedSessions.size !== 0,
        preservedSessions,
        phase: "owned",
        approval: undefined,
        transitionWork: undefined,
        approvedSessionTopic: undefined,
      };
      this.states.set(proposal.id, state);
      await this.cancel(state);
    }
  }

  private cancel(state: ProductionProposalState): Promise<void> {
    if (state.phase === "cancelled_complete") return Promise.resolve();
    if (state.phase === "cancelling" && state.transitionWork !== undefined) {
      return state.transitionWork;
    }
    if (
      state.phase === "finishing_approval" ||
      state.phase === "approved_complete" ||
      state.phase === "poisoned"
    ) {
      return Promise.reject(sdkUnavailable());
    }
    state.phase = "cancelling";
    let work: Promise<void>;
    work = this.performCancellation(state).then(
      () => {
        state.approval = undefined;
        state.phase = "cancelled_complete";
        if (state.transitionWork === work) state.transitionWork = undefined;
      },
      () => {
        state.approval = undefined;
        state.phase = "poisoned";
        if (state.transitionWork === work) state.transitionWork = undefined;
        throw sdkUnavailable();
      },
    );
    state.transitionWork = work;
    return work;
  }

  private finishApproval(
    state: ProductionProposalState,
    sessionTopic: string,
  ): Promise<void> {
    if (!topicPattern.test(sessionTopic)) return Promise.reject(sdkUnavailable());
    if (
      state.phase === "approved_complete" &&
      state.approvedSessionTopic === sessionTopic
    ) {
      return Promise.resolve();
    }
    if (
      state.phase === "finishing_approval" &&
      state.approvedSessionTopic === sessionTopic &&
      state.transitionWork !== undefined
    ) {
      return state.transitionWork;
    }
    if (state.phase !== "approval_observed") return Promise.reject(sdkUnavailable());
    state.phase = "finishing_approval";
    state.approvedSessionTopic = sessionTopic;
    let work: Promise<void>;
    work = this.performFinishApproval(state, sessionTopic).then(
      () => {
        state.approval = undefined;
        state.phase = "approved_complete";
        if (state.transitionWork === work) state.transitionWork = undefined;
      },
      () => {
        state.approval = undefined;
        state.phase = "poisoned";
        if (state.transitionWork === work) state.transitionWork = undefined;
        throw sdkUnavailable();
      },
    );
    state.transitionWork = work;
    return work;
  }

  private async performCancellation(state: ProductionProposalState): Promise<void> {
    if (!state.preservePairing) {
      try {
        await invokeMethod(this.pairingDisconnect, [{ topic: state.pairingTopic }]);
      } catch {
        // Exact proposal expiry is an independent barrier and still runs below.
      }
    }
    await this.drain(state);
    await this.expireProposal(state.id);
    await state.approval?.then(() => undefined, () => undefined);
    await this.drain(state);
    await this.quarantineStoredSessions(state);
    await this.drain(state);
    if (
      !this.proposalAbsent(state.id) ||
      (!state.preservePairing && !this.pairingAbsent(state.pairingTopic)) ||
      this.hasPendingSession(state) ||
      this.hasUnexpectedStoredSession(state)
    ) {
      throw sdkUnavailable();
    }
  }

  private async performFinishApproval(
    state: ProductionProposalState,
    sessionTopic: string,
  ): Promise<void> {
    await this.drain(state);
    const sessions = this.readSessionStore().sessions.filter(
      (candidate) => candidate.pairingTopic === state.pairingTopic,
    );
    const session = sessions[0];
    if (
      !this.proposalAbsent(state.id) ||
      this.hasPendingSession(state) ||
      !this.pairingPresentExactlyOnce(state.pairingTopic) ||
      sessions.length !== 1 ||
      session === undefined ||
      session.public.topic !== sessionTopic
    ) {
      throw sdkUnavailable();
    }
  }

  private async quarantineStoredSessions(state: ProductionProposalState): Promise<void> {
    const sessions = this.readSessionStore();
    const topics = sessions.sessions
      .filter((session) =>
        session.pairingTopic === state.pairingTopic &&
        state.preservedSessions.get(session.public.topic) !== sessionIdentity(session))
      .map((session) => session.public.topic)
      .sort(compareCodePointSequences);
    for (const topic of topics) {
      try {
        await invokeMethod(this.sessionDisconnect, [{
          topic,
          reason: approvedSessionDisconnectReason,
        }]);
      } catch {
        if (this.hasStoredSessionTopic(topic)) throw sdkUnavailable();
      }
      if (this.hasStoredSessionTopic(topic)) throw sdkUnavailable();
    }
  }

  private onSessionProposeResponse(arguments_: readonly unknown[]): unknown {
    const topic = arguments_[0];
    const payload = arguments_[1];
    let proposalId: number | undefined;
    try {
      const id = readOwnDataProperty(payload, "id");
      if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) proposalId = id;
    } catch {
      // The pinned SDK retains authority to reject malformed provider payloads.
    }
    const stateById = proposalId === undefined ? undefined : this.states.get(proposalId);
    const statesByTopic = typeof topic === "string"
      ? [...this.states.values()].filter((state) => state.pairingTopic === topic)
      : [];
    if (stateById !== undefined || statesByTopic.length !== 0) {
      if (
        stateById === undefined ||
        typeof topic !== "string" ||
        stateById.pairingTopic !== topic
      ) {
        return Promise.reject(sdkUnavailable());
      }
      if (stateById.phase !== "owned") return Promise.resolve();
    }
    const result = Promise.resolve().then(() => invokeMethod(
      this.originalProposalResponse,
      arguments_,
    ));
    if (proposalId === undefined) return result;
    return this.track(this.proposalActivities, proposalId, result);
  }

  private onSessionSet(arguments_: readonly unknown[]): unknown {
    const session = arguments_[1];
    let pairingTopic: string;
    try {
      const value = readOwnDataProperty(session, "pairingTopic");
      if (typeof value !== "string" || !topicPattern.test(value)) throw invalidSdkData();
      pairingTopic = value;
    } catch {
      return Promise.reject(invalidSdkData());
    }
    if ([...this.states.values()].some((state) =>
      state.pairingTopic === pairingTopic &&
      ![
        "owned",
        "approval_observed",
        "approved_complete",
      ].includes(state.phase))) {
      return Promise.reject(sdkUnavailable());
    }
    const result = Promise.resolve().then(() => invokeMethod(this.originalSessionSet, arguments_));
    return this.track(this.sessionWriteActivities, pairingTopic, result);
  }

  private onSessionSettleRequest(arguments_: readonly unknown[]): unknown {
    const sessionTopic = arguments_[0];
    if (typeof sessionTopic !== "string" || !topicPattern.test(sessionTopic)) {
      return Promise.reject(invalidSdkData());
    }
    let pending: PendingSessionReference | undefined;
    try {
      pending = this.pendingSessionForTopic(sessionTopic);
    } catch {
      return Promise.reject(sdkUnavailable());
    }
    if (pending === undefined) {
      return Promise.resolve().then(() => invokeMethod(this.originalSessionSettle, arguments_));
    }
    const state = this.states.get(pending.proposalId);
    const statesByPairing = [...this.states.values()].filter(
      (candidate) => candidate.pairingTopic === pending.pairingTopic,
    );
    if (state !== undefined || statesByPairing.length !== 0) {
      if (state === undefined || state.pairingTopic !== pending.pairingTopic) {
        return Promise.reject(sdkUnavailable());
      }
      if (state.phase !== "owned") return Promise.resolve();
    }
    const result = Promise.resolve().then(() => invokeMethod(
      this.originalSessionSettle,
      arguments_,
    ));
    return this.track(this.proposalActivities, pending.proposalId, result);
  }

  private pendingSessionForTopic(sessionTopic: string): PendingSessionReference | undefined {
    if (this.pendingSessions.size > maximumSdkStoreRecordCount) throw invalidSdkData();
    let match: PendingSessionReference | undefined;
    Map.prototype.forEach.call(this.pendingSessions, (value: unknown, key: unknown) => {
      const pending = normalizePendingSessionReference(value);
      if (key !== pending.proposalId) throw invalidSdkData();
      if (pending.sessionTopic !== sessionTopic) return;
      if (match !== undefined) throw invalidSdkData();
      match = pending;
    });
    return match;
  }

  private track<Key>(
    activities: Map<Key, Set<Promise<void>>>,
    key: Key,
    operation: Promise<unknown>,
  ): Promise<unknown> {
    let completion: Promise<void>;
    completion = operation.then(() => undefined, () => undefined).finally(() => {
      const tracked = activities.get(key);
      tracked?.delete(completion);
      if (tracked?.size === 0) activities.delete(key);
    });
    const tracked = activities.get(key) ?? new Set<Promise<void>>();
    tracked.add(completion);
    activities.set(key, tracked);
    return operation;
  }

  private async drain(state: ProductionProposalState): Promise<void> {
    for (;;) {
      const activities = [
        ...(this.proposalActivities.get(state.id) ?? []),
        ...(this.sessionWriteActivities.get(state.pairingTopic) ?? []),
      ];
      if (activities.length === 0) return;
      await Promise.all(activities);
    }
  }

  private readProposals(): readonly WalletConnectProposalReference[] {
    try {
      return normalizeProposalStore(invokeMethod(this.proposalGetAll, []));
    } catch {
      throw sdkUnavailable();
    }
  }

  private proposalAbsent(id: number): boolean {
    return !this.readProposals().some((proposal) => proposal.id === id);
  }

  private pairingAbsent(topic: string): boolean {
    try {
      return canProveTopicAbsent(indexRawTopicStore(
        invokeMethod(this.pairingGetAll, []),
      ), topic);
    } catch {
      throw sdkUnavailable();
    }
  }

  private pairingPresentExactlyOnce(topic: string): boolean {
    try {
      const index = indexRawTopicStore(invokeMethod(this.pairingGetAll, []));
      return !index.hasUnknownTopic && index.recordsByTopic.get(topic)?.length === 1;
    } catch {
      throw sdkUnavailable();
    }
  }

  private hasUnexpectedStoredSession(state: ProductionProposalState): boolean {
    return this.readSessionStore().sessions.some(
      (session) =>
        session.pairingTopic === state.pairingTopic &&
        state.preservedSessions.get(session.public.topic) !== sessionIdentity(session),
    );
  }

  private hasStoredSessionTopic(topic: string): boolean {
    return this.readSessionStore().sessions.some(
      (session) => session.public.topic === topic,
    );
  }

  private readSessionStore(): NormalizedSessionStore {
    try {
      const store = normalizeSessionStore(indexRawTopicStore(
        invokeMethod(this.sessionGetAll, []),
      ));
      if (store.hasUnknownMalformedSession || store.malformedTopics.size !== 0) {
        throw invalidSdkData();
      }
      return store;
    } catch {
      throw sdkUnavailable();
    }
  }

  private pruneFinishedStates(): void {
    const now = Math.floor(Date.now() / 1_000);
    for (const [id, state] of this.states) {
      if (
        (state.phase === "cancelled_complete" || state.phase === "approved_complete") &&
        state.expiryTimestamp <= now &&
        !this.proposalActivities.has(id) &&
        !this.sessionWriteActivities.has(state.pairingTopic)
      ) {
        this.states.delete(id);
      }
    }
  }

  private hasPendingSession(state: ProductionProposalState): boolean {
    try {
      if (this.pendingSessions.size > maximumSdkStoreRecordCount) throw invalidSdkData();
      let found = false;
      Map.prototype.forEach.call(this.pendingSessions, (value: unknown, key: unknown) => {
        const pending = normalizePendingSessionReference(value);
        if (key !== pending.proposalId) throw invalidSdkData();
        if (pending.proposalId === state.id || pending.pairingTopic === state.pairingTopic) {
          found = true;
        }
      });
      return found;
    } catch {
      throw sdkUnavailable();
    }
  }

  private async expireProposal(id: number): Promise<void> {
    if (this.proposalAbsent(id)) return;
    let eventObserved = false;
    const listener = (event: unknown): void => {
      try {
        if (readOwnDataProperty(event, "id") !== id) return;
        eventObserved = true;
      } catch {
        // Another malformed SDK event cannot complete this exact proposal.
      }
    };
    let listenerDetached = false;
    try {
      invokeMethod(this.clientOn, ["proposal_expire", listener]);
      try {
        invokeMethod(this.expirerSet, [id, Math.floor(Date.now() / 1_000) - 1]);
      } catch {
        // Store absence remains authoritative when the command reports failure.
      }
      const deadline = performance.now() + acquisitionDeadlineMilliseconds;
      let consecutiveAbsence = 0;
      for (;;) {
        if (this.proposalAbsent(id)) {
          consecutiveAbsence += 1;
          if (eventObserved || consecutiveAbsence >= 2) break;
        } else {
          consecutiveAbsence = 0;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw sdkUnavailable();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(25, remaining));
        });
      }
    } catch {
      throw sdkUnavailable();
    } finally {
      try {
        invokeMethod(this.clientOff, ["proposal_expire", listener]);
        listenerDetached = true;
      } catch {
        // The caller poisons and closes the SDK when exact listener release is unproven.
      }
    }
    if (!listenerDetached || !this.proposalAbsent(id)) throw sdkUnavailable();
  }
}

const pairingTopicFromUri = (uri: string): string => {
  if (!validSdkText(uri)) throw invalidSdkData();
  const match = pairingUriPattern.exec(uri);
  const topic = match?.[1];
  const query = match?.[2];
  if (topic === undefined || query === undefined) throw invalidSdkData();
  const parameters = new URLSearchParams(query);
  const allowedNames = new Set([
    "expiryTimestamp",
    "methods",
    "relay-data",
    "relay-protocol",
    "symKey",
  ]);
  const values = new Map<string, string>();
  for (const [name, value] of parameters) {
    if (!allowedNames.has(name) || values.has(name) || !validSdkText(value)) {
      throw invalidSdkData();
    }
    values.set(name, value);
  }
  const relayProtocol = values.get("relay-protocol");
  const symmetricKey = values.get("symKey");
  if (relayProtocol !== "irn" || symmetricKey === undefined || !topicPattern.test(symmetricKey)) {
    throw invalidSdkData();
  }
  const relayData = values.get("relay-data");
  if (relayData !== undefined && relayData.length === 0) throw invalidSdkData();
  const expiryTimestamp = values.get("expiryTimestamp");
  if (expiryTimestamp !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(expiryTimestamp)) throw invalidSdkData();
    const parsedExpiry = Number(expiryTimestamp);
    if (!Number.isSafeInteger(parsedExpiry)) throw invalidSdkData();
  }
  const methods = values.get("methods");
  if (methods !== undefined) {
    const methodValues = methods.split(",");
    if (
      methodValues.length === 0 ||
      methodValues.length > maximumNamespaceArrayLength ||
      methodValues.some((method) => !fixedIdentifierSchema.safeParse(method).success) ||
      new Set(methodValues).size !== methodValues.length
    ) {
      throw invalidSdkData();
    }
  }
  return topic;
};

const qrMatrixFromValue = (value: unknown): WalletQrMatrix => {
  const modules = readOwnDataProperty(value, "modules");
  const size = readOwnDataProperty(modules, "size");
  const data = readOwnDataProperty(modules, "data");
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < walletQrMatrixSizeLimits.minimum ||
    size > walletQrMatrixSizeLimits.maximum ||
    !ArrayBuffer.isView(data) ||
    Reflect.getPrototypeOf(data) !== Uint8Array.prototype
  ) {
    throw invalidSdkData();
  }
  const descriptors = Object.getOwnPropertyDescriptors(data);
  const keys = Reflect.ownKeys(descriptors);
  const expectedLength = size * size;
  if (keys.length !== expectedLength || keys.some((key) => typeof key !== "string")) {
    throw invalidSdkData();
  }
  const copiedData = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      (descriptor.value !== 0 && descriptor.value !== 1)
    ) {
      throw invalidSdkData();
    }
    copiedData[index] = descriptor.value;
  }
  const rows: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let value = "";
    for (let column = 0; column < size; column += 1) {
      const module = copiedData[(row * size) + column];
      value += module === 0 ? "0" : "1";
    }
    rows.push(value);
  }
  return parseWalletQrMatrix({ size, rows });
};

const normalizeChangedAccounts = (
  value: unknown,
  chainId: EvmChainId,
): readonly WalletConnectAccountReference[] => {
  const accounts = copySdkStringArray(value);
  const prefix = `${chainId}:`;
  return Object.freeze(accounts.map((account) => {
    const addressValue = account.startsWith(prefix) ? account.slice(prefix.length) : account;
    const address = parseEvmAddressInput(addressValue);
    return `${prefix}${address}` as WalletConnectAccountReference;
  }));
};

const isUserRejected = (error: unknown): boolean => {
  try {
    return readOwnDataProperty(error, "code") === userRejectedCode;
  } catch {
    return false;
  }
};

const createDroppingLogger = (): WalletConnectSdkLogger => {
  const drop = (..._arguments: readonly unknown[]): void => undefined;
  return {
    level: "warn",
    child: (_bindings: unknown) => createDroppingLogger(),
    trace: drop,
    debug: drop,
    info: drop,
    warn: drop,
    error: drop,
    fatal: drop,
  };
};

interface ProductionSdkLifecycle {
  readonly core: unknown;
  close(): Promise<void>;
}

const capturePendingTransportSettlement = (
  relayer: unknown,
): Promise<void> | undefined => {
  const pendingTransport = readOptionalOwnDataProperty(relayer, "connectPromise");
  if (pendingTransport === undefined) return undefined;
  const then = captureDataMethod(pendingTransport, "then", 1, false);
  return Promise.resolve(invokeMethod(then, [
    () => undefined,
    () => undefined,
  ])).then(() => undefined);
};

const createProductionSdkClose = (
  relayer: unknown,
  transportClose: CapturedMethod | undefined,
  heartbeatStop: CapturedMethod | undefined,
): (() => Promise<void>) => {
  let transportClosed = transportClose === undefined;
  let heartbeatStopped = heartbeatStop === undefined;
  let activeClose: Promise<void> | undefined;

  const closeRemaining = async (): Promise<void> => {
    let failed = false;
    if (!transportClosed && transportClose !== undefined) {
      let pendingTransport: Promise<void> | undefined;
      let transportFailed = false;
      try {
        pendingTransport = capturePendingTransportSettlement(relayer);
      } catch {
        transportFailed = true;
      }
      try {
        await invokeMethod(transportClose, []);
      } catch {
        transportFailed = true;
      }
      if (pendingTransport !== undefined) {
        try {
          await pendingTransport;
          await invokeMethod(transportClose, []);
        } catch {
          transportFailed = true;
        }
      }
      if (transportFailed) failed = true;
      else transportClosed = true;
    }
    if (!heartbeatStopped && heartbeatStop !== undefined) {
      try {
        await invokeMethod(heartbeatStop, []);
        heartbeatStopped = true;
      } catch {
        failed = true;
      }
    }
    if (failed) throw sdkUnavailable();
  };

  return (): Promise<void> => {
    if (activeClose !== undefined) return activeClose;
    const closing = closeRemaining();
    activeClose = closing;
    void closing.then(
      () => { if (activeClose === closing) activeClose = undefined; },
      () => { if (activeClose === closing) activeClose = undefined; },
    );
    return closing;
  };
};

const captureProductionSdkLifecycle = (
  client: unknown,
  acquisition: WalletConnectSdkAcquisitionAuthority,
): ProductionSdkLifecycle => {
  const core = readOwnDataProperty(client, "core");
  let heartbeatStop: CapturedMethod | undefined;
  let transportClose: CapturedMethod | undefined;
  let relayer: unknown;
  let complete = true;
  try {
    const heartbeat = readOwnDataProperty(core, "heartbeat");
    heartbeatStop = captureDataMethod(heartbeat, "stop", 1, false);
  } catch {
    complete = false;
  }
  try {
    relayer = readOwnDataProperty(core, "relayer");
    transportClose = captureDataMethod(relayer, "transportClose", 1, false);
  } catch {
    complete = false;
  }
  const close = createProductionSdkClose(relayer, transportClose, heartbeatStop);
  acquisition.retainCleanup(close);
  if (!complete) throw invalidSdkData();
  return Object.freeze({ core, close });
};

const normalizeProductionSdk = (
  client: unknown,
  lifecycle: ProductionSdkLifecycle,
): WalletConnectSdkPort => {
  const pairing = readOwnDataProperty(lifecycle.core, "pairing");
  const disconnectPairing = captureDataMethod(pairing, "disconnect");
  const listPairings = captureDataMethod(pairing, "getPairings");
  const session = readOwnDataProperty(client, "session");
  const listSessions = captureDataMethod(session, "getAll");
  const connect = captureDataMethod(client, "connect");
  const disconnect = captureDataMethod(client, "disconnect");
  const on = captureDataMethod(client, "on");
  const off = captureDataMethod(client, "off");
  const proposalController = new ProductionProposalController(client, lifecycle.core);
  let available = true;

  const assertAvailable = (): void => {
    if (!available) throw sdkUnavailable();
  };
  const poison = async (pairingTopic?: string): Promise<never> => {
    available = false;
    if (pairingTopic !== undefined) {
      try {
        await invokeMethod(disconnectPairing, [{ topic: pairingTopic }]);
      } catch {
        // The exact pairing remains for startup reconciliation by the next owner.
      }
    }
    try {
      await lifecycle.close();
    } catch {
      // The fixed adapter error below remains the only public failure.
    }
    throw sdkUnavailable();
  };

  return Object.freeze({
    listSessions: () => {
      assertAvailable();
      return invokeMethod(listSessions, []) as readonly unknown[];
    },
    listPairings: () => {
      assertAvailable();
      return invokeMethod(listPairings, []) as readonly unknown[];
    },
    initializeConnectionAttempts: async () => {
      assertAvailable();
      await proposalController.initialize();
    },
    startConnection: async (input: WalletConnectSdkConnectInput) => {
      assertAvailable();
      try {
        proposalController.assertConnectionReady();
      } catch {
        return poison();
      }

      let rawConnection: unknown;
      try {
        rawConnection = await invokeMethod(connect, [{
          requiredNamespaces: {
            eip155: {
              chains: [...input.requiredNamespaces.eip155.chains],
              methods: [...input.requiredNamespaces.eip155.methods],
              events: [...input.requiredNamespaces.eip155.events],
            },
          },
        }]);
      } catch {
        return poison();
      }

      let pairingTopic: string;
      let uri: string;
      try {
        const rawUri = readOptionalOwnDataProperty(rawConnection, "uri");
        if (typeof rawUri !== "string") throw invalidSdkData();
        uri = rawUri;
        pairingTopic = pairingTopicFromUri(uri);
      } catch {
        return poison();
      }

      try {
        const connection = normalizeRawSdkConnection(rawConnection);
        if (connection.uri !== uri) throw invalidSdkData();
        const proposalAttempt = await proposalController.bindConnection(
          pairingTopic,
          connection.approval,
        );
        return Object.freeze({
          uri,
          lifecycle: createProductionConnectionLifecycle(
            pairingTopic,
            proposalAttempt,
            assertAvailable,
            () => poison(),
          ),
        });
      } catch {
        return poison(pairingTopic);
      }
    },
    disconnectPairing: async (topic: string) => {
      assertAvailable();
      await invokeMethod(disconnectPairing, [{ topic }]);
    },
    disconnectSession: async (topic: string) => {
      assertAvailable();
      await invokeMethod(disconnect, [{ topic, reason: approvedSessionDisconnectReason }]);
    },
    on: (event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener) => {
      assertAvailable();
      invokeMethod(on, [event, listener]);
    },
    off: (event: WalletConnectSdkEventName, listener: WalletConnectSdkEventListener) => {
      invokeMethod(off, [event, listener]);
    },
    close: () => {
      available = false;
      return lifecycle.close();
    },
  });
};

const createProductionSdkFactory = (signClientModule: unknown): WalletConnectSdkFactory => {
  const signClient = readOwnDataProperty(signClientModule, "SignClient");
  const initialize = captureDataMethod(signClient, "init", 0, false);
  return async (options, acquisition) => {
    try {
      const client = await invokeMethod(initialize, [{
        projectId: options.projectId,
        name: options.name,
        metadata: {
          name: options.metadata.name,
          description: options.metadata.description,
          url: options.metadata.url,
          icons: [...options.metadata.icons],
        },
        storageOptions: { database: options.storageOptions.database },
        telemetryEnabled: options.telemetryEnabled,
        logger: options.logger,
      }]);
      const lifecycle = captureProductionSdkLifecycle(client, acquisition);
      return normalizeProductionSdk(client, lifecycle);
    } catch {
      throw sdkUnavailable();
    }
  };
};

const createProductionQrEncoder = (qrCodeModule: unknown): WalletQrEncoder => {
  const create = captureDataMethod(qrCodeModule, "create");
  return (uri) => qrMatrixFromValue(invokeMethod(create, [
    uri,
    { errorCorrectionLevel: "L" },
  ]));
};

export const loadWalletConnectProductionDependencies = async (
  moduleLoader: WalletExternalModuleLoader = loadWalletExternalModule,
): Promise<WalletConnectProductionDependencies> => {
  let signClientModule: unknown;
  let qrCodeModule: unknown;
  try {
    [signClientModule, qrCodeModule] = await Promise.all([
      moduleLoader("signClient"),
      moduleLoader("qrCode"),
    ]);
  } catch {
    throw sdkUnavailable();
  }
  try {
    return Object.freeze({
      sdkFactory: createProductionSdkFactory(signClientModule),
      qrEncoder: createProductionQrEncoder(qrCodeModule),
    });
  } catch {
    throw sdkUnavailable();
  }
};

class WalletConnectConnectionAttempt implements WalletConnectConnectionAttemptPort {
  readonly qr: WalletQrMatrix;
  private readonly publicPort: WalletConnectConnectionAttemptPort;

  private readonly result = createDeferred<WalletConnectAttemptOutcome>();
  private terminal: WalletConnectAttemptOutcome | undefined;
  private approvalObservation: Promise<void> | undefined;
  private approvalProcessing: Promise<void> | undefined;
  private approvalDisposition: ApprovalDisposition | undefined;
  private approvalProcessingFailed = false;
  private cancellationRequested = false;
  private cancellation: Promise<WalletConnectAttemptOutcome> | undefined;
  private failureReported = false;

  constructor(
    qr: WalletQrMatrix,
    private readonly sdkAttempt: WalletConnectSdkConnectionLifecycle,
    private readonly validateApprovedSession: (
      session: unknown,
      pairingTopic: string,
    ) => Promise<WalletConnectSessionSnapshot>,
    private readonly quarantineApprovedSession: (
      session: unknown,
      pairingTopic: string,
    ) => Promise<void>,
    private readonly reportFailure: () => void,
    private readonly settled: () => void,
  ) {
    this.qr = qr;
    this.publicPort = Object.freeze({
      qr,
      wait: () => this.wait(),
      cancel: () => this.cancel(),
    });
  }

  asPort(): WalletConnectConnectionAttemptPort {
    return this.publicPort;
  }

  wait(): Promise<WalletConnectAttemptOutcome> {
    this.observeApproval();
    return this.result.promise;
  }

  cancel(): Promise<WalletConnectAttemptOutcome> {
    if (this.terminal !== undefined) return Promise.resolve(this.terminal);
    if (this.cancellation !== undefined) return this.cancellation;
    if (this.approvalDisposition !== undefined) return this.result.promise;

    this.cancellationRequested = true;
    this.observeApproval();
    const cancellation = this.performCancellation();
    this.cancellation = cancellation;
    void cancellation.catch(() => {
      if (this.terminal === undefined) this.cancellation = undefined;
    });
    return cancellation;
  }

  async shutdown(): Promise<void> {
    let failed = false;
    try {
      const outcome = await this.cancel();
      failed = outcome.status === "failed";
    } catch {
      failed = true;
    }
    await this.approvalObservation;
    const processing = this.approvalProcessing;
    if (processing !== undefined) {
      try {
        await processing;
      } catch {
        failed = true;
      }
    }
    if (this.approvalDisposition === "failed") failed = true;
    if (failed) throw sdkUnavailable();
  }

  private observeApproval(): void {
    if (this.approvalObservation !== undefined) return;
    this.approvalObservation = Promise.resolve()
      .then(() => this.sdkAttempt.waitForApproval())
      .then(
        (session) => {
          const processing = this.onApproved(session);
          this.approvalProcessing = processing;
          return processing;
        },
        (error: unknown) => {
          const processing = this.onApprovalFailure(error);
          this.approvalProcessing = processing;
          return processing;
        },
      )
      .catch(async () => {
        this.approvalDisposition = "failed";
        this.approvalProcessingFailed = true;
        if (!this.cancellationRequested) {
          try {
            await this.sdkAttempt.cancel();
          } catch {
            this.reportCleanupFailure();
          }
        }
        if (!this.cancellationRequested) this.settle(Object.freeze({ status: "failed" }));
      });
  }

  private async onApproved(session: unknown): Promise<void> {
    this.approvalDisposition = "approved";
    if (this.cancellationRequested) return;
    try {
      const normalized = await this.validateApprovedSession(
        session,
        this.sdkAttempt.pairingTopic,
      );
      await this.sdkAttempt.finishApproval(normalized.topic);
      this.settle(Object.freeze({ status: "approved", session: normalized }));
    } catch {
      this.approvalDisposition = "failed";
      try {
        await this.quarantineApprovedSession(session, this.sdkAttempt.pairingTopic);
      } catch {
        // The adapter-level quarantine remains fail-closed and emits its safe event.
      }
      try {
        await this.sdkAttempt.cancel();
      } catch {
        this.reportCleanupFailure();
      }
      this.settle(Object.freeze({ status: "failed" }));
    }
  }

  private async onApprovalFailure(error: unknown): Promise<void> {
    const rejected = isUserRejected(error);
    this.approvalDisposition = rejected ? "rejected" : "failed";
    if (this.cancellationRequested) return;
    try {
      await this.sdkAttempt.cancel();
      this.settle(Object.freeze({ status: rejected ? "rejected" : "failed" }));
    } catch {
      this.approvalDisposition = "failed";
      this.reportCleanupFailure();
      this.settle(Object.freeze({ status: "failed" }));
    }
  }

  private async performCancellation(): Promise<WalletConnectAttemptOutcome> {
    try {
      await this.sdkAttempt.cancel();
      await this.approvalObservation;
    } catch {
      this.reportCleanupFailure();
      return this.settle(Object.freeze({ status: "failed" }));
    }
    if (this.approvalProcessingFailed) {
      return this.settle(Object.freeze({ status: "failed" }));
    }
    return this.settle(Object.freeze({ status: "cancelled" }));
  }

  private settle(outcome: WalletConnectAttemptOutcome): WalletConnectAttemptOutcome {
    if (this.terminal !== undefined) return this.terminal;
    this.terminal = outcome;
    this.result.resolve(outcome);
    this.settled();
    return outcome;
  }

  private reportCleanupFailure(): void {
    if (this.failureReported) return;
    this.failureReported = true;
    this.reportFailure();
  }
}

class WalletConnectClient implements WalletConnectClientPort {
  private readonly listeners = new Set<(event: WalletConnectClientEvent) => void>();
  private readonly sdkListeners = new Map<WalletConnectSdkEventName, WalletConnectSdkEventListener>();
  private readonly quarantinedSessionTopics = new Set<string>();
  private readonly quarantinedPairingTopics = new Set<string>();
  private readonly pendingAttempts = new Set<WalletConnectConnectionAttempt>();
  private sdkCommandTail: Promise<void> = Promise.resolve();
  private activeAttempt: WalletConnectConnectionAttempt | undefined;
  private starting: Promise<void> | undefined;
  private closed = false;
  private sdkUsable = true;
  private operationalCleanupAttempted = false;
  private shutdownComplete = false;
  private closeWork: Promise<void> | undefined;
  private sdkCloseComplete = false;
  private sdkCloseWork: Promise<void> | undefined;

  constructor(
    private readonly sdk: WalletConnectSdkPort,
    private readonly qrEncoder: WalletQrEncoder,
    private readonly configuration: WalletConnectConfigurationState,
  ) {}

  async initialize(): Promise<void> {
    this.attachSdkListeners();
    await this.sdk.initializeConnectionAttempts();
    await this.reconcileStores();
  }

  listSessions(): readonly WalletConnectSessionSnapshot[] {
    if (this.closed) throw clientClosed();
    if (!this.sdkUsable) throw sdkUnavailable();
    if (this.pendingAttempts.size !== 0) throw sdkUnavailable();
    return this.readPublicSessions();
  }

  async startConnection(): Promise<WalletConnectConnectionAttemptPort> {
    if (this.closed) throw clientClosed();
    if (!this.sdkUsable) throw sdkUnavailable();
    if (this.starting !== undefined || this.activeAttempt !== undefined) {
      throw connectionAttemptActive();
    }
    if (this.pendingAttempts.size !== 0) throw sdkUnavailable();

    let resolveStarting: (() => void) | undefined;
    this.starting = new Promise<void>((resolve) => {
      resolveStarting = resolve;
    });
    try {
      const sessions = await this.reconcileStores();
      if (this.closed) throw clientClosed();
      if (sessions.length !== 0) throw sdkUnavailable();
      return await this.createConnectionAttempt();
    } finally {
      resolveStarting?.();
      this.starting = undefined;
    }
  }

  async disconnectSession(topic: string): Promise<readonly WalletConnectSessionSnapshot[]> {
    if (this.closed) throw clientClosed();
    if (!this.sdkUsable) throw sdkUnavailable();
    if (this.pendingAttempts.size !== 0) throw sdkUnavailable();
    await this.reconcileStores();
    if (this.closed) throw clientClosed();
    return this.disconnectAndRead(topic);
  }

  subscribe(listener: (event: WalletConnectClientEvent) => void): () => void {
    if (this.closed) throw clientClosed();
    if (!this.sdkUsable) throw sdkUnavailable();
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.shutdownComplete) return Promise.resolve();
    return this.closeWork ?? this.startCloseWork();
  }

  private startCloseWork(): Promise<void> {
    let work: Promise<void>;
    work = Promise.resolve().then(() => this.performClose()).then(
      () => {
        this.shutdownComplete = true;
      },
      () => {
        if (this.closeWork === work) this.closeWork = undefined;
        throw sdkUnavailable();
      },
    );
    this.closeWork = work;
    return work;
  }

  private async createConnectionAttempt(): Promise<WalletConnectConnectionAttemptPort> {
    let sdkStartInvoked = false;
    let sdkAttempt: WalletConnectSdkConnectionLifecycle | undefined;
    let handedOff = false;
    try {
      const rawStart = await this.runSdkCommand(async () => {
        sdkStartInvoked = true;
        const result = await this.sdk.startConnection({
          requiredNamespaces: Object.freeze({
            eip155: Object.freeze({
              chains: Object.freeze([this.configuration.chain.chainId]),
              methods: this.configuration.requiredMethods,
              events: this.configuration.requiredEvents,
            }),
          }),
        });
        return result;
      });
      const preparedStart = normalizeSdkConnectionStart(rawStart);
      sdkAttempt = preparedStart.lifecycle;
      const preparedAttempt = preparedStart.lifecycle;
      await this.runSdkCommand(async () => {
        const pairingsAfter = this.readPairingStore();
        if (
          pairingsAfter.hasUnknownTopic ||
          pairingsAfter.recordsByTopic.size !== 1 ||
          pairingsAfter.recordsByTopic.get(preparedAttempt.pairingTopic)?.length !== 1
        ) {
          throw invalidSdkData();
        }
      });
      const qr = this.qrEncoder(preparedStart.uri);

      if (this.closed) throw clientClosed();
      if (this.activeAttempt !== undefined || this.pendingAttempts.size !== 0) {
        throw sdkUnavailable();
      }

      let attempt: WalletConnectConnectionAttempt;
      attempt = new WalletConnectConnectionAttempt(
        qr,
        preparedAttempt,
        async (session, expectedPairingTopic) =>
          this.validateApprovedSession(session, expectedPairingTopic),
        async (session, attemptPairingTopic) =>
          this.quarantineApprovedSession(session, attemptPairingTopic),
        () => this.reportAttemptFailure(),
        () => {
          if (this.activeAttempt === attempt) this.activeAttempt = undefined;
          this.pendingAttempts.delete(attempt);
        },
      );
      this.activeAttempt = attempt;
      this.pendingAttempts.add(attempt);
      handedOff = true;
      return attempt.asPort();
    } catch {
      if (!handedOff && sdkAttempt !== undefined) {
        try {
          await sdkAttempt.cancel();
        } catch {
          await this.poisonSdk();
        }
      } else if (sdkStartInvoked) {
        await this.poisonSdk();
      }
      if (this.closed) throw clientClosed();
      throw sdkUnavailable();
    }
  }

  private readSessionStore(): RawTopicStoreIndex {
    try {
      return indexRawTopicStore(this.sdk.listSessions());
    } catch {
      throw sdkUnavailable();
    }
  }

  private readPairingStore(): RawTopicStoreIndex {
    try {
      return indexRawTopicStore(this.sdk.listPairings());
    } catch {
      throw sdkUnavailable();
    }
  }

  private observeSessionStore(index: RawTopicStoreIndex): NormalizedSessionStore {
    const normalized = normalizeSessionStore(index);
    for (const topic of normalized.malformedTopics) {
      this.quarantinedSessionTopics.add(topic);
    }
    for (const topic of [...this.quarantinedSessionTopics]) {
      if (canProveTopicAbsent(index, topic)) this.quarantinedSessionTopics.delete(topic);
    }
    return normalized;
  }

  private readPublicSessions(): readonly WalletConnectSessionSnapshot[] {
    const index = this.readSessionStore();
    const normalized = this.observeSessionStore(index);
    if (
      normalized.hasUnknownMalformedSession ||
      normalized.malformedTopics.size !== 0 ||
      this.quarantinedSessionTopics.size !== 0
    ) {
      throw sdkUnavailable();
    }
    return Object.freeze(normalized.sessions.map((session) => session.public));
  }

  private async reconcileStores(): Promise<readonly WalletConnectSessionInternalSnapshot[]> {
    const sessions = await this.resolveSessionQuarantine();
    if (this.activeAttempt !== undefined) return sessions;
    const ownedPairingTopics = new Set(sessions.map((session) => session.pairingTopic));
    await this.resolvePairingQuarantine(ownedPairingTopics);
    return sessions;
  }

  private async resolveSessionQuarantine(): Promise<readonly WalletConnectSessionInternalSnapshot[]> {
    let index = this.readSessionStore();
    let normalized = this.observeSessionStore(index);

    const topics = [...this.quarantinedSessionTopics].sort(compareCodePointSequences);
    for (const topic of topics) await this.disconnectSessionAndObserve(topic);

    index = this.readSessionStore();
    normalized = this.observeSessionStore(index);
    if (
      normalized.hasUnknownMalformedSession ||
      normalized.malformedTopics.size !== 0 ||
      this.quarantinedSessionTopics.size !== 0
    ) {
      throw sdkUnavailable();
    }
    return normalized.sessions;
  }

  private async resolvePairingQuarantine(ownedTopics: ReadonlySet<string>): Promise<void> {
    let index = this.readPairingStore();
    if (index.hasUnknownTopic) throw sdkUnavailable();
    for (const topic of [...this.quarantinedPairingTopics]) {
      if (canProveTopicAbsent(index, topic)) this.quarantinedPairingTopics.delete(topic);
    }
    const staleTopics = new Set(this.quarantinedPairingTopics);
    for (const [topic, records] of index.recordsByTopic) {
      if (!ownedTopics.has(topic)) staleTopics.add(topic);
      if (ownedTopics.has(topic) && records.length !== 1) throw sdkUnavailable();
    }
    for (const topic of [...staleTopics].sort(compareCodePointSequences)) {
      this.quarantinedPairingTopics.add(topic);
      await this.disconnectPairingAndObserve(topic);
    }
    index = this.readPairingStore();
    if (index.hasUnknownTopic) throw sdkUnavailable();
    for (const topic of this.quarantinedPairingTopics) {
      if (!canProveTopicAbsent(index, topic)) throw sdkUnavailable();
    }
    this.quarantinedPairingTopics.clear();
  }

  private async poisonSdk(): Promise<void> {
    this.sdkUsable = false;
    try {
      await this.releaseSdk();
    } catch {
      // The adapter remains unusable even when resource shutdown reports failure.
    }
  }

  private reportAttemptFailure(): void {
    this.sdkUsable = false;
    this.emit(Object.freeze({ kind: "session_quarantined" }));
    void this.releaseSdk().catch(() => undefined);
  }

  private async disconnectAndRead(
    topic: string,
  ): Promise<readonly WalletConnectSessionSnapshot[]> {
    await this.disconnectSessionAndObserve(topic);
    const sessions = await this.reconcileStores();
    return Object.freeze(sessions.map((session) => session.public));
  }

  private async disconnectSessionAndObserve(topic: string): Promise<void> {
    if (!topicPattern.test(topic)) throw invalidSdkData();
    this.quarantinedSessionTopics.add(topic);
    await this.runSdkCommand(async () => {
      try {
        await this.sdk.disconnectSession(topic);
      } catch {
        // The authoritative SDK store is read below even when transport reports failure.
      }
      const index = this.readSessionStore();
      if (!canProveTopicAbsent(index, topic)) throw sdkUnavailable();
      this.quarantinedSessionTopics.delete(topic);
    });
  }

  private async disconnectPairingAndObserve(topic: string): Promise<void> {
    if (!topicPattern.test(topic)) throw invalidSdkData();
    this.quarantinedPairingTopics.add(topic);
    await this.runSdkCommand(async () => {
      try {
        await this.sdk.disconnectPairing(topic);
      } catch {
        // The authoritative SDK store is read below even when transport reports failure.
      }
      const index = this.readPairingStore();
      if (!canProveTopicAbsent(index, topic)) throw sdkUnavailable();
      this.quarantinedPairingTopics.delete(topic);
    });
  }

  private async validateApprovedSession(
    session: unknown,
    expectedPairingTopic: string,
  ): Promise<WalletConnectSessionSnapshot> {
    return this.runSdkCommand(async () => {
      const approved = normalizeSessionInternal(session);
      if (approved.pairingTopic !== expectedPairingTopic) {
        throw invalidSdkData();
      }
      const sessionIndex = this.readSessionStore();
      if (sessionIndex.hasUnknownTopic || sessionIndex.recordsByTopic.size !== 1) {
        throw invalidSdkData();
      }
      const storedRecords = sessionIndex.recordsByTopic.get(approved.public.topic);
      if (storedRecords?.length !== 1) throw invalidSdkData();
      const stored = normalizeSessionInternal(storedRecords[0]);
      if (stored.pairingTopic !== expectedPairingTopic) throw invalidSdkData();
      const pairingIndex = this.readPairingStore();
      if (
        pairingIndex.hasUnknownTopic ||
        pairingIndex.recordsByTopic.get(expectedPairingTopic)?.length !== 1
      ) {
        throw invalidSdkData();
      }
      this.quarantinedPairingTopics.delete(expectedPairingTopic);
      return stored.public;
    });
  }

  private async quarantineApprovedSession(
    session: unknown,
    expectedPairingTopic: string,
  ): Promise<void> {
    const topic = readTopicOrNull(session);
    let rawPairingTopic: string | null = null;
    try {
      const value = readOwnDataProperty(session, "pairingTopic");
      if (typeof value === "string" && topicPattern.test(value)) rawPairingTopic = value;
    } catch {
      // The store scan below remains authoritative for readable exact sessions.
    }
    const index = await this.runSdkCommand(async () => this.readSessionStore());
    const normalized = normalizeSessionStore(index);
    const candidateTopics = new Set<string>();
    if (topic !== null && rawPairingTopic === expectedPairingTopic) candidateTopics.add(topic);
    for (const storedSession of normalized.sessions) {
      if (storedSession.pairingTopic === expectedPairingTopic) {
        candidateTopics.add(storedSession.public.topic);
      }
    }
    for (const candidateTopic of candidateTopics) {
      this.quarantinedSessionTopics.add(candidateTopic);
    }
    try {
      for (const candidateTopic of [...candidateTopics].sort(compareCodePointSequences)) {
        await this.disconnectSessionAndObserve(candidateTopic);
      }
      if (index.hasUnknownTopic) throw sdkUnavailable();
    } catch {
      this.emit(Object.freeze({ kind: "session_quarantined" }));
      throw sdkUnavailable();
    }
  }

  private attachSdkListeners(): void {
    try {
      for (const eventName of sdkEventNames) {
        const listener: WalletConnectSdkEventListener = (event) => {
          this.onSdkEvent(eventName, event);
        };
        this.sdk.on(eventName, listener);
        this.sdkListeners.set(eventName, listener);
      }
    } catch {
      this.detachSdkListeners();
      throw sdkUnavailable();
    }
  }

  private detachSdkListeners(): boolean {
    for (const [eventName, listener] of this.sdkListeners) {
      try {
        this.sdk.off(eventName, listener);
        this.sdkListeners.delete(eventName);
      } catch {
        // The SDK close lifecycle owns any remaining registration and reference.
      }
    }
    return this.sdkListeners.size === 0;
  }

  private onSdkEvent(eventName: WalletConnectSdkEventName, event: unknown): void {
    if (this.closed || !this.sdkUsable || this.pendingAttempts.size !== 0) return;
    const topic = readTopicOrNull(event);
    if (topic === null) {
      this.emit(Object.freeze({ kind: "invalid_session_event", topic: null }));
      return;
    }
    if (this.quarantinedSessionTopics.has(topic)) {
      if (eventName === "session_delete" || eventName === "session_expire") {
        try {
          const index = this.readSessionStore();
          if (canProveTopicAbsent(index, topic)) {
            this.quarantinedSessionTopics.delete(topic);
          }
        } catch {
          // The SDK event triggers observation but never overrides the store authority.
        }
      }
      return;
    }

    if (eventName === "session_update" || eventName === "session_extend") {
      this.emit(Object.freeze({ kind: "session_changed", topic }));
      return;
    }
    if (eventName === "session_delete") {
      this.emit(Object.freeze({ kind: "session_deleted", topic }));
      return;
    }
    if (eventName === "session_expire") {
      this.emit(Object.freeze({ kind: "session_expired", topic }));
      return;
    }
    this.onSessionEvent(topic, event);
  }

  private onSessionEvent(topic: string, event: unknown): void {
    try {
      const parameters = readOwnDataProperty(event, "params");
      const chainId = readOwnDataProperty(parameters, "chainId");
      if (chainId !== this.configuration.chain.chainId) throw invalidSdkData();
      const sdkEvent = readOwnDataProperty(parameters, "event");
      const name = readOwnDataProperty(sdkEvent, "name");
      const data = readOwnDataProperty(sdkEvent, "data");
      if (name === "accountsChanged") {
        this.emit(Object.freeze({
          kind: "session_event",
          topic,
          eventName: "accountsChanged",
          data: normalizeChangedAccounts(data, this.configuration.chain.chainId),
        }));
        return;
      }
      if (name === "chainChanged" && validSdkText(data)) {
        this.emit(Object.freeze({
          kind: "session_event",
          topic,
          eventName: "chainChanged",
          data,
        }));
        return;
      }
    } catch {
      // The invalid event below forces coordinator reconciliation without raw data.
    }
    this.emit(Object.freeze({ kind: "invalid_session_event", topic }));
  }

  private emit(event: WalletConnectClientEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One consumer cannot prevent another consumer from observing invalidation.
      }
    }
  }

  private runSdkCommand<Result>(operation: () => Promise<Result>): Promise<Result> {
    const command = this.sdkCommandTail.then(operation);
    this.sdkCommandTail = command.then(() => undefined, () => undefined);
    return command;
  }

  private async waitForSdkCommands(): Promise<void> {
    while (true) {
      const commandTail = this.sdkCommandTail;
      await commandTail;
      if (commandTail === this.sdkCommandTail) return;
    }
  }

  private async performClose(): Promise<void> {
    if (!this.operationalCleanupAttempted) {
      this.operationalCleanupAttempted = true;
      try {
        await this.performOperationalCleanup();
      } catch {
        // A closed SDK cannot safely repeat operational cleanup. The next owner
        // reconciles the persisted SDK store through a new client lifecycle.
      }
    }
    try {
      await this.releaseSdk();
      this.sdkListeners.clear();
    } catch {
      throw sdkUnavailable();
    }
  }

  private releaseSdk(): Promise<void> {
    if (this.sdkCloseComplete) return Promise.resolve();
    if (this.sdkCloseWork !== undefined) return this.sdkCloseWork;
    let work: Promise<void>;
    work = Promise.resolve().then(() => this.sdk.close()).then(
      () => {
        this.sdkCloseComplete = true;
        if (this.sdkCloseWork === work) this.sdkCloseWork = undefined;
      },
      () => {
        if (this.sdkCloseWork === work) this.sdkCloseWork = undefined;
        throw sdkUnavailable();
      },
    );
    this.sdkCloseWork = work;
    return work;
  }

  private async performOperationalCleanup(): Promise<void> {
    this.detachSdkListeners();
    this.listeners.clear();
    const starting = this.starting;
    if (starting !== undefined) {
      try {
        await starting;
      } catch {
        // Continue through the remaining independently owned cleanup.
      }
    }
    await Promise.allSettled(
      [...this.pendingAttempts].map(async (attempt) => attempt.shutdown()),
    );
    await this.waitForSdkCommands();
    if (this.sdkUsable) {
      try {
        await this.reconcileStores();
      } catch {
        // Persisted state remains fail-closed and is reconciled by the next owner.
      }
    }
    await this.waitForSdkCommands();
  }
}

export const createWalletConnectClient = async (
  configuration: WalletConnectClientConfiguration,
  acquisitionResources: WalletConnectAcquisitionRegistry,
  signal: AbortSignal,
  sdkFactory?: WalletConnectSdkFactory,
  moduleLoader: WalletExternalModuleLoader = loadWalletExternalModule,
): Promise<WalletConnectClientAcquisition> => {
  let wallet: WalletConnectConfigurationState;
  try {
    wallet = readWalletConnectConfiguration(configuration.wallet);
  } catch {
    throw clientError("invalid_configuration");
  }
  if (
    !isAbsolute(configuration.privateStoreDirectory) ||
    configuration.privateStoreDirectory.includes("\0")
  ) {
    throw clientError("invalid_configuration");
  }

  const acquisitionResource = new TrackedWalletConnectAcquisition(signal);
  const registration = acquisitionResources.register(acquisitionResource);
  const acquisitionBudget = createWalletConnectAcquisitionBudget(signal);
  let clientAdopted = false;
  let ownedResource: WalletConnectAcquisitionResource = acquisitionResource;
  const logger = createDroppingLogger();
  try {
    const productionDependencies = await acquisitionBudget.run(
      () => loadWalletConnectProductionDependencies(moduleLoader),
    );
    acquisitionResource.beginSdkAcquisition();
    const sdk = await acquisitionBudget.run(() => {
      const factoryResult = Promise.resolve()
        .then(() => (sdkFactory ?? productionDependencies.sdkFactory)({
        projectId: wallet.projectId,
        name: wallet.metadata.name,
        metadata: wallet.metadata,
        storageOptions: { database: configuration.privateStoreDirectory },
        telemetryEnabled: false,
        logger,
      }, acquisitionResource.authority));
      return factoryResult.then(
        (sdk) => {
          acquisitionResource.retainCleanup(async () => sdk.close());
          return sdk;
        },
        (error: unknown) => {
          acquisitionResource.finishSdkAcquisitionWithoutHandle();
          throw error;
        },
      );
    });
    const client = new WalletConnectClient(
      sdk,
      productionDependencies.qrEncoder,
      wallet,
    );
    acquisitionResource.retainCleanup(async () => client.close());
    await acquisitionBudget.run(() => client.initialize());
    acquisitionResource.markReady();
    const initializedClient: WalletConnectClientPort = Object.freeze({
      listSessions: () => client.listSessions(),
      startConnection: () => client.startConnection(),
      disconnectSession: (topic: string) => client.disconnectSession(topic),
      subscribe: (listener: (event: WalletConnectClientEvent) => void) =>
        client.subscribe(listener),
      close: () => client.close(),
    });
    return Object.freeze({
      client: initializedClient,
      replace: (resource: WalletConnectAcquisitionResource): void => {
        const current = acquisitionResource.adoptionIsCurrent();
        registration.replace(ownedResource, resource);
        ownedResource = resource;
        if (!clientAdopted) {
          clientAdopted = true;
          acquisitionResource.markAdopted();
        }
        if (!current) throw sdkUnavailable();
      },
      transfer: (): void => registration.transfer(),
    });
  } catch {
    acquisitionResource.requestShutdown();
    throw sdkUnavailable();
  }
};
