import { randomBytes } from "node:crypto";

import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  deepFreezeValue,
  parseUtcTimestamp,
  type ApplicationFailure,
  type CanonicalClock,
  type EvmAccountIdentity,
  type UnsignedDecimal,
  type UtcTimestamp,
  type WalletConnectionData,
} from "../core/index.js";
import { captureConnectedWalletSession } from "./active-wallet.js";
import {
  tokenCatalogContractLimits,
  tokenCatalogOperationConfirmationContract,
  tokenCatalogOperationSchema,
  tokenCatalogReviewDigest,
  parseTokenOperationFailure,
  tokenInspectCapability,
  tokenRegistrationChangesSchema,
  tokenRegistrationRevisionSchema,
  tokenRegistrationSettingsSchema,
  type TokenCatalogConfirmedOperation,
  type TokenCatalogOperationConfirmationInput,
  type TokenCatalogOperation,
  type TokenCatalogOperationStartResult,
  type TokenCatalogTerminalOperation,
  type TokenInspectionSuccess,
  type TokenRegistration,
  type TokenRegistrationSettings,
  type TokenRegistrationStartRequest,
  type TokenRegistrationUpdateStartInput,
  type TokenUnregistrationStartInput,
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

const createOperationId = () => randomBytes(tokenCatalogContractLimits.operationIdBytes).toString("base64url");
const createRegistrationRevision = () => tokenRegistrationRevisionSchema.parse(
  randomBytes(tokenCatalogContractLimits.registrationRevisionBytes).toString("base64url"),
);

interface CapturedWallet {
  readonly account: EvmAccountIdentity;
  readonly connectionRevision: UnsignedDecimal;
  readonly sessionSource: NonNullable<
    ReturnType<TokenCatalogCoordinatorDependencies["activeWallet"]["capture"]>["sessionSource"]
  >;
}

interface OperationEntry {
  operation: TokenCatalogOperation;
  readonly connectionRevision: UnsignedDecimal;
  readonly sessionSource: CapturedWallet["sessionSource"];
  terminalAt?: UtcTimestamp;
  readonly sequence: number;
}

export interface TokenCatalogCoordinatorRuntimeDependencies extends TokenCatalogCoordinatorDependencies {
  readonly clock: CanonicalClock;
  readWalletProjection(): Readonly<{
    revision: UnsignedDecimal;
    connection: WalletConnectionData;
    updatedAt: UtcTimestamp;
  }>;
  readonly signal: AbortSignal;
}

const sameConnectedWallet = (
  connection: WalletConnectionData,
  account: EvmAccountIdentity,
): boolean => connection.status === "connected" &&
  connection.chainId === account.chainId && connection.address === account.address;

const failureFor = (error: unknown): ApplicationFailure =>
  normalizeTokenCatalogError(error).failure;

const operationFailureFor = (error: unknown): ApplicationFailure => {
  try { return parseTokenOperationFailure(failureFor(error)); }
  catch { return new TokenCatalogOperationError("internal_error").failure; }
};

export class TokenCatalogCoordinator implements TokenCatalogOperationCoordinatorPort {
  readonly #dependencies: TokenCatalogCoordinatorRuntimeDependencies;
  readonly #inspections: CapabilityBindingRegistry;
  readonly #operations = new Map<string, OperationEntry>();
  readonly #inspectionControllers = new Set<AbortController>();
  #starting = false;
  #sequence = 0;
  #closed = false;

  constructor(dependencies: TokenCatalogCoordinatorRuntimeDependencies) {
    this.#dependencies = dependencies;
    this.#inspections = new CapabilityBindingRegistry(
      new CapabilityRegistry([tokenInspectCapability]),
      [dependencies.inspection],
    );
    Object.seal(this);
  }

  async startRegistration(
    input: TokenRegistrationStartRequest,
    interactionInterface: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogOperationStartResult<"register"> | ApplicationFailure> {
    let admitted = false;
    const controller = new AbortController();
    try {
      this.#admitStart();
      admitted = true;
      this.#inspectionControllers.add(controller);
      const wallet = this.#captureWallet();
      if (input.asset.chainId !== wallet.account.chainId) throw new TokenCatalogOperationError("invalid_input");
      if (this.#dependencies.store.getRegistration(wallet.account, input.asset) !== undefined) {
        throw new TokenCatalogOperationError("token_registration_already_exists");
      }
      const signal = AbortSignal.any([this.#dependencies.signal, controller.signal]);
      const inspection = await this.#inspections.invoke(
        tokenInspectCapability,
        { asset: input.asset, block: { kind: "latest" } },
        { signal },
      );
      if ("ok" in inspection && inspection.ok === false) return inspection;
      if (this.#closed || signal.aborted) throw new TokenCatalogOperationError("request_aborted");
      this.#recaptureWallet(wallet);
      return this.#createOperation({
        kind: "register",
        interactionInterface,
        wallet,
        asset: input.asset,
        previousRegistration: null,
        proposedSettings: tokenRegistrationSettingsSchema.parse(input.settings),
        inspection,
      });
    } catch (error) {
      return failureFor(error);
    } finally {
      this.#inspectionControllers.delete(controller);
      if (admitted) this.#starting = false;
    }
  }

  async startRegistrationUpdate(
    input: TokenRegistrationUpdateStartInput,
    interactionInterface: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogOperationStartResult<"update_registration"> | ApplicationFailure> {
    let admitted = false;
    try {
      this.#admitStart();
      admitted = true;
      const wallet = this.#captureWallet();
      if (input.asset.chainId !== wallet.account.chainId) throw new TokenCatalogOperationError("invalid_input");
      const current = this.#dependencies.store.getRegistration(wallet.account, input.asset);
      if (current === undefined) throw new TokenCatalogOperationError("token_registration_not_found");
      if (current.registration.revision !== input.expectedRevision) {
        throw new TokenCatalogOperationError("token_registration_revision_changed");
      }
      const changes = tokenRegistrationChangesSchema.parse(input.changes);
      const proposedSettings = tokenRegistrationSettingsSchema.parse({
        userLabel: changes.userLabel === undefined ? current.registration.userLabel : changes.userLabel,
        visibility: changes.visibility === undefined ? current.registration.visibility : changes.visibility,
      });
      if (
        proposedSettings.userLabel === current.registration.userLabel &&
        proposedSettings.visibility === current.registration.visibility
      ) throw new TokenCatalogOperationError("invalid_input");
      this.#recaptureWallet(wallet);
      return this.#createOperation({
        kind: "update_registration",
        interactionInterface,
        wallet,
        asset: input.asset,
        previousRegistration: current.registration,
        proposedSettings,
        inspection: current.inspection,
      });
    } catch (error) {
      return failureFor(error);
    } finally {
      if (admitted) this.#starting = false;
    }
  }

  async startUnregistration(
    input: TokenUnregistrationStartInput,
    interactionInterface: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogOperationStartResult<"unregister"> | ApplicationFailure> {
    let admitted = false;
    try {
      this.#admitStart();
      admitted = true;
      const wallet = this.#captureWallet();
      if (input.asset.chainId !== wallet.account.chainId) throw new TokenCatalogOperationError("invalid_input");
      const current = this.#dependencies.store.getRegistration(wallet.account, input.asset);
      if (current === undefined) throw new TokenCatalogOperationError("token_registration_not_found");
      if (current.registration.revision !== input.expectedRevision) {
        throw new TokenCatalogOperationError("token_registration_revision_changed");
      }
      this.#recaptureWallet(wallet);
      return this.#createOperation({
        kind: "unregister",
        interactionInterface,
        wallet,
        asset: input.asset,
        previousRegistration: current.registration,
        proposedSettings: null,
        inspection: current.inspection,
      });
    } catch (error) {
      return failureFor(error);
    } finally {
      if (admitted) this.#starting = false;
    }
  }

  getOperation(operationId: TokenCatalogOperation["operationId"]): TokenCatalogOperation {
    this.#expireAndPurge();
    const entry = this.#operations.get(operationId);
    if (entry === undefined) throw new TokenCatalogOperationError("token_operation_not_found");
    return entry.operation;
  }

  getCurrentOperation(): TokenCatalogOperation | null {
    this.#expireAndPurge();
    let current: OperationEntry | undefined;
    for (const entry of this.#operations.values()) {
      if (current === undefined || entry.sequence > current.sequence) current = entry;
    }
    return current?.operation ?? null;
  }

  async confirm(
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
        sessionSource: entry.sessionSource,
      });
    } catch (error) {
      throw normalizeTokenCatalogError(error);
    }
    entry.operation = this.#replaceOperation(entry.operation, { state: "applying" });
    try {
      let result: TokenCatalogOperation["result"];
      const previous = entry.operation.review.previousRegistration;
      if (entry.operation.kind === "register") {
        const settings = entry.operation.review.proposedSettings;
        if (settings === null) throw new TokenCatalogOperationError("internal_error");
        result = this.#dependencies.store.register({
          account: entry.operation.account,
          expectedConnectionRevision: entry.connectionRevision,
          inspection: entry.operation.review.inspection,
          settings,
          revision: createRegistrationRevision(),
          now: this.#now(),
        });
      } else if (entry.operation.kind === "update_registration") {
        const settings = entry.operation.review.proposedSettings;
        if (settings === null || previous === null) throw new TokenCatalogOperationError("internal_error");
        result = this.#dependencies.store.update({
          account: entry.operation.account,
          asset: entry.operation.asset,
          expectedConnectionRevision: entry.connectionRevision,
          expectedRegistrationRevision: previous.revision,
          settings,
          revision: createRegistrationRevision(),
          now: this.#now(),
        });
      } else {
        if (previous === null) throw new TokenCatalogOperationError("internal_error");
        result = this.#dependencies.store.unregister({
          account: entry.operation.account,
          asset: entry.operation.asset,
          expectedConnectionRevision: entry.connectionRevision,
          expectedRegistrationRevision: previous.revision,
        });
      }
      entry.operation = this.#replaceOperation(entry.operation, { state: "completed", result });
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
    try { return tokenCatalogOperationConfirmationContract.parseSuccess(input, entry.operation); }
    catch { throw new TokenCatalogOperationError("internal_error"); }
  }

  async cancel(
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

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#inspectionControllers) controller.abort();
    this.#inspectionControllers.clear();
    this.#operations.clear();
    this.#starting = false;
  }

  #now(): UtcTimestamp {
    return this.#dependencies.clock.now();
  }

  #admitStart(): void {
    this.#expireAndPurge();
    if (this.#closed) throw new TokenCatalogOperationError("runtime_state_unavailable");
    if (this.#starting || [...this.#operations.values()].some((entry) =>
      !isTokenCatalogOperationTerminal(entry.operation.state))) {
      throw new TokenCatalogOperationError("token_operation_conflict");
    }
    this.#starting = true;
  }

  #captureWallet(): CapturedWallet {
    const active = captureConnectedWalletSession(this.#dependencies.activeWallet);
    const projection = this.#dependencies.readWalletProjection();
    if (!sameConnectedWallet(projection.connection, active.account)) {
      throw new TokenCatalogOperationError("state_conflict");
    }
    return Object.freeze({
      account: active.account,
      connectionRevision: projection.revision,
      sessionSource: active.sessionSource,
    });
  }

  #recaptureWallet(captured: CapturedWallet): void {
    const active = this.#dependencies.activeWallet.capture();
    const projection = this.#dependencies.readWalletProjection();
    if (
      !sameConnectedWallet(active.connection, captured.account) ||
      active.sessionSource !== captured.sessionSource ||
      projection.revision !== captured.connectionRevision ||
      !sameConnectedWallet(projection.connection, captured.account)
    ) throw new TokenCatalogOperationError("state_conflict");
  }

  #createOperation<Kind extends TokenCatalogOperationKind>(input: Readonly<{
    kind: Kind;
    interactionInterface: TokenCatalogInteractionInterface;
    wallet: CapturedWallet;
    asset: TokenRegistration["asset"];
    previousRegistration: TokenRegistration | null;
    proposedSettings: TokenRegistrationSettings | null;
    inspection: TokenInspectionSuccess;
  }>): TokenCatalogOperationStartResult<Kind> {
    const createdAt = this.#now();
    const expiresAt = addMilliseconds(createdAt, tokenCatalogCoordinatorPolicy.userActionMilliseconds);
    const operationId = createOperationId();
    const reviewDigest = tokenCatalogReviewDigest({
      operationId,
      kind: input.kind,
      account: input.wallet.account,
      connectionRevision: input.wallet.connectionRevision,
      asset: input.asset,
      previousRegistration: input.previousRegistration,
      proposedSettings: input.proposedSettings,
      inspection: input.inspection,
      interactionInterface: input.interactionInterface,
      expiresAt,
    });
    const operation = deepFreezeValue(tokenCatalogOperationSchema.parse({
      operationId,
      kind: input.kind,
      state: "awaiting_confirmation",
      interactionInterface: input.interactionInterface,
      createdAt,
      expiresAt,
      account: input.wallet.account,
      asset: input.asset,
      review: {
        previousRegistration: input.previousRegistration,
        proposedSettings: input.proposedSettings,
        inspection: input.inspection,
        reviewDigest,
      },
      result: null,
      failure: null,
    }));
    const entry: OperationEntry = {
      operation,
      connectionRevision: input.wallet.connectionRevision,
      sessionSource: input.wallet.sessionSource,
      sequence: ++this.#sequence,
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
      previousRegistration: entry.operation.review.previousRegistration,
      proposedSettings: entry.operation.review.proposedSettings,
      inspection: entry.operation.review.inspection,
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
