import {
  bindCapability,
  canonicalJsonStringify,
  compareCodePointSequences,
  deriveCaip10Account,
  deriveEip155Reference,
  parseCapabilityDataAt,
  parseCaip10EvmAccount,
  parseUtcTimestamp,
  walletConnectionEvidence,
  walletConnectionCapability,
  type CapabilityBinding,
  type CanonicalJson,
  type HandlerInvocationContext,
  type InvocationBoundaryPorts,
  type ObservationWriter,
  type UnsignedDecimal,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../core/index.js";
import type {
  WalletConnectionReadCapabilityPort,
  WalletOwnerBootstrapPort,
} from "../runtime/application-context.js";
import type { WalletConnectionRecord } from "../runtime/wallet-projection.js";
import type { WalletSessionSource } from "../runtime/source-identity.js";
import {
  isWalletOperationFailureCode,
  operationFailure,
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationConfirmation,
  parseWalletOperationCommand,
  parseWalletOperationCreate,
  parseWalletOperationId,
  parseWalletOperationPresentation,
  parseWalletOperationResponse,
  parseWalletOperationStartResponse,
  parseWalletWebOperationCreate,
  type WalletCurrentOperationProjection,
  type WalletManagementOperation,
  type WalletOperationConfirmationPort,
  type WalletOperationConfirmation,
  type WalletOperationCreate,
  type WalletOperationFailureCode,
  type WalletLocalControlOperationPort,
  type WalletOperationOutcome,
  type WalletOperationPresentation,
  type WalletOperationPresentationPort,
  type WalletWebOperationPort,
  type WalletOperationResponse,
  type WalletOperationResult,
  type WalletOperationStartResponse,
  type WalletOperationStartResult,
  type WalletCurrentOperationProjectionPort,
  type WalletWebOperationCreate,
} from "./contracts.js";
import type { WalletOperationKind } from "./operation-state.js";
import {
  WalletOperationError,
  createWalletFailure,
  normalizeWalletError,
  walletErrorRegistry,
} from "./errors.js";
import type {
  WalletConnectAttemptOutcome,
  WalletConnectClientEvent,
  WalletConnectClientPort,
  WalletConnectConnectionAttemptPort,
  WalletConnectSessionSnapshot,
} from "./walletconnect-client.js";
import { isWalletConnectClientError } from "./walletconnect-client.js";

const userActionWaitMilliseconds = 5 * 60 * 1_000;
const walletSdkOperationMilliseconds = 5 * 60 * 1_000;
const terminalRetentionMilliseconds = 5 * 60 * 1_000;
const targetNamespace = "eip155";

class WalletSdkDeadlineError extends Error {
  constructor() {
    super("Wallet SDK operation deadline exceeded.");
    this.name = "WalletSdkDeadlineError";
  }
}

class WalletSdkMutationUnavailableError extends Error {
  constructor() {
    super("A previous wallet SDK mutation has not settled.");
    this.name = "WalletSdkMutationUnavailableError";
  }
}

const walletFailureCode = (error: unknown): WalletOperationFailureCode => {
  if (error instanceof WalletSdkDeadlineError) return "wallet_timeout";
  if (error instanceof WalletSdkMutationUnavailableError) return "runtime_state_unavailable";
  if (isWalletConnectClientError(error)) return "runtime_state_unavailable";
  const failure = normalizeWalletError(error).failure;
  if (isWalletOperationFailureCode(failure.error.code)) return failure.error.code;
  return ["runtime", "state", "transport"].includes(failure.error.category)
    ? "runtime_state_unavailable"
    : "internal_error";
};

const disconnected = (reason: "no_session" | "expired" | "deleted" | "disconnected" | "unusable_store") =>
  Object.freeze({ status: "disconnected" as const, reason });

const addMilliseconds = (timestamp: UtcTimestamp, milliseconds: number): UtcTimestamp =>
  parseUtcTimestamp(new Date(Date.parse(timestamp) + milliseconds).toISOString());

const asCanonical = (value: WalletConnectionData): CanonicalJson => value as unknown as CanonicalJson;

const sameConnection = (left: WalletConnectionData, right: WalletConnectionData): boolean =>
  canonicalJsonStringify(asCanonical(left)) === canonicalJsonStringify(asCanonical(right));

const canonicalUnique = (values: readonly string[]): readonly string[] | undefined => {
  const ordered = [...values].sort(compareCodePointSequences);
  if (new Set(ordered).size !== ordered.length) return undefined;
  return Object.freeze(ordered);
};

const captureSessionSetIdentity = (
  sessions: readonly WalletConnectSessionSnapshot[],
): string | undefined => {
  try {
    const ordered = [...sessions].sort((left, right) =>
      compareCodePointSequences(left.topic, right.topic));
    if (ordered.some((session, index) => index > 0 && ordered[index - 1]?.topic === session.topic)) {
      return undefined;
    }
    return canonicalJsonStringify(ordered as unknown as CanonicalJson);
  } catch {
    return undefined;
  }
};

const validateSession = (
  session: WalletConnectSessionSnapshot,
  evaluatedAt: UtcTimestamp,
  configuration: WalletOwnerBootstrapPort["configuration"],
): WalletConnectionData | undefined => {
  const targetChainId = configuration.chain.chainId;
  const namespaceKeys = Object.keys(session.namespaces).sort(compareCodePointSequences);
  const namespace = session.namespaces[targetNamespace];
  if (namespaceKeys.length !== 1 || namespaceKeys[0] !== targetNamespace || namespace === undefined ||
    namespace.chains.length !== 1 || namespace.chains[0] !== targetChainId || namespace.accounts.length !== 1 ||
    !Number.isSafeInteger(session.expiry) || session.expiry <= 0) {
    return undefined;
  }
  const account = namespace.accounts[0];
  let identity: ReturnType<typeof parseCaip10EvmAccount>;
  try { identity = parseCaip10EvmAccount(account); }
  catch { return undefined; }
  if (identity.chainId !== targetChainId) return undefined;
  const approvedMethods = canonicalUnique(namespace.methods);
  const approvedEvents = canonicalUnique(namespace.events);
  if (approvedMethods === undefined || approvedEvents === undefined ||
    !configuration.requiredMethods.every((method) => approvedMethods.includes(method)) ||
    !configuration.requiredEvents.every((event) => approvedEvents.includes(event))) {
    return undefined;
  }
  let expiresAt: UtcTimestamp;
  try { expiresAt = parseUtcTimestamp(new Date(session.expiry * 1_000).toISOString()); }
  catch { return undefined; }
  try {
    return parseCapabilityDataAt(walletConnectionCapability, {
      status: "connected",
      address: identity.address,
      chainId: targetChainId,
      approvedMethods,
      approvedEvents,
      expiresAt,
    }, evaluatedAt);
  } catch {
    return undefined;
  }
};

interface ConnectionSnapshot {
  readonly record: WalletConnectionRecord;
  readonly sessionSource?: WalletSessionSource;
}

type EmptyConnectionReason = "no_session" | "expired" | "deleted" | "disconnected";

interface ReconciliationAuthority {
  readonly kind: "startup_restore" | "runtime_continuity" | "explicit_cleanup";
  readonly emptyReason: EmptyConnectionReason;
  readonly committedConnectionRevision?: string;
}

interface SessionContinuity {
  readonly topic: string;
  readonly account: string;
}

export interface ActiveWalletReadSnapshot {
  readonly connection: WalletConnectionData;
  readonly connectionRevision: UnsignedDecimal;
  readonly sessionSource?: WalletSessionSource;
}

export interface ActiveWalletReadPort {
  capture(): ActiveWalletReadSnapshot;
}

interface WalletConnectionInvocationPorts extends InvocationBoundaryPorts {
  readonly walletSnapshot: ActiveWalletReadSnapshot;
  readonly evidenceAvailable: boolean;
}

interface EffectToken {
  readonly id: number;
  readonly operationId: string | null;
  readonly phaseVersion: number;
  readonly kind:
    | "start_connection"
    | "disconnect_sessions"
    | "cancel_attempt"
    | "revoke_approved_session"
    | "reconcile_sessions";
}

type EffectSettlement<Result> =
  | { readonly status: "fulfilled"; readonly value: Result; readonly settledAt: UtcTimestamp }
  | { readonly status: "rejected"; readonly error: unknown; readonly settledAt: UtcTimestamp };

type VisibleEffectSettlement<Result> =
  | { readonly status: "settled"; readonly settlement: EffectSettlement<Result> }
  | { readonly status: "deadline" };

interface EffectHandle<Result> {
  readonly token: EffectToken;
  readonly deadline: UtcTimestamp;
  readonly actual: Promise<EffectSettlement<Result>>;
  readonly visible: Promise<VisibleEffectSettlement<Result>>;
  readonly cleanupTopics?: readonly string[];
  readonly lateSuccess?: (value: Result) => Promise<void>;
  fence?: Promise<void>;
}

interface ExactSessionRevocationEffect extends EffectHandle<void> {
  readReconciliation(): StableReconciliation;
}

interface AttemptLease {
  readonly generation: number;
  readonly attempt: WalletConnectConnectionAttemptPort;
}

interface ExplicitDisconnectPurpose {
  readonly targetTopics: readonly string[];
}

interface AttemptTerminationPurpose {
  readonly intent: "cancelled" | "expired";
  readonly attempt: AttemptLease;
}

interface StartingTerminationPurpose {
  readonly intent: "cancelled" | "expired";
}

interface StartingTerminationHandle {
  readonly startEffect: EffectHandle<WalletConnectConnectionAttemptPort>;
  readonly deadline: UtcTimestamp;
  readonly work: Promise<void>;
}

type OperationPhase =
  | { readonly tag: "awaiting_confirmation"; readonly deadline: UtcTimestamp }
  | {
      readonly tag: "approval_starting";
      readonly deadline: UtcTimestamp;
      readonly effect: EffectHandle<WalletConnectConnectionAttemptPort>;
    }
  | {
      readonly tag: "approval_waiting";
      readonly deadline: UtcTimestamp;
      readonly attempt: AttemptLease;
    }
  | {
      readonly tag: "terminating_start";
      readonly deadline: UtcTimestamp;
      readonly purpose: StartingTerminationPurpose;
      readonly termination: StartingTerminationHandle;
    }
  | {
      readonly tag: "disconnecting";
      readonly deadline: UtcTimestamp;
      readonly purpose: ExplicitDisconnectPurpose;
      readonly effect: ExactSessionRevocationEffect;
    }
  | {
      readonly tag: "terminating_attempt";
      readonly deadline: UtcTimestamp;
      readonly purpose: AttemptTerminationPurpose;
      readonly effect: EffectHandle<WalletConnectAttemptOutcome>;
    }
  | {
      readonly tag: "validating_session";
      readonly deadline: UtcTimestamp;
      readonly approvedTopic: string;
      readonly effect?: EffectHandle<unknown>;
    }
  | {
      readonly tag: "terminal";
      readonly state: "completed";
      readonly retentionDeadline: UtcTimestamp;
      readonly result: WalletOperationResult;
    }
  | {
      readonly tag: "terminal";
      readonly state: "cancelled" | "rejected" | "expired";
      readonly retentionDeadline: UtcTimestamp;
    }
  | {
      readonly tag: "terminal";
      readonly state: "failed";
      readonly retentionDeadline: UtcTimestamp;
      readonly failure: ReturnType<typeof operationFailure>;
    };

type OperationTransition =
  | Exclude<OperationPhase, { readonly tag: "terminal" }>
  | { readonly tag: "terminal"; readonly state: "completed"; readonly result: WalletOperationResult }
  | { readonly tag: "terminal"; readonly state: "cancelled" | "rejected" | "expired" }
  | { readonly tag: "terminal"; readonly state: "failed"; readonly failure: ReturnType<typeof operationFailure> };

interface OperationIdentity {
  readonly operationId: string;
  readonly kind: WalletOperationKind;
  readonly interactionInterface: WalletOperationCreate["interactionInterface"];
  readonly connectionRevision: string;
  readonly createdAt: UtcTimestamp;
  readonly userActionDeadline: UtcTimestamp;
}

type LifecycleAdmission =
  | {
      readonly id: number;
      readonly kind: "create";
    }
  | {
      readonly id: number;
      readonly kind: "confirm";
      readonly operationId: string;
      readonly phaseVersion: number;
      readonly interactionInterface: WalletOperationCreate["interactionInterface"];
      readonly connectionRevision: string;
    };

interface OperationEntry {
  readonly identity: OperationIdentity;
  readonly phaseVersion: number;
  readonly phase: OperationPhase;
  wake?: ReturnType<typeof setTimeout>;
}

interface ActorRequest<Result> {
  readonly operation: () => Result;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
}

interface ShutdownSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const createShutdownSignal = (): ShutdownSignal => {
  let resolveSignal: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolveSignal = resolve; });
  if (resolveSignal === undefined) throw new Error("Wallet shutdown signal initialization failed.");
  return Object.freeze({ promise, resolve: resolveSignal });
};

type RevocationAuthority =
  | "explicit_operation"
  | "approved_attempt"
  | "active_invalidation"
  | "startup_invalid";

interface StableReconciliation {
  readonly sessions: readonly WalletConnectSessionSnapshot[];
  readonly sessionSetIdentity: string;
  readonly evidenceEpoch: number;
}

interface ReconciliationObservation {
  readonly sessions: readonly WalletConnectSessionSnapshot[];
  readonly sessionSetIdentity: string;
  readonly revokeTopics: readonly string[];
}

type StableReconciliationState = "current" | "changed" | "unavailable";

type OperationStartAction =
  | { readonly kind: "retry" }
  | { readonly kind: "current_connection"; readonly result: WalletOperationStartResult }
  | { readonly kind: "immediate"; readonly operationId: string }
  | {
      readonly kind: "start_pairing";
      readonly operationId: string;
      readonly effect: EffectHandle<WalletConnectConnectionAttemptPort>;
    }
  | {
      readonly kind: "disconnect";
      readonly operationId: string;
      readonly effect: ExactSessionRevocationEffect;
      readonly purpose: ExplicitDisconnectPurpose;
    };

type ConfirmationAction = Extract<
  OperationStartAction,
  { readonly kind: "immediate" } | { readonly kind: "disconnect" }
>;

type DeadlineSynchronization =
  | { readonly kind: "ready"; readonly response: WalletOperationResponse }
  | {
      readonly kind: "terminate_start";
      readonly operationId: string;
      readonly phaseVersion: number;
      readonly termination: StartingTerminationHandle;
      readonly purpose: StartingTerminationPurpose;
    }
  | {
      readonly kind: "terminate_attempt";
      readonly operationId: string;
      readonly effect: EffectHandle<WalletConnectAttemptOutcome>;
      readonly purpose: AttemptTerminationPurpose;
    };

interface StartingTerminationAction {
  readonly kind: "terminate_start";
  readonly operationId: string;
  readonly phaseVersion: number;
  readonly termination: StartingTerminationHandle;
  readonly purpose: StartingTerminationPurpose;
}

interface AttemptTerminationAction {
  readonly kind: "terminate_attempt";
  readonly operationId: string;
  readonly effect: EffectHandle<WalletConnectAttemptOutcome>;
  readonly purpose: AttemptTerminationPurpose;
}

type ApprovedValidationAction =
  | { readonly kind: "complete" }
  | {
      readonly kind: "cleanup";
      readonly operationId: string;
      readonly phaseVersion: number;
      readonly approvedTopic: string;
      readonly failureCode: WalletOperationFailureCode;
      readonly effect?: ExactSessionRevocationEffect;
    };

export interface WalletCoordinatorPort extends WalletLocalControlOperationPort {
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWalletReadPort;
  readonly operation: WalletWebOperationPort;
  readonly cliConfirmation: WalletOperationConfirmationPort<"cli">;
  readonly webConfirmation: WalletOperationConfirmationPort<"web">;
  readonly operationPresentation: WalletOperationPresentationPort;
  readonly currentOperationProjection: WalletCurrentOperationProjectionPort;
  close(): Promise<void>;
}

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
};

const legalPhaseTransitions = Object.freeze({
  awaiting_confirmation: Object.freeze(["disconnecting", "terminal"] as const),
  approval_starting: Object.freeze(["approval_waiting", "terminating_start", "terminal"] as const),
  approval_waiting: Object.freeze(["terminating_attempt", "validating_session", "terminal"] as const),
  terminating_start: Object.freeze(["terminal"] as const),
  disconnecting: Object.freeze(["terminal"] as const),
  terminating_attempt: Object.freeze(["approval_waiting", "terminal"] as const),
  validating_session: Object.freeze(["validating_session", "terminal"] as const),
  terminal: Object.freeze([] as const),
} satisfies Readonly<Record<OperationPhase["tag"], readonly OperationPhase["tag"][]>>);

export class WalletCoordinator implements WalletCoordinatorPort {
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWalletReadPort;
  readonly operation: WalletWebOperationPort;
  readonly cliConfirmation: WalletOperationConfirmationPort<"cli">;
  readonly webConfirmation: WalletOperationConfirmationPort<"web">;
  readonly operationPresentation: WalletOperationPresentationPort;
  readonly currentOperationProjection: WalletCurrentOperationProjectionPort;

  readonly #client: WalletConnectClientPort;
  readonly #wallet: WalletOwnerBootstrapPort;
  readonly #operations = new Map<string, OperationEntry>();
  readonly #mailbox: ActorRequest<unknown>[] = [];
  readonly #deferredSessionTopics = new Set<string>();
  readonly #revocationAuthorities = new Map<string, RevocationAuthority>();
  readonly #activeMutations = new Set<number>();
  readonly #fences = new Set<Promise<void>>();
  readonly #backgroundTasks = new Set<Promise<void>>();
  readonly #shutdownSignal = createShutdownSignal();
  #connectionSnapshot: ConnectionSnapshot;
  #connectionEvidenceAvailable = false;
  #connectionEvidenceEpoch = 0;
  #observedSessionSetIdentity: string | undefined;
  #sessionContinuity: SessionContinuity | undefined;
  #activeOperationId: string | undefined;
  #lifecycleAdmission: LifecycleAdmission | undefined;
  #nextEffectId = 1;
  #nextAttemptGeneration = 1;
  #nextAdmissionId = 1;
  #mailboxScheduled = false;
  #mutationTail: Promise<void> = Promise.resolve();
  #reconciliationTail: Promise<void> = Promise.resolve();
  #expiryReconciliation: Promise<void> | undefined;
  #unsubscribe: (() => void) | undefined;
  #closingRequested = false;
  #closeWork: Promise<void> | undefined;
  #closeComplete = false;

  private constructor(client: WalletConnectClientPort, wallet: WalletOwnerBootstrapPort) {
    this.#client = client;
    this.#wallet = wallet;
    this.#connectionSnapshot = Object.freeze({ record: wallet.projection.read() });
    this.activeWallet = Object.freeze({ capture: () => this.#captureActiveWallet() });
    this.operation = Object.freeze({
      start: async (input: WalletWebOperationCreate, operationId: string) => {
        const parsed = parseWalletWebOperationCreate(input);
        return (await this.#startOperationRequest(parseWalletOperationCreate({
          control: { operationId, interactionInterface: "web" },
          request: parsed,
        }), true)).result;
      },
      cancel: async (operationId: string, input: WalletOperationConfirmation) =>
        (await this.#cancel("web", operationId, input)).operation,
    });
    this.cliConfirmation = Object.freeze({
      interactionInterface: "cli",
      confirm: async (operationId: string, input: WalletOperationConfirmation) =>
        this.#confirm("cli", operationId, input),
    });
    this.webConfirmation = Object.freeze({
      interactionInterface: "web",
      confirm: async (operationId: string, input: WalletOperationConfirmation) =>
        (await this.#confirm("web", operationId, input)).operation,
    });
    this.operationPresentation = Object.freeze({
      get: (operationId: string) => this.#readPresentation(operationId),
    });
    this.currentOperationProjection = Object.freeze({
      get: () => this.#readCurrentProjection(),
    });

    const binding: CapabilityBinding<typeof walletConnectionCapability> = bindCapability({
      definition: walletConnectionCapability,
      errorRegistry: walletErrorRegistry,
      invocationAuthority: wallet.capabilityAuthority.invocationAuthority,
      createInvocationPorts: (_input: Record<string, never>): WalletConnectionInvocationPorts => {
        const walletSnapshot = this.#captureActiveWallet();
        return Object.freeze({
          ...wallet.capabilityAuthority.createInvocationPorts(walletSnapshot.sessionSource),
          walletSnapshot,
          evidenceAvailable: this.#connectionEvidenceAvailable,
        });
      },
      handler: async (
        _input: Record<string, never>,
        context: HandlerInvocationContext<WalletConnectionInvocationPorts>,
        observations: ObservationWriter,
      ) => {
        const snapshot = context.ports.walletSnapshot;
        if (!context.ports.evidenceAvailable) {
          return { status: "failure", code: "runtime_state_unavailable", issues: [] };
        }
        const sdkTarget = observations.bind(walletConnectionEvidence.targets.sdk);
        const sessionTarget = observations.bind(
          walletConnectionEvidence.targets.session,
        );
        observations.record(sdkTarget.slot, {
          source: wallet.sourceAuthority.sdkStoreAuthority,
          claims: [{
            role: sdkTarget.roles.state,
            value: asCanonical(snapshot.connection),
          }],
        });
        if (snapshot.connection.status === "connected") {
          if (snapshot.sessionSource === undefined) throw new TypeError("Connected wallet source is unavailable.");
          observations.record(sessionTarget.slot, {
            source: snapshot.sessionSource.observationAuthority,
            claims: [{
              role: sessionTarget.roles.state,
              value: asCanonical(snapshot.connection),
            }],
          });
        }
        return { status: "success", data: snapshot.connection };
      },
    });
    this.walletConnection = Object.freeze({ connection: binding });
    Object.seal(this);
  }

  static async create(input: {
    readonly client: WalletConnectClientPort;
    readonly wallet: WalletOwnerBootstrapPort;
  }): Promise<WalletCoordinator> {
    const coordinator = new WalletCoordinator(input.client, input.wallet);
    coordinator.#unsubscribe = input.client.subscribe((event) => {
      if (coordinator.#eventCanInvalidateEvidence(event)) coordinator.#quiesceEvidence();
      coordinator.#trackBackground(coordinator.#handleClientEvent(event));
    });
    await coordinator.#actor(() => {
      coordinator.#publishLocalState(Object.freeze({ status: "unknown", reason: "reconciling" }));
    });
    await coordinator.#reconcile({ kind: "startup_restore", emptyReason: "no_session" });
    return coordinator;
  }

  async start(input: WalletOperationCreate): Promise<WalletOperationStartResponse> {
    const parsed = parseWalletOperationCommand(input);
    return this.#startOperationRequest(parsed, false);
  }

  async #startOperationRequest(
    parsed: WalletOperationCreate,
    directBrowserAction: boolean,
  ): Promise<WalletOperationStartResponse> {
    this.#assertOpen();
    const admission = await this.#actor(() => this.#beginCreateAdmission());
    try {
      for (;;) {
        const emptyReason = await this.#actor(() => this.#operationEmptyReason());
        const stable = await this.#reconcile({ kind: "explicit_cleanup", emptyReason });
        this.#assertOpen();
        if (stable === undefined) throw new WalletOperationError("runtime_state_unavailable");
        const action = await this.#actor(() => this.#startOperation(
          parsed,
          stable,
          admission,
          directBrowserAction,
        ));
        if (action.kind === "retry") continue;
        if (action.kind === "current_connection") {
          return parseWalletOperationStartResponse({ result: action.result });
        }
        if (action.kind === "immediate") return this.#readStartResponse(action.operationId);
        if (action.kind === "start_pairing") {
          this.#trackBackground(this.#settlePairingStart(action.operationId, action.effect));
          return this.#readStartResponse(action.operationId);
        }
        this.#trackBackground(
          this.#settleExplicitDisconnect(action.operationId, action.effect, action.purpose),
        );
        return this.#readStartResponse(action.operationId);
      }
    } finally {
      await this.#actor(() => this.#releaseLifecycleAdmission(admission));
    }
  }

  #operationEmptyReason(): EmptyConnectionReason {
    const connection = this.#connectionSnapshot.record.connection;
    return connection.status === "disconnected" && connection.reason !== "unusable_store"
      ? connection.reason
      : "no_session";
  }

  async get(operationId: string): Promise<WalletOperationResponse> {
    this.#assertOpen();
    const id = parseWalletOperationId(operationId);
    return this.#enterOperation(id);
  }

  async #readPresentation(operationId: string): Promise<WalletOperationPresentation> {
    this.#assertOpen();
    const id = parseWalletOperationId(operationId);
    await this.#enterOperation(id);
    return this.#actor(() => {
      this.#assertOpen();
      return this.#operationPresentation(this.#operationEntry(id));
    });
  }

  async #readCurrentProjection(): Promise<WalletCurrentOperationProjection> {
    this.#assertOpen();
    await this.#actor(() => { this.#beginExpiryReconciliationIfNeeded(); });
    const activeOperationId = await this.#actor(() => {
      this.#assertOpen();
      this.#pruneExpiredTerminalOperations();
      return this.#activeOperationId;
    });
    if (activeOperationId !== undefined) {
      await this.#enterOperation(activeOperationId);
    }
    return this.#actor(() => {
      this.#assertOpen();
      this.#pruneExpiredTerminalOperations();
      const record = this.#connectionSnapshot.record;
      const operationId = this.#activeOperationId;
      return parseWalletCurrentOperationProjection(operationId === undefined
        ? {
            status: "absent",
            connectionRevision: record.revision,
            connection: record.connection,
          }
        : {
            status: "present",
            connectionRevision: record.revision,
            connection: record.connection,
            presentation: this.#operationPresentation(this.#operationEntry(operationId)),
          });
    });
  }

  async #confirm(
    interactionInterface: WalletOperationCreate["interactionInterface"],
    operationId: string,
    input: WalletOperationConfirmation,
  ): Promise<WalletOperationResponse> {
    const id = parseWalletOperationId(operationId);
    const confirmation = parseWalletOperationConfirmation(input);
    this.#assertOpen();
    await this.#enterOperation(id);
    const admission = await this.#actor(() => this.#beginConfirmationAdmission(
      interactionInterface,
      id,
      confirmation,
    ));
    try {
      const emptyReason = await this.#actor(() => this.#operationEmptyReason());
      const stable = await this.#reconcile({ kind: "explicit_cleanup", emptyReason });
      this.#assertOpen();
      if (stable === undefined) throw new WalletOperationError("runtime_state_unavailable");
      const action = await this.#actor(() => this.#confirmOperation(
        interactionInterface,
        id,
        confirmation,
        stable,
        admission,
      ));
      if (action.kind === "immediate") return this.#readResponse(id);
      this.#trackBackground(
        this.#settleExplicitDisconnect(id, action.effect, action.purpose),
      );
      return this.#readResponse(id);
    } finally {
      await this.#actor(() => this.#releaseLifecycleAdmission(admission));
    }
  }

  async cancel(operationId: string): Promise<WalletOperationResponse> {
    return this.#cancel(undefined, operationId);
  }

  async #cancel(
    interactionInterface: WalletOperationCreate["interactionInterface"] | undefined,
    operationId: string,
    confirmationInput?: WalletOperationConfirmation,
  ): Promise<WalletOperationResponse> {
    const id = parseWalletOperationId(operationId);
    const confirmation = interactionInterface === undefined
      ? undefined
      : parseWalletOperationConfirmation(confirmationInput);
    this.#assertOpen();
    await this.#enterOperation(id);
    const action = await this.#actor(() => this.#cancelOperation(
      interactionInterface,
      id,
      confirmation,
    ));
    if (action === undefined) return this.#readResponse(id);
    this.#trackBackground(action.kind === "terminate_start"
      ? this.#settleStartingTermination(action)
      : this.#settleAttemptTermination(id, action.effect, action.purpose));
    return this.#readResponse(id);
  }

  close(): Promise<void> {
    if (this.#closeComplete) return Promise.resolve();
    if (!this.#closingRequested) {
      this.#closingRequested = true;
      this.#shutdownSignal.resolve();
    }
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#quiesceEvidence();
    const work = this.#closeWork ?? this.#startCloseWork();
    const deadline = addMilliseconds(this.#now(), walletSdkOperationMilliseconds);
    return this.#waitForCanonicalDeadline(work, deadline).then(
      (settlement) => {
        if (settlement.status === "deadline" || settlement.settlement.status === "rejected") {
          throw new WalletOperationError("runtime_state_unavailable");
        }
      },
      () => { throw new WalletOperationError("runtime_state_unavailable"); },
    );
  }

  #startCloseWork(): Promise<void> {
    let work: Promise<void>;
    work = this.#performClose().then(
      () => {
        this.#closeComplete = true;
        this.#operations.clear();
        this.#activeOperationId = undefined;
        this.#lifecycleAdmission = undefined;
        this.#sessionContinuity = undefined;
        this.#observedSessionSetIdentity = undefined;
      },
      (error: unknown) => {
        if (this.#closeWork === work) this.#closeWork = undefined;
        throw error;
      },
    );
    this.#closeWork = work;
    return work;
  }

  async #performClose(): Promise<void> {
    await this.#actor(() => this.#clearOperationWakes());
    await this.#awaitOwnedWork(true);
    await this.#client.close();
    await this.#awaitOwnedWork(true);
  }

  async #awaitOwnedWork(includeBackground: boolean): Promise<void> {
    for (;;) {
      const mutationTail = this.#mutationTail;
      const reconciliationTail = this.#reconciliationTail;
      const fences = [...this.#fences];
      const background = includeBackground ? [...this.#backgroundTasks] : [];
      await Promise.all([mutationTail, reconciliationTail, ...fences, ...background]);
      await this.#actor(() => undefined);
      if (
        mutationTail === this.#mutationTail &&
        reconciliationTail === this.#reconciliationTail &&
        this.#fences.size === 0 &&
        (!includeBackground || this.#backgroundTasks.size === 0)
      ) return;
    }
  }

  #assertOpen(): void {
    if (this.#closingRequested) throw new WalletOperationError("runtime_state_unavailable");
  }

  #actor<Result>(operation: () => Result): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      this.#mailbox.push({ operation, resolve, reject } as ActorRequest<unknown>);
      if (this.#mailboxScheduled) return;
      this.#mailboxScheduled = true;
      queueMicrotask(() => this.#drainMailbox());
    });
  }

  #trackBackground(work: Promise<unknown>): void {
    let tracked: Promise<void>;
    tracked = work.then(
      () => undefined,
      () => undefined,
    ).finally(() => { this.#backgroundTasks.delete(tracked); });
    this.#backgroundTasks.add(tracked);
  }

  #beginCreateAdmission(): Extract<LifecycleAdmission, { readonly kind: "create" }> {
    this.#assertOpen();
    this.#pruneExpiredTerminalOperations();
    if (this.#activeOperationId !== undefined || this.#lifecycleAdmission !== undefined) {
      throw new WalletOperationError("state_conflict");
    }
    const admission = Object.freeze({ id: this.#nextAdmissionId, kind: "create" as const });
    this.#nextAdmissionId += 1;
    this.#lifecycleAdmission = admission;
    return admission;
  }

  #beginConfirmationAdmission(
    interactionInterface: WalletOperationCreate["interactionInterface"],
    operationId: string,
    confirmation: WalletOperationConfirmation,
  ): Extract<LifecycleAdmission, { readonly kind: "confirm" }> {
    this.#assertOpen();
    if (this.#lifecycleAdmission !== undefined) throw new WalletOperationError("state_conflict");
    const entry = this.#operationEntry(operationId);
    this.#assertConfirmationAuthority(entry, interactionInterface, confirmation);
    const admission = Object.freeze({
      id: this.#nextAdmissionId,
      kind: "confirm" as const,
      operationId,
      phaseVersion: entry.phaseVersion,
      interactionInterface,
      connectionRevision: confirmation.connectionRevision,
    });
    this.#nextAdmissionId += 1;
    this.#lifecycleAdmission = admission;
    return admission;
  }

  #releaseLifecycleAdmission(admission: LifecycleAdmission): void {
    if (this.#lifecycleAdmission === admission) this.#lifecycleAdmission = undefined;
  }

  #assertLifecycleAdmission(admission: LifecycleAdmission): void {
    if (this.#lifecycleAdmission !== admission) throw new WalletOperationError("state_conflict");
  }

  #assertConfirmationAuthority(
    entry: OperationEntry,
    interactionInterface: WalletOperationCreate["interactionInterface"],
    confirmation: WalletOperationConfirmation,
  ): void {
    if (
      entry.phase.tag !== "awaiting_confirmation" ||
      entry.identity.interactionInterface !== interactionInterface ||
      confirmation.connectionRevision !== entry.identity.connectionRevision ||
      this.#connectionSnapshot.record.revision !== confirmation.connectionRevision
    ) throw new WalletOperationError("state_conflict");
  }

  #drainMailbox(): void {
    try {
      for (;;) {
        const request = this.#mailbox.shift();
        if (request === undefined) break;
        try { request.resolve(request.operation()); }
        catch (error) { request.reject(error); }
      }
    } finally {
      this.#mailboxScheduled = false;
      if (this.#mailbox.length !== 0) {
        this.#mailboxScheduled = true;
        queueMicrotask(() => this.#drainMailbox());
      }
    }
  }

  #now(): UtcTimestamp {
    return this.#wallet.capabilityAuthority.clock.now();
  }

  #captureActiveWallet(): ActiveWalletReadSnapshot {
    let snapshot = this.#connectionSnapshot;
    if (this.#closingRequested) {
      return Object.freeze({
        connection: disconnected("unusable_store"),
        connectionRevision: snapshot.record.revision,
      });
    }
    if (this.#beginExpiryReconciliationIfNeeded() !== undefined) {
      snapshot = this.#connectionSnapshot;
      return Object.freeze({
        connection: snapshot.record.connection,
        connectionRevision: snapshot.record.revision,
      });
    }
    if (!this.#connectionEvidenceAvailable) {
      snapshot = this.#connectionSnapshot;
      return Object.freeze({
        connection: disconnected("unusable_store"),
        connectionRevision: snapshot.record.revision,
      });
    }
    snapshot = this.#connectionSnapshot;
    return Object.freeze({
      connection: snapshot.record.connection,
      connectionRevision: snapshot.record.revision,
      ...(snapshot.sessionSource === undefined ? {} : { sessionSource: snapshot.sessionSource }),
    });
  }

  #beginExpiryReconciliationIfNeeded(): Promise<void> | undefined {
    if (this.#expiryReconciliation !== undefined) return this.#expiryReconciliation;
    if (!this.#connectionEvidenceAvailable) return undefined;
    const connection = this.#connectionSnapshot.record.connection;
    if (
      connection.status !== "connected" ||
      Date.parse(connection.expiresAt) > Date.parse(this.#now())
    ) return undefined;
    const committedConnectionRevision = this.#commitExpiredConnection();
    let work: Promise<void>;
    work = this.#reconcile({
      kind: "runtime_continuity",
      emptyReason: "expired",
      ...(committedConnectionRevision === undefined ? {} : { committedConnectionRevision }),
    })
      .then(async (stable) => {
        if (stable === undefined) {
          await this.#actor(() => this.#persistUnavailableLocalState());
        }
      }, async () => {
        await this.#actor(() => this.#persistUnavailableLocalState());
      })
      .finally(() => this.#actor(() => {
        if (this.#expiryReconciliation === work) this.#expiryReconciliation = undefined;
      }));
    this.#expiryReconciliation = work;
    this.#trackBackground(work);
    return work;
  }

  #commitExpiredConnection(): string | undefined {
    this.#connectionEvidenceEpoch += 1;
    this.#connectionEvidenceAvailable = false;
    const continuity = this.#sessionContinuity;
    if (continuity !== undefined) {
      this.#revocationAuthorities.set(continuity.topic, "active_invalidation");
    }
    try {
      const evaluatedAt = this.#now();
      const expired = parseCapabilityDataAt(
        walletConnectionCapability,
        disconnected("expired"),
        evaluatedAt,
      );
      const current = this.#wallet.projection.read();
      const record = sameConnection(current.connection, expired)
        ? current
        : this.#wallet.projection.replace(current.revision, expired, evaluatedAt);
      this.#connectionEvidenceAvailable = true;
      this.#connectionSnapshot = Object.freeze({ record });
      return record.revision;
    } catch {
      this.#markLocalStateUnavailable();
      return undefined;
    }
  }

  #markLocalStateUnavailable(): void {
    const current = this.#connectionSnapshot.record;
    this.#connectionEvidenceAvailable = false;
    this.#observedSessionSetIdentity = undefined;
    this.#connectionSnapshot = Object.freeze({
      record: Object.freeze({
        revision: current.revision,
        connection: disconnected("unusable_store"),
        updatedAt: this.#now(),
      }),
    });
  }

  #quiesceEvidence(preserveConnectionSnapshot = false): number {
    this.#connectionEvidenceEpoch += 1;
    this.#connectionEvidenceAvailable = false;
    const current = this.#connectionSnapshot.record;
    this.#connectionSnapshot = Object.freeze({
      record: preserveConnectionSnapshot
        ? current
        : Object.freeze({
            revision: current.revision,
            connection: disconnected("unusable_store"),
            updatedAt: this.#now(),
          }),
    });
    return this.#connectionEvidenceEpoch;
  }

  #publishLocalState(connection: unknown): void {
    try {
      const evaluatedAt = this.#now();
      const canonical = parseCapabilityDataAt(walletConnectionCapability, connection, evaluatedAt);
      let record = this.#wallet.projection.read();
      if (!sameConnection(record.connection, canonical)) {
        record = this.#wallet.projection.replace(record.revision, canonical, evaluatedAt);
      }
      this.#connectionEvidenceAvailable = false;
      this.#observedSessionSetIdentity = undefined;
      this.#connectionSnapshot = Object.freeze({ record });
    } catch (error) {
      this.#markLocalStateUnavailable();
      throw error;
    }
  }

  #publishSdkState(
    connection: unknown,
    sessions: readonly WalletConnectSessionSnapshot[],
    evidenceEpoch: number,
    activeTopic?: string,
    committedConnectionRevision?: string,
  ): boolean {
    if (evidenceEpoch !== this.#connectionEvidenceEpoch || this.#activeMutations.size !== 0) {
      this.#connectionEvidenceAvailable = false;
      return false;
    }
    try {
      const evaluatedAt = this.#now();
      const canonical = parseCapabilityDataAt(walletConnectionCapability, connection, evaluatedAt);
      const topics = canonicalUnique(sessions.map(({ topic }) => topic));
      if (topics === undefined) throw new TypeError("Wallet session topics are not unique.");
      const sessionSetIdentity = captureSessionSetIdentity(sessions);
      if (sessionSetIdentity === undefined) {
        throw new TypeError("Wallet session set identity is unavailable.");
      }
      const sessionSource = canonical.status === "connected" && activeTopic !== undefined
        ? this.#wallet.sourceAuthority.createSessionSource(activeTopic)
        : undefined;
      if (
        canonical.status === "connected" &&
        (sessionSource === undefined || !topics.includes(activeTopic as string))
      ) {
        throw new TypeError("Connected wallet projection requires its observed session source.");
      }
      if (canonical.status !== "connected" && activeTopic !== undefined) {
        throw new TypeError("A non-connected wallet projection cannot select a session.");
      }
      let record = this.#wallet.projection.read();
      const connectionChanged = !sameConnection(record.connection, canonical);
      const sessionSetChanged = this.#observedSessionSetIdentity !== sessionSetIdentity;
      const committedConnectionStillCurrent =
        committedConnectionRevision !== undefined &&
        committedConnectionRevision === record.revision &&
        !connectionChanged;
      if (
        connectionChanged ||
        (sessionSetChanged && !committedConnectionStillCurrent)
      ) {
        record = this.#wallet.projection.replace(record.revision, canonical, evaluatedAt);
      }
      if (canonical.status === "connected" && activeTopic !== undefined) {
        this.#sessionContinuity = Object.freeze({
          topic: activeTopic,
          account: deriveCaip10Account({ chainId: canonical.chainId, address: canonical.address }),
        });
      } else if (sessions.length === 0) {
        this.#sessionContinuity = undefined;
      }
      this.#connectionEvidenceAvailable = true;
      this.#observedSessionSetIdentity = sessionSetIdentity;
      this.#connectionSnapshot = Object.freeze({
        record,
        ...(sessionSource === undefined ? {} : { sessionSource }),
      });
      return true;
    } catch (error) {
      this.#markLocalStateUnavailable();
      throw error;
    }
  }

  #persistUnavailableLocalState(): void {
    try { this.#publishLocalState(disconnected("unusable_store")); }
    catch { this.#markLocalStateUnavailable(); }
  }

  #createOperationIdentity(input: WalletOperationCreate, connectionRevision: string): OperationIdentity {
    const createdAt = this.#now();
    const userActionDeadline = addMilliseconds(createdAt, userActionWaitMilliseconds);
    return Object.freeze({
      operationId: input.operationId,
      kind: input.kind,
      interactionInterface: input.interactionInterface,
      connectionRevision,
      createdAt,
      userActionDeadline,
    });
  }

  #registerOperationEntry(
    identity: OperationIdentity,
    phase: OperationPhase,
    phaseVersion = 0,
  ): OperationEntry {
    const entry: OperationEntry = {
      identity,
      phaseVersion,
      phase,
    };
    this.#operationModel(entry);
    this.#operations.set(identity.operationId, entry);
    this.#activeOperationId = identity.operationId;
    this.#armOperationWake(entry);
    return entry;
  }

  #createOperationEntry(input: WalletOperationCreate, connectionRevision: string): OperationEntry {
    const identity = this.#createOperationIdentity(input, connectionRevision);
    return this.#registerOperationEntry(
      identity,
      Object.freeze({ tag: "awaiting_confirmation", deadline: identity.userActionDeadline }),
    );
  }

  #startConnectionOperation(
    input: WalletOperationCreate,
    connectionRevision: string,
  ): {
    readonly operationId: string;
    readonly effect: EffectHandle<WalletConnectConnectionAttemptPort>;
  } {
    const identity = this.#createOperationIdentity(input, connectionRevision);
    const effect = this.#launchMutation({
      operationId: identity.operationId,
      phaseVersion: 0,
      kind: "start_connection",
      deadline: identity.userActionDeadline,
      run: async () => this.#client.startConnection(),
      lateSuccess: async (attempt) => this.#cleanupLateAttempt(attempt),
    });
    this.#registerOperationEntry(identity, Object.freeze({
      tag: "approval_starting",
      deadline: identity.userActionDeadline,
      effect,
    }));
    return Object.freeze({ operationId: identity.operationId, effect });
  }

  #operationModel(entry: OperationEntry): WalletManagementOperation {
    const base = {
      operationId: entry.identity.operationId,
      kind: entry.identity.kind,
      connectionRevision: entry.identity.connectionRevision,
    };
    const phase = entry.phase;
    if (phase.tag === "terminal") {
      if (phase.state === "completed") {
        return parseWalletManagementOperation({
          ...base,
          state: phase.state,
          expiresAt: phase.retentionDeadline,
          result: phase.result,
          failure: null,
        });
      }
      if (phase.state === "failed") {
        return parseWalletManagementOperation({
          ...base,
          state: phase.state,
          expiresAt: phase.retentionDeadline,
          result: null,
          failure: phase.failure,
        });
      }
      return parseWalletManagementOperation({
        ...base,
        state: phase.state,
        expiresAt: phase.retentionDeadline,
        result: null,
        failure: null,
      });
    }
    const state = phase.tag === "approval_starting"
      ? "starting_connection"
      : phase.tag === "approval_waiting"
        ? "awaiting_wallet_approval"
        : phase.tag === "terminating_start" || phase.tag === "terminating_attempt"
          ? "cancelling"
          : phase.tag;
    return parseWalletManagementOperation({
      ...base,
      state,
      expiresAt: phase.deadline,
      result: null,
      failure: null,
    });
  }

  #operationResponse(entry: OperationEntry): WalletOperationResponse {
    return parseWalletOperationResponse({
      operation: this.#operationModel(entry),
      ...(entry.phase.tag === "approval_waiting" && entry.identity.interactionInterface === "cli"
        ? { qr: entry.phase.attempt.attempt.qr }
        : {}),
    });
  }

  #readResponse(operationId: string): WalletOperationResponse {
    return this.#operationResponse(this.#operationEntry(operationId));
  }

  #readStartResponse(operationId: string): WalletOperationStartResponse {
    const response = this.#readResponse(operationId);
    return parseWalletOperationStartResponse({
      result: {
        status: "operation_started",
        operation: response.operation,
      },
      ...(response.qr === undefined ? {} : { qr: response.qr }),
    });
  }

  #operationPresentation(entry: OperationEntry): WalletOperationPresentation {
    return parseWalletOperationPresentation({
      operation: this.#operationModel(entry),
      access: entry.identity.interactionInterface === "web" ? "interactive" : "read_only",
      ...(entry.phase.tag === "approval_waiting"
        ? { qr: entry.phase.attempt.attempt.qr }
        : {}),
    });
  }

  #operationEntry(operationId: string): OperationEntry {
    const entry = this.#operations.get(operationId);
    if (entry === undefined) throw new WalletOperationError("state_conflict");
    if (entry.phase.tag === "terminal" && this.#deadlineReached(entry.phase.retentionDeadline)) {
      this.#removeOperation(entry);
      throw new WalletOperationError("state_conflict");
    }
    return entry;
  }

  #transition(entry: OperationEntry, requested: OperationTransition): OperationEntry {
    if (!legalPhaseTransitions[entry.phase.tag].includes(requested.tag as never)) {
      throw new TypeError(`Illegal wallet operation transition ${entry.phase.tag} -> ${requested.tag}.`);
    }
    const phase: OperationPhase = requested.tag === "terminal"
      ? requested.state === "completed"
        ? Object.freeze({
            tag: "terminal",
            state: requested.state,
            retentionDeadline: addMilliseconds(this.#now(), terminalRetentionMilliseconds),
            result: requested.result,
          })
        : requested.state === "failed"
          ? Object.freeze({
              tag: "terminal",
              state: requested.state,
              retentionDeadline: addMilliseconds(this.#now(), terminalRetentionMilliseconds),
              failure: requested.failure,
            })
          : Object.freeze({
              tag: "terminal",
              state: requested.state,
              retentionDeadline: addMilliseconds(this.#now(), terminalRetentionMilliseconds),
            })
      : requested;
    const next: OperationEntry = {
      identity: entry.identity,
      phaseVersion: entry.phaseVersion + 1,
      phase,
    };
    this.#operationModel(next);
    if (entry.wake !== undefined) clearTimeout(entry.wake);
    this.#operations.set(entry.identity.operationId, next);
    if (phase.tag === "terminal" && this.#activeOperationId === entry.identity.operationId) {
      this.#activeOperationId = undefined;
    }
    this.#armOperationWake(next);
    return next;
  }

  #complete(entry: OperationEntry, outcome: WalletOperationOutcome): OperationEntry {
    const connection = this.#connectionSnapshot.record.connection;
    let result: WalletOperationResult;
    if (entry.identity.kind !== "disconnect") {
      if (outcome !== "connected" || connection.status !== "connected") {
        this.#persistUnavailableLocalState();
        return this.#fail(entry, "runtime_state_unavailable");
      }
      result = Object.freeze({ outcome, connection });
    } else {
      if (outcome === "connected" || connection.status !== "disconnected") {
        this.#persistUnavailableLocalState();
        return this.#fail(entry, "runtime_state_unavailable");
      }
      result = Object.freeze({ outcome, connection });
    }
    return this.#transition(entry, {
      tag: "terminal",
      state: "completed",
      result,
    });
  }

  #fail(entry: OperationEntry, code: WalletOperationFailureCode): OperationEntry {
    return this.#transition(entry, {
      tag: "terminal",
      state: "failed",
      failure: operationFailure(createWalletFailure(code)),
    });
  }

  #finish(entry: OperationEntry, state: "cancelled" | "rejected" | "expired"): OperationEntry {
    return this.#transition(entry, { tag: "terminal", state });
  }

  #removeOperation(entry: OperationEntry): void {
    if (entry.wake !== undefined) clearTimeout(entry.wake);
    if (this.#operations.get(entry.identity.operationId) === entry) {
      this.#operations.delete(entry.identity.operationId);
    }
  }

  #pruneExpiredTerminalOperations(): void {
    for (const entry of this.#operations.values()) {
      if (entry.phase.tag === "terminal" && this.#deadlineReached(entry.phase.retentionDeadline)) {
        this.#removeOperation(entry);
      }
    }
  }

  #clearOperationWakes(): void {
    for (const entry of this.#operations.values()) {
      if (entry.wake === undefined) continue;
      clearTimeout(entry.wake);
      delete entry.wake;
    }
  }

  #armOperationWake(entry: OperationEntry): void {
    const deadline = entry.phase.tag === "terminal"
      ? entry.phase.retentionDeadline
      : entry.phase.tag === "awaiting_confirmation" || entry.phase.tag === "approval_waiting"
        ? entry.phase.deadline
        : undefined;
    if (deadline === undefined || this.#closingRequested) return;
    const remaining = Math.max(0, Date.parse(deadline) - Date.parse(this.#now()));
    const timer = setTimeout(() => {
      this.#trackBackground(
        this.#actor(() => this.#handleOperationWake(entry.identity.operationId, entry.phaseVersion)),
      );
    }, remaining);
    unrefTimer(timer);
    entry.wake = timer;
  }

  #handleOperationWake(operationId: string, phaseVersion: number): void {
    if (this.#closingRequested) return;
    const entry = this.#operations.get(operationId);
    if (entry === undefined || entry.phaseVersion !== phaseVersion) return;
    const deadline = entry.phase.tag === "terminal" ? entry.phase.retentionDeadline : entry.phase.deadline;
    if (!this.#deadlineReached(deadline)) {
      this.#armOperationWake(entry);
      return;
    }
    if (entry.phase.tag === "terminal") {
      this.#removeOperation(entry);
      return;
    }
    if (entry.phase.tag === "awaiting_confirmation") {
      this.#finish(entry, "expired");
      return;
    }
    if (entry.phase.tag === "approval_waiting") {
      const termination = this.#beginAttemptTermination(entry, "expired");
      this.#trackBackground(
        this.#settleAttemptTermination(operationId, termination.effect, termination.purpose),
      );
    }
  }

  #deadlineReached(deadline: UtcTimestamp): boolean {
    return Date.parse(this.#now()) >= Date.parse(deadline);
  }

  #launchMutation<Result>(input: {
    readonly operationId: string | null;
    readonly phaseVersion: number;
    readonly kind: EffectToken["kind"];
    readonly deadline: UtcTimestamp;
    readonly run: (checkDeadline: () => void) => Promise<Result>;
    readonly cleanupTopics?: readonly string[];
    readonly lateSuccess?: (value: Result) => Promise<void>;
    readonly afterSuccess?: (value: Result) => Promise<void>;
    readonly preserveConnectionSnapshot?: boolean;
  }): EffectHandle<Result> {
    const token: EffectToken = Object.freeze({
      id: this.#nextEffectId,
      operationId: input.operationId,
      phaseVersion: input.phaseVersion,
      kind: input.kind,
    });
    this.#nextEffectId += 1;
    this.#quiesceEvidence(input.preserveConnectionSnapshot === true);
    this.#activeMutations.add(token.id);
    const execute = async (): Promise<EffectSettlement<Result>> => {
      const checkDeadline = (): void => {
        if (this.#deadlineReached(input.deadline)) throw new WalletSdkDeadlineError();
      };
      try {
        checkDeadline();
        const value = await input.run(checkDeadline);
        return Object.freeze({ status: "fulfilled", value, settledAt: this.#now() });
      } catch (error) {
        return Object.freeze({ status: "rejected", error, settledAt: this.#now() });
      }
    };
    const actual = this.#mutationTail.then(execute, execute);
    const finalized = actual.then(async (settlement): Promise<EffectSettlement<Result>> => {
      this.#activeMutations.delete(token.id);
      if (settlement.status === "fulfilled" && input.afterSuccess !== undefined) {
        try { await input.afterSuccess(settlement.value); }
        catch (error) {
          return Object.freeze({ status: "rejected", error, settledAt: this.#now() });
        }
      }
      return settlement;
    });
    this.#mutationTail = finalized.then(() => undefined, () => undefined);
    const handle: EffectHandle<Result> = {
      token,
      deadline: input.deadline,
      actual: finalized,
      visible: this.#waitForCanonicalDeadline(finalized, input.deadline),
      ...(input.cleanupTopics === undefined
        ? {}
        : { cleanupTopics: Object.freeze([...input.cleanupTopics]) }),
      ...(input.lateSuccess === undefined ? {} : { lateSuccess: input.lateSuccess }),
    };
    return handle;
  }

  async #waitForCanonicalDeadline<Result>(
    actual: Promise<EffectSettlement<Result>> | Promise<Result>,
    deadline: UtcTimestamp,
  ): Promise<VisibleEffectSettlement<Result>> {
    const tagged = actual.then(
      (value): EffectSettlement<Result> => {
        if (
          typeof value === "object" && value !== null &&
          "status" in value && "settledAt" in value &&
          (value.status === "fulfilled" || value.status === "rejected")
        ) return value as EffectSettlement<Result>;
        return Object.freeze({ status: "fulfilled", value: value as Result, settledAt: this.#now() });
      },
      (error: unknown): EffectSettlement<Result> =>
        Object.freeze({ status: "rejected", error, settledAt: this.#now() }),
    );
    for (;;) {
      if (this.#deadlineReached(deadline)) return Object.freeze({ status: "deadline" });
      const remaining = Math.max(1, Date.parse(deadline) - Date.parse(this.#now()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = new Promise<"wake">((resolve) => {
        timer = setTimeout(() => resolve("wake"), remaining);
        unrefTimer(timer);
      });
      const winner = await Promise.race([
        tagged.then((settlement) => Object.freeze({ kind: "settlement" as const, settlement })),
        wake.then(() => Object.freeze({ kind: "wake" as const })),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (winner.kind === "wake") continue;
      if (Date.parse(winner.settlement.settledAt) >= Date.parse(deadline)) {
        return Object.freeze({ status: "deadline" });
      }
      return Object.freeze({ status: "settled", settlement: winner.settlement });
    }
  }

  #fenceEffect<Result>(effect: EffectHandle<Result>): Promise<void> {
    if (effect.fence !== undefined) return effect.fence;
    this.#quiesceEvidence();
    let fence: Promise<void>;
    fence = effect.actual
      .then(async (settlement) => {
        if (settlement.status === "fulfilled" && effect.lateSuccess !== undefined) {
          await effect.lateSuccess(settlement.value);
        }
        if (settlement.status === "fulfilled" && effect.cleanupTopics !== undefined) {
          await this.#actor(() => this.#observeAfterExactCleanup(
            { kind: "runtime_continuity", emptyReason: "no_session" },
            effect.cleanupTopics as readonly string[],
          ));
        } else {
          await this.#reconcile({ kind: "runtime_continuity", emptyReason: "no_session" });
        }
      })
      .catch(async () => {
        await this.#actor(() => this.#persistUnavailableLocalState());
      })
      .finally(() => { this.#fences.delete(fence); });
    effect.fence = fence;
    this.#fences.add(fence);
    return fence;
  }

  #observeSdkStore(authority: ReconciliationAuthority): ReconciliationObservation | undefined {
    let sessions: readonly WalletConnectSessionSnapshot[];
    try { sessions = this.#client.listSessions(); }
    catch {
      this.#persistUnavailableLocalState();
      return undefined;
    }
    const sessionSetIdentity = captureSessionSetIdentity(sessions);
    if (sessionSetIdentity === undefined) {
      this.#persistUnavailableLocalState();
      return undefined;
    }
    const evidenceEpoch = this.#connectionEvidenceEpoch;
    const presentTopics = new Set(sessions.map(({ topic }) => topic));
    for (const topic of this.#deferredSessionTopics) {
      if (!presentTopics.has(topic)) this.#deferredSessionTopics.delete(topic);
    }

    const continuity = authority.kind === "startup_restore" ? undefined : this.#sessionContinuity;
    if (authority.kind !== "startup_restore" && sessions.length !== 0) {
      if (continuity === undefined) {
        for (const session of sessions) this.#deferredSessionTopics.add(session.topic);
      } else {
        const continuousSession = sessions.find(({ topic }) => topic === continuity.topic);
        if (continuousSession === undefined) {
          for (const session of sessions) this.#deferredSessionTopics.add(session.topic);
        } else {
          const connection = validateSession(
            continuousSession,
            this.#now(),
            this.#wallet.configuration,
          );
          if (connection === undefined || connection.status !== "connected" ||
            deriveCaip10Account({ chainId: connection.chainId, address: connection.address }) !== continuity.account) {
            this.#revocationAuthorities.set(continuousSession.topic, "active_invalidation");
          }
          for (const session of sessions) {
            if (session.topic !== continuity.topic) this.#deferredSessionTopics.add(session.topic);
          }
        }
      }
    }

    let revokeTopics = Object.freeze(sessions
      .map(({ topic }) => topic)
      .filter((topic) => this.#revocationAuthorities.has(topic)));
    if (revokeTopics.length !== 0) {
      if (authority.emptyReason !== "expired") {
        try { this.#publishSdkState(disconnected("unusable_store"), sessions, evidenceEpoch); }
        catch { this.#markLocalStateUnavailable(); }
      }
      return Object.freeze({ sessions, sessionSetIdentity, revokeTopics });
    }

    const hasDeferredSession = sessions.some(({ topic }) => this.#deferredSessionTopics.has(topic));
    if (hasDeferredSession) {
      try {
        this.#publishSdkState(
          sessions.length > 1
            ? Object.freeze({ status: "unresolved", sessionCount: String(sessions.length) })
            : disconnected("unusable_store"),
          sessions,
          evidenceEpoch,
        );
      } catch { return undefined; }
      return Object.freeze({ sessions, sessionSetIdentity, revokeTopics: Object.freeze([]) });
    }
    if (sessions.length === 0) {
      try {
        this.#publishSdkState(
          disconnected(authority.emptyReason),
          sessions,
          evidenceEpoch,
          undefined,
          authority.committedConnectionRevision,
        );
      }
      catch { return undefined; }
      return Object.freeze({ sessions, sessionSetIdentity, revokeTopics: Object.freeze([]) });
    }
    if (sessions.length > 1) {
      try {
        this.#publishSdkState(Object.freeze({
          status: "unresolved",
          sessionCount: String(sessions.length),
        }), sessions, evidenceEpoch);
      } catch { return undefined; }
      return Object.freeze({ sessions, sessionSetIdentity, revokeTopics: Object.freeze([]) });
    }

    const session = sessions[0] as WalletConnectSessionSnapshot;
    const connection = validateSession(session, this.#now(), this.#wallet.configuration);
    if (connection !== undefined) {
      try { this.#publishSdkState(connection, sessions, evidenceEpoch, session.topic); }
      catch { return undefined; }
      return Object.freeze({ sessions, sessionSetIdentity, revokeTopics: Object.freeze([]) });
    }
    if (authority.kind === "startup_restore") {
      this.#revocationAuthorities.set(session.topic, "startup_invalid");
      revokeTopics = Object.freeze([session.topic]);
    } else if (continuity?.topic === session.topic) {
      this.#revocationAuthorities.set(session.topic, "active_invalidation");
      revokeTopics = Object.freeze([session.topic]);
    } else {
      this.#deferredSessionTopics.add(session.topic);
    }
    if (authority.emptyReason !== "expired" || revokeTopics.length === 0) {
      try { this.#publishSdkState(disconnected("unusable_store"), sessions, evidenceEpoch); }
      catch { this.#markLocalStateUnavailable(); }
    }
    return Object.freeze({ sessions, sessionSetIdentity, revokeTopics });
  }

  #reconcile(
    authority: ReconciliationAuthority,
    deadline: UtcTimestamp = addMilliseconds(this.#now(), walletSdkOperationMilliseconds),
  ): Promise<StableReconciliation | undefined> {
    let task: Promise<StableReconciliation | undefined>;
    const predecessor = this.#reconciliationTail;
    task = predecessor.then(
      () => this.#performReconciliation(authority, deadline),
      () => this.#performReconciliation(authority, deadline),
    );
    this.#reconciliationTail = task.then(() => undefined, () => undefined);
    return task;
  }

  async #performReconciliation(
    authority: ReconciliationAuthority,
    deadline: UtcTimestamp,
  ): Promise<StableReconciliation | undefined> {
    const observation = await this.#actor(() => {
      if (this.#activeMutations.size !== 0 || this.#fences.size !== 0) {
        this.#persistUnavailableLocalState();
        return undefined;
      }
      return this.#observeSdkStore(authority);
    });
    if (observation === undefined) return undefined;
    if (observation.revokeTopics.length === 0) {
      return Object.freeze({
        sessions: observation.sessions,
        sessionSetIdentity: observation.sessionSetIdentity,
        evidenceEpoch: this.#connectionEvidenceEpoch,
      });
    }

    const cleanupTopics = observation.revokeTopics;
    const effect = this.#launchExactSessionRevocation({
      operationId: null,
      phaseVersion: 0,
      kind: "reconcile_sessions",
      deadline,
      topics: cleanupTopics,
      reconciliationAuthority: authority,
      preserveConnectionSnapshot: authority.committedConnectionRevision !== undefined,
    });
    const visible = await effect.visible;
    if (visible.status === "deadline") {
      this.#fenceEffect(effect);
      await this.#actor(() => this.#persistUnavailableLocalState());
      return undefined;
    }
    if (visible.settlement.status === "rejected") {
      await this.#actor(() => this.#persistUnavailableLocalState());
      return undefined;
    }
    return effect.readReconciliation();
  }

  #observeAfterExactCleanup(
    authority: ReconciliationAuthority,
    cleanupTopics: readonly string[],
  ): StableReconciliation | undefined {
    const observation = this.#observeSdkStore(authority);
    if (observation === undefined) return undefined;
    const remaining = new Set(observation.sessions.map(({ topic }) => topic));
    for (const topic of cleanupTopics) {
      if (!remaining.has(topic)) this.#revocationAuthorities.delete(topic);
    }
    if (
      cleanupTopics.some((topic) => remaining.has(topic)) ||
      observation.revokeTopics.length !== 0
    ) {
      return undefined;
    }
    return Object.freeze({
      sessions: observation.sessions,
      sessionSetIdentity: observation.sessionSetIdentity,
      evidenceEpoch: this.#connectionEvidenceEpoch,
    });
  }

  #launchExactSessionRevocation(input: Readonly<{
    operationId: string | null;
    phaseVersion: number;
    kind: Extract<EffectToken["kind"], "disconnect_sessions" | "revoke_approved_session" | "reconcile_sessions">;
    deadline: UtcTimestamp;
    topics: readonly string[];
    authority?: RevocationAuthority;
    reconciliationAuthority: ReconciliationAuthority;
    preserveConnectionSnapshot?: boolean;
  }>): ExactSessionRevocationEffect {
    const topics = canonicalUnique(input.topics);
    if (topics === undefined || topics.length === 0) {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    for (const topic of topics) {
      if (input.authority !== undefined) this.#revocationAuthorities.set(topic, input.authority);
      else if (!this.#revocationAuthorities.has(topic)) {
        throw new WalletOperationError("runtime_state_unavailable");
      }
    }
    let reconciliation: StableReconciliation | undefined;
    const effect = this.#launchMutation<void>({
      operationId: input.operationId,
      phaseVersion: input.phaseVersion,
      kind: input.kind,
      deadline: input.deadline,
      cleanupTopics: topics,
      ...(input.preserveConnectionSnapshot === undefined
        ? {}
        : { preserveConnectionSnapshot: input.preserveConnectionSnapshot }),
      run: async (checkDeadline) => {
        for (const topic of topics) {
          checkDeadline();
          await this.#client.disconnectSession(topic);
        }
      },
      afterSuccess: async () => {
        reconciliation = await this.#actor(() => this.#observeAfterExactCleanup(
          input.reconciliationAuthority,
          topics,
        ));
        if (reconciliation === undefined) throw new WalletSdkMutationUnavailableError();
      },
    });
    return Object.assign(effect, {
      readReconciliation(): StableReconciliation {
        if (reconciliation === undefined) throw new WalletSdkMutationUnavailableError();
        return reconciliation;
      },
    });
  }

  async #revokeExactSessions(input: Readonly<{
    operationId: string | null;
    phaseVersion: number;
    deadline: UtcTimestamp;
    topics: readonly string[];
    authority: RevocationAuthority;
    reconciliationAuthority: ReconciliationAuthority;
  }>): Promise<StableReconciliation> {
    const effect = await this.#actor(() => this.#launchExactSessionRevocation({
      ...input,
      kind: "revoke_approved_session",
    }));
    const visible = await effect.visible;
    if (visible.status === "deadline") {
      this.#fenceEffect(effect);
      throw new WalletSdkDeadlineError();
    }
    if (visible.settlement.status === "rejected") throw visible.settlement.error;
    return effect.readReconciliation();
  }

  #stableReconciliationState(stable: StableReconciliation): StableReconciliationState {
    if (stable.evidenceEpoch !== this.#connectionEvidenceEpoch || !this.#connectionEvidenceAvailable) {
      return "changed";
    }
    let sessions: readonly WalletConnectSessionSnapshot[];
    try { sessions = this.#client.listSessions(); }
    catch {
      this.#persistUnavailableLocalState();
      return "unavailable";
    }
    const currentIdentity = captureSessionSetIdentity(sessions);
    if (currentIdentity === undefined) {
      this.#persistUnavailableLocalState();
      return "unavailable";
    }
    if (currentIdentity === stable.sessionSetIdentity) return "current";
    this.#quiesceEvidence();
    return "changed";
  }

  #startOperation(
    input: WalletOperationCreate,
    stable: StableReconciliation,
    admission: Extract<LifecycleAdmission, { readonly kind: "create" }>,
    directBrowserAction: boolean,
  ): OperationStartAction {
    this.#assertOpen();
    this.#assertLifecycleAdmission(admission);
    this.#pruneExpiredTerminalOperations();
    if (this.#operations.has(input.operationId)) throw new WalletOperationError("state_conflict");
    if (this.#fences.size !== 0) throw new WalletOperationError("runtime_state_unavailable");
    if (this.#activeOperationId !== undefined) throw new WalletOperationError("state_conflict");
    const reconciliationState = this.#stableReconciliationState(stable);
    if (reconciliationState === "unavailable") {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    if (reconciliationState === "changed") return Object.freeze({ kind: "retry" });
    const record = this.#connectionSnapshot.record;
    if (input.connectionRevision !== null && input.connectionRevision !== record.revision) {
      throw new WalletOperationError("state_conflict");
    }
    if (input.kind === "connect") {
      if (stable.sessions.length === 0) {
        const started = this.#startConnectionOperation(input, record.revision);
        return Object.freeze({ kind: "start_pairing", ...started });
      }
      if (stable.sessions.length !== 1 || record.connection.status !== "connected") {
        throw new WalletOperationError("state_conflict");
      }
      return Object.freeze({
        kind: "current_connection",
        result: parseWalletOperationStartResponse({
          result: {
            status: "current_connection",
            connectionRevision: record.revision,
            connection: record.connection,
          },
        }).result,
      });
    }
    const entry = this.#createOperationEntry(input, record.revision);
    if (stable.sessions.length === 0) {
      this.#complete(entry, "already_disconnected");
      return Object.freeze({ kind: "immediate", operationId: entry.identity.operationId });
    }
    if (
      directBrowserAction ||
      (stable.sessions.length === 1 && input.interactionInterface === "cli")
    ) {
      const started = this.#beginExplicitDisconnect(entry, stable.sessions);
      return Object.freeze({ kind: "disconnect", operationId: entry.identity.operationId, ...started });
    }
    return Object.freeze({ kind: "immediate", operationId: entry.identity.operationId });
  }

  #confirmOperation(
    interactionInterface: WalletOperationCreate["interactionInterface"],
    operationId: string,
    confirmation: WalletOperationConfirmation,
    stable: StableReconciliation,
    admission: Extract<LifecycleAdmission, { readonly kind: "confirm" }>,
  ): ConfirmationAction {
    this.#assertOpen();
    this.#assertLifecycleAdmission(admission);
    const entry = this.#operationEntry(operationId);
    if (
      admission.operationId !== operationId ||
      admission.phaseVersion !== entry.phaseVersion ||
      admission.interactionInterface !== interactionInterface ||
      admission.connectionRevision !== confirmation.connectionRevision
    ) {
      throw new WalletOperationError("state_conflict");
    }
    this.#assertConfirmationAuthority(entry, interactionInterface, confirmation);
    const reconciliationState = this.#stableReconciliationState(stable);
    if (reconciliationState === "unavailable") {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    if (reconciliationState === "changed") {
      this.#trackBackground(
        this.#reconcile({ kind: "runtime_continuity", emptyReason: "no_session" }),
      );
      throw new WalletOperationError("state_conflict");
    }
    if (entry.identity.kind === "disconnect" && stable.sessions.length === 0) {
      this.#complete(entry, "already_disconnected");
      return Object.freeze({ kind: "immediate", operationId });
    }
    if (entry.identity.kind === "disconnect") {
      const started = this.#beginExplicitDisconnect(entry, stable.sessions);
      return Object.freeze({ kind: "disconnect", operationId, ...started });
    }
    throw new WalletOperationError("state_conflict");
  }

  async #cleanupLateAttempt(attempt: WalletConnectConnectionAttemptPort): Promise<void> {
    const outcome = await attempt.cancel();
    if (outcome.status !== "approved") return;
    await this.#revokeExactSessions({
      operationId: null,
      phaseVersion: 0,
      deadline: addMilliseconds(this.#now(), walletSdkOperationMilliseconds),
      topics: Object.freeze([outcome.session.topic]),
      authority: "approved_attempt",
      reconciliationAuthority: { kind: "runtime_continuity", emptyReason: "no_session" },
    });
  }

  async #settlePairingStart(
    operationId: string,
    effect: EffectHandle<WalletConnectConnectionAttemptPort>,
  ): Promise<void> {
    const visible = await effect.visible;
    if (this.#closingRequested) {
      this.#fenceEffect(effect);
      throw new WalletOperationError("runtime_state_unavailable");
    }
    if (visible.status === "deadline") {
      const termination = await this.#actor(() => {
        const entry = this.#entryOwningEffect(operationId, effect);
        return entry?.phase.tag === "approval_starting"
          ? this.#beginStartingTermination(entry, "expired")
          : undefined;
      });
      if (termination !== undefined) await this.#settleStartingTermination(termination);
      return;
    }
    const settlement = visible.settlement;
    if (settlement.status === "rejected") {
      await this.#actor(() => {
        const entry = this.#entryOwningEffect(operationId, effect);
        if (entry !== undefined) this.#fail(entry, walletFailureCode(settlement.error));
      });
      if (isWalletConnectClientError(settlement.error)) {
        this.#trackBackground(
          this.#reconcile({ kind: "runtime_continuity", emptyReason: "no_session" }),
        );
      }
      return;
    }
    const attempt = settlement.value;
    const lease: AttemptLease = Object.freeze({
      generation: this.#nextAttemptGeneration,
      attempt,
    });
    this.#nextAttemptGeneration += 1;
    const disposition = await this.#actor(() => {
      const entry = this.#entryOwningEffect(operationId, effect);
      if (entry?.phase.tag === "approval_starting") {
        this.#transition(entry, Object.freeze({
          tag: "approval_waiting",
          deadline: entry.identity.userActionDeadline,
          attempt: lease,
        }));
        return "accepted" as const;
      }
      const current = this.#operations.get(operationId);
      if (
        current?.phase.tag === "terminating_start" &&
        current.phase.termination.startEffect === effect
      ) {
        return "termination_owns" as const;
      }
      return "orphan" as const;
    });
    if (disposition === "termination_owns") return;
    if (disposition === "orphan") {
      this.#fenceEffect(effect);
      return;
    }
    this.#trackBackground(this.#observeAttemptOutcome(operationId, lease));
  }

  async #observeAttemptOutcome(operationId: string, lease: AttemptLease): Promise<void> {
    const observed = await Promise.race([
      Promise.resolve().then(() => lease.attempt.wait()).then(
        (outcome) => Object.freeze({ kind: "outcome" as const, outcome }),
        (error: unknown) => Object.freeze({ kind: "error" as const, error }),
      ),
      this.#shutdownSignal.promise.then(() => Object.freeze({ kind: "closed" as const })),
    ]);
    if (observed.kind === "closed" || this.#closingRequested) return;
    if (observed.kind === "outcome") {
      await this.#settleAttemptOutcome(operationId, lease, observed.outcome);
      return;
    }
    await this.#actor(() => {
      const entry = this.#entryWithAttempt(operationId, lease);
      if (entry !== undefined) this.#fail(entry, walletFailureCode(observed.error));
    });
  }

  #beginExplicitDisconnect(
    entry: OperationEntry,
    sessions: readonly WalletConnectSessionSnapshot[],
  ): {
    readonly effect: ExactSessionRevocationEffect;
    readonly purpose: ExplicitDisconnectPurpose;
  } {
    const topics = canonicalUnique(sessions.map(({ topic }) => topic));
    if (topics === undefined) throw new WalletOperationError("runtime_state_unavailable");
    const purpose = Object.freeze({
      targetTopics: topics,
    });
    const deadline = addMilliseconds(this.#now(), walletSdkOperationMilliseconds);
    const effect = this.#launchExactSessionRevocation({
      operationId: entry.identity.operationId,
      phaseVersion: entry.phaseVersion + 1,
      kind: "disconnect_sessions",
      deadline,
      topics,
      authority: "explicit_operation",
      reconciliationAuthority: { kind: "explicit_cleanup", emptyReason: "disconnected" },
    });
    this.#transition(entry, Object.freeze({
      tag: "disconnecting",
      deadline,
      purpose,
      effect,
    }));
    return Object.freeze({ effect, purpose });
  }

  async #settleExplicitDisconnect(
    operationId: string,
    effect: ExactSessionRevocationEffect,
    purpose: ExplicitDisconnectPurpose,
  ): Promise<void> {
    const visible = await effect.visible;
    if (this.#closingRequested) return;
    if (visible.status === "deadline") {
      await this.#actor(() => this.#timeoutEffect(operationId, effect));
      return;
    }
    const settlement = visible.settlement;
    if (settlement.status === "rejected") {
      await this.#actor(() => {
        this.#persistUnavailableLocalState();
        const entry = this.#entryOwningEffect(operationId, effect);
        if (entry !== undefined) {
          this.#fail(entry, walletFailureCode(settlement.error));
        }
      });
      return;
    }
    const reconciliation = effect.readReconciliation();
    const postcondition = reconciliation.sessions.length === 0;
    await this.#actor(() => {
      const entry = this.#entryOwningEffect(operationId, effect);
      if (entry === undefined) return;
      if (!postcondition) {
        this.#fail(entry, "runtime_state_unavailable");
        return;
      }
      for (const topic of purpose.targetTopics) this.#deferredSessionTopics.delete(topic);
      this.#complete(entry, "disconnected");
    });
  }

  #beginStartingTermination(
    entry: OperationEntry,
    intent: "cancelled" | "expired",
  ): StartingTerminationAction {
    if (entry.phase.tag !== "approval_starting") {
      throw new WalletOperationError("state_conflict");
    }
    const purpose = Object.freeze({ intent });
    const deadline = addMilliseconds(this.#now(), walletSdkOperationMilliseconds);
    const startEffect = entry.phase.effect;
    let work: Promise<void>;
    work = this.#terminateStartingConnection(startEffect, deadline)
      .finally(() => { this.#fences.delete(work); });
    this.#fences.add(work);
    const termination = Object.freeze({ startEffect, deadline, work });
    const terminating = this.#transition(entry, Object.freeze({
      tag: "terminating_start",
      deadline,
      purpose,
      termination,
    }));
    return Object.freeze({
      kind: "terminate_start",
      operationId: entry.identity.operationId,
      phaseVersion: terminating.phaseVersion,
      termination,
      purpose,
    });
  }

  async #terminateStartingConnection(
    startEffect: EffectHandle<WalletConnectConnectionAttemptPort>,
    deadline: UtcTimestamp,
  ): Promise<void> {
    const startSettlement = await startEffect.actual;
    if (startSettlement.status === "rejected") {
      const observation = await this.#actor(() => this.#observeSdkStore({
        kind: "runtime_continuity",
        emptyReason: "no_session",
      }));
      if (observation === undefined || observation.revokeTopics.length !== 0) {
        throw new WalletSdkMutationUnavailableError();
      }
      return;
    }

    const outcome = await startSettlement.value.cancel();
    if (outcome.status === "failed") throw new WalletSdkMutationUnavailableError();
    if (outcome.status === "approved") {
      await this.#revokeExactSessions({
        operationId: null,
        phaseVersion: 0,
        deadline,
        topics: Object.freeze([outcome.session.topic]),
        authority: "approved_attempt",
        reconciliationAuthority: { kind: "runtime_continuity", emptyReason: "no_session" },
      });
      return;
    }

    const observation = await this.#actor(() => this.#observeSdkStore({
      kind: "runtime_continuity",
      emptyReason: "no_session",
    }));
    if (observation === undefined || observation.revokeTopics.length !== 0) {
      throw new WalletSdkMutationUnavailableError();
    }
  }

  async #settleStartingTermination(action: StartingTerminationAction): Promise<void> {
    const visible = await this.#waitForCanonicalDeadline(
      action.termination.work,
      action.termination.deadline,
    );
    await this.#actor(() => {
      const entry = this.#entryWithStartingTermination(action);
      if (entry === undefined) return;
      if (visible.status === "deadline") {
        this.#persistUnavailableLocalState();
        this.#fail(entry, "wallet_timeout");
        return;
      }
      if (visible.settlement.status === "rejected") {
        this.#persistUnavailableLocalState();
        this.#fail(entry, walletFailureCode(visible.settlement.error));
        return;
      }
      this.#finish(entry, action.purpose.intent);
    });
  }

  #entryWithStartingTermination(action: StartingTerminationAction): OperationEntry | undefined {
    const entry = this.#operations.get(action.operationId);
    return entry?.phase.tag === "terminating_start" &&
      entry.phaseVersion === action.phaseVersion &&
      entry.phase.termination === action.termination
      ? entry
      : undefined;
  }

  #beginAttemptTermination(
    entry: OperationEntry,
    intent: "cancelled" | "expired",
  ): {
    readonly effect: EffectHandle<WalletConnectAttemptOutcome>;
    readonly purpose: AttemptTerminationPurpose;
  } {
    if (entry.phase.tag !== "approval_waiting") throw new WalletOperationError("state_conflict");
    const attempt = entry.phase.attempt;
    const purpose = Object.freeze({ intent, attempt });
    const deadline = addMilliseconds(this.#now(), walletSdkOperationMilliseconds);
    const effect = this.#launchMutation({
      operationId: entry.identity.operationId,
      phaseVersion: entry.phaseVersion + 1,
      kind: "cancel_attempt",
      deadline,
      run: async () => {
        const outcome = await attempt.attempt.cancel();
        if (outcome.status === "approved") {
          await this.#actor(() => {
            this.#revocationAuthorities.set(outcome.session.topic, "approved_attempt");
          });
          await this.#client.disconnectSession(outcome.session.topic);
        }
        return outcome;
      },
      afterSuccess: async (outcome) => {
        if (outcome.status !== "approved") return;
        const reconciliation = await this.#actor(() => this.#observeAfterExactCleanup(
          { kind: "runtime_continuity", emptyReason: "no_session" },
          Object.freeze([outcome.session.topic]),
        ));
        if (reconciliation === undefined) throw new WalletSdkMutationUnavailableError();
      },
    });
    this.#transition(entry, Object.freeze({
      tag: "terminating_attempt",
      deadline,
      purpose,
      effect,
    }));
    return Object.freeze({ effect, purpose });
  }

  async #settleAttemptTermination(
    operationId: string,
    effect: EffectHandle<WalletConnectAttemptOutcome>,
    purpose: AttemptTerminationPurpose,
  ): Promise<void> {
    const visible = await effect.visible;
    if (this.#closingRequested) throw new WalletOperationError("runtime_state_unavailable");
    if (visible.status === "deadline") {
      await this.#actor(() => this.#timeoutEffect(operationId, effect));
      if (purpose.intent === "cancelled") throw new WalletSdkDeadlineError();
      return;
    }
    if (visible.settlement.status === "rejected") {
      const error = visible.settlement.error;
      await this.#actor(() => {
        const entry = this.#entryOwningEffect(operationId, effect);
        if (entry === undefined) return;
        if (purpose.intent === "cancelled" && !this.#deadlineReached(entry.identity.userActionDeadline)) {
          this.#transition(entry, Object.freeze({
            tag: "approval_waiting",
            deadline: entry.identity.userActionDeadline,
            attempt: purpose.attempt,
          }));
        } else {
          this.#fail(entry, walletFailureCode(error));
        }
      });
      throw error;
    }
    const outcome = visible.settlement.value;
    const reconciliation = await this.#reconcile(
      { kind: "runtime_continuity", emptyReason: "no_session" },
      effect.deadline,
    );
    const approvedTopicPresent = outcome.status === "approved" &&
      reconciliation?.sessions.some(({ topic }) => topic === outcome.session.topic) === true;
    await this.#actor(() => {
      const entry = this.#entryOwningEffect(operationId, effect);
      if (entry === undefined) return;
      if (outcome.status === "failed" || reconciliation === undefined || approvedTopicPresent) {
        this.#fail(entry, "runtime_state_unavailable");
        return;
      }
      if (outcome.status === "approved") this.#revocationAuthorities.delete(outcome.session.topic);
      if (purpose.intent === "expired") this.#finish(entry, "expired");
      else if (outcome.status === "rejected") this.#finish(entry, "rejected");
      else this.#finish(entry, "cancelled");
    });
  }

  async #settleAttemptOutcome(
    operationId: string,
    attempt: AttemptLease,
    outcome: WalletConnectAttemptOutcome,
  ): Promise<void> {
    if (this.#closingRequested) return;
    const expiry = await this.#actor(() => {
      const entry = this.#entryWithAttempt(operationId, attempt);
      if (entry === undefined) return undefined;
      return this.#deadlineReached(entry.identity.userActionDeadline)
        ? this.#beginAttemptTermination(entry, "expired")
        : null;
    });
    if (this.#closingRequested) return;
    if (expiry !== null && expiry !== undefined) {
      await this.#settleAttemptTermination(operationId, expiry.effect, expiry.purpose);
      return;
    }
    if (expiry === undefined) return;

    if (outcome.status !== "approved") {
      await this.#reconcile({ kind: "runtime_continuity", emptyReason: "no_session" });
      await this.#actor(() => {
        const entry = this.#entryWithAttempt(operationId, attempt);
        if (entry === undefined) return;
        if (outcome.status === "rejected") this.#finish(entry, "rejected");
        else if (outcome.status === "cancelled") this.#finish(entry, "cancelled");
        else this.#fail(entry, "runtime_state_unavailable");
      });
      return;
    }

    let validation: ApprovedValidationAction;
    try {
      validation = await this.#actor(() => this.#beginApprovedValidation(operationId, attempt, outcome.session));
    } catch (error) {
      validation = await this.#actor(() => this.#beginApprovedExceptionCleanup(
        operationId,
        outcome.session.topic,
        walletFailureCode(error),
      ));
    }
    if (validation.kind === "complete") return;
    await this.#settleApprovedValidation(validation);
  }

  #beginApprovedValidation(
    operationId: string,
    attempt: AttemptLease,
    outcomeSession: WalletConnectSessionSnapshot,
  ): ApprovedValidationAction {
    if (this.#closingRequested) return Object.freeze({ kind: "complete" });
    const entry = this.#entryWithAttempt(operationId, attempt);
    if (entry === undefined) return Object.freeze({ kind: "complete" });
    const deadline = addMilliseconds(this.#now(), walletSdkOperationMilliseconds);
    this.#revocationAuthorities.set(outcomeSession.topic, "approved_attempt");
    const evidenceEpoch = this.#quiesceEvidence();
    const validating = this.#transition(entry, Object.freeze({
      tag: "validating_session",
      deadline,
      approvedTopic: outcomeSession.topic,
    }));
    const sessions = this.#client.listSessions();
    const approved = sessions.find(({ topic }) => topic === outcomeSession.topic);
    const connection = sessions.length === 1 && approved !== undefined
      ? validateSession(approved, this.#now(), this.#wallet.configuration)
      : undefined;
    if (connection !== undefined && approved !== undefined) {
      if (!this.#publishSdkState(connection, sessions, evidenceEpoch, approved.topic)) {
        throw new WalletSdkMutationUnavailableError();
      }
      this.#deferredSessionTopics.delete(approved.topic);
      this.#revocationAuthorities.delete(approved.topic);
      this.#complete(validating, "connected");
      return Object.freeze({ kind: "complete" });
    }

    for (const session of sessions) {
      if (session.topic !== outcomeSession.topic) this.#deferredSessionTopics.add(session.topic);
    }
    this.#persistUnavailableLocalState();
    let effect: ExactSessionRevocationEffect | undefined;
    if (approved !== undefined) {
      effect = this.#launchExactSessionRevocation({
        operationId,
        phaseVersion: validating.phaseVersion + 1,
        kind: "revoke_approved_session",
        deadline,
        topics: Object.freeze([approved.topic]),
        authority: "approved_attempt",
        reconciliationAuthority: { kind: "explicit_cleanup", emptyReason: "no_session" },
      });
    }
    const cleanupEntry = effect === undefined
      ? validating
      : this.#transition(validating, Object.freeze({
          tag: "validating_session",
          deadline,
          approvedTopic: outcomeSession.topic,
          effect: effect as EffectHandle<unknown>,
        }));
    return Object.freeze({
      kind: "cleanup",
      operationId,
      phaseVersion: cleanupEntry.phaseVersion,
      approvedTopic: outcomeSession.topic,
      failureCode: "wallet_session_unusable",
      ...(effect === undefined ? {} : { effect }),
    });
  }

  #beginApprovedExceptionCleanup(
    operationId: string,
    approvedTopic: string,
    failureCode: WalletOperationFailureCode,
  ): ApprovedValidationAction {
    if (this.#closingRequested) return Object.freeze({ kind: "complete" });
    const entry = this.#operations.get(operationId);
    if (
      entry === undefined ||
      entry.phase.tag === "terminal" ||
      this.#activeOperationId !== operationId
    ) {
      return Object.freeze({ kind: "complete" });
    }
    if (
      (entry.phase.tag !== "approval_waiting" && entry.phase.tag !== "validating_session") ||
      (entry.phase.tag === "validating_session" && entry.phase.effect !== undefined)
    ) {
      this.#persistUnavailableLocalState();
      this.#fail(entry, failureCode);
      return Object.freeze({ kind: "complete" });
    }
    this.#persistUnavailableLocalState();
    const deadline = addMilliseconds(this.#now(), walletSdkOperationMilliseconds);
    const effect = this.#launchExactSessionRevocation({
      operationId,
      phaseVersion: entry.phaseVersion + 1,
      kind: "revoke_approved_session",
      deadline,
      topics: Object.freeze([approvedTopic]),
      authority: "approved_attempt",
      reconciliationAuthority: { kind: "explicit_cleanup", emptyReason: "no_session" },
    });
    const cleanupEntry = this.#transition(entry, Object.freeze({
      tag: "validating_session",
      deadline,
      approvedTopic,
      effect: effect as EffectHandle<unknown>,
    }));
    return Object.freeze({
      kind: "cleanup",
      operationId,
      phaseVersion: cleanupEntry.phaseVersion,
      approvedTopic,
      failureCode,
      effect,
    });
  }

  async #settleApprovedValidation(action: Extract<ApprovedValidationAction, { readonly kind: "cleanup" }>): Promise<void> {
    if (action.effect !== undefined) {
      const visible = await action.effect.visible;
      if (visible.status === "deadline") {
        this.#fenceEffect(action.effect);
        await this.#actor(() => {
          this.#persistUnavailableLocalState();
          const entry = this.#operations.get(action.operationId);
          if (entry?.phaseVersion === action.phaseVersion && entry.phase.tag === "validating_session") {
            this.#fail(entry, "runtime_state_unavailable");
          }
        });
        return;
      }
      const settlement = visible.settlement;
      if (settlement.status === "rejected") {
        await this.#actor(() => {
          const entry = this.#operations.get(action.operationId);
          if (entry?.phaseVersion === action.phaseVersion && entry.phase.tag === "validating_session") {
            this.#fail(entry, walletFailureCode(settlement.error));
          }
        });
        return;
      }
    }
    if (this.#closingRequested) return;
    const reconciliation = action.effect === undefined
      ? await this.#reconcile({ kind: "explicit_cleanup", emptyReason: "no_session" })
      : action.effect.readReconciliation();
    await this.#actor(() => {
      const entry = this.#operations.get(action.operationId);
      if (entry?.phaseVersion !== action.phaseVersion || entry.phase.tag !== "validating_session") return;
      const topicPresent = reconciliation?.sessions.some(({ topic }) => topic === action.approvedTopic) === true;
      if (reconciliation === undefined || topicPresent) {
        this.#fail(entry, "runtime_state_unavailable");
        return;
      }
      this.#fail(entry, action.failureCode);
    });
  }

  #cancelOperation(
    interactionInterface: WalletOperationCreate["interactionInterface"] | undefined,
    operationId: string,
    confirmation: WalletOperationConfirmation | undefined,
  ): StartingTerminationAction | AttemptTerminationAction | undefined {
    const entry = this.#operationEntry(operationId);
    if (interactionInterface !== undefined && entry.identity.interactionInterface !== interactionInterface) {
      throw new WalletOperationError("state_conflict");
    }
    if (
      interactionInterface !== undefined &&
      (
        confirmation === undefined ||
        confirmation.connectionRevision !== entry.identity.connectionRevision
      )
    ) {
      throw new WalletOperationError("state_conflict");
    }
    if (entry.phase.tag === "terminal" && entry.phase.state === "cancelled") return undefined;
    if (entry.phase.tag === "awaiting_confirmation") {
      this.#finish(entry, "cancelled");
      return undefined;
    }
    if (entry.phase.tag === "approval_starting") {
      return this.#beginStartingTermination(entry, "cancelled");
    }
    if (entry.phase.tag !== "approval_waiting") throw new WalletOperationError("state_conflict");
    const termination = this.#beginAttemptTermination(entry, "cancelled");
    return Object.freeze({
      kind: "terminate_attempt",
      operationId,
      effect: termination.effect,
      purpose: termination.purpose,
    });
  }

  async #enterOperation(operationId: string): Promise<WalletOperationResponse> {
    const synchronization = await this.#actor(() => this.#synchronizeOperation(operationId));
    if (synchronization.kind === "terminate_start") {
      await this.#settleStartingTermination(synchronization);
    } else if (synchronization.kind === "terminate_attempt") {
      await this.#settleAttemptTermination(
        synchronization.operationId,
        synchronization.effect,
        synchronization.purpose,
      );
    }
    this.#assertOpen();
    return this.#readResponse(operationId);
  }

  #synchronizeOperation(operationId: string): DeadlineSynchronization {
    const entry = this.#operationEntry(operationId);
    const phase = entry.phase;
    if (phase.tag === "terminal") return Object.freeze({ kind: "ready", response: this.#operationResponse(entry) });
    if (!this.#deadlineReached(phase.deadline)) {
      return Object.freeze({ kind: "ready", response: this.#operationResponse(entry) });
    }
    if (phase.tag === "awaiting_confirmation") {
      const terminal = this.#finish(entry, "expired");
      return Object.freeze({ kind: "ready", response: this.#operationResponse(terminal) });
    }
    if (phase.tag === "approval_waiting") {
      const termination = this.#beginAttemptTermination(entry, "expired");
      return Object.freeze({
        kind: "terminate_attempt",
        operationId,
        effect: termination.effect,
        purpose: termination.purpose,
      });
    }
    if (phase.tag === "approval_starting") {
      return this.#beginStartingTermination(entry, "expired");
    } else if (phase.tag === "terminating_start") {
      return Object.freeze({
        kind: "terminate_start",
        operationId,
        phaseVersion: entry.phaseVersion,
        termination: phase.termination,
        purpose: phase.purpose,
      });
    } else if (phase.tag === "disconnecting") {
      this.#timeoutEffect(operationId, phase.effect);
    } else if (phase.tag === "terminating_attempt") {
      this.#timeoutEffect(operationId, phase.effect);
    } else if (phase.effect !== undefined) {
      this.#timeoutEffect(operationId, phase.effect);
    } else {
      this.#fail(entry, "wallet_timeout");
    }
    return Object.freeze({ kind: "ready", response: this.#operationResponse(this.#operationEntry(operationId)) });
  }

  #timeoutEffect<Result>(operationId: string, effect: EffectHandle<Result>): void {
    const entry = this.#entryOwningEffect(operationId, effect);
    if (entry === undefined) return;
    this.#fenceEffect(effect);
    this.#fail(entry, "wallet_timeout");
  }

  #entryOwningEffect<Result>(operationId: string, effect: EffectHandle<Result>): OperationEntry | undefined {
    const entry = this.#operations.get(operationId);
    if (entry === undefined || entry.phaseVersion !== effect.token.phaseVersion) return undefined;
    const phase = entry.phase;
    if (
      phase.tag === "approval_starting" ||
      phase.tag === "disconnecting" ||
      phase.tag === "terminating_attempt" ||
      phase.tag === "validating_session"
    ) {
      return phase.effect?.token.id === effect.token.id ? entry : undefined;
    }
    return undefined;
  }

  #entryWithAttempt(operationId: string, attempt: AttemptLease): OperationEntry | undefined {
    const entry = this.#operations.get(operationId);
    return entry?.phase.tag === "approval_waiting" &&
      entry.phase.attempt.generation === attempt.generation &&
      entry.phase.attempt.attempt === attempt.attempt
      ? entry
      : undefined;
  }

  #eventCanInvalidateEvidence(event: WalletConnectClientEvent): boolean {
    if (event.kind === "session_quarantined" || event.kind === "session_changed" ||
      event.kind === "session_deleted" || event.kind === "session_expired") return true;
    const activeTopic = this.#sessionContinuity?.topic;
    if (event.kind === "invalid_session_event") return event.topic === null || event.topic === activeTopic;
    return event.topic === activeTopic;
  }

  async #handleClientEvent(event: WalletConnectClientEvent): Promise<void> {
    if (this.#closingRequested) return;
    if (event.kind === "session_quarantined") {
      await this.#actor(() => this.#persistUnavailableLocalState());
      return;
    }
    if (event.kind === "session_changed") {
      await this.#reconcile({ kind: "runtime_continuity", emptyReason: "no_session" });
      return;
    }
    if (event.kind === "session_deleted") {
      await this.#reconcile({ kind: "runtime_continuity", emptyReason: "deleted" });
      return;
    }
    if (event.kind === "session_expired") {
      await this.#reconcile({ kind: "runtime_continuity", emptyReason: "expired" });
      return;
    }
    const continuity = await this.#actor(() => this.#sessionContinuity);
    if (this.#closingRequested) return;
    if (continuity === undefined || (event.topic !== null && event.topic !== continuity.topic)) return;
    const activeTopic = continuity.topic;
    if (event.kind === "invalid_session_event") {
      await this.#invalidateSession(activeTopic);
      return;
    }
    if (event.eventName === "accountsChanged") {
      if (event.data.length !== 1 || event.data[0] !== continuity.account) {
        await this.#invalidateSession(activeTopic);
        return;
      }
      await this.#reconcile({ kind: "runtime_continuity", emptyReason: "no_session" });
      return;
    }
    const targetChainHex = `0x${BigInt(
      deriveEip155Reference(this.#wallet.configuration.chain.chainId),
    ).toString(16)}`;
    if (event.data !== targetChainHex) {
      await this.#invalidateSession(activeTopic);
      return;
    }
    await this.#reconcile({ kind: "runtime_continuity", emptyReason: "no_session" });
  }

  async #invalidateSession(topic: string): Promise<void> {
    await this.#actor(() => {
      this.#revocationAuthorities.set(topic, "active_invalidation");
      this.#persistUnavailableLocalState();
    });
    if (this.#closingRequested) return;
    await this.#reconcile({ kind: "runtime_continuity", emptyReason: "no_session" });
  }
}

export const createWalletCoordinator = (input: {
  readonly client: WalletConnectClientPort;
  readonly wallet: WalletOwnerBootstrapPort;
}): Promise<WalletCoordinator> => WalletCoordinator.create(input);
