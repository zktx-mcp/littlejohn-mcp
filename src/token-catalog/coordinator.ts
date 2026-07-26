import { randomBytes } from "node:crypto";

import {
  ObservationAuthorityRegistry,
  deepFreezeValue,
  parseUtcTimestamp,
  type ApplicationFailure,
  type CanonicalClock,
  type EvmAccountIdentity,
  type UnsignedDecimal,
  type UtcTimestamp,
} from "../core/index.js";
import {
  findOfficialAssetMember,
  type OfficialAssetSnapshotRevision,
  type StockFactoryVerification,
} from "../registry/index.js";
import { captureConnectedWalletSession } from "./active-wallet.js";
import {
  tokenCatalogContractLimits,
  tokenCatalogOperationConfirmationContract,
  tokenCatalogOperationSchema,
  tokenCatalogReviewDigest,
  tokenInspectionDigest,
  parseTokenOperationFailure,
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
  type TokenCatalogConfirmedOperation,
  type TokenCatalogOperationConfirmationInput,
  type TokenCatalogOperation,
  type TokenCatalogOperationStartResult,
  type TokenCatalogTerminalOperation,
  type TokenInspectionSuccess,
  type TokenSelection,
  type TokenOfficialSelectionEvidence,
  type TokenAdditionStartRequest,
  type TokenRemovalStartInput,
} from "./contracts.js";
import { normalizeTokenCatalogError, TokenCatalogOperationError } from "./operation-error.js";
import type {
  TokenCatalogCoordinatorDependencies,
  TokenCatalogOperationCoordinatorPort,
} from "./ports.js";
import {
  isTokenCatalogOperationTerminal,
  tokenCatalogInteractionInterfaces,
  type TokenCatalogInteractionInterface,
  type TokenCatalogOperationKind,
} from "./state.js";

export const tokenCatalogCoordinatorPolicy = Object.freeze({
  userActionMilliseconds: 5 * 60 * 1_000,
  terminalRetentionMilliseconds: 5 * 60 * 1_000,
});

const addMilliseconds = (value: UtcTimestamp, milliseconds: number): UtcTimestamp =>
  parseUtcTimestamp(new Date(Date.parse(value) + milliseconds).toISOString());

const createSelectionRevision = () => tokenSelectionRevisionSchema.parse(
  randomBytes(tokenCatalogContractLimits.selectionRevisionBytes).toString("base64url"),
);
const createSelectionSetRevision = () => tokenSelectionSetRevisionSchema.parse(
  randomBytes(tokenCatalogContractLimits.selectionRevisionBytes).toString("base64url"),
);

interface CapturedWallet {
  readonly account: EvmAccountIdentity;
  readonly connectionRevision: UnsignedDecimal;
  readonly sessionSourceId: string;
  readonly sessionTopicDigest: string;
}

interface OperationEntry {
  operation: TokenCatalogOperation;
  readonly connectionRevision: UnsignedDecimal;
  readonly sessionSourceId: CapturedWallet["sessionSourceId"];
  readonly sessionTopicDigest: CapturedWallet["sessionTopicDigest"];
  terminalAt?: UtcTimestamp;
  readonly sequence: number;
  readonly officialVerification: StockFactoryVerification | null;
}

type TokenStartCommand =
  | Readonly<{
      kind: "add";
      input: TokenAdditionStartRequest;
      interactionInterface: TokenCatalogInteractionInterface;
      operationId: TokenCatalogOperation["operationId"];
    }>
  | Readonly<{
      kind: "remove";
      input: TokenRemovalStartInput;
      interactionInterface: TokenCatalogInteractionInterface;
      operationId: TokenCatalogOperation["operationId"];
    }>;

type PreparedTokenStart = Readonly<{
  kind: TokenCatalogOperationKind;
  asset: TokenSelection["asset"];
  previousSelection: TokenSelection | null;
  selectionSetRevision: ReturnType<typeof tokenSelectionSetRevisionSchema.parse> | null;
  inspection: TokenInspectionSuccess | null;
  officialSnapshotRevision: OfficialAssetSnapshotRevision | null;
  officialEvidence: TokenOfficialSelectionEvidence | null;
  officialVerification: StockFactoryVerification | null;
}>;

export interface TokenCatalogCoordinatorRuntimeDependencies extends TokenCatalogCoordinatorDependencies {
  readonly clock: CanonicalClock;
  readonly signal: AbortSignal;
}

const failureFor = (error: unknown): ApplicationFailure =>
  normalizeTokenCatalogError(error).failure;

const operationFailureFor = (error: unknown): ApplicationFailure => {
  try { return parseTokenOperationFailure(failureFor(error)); }
  catch { return new TokenCatalogOperationError("internal_error").failure; }
};

export class TokenCatalogCoordinator implements TokenCatalogOperationCoordinatorPort {
  readonly #dependencies: TokenCatalogCoordinatorRuntimeDependencies;
  readonly #operations = new Map<string, OperationEntry>();
  readonly #inspectionControllers = new Set<AbortController>();
  readonly #activeCalls = new Set<Promise<void>>();
  #starting = false;
  #sequence = 0;
  #lifecycleState: "open" | "closing" | "closed" = "open";
  #closePromise?: Promise<void>;

  constructor(dependencies: TokenCatalogCoordinatorRuntimeDependencies) {
    this.#dependencies = dependencies;
    Object.seal(this);
  }

  startAddition(
    input: TokenAdditionStartRequest,
    control: import("./ports.js").TokenCatalogOperationControl,
  ): Promise<TokenCatalogOperationStartResult<"add"> | ApplicationFailure> {
    return this.#runAdmitted(() => this.#start({ kind: "add", input, ...control })) as Promise<
      TokenCatalogOperationStartResult<"add"> | ApplicationFailure
    >;
  }

  startRemoval(
    input: TokenRemovalStartInput,
    control: import("./ports.js").TokenCatalogOperationControl,
  ): Promise<TokenCatalogOperationStartResult<"remove"> | ApplicationFailure> {
    return this.#runAdmitted(() => this.#start({ kind: "remove", input, ...control })) as Promise<
      TokenCatalogOperationStartResult<"remove"> | ApplicationFailure
    >;
  }

  getOperation(operationId: TokenCatalogOperation["operationId"]): TokenCatalogOperation {
    this.#assertOpen();
    this.#expireAndPurge();
    const entry = this.#operations.get(operationId);
    if (entry === undefined) throw new TokenCatalogOperationError("token_operation_not_found");
    return entry.operation;
  }

  getCurrentOperation(): TokenCatalogOperation | null {
    this.#assertOpen();
    this.#expireAndPurge();
    let current: OperationEntry | undefined;
    for (const entry of this.#operations.values()) {
      if (current === undefined || entry.sequence > current.sequence) current = entry;
    }
    return current?.operation ?? null;
  }

  confirm(
    control: import("./ports.js").TokenCatalogOperationControl,
    inputValue: TokenCatalogOperationConfirmationInput,
  ): Promise<TokenCatalogConfirmedOperation> {
    if (control.operationId !== inputValue.operationId) {
      return Promise.reject(new TokenCatalogOperationError("state_conflict"));
    }
    return this.#runAdmitted(() => this.#confirm(control.interactionInterface, inputValue));
  }

  async #confirm(
    interactionInterfaceInput: TokenCatalogInteractionInterface,
    inputValue: TokenCatalogOperationConfirmationInput,
  ): Promise<TokenCatalogConfirmedOperation> {
    let input: TokenCatalogOperationConfirmationInput;
    try { input = tokenCatalogOperationConfirmationContract.parseInput(inputValue); }
    catch { throw new TokenCatalogOperationError("invalid_input"); }
    const interactionInterface = tokenCatalogInteractionInterfaces.find(
      (candidate) => candidate === interactionInterfaceInput,
    );
    if (interactionInterface === undefined) throw new TokenCatalogOperationError("invalid_input");
    this.#expireAndPurge();
    const entry = this.#operations.get(input.operationId);
    if (entry === undefined) throw new TokenCatalogOperationError("token_operation_not_found");
    if (entry.operation.state === "expired") throw new TokenCatalogOperationError("token_operation_expired");
    const expectedReviewDigest = this.#reviewDigest(entry);
    if (
      entry.operation.state !== "awaiting_confirmation" ||
      entry.operation.interactionInterface !== interactionInterface ||
      entry.operation.review.reviewDigest !== expectedReviewDigest ||
      input.reviewDigest !== expectedReviewDigest
    ) throw new TokenCatalogOperationError("state_conflict");
    try {
      this.#recaptureWallet({
        account: entry.operation.account,
        connectionRevision: entry.connectionRevision,
        sessionSourceId: entry.sessionSourceId,
        sessionTopicDigest: entry.sessionTopicDigest,
      });
    } catch (error) {
      throw normalizeTokenCatalogError(error);
    }
    entry.operation = this.#replaceOperation(entry.operation, { state: "applying" });
    try {
      const applying = entry.operation;
      if (applying.state !== "applying") throw new TokenCatalogOperationError("internal_error");
      if (applying.kind === "add") {
        entry.operation = this.#dependencies.store.applyConfirmation({
          kind: applying.kind,
          operation: applying,
          expectedConnectionRevision: entry.connectionRevision,
          selectionRevision: createSelectionRevision(),
          selectionSetRevision: createSelectionSetRevision(),
          officialVerification: entry.officialVerification,
          now: this.#now(),
        });
      } else {
        entry.operation = this.#dependencies.store.applyConfirmation({
          kind: applying.kind,
          operation: applying,
          expectedConnectionRevision: entry.connectionRevision,
          selectionRevision: createSelectionRevision(),
          selectionSetRevision: createSelectionSetRevision(),
          now: this.#now(),
        });
      }
    } catch (error) {
      entry.operation = this.#replaceOperation(entry.operation, {
        state: "failed",
        failure: operationFailureFor(error),
      });
    }
    entry.terminalAt = this.#now();
    if (entry.operation.state !== "completed" && entry.operation.state !== "failed") {
      throw new TokenCatalogOperationError("internal_error");
    }
    try { return tokenCatalogOperationConfirmationContract.parsePublicSuccess(input, entry.operation); }
    catch { throw new TokenCatalogOperationError("internal_error"); }
  }

  cancel(
    operationId: TokenCatalogOperation["operationId"],
    interactionInterface?: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogTerminalOperation> {
    return this.#runAdmitted(() => this.#cancel(operationId, interactionInterface));
  }

  async #cancel(
    operationId: TokenCatalogOperation["operationId"],
    interactionInterface?: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogTerminalOperation> {
    this.#expireAndPurge();
    const entry = this.#operations.get(operationId);
    if (entry === undefined) throw new TokenCatalogOperationError("token_operation_not_found");
    if (interactionInterface !== undefined && entry.operation.interactionInterface !== interactionInterface) {
      throw new TokenCatalogOperationError("state_conflict");
    }
    if (isTokenCatalogOperationTerminal(entry.operation.state)) {
      const operation = entry.operation;
      if (
        operation.state === "cancelled" || operation.state === "completed" ||
        operation.state === "expired" || operation.state === "failed"
      ) return operation;
      throw new TokenCatalogOperationError("internal_error");
    }
    if (entry.operation.state !== "awaiting_confirmation") {
      throw new TokenCatalogOperationError("state_conflict");
    }
    entry.operation = this.#replaceOperation(entry.operation, { state: "cancelled" });
    entry.terminalAt = this.#now();
    const cancelled = entry.operation;
    if (cancelled.state !== "cancelled") throw new TokenCatalogOperationError("internal_error");
    return cancelled;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#lifecycleState = "closing";
    for (const controller of this.#inspectionControllers) controller.abort();
    const closePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.#activeCalls]);
      this.#inspectionControllers.clear();
      this.#operations.clear();
      this.#starting = false;
      this.#lifecycleState = "closed";
    });
    this.#closePromise = closePromise;
    return closePromise;
  }

  #assertOpen(): void {
    if (this.#lifecycleState !== "open") {
      throw new TokenCatalogOperationError("runtime_state_unavailable");
    }
  }

  #runAdmitted<Result>(operation: () => Promise<Result>): Promise<Result> {
    try { this.#assertOpen(); }
    catch (error) { return Promise.reject(error); }
    const active = operation();
    let settlement!: Promise<void>;
    settlement = active.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.#activeCalls.delete(settlement);
    });
    this.#activeCalls.add(settlement);
    return active;
  }

  async #start(command: TokenStartCommand): Promise<TokenCatalogOperationStartResult | ApplicationFailure> {
    let admitted = false;
    const controller = new AbortController();
    try {
      this.#admitStart(command.operationId);
      admitted = true;
      this.#inspectionControllers.add(controller);
      const wallet = this.#captureWallet();
      if (command.input.asset.chainId !== wallet.account.chainId) {
        throw new TokenCatalogOperationError("invalid_input");
      }
      const signal = AbortSignal.any([this.#dependencies.signal, controller.signal]);
      let prepared: PreparedTokenStart;
      if (command.kind === "add") {
        const current = this.#dependencies.store.getSelection(wallet.account, command.input.asset);
        if (current?.selection.included === true) {
          throw new TokenCatalogOperationError("token_selection_already_included");
        }
        const synchronization = await this.#dependencies.officialAssets.synchronize(signal);
        if (synchronization.status === "unavailable") {
          return synchronization.failure;
        }
        const member = findOfficialAssetMember(synchronization.snapshot, command.input.asset.address);
        const chainResult = await this.#dependencies.additionChainReads.inspectAndVerifyOfficial({
          asset: command.input.asset,
          officialMember: member ?? null,
        }, signal);
        if (!("inspection" in chainResult)) return chainResult;
        const { inspection, officialVerification } = chainResult;
        const officialEvidence: TokenOfficialSelectionEvidence | null = member === undefined || officialVerification === null
          ? null
          : Object.freeze({
              assetUid: member.assetUid,
              snapshotRevision: synchronization.snapshot.revision,
              verificationBlock: officialVerification.block,
            });
        prepared = Object.freeze({
          kind: command.kind,
          asset: command.input.asset,
          previousSelection: current?.selection ?? null,
          selectionSetRevision: this.#dependencies.store.getSelectionState(wallet.account)?.revision ?? null,
          inspection,
          officialSnapshotRevision: synchronization.snapshot.revision,
          officialEvidence,
          officialVerification,
        });
      } else {
        const current = this.#dependencies.store.getSelection(wallet.account, command.input.asset);
        if (current === undefined) throw new TokenCatalogOperationError("token_selection_not_found");
        if (!current.selection.included) throw new TokenCatalogOperationError("token_selection_not_included");
        if (current.selection.revision !== command.input.expectedRevision) {
          throw new TokenCatalogOperationError("token_selection_revision_changed");
        }
        prepared = Object.freeze({
          kind: command.kind,
          asset: command.input.asset,
          previousSelection: current.selection,
          selectionSetRevision: this.#dependencies.store.getSelectionState(wallet.account)?.revision ?? null,
          inspection: null,
          officialSnapshotRevision: null,
          officialEvidence: null,
          officialVerification: null,
        });
      }
      if (this.#lifecycleState !== "open" || signal.aborted) {
        throw new TokenCatalogOperationError("request_aborted");
      }
      this.#recaptureWallet(wallet);
      return this.#createOperation({
        ...prepared,
        interactionInterface: command.interactionInterface,
        operationId: command.operationId,
        wallet,
      });
    } catch (error) {
      return failureFor(error);
    } finally {
      this.#inspectionControllers.delete(controller);
      if (admitted) this.#starting = false;
    }
  }

  #now(): UtcTimestamp {
    return this.#dependencies.clock.now();
  }

  #admitStart(operationId: TokenCatalogOperation["operationId"]): void {
    this.#expireAndPurge();
    this.#assertOpen();
    if (this.#operations.has(operationId)) throw new TokenCatalogOperationError("state_conflict");
    if (this.#starting || [...this.#operations.values()].some((entry) =>
      !isTokenCatalogOperationTerminal(entry.operation.state))) {
      throw new TokenCatalogOperationError("token_operation_conflict");
    }
    this.#starting = true;
  }

  #captureWallet(): CapturedWallet {
    const active = captureConnectedWalletSession(this.#dependencies.activeWallet);
    try {
      const authorities = new ObservationAuthorityRegistry(
        this.#dependencies.clock,
        [active.sessionSource.observationAuthority],
      );
      if (authorities.get("wallet_session") !== active.sessionSource.observationAuthority) {
        throw new TypeError("Active wallet evidence authority is unavailable.");
      }
    } catch {
      throw new TokenCatalogOperationError("wallet_session_unusable");
    }
    return Object.freeze({
      account: active.account,
      connectionRevision: active.connectionRevision,
      sessionSourceId: active.sessionSource.sourceId,
      sessionTopicDigest: active.sessionSource.topicDigest,
    });
  }

  #recaptureWallet(captured: CapturedWallet): void {
    let active: CapturedWallet;
    try { active = this.#captureWallet(); }
    catch (error) {
      const code = normalizeTokenCatalogError(error).failure.error.code;
      if (code === "wallet_not_connected" || code === "wallet_session_unusable") {
        throw new TokenCatalogOperationError("state_conflict");
      }
      throw error;
    }
    if (
      active.account.chainId !== captured.account.chainId ||
      active.account.address !== captured.account.address ||
      active.connectionRevision !== captured.connectionRevision ||
      active.sessionSourceId !== captured.sessionSourceId ||
      active.sessionTopicDigest !== captured.sessionTopicDigest
    ) throw new TokenCatalogOperationError("state_conflict");
  }

  #createOperation<Kind extends TokenCatalogOperationKind>(input: Readonly<{
    operationId: TokenCatalogOperation["operationId"];
    kind: Kind;
    interactionInterface: TokenCatalogInteractionInterface;
    wallet: CapturedWallet;
    asset: TokenSelection["asset"];
    previousSelection: TokenSelection | null;
    selectionSetRevision: ReturnType<typeof tokenSelectionSetRevisionSchema.parse> | null;
    inspection: TokenInspectionSuccess | null;
    officialSnapshotRevision: OfficialAssetSnapshotRevision | null;
    officialEvidence: TokenOfficialSelectionEvidence | null;
    officialVerification: StockFactoryVerification | null;
  }>): TokenCatalogOperationStartResult<Kind> {
    const createdAt = this.#now();
    const expiresAt = addMilliseconds(createdAt, tokenCatalogCoordinatorPolicy.userActionMilliseconds);
    const inspectionDigest = input.inspection === null
      ? null
      : tokenInspectionDigest(input.inspection);
    const reviewDigest = tokenCatalogReviewDigest({
      operationId: input.operationId,
      kind: input.kind,
      account: input.wallet.account,
      connectionRevision: input.wallet.connectionRevision,
      asset: input.asset,
      previousSelection: input.previousSelection,
      selectionSetRevision: input.selectionSetRevision,
      inspection: input.inspection,
      officialSnapshotRevision: input.officialSnapshotRevision,
      officialEvidence: input.officialEvidence,
      interactionInterface: input.interactionInterface,
      expiresAt,
    });
    const operation = deepFreezeValue(tokenCatalogOperationSchema.parse({
      operationId: input.operationId,
      kind: input.kind,
      state: "awaiting_confirmation",
      interactionInterface: input.interactionInterface,
      createdAt,
      expiresAt,
      account: input.wallet.account,
      connectionRevision: input.wallet.connectionRevision,
      asset: input.asset,
      review: {
        previousSelection: input.previousSelection,
        selectionSetRevision: input.selectionSetRevision,
        inspection: input.inspection,
        inspectionDigest,
        officialSnapshotRevision: input.officialSnapshotRevision,
        officialEvidence: input.officialEvidence,
        reviewDigest,
      },
      result: null,
      failure: null,
    }));
    const entry: OperationEntry = {
      operation,
      connectionRevision: input.wallet.connectionRevision,
      sessionSourceId: input.wallet.sessionSourceId,
      sessionTopicDigest: input.wallet.sessionTopicDigest,
      sequence: ++this.#sequence,
      officialVerification: input.officialVerification,
    };
    this.#operations.set(operation.operationId, entry);
    if (operation.kind !== input.kind || operation.state !== "awaiting_confirmation") {
      throw new TokenCatalogOperationError("internal_error");
    }
    return deepFreezeValue({ operation }) as TokenCatalogOperationStartResult<Kind>;
  }

  #replaceOperation(
    operation: TokenCatalogOperation,
    change: Readonly<{
      state: TokenCatalogOperation["state"];
      result?: NonNullable<TokenCatalogOperation["result"]>;
      failure?: ApplicationFailure;
    }>,
  ): TokenCatalogOperation {
    return deepFreezeValue(tokenCatalogOperationSchema.parse({
      ...operation,
      state: change.state,
      result: change.result ?? null,
      failure: change.failure ?? null,
    }));
  }

  #reviewDigest(entry: OperationEntry): TokenCatalogOperation["review"]["reviewDigest"] {
    return tokenCatalogReviewDigest({
      operationId: entry.operation.operationId,
      kind: entry.operation.kind,
      account: entry.operation.account,
      connectionRevision: entry.connectionRevision,
      asset: entry.operation.asset,
      previousSelection: entry.operation.review.previousSelection,
      selectionSetRevision: entry.operation.review.selectionSetRevision,
      inspection: entry.operation.review.inspection,
      officialSnapshotRevision: entry.operation.review.officialSnapshotRevision,
      officialEvidence: entry.operation.review.officialEvidence,
      interactionInterface: entry.operation.interactionInterface,
      expiresAt: entry.operation.expiresAt,
    });
  }

  #expireAndPurge(): void {
    const now = this.#now();
    for (const [operationId, entry] of this.#operations) {
      if (entry.operation.state === "awaiting_confirmation" && entry.operation.expiresAt <= now) {
        entry.operation = this.#replaceOperation(entry.operation, { state: "expired" });
        entry.terminalAt = entry.operation.expiresAt;
      }
      if (
        entry.terminalAt !== undefined &&
        addMilliseconds(entry.terminalAt, tokenCatalogCoordinatorPolicy.terminalRetentionMilliseconds) <= now
      ) {
        this.#operations.delete(operationId);
      }
    }
  }
}
