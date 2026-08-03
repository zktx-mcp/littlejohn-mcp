import {
  bindCapability,
  canonicalJsonStringify,
  compareCodePointSequences,
  deriveCaip10Account,
  fixedIdentifierSchema,
  parseCaip10EvmAccount,
  parseCapabilityDataAt,
  parseEvmChainId,
  parseUtcTimestamp,
  walletConnectionCapability,
  walletConnectionEvidence,
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
  parseWalletOperationCancellation,
  parseWalletOperationCommand,
  parseWalletOperationConfirmation,
  parseWalletOperationId,
  parseWalletOperationPresentation,
  parseWalletOperationStartResult,
  parseWalletWebOperationCreate,
  type WalletCurrentOperationProjection,
  type WalletCurrentOperationProjectionPort,
  type WalletLocalControlOperationPort,
  type WalletManagementOperation,
  type WalletOperationCancellation,
  type WalletOperationConfirmation,
  type WalletOperationConfirmationPort,
  type WalletOperationCreate,
  type WalletOperationFailure,
  type WalletOperationFailureCode,
  type WalletOperationPresentation,
  type WalletOperationPresentationPort,
  type WalletOperationResult,
  type WalletOperationStartResult,
  type WalletPeerRefusalCode,
  type WalletWebOperationCreate,
  type WalletWebOperationPort,
} from "./contracts.js";
import {
  isWalletOperationTerminalState,
  type WalletInteractionInterface,
  type WalletOperationKind,
  type WalletOperationState,
} from "./operation-state.js";
import {
  WalletOperationError,
  createWalletFailure,
  normalizeWalletError,
  walletErrorRegistry,
} from "./errors.js";
import {
  isWalletConnectClientError,
  type WalletConnectAttemptOutcome,
  type WalletConnectClientEvent,
  type WalletConnectClientPort,
  type WalletConnectConnectionAttemptPort,
  type WalletConnectSessionSnapshot,
  type WalletConnectStableObservation,
} from "./walletconnect-client.js";
import {
  readWalletConnectSessionRequirements,
  type WalletConnectSessionRequirements,
} from "./walletconnect-configuration.js";

const actionLifetimeMilliseconds = 5 * 60 * 1_000;
const effectSettlementMilliseconds = 5 * 60 * 1_000;
const terminalRetentionMilliseconds = 5 * 60 * 1_000;

const unknownConnection = (
  reason: "reconciling" | "observation_unavailable",
): WalletConnectionData => Object.freeze({ status: "unknown", reason });

const disconnectedConnection = (
  reason: "no_session" | "expired" | "disconnected",
): WalletConnectionData => Object.freeze({ status: "disconnected", reason });

const addMilliseconds = (value: UtcTimestamp, milliseconds: number): UtcTimestamp =>
  parseUtcTimestamp(new Date(Date.parse(value) + milliseconds).toISOString());

const asCanonical = (value: WalletConnectionData): CanonicalJson =>
  value as unknown as CanonicalJson;

const sameConnection = (left: WalletConnectionData, right: WalletConnectionData): boolean =>
  canonicalJsonStringify(asCanonical(left)) === canonicalJsonStringify(asCanonical(right));

const orderedUnique = (values: readonly string[]): readonly string[] | undefined => {
  const ordered = [...values].sort(compareCodePointSequences);
  if (ordered.some((value, index) => index !== 0 && ordered[index - 1] === value)) {
    return undefined;
  }
  return Object.freeze(ordered);
};

interface ValidSession {
  readonly status: "valid";
  readonly source: WalletSessionSource;
  readonly connection: Extract<WalletConnectionData, { readonly status: "connected" }>;
}

interface InvalidSession {
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

type EvaluatedSession = ValidSession | InvalidSession;

interface EvaluatedObservation {
  readonly observation: WalletConnectStableObservation;
  readonly sessions: readonly EvaluatedSession[];
  readonly connection: WalletConnectionData;
  readonly sessionSource?: WalletSessionSource;
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

interface CancellationSignal {
  readonly promise: Promise<void>;
  request(): void;
}

interface OperationEntry {
  readonly operationId: string;
  readonly kind: WalletOperationKind;
  readonly connectionRevision: string;
  readonly actionExpiresAt: UtcTimestamp;
  readonly interactionInterface: WalletInteractionInterface;
  state: WalletOperationState;
  result: WalletOperationResult | null;
  failure: WalletOperationFailure | null;
  peerRefusalCode: WalletPeerRefusalCode | null;
  qr?: WalletOperationPresentation["qr"];
  terminationIntent?: "cancelled" | "expired";
  terminalExpiresAt?: UtcTimestamp;
  readonly cancellation: CancellationSignal;
}

interface ActiveEffect {
  readonly operationId?: string;
  readonly work: Promise<void>;
}

type StableRead =
  | { readonly status: "available"; readonly observation: WalletConnectStableObservation }
  | { readonly status: "unavailable" };

type ConnectedWalletConnection = Extract<WalletConnectionData, { readonly status: "connected" }>;

interface SessionAttribution {
  readonly source: WalletSessionSource;
  readonly connection: ConnectedWalletConnection;
}

type WalletAuthority =
  | Readonly<{
      status: "available";
      record: WalletConnectionRecord;
      sessionAttribution?: SessionAttribution;
      pendingRevalidation: false;
    }>
  | Readonly<{
      status: "closed";
      record: WalletConnectionRecord;
      reason: "reconciling" | "observation_unavailable";
      sessionAttribution?: SessionAttribution;
      pendingRevalidation: boolean;
    }>;

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
  if (
    typeof timer === "object" && timer !== null &&
    "unref" in timer && typeof timer.unref === "function"
  ) timer.unref();
};

const createCancellationSignal = (): CancellationSignal => {
  let requested = false;
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return Object.freeze({
    promise,
    request: () => {
      if (requested) return;
      requested = true;
      resolve();
    },
  });
};

const failureCodeFor = (error: unknown): WalletOperationFailureCode => {
  if (isWalletConnectClientError(error)) {
    switch (error.code) {
      case "qr_encoding": return "wallet_pairing_code_unavailable";
      case "local_admission": return "state_conflict";
      case "sdk": return "walletconnect_unavailable";
      case "observation": return "runtime_state_unavailable";
      case "module_loading":
      case "configuration":
      case "deadline": return "internal_error";
    }
  }
  const failure = normalizeWalletError(error).failure;
  if (isWalletOperationFailureCode(failure.error.code)) return failure.error.code;
  return ["runtime", "state", "transport"].includes(failure.error.category)
    ? "runtime_state_unavailable"
    : "internal_error";
};

const operationFailureFor = (code: WalletOperationFailureCode): WalletOperationFailure =>
  operationFailure(createWalletFailure(code));

const withDeadline = async <Result>(
  work: Promise<Result>,
  milliseconds: number,
): Promise<Result> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WalletOperationError("wallet_timeout")), milliseconds);
    unrefTimer(timer);
  });
  try { return await Promise.race([work, deadline]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
};

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
  readonly #requirements: WalletConnectSessionRequirements;
  readonly #operations = new Map<string, OperationEntry>();
  #authority: WalletAuthority;
  #activeOperationId: string | undefined;
  #effect: ActiveEffect | undefined;
  #operationWake: ReturnType<typeof setTimeout> | undefined;
  #reconcilePending = false;
  #reconcileScheduled = false;
  #unsubscribe: (() => void) | undefined;
  #closing = false;
  #closed = false;
  #closeWork: Promise<void> | undefined;

  private constructor(client: WalletConnectClientPort, wallet: WalletOwnerBootstrapPort) {
    this.#client = client;
    this.#wallet = wallet;
    this.#requirements = readWalletConnectSessionRequirements(wallet.configuration);
    this.#authority = Object.freeze({
      status: "closed",
      record: wallet.projection.read(),
      reason: "reconciling",
      pendingRevalidation: false,
    });

    this.activeWallet = Object.freeze({ capture: () => this.#captureActiveWallet() });
    this.operation = Object.freeze({
      start: async (input: WalletWebOperationCreate, operationId: string) => {
        const parsed = parseWalletWebOperationCreate(input);
        return this.#start(parseWalletOperationCommand({
          operationId,
          interactionInterface: "web",
          kind: parsed.kind,
          connectionRevision: parsed.connectionRevision,
        }));
      },
      cancel: async (operationId: string, input: WalletOperationConfirmation) => {
        const confirmation = parseWalletOperationConfirmation(input);
        return this.#cancel({
          operationId,
          connectionRevision: confirmation.connectionRevision,
        }, "web");
      },
    });
    this.cliConfirmation = Object.freeze({
      interactionInterface: "cli" as const,
      confirm: (operationId: string, input: WalletOperationConfirmation) =>
        this.#confirm("cli", operationId, input),
    });
    this.webConfirmation = Object.freeze({
      interactionInterface: "web" as const,
      confirm: (operationId: string, input: WalletOperationConfirmation) =>
        this.#confirm("web", operationId, input),
    });
    this.operationPresentation = Object.freeze({
      get: (operationId: string, interactionInterface: WalletInteractionInterface) =>
        this.#readPresentation(operationId, interactionInterface),
    });
    this.currentOperationProjection = Object.freeze({
      get: () => this.#readCurrentProjection(),
    });

    const binding: CapabilityBinding<typeof walletConnectionCapability> = bindCapability({
      definition: walletConnectionCapability,
      errorRegistry: walletErrorRegistry,
      invocationAuthority: wallet.capabilityAuthority.invocationAuthority,
      createInvocationPorts: (): WalletConnectionInvocationPorts => {
        const walletSnapshot = this.#captureActiveWallet();
        return Object.freeze({
          ...wallet.capabilityAuthority.createInvocationPorts(walletSnapshot.sessionSource),
          walletSnapshot,
          evidenceAvailable: this.#authority.status === "available",
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
        const sdk = observations.bind(walletConnectionEvidence.targets.sdk);
        observations.record(sdk.slot, {
          source: wallet.sourceAuthority.sdkStoreAuthority,
          claims: [{ role: sdk.roles.state, value: asCanonical(snapshot.connection) }],
        });
        if (snapshot.connection.status === "connected") {
          if (snapshot.sessionSource === undefined) {
            throw new TypeError("Connected wallet source is unavailable.");
          }
          const session = observations.bind(walletConnectionEvidence.targets.session);
          observations.record(session.slot, {
            source: snapshot.sessionSource.observationAuthority,
            claims: [{ role: session.roles.state, value: asCanonical(snapshot.connection) }],
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
    const activation = input.client.activate((event) => coordinator.#onClientEvent(event));
    coordinator.#unsubscribe = activation.unsubscribe;
    coordinator.#closeAuthority("reconciling", false);
    if (activation.initialObservation.status === "available") {
      coordinator.#convergeObservation(activation.initialObservation.observation, "no_session");
    } else {
      try { coordinator.#closeAuthority("observation_unavailable", false); }
      catch { /* The in-memory authority remains closed. */ }
    }
    try { activation.releaseEvents(); }
    catch {
      try { coordinator.#closeAuthority("observation_unavailable", false); }
      catch { /* The in-memory authority remains closed. */ }
    }
    return coordinator;
  }

  async start(input: WalletOperationCreate): Promise<WalletOperationStartResult> {
    return this.#start(parseWalletOperationCommand(input));
  }

  async get(operationId: string): Promise<WalletManagementOperation> {
    this.#assertOpen();
    this.#convergePublicState();
    const id = parseWalletOperationId(operationId);
    return this.#operationValue(this.#entry(id));
  }

  async cancel(input: WalletOperationCancellation): Promise<WalletManagementOperation> {
    return this.#cancel(parseWalletOperationCancellation(input));
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closeWork !== undefined) return this.#closeWork;
    this.#closing = true;
    const work = this.#performClose().then(() => {
      this.#closed = true;
      this.#operations.clear();
      this.#activeOperationId = undefined;
    }).finally(() => {
      if (this.#closeWork === work) this.#closeWork = undefined;
    });
    this.#closeWork = work;
    return work;
  }

  async #start(input: WalletOperationCreate): Promise<WalletOperationStartResult> {
    this.#assertOpen();
    this.#convergePublicState();
    if (
      this.#activeOperationId !== undefined || this.#effect !== undefined ||
      this.#operations.has(input.operationId)
    ) throw new WalletOperationError("state_conflict");

    const stable = this.#readStableObservation();
    if (stable.status === "unavailable") {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    this.#convergeObservation(stable.observation, "no_session");
    if (this.#authority.status !== "available" || this.#effect !== undefined) {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    const record = this.#authority.record;
    if (input.connectionRevision !== null && input.connectionRevision !== record.revision) {
      throw new WalletOperationError("state_conflict");
    }

    if (input.kind === "connect" && record.connection.status === "connected") {
      return parseWalletOperationStartResult({
        status: "current_connection",
        connectionRevision: record.revision,
        connection: record.connection,
      });
    }
    if (input.kind === "connect" && record.connection.status !== "disconnected") {
      throw new WalletOperationError(
        record.connection.status === "unresolved" ? "wallet_session_unusable" : "runtime_state_unavailable",
      );
    }

    const entry = this.#prepareOperation(input, record.revision);
    if (input.kind === "disconnect") {
      if (record.connection.status === "unknown") {
        throw new WalletOperationError("runtime_state_unavailable");
      }
      this.#publishOperation(entry);
      if (record.connection.status === "disconnected") {
        this.#complete(entry, {
          outcome: "already_disconnected",
          connection: record.connection,
        });
      } else {
        this.#setState(entry, "awaiting_confirmation");
      }
      return this.#startResult(entry);
    }

    this.#closeAuthority("reconciling", false);
    this.#publishOperation(entry);
    this.#launchEffect(entry.operationId, () => this.#startConnectionEffect(entry));
    return this.#startResult(entry);
  }

  #prepareOperation(input: WalletOperationCreate, connectionRevision: string): OperationEntry {
    const now = this.#now();
    return {
      operationId: parseWalletOperationId(input.operationId),
      kind: input.kind,
      connectionRevision,
      actionExpiresAt: addMilliseconds(now, actionLifetimeMilliseconds),
      interactionInterface: input.interactionInterface,
      state: input.kind === "connect" ? "starting_connection" : "awaiting_confirmation",
      result: null,
      failure: null,
      peerRefusalCode: null,
      cancellation: createCancellationSignal(),
    };
  }

  #publishOperation(entry: OperationEntry): void {
    this.#operations.set(entry.operationId, entry);
    this.#activeOperationId = entry.operationId;
    this.#scheduleConvergence();
  }

  async #confirm(
    interactionInterface: WalletInteractionInterface,
    operationId: string,
    input: WalletOperationConfirmation,
  ): Promise<WalletManagementOperation> {
    this.#assertOpen();
    this.#convergePublicState();
    const id = parseWalletOperationId(operationId);
    const confirmation = parseWalletOperationConfirmation(input);
    const entry = this.#entry(id);
    if (
      entry.kind !== "disconnect" || entry.state !== "awaiting_confirmation" ||
      entry.interactionInterface !== interactionInterface ||
      entry.connectionRevision !== confirmation.connectionRevision ||
      this.#authority.record.revision !== confirmation.connectionRevision ||
      this.#effect !== undefined
    ) throw new WalletOperationError("state_conflict");

    const stable = this.#readStableObservation();
    if (stable.status === "unavailable") {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    const evaluated = this.#convergeObservation(stable.observation, "no_session");
    if (
      this.#authority.status !== "available" ||
      this.#authority.record.revision !== confirmation.connectionRevision
    ) {
      throw new WalletOperationError("state_conflict");
    }
    const sources = evaluated.sessions.map((session) => session.source.sourceId);
    if (sources.length === 0) {
      const disconnected = this.#convergeObservation(stable.observation, "disconnected");
      if (disconnected.connection.status !== "disconnected") {
        throw new WalletOperationError("state_conflict");
      }
      this.#complete(entry, {
        outcome: "already_disconnected",
        connection: disconnected.connection,
      });
      return this.#operationValue(entry);
    }
    this.#closeAuthority("reconciling", false);
    this.#setState(entry, "disconnecting");
    this.#launchEffect(entry.operationId, () => this.#disconnectEffect(entry, sources));
    return this.#operationValue(entry);
  }

  async #cancel(
    input: WalletOperationCancellation,
    browserInterface?: "web",
  ): Promise<WalletManagementOperation> {
    this.#assertOpen();
    this.#convergePublicState();
    const cancellation = parseWalletOperationCancellation(input);
    const entry = this.#entry(cancellation.operationId);
    if (
      cancellation.connectionRevision !== entry.connectionRevision ||
      (browserInterface !== undefined && entry.interactionInterface !== browserInterface)
    ) throw new WalletOperationError("state_conflict");
    if (entry.state === "cancelled") return this.#operationValue(entry);
    if (entry.state === "awaiting_confirmation") {
      this.#terminal(entry, "cancelled");
      return this.#operationValue(entry);
    }
    if (entry.kind === "connect" && entry.state === "cancelling") {
      return this.#operationValue(entry);
    }
    if (
      entry.kind !== "connect" ||
      !["starting_connection", "awaiting_wallet_approval"].includes(entry.state) ||
      this.#effect?.operationId !== entry.operationId
    ) {
      throw new WalletOperationError("state_conflict");
    }
    entry.terminationIntent = "cancelled";
    entry.qr = undefined;
    this.#setState(entry, "cancelling");
    try { this.#closeAuthority("reconciling", true); }
    catch { /* Cancellation still proceeds under the already-closed in-memory authority. */ }
    entry.cancellation.request();
    return this.#operationValue(entry);
  }

  async #startConnectionEffect(entry: OperationEntry): Promise<void> {
    let attempt: WalletConnectConnectionAttemptPort;
    try {
      attempt = await this.#client.startConnection();
    }
    catch (error) {
      this.#convergeOperations();
      const evaluated = this.#refreshAfterEffect();
      if (this.#settleConnectTermination(entry, evaluated)) return;
      const code = isWalletConnectClientError(error) && error.code === "qr_encoding"
        ? evaluated !== undefined && this.#isCompleteEmpty(evaluated)
          ? "wallet_pairing_code_unavailable"
          : "walletconnect_unavailable"
        : failureCodeFor(error);
      this.#failIfNonterminal(entry, code);
      return;
    }
    this.#convergeOperations();
    let outcome: WalletConnectAttemptOutcome;
    try {
      if (entry.terminationIntent !== undefined || isWalletOperationTerminalState(entry.state)) {
        outcome = await attempt.cancel();
      } else {
        entry.qr = attempt.qr;
        this.#setState(entry, "awaiting_wallet_approval");
        const selected = await Promise.race([
          attempt.wait().then((value) => Object.freeze({ kind: "outcome" as const, value })),
          entry.cancellation.promise.then(() => Object.freeze({ kind: "cancel" as const })),
        ]);
        outcome = selected.kind === "cancel" || entry.terminationIntent !== undefined
          ? await attempt.cancel()
          : selected.value;
      }
    } catch (error) {
      this.#convergeOperations();
      const evaluated = this.#refreshAfterEffect();
      if (this.#settleConnectTermination(entry, evaluated)) return;
      this.#failIfNonterminal(entry, failureCodeFor(error));
      return;
    }
    this.#convergeOperations();
    entry.qr = undefined;

    if (entry.terminationIntent !== undefined || isWalletOperationTerminalState(entry.state)) {
      if (outcome.status === "approved") await this.#cleanApprovedSession(outcome.session);
      const evaluated = this.#refreshAfterEffect();
      this.#settleConnectTermination(entry, evaluated);
      return;
    }

    if (outcome.status === "rejected") {
      this.#refreshAfterEffect();
      this.#reject(entry, outcome.peerRefusalCode);
      return;
    }
    if (outcome.status === "failed") {
      this.#refreshAfterEffect();
      this.#fail(entry, "walletconnect_unavailable");
      return;
    }
    if (outcome.status === "cancelled") {
      const evaluated = this.#refreshAfterEffect();
      if (evaluated !== undefined && this.#isCompleteEmpty(evaluated)) {
        this.#terminal(entry, "cancelled");
      } else {
        this.#closeAuthority("observation_unavailable", true);
        this.#fail(entry, "runtime_state_unavailable");
      }
      return;
    }

    this.#setState(entry, "validating_session");
    const stable = this.#readStableObservation();
    if (stable.status === "available") {
      const evaluated = this.#convergeObservation(stable.observation, "no_session");
      const only = evaluated.sessions[0];
      if (
        evaluated.observation.proposalCount === 0 &&
        evaluated.sessions.length === 1 && only?.status === "valid" &&
        outcome.session.status === "valid" &&
        only.source.sourceId === outcome.session.source.sourceId &&
        this.#authority.status === "available" &&
        !this.#authority.record.revalidationRequired
      ) {
        const record = this.#authority.record;
        if (record.connection.status === "connected") {
          this.#complete(entry, { outcome: "connected", connection: record.connection });
          return;
        }
      }
    }

    await this.#cleanApprovedSession(outcome.session);
    this.#convergeOperations();
    const evaluated = this.#refreshAfterEffect();
    if (this.#settleConnectTermination(entry, evaluated)) return;
    if (outcome.session.status !== "valid") this.#closeAuthority("reconciling", true);
    this.#fail(entry, "wallet_session_unusable");
  }

  async #cleanApprovedSession(session: WalletConnectSessionSnapshot): Promise<void> {
    try { await this.#client.disconnectSession(session.source.sourceId); }
    catch {
      this.#closeAuthority("reconciling", true);
    }
  }

  #settleConnectTermination(
    entry: OperationEntry,
    evaluated: EvaluatedObservation | undefined,
  ): boolean {
    if (entry.terminationIntent === undefined && !isWalletOperationTerminalState(entry.state)) {
      return false;
    }
    if (evaluated !== undefined && this.#isCompleteEmpty(evaluated)) {
      if (!isWalletOperationTerminalState(entry.state)) {
        this.#terminal(entry, entry.terminationIntent ?? "cancelled");
      }
    } else {
      this.#closeAuthority("observation_unavailable", true);
      this.#failIfNonterminal(entry, "runtime_state_unavailable");
    }
    return true;
  }

  async #disconnectEffect(entry: OperationEntry, sourceIds: readonly string[]): Promise<void> {
    let effectError: unknown;
    for (const sourceId of sourceIds) {
      try { await this.#client.disconnectSession(sourceId); }
      catch (error) { effectError ??= error; }
    }
    this.#convergeOperations();
    const stable = this.#readStableObservation();
    if (stable.status === "unavailable") {
      this.#failIfNonterminal(entry, "runtime_state_unavailable");
      return;
    }
    const evaluated = this.#convergeObservation(stable.observation, "disconnected");
    if (!this.#isCompleteEmpty(evaluated)) {
      this.#failIfNonterminal(
        entry,
        effectError === undefined ? "runtime_state_unavailable" : failureCodeFor(effectError),
      );
      return;
    }
    if (!isWalletOperationTerminalState(entry.state)) {
      const connection = this.#authority.record.connection;
      if (connection.status !== "disconnected") {
        this.#fail(entry, "runtime_state_unavailable");
        return;
      }
      if (entry.terminationIntent !== undefined) {
        this.#terminal(entry, entry.terminationIntent);
      } else {
        this.#complete(entry, { outcome: "disconnected", connection });
      }
    }
  }

  #readPresentation(
    operationId: string,
    interactionInterface: WalletInteractionInterface,
  ): Promise<WalletOperationPresentation> {
    this.#assertOpen();
    this.#convergePublicState();
    const entry = this.#entry(parseWalletOperationId(operationId));
    const access = interactionInterface === entry.interactionInterface
      ? "interactive"
      : interactionInterface === "web" && entry.interactionInterface === "cli"
        ? "read_only"
        : undefined;
    if (access === undefined) throw new WalletOperationError("state_conflict");
    return Promise.resolve(parseWalletOperationPresentation({
      operation: this.#operationValue(entry),
      access,
      ...(entry.state === "awaiting_wallet_approval" && entry.qr !== undefined
        ? { qr: entry.qr }
        : {}),
    }));
  }

  #readCurrentProjection(): Promise<WalletCurrentOperationProjection> {
    this.#assertOpen();
    this.#convergePublicState();
    const record = this.#authority.record;
    const active = this.#activeOperationId === undefined
      ? undefined
      : this.#operations.get(this.#activeOperationId);
    if (active === undefined || isWalletOperationTerminalState(active.state)) {
      return Promise.resolve(parseWalletCurrentOperationProjection({
        status: "absent",
        connectionRevision: record.revision,
        connection: record.connection,
      }));
    }
    const access = active.interactionInterface === "web" ? "interactive" : "read_only";
    return Promise.resolve(parseWalletCurrentOperationProjection({
      status: "present",
      connectionRevision: record.revision,
      connection: record.connection,
      presentation: {
        operation: this.#operationValue(active),
        access,
        ...(active.state === "awaiting_wallet_approval" && active.qr !== undefined
          ? { qr: active.qr }
          : {}),
      },
    }));
  }

  #operationValue(entry: OperationEntry): WalletManagementOperation {
    return parseWalletManagementOperation({
      operationId: entry.operationId,
      kind: entry.kind,
      state: entry.state,
      connectionRevision: entry.connectionRevision,
      actionExpiresAt: entry.actionExpiresAt,
      interactionInterface: entry.interactionInterface,
      result: entry.result,
      failure: entry.failure,
      peerRefusalCode: entry.peerRefusalCode,
    });
  }

  #startResult(entry: OperationEntry): WalletOperationStartResult {
    return parseWalletOperationStartResult({
      status: "operation_started",
      operation: this.#operationValue(entry),
    });
  }

  #entry(operationId: string): OperationEntry {
    const entry = this.#operations.get(operationId);
    if (entry === undefined) throw new WalletOperationError("state_conflict");
    return entry;
  }

  #setState(entry: OperationEntry, state: WalletOperationState): void {
    if (isWalletOperationTerminalState(entry.state)) return;
    entry.state = state;
    entry.result = null;
    entry.failure = null;
    entry.peerRefusalCode = null;
  }

  #complete(entry: OperationEntry, result: WalletOperationResult): void {
    if (isWalletOperationTerminalState(entry.state)) return;
    entry.state = "completed";
    entry.result = result;
    entry.failure = null;
    entry.peerRefusalCode = null;
    this.#finishTerminal(entry);
  }

  #reject(entry: OperationEntry, code: WalletPeerRefusalCode): void {
    if (isWalletOperationTerminalState(entry.state)) return;
    entry.state = "rejected";
    entry.result = null;
    entry.failure = null;
    entry.peerRefusalCode = code;
    this.#finishTerminal(entry);
  }

  #fail(entry: OperationEntry, code: WalletOperationFailureCode): void {
    if (isWalletOperationTerminalState(entry.state)) return;
    entry.state = "failed";
    entry.result = null;
    entry.failure = operationFailureFor(code);
    entry.peerRefusalCode = null;
    this.#finishTerminal(entry);
  }

  #failIfNonterminal(entry: OperationEntry, code: WalletOperationFailureCode): void {
    if (!isWalletOperationTerminalState(entry.state)) this.#fail(entry, code);
  }

  #terminal(entry: OperationEntry, state: "cancelled" | "expired"): void {
    if (isWalletOperationTerminalState(entry.state)) return;
    entry.state = state;
    entry.result = null;
    entry.failure = null;
    entry.peerRefusalCode = null;
    this.#finishTerminal(entry);
  }

  #finishTerminal(entry: OperationEntry): void {
    entry.qr = undefined;
    entry.terminalExpiresAt = addMilliseconds(this.#now(), terminalRetentionMilliseconds);
    if (this.#activeOperationId === entry.operationId) this.#activeOperationId = undefined;
    this.#scheduleConvergence();
  }

  #convergeOperations(now: UtcTimestamp = this.#now()): void {
    const current = Date.parse(now);
    for (const entry of this.#operations.values()) {
      if (
        isWalletOperationTerminalState(entry.state) &&
        entry.terminalExpiresAt !== undefined &&
        Date.parse(entry.terminalExpiresAt) <= current &&
        this.#effect?.operationId !== entry.operationId
      ) {
        this.#operations.delete(entry.operationId);
        continue;
      }
      if (
        isWalletOperationTerminalState(entry.state) ||
        Date.parse(entry.actionExpiresAt) > current
      ) continue;
      if (entry.state === "awaiting_confirmation") {
        this.#terminal(entry, "expired");
        continue;
      }
      if (entry.terminationIntent !== undefined) continue;
      entry.terminationIntent = "expired";
      if (entry.kind === "connect") {
        entry.qr = undefined;
        this.#setState(entry, "cancelling");
        try { this.#closeAuthority("reconciling", true); }
        catch { /* The in-memory authority was closed before the durable attempt. */ }
        entry.cancellation.request();
      }
    }
    this.#scheduleConvergence();
  }

  #scheduleConvergence(): void {
    if (this.#operationWake !== undefined) clearTimeout(this.#operationWake);
    this.#operationWake = undefined;
    if (this.#closing || this.#closed) return;
    const now = Date.parse(this.#now());
    let next: number | undefined;
    for (const entry of this.#operations.values()) {
      if (
        isWalletOperationTerminalState(entry.state) &&
        this.#effect?.operationId === entry.operationId
      ) continue;
      const candidate = isWalletOperationTerminalState(entry.state)
        ? entry.terminalExpiresAt
        : entry.terminationIntent === undefined
          ? entry.actionExpiresAt
          : undefined;
      if (candidate === undefined) continue;
      const timestamp = Date.parse(candidate);
      if (next === undefined || timestamp < next) next = timestamp;
    }
    if (next === undefined) return;
    const wake = setTimeout(() => {
      if (this.#operationWake === wake) this.#operationWake = undefined;
      try { this.#convergeOperations(); }
      catch { /* Exact operation state remains available to the next public convergence. */ }
    }, Math.max(0, next - now));
    unrefTimer(wake);
    this.#operationWake = wake;
  }

  #evaluateSession(
    session: WalletConnectSessionSnapshot,
    evaluatedAt: UtcTimestamp,
  ): EvaluatedSession {
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
    if (account.chainId !== this.#requirements.chain.chainId) {
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
      !this.#requirements.requiredMethods.every((method) => methods.includes(method))
    ) return Object.freeze({ status: "invalid", reason: "methods", source: session.source });
    let admittedEvents: readonly string[];
    try { admittedEvents = namespace.events.map((event) => fixedIdentifierSchema.parse(event)); }
    catch { return Object.freeze({ status: "invalid", reason: "events", source: session.source }); }
    const events = orderedUnique(admittedEvents);
    if (
      events === undefined ||
      !this.#requirements.requiredEvents.every((event) => events.includes(event))
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
  }

  #evaluateObservation(
    observation: WalletConnectStableObservation,
    emptyReason: "no_session" | "expired" | "disconnected",
    revalidationRequired: boolean,
  ): EvaluatedObservation {
    const now = this.#now();
    const sessions = Object.freeze(observation.sessions.map((session) => this.#evaluateSession(session, now)));
    let connection: WalletConnectionData;
    let sessionSource: WalletSessionSource | undefined;
    if (observation.proposalCount !== 0 && sessions.length === 0) {
      connection = unknownConnection("reconciling");
    } else if (sessions.length === 0) {
      connection = disconnectedConnection(emptyReason);
    } else if (
      observation.proposalCount !== 0 || sessions.length !== 1 ||
      sessions[0]?.status !== "valid" || revalidationRequired
    ) {
      connection = parseCapabilityDataAt(walletConnectionCapability, {
        status: "unresolved",
        sessionCount: String(sessions.length),
      }, now);
    } else {
      connection = sessions[0].connection;
      sessionSource = sessions[0].source;
    }
    return Object.freeze({
      observation,
      sessions,
      connection,
      ...(sessionSource === undefined ? {} : { sessionSource }),
    });
  }

  #readStableObservation(): StableRead {
    try {
      return Object.freeze({
        status: "available" as const,
        observation: this.#client.observe(),
      });
    } catch {
      try { this.#closeAuthority("observation_unavailable", false); }
      catch { /* The in-memory authority was closed before the durable attempt. */ }
      return Object.freeze({ status: "unavailable" as const });
    }
  }

  #convergeObservation(
    observation: WalletConnectStableObservation,
    emptyReason: "no_session" | "expired" | "disconnected",
    allowExpiryCleanup = true,
  ): EvaluatedObservation {
    if (this.#closing || this.#closed) {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    const authority = this.#authority;
    const previousAttribution = authority.sessionAttribution;
    if (
      allowExpiryCleanup && this.#effect === undefined &&
      authority.record.connection.status === "connected" &&
      previousAttribution !== undefined &&
      Date.parse(previousAttribution.connection.expiresAt) <= Date.parse(this.#now()) &&
      observation.sessions.some((session) =>
        session.source.sourceId === previousAttribution.source.sourceId)
    ) {
      const evaluated = this.#evaluateObservation(
        observation,
        emptyReason,
        authority.pendingRevalidation || authority.record.revalidationRequired,
      );
      this.#startExpiryCleanup(previousAttribution.source);
      return evaluated;
    }

    const completeEmpty = observation.proposalCount === 0 && observation.sessions.length === 0;
    const admittedEmptyReason = completeEmpty && authority.record.connection.status === "disconnected"
      ? authority.record.connection.reason
      : emptyReason;
    const revalidationRequired = completeEmpty
      ? false
      : authority.pendingRevalidation || authority.record.revalidationRequired;
    const evaluated = this.#evaluateObservation(
      observation,
      admittedEmptyReason,
      revalidationRequired,
    );
    const sessionAttribution = evaluated.connection.status === "connected" &&
        evaluated.sessionSource !== undefined
      ? Object.freeze({
          source: evaluated.sessionSource,
          connection: evaluated.connection,
        })
      : previousAttribution !== undefined && evaluated.sessions.some((session) =>
        session.source.sourceId === previousAttribution.source.sourceId)
        ? previousAttribution
        : undefined;
    this.#commitAuthority(
      evaluated.connection,
      revalidationRequired,
      sessionAttribution,
    );
    this.#reconcilePending = false;
    return evaluated;
  }

  #commitAuthority(
    connection: WalletConnectionData,
    revalidationRequired: boolean,
    sessionAttribution: SessionAttribution | undefined,
  ): WalletConnectionRecord {
    if (this.#closing || this.#closed) {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    if (connection.status === "connected" && revalidationRequired) {
      throw new TypeError("A connected wallet cannot require revalidation.");
    }
    if (
      connection.status === "connected" &&
      (sessionAttribution === undefined ||
        !sameConnection(connection, sessionAttribution.connection))
    ) {
      throw new TypeError("A connected wallet and its exact session attribution must be admitted together.");
    }
    const previous = this.#authority;
    const previousAttribution = previous.sessionAttribution;
    let current: WalletConnectionRecord;
    try { current = this.#wallet.projection.read(); }
    catch (error) {
      this.#latchProjectionFailure(previous.record);
      throw error;
    }
    const sourceChanged = sessionAttribution?.source.sourceId !==
      previousAttribution?.source.sourceId;
    if (
      !sourceChanged &&
      sameConnection(current.connection, connection) &&
      current.revalidationRequired === revalidationRequired
    ) {
      this.#authority = Object.freeze({
        status: "available",
        record: current,
        ...(sessionAttribution === undefined ? {} : { sessionAttribution }),
        pendingRevalidation: false,
      });
      return current;
    }
    try {
      const record = this.#wallet.projection.replace(
        current.revision,
        connection,
        revalidationRequired,
        this.#now(),
      );
      this.#authority = Object.freeze({
        status: "available",
        record,
        ...(sessionAttribution === undefined ? {} : { sessionAttribution }),
        pendingRevalidation: false,
      });
      return record;
    } catch (error) {
      try {
        const after = this.#wallet.projection.read();
        if (
          after.revision !== current.revision &&
          sameConnection(after.connection, connection) &&
          after.revalidationRequired === revalidationRequired
        ) {
          this.#authority = Object.freeze({
            status: "available",
            record: after,
            ...(sessionAttribution === undefined ? {} : { sessionAttribution }),
            pendingRevalidation: false,
          });
          return after;
        }
        this.#latchProjectionFailure(after);
      } catch { this.#latchProjectionFailure(current); }
      throw error;
    }
  }

  #closeAuthority(
    reason: "reconciling" | "observation_unavailable",
    requireRevalidation: boolean,
  ): void {
    const previous = this.#authority;
    const pendingRevalidation = previous.pendingRevalidation || requireRevalidation;
    this.#authority = Object.freeze({
      status: "closed",
      record: previous.record,
      reason,
      ...(previous.sessionAttribution === undefined
        ? {}
        : { sessionAttribution: previous.sessionAttribution }),
      pendingRevalidation,
    });
    if (this.#closing || this.#closed) return;
    try {
      const current = this.#wallet.projection.read();
      const targetRevalidation = current.revalidationRequired || pendingRevalidation;
      const connection = unknownConnection(reason);
      const record = sameConnection(current.connection, connection) &&
          current.revalidationRequired === targetRevalidation
        ? current
        : this.#wallet.projection.replace(
          current.revision,
          connection,
          targetRevalidation,
          this.#now(),
        );
      this.#authority = Object.freeze({
        status: "closed",
        record,
        reason,
        ...(previous.sessionAttribution === undefined
          ? {}
          : { sessionAttribution: previous.sessionAttribution }),
        pendingRevalidation: pendingRevalidation && !record.revalidationRequired,
      });
    } catch (error) {
      this.#latchProjectionFailure(previous.record);
      throw error;
    }
  }

  #latchProjectionFailure(fallback: WalletConnectionRecord): void {
    const attribution = this.#authority.sessionAttribution;
    this.#authority = Object.freeze({
      status: "closed",
      record: fallback,
      reason: "observation_unavailable",
      ...(attribution === undefined ? {} : { sessionAttribution: attribution }),
      pendingRevalidation: true,
    });
    if (this.#closing || this.#closed) return;
    try {
      const current = this.#wallet.projection.read();
      const connection = unknownConnection("observation_unavailable");
      const record = sameConnection(current.connection, connection) && current.revalidationRequired
        ? current
        : this.#wallet.projection.replace(
          current.revision,
          connection,
          true,
          this.#now(),
        );
      this.#authority = Object.freeze({
        status: "closed",
        record,
        reason: "observation_unavailable",
        ...(attribution === undefined ? {} : { sessionAttribution: attribution }),
        pendingRevalidation: !record.revalidationRequired,
      });
    } catch {
      this.#authority = Object.freeze({
        status: "closed",
        record: this.#authority.record,
        reason: "observation_unavailable",
        ...(attribution === undefined ? {} : { sessionAttribution: attribution }),
        pendingRevalidation: true,
      });
    }
  }

  #refreshAfterEffect(): EvaluatedObservation | undefined {
    const stable = this.#readStableObservation();
    if (stable.status === "unavailable") return undefined;
    try { return this.#convergeObservation(stable.observation, "no_session"); }
    catch { return undefined; }
  }

  #isCompleteEmpty(evaluated: EvaluatedObservation): boolean {
    return evaluated.observation.proposalCount === 0 &&
      evaluated.sessions.length === 0 &&
      this.#authority.status === "available" &&
      this.#authority.record.connection.status === "disconnected" &&
      !this.#authority.record.revalidationRequired;
  }

  #captureActiveWallet(): ActiveWalletReadSnapshot {
    this.#convergePublicState();
    const authority = this.#authority;
    if (authority.status === "closed") {
      return Object.freeze({
        connection: unknownConnection(authority.reason),
        connectionRevision: authority.record.revision,
      });
    }
    return Object.freeze({
      connection: authority.record.connection,
      connectionRevision: authority.record.revision,
      ...(authority.record.connection.status !== "connected" ||
        authority.sessionAttribution === undefined
        ? {}
        : { sessionSource: authority.sessionAttribution.source }),
    });
  }

  #convergePublicState(): void {
    this.#convergeOperations();
    if (this.#effect !== undefined) return;
    const connection = this.#authority.record.connection;
    const connectionExpired = this.#authority.status === "available" &&
      connection.status === "connected" &&
      Date.parse(connection.expiresAt) <= Date.parse(this.#now());
    if (!this.#reconcilePending && this.#authority.status === "available" && !connectionExpired) {
      return;
    }
    this.#reconcilePending = false;
    const stable = this.#readStableObservation();
    if (stable.status === "available") {
      this.#convergeObservation(stable.observation, "no_session");
    }
  }

  #startExpiryCleanup(source: WalletSessionSource): void {
    if (this.#effect !== undefined) return;
    this.#closeAuthority("reconciling", false);
    this.#launchEffect(undefined, async () => {
      let effectError: unknown;
      try { await this.#client.disconnectSession(source.sourceId); }
      catch (error) { effectError = error; }
      const stable = this.#readStableObservation();
      if (stable.status === "unavailable") return;
      const evaluated = this.#convergeObservation(stable.observation, "expired");
      if (!this.#isCompleteEmpty(evaluated) && effectError !== undefined) {
        try { this.#closeAuthority("observation_unavailable", true); }
        catch { /* The in-memory revalidation latch remains closed. */ }
      }
    });
  }

  #onClientEvent(event: WalletConnectClientEvent): void {
    if (this.#closed || this.#closing) return;
    try {
      if (event.kind === "observation_changed") {
        this.#scheduleReconcile();
        return;
      }
      if (event.kind === "identity_unattributed") {
        this.#closeAuthority("reconciling", false);
        this.#scheduleReconcile();
        return;
      }
      const authority = this.#authority;
      const attribution = authority.sessionAttribution;
      if (
        attribution === undefined || event.sessionSourceId !== attribution.source.sourceId
      ) return;
      const connection = attribution.connection;
      let contradiction = event.kind === "identity_invalid";
      if (event.kind === "chain_changed") {
        contradiction = event.chainId !== connection.chainId;
      } else if (event.kind === "accounts_changed") {
        contradiction = event.chainId !== connection.chainId ||
          event.accounts.length !== 1 ||
          event.accounts[0] !== deriveCaip10Account({
            chainId: connection.chainId,
            address: connection.address,
          });
      }
      if (contradiction) this.#closeAuthority("reconciling", true);
      this.#scheduleReconcile();
    } catch {
      try { this.#closeAuthority("observation_unavailable", true); }
      catch { /* The in-memory authority remains closed. */ }
    }
  }

  #scheduleReconcile(): void {
    this.#reconcilePending = true;
    if (this.#reconcileScheduled || this.#closing) return;
    this.#reconcileScheduled = true;
    queueMicrotask(() => {
      this.#reconcileScheduled = false;
      if (this.#closing || !this.#reconcilePending) return;
      if (this.#effect !== undefined) return;
      this.#reconcilePending = false;
      const stable = this.#readStableObservation();
      if (stable.status === "available") {
        try { this.#convergeObservation(stable.observation, "no_session"); }
        catch { /* The authority owner already closed the failed projection. */ }
      }
    });
  }

  #launchEffect(
    operationId: string | undefined,
    run: () => Promise<void>,
  ): void {
    if (this.#effect !== undefined) throw new WalletOperationError("state_conflict");
    let effect!: ActiveEffect;
    const work = Promise.resolve().then(run).catch((error: unknown) => {
      if (this.#closing || this.#closed) return;
      try { this.#closeAuthority("observation_unavailable", true); }
      catch { /* The in-memory authority remains closed. */ }
      if (operationId !== undefined) {
        const entry = this.#operations.get(operationId);
        if (entry !== undefined) this.#failIfNonterminal(entry, failureCodeFor(error));
      }
      this.#reconcilePending = true;
    }).finally(() => {
      if (this.#effect === effect) this.#effect = undefined;
      if (this.#closing || this.#closed) return;
      if (this.#reconcilePending) this.#scheduleReconcile();
      this.#scheduleConvergence();
    });
    effect = {
      ...(operationId === undefined ? {} : { operationId }),
      work,
    };
    this.#effect = effect;
    this.#scheduleConvergence();
  }

  #assertOpen(): void {
    if (this.#closing || this.#closed) throw new WalletOperationError("runtime_state_unavailable");
  }

  #now(): UtcTimestamp {
    return this.#wallet.capabilityAuthority.clock.now();
  }

  async #performClose(): Promise<void> {
    if (this.#operationWake !== undefined) {
      clearTimeout(this.#operationWake);
      this.#operationWake = undefined;
    }
    const active = this.#activeOperationId === undefined
      ? undefined
      : this.#operations.get(this.#activeOperationId);
    if (active !== undefined && !isWalletOperationTerminalState(active.state)) {
      if (active.state === "awaiting_confirmation") {
        this.#terminal(active, "cancelled");
      } else if (active.kind === "connect") {
        active.terminationIntent ??= "cancelled";
        active.qr = undefined;
        this.#setState(active, "cancelling");
        active.cancellation.request();
      }
    }
    const previous = this.#authority;
    this.#authority = Object.freeze({
      status: "closed",
      record: previous.record,
      reason: "reconciling",
      ...(previous.sessionAttribution === undefined
        ? {}
        : { sessionAttribution: previous.sessionAttribution }),
      pendingRevalidation: previous.pendingRevalidation,
    });
    if (this.#effect !== undefined) {
      try { await withDeadline(this.#effect.work, effectSettlementMilliseconds); }
      catch { /* Operating-system teardown contains external work that cannot be drained. */ }
    }
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.#client.contain();
  }
}

export const createWalletCoordinator = (input: {
  readonly client: WalletConnectClientPort;
  readonly wallet: WalletOwnerBootstrapPort;
}): Promise<WalletCoordinator> => WalletCoordinator.create(input);
