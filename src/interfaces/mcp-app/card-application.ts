import type {PresentationWorkBudget} from "../presentation-work.js";
import {canonicalJsonStringify, captureCanonicalJson, operationIdSchema, sha256Bytes, utf8ByteLength,
  type CanonicalJson, type CanonicalClock, type ApplicationFailure} from "../../core/index.js";
import {createOperationId} from "../../runtime/operation-id.js";
import {internalCanonicalJsonResponseLimitBytes} from "../../runtime/http-limits.js";
import {createApplicationLifecycle} from "../../runtime/application-lifecycle.js";
import type {PresentationSnapshotRecord, PresentationSnapshotStore, ReviewPresentationSource} from "../../runtime/presentation-snapshot.js";
import {operationToolResultEvidence, createPresentationSnapshotResource, createWalletOperationQrMetadata} from "./contracts.js";
import {admitCardRecord, admitCardActionDelivery, cardIdInputSchema, cardOpeningSchema, cardReadReferenceSchema,
  cardReadStartContract, cardDecisionStartContract, assertCardPresentationSource, admitCardSourceResult, cardReferenceContract, cardState,
  cardPresentationDeliverySchema, type CardOutcome, type CardRecord, type DecisionCardRecord, type ReadCardRecord,
  type CardReadInput, type CardCreationResult, type CardDecisionStartInput,
  type PresentationCardStore, type CardPresentation, type CardPresentationDelivery, type CardActionDelivery} from "./card-contract.js";
import {cardSources, CardDomainError, type CardDomains, type CardSource, type CardOperationObservation, type PreparedCardSource} from "./card-sources.js";
import {presentationContractRegistry, type PresentationDecisionKind} from "./registry.js";
import {projectCardOperation} from "./card-projection.js";
import {isWalletOperationCancellableState, isWalletOperationTerminalState} from "../../wallet/operation-state.js";
import {walletAccountSelectionContracts, type WalletAccountSelection} from "../../wallet/account-selection-contract.js";
import {normalizeWalletError} from "../../wallet/errors.js";
import {CardError} from "./card-errors.js";
import {getRuntimeOperationFailure} from "../../runtime/errors.js";
import type {PreparedReviewDispatch} from "../../review/prepared-dispatch.js";
import {admitSnapshotRecord} from "./snapshot-record.js";

export interface CardReadExecutionPort {
  execute(input: CardReadInput, signal: AbortSignal): Promise<CanonicalJson | ApplicationFailure>;
}
export interface CardApplicationDependencies {
  readonly work: PresentationWorkBudget;
  readonly ownerSignal: AbortSignal;
  readonly clock: CanonicalClock;
  readonly store: PresentationCardStore;
  readonly snapshots: PresentationSnapshotStore;
  readonly reviews: ReviewPresentationSource;
  readonly domains: CardDomains;
  readonly readExecution: CardReadExecutionPort;
}
interface ActiveCall {readonly controller: AbortController; readonly settled: Promise<void>; release(): void}
interface ResolvedCard {
  readonly record: CardRecord;
  readonly operation?: CardOperationObservation;
  readonly snapshot?: PresentationSnapshotRecord;
  readonly selection?: WalletAccountSelection;
  readonly sourceAvailable?: boolean;
}
const terminalOperation = (observation: CardOperationObservation): boolean =>
  observation.value.domain !== "wallet" || isWalletOperationTerminalState(observation.value.state);
const digest = (value: unknown): string => sha256Bytes(new TextEncoder().encode(canonicalJsonStringify(captureCanonicalJson(value))));
const decisionRecord = (record: CardRecord): DecisionCardRecord => {
  if (record.kind === "read" || record.kind === "preparing") throw new CardError("state_conflict");
  return record;
};

export class PresentationCardApplication {
  readonly #active = new Map<string, ActiveCall>();
  readonly #work = new Set<Promise<unknown>>();
  readonly #sources = cardSources;
  readonly #lifecycle = createApplicationLifecycle();
  #storageFailed = false;
  constructor(private readonly dependencies: CardApplicationDependencies) {
    const abortWork = (): void => {for (const call of this.#active.values()) call.controller.abort();};
    this.#lifecycle.resources.register({close: async () => {
      dependencies.ownerSignal.removeEventListener("abort", abortWork);
      abortWork();
      await Promise.allSettled([...this.#work]);
      this.#active.clear();
    }});
    this.#lifecycle.open();
    dependencies.ownerSignal.addEventListener("abort", abortWork, {once: true});
    if (dependencies.ownerSignal.aborted) abortWork();
  }

  startDecision(input: unknown, signal: AbortSignal, publicationKey: string | null = null): Promise<CardCreationResult> {
    return this.#track(async () => {
      this.#assertOpen(signal);
      const command: CardDecisionStartInput = cardDecisionStartContract.parseNormalizedInput(input);
      const permit = this.dependencies.work.reserveCreation();
      try {
      const reservation = this.dependencies.store.beginCreation(command.kind, captureCanonicalJson(command), publicationKey);
      if (reservation.status !== "reserved") return {kind: "card", cardId: reservation.cardId, disposition: reservation.status};
      const source = this.#sources[command.kind];
      let prepared: PreparedCardSource | undefined;
      try {
        prepared = command.source.kind === "new"
          ? await source.prepare(this.dependencies.domains, command.source.input, signal)
          : source.existing(this.dependencies.domains, command.source.operationId, this.dependencies.reviews);
        this.#assertOpen(signal);
        const value = source.entry.parseResult(prepared.input, prepared.value);
        const description = source.describe(value);
        const snapshotInput = {contractId: source.entry.contractId, contractVersion: source.entry.contractVersion,
          normalizedInput: prepared.input, admittedResult: value};
        const snapshot = this.dependencies.snapshots.prepare(snapshotInput);
        if (snapshot.status !== "available") throw new CardError(snapshot.reason === "capacity_exceeded" ? "presentation_capacity_exceeded" : "runtime_state_unavailable");
        if (description !== null && description.expiresAt !== null && this.dependencies.clock.now() >= description.expiresAt) throw new CardError("review_expired");
        const record = admitCardRecord(description === null
          ? {cardId: reservation.cardId, kind: "read", contractVersion: "1", contractId: source.entry.contractId,
            inputDigest: snapshot.value.inputDigest, snapshotId: snapshot.value.snapshotId, preparationState: "completed", outcome: {kind: "snapshot"}}
          : {cardId: reservation.cardId, kind: command.kind, contractVersion: "1", operationId: description.operationId,
            resultDigest: snapshot.value.resultDigest, snapshotId: source.entry.retention === "sqlite" ? snapshot.value.snapshotId : null,
            expiresAt: description.expiresAt, inputState: description.outcome === null ? "input_pending" : "input_closed",
            closeReason: description.outcome === null ? null : "invalidated", dispatchId: null, outcome: description.outcome,
            ...(description.context === undefined ? {} : {context: description.context})});
        if (record.kind === "preparing") throw new CardError("presentation_inconsistent");
        if (record.kind !== "read") admitCardSourceResult(record, prepared.input, value);
        this.dependencies.store.commitCreation(reservation.reservation, record,
          source.entry.retention === "sqlite" ? snapshotInput : undefined, prepared.walletReview, prepared.tokenReview);
        return {kind: "card", cardId: reservation.cardId, disposition: "created"};
      } catch (error) {
        try {prepared?.discard(); this.dependencies.store.discardCreation(reservation.reservation);}
        catch {this.#storageFailed = true; throw new CardError("runtime_state_unavailable");}
        throw error;
      }
      } finally {permit.release();}
    });
  }

  startRead(input: unknown, signal: AbortSignal, publicationKey: string | null = null): Promise<CardCreationResult> {
    return this.#track(async () => {
      this.#assertOpen(signal);
      const request = cardReadStartContract.parseNormalizedInput(input);
      const entry = presentationContractRegistry.requireIdentity(request.capabilityId, "1");
      const command = entry.parseNormalizedInput(request.input);
      const permit = this.dependencies.work.reserveRead(utf8ByteLength(canonicalJsonStringify(command)));
      let handedOff = false;
      try {
      const reservation = this.dependencies.store.beginCreation("read", captureCanonicalJson(request), publicationKey);
      if (reservation.status !== "reserved") return {kind: "card", cardId: reservation.cardId, disposition: reservation.status};
      let record: ReadCardRecord;
      try {
        this.#assertOpen(signal);
        record = this.dependencies.store.commitCreation(reservation.reservation, {
          cardId: reservation.cardId, kind: "read", contractVersion: "1", contractId: entry.contractId,
          inputDigest: digest(command), snapshotId: null, preparationState: "pending", outcome: null,
        }, undefined, undefined, undefined) as ReadCardRecord;
      } catch (error) {
        try {this.dependencies.store.discardCreation(reservation.reservation);}
        catch {this.#storageFailed = true; throw new CardError("runtime_state_unavailable");}
        throw error;
      }
      const call = this.#register(record.cardId);
      void this.#track(async () => {
        try {
          this.#assertOpen(call.controller.signal);
          const result = await this.dependencies.readExecution.execute({capabilityId: entry.contractId, input: command}, call.controller.signal);
          const current = this.#read(record.cardId);
          if (current.kind !== "read") throw new CardError("presentation_inconsistent");
          if (current.preparationState !== "pending") return;
          if (call.controller.signal.aborted) this.#failRead(current, this.#accepting ? "request_aborted" : "runtime_state_unavailable");
          else if (typeof result === "object" && result !== null && "ok" in result && result.ok === false) {
            this.#failRead(current, entry.parseFailure(result).error.code);
          } else this.dependencies.store.completeRead(current, {contractId: entry.contractId, contractVersion: "1",
            normalizedInput: command, admittedResult: entry.parseResult(command, result)});
        } catch (error) {
          try {const current = this.#read(record.cardId); if (current.kind === "read" && current.preparationState === "pending") this.#failRead(current, this.#failureCode(error));}
          catch {this.#storageFailed = true;}
        } finally {call.release(); permit.release();}
      });
      handedOff = true;
      return {kind: "card", cardId: record.cardId, disposition: "created"};
      } finally {if (!handedOff) permit.release();}
    });
  }

  async #resolve(cardId: string, includePrivate = false): Promise<ResolvedCard> {
    this.#assertOpen();
    let record = this.#read(cardId);
    if (record.kind === "preparing") return {record};
    if (record.kind === "read") {
      if (record.preparationState === "pending" && !this.#active.has(cardId)) record = this.#failRead(record, "runtime_state_unavailable");
      return {record, ...(record.snapshotId === null ? {} : {snapshot: this.#snapshot(record.snapshotId)})};
    }
    const source = this.#sources[record.kind];
    let snapshot: PresentationSnapshotRecord | undefined;
    if (record.snapshotId !== null) {
      try {snapshot = this.#decisionSnapshot(record);}
      catch (error) {
        if (record.inputState === "input_closed" && error instanceof CardError && error.failure.error.code === "runtime_state_unavailable") {
          return {record, sourceAvailable: false};
        }
        throw error;
      }
    }
    if (source.operation !== undefined) {
      // Domain state is observed even on another card that refers to the same Review.
      let operation: CardOperationObservation | null;
      try {operation = await source.operation(this.dependencies.domains, record, includePrivate);}
      catch (error) {
        if (error instanceof CardDomainError) return {record, sourceAvailable: false,
          ...(record.inputState === "input_pending" && snapshot !== undefined ? {snapshot} : {})};
        throw error;
      }
      this.#assertOpen(); record = decisionRecord(this.#read(cardId));
      if (snapshot !== undefined) this.#admitDecisionSnapshot(record, snapshot);
      if (record.outcome?.kind === "operation" && operation !== null && !terminalOperation(operation)) {
        try {operation = await source.operation(this.dependencies.domains, record);}
        catch {operation = null;}
        this.#assertOpen(); record = decisionRecord(this.#read(cardId));
        if (operation !== null && !terminalOperation(operation)) operation = null;
      }
      if (operation !== null) {
        if (record.inputState === "input_pending") record = this.#closeInput(record, "invalidated");
        if (terminalOperation(operation) && record.outcome?.kind !== "operation") record = this.#setOutcome(record, {kind: "operation"});
        return {record, operation, ...(record.kind === "wallet" && snapshot !== undefined ? {snapshot} : {})};
      }
      if (record.inputState === "input_closed") {
        if (record.closeReason === "submitted" && record.outcome === null && !this.#active.has(cardId)) record = this.#setOutcome(record, source.unknown(record));
        return {record};
      }
    } else if (record.inputState === "input_closed") return {record};
    if (this.#expired(record)) return {record: this.#closeInput(record, "expired")};
    if (record.kind === "wallet_selection") {
      let selection: WalletAccountSelection;
      try {selection = await this.dependencies.domains.wallet.getAccountSelection({chainId: record.context.chainId}, this.dependencies.ownerSignal);}
      catch (error) {
        const failure = normalizeWalletError(error).failure;
        if (failure.error.code === "wallet_not_connected" || failure.error.code === "wallet_session_unusable" || failure.error.code === "wallet_account_unavailable") {
          return {record: this.#closeInput(record, "invalidated")};
        }
        return {record, ...(snapshot === undefined ? {} : {snapshot}), sourceAvailable: false};
      }
      this.#assertOpen(); record = decisionRecord(this.#read(cardId));
      if (record.kind !== "wallet_selection") throw new CardError("presentation_inconsistent");
      if (record.inputState === "input_closed") return {record};
      if (selection.connectionId !== record.context.connectionId || selection.connectionRevision !== record.context.originalConnectionRevision) {
        return {record: this.#closeInput(record, "invalidated")};
      }
      if (snapshot !== undefined) this.#admitDecisionSnapshot(record, snapshot);
      return {record, selection, ...(snapshot === undefined ? {} : {snapshot})};
    }
    if (snapshot !== undefined) return {record, snapshot};
    const material = this.dependencies.reviews.readPresentation(record.operationId!);
    if (material.status !== "available") {
      if (material.reason === "runtime_unavailable") return {record, sourceAvailable: false};
      if (material.reason !== "snapshot_missing") throw new CardError("runtime_state_unavailable");
      return {record: this.#closeInput(record, "invalidated")};
    }
    this.#admitDecisionSnapshot(record, material.value.snapshot);
    return {record, snapshot: material.value.snapshot};
  }

  get(input: unknown): Promise<CardPresentationDelivery> {
    return this.#track(async () => {
      const reference = cardReadReferenceSchema.parse(captureCanonicalJson(input));
      this.#assertOpen();
      if (reference.kind === "snapshot") return this.#delivery({state: {mode: "static", reference, record: null},
        display: {kind: "snapshot", resource: this.#resource(this.#snapshot(reference.snapshotId))}, actions: []});
      return this.#present(await this.#resolve(reference.cardId, reference.cardOpenRequestId !== undefined), reference.cardOpenRequestId !== undefined);
    });
  }
  getReference(input: unknown): ReturnType<typeof cardReferenceContract.parsePublicSuccess> {
    this.#assertOpen();
    const parsed = cardReferenceContract.parseInput(input);
    const record = decisionRecord(this.#read(parsed.cardId));
    if (record.snapshotId !== null) this.#decisionSnapshot(record);
    try {assertCardPresentationSource(record, parsed.descriptor);} catch {throw new CardError("presentation_inconsistent");}
    return cardReferenceContract.parsePublicSuccess(parsed, {kind: "card", cardId: record.cardId});
  }
  open(input: unknown): Promise<CardPresentationDelivery> {
    return this.#track(async () => {
      const {cardId} = cardOpeningSchema.parse(captureCanonicalJson(input));
      return this.#present(await this.#resolve(cardId, true), true);
    });
  }
  cancelDecision(input: unknown): Promise<CardPresentationDelivery> {
    return this.#track(async () => {
      const {cardId} = cardIdInputSchema.parse(captureCanonicalJson(input));
      const resolved = await this.#resolve(cardId);
      const record = decisionRecord(resolved.record);
      if (record.inputState === "input_closed") return this.#present(resolved);
      if (record.operationId !== null) this.#sources[record.kind].discard?.(this.dependencies.domains, record.operationId);
      return this.#present({record: this.#closeInput(record, "discarded")});
    });
  }
  cancelWait(input: unknown): Promise<CardPresentationDelivery> {
    return this.#track(async () => {
      const {cardId} = cardIdInputSchema.parse(captureCanonicalJson(input));
      const resolved = await this.#resolve(cardId);
      const record = resolved.record;
      if (record.kind === "read") {
        const call = this.#active.get(cardId);
        call?.controller.abort();
        if (call !== undefined) await call.settled;
      } else if (record.kind === "wallet" && record.closeReason === "submitted") await this.#sources.wallet.end?.(this.dependencies.domains, record);
      else if ((record.kind === "signing" || record.kind === "transaction") && record.closeReason === "submitted") {
        const call = this.#active.get(cardId);
        call?.controller.abort();
        if (call !== undefined) await call.settled;
      }
      else throw new CardError("state_conflict");
      return this.#present(await this.#resolve(cardId));
    });
  }

  action(contextInput: unknown, input: unknown, deliverySignal: AbortSignal): Promise<CardActionDelivery> {
    return this.#track(async () => {
      this.#assertOpen(deliverySignal);
      const context = cardOpeningSchema.parse(captureCanonicalJson(contextInput));
      const initial = decisionRecord((await this.#resolve(context.cardId)).record);
      this.#assertOpen(deliverySignal);
      if (initial.inputState !== "input_pending" || this.#expired(initial)) throw new CardError("state_conflict");
      const source = this.#sources[initial.kind];
      let decision: CanonicalJson | undefined;
      try {decision = captureCanonicalJson(source.decision(input));} catch {throw new CardError("invalid_input");}
      input = undefined;
      if (initial.kind === "wallet_selection") {
        const command = walletAccountSelectionContracts.select.parseInput(decision);
        if (command.connectionId !== initial.context.connectionId || command.chainId !== initial.context.chainId ||
            command.expectedConnectionRevision !== initial.context.originalConnectionRevision) throw new CardError("state_conflict");
      } else {
        if (typeof decision !== "object" || decision === null || Array.isArray(decision) || decision["initiatedBy"] !== "mcp_app") throw new CardError("state_conflict");
        const value = source.creatingValue(decision);
        if (operationToolResultEvidence(value).sha256 !== initial.resultDigest || source.describe(value)?.operationId !== initial.operationId) throw new CardError("state_conflict");
      }
      const admission = this.dependencies.store.prepareDecision(initial, createOperationId(), deliverySignal);
      const call = this.#register(initial.cardId);
      let prepared: PreparedReviewDispatch<import("./card-sources.js").CardDispatchResult> | undefined;
      try {
        this.#assertOpen(deliverySignal);
        const workSignal = call.controller.signal;
        if (source.prepareDispatch !== undefined) {
          prepared = await source.prepareDispatch(this.dependencies.domains, decision, workSignal);
          this.#assertOpen(deliverySignal);
          if (prepared.source.kind !== initial.kind || prepared.source.operationId !== initial.operationId || prepared.source.resultDigest !== initial.resultDigest) throw new CardError("presentation_inconsistent");
          if (prepared.result !== undefined) {
            const result = prepared.result;
            let presentation: CardActionDelivery["presentation"] = {status: "unavailable", cardId: initial.cardId};
            try {
              let current = decisionRecord(this.#read(initial.cardId));
              if (current.inputState === "input_pending") {
                current = this.#closeInput(current, "invalidated");
                if (result.outcome !== null) current = this.#setOutcome(current, result.outcome);
              }
              presentation = this.#present({record: current}).presentation;
            } catch {this.#storageFailed = true;}
            return admitCardActionDelivery({result: result.value, presentation});
          }
          this.dependencies.store.commitDecision(admission, prepared.source);
        }
        const pending = prepared === undefined
          ? source.dispatch(this.dependencies.domains, decision, workSignal, admission) : prepared.execute();
        decision = undefined;
        const result = await pending;
        let current: DecisionCardRecord | undefined;
        try {
          current = decisionRecord(this.#read(initial.cardId));
          if (current.inputState !== "input_closed" || current.closeReason !== "submitted") throw new CardError("presentation_inconsistent");
          if (result.outcome !== null) current = this.#setOutcome(current, result.outcome);
        } catch {this.#storageFailed = true; current = undefined;}
        let presentation: Pick<CardActionDelivery, "presentation" | "qr"> = {presentation: {status: "unavailable", cardId: initial.cardId}};
        try {if (current !== undefined) presentation = this.#present(result.operation === undefined ||
          (current.outcome?.kind === "operation" && !terminalOperation(result.operation)) ? await this.#resolve(initial.cardId, true) : {record: current, operation: result.operation}, true);}
        catch { /* A display failure never rewrites the admitted domain result. */ }
        // HTTP and MCP disposal own private delivery; they never rewrite an admitted outcome.
        return admitCardActionDelivery({result: result.value, ...presentation});
      } catch (error) {
        try {
          const current = decisionRecord(this.#read(initial.cardId));
          if (current.closeReason === "submitted" && current.outcome === null) {
            const outcome = error instanceof CardDomainError ? {kind: "failure" as const, failureCode: error.failure.error.code}
              : source.unknown(current, decision);
            this.#setOutcome(current, outcome);
          }
        } catch {this.#storageFailed = true;}
        throw error;
      } finally {
        prepared?.discard();
        this.dependencies.store.discardDecision(admission);
        decision = undefined;
        call.release();
      }
    });
  }

  #present(resolved: ResolvedCard, controls = false): CardPresentationDelivery {
    const {record, snapshot, operation, selection} = resolved;
    controls = controls && resolved.sourceAvailable !== false;
    const actions: CardPresentation["actions"] = [];
    if (record.kind === "preparing") return this.#delivery({state: cardState(record), display: {kind: "summary"}, actions});
    if (record.kind === "read") {
      if (record.preparationState === "completed") {
        if (snapshot === undefined) throw new CardError("presentation_inconsistent");
        return this.#delivery({state: cardState(record), display: {kind: "snapshot", resource: this.#resource(snapshot)}, actions});
      }
      return this.#delivery({state: cardState(record), display: {kind: "summary"}, actions});
    }
    if (record.inputState === "input_pending") {
      if (snapshot === undefined && resolved.sourceAvailable === false) return this.#delivery({state: cardState(record), display: {kind: "summary"}, actions});
      if (snapshot === undefined || snapshot.resultDigest !== record.resultDigest) throw new CardError("presentation_inconsistent");
      if (controls && (record.kind !== "wallet_selection" || selection !== undefined)) actions.push("confirm", "discard");
      return this.#delivery({state: cardState(record), display: {kind: "decision", resource: this.#resource(snapshot,
        record.snapshotId !== null ? {kind: "sqlite"} : {kind: "review_memory", operationId: record.operationId!, expiresAt: record.expiresAt!})}, actions,
        ...(selection === undefined ? {} : {selection})});
    }
    if (operation !== undefined) {
      const originalControls = controls && record.closeReason === "submitted";
      if (originalControls && operation.value.domain === "wallet" && isWalletOperationCancellableState(operation.value.state)) actions.push("stop");
      const original = record.kind === "wallet" ? snapshot ?? this.#decisionSnapshot(record) : undefined;
      if (original !== undefined) this.#admitDecisionSnapshot(record, original);
      return this.#delivery({state: cardState(record), display: {kind: "operation", value: projectCardOperation(operation.value),
        ...(original === undefined ? {} : {review: this.#resource(original)})}, actions},
        originalControls && operation.value.domain === "wallet" && operation.value.state === "awaiting_wallet_approval" && operation.qr !== undefined
          ? createWalletOperationQrMetadata(operation.value, operation.qr) : undefined);
    }
    if (controls && (record.kind === "signing" || record.kind === "transaction") && record.closeReason === "submitted" &&
        record.outcome === null && this.#active.has(record.cardId)) actions.push("stop");
    return this.#delivery({state: cardState(record), display: {kind: "summary"}, actions});
  }
  #decisionSnapshot(record: DecisionCardRecord): PresentationSnapshotRecord {
    if (record.snapshotId === null) throw new CardError("presentation_inconsistent");
    const snapshot = this.#snapshot(record.snapshotId);
    this.#admitDecisionSnapshot(record, snapshot);
    return snapshot;
  }
  #admitDecisionSnapshot(record: DecisionCardRecord, snapshot: PresentationSnapshotRecord): void {
    try {
      const source = record.snapshotId !== null ? {kind: "sqlite" as const}
        : {kind: "review_memory" as const, operationId: record.operationId!, expiresAt: record.expiresAt!};
      const admitted = admitSnapshotRecord(snapshot, source);
      assertCardPresentationSource(record, admitted.resource.descriptor);
      admitCardSourceResult(record, admitted.normalizedInput, admitted.admittedResult);
      if (record.kind === "wallet" || record.kind === "token_selection") {
        const original = this.#sources[record.kind].existing(this.dependencies.domains, record.operationId, this.dependencies.reviews);
        if (canonicalJsonStringify(original.input) !== canonicalJsonStringify(admitted.normalizedInput) ||
            canonicalJsonStringify(original.value) !== canonicalJsonStringify(admitted.admittedResult)) {
          throw new CardError("presentation_inconsistent");
        }
      }
    } catch (error) {
      if (getRuntimeOperationFailure(error)?.error.code === "runtime_state_unavailable") throw new CardError("runtime_state_unavailable");
      throw new CardError("presentation_inconsistent");
    }
  }
  #snapshot(id: string): PresentationSnapshotRecord {
    const result = this.dependencies.snapshots.read(id);
    if (result.status !== "available") throw new CardError("runtime_state_unavailable");
    return result.value;
  }
  #resource(record: PresentationSnapshotRecord, source: import("./contracts.js").PresentationSource = {kind: "sqlite"}) {
    const entry = presentationContractRegistry.requireIdentity(record.contractId, record.contractVersion);
    const input = entry.parseNormalizedInput(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(record.inputBytes)));
    return createPresentationSnapshotResource(record, input, source);
  }
  #delivery(presentation: CardPresentation, qr?: CardPresentationDelivery["qr"]): CardPresentationDelivery {
    const value = cardPresentationDeliverySchema.parse(captureCanonicalJson({presentation, ...(qr === undefined ? {} : {qr})}));
    if (utf8ByteLength(canonicalJsonStringify(captureCanonicalJson(value))) > internalCanonicalJsonResponseLimitBytes) throw new CardError("presentation_capacity_exceeded");
    return value;
  }
  #register(cardId: string): ActiveCall {
    if (this.#active.has(cardId)) throw new CardError("state_conflict");
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {settle = resolve;});
    const call = {controller, settled, release: () => {this.#active.delete(cardId); settle();}};
    this.#active.set(cardId, call);
    if (!this.#accepting) controller.abort();
    return call;
  }
  close(): Promise<void> {return this.#lifecycle.close();}
  #track<T>(run: () => Promise<T>): Promise<T> {
    let work: Promise<T>;
    work = Promise.resolve().then(run).finally(() => this.#work.delete(work));
    this.#work.add(work); return work;
  }
  get #accepting(): boolean {return this.#lifecycle.admission.isOpen && !this.dependencies.ownerSignal.aborted;}
  #assertOpen(signal?: AbortSignal): void {
    if (!this.#accepting || this.#storageFailed) throw new CardError("runtime_state_unavailable");
    if (signal?.aborted) throw new CardError("request_aborted");
  }
  #read(id: string): CardRecord {
    const record = this.dependencies.store.read(operationIdSchema.parse(id));
    if (record === null) throw new CardError("presentation_not_found"); return record;
  }
  #closeInput(record: DecisionCardRecord, reason: "expired" | "discarded" | "invalidated" | "owner_lost"): DecisionCardRecord {
    if (record.inputState === "input_closed") return record;
    return this.dependencies.store.replace(record, {...record, inputState: "input_closed", closeReason: reason, dispatchId: null}) as DecisionCardRecord;
  }
  #setOutcome(record: DecisionCardRecord, outcome: CardOutcome): DecisionCardRecord {
    if (canonicalJsonStringify(captureCanonicalJson(record.outcome)) === canonicalJsonStringify(captureCanonicalJson(outcome))) return record;
    return this.dependencies.store.replace(record, {...record, outcome}) as DecisionCardRecord;
  }
  #failRead(record: ReadCardRecord, code: string): ReadCardRecord {
    if (record.preparationState !== "pending") return record;
    return this.dependencies.store.replace(record, {...record, preparationState: "failed", snapshotId: null, outcome: {kind: "failure", failureCode: code}}) as ReadCardRecord;
  }
  #failureCode(error: unknown): string {
    return error instanceof CardError || error instanceof CardDomainError ? error.failure.error.code : getRuntimeOperationFailure(error)?.error.code ?? "internal_error";
  }
  #expired(record: DecisionCardRecord): boolean {return record.expiresAt !== null && this.dependencies.clock.now() >= record.expiresAt;}
}
