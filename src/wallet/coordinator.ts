import { randomBytes } from "node:crypto";

import {
  addUtcMilliseconds,
  bindCapability,
  canonicalJsonStringify,
  compareCodePointSequences,
  deriveCaip10Account,
  fixedIdentifierSchema,
  operationIdFromBytes,
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
  parseWalletDirectAction,
  parseWalletManagementOperation,
  parseWalletOperationCancellation,
  parseWalletOperationId,
  parseWalletOperationPresentation,
  parseWalletReview,
  walletManagementContracts,
  walletReviewDigest,
  walletReviewActionLifetimeMilliseconds,
  type WalletDirectAction,
  type WalletManagementOperation,
  type WalletNonterminalManagementOperation,
  type WalletOperationCancellation,
  type WalletOperationFailure,
  type WalletOperationFailureCode,
  type WalletOperationPresentation,
  type WalletOperationResult,
  type WalletPeerRefusalCode,
  type WalletReview,
  type WalletReviewRequest,
  type WalletReviewResult,
  type WalletManagementPort,
} from "./contracts.js";
import {
  isWalletOperationTerminalState,
  isWalletOperationCancellableState,
  type WalletInitiator,
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

const effectSettlementMilliseconds = 5 * 60 * 1_000;
// Node timer delay representation, not an operation deadline.
const maximumTimerDelayMilliseconds = 2_147_483_647;

const unknownConnection = (
  reason: "reconciling" | "observation_unavailable",
): WalletConnectionData => Object.freeze({ status: "unknown", reason });

const disconnectedConnection = (
  reason: "no_session" | "expired" | "disconnected",
): WalletConnectionData => Object.freeze({ status: "disconnected", reason });

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
  readonly initiatedBy: WalletInitiator;
  readonly review: WalletReview;
  readonly connectionRevision: UnsignedDecimal;
  readonly actionExpiresAt: UtcTimestamp;
  state: WalletOperationState;
  result: WalletOperationResult | null;
  failure: WalletOperationFailure | null;
  peerRefusalCode: WalletPeerRefusalCode | null;
  qr?: WalletOperationPresentation["qr"];
  terminationIntent?: "cancelled" | "expired";
  readonly cancellation: CancellationSignal;
}

interface ActiveEffect {
  readonly operationId?: string;
  readonly work: Promise<void>;
}

type ConnectReconciliationHint =
  | Readonly<{ kind: "approved" }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "rejected"; peerRefusalCode: WalletPeerRefusalCode }>
  | Readonly<{ kind: "failed"; failureCode: WalletOperationFailureCode }>;

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

export interface WalletCoordinatorPort extends WalletManagementPort {
  readonly walletConnection: WalletConnectionReadCapabilityPort;
  readonly activeWallet: ActiveWalletReadPort;
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

  readonly #client: WalletConnectClientPort;
  readonly #wallet: WalletOwnerBootstrapPort;
  readonly #requirements: WalletConnectSessionRequirements;
  readonly #operations = new Map<string, OperationEntry>();
  readonly #persistenceBlockedOperations = new Set<string>();
  #authority: WalletAuthority;
  #effect: ActiveEffect | undefined;
  #operationWake: ReturnType<typeof setTimeout> | undefined;
  #expiryCleanupSourceId: string | undefined;
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

    this.activeWallet = Object.freeze({ capture: () => this.#captureActiveWallet().snapshot });

    const binding: CapabilityBinding<typeof walletConnectionCapability> = bindCapability({
      definition: walletConnectionCapability,
      errorRegistry: walletErrorRegistry,
      invocationAuthority: wallet.capabilityAuthority.invocationAuthority,
      createInvocationPorts: (): WalletConnectionInvocationPorts => {
        const captured = this.#captureActiveWallet();
        const walletSnapshot = captured.snapshot;
        return Object.freeze({
          ...wallet.capabilityAuthority.createInvocationPorts(walletSnapshot.sessionSource),
          walletSnapshot,
          evidenceAvailable: captured.evidenceAvailable,
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
    await coordinator.#reconcileDurableOperation();
    return coordinator;
  }

  async review(input: WalletReviewRequest): Promise<WalletReviewResult> {
    this.#assertOpen();
    const request = walletManagementContracts.review.parseInput(input);
    const captured = this.#captureActiveWallet();
    if (!captured.evidenceAvailable) throw new WalletOperationError("runtime_state_unavailable");
    if (
      this.#authority.status !== "available" || this.#effect !== undefined ||
      this.#reconcilePending
    ) {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    const record = this.#authority.record;
    if (request.kind === "connect") {
      if (record.connection.status === "connected") {
        return walletManagementContracts.review.parsePublicSuccess(request, {
          status: "current_connection",
          connectionRevision: record.revision,
          connection: record.connection,
        });
      }
      if (
        record.connection.status !== "disconnected" ||
        this.#authority.sessionAttribution !== undefined
      ) {
        throw new WalletOperationError("wallet_session_unusable");
      }
    } else {
      if (record.connection.status === "disconnected") {
        return walletManagementContracts.review.parsePublicSuccess(request, {
          status: "already_disconnected",
          connectionRevision: record.revision,
          connection: record.connection,
        });
      }
      if (
        record.connection.status !== "connected" ||
        this.#authority.sessionAttribution === undefined
      ) throw new WalletOperationError("wallet_session_unusable");
    }
    const createdAt = this.#now();
    const withoutDigest = request.kind === "connect"
      ? {
          contractVersion: "1" as const,
          domain: "wallet" as const,
          kind: "connect" as const,
          operationId: operationIdFromBytes(randomBytes(32)),
          createdAt,
          actionExpiresAt: addUtcMilliseconds(createdAt, walletReviewActionLifetimeMilliseconds),
          target: { chainId: this.#requirements.chain.chainId },
          decision: {
            requiredMethods: this.#requirements.requiredMethods,
            requiredEvents: this.#requirements.requiredEvents,
          },
          precondition: {
            connectionRevision: record.revision,
            connection: record.connection,
          },
          fixedEvidence: { sessionSourceIds: [] as const },
        }
      : {
          contractVersion: "1" as const,
          domain: "wallet" as const,
          kind: "disconnect" as const,
          operationId: operationIdFromBytes(randomBytes(32)),
          createdAt,
          actionExpiresAt: addUtcMilliseconds(createdAt, walletReviewActionLifetimeMilliseconds),
          target: { chainId: this.#requirements.chain.chainId },
          decision: { action: "disconnect_session" as const },
          precondition: {
            connectionRevision: record.revision,
            connection: record.connection,
          },
          fixedEvidence: {
            sessionSourceIds: [this.#authority.sessionAttribution!.source.sourceId] as const,
          },
        };
    const review = parseWalletReview({
      ...withoutDigest,
      reviewDigest: walletReviewDigest(withoutDigest),
    });
    return walletManagementContracts.review.parsePublicSuccess(request, { status: "review", review });
  }

  async decide(input: WalletDirectAction): Promise<WalletManagementOperation> {
    return this.#decide(parseWalletDirectAction(input));
  }

  async get(operationId: string): Promise<WalletManagementOperation> {
    return this.#readExactOperation(operationId);
  }

  async cancel(input: WalletOperationCancellation): Promise<WalletManagementOperation> {
    return this.#cancel(parseWalletOperationCancellation(input));
  }

  async getPresentation(operationId: string): Promise<WalletOperationPresentation> {
    const operation = this.#readExactOperation(operationId);
    const entry = this.#operations.get(operation.operationId);
    return parseWalletOperationPresentation({
      operation,
      ...(operation.state === "awaiting_wallet_approval" && entry?.qr !== undefined
        ? { qr: entry.qr }
        : {}),
    });
  }

  #readExactOperation(operationId: string): WalletManagementOperation {
    this.#assertOpen();
    const id = parseWalletOperationId(operationId);
    let operation = this.#wallet.operations.read(id);
    if (operation === null) throw new WalletOperationError("wallet_operation_not_found");
    if (!isWalletOperationTerminalState(operation.state)) {
      this.#convergeOperations();
      operation = this.#wallet.operations.read(id);
      if (operation === null) throw new WalletOperationError("wallet_operation_not_found");
    }
    return operation;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closeWork !== undefined) return this.#closeWork;
    this.#closing = true;
    let resolveClose!: () => void;
    let rejectClose!: (reason: unknown) => void;
    const closeWork = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.#closeWork = closeWork;
    void this.#performClose().then(
      () => {
        this.#closed = true;
        this.#operations.clear();
        if (this.#closeWork === closeWork) this.#closeWork = undefined;
        resolveClose();
      },
      (error: unknown) => {
        if (this.#closeWork === closeWork) this.#closeWork = undefined;
        rejectClose(error);
      },
    );
    return closeWork;
  }

  async #decide(input: WalletDirectAction): Promise<WalletManagementOperation> {
    this.#assertOpen();
    const review = parseWalletReview(input.review);
    const existing = this.#wallet.operations.read(review.operationId);
    if (existing !== null) {
      if (
        existing.kind !== review.kind ||
        existing.review.reviewDigest !== review.reviewDigest ||
        canonicalJsonStringify(existing.review as unknown as CanonicalJson) !==
          canonicalJsonStringify(review as unknown as CanonicalJson)
      ) throw new WalletOperationError("state_conflict");
      return review.kind === "connect"
        ? walletManagementContracts.connect.parsePublicSuccess(input, existing)
        : walletManagementContracts.disconnect.parsePublicSuccess(input, existing);
    }
    if (Date.parse(review.actionExpiresAt) <= Date.parse(this.#now())) {
      throw new WalletOperationError("wallet_operation_expired");
    }
    if (this.#wallet.operations.readActive() !== null || this.#effect !== undefined) {
      throw new WalletOperationError("state_conflict");
    }

    this.#convergePublicState();

    const stable = this.#readStableObservation();
    if (stable.status === "unavailable") {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    const evaluated = this.#convergeObservation(stable.observation, "no_session");
    if (this.#authority.status !== "available" || this.#effect !== undefined) {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    const record = this.#authority.record;
    if (
      review.precondition.connectionRevision !== record.revision ||
      !sameConnection(review.precondition.connection, record.connection)
    ) {
      throw new WalletOperationError("state_conflict");
    }

    if (review.kind === "connect") {
      if (
        record.connection.status !== "disconnected" ||
        evaluated.observation.proposalCount !== 0 || evaluated.sessions.length !== 0 ||
        review.target.chainId !== this.#requirements.chain.chainId ||
        canonicalJsonStringify(review.decision as unknown as CanonicalJson) !==
          canonicalJsonStringify({
            requiredMethods: this.#requirements.requiredMethods,
            requiredEvents: this.#requirements.requiredEvents,
          } as unknown as CanonicalJson)
      ) throw new WalletOperationError("state_conflict");
    } else {
      const attribution = this.#authority.sessionAttribution;
      if (
        record.connection.status !== "connected" || attribution === undefined ||
        evaluated.sessions.length !== 1 ||
        review.fixedEvidence.sessionSourceIds[0] !== attribution.source.sourceId
      ) throw new WalletOperationError("state_conflict");
    }

    const entry = this.#prepareOperation(input);
    this.#publishOperation(entry);
    if (entry.kind === "connect") {
      this.#launchEffect(entry.operationId, () => this.#startConnectionEffect(entry));
    } else {
      this.#launchEffect(entry.operationId, () => this.#disconnectEffect(
        entry,
        (entry.review as Extract<WalletReview, { kind: "disconnect" }>).fixedEvidence.sessionSourceIds,
      ));
    }
    const operation = this.#operationValue(entry);
    return review.kind === "connect"
      ? walletManagementContracts.connect.parsePublicSuccess(input, operation)
      : walletManagementContracts.disconnect.parsePublicSuccess(input, operation);
  }

  #prepareOperation(input: WalletDirectAction): OperationEntry {
    const review = input.review;
    return {
      operationId: parseWalletOperationId(review.operationId),
      kind: review.kind,
      initiatedBy: input.initiatedBy,
      review,
      connectionRevision: review.precondition.connectionRevision,
      actionExpiresAt: review.actionExpiresAt,
      state: review.kind === "connect" ? "starting_connection" : "disconnecting",
      result: null,
      failure: null,
      peerRefusalCode: null,
      cancellation: createCancellationSignal(),
    };
  }

  #publishOperation(entry: OperationEntry): void {
    const operation = this.#wallet.operations.create(
      this.#operationValue(entry) as WalletNonterminalManagementOperation,
    );
    this.#syncEntry(entry, operation);
    this.#operations.set(entry.operationId, entry);
    this.#scheduleConvergence();
  }

  async #cancel(
    input: WalletOperationCancellation,
  ): Promise<WalletManagementOperation> {
    this.#assertOpen();
    const cancellation = parseWalletOperationCancellation(input);
    this.#convergeOperations();
    const entry = this.#entry(cancellation.operationId);
    if (this.#persistenceBlockedOperations.has(entry.operationId)) {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    if (
      cancellation.connectionRevision !== entry.connectionRevision ||
      cancellation.reviewDigest !== entry.review.reviewDigest
    ) throw new WalletOperationError("state_conflict");
    if (entry.state === "cancelled") return this.#operationValue(entry);
    if (entry.kind === "connect" && entry.state === "cancelling") {
      return this.#operationValue(entry);
    }
    if (
      entry.kind !== "connect" ||
      entry.state !== cancellation.expectedState ||
      !isWalletOperationCancellableState(entry.state) ||
      this.#effect?.operationId !== entry.operationId
    ) {
      throw new WalletOperationError("state_conflict");
    }
    this.#setState(entry, "cancelling", "cancelled");
    entry.qr = undefined;
    try { this.#closeAuthority("reconciling", true); }
    catch { /* Cancellation still proceeds under the already-closed in-memory authority. */ }
    entry.cancellation.request();
    return this.#operationValue(entry);
  }

  async #startConnectionEffect(entry: OperationEntry): Promise<void> {
    try { this.#closeAuthority("reconciling", false); }
    catch {
      this.#commitPostEffect(entry, () => this.#fail(entry, "runtime_state_unavailable"));
      return;
    }
    let attempt: WalletConnectConnectionAttemptPort;
    try {
      attempt = await withDeadline(
        this.#client.startConnection(),
        Math.max(1, Date.parse(entry.actionExpiresAt) - Date.parse(this.#now())),
      );
    }
    catch (error) {
      const code = isWalletConnectClientError(error) && error.code === "qr_encoding"
        ? "wallet_pairing_code_unavailable"
        : failureCodeFor(error);
      await this.#reconcileConnectEffect(entry, { kind: "failed", failureCode: code });
      return;
    }
    this.#convergeOperations();
    let outcome: WalletConnectAttemptOutcome;
    try {
      if (entry.terminationIntent !== undefined || isWalletOperationTerminalState(entry.state)) {
        outcome = await withDeadline(attempt.cancel(), effectSettlementMilliseconds);
      } else {
        this.#setState(entry, "awaiting_wallet_approval");
        entry.qr = attempt.qr;
        const selected = await Promise.race([
          attempt.wait().then((value) => Object.freeze({ kind: "outcome" as const, value })),
          entry.cancellation.promise.then(() => Object.freeze({ kind: "cancel" as const })),
        ]);
        outcome = selected.kind === "cancel" || entry.terminationIntent !== undefined
          ? await withDeadline(attempt.cancel(), effectSettlementMilliseconds)
          : selected.value;
      }
    } catch (error) {
      await this.#reconcileConnectEffect(entry, {
        kind: "failed",
        failureCode: failureCodeFor(error),
      });
      return;
    }
    this.#convergeOperations();
    entry.qr = undefined;
    if (
      outcome.status === "approved" && entry.terminationIntent === undefined &&
      !isWalletOperationTerminalState(entry.state)
    ) {
      try { this.#setState(entry, "validating_session"); }
      catch {
        await this.#reconcileConnectEffect(entry, {
          kind: "failed",
          failureCode: "runtime_state_unavailable",
        });
        return;
      }
    }
    const hint: ConnectReconciliationHint = outcome.status === "approved"
      ? { kind: "approved" }
      : outcome.status === "rejected"
        ? { kind: "rejected", peerRefusalCode: outcome.peerRefusalCode }
        : outcome.status === "cancelled"
          ? { kind: "cancelled" }
          : { kind: "failed", failureCode: "walletconnect_unavailable" };
    await this.#reconcileConnectEffect(entry, hint);
  }

  #reviewedConnectSession(
    entry: OperationEntry,
    evaluated: EvaluatedObservation,
  ): ValidSession | undefined {
    if (entry.review.kind !== "connect" || evaluated.observation.proposalCount !== 0 ||
      evaluated.sessions.length !== 1) return undefined;
    const session = evaluated.sessions[0];
    if (session?.status !== "valid") return undefined;
    const reviewedDecision = entry.review.decision;
    if (
      entry.review.target.chainId !== this.#requirements.chain.chainId ||
      canonicalJsonStringify(reviewedDecision as unknown as CanonicalJson) !==
        canonicalJsonStringify({
          requiredMethods: this.#requirements.requiredMethods,
          requiredEvents: this.#requirements.requiredEvents,
        } as unknown as CanonicalJson) ||
      session.connection.chainId !== entry.review.target.chainId ||
      !reviewedDecision.requiredMethods.every((method) =>
        session.connection.approvedMethods.some((approved) => approved === method)) ||
      !reviewedDecision.requiredEvents.every((event) =>
        session.connection.approvedEvents.some((approved) => approved === event)) ||
      this.#authority.status !== "available" ||
      this.#authority.record.revalidationRequired ||
      !sameConnection(this.#authority.record.connection, session.connection)
    ) return undefined;
    return session;
  }

  #blockOperationPersistence(entry: OperationEntry): void {
    entry.qr = undefined;
    this.#persistenceBlockedOperations.add(entry.operationId);
    try { this.#closeAuthority("observation_unavailable", true); }
    catch { /* The in-memory authority remains unavailable. */ }
  }

  #commitPostEffect(entry: OperationEntry, commit: () => void): boolean {
    if (isWalletOperationTerminalState(entry.state)) return true;
    try {
      commit();
      return true;
    } catch {
      this.#blockOperationPersistence(entry);
      return false;
    }
  }

  #settleEmptyConnect(
    entry: OperationEntry,
    hint: ConnectReconciliationHint,
  ): void {
    if (entry.terminationIntent !== undefined) {
      this.#terminal(entry, entry.terminationIntent);
    } else if (hint.kind === "rejected") {
      this.#reject(entry, hint.peerRefusalCode);
    } else if (hint.kind === "cancelled") {
      this.#terminal(entry, "cancelled");
    } else {
      this.#fail(entry, hint.kind === "failed" ? hint.failureCode : "wallet_session_unusable");
    }
  }

  async #reconcileConnectEffect(
    entry: OperationEntry,
    hint: ConnectReconciliationHint,
  ): Promise<void> {
    entry.qr = undefined;
    if (isWalletOperationTerminalState(entry.state) ||
      this.#persistenceBlockedOperations.has(entry.operationId)) return;

    const initial = this.#refreshAfterEffect();
    const matching = initial === undefined ? undefined : this.#reviewedConnectSession(entry, initial);
    if (matching !== undefined && entry.terminationIntent === undefined) {
      const record = this.#authority.record;
      this.#commitPostEffect(entry, () => this.#complete(entry, {
        outcome: "connected",
        connectionRevision: record.revision,
        connection: matching.connection,
      }));
      return;
    }

    if (matching !== undefined && entry.terminationIntent !== undefined) {
      try {
        await withDeadline(
          this.#client.disconnectSession(matching.source.sourceId),
          effectSettlementMilliseconds,
        );
      } catch { /* General containment below establishes the final postcondition. */ }
    }

    let contained = true;
    try {
      await withDeadline(
        this.#client.containPendingConnectionState(),
        effectSettlementMilliseconds,
      );
    } catch { contained = false; }

    const settled = this.#refreshAfterEffect();
    if (contained && settled !== undefined) {
      const adopted = this.#reviewedConnectSession(entry, settled);
      if (adopted !== undefined && entry.terminationIntent === undefined) {
        const record = this.#authority.record;
        this.#commitPostEffect(entry, () => this.#complete(entry, {
          outcome: "connected",
          connectionRevision: record.revision,
          connection: adopted.connection,
        }));
        return;
      }
      if (this.#isCompleteEmpty(settled)) {
        this.#commitPostEffect(entry, () => this.#settleEmptyConnect(entry, hint));
        return;
      }
    }

    try { this.#closeAuthority("observation_unavailable", true); }
    catch { /* The in-memory authority remains unavailable. */ }
    this.#commitPostEffect(entry, () => this.#fail(entry, "runtime_state_unavailable"));
  }

  async #disconnectEffect(entry: OperationEntry, sourceIds: readonly string[]): Promise<void> {
    try { this.#closeAuthority("reconciling", false); }
    catch {
      this.#commitPostEffect(entry, () => this.#fail(entry, "runtime_state_unavailable"));
      return;
    }
    let effectError: unknown;
    for (const sourceId of sourceIds) {
      try {
        await withDeadline(
          this.#client.disconnectSession(sourceId),
          Math.max(1, Date.parse(entry.actionExpiresAt) - Date.parse(this.#now())),
        );
      }
      catch (error) { effectError ??= error; }
    }
    this.#convergeOperations();
    const stable = this.#readStableObservation();
    if (stable.status === "unavailable") {
      this.#commitPostEffect(entry, () => this.#fail(entry, "runtime_state_unavailable"));
      return;
    }
    let evaluated: EvaluatedObservation;
    try { evaluated = this.#convergeObservation(stable.observation, "disconnected"); }
    catch {
      this.#commitPostEffect(entry, () => this.#fail(entry, "runtime_state_unavailable"));
      return;
    }
    if (!this.#isCompleteEmpty(evaluated)) {
      this.#commitPostEffect(entry, () => this.#fail(
        entry,
        effectError === undefined ? "runtime_state_unavailable" : failureCodeFor(effectError),
      ));
      return;
    }
    if (!isWalletOperationTerminalState(entry.state)) {
      const connection = this.#authority.record.connection;
      if (connection.status !== "disconnected") {
        this.#commitPostEffect(entry, () => this.#fail(entry, "runtime_state_unavailable"));
        return;
      }
      if (entry.terminationIntent !== undefined) {
        this.#commitPostEffect(entry, () => this.#terminal(entry, entry.terminationIntent!));
      } else {
        this.#commitPostEffect(entry, () => this.#complete(entry, {
          outcome: "disconnected",
          connectionRevision: this.#authority.record.revision,
          connection,
        }));
      }
    }
  }

  #operationValue(entry: OperationEntry): WalletManagementOperation {
    return parseWalletManagementOperation({
      contractVersion: "1",
      domain: "wallet",
      operationId: entry.operationId,
      kind: entry.kind,
      initiatedBy: entry.initiatedBy,
      review: entry.review,
      state: entry.state,
      terminationTarget: entry.state === "cancelling" ? entry.terminationIntent : null,
      result: entry.result,
      failure: entry.failure,
      peerRefusalCode: entry.peerRefusalCode,
    });
  }

  #entryFromOperation(operation: WalletManagementOperation): OperationEntry {
    return {
      operationId: operation.operationId,
      kind: operation.kind,
      initiatedBy: operation.initiatedBy,
      review: operation.review,
      connectionRevision: operation.review.precondition.connectionRevision,
      actionExpiresAt: operation.review.actionExpiresAt,
      state: operation.state,
      result: operation.result,
      failure: operation.failure,
      peerRefusalCode: operation.peerRefusalCode,
      ...(operation.state === "cancelling" && operation.terminationTarget !== null
        ? { terminationIntent: operation.terminationTarget }
        : {}),
      cancellation: createCancellationSignal(),
    };
  }

  #entry(operationId: string): OperationEntry {
    const cached = this.#operations.get(operationId);
    if (cached !== undefined) return cached;
    const operation = this.#wallet.operations.read(operationId);
    if (operation === null) throw new WalletOperationError("wallet_operation_not_found");
    return this.#entryFromOperation(operation);
  }

  #syncEntry(entry: OperationEntry, operation: WalletManagementOperation): void {
    entry.state = operation.state;
    entry.result = operation.result;
    entry.failure = operation.failure;
    entry.peerRefusalCode = operation.peerRefusalCode;
    if (operation.state === "cancelling" && operation.terminationTarget !== null) {
      entry.terminationIntent = operation.terminationTarget;
    } else {
      delete entry.terminationIntent;
    }
  }

  #transition(
    entry: OperationEntry,
    state: WalletOperationState,
    input: Readonly<{
      terminationTarget?: "cancelled" | "expired";
      result?: WalletOperationResult;
      failure?: WalletOperationFailure;
      peerRefusalCode?: WalletPeerRefusalCode;
    }> = {},
  ): WalletManagementOperation {
    if (isWalletOperationTerminalState(entry.state)) return this.#operationValue(entry);
    const previousState = entry.state as WalletNonterminalManagementOperation["state"];
    const next = parseWalletManagementOperation({
      contractVersion: "1",
      domain: "wallet",
      operationId: entry.operationId,
      kind: entry.kind,
      initiatedBy: entry.initiatedBy,
      review: entry.review,
      state,
      terminationTarget: state === "cancelling" ? input.terminationTarget : null,
      result: state === "completed" ? input.result : null,
      failure: state === "failed" ? input.failure : null,
      peerRefusalCode: state === "rejected" ? input.peerRefusalCode : null,
    });
    const stored = this.#wallet.operations.transition({
      operationId: entry.operationId,
      reviewDigest: entry.review.reviewDigest,
      expectedState: previousState,
      connectionRevision: entry.connectionRevision,
      operation: next,
    });
    this.#syncEntry(entry, stored);
    if (isWalletOperationTerminalState(stored.state)) this.#finishTerminal(entry);
    return stored;
  }

  #setState(
    entry: OperationEntry,
    state: WalletOperationState,
    terminationTarget?: "cancelled" | "expired",
  ): void {
    this.#transition(entry, state, { ...(terminationTarget === undefined ? {} : { terminationTarget }) });
  }

  #complete(entry: OperationEntry, result: WalletOperationResult): void {
    this.#transition(entry, "completed", { result });
  }

  #reject(entry: OperationEntry, code: WalletPeerRefusalCode): void {
    this.#transition(entry, "rejected", { peerRefusalCode: code });
  }

  #fail(entry: OperationEntry, code: WalletOperationFailureCode): void {
    this.#transition(entry, "failed", { failure: operationFailureFor(code) });
  }

  #failIfNonterminal(entry: OperationEntry, code: WalletOperationFailureCode): void {
    if (!isWalletOperationTerminalState(entry.state)) this.#fail(entry, code);
  }

  #terminal(entry: OperationEntry, state: "cancelled" | "expired"): void {
    this.#transition(entry, state);
  }

  #finishTerminal(entry: OperationEntry): void {
    entry.qr = undefined;
    this.#persistenceBlockedOperations.delete(entry.operationId);
    this.#operations.delete(entry.operationId);
    this.#scheduleConvergence();
  }

  #convergeOperations(now: UtcTimestamp = this.#now()): void {
    const current = Date.parse(now);
    for (const entry of this.#operations.values()) {
      if (
        isWalletOperationTerminalState(entry.state) ||
        this.#persistenceBlockedOperations.has(entry.operationId) ||
        Date.parse(entry.actionExpiresAt) > current
      ) continue;
      if (entry.terminationIntent !== undefined) continue;
      if (entry.kind === "connect") {
        try { this.#setState(entry, "cancelling", "expired"); }
        catch {
          this.#blockOperationPersistence(entry);
          continue;
        }
        entry.qr = undefined;
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
      const candidate = !isWalletOperationTerminalState(entry.state) &&
        !this.#persistenceBlockedOperations.has(entry.operationId) &&
        entry.kind === "connect" && entry.terminationIntent === undefined
        ? entry.actionExpiresAt
        : undefined;
      if (candidate === undefined) continue;
      const timestamp = Date.parse(candidate);
      if (next === undefined || timestamp < next) next = timestamp;
    }
    const session = this.#authority.sessionAttribution;
    if (session !== undefined && this.#authority.record.connection.status === "connected" &&
      this.#effect === undefined && !this.#authority.pendingRevalidation &&
      this.#persistenceBlockedOperations.size === 0 &&
      this.#expiryCleanupSourceId !== session.source.sourceId) {
      const expiry = Date.parse(session.connection.expiresAt);
      if (next === undefined || expiry < next) next = expiry;
    }
    if (next === undefined) return;
    const wake = setTimeout(() => {
      if (this.#operationWake === wake) this.#operationWake = undefined;
      try { this.#convergePublicState(); }
      catch { /* Retain closed authority and the stored predecessor on failure. */ }
      finally {
        try { this.#scheduleConvergence(); }
        catch { this.#invalidateAuthority("observation_unavailable", false); }
      }
    }, Math.min(maximumTimerDelayMilliseconds, Math.max(0, next - now)));
    unrefTimer(wake);
    this.#operationWake = wake;
  }

  async #reconcileDurableOperation(): Promise<void> {
    const operation = this.#wallet.operations.readActive();
    if (operation === null) return;
    const entry = this.#entryFromOperation(operation);
    this.#operations.set(entry.operationId, entry);
    entry.qr = undefined;
    const first = this.#readStableObservation();
    if (first.status === "unavailable") {
      this.#commitPostEffect(entry, () => this.#fail(entry, "runtime_state_unavailable"));
      return;
    }
    let initial: EvaluatedObservation;
    try { initial = this.#convergeObservation(first.observation, "no_session"); }
    catch {
      this.#commitPostEffect(entry, () => this.#fail(entry, "runtime_state_unavailable"));
      return;
    }
    if (entry.kind === "disconnect") {
      if (this.#isCompleteEmpty(initial)) {
        const connection = this.#authority.record.connection;
        if (connection.status === "disconnected") {
          this.#commitPostEffect(entry, () => this.#complete(entry, {
            outcome: "disconnected",
            connectionRevision: this.#authority.record.revision,
            connection,
          }));
          return;
        }
      }
      this.#commitPostEffect(entry, () => this.#fail(entry, "runtime_state_unavailable"));
      return;
    }
    const adopted = this.#reviewedConnectSession(entry, initial);
    if (adopted !== undefined && entry.terminationIntent === undefined) {
      this.#commitPostEffect(entry, () => this.#complete(entry, {
        outcome: "connected",
        connectionRevision: this.#authority.record.revision,
        connection: adopted.connection,
      }));
      return;
    }
    if (entry.terminationIntent === undefined) {
      if (!this.#commitPostEffect(entry, () => this.#setState(entry, "cancelling", "expired"))) {
        return;
      }
    }
    await this.#reconcileConnectEffect(entry, {
      kind: "failed",
      failureCode: "runtime_state_unavailable",
    });
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
    if (this.#expiryCleanupSourceId !== undefined && !observation.sessions.some((session) =>
      session.source.sourceId === this.#expiryCleanupSourceId)) this.#expiryCleanupSourceId = undefined;
    const authority = this.#authority;
    const previousAttribution = authority.sessionAttribution;
    if (
      allowExpiryCleanup && this.#effect === undefined &&
      this.#expiryCleanupSourceId !== previousAttribution?.source.sourceId &&
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
    this.#scheduleConvergence();
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

  #invalidateAuthority(
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
  }

  #closeAuthority(
    reason: "reconciling" | "observation_unavailable",
    requireRevalidation: boolean,
  ): void {
    const previous = this.#authority;
    const pendingRevalidation = previous.pendingRevalidation || requireRevalidation;
    this.#invalidateAuthority(reason, requireRevalidation);
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

  #captureActiveWallet(): Readonly<{
    snapshot: ActiveWalletReadSnapshot;
    evidenceAvailable: boolean;
  }> {
    const now = this.#now();
    const current = this.#authority;
    const expired = current.record.connection.status === "connected" &&
      current.sessionAttribution !== undefined &&
      Date.parse(current.sessionAttribution.connection.expiresAt) <= Date.parse(now);
    if (expired) {
      this.#invalidateAuthority(current.status === "closed" ? current.reason : "reconciling", false);
    }
    const authority = this.#authority;
    if (authority.status === "closed" || this.#closing || this.#closed || this.#effect !== undefined ||
      this.#reconcilePending ||
      this.#persistenceBlockedOperations.size !== 0) {
      return Object.freeze({
        snapshot: Object.freeze({
          connection: unknownConnection(authority.status === "closed" ? authority.reason : "reconciling"),
          connectionRevision: authority.record.revision,
        }),
        evidenceAvailable: false,
      });
    }
    return Object.freeze({
      snapshot: Object.freeze({
        connection: authority.record.connection,
        connectionRevision: authority.record.revision,
        ...(authority.record.connection.status !== "connected" ||
          authority.sessionAttribution === undefined
          ? {} : { sessionSource: authority.sessionAttribution.source }),
      }),
      evidenceAvailable: true,
    });
  }

  #convergePublicState(): void {
    this.#convergeOperations();
    if (this.#effect !== undefined || this.#persistenceBlockedOperations.size !== 0) return;
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
    if (this.#effect !== undefined || this.#expiryCleanupSourceId === source.sourceId) return;
    this.#closeAuthority("reconciling", false);
    this.#expiryCleanupSourceId = source.sourceId;
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
    if (
      this.#reconcileScheduled || this.#closing ||
      this.#persistenceBlockedOperations.size !== 0
    ) return;
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
    const work = Promise.resolve().then(run).catch(async (error: unknown) => {
      if (this.#closing || this.#closed) return;
      try { this.#closeAuthority("observation_unavailable", true); }
      catch { /* The in-memory authority remains closed. */ }
      if (operationId !== undefined) {
        const entry = this.#operations.get(operationId);
        if (entry !== undefined && !isWalletOperationTerminalState(entry.state)) {
          if (entry.kind === "connect") {
            await this.#reconcileConnectEffect(entry, {
              kind: "failed",
              failureCode: failureCodeFor(error),
            });
          } else {
            this.#commitPostEffect(entry, () => this.#fail(entry, failureCodeFor(error)));
          }
        }
      }
      if (operationId === undefined || !this.#persistenceBlockedOperations.has(operationId)) {
        this.#reconcilePending = true;
      }
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
    const storedActive = this.#wallet.operations.readActive();
    if (storedActive !== null && storedActive.kind === "connect") {
      const active = this.#operations.get(storedActive.operationId) ??
        this.#entryFromOperation(storedActive);
      active.qr = undefined;
      if (
        !this.#persistenceBlockedOperations.has(active.operationId) &&
        ["starting_connection", "awaiting_wallet_approval", "validating_session"].includes(active.state)
      ) {
        try { this.#setState(active, "cancelling", "expired"); }
        catch { this.#blockOperationPersistence(active); }
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
