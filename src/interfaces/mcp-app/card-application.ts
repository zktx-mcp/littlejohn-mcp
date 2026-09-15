import {
  canonicalJsonStringify, captureCanonicalJson,
  operationIdSchema, utf8ByteLength, type CanonicalJson, type CanonicalClock, type ApplicationFailure,
} from "../../core/index.js";
import { createOperationId } from "../../runtime/operation-id.js";
import { internalCanonicalJsonResponseLimitBytes } from "../../runtime/http-limits.js";
import { createApplicationLifecycle } from "../../runtime/application-lifecycle.js";
import type { PresentationSnapshotRecord, PresentationSnapshotStore, ReviewPresentationSource } from "../../runtime/presentation-snapshot.js";
import { operationToolResultEvidence, createPresentationSnapshotResource, createWalletOperationQrMetadata } from "./contracts.js";
import {
  admitCardRecord, admitCardActionDelivery, cardIdInputSchema, cardOpeningSchema, cardReadReferenceSchema, cardReadInputSchema,
  assertCardPresentationSource, cardReferenceContract,
  cardState, cardPresentationDeliverySchema, readCardRecordSchema,
  type CardOutcome, type CardRecord, type DecisionCardRecord, type ReadCardRecord, type CardState, type CardReadInput,
  type CardReviewResult, type PresentationCardStore, type CardPresentation, type CardPresentationDelivery, type CardActionDelivery,
} from "./card-contract.js";
import { cardSources, CardDomainError, type CardDomains, type CardSource, type CardOperationObservation } from "./card-sources.js";
import { presentationContractRegistry, presentationContracts, type PresentationDecisionKind } from "./registry.js";
import { projectCardOperation } from "./card-projection.js";
import { isWalletOperationCancellableState, isWalletOperationTerminalState } from "../../wallet/operation-state.js";
import { CardError } from "./card-errors.js";
import type { RequestInitiatedBy } from "../../review/direct-decision.js";
import { getRuntimeOperationFailure } from "../../runtime/errors.js";
import { admitSnapshotRecord } from "./snapshot-record.js";

export interface CardReadExecutionPort {
  execute(input: CardReadInput["input"], signal: AbortSignal): Promise<CanonicalJson | ApplicationFailure>;
}
export interface CardApplicationDependencies {
  readonly ownerSignal: AbortSignal;
  readonly clock: CanonicalClock;
  readonly store: PresentationCardStore;
  readonly snapshots: PresentationSnapshotStore;
  readonly reviews: ReviewPresentationSource;
  readonly domains: CardDomains;
  readonly readExecution: CardReadExecutionPort;
}
interface ActiveCall { readonly controller: AbortController; readonly settled: Promise<void> }
interface ActionResponse { readonly value: CanonicalJson; readonly record: DecisionCardRecord | undefined; readonly operation?: CardOperationObservation }
interface ResolvedCard { readonly record: CardRecord; readonly operation?: CardOperationObservation; readonly snapshot?: PresentationSnapshotRecord }
const terminalOperation = (observation: CardOperationObservation): boolean => observation.value.domain !== "wallet" || isWalletOperationTerminalState(observation.value.state);

export class PresentationCardApplication {
  readonly #active = new Map<string, ActiveCall>();
  readonly #work = new Set<Promise<unknown>>();
  readonly #sources: Readonly<Record<PresentationDecisionKind, CardSource>> = cardSources;
  readonly #lifecycle = createApplicationLifecycle();
  #storageFailed = false;
  constructor(private readonly dependencies: CardApplicationDependencies) {
    const abortWork = (): void => {
      for (const call of this.#active.values()) call.controller.abort();
    };
    this.#lifecycle.resources.register({ close: async () => {
      dependencies.ownerSignal.removeEventListener("abort", abortWork);
      abortWork();
      await Promise.allSettled([...this.#work]);
      this.#active.clear();
    } });
    this.#lifecycle.open();
    // Owner termination precedes HTTP request draining. Response transport
    // cancellation remains independent of this application lifetime.
    dependencies.ownerSignal.addEventListener("abort", abortWork, { once: true });
    if (dependencies.ownerSignal.aborted) abortWork();
  }

  async initialize(): Promise<void> {
    this.#assertOpen();
    for (const record of this.dependencies.store.unsettled()) {
      this.#assertOpen();
      if (record.kind === "read") this.#finish(record, { kind: "failure", failureCode: "runtime_state_unavailable" });
      else if (record.phase === "ready") this.#discard(record, "owner_lost");
      else await this.#resolve(record.cardId);
    }
  }

  startReview(kind: PresentationDecisionKind, input: unknown, signal: AbortSignal): Promise<CardReviewResult> {
    return this.#track(async () => {
      this.#assertOpen(signal);
      const source = this.#sources[kind];
      const command = source.entry.parseInput(input);
      const value = source.entry.parseResult(command, await source.start(this.dependencies.domains, command, signal));
      const description = source.describe(value);
      try {
        this.#assertOpen(signal); this.#bounded(value);
        const snapshotInput = { contractId: source.entry.contractId, contractVersion: source.entry.contractVersion,
          normalizedInput: command, admittedResult: value };
        const prepared = this.dependencies.snapshots.prepare(snapshotInput);
        if (prepared.status === "unavailable") throw new CardError(prepared.reason === "capacity_exceeded" ? "presentation_capacity_exceeded" : "runtime_state_unavailable");
        const durable = source.entry.retention === "sqlite";
        const record = description === null ? null : admitCardRecord({
          cardId: createOperationId(), kind, contractVersion: source.entry.contractVersion,
          operationId: description.operationId, resultDigest: prepared.value.resultDigest,
          snapshotId: durable ? prepared.value.snapshotId : null, firstCardOpenRequestId: null,
          expiresAt: description.expiresAt, phase: description.outcome === null ? "ready" : "closed", outcome: description.outcome,
          ...(description.context === undefined ? {} : { context: description.context }),
        });
        if (record !== null) this.#bounded(cardState(record));
        if (durable) {
          const committed = this.dependencies.snapshots.commit(snapshotInput);
          if (committed.status === "unavailable") throw new CardError(committed.reason === "capacity_exceeded" ? "presentation_capacity_exceeded" : "runtime_state_unavailable");
          if (committed.value.snapshotId !== prepared.value.snapshotId || committed.value.resultDigest !== prepared.value.resultDigest || committed.value.inputDigest !== prepared.value.inputDigest) throw new CardError("presentation_inconsistent");
        }
        const stored = record === null ? null : this.dependencies.store.insert(record);
        const result: CardReviewResult = { value, reference: stored === null ? null : { kind: "card", cardId: stored.cardId } };
        this.#bounded(result); return result;
      } catch (error) {
        if (description !== null) source.discard?.(this.dependencies.domains, description.operationId);
        throw error;
      }
    });
  }

  async startRead(input: unknown, signal: AbortSignal): Promise<{ reference: { kind: "card"; cardId: string } }> {
    this.#assertOpen(signal);
    const request = cardReadInputSchema.parse(captureCanonicalJson(input));
    const record = readCardRecordSchema.parse(this.dependencies.store.insert(readCardRecordSchema.parse({
      cardId: createOperationId(), kind: "read", contractVersion: "1", request, phase: "pending", outcome: null,
    })));
    const call = this.#register(record.cardId);
    void this.#track(async () => {
      try {
        this.#assertOpen(call.controller.signal);
        const result = await this.dependencies.readExecution.execute(request.input, call.controller.signal);
        const current = this.#read(record.cardId);
        if (current.kind !== "read") throw new CardError("presentation_inconsistent");
        if (current.phase === "closed") return;
        if (call.controller.signal.aborted) this.#finish(current, { kind: "failure", failureCode:
          this.#accepting ? "request_aborted" : "runtime_state_unavailable" });
        else if (result !== null && typeof result === "object" && "ok" in result && result.ok === false) {
          const failure = result as ApplicationFailure;
          this.#finish(current, { kind: "failure", failureCode: failure.error.code });
        } else {
          const admitted = presentationContracts.stockTokenTradeHistory.parseResult(request.input, result);
          this.dependencies.store.completeRead(current, {
            contractId: request.capabilityId, contractVersion: current.contractVersion,
            normalizedInput: captureCanonicalJson(request.input), admittedResult: admitted,
          });
        }
      } catch (error) {
        try {
          const current = this.#read(record.cardId);
          if (current.phase !== "closed") this.#finish(current, { kind: "failure", failureCode:
            error instanceof CardError ? error.failure.error.code : getRuntimeOperationFailure(error)?.error.code ?? "internal_error" });
        } catch { this.#storageFailed = true; }
      } finally { call.release(); }
    });
    return { reference: { kind: "card", cardId: record.cardId } };
  }

  async #resolve(cardId: string, openingId?: string, publication?: ActionResponse): Promise<ResolvedCard> {
    this.#assertOpen();
    let record = this.#read(cardId);
    if (record.kind === "read") {
      return { record: record.phase === "closed" || this.#active.has(cardId) ? record
        : this.#finish(record, { kind: "failure", failureCode: "runtime_state_unavailable" }) };
    }
    if (record.phase === "closed" && record.outcome?.kind !== "operation") return { record };
    const source = this.#sources[record.kind];
    if (source.operation !== undefined) {
      let operation: CardOperationObservation | null | undefined = publication?.operation;
      const includeQr = record.kind === "wallet" && record.phase !== "closed" && openingId !== undefined && openingId === record.firstCardOpenRequestId;
      if (operation === undefined || (includeQr && operation.value.domain === "wallet" && operation.value.state === "awaiting_wallet_approval")) {
        try { operation = await source.operation(this.dependencies.domains, record, includeQr); }
        catch (error) {
          this.#assertOpen(); record = this.#read(cardId);
          if (record.phase === "closed") return { record };
          throw error;
        }
        this.#assertOpen(); record = this.#read(cardId);
      }
      if (record.kind === "read") throw new CardError("presentation_inconsistent");
      if (record.phase === "closed") {
        if (record.outcome?.kind !== "operation") return { record };
        if (operation !== null && !terminalOperation(operation)) {
          // The immutable terminal DB fact has overtaken the awaited observation.
          try { operation = await source.operation(this.dependencies.domains, record); }
          catch { operation = null; }
          this.#assertOpen(); record = this.#read(cardId);
        }
        return { record, ...(operation !== null && terminalOperation(operation) ? { operation } : {}) };
      }
      if (operation !== null) {
        record = terminalOperation(operation) ? this.#finish(record, { kind: "operation" }) : this.#change(record, { phase: "pending" });
      } else if (record.phase === "ready" && this.#expired(record)) record = this.#discard(record, "expired");
      else if (record.phase !== "ready" && !this.#active.has(cardId)) record = this.#finish(record, source.unknown(record.operationId));
      return { record, ...(operation === null ? {} : { operation }) };
    }
    if (record.phase === "ready") {
      if (this.#expired(record)) return { record: this.#discard(record, "expired") };
      const material = this.dependencies.reviews.readPresentation(record.operationId);
      if (material.status === "unavailable") {
        if (material.reason !== "snapshot_missing") throw new CardError("runtime_state_unavailable");
        return { record: this.#finish(record, { kind: "decision", reason: "source_unavailable" }) };
      }
      if (material.value.snapshot.resultDigest !== record.resultDigest) throw new CardError("presentation_inconsistent");
      return { record, snapshot: material.value.snapshot };
    }
    return { record: !this.#active.has(cardId) ? this.#finish(record, source.unknown(record.operationId)) : record };
  }

  #presentationData(resolved: ResolvedCard, snapshot?: PresentationSnapshotRecord): ResolvedCard {
    const record = resolved.record;
    const snapshotId = record.kind === "read" ? record.outcome?.kind === "snapshot" ? record.outcome.snapshotId : null
      : record.phase === "ready" ? record.snapshotId : null;
    const selected = resolved.snapshot ?? snapshot ?? (snapshotId === null ? undefined : this.#snapshot(snapshotId));
    if (record.phase === "ready" && (selected === undefined || selected.resultDigest !== record.resultDigest)) throw new CardError("presentation_inconsistent");
    return { ...resolved, ...(selected === undefined ? {} : { snapshot: selected }) };
  }

  async #readPresentation(cardId: string, openingId?: string, publication?: ActionResponse, snapshot?: PresentationSnapshotRecord): Promise<CardPresentationDelivery> {
    return this.#present(this.#presentationData(await this.#resolve(cardId, openingId, publication), snapshot), openingId);
  }

  get(input: unknown): Promise<CardPresentationDelivery> {
    return this.#track(async () => {
    const reference = cardReadReferenceSchema.parse(captureCanonicalJson(input));
    this.#assertOpen();
    if (reference.kind === "snapshot") {
      const snapshot = this.#snapshot(reference.snapshotId);
      const entry = presentationContractRegistry.requireIdentity(snapshot.contractId, snapshot.contractVersion);
      if (entry.cardKind !== undefined) {
        const admitted = admitSnapshotRecord(snapshot);
        const description = this.#sources[entry.cardKind].describe(admitted.admittedResult);
        if (description !== null) {
          const saved = this.getReference({ operationId: description.operationId, descriptor: admitted.resource.descriptor });
          return this.#readPresentation(saved.cardId, undefined, undefined, snapshot);
        }
      }
      return this.#delivery({ state: { mode: "static", reference, record: null },
        display: { kind: "snapshot", resource: this.#resource(snapshot) }, actions: [] });
    }
    return this.#readPresentation(reference.cardId, reference.cardOpenRequestId);
    });
  }

  getReference(input: unknown): ReturnType<typeof cardReferenceContract.parsePublicSuccess> {
    this.#assertOpen();
    const source = cardReferenceContract.parseInput(input);
    let kind: PresentationDecisionKind | undefined;
    try { kind = presentationContractRegistry.requireIdentity(source.descriptor.contractId, source.descriptor.contractVersion).cardKind; }
    catch { throw new CardError("presentation_inconsistent"); }
    if (kind === undefined) throw new CardError("presentation_inconsistent");
    const record = this.dependencies.store.find(kind, source.operationId);
    if (record === null) throw new CardError("presentation_not_found");
    if (record.kind === "read" || record.operationId !== source.operationId) throw new CardError("presentation_inconsistent");
    try { assertCardPresentationSource(record, source.descriptor); }
    catch { throw new CardError("presentation_inconsistent"); }
    return cardReferenceContract.parsePublicSuccess(source, { kind: "card", cardId: record.cardId });
  }

  open(input: unknown): Promise<CardPresentationDelivery> {
    return this.#track(async () => {
      this.#assertOpen();
      const { cardId, cardOpenRequestId } = cardOpeningSchema.parse(input);
      let record = this.#read(cardId);
      if (record.kind !== "read" && record.phase === "ready" && record.firstCardOpenRequestId !== null && record.firstCardOpenRequestId !== cardOpenRequestId) {
        return this.#present({ record: this.#discard(record, "returned") }, cardOpenRequestId);
      }
      const resolved = await this.#resolve(cardId, cardOpenRequestId);
      // Admission resumes after an await; another instance may have admitted this same ID.
      record = this.#read(cardId);
      if (record.phase === "closed" && record.outcome?.kind === "operation" &&
          (resolved.operation === undefined || !terminalOperation(resolved.operation))) {
        return this.#readPresentation(cardId, cardOpenRequestId);
      }
      if (record.kind !== "read" && record.phase === "ready") {
        if (record.firstCardOpenRequestId === null) record = this.#change(record, { firstCardOpenRequestId: cardOpenRequestId });
        else if (record.firstCardOpenRequestId !== cardOpenRequestId) record = this.#discard(record, "returned");
      }
      return this.#present(this.#presentationData({ ...resolved, record }), cardOpenRequestId);
    });
  }

  cancelDecision(input: unknown): Promise<CardPresentationDelivery> {
    return this.#track(async () => {
      const { cardId } = cardIdInputSchema.parse(input);
      const resolved = await this.#resolve(cardId);
      const record = resolved.record;
      if (record.kind === "read" || record.phase !== "ready") {
        if (record.phase !== "closed") throw new CardError("state_conflict");
        return this.#present(this.#presentationData(resolved));
      }
      return this.#present({ record: this.#discard(record, "discarded") });
    });
  }

  cancelWait(input: unknown): Promise<CardPresentationDelivery> {
    return this.#track(async () => {
      const { cardId } = cardIdInputSchema.parse(input);
      const resolved = await this.#resolve(cardId);
      const record = resolved.record;
      if (record.kind !== "read" && record.phase === "ready") return this.#present({ record: this.#discard(record, "discarded") });
      if (record.phase === "closed") return this.#present(this.#presentationData(resolved));
      const call = this.#active.get(cardId);
      if (record.kind === "wallet") await this.#sources.wallet.end?.(this.dependencies.domains, record);
      else if (call !== undefined) { call.controller.abort(); await call.settled; }
      else if (record.kind !== "read") throw new CardError("state_conflict");
      return this.#readPresentation(cardId);
    });
  }

  async cancelReview(kind: "signing" | "transaction", operationId: string): Promise<CanonicalJson> {
    this.#assertOpen();
    const id = operationIdSchema.parse(operationId);
    const stored = this.dependencies.store.find(kind, id);
    const record = stored === null ? null : (await this.#resolve(stored.cardId)).record;
    const result = this.#sources[kind].discard!(this.dependencies.domains, id);
    if (record?.phase === "ready") this.#finish(record, { kind: "decision", reason: "discarded" });
    return captureCanonicalJson(result);
  }

  action(contextInput: unknown, input: unknown, signal: AbortSignal): Promise<CardActionDelivery> {
    return this.#track(async () => {
      this.#assertOpen(signal);
      const context = cardOpeningSchema.parse(contextInput);
      const { record } = await this.#resolve(context.cardId);
      this.#assertOpen(signal);
      if (record.kind === "read" || record.firstCardOpenRequestId !== context.cardOpenRequestId) throw new CardError("state_conflict");
      const source = this.#sources[record.kind];
      let decision: CanonicalJson | undefined = this.#admitDecision(source, input, "mcp_app", record);
      input = undefined;
      const pending = this.#dispatch(source, record, decision, signal, "mcp_app"); decision = undefined;
      const response = await pending;
      let display: Pick<CardActionDelivery, "presentation" | "qr"> = { presentation: { status: "unavailable", cardId: context.cardId } };
      if (response.record !== undefined) {
        try { display = await this.#readPresentation(context.cardId, context.cardOpenRequestId, response); }
        catch { /* A display failure does not rewrite the admitted domain result. */ }
      }
      if (signal.aborted) throw new CardError("request_aborted");
      return admitCardActionDelivery({ result: response.value, ...display });
    });
  }

  decideWithoutView(kind: PresentationDecisionKind, input: unknown, signal: AbortSignal): Promise<CanonicalJson> {
    return this.#track(async () => {
      this.#assertOpen(signal);
      const source = this.#sources[kind];
      let decision: (CanonicalJson & { readonly review: unknown }) | undefined = this.#admitDecision(source, input, "cli");
      input = undefined;
      const description = source.describe(source.creatingValue(decision.review));
      if (description === null) throw new CardError("state_conflict");
      const stored = this.dependencies.store.find(kind, description.operationId);
      if (stored === null) {
        const pending = source.dispatch(this.dependencies.domains, decision, description.operationId, signal);
        decision = undefined; return (await pending).value;
      }
      const { record } = await this.#resolve(stored.cardId);
      this.#assertOpen(signal);
      if (record.kind === "read") throw new CardError("state_conflict");
      this.#admitDecision(source, decision, "cli", record);
      const pending = this.#dispatch(source, record, decision, signal, "cli"); decision = undefined;
      return (await pending).value;
    });
  }

  #admitDecision(source: CardSource, input: unknown, initiatedBy: RequestInitiatedBy, record?: DecisionCardRecord): CanonicalJson & { readonly review: unknown } {
    let parsed: ReturnType<CardSource["decision"]>;
    try { parsed = source.decision(input); } catch { throw new CardError("invalid_input"); }
    if (parsed.initiatedBy !== initiatedBy) throw new CardError("state_conflict");
    if (record !== undefined) {
      const creating = source.creatingValue(parsed.review);
      if (record.phase !== "ready" || this.#expired(record) || operationToolResultEvidence(creating).sha256 !== record.resultDigest ||
          source.describe(creating)?.operationId !== record.operationId) throw new CardError("state_conflict");
    }
    return captureCanonicalJson(parsed) as CanonicalJson & { readonly review: unknown };
  }

  async #dispatch(source: CardSource, record: DecisionCardRecord, decision: CanonicalJson | undefined,
    deliverySignal: AbortSignal, initiatedBy: RequestInitiatedBy): Promise<ActionResponse> {
    record = this.#change(record, { phase: "dispatching" }) as DecisionCardRecord;
    const call = this.#register(record.cardId);
    try {
      const workSignal = initiatedBy === "cli" ? AbortSignal.any([deliverySignal, call.controller.signal]) : call.controller.signal;
      this.#assertOpen(workSignal);
      const pending = source.dispatch(this.dependencies.domains, decision, record.operationId, workSignal);
      decision = undefined;
      try {
        const current = this.#read(record.cardId);
        if (current.phase !== "closed") this.#change(current, { phase: "pending" });
      } catch { this.#storageFailed = true; call.controller.abort(); }
      const result = await pending;
      let published: DecisionCardRecord | undefined;
      try {
        const current = this.#read(record.cardId);
        if (current.kind === "read") throw new CardError("presentation_inconsistent");
        if (current.phase !== "closed" && result.outcome !== null) published = this.#finish(current, result.outcome) as DecisionCardRecord;
        else if (current.phase === "closed" && result.outcome !== null && canonicalJsonStringify(captureCanonicalJson(current.outcome)) !==
          canonicalJsonStringify(captureCanonicalJson(result.outcome))) throw new CardError("request_aborted");
        else published = current;
      } catch (error) { if (error instanceof CardError && error.failure.error.code === "request_aborted") throw error; this.#storageFailed = true; }
      // The response's private value is never retained for another transport or View.
      if (initiatedBy === "mcp_app" && deliverySignal.aborted) throw new CardError("request_aborted");
      return { value: result.value, record: published, ...(result.operation === undefined ? {} : { operation: result.operation }) };
    } catch (error) {
      try {
        const current = this.#read(record.cardId);
        if (current.phase !== "closed") this.#finish(current, error instanceof CardDomainError
          ? { kind: "failure", failureCode: error.failure.error.code } : source.unknown(record.operationId));
      } catch { this.#storageFailed = true; }
      throw error;
    } finally { decision = undefined; call.release(); }
  }

  #present(resolved: ResolvedCard, openingId?: string): CardPresentationDelivery {
    const { record, operation, snapshot } = resolved;
    const actions: CardPresentation["actions"] = [];
    if (record.kind === "read") {
      if (record.phase === "pending" && this.#active.has(record.cardId)) actions.push("stop");
      if (record.outcome?.kind === "snapshot") {
        if (snapshot === undefined) throw new CardError("presentation_inconsistent");
        return this.#delivery({ state: cardState(record), actions, display: { kind: "snapshot", resource: this.#resource(snapshot) } });
      }
      return this.#delivery({ state: cardState(record), actions, display: { kind: "summary" } });
    }
    if (record.phase === "ready") {
      if (snapshot === undefined || snapshot.resultDigest !== record.resultDigest) throw new CardError("presentation_inconsistent");
      if (openingId !== undefined && openingId === record.firstCardOpenRequestId) actions.push("confirm", "discard");
      return this.#delivery({ state: cardState(record), actions, display: { kind: "review", resource: this.#resource(snapshot,
        record.snapshotId !== null ? { kind: "sqlite" } : { kind: "review_memory", operationId: record.operationId, expiresAt: record.expiresAt! }) } });
    }
    if ((record.kind === "wallet" || record.kind === "token_selection") && (record.outcome === null || record.outcome.kind === "operation") && operation !== undefined) {
      const value = operation.value;
      if (openingId !== undefined && value.domain === "wallet" && record.phase !== "closed" && isWalletOperationCancellableState(value.state)) actions.push("stop");
      const presentation: CardPresentation = { state: cardState(record), display: { kind: "operation", value: projectCardOperation(value) }, actions };
      return this.#delivery(presentation, value.domain === "wallet" && value.state === "awaiting_wallet_approval" &&
        openingId !== undefined && openingId === record.firstCardOpenRequestId && operation.qr !== undefined
        ? createWalletOperationQrMetadata(value, operation.qr) : undefined);
    }
    if (openingId !== undefined && record.phase !== "closed" && this.#active.has(record.cardId)) actions.push("stop");
    return this.#delivery({ state: cardState(record), display: { kind: "summary" }, actions });
  }

  #snapshot(snapshotId: string): PresentationSnapshotRecord {
    const stored = this.dependencies.snapshots.read(snapshotId);
    if (stored.status === "unavailable") throw new CardError("runtime_state_unavailable");
    return stored.value;
  }
  #resource(record: PresentationSnapshotRecord, source: import("./contracts.js").PresentationSource = { kind: "sqlite" }) {
    const entry = presentationContractRegistry.requireIdentity(record.contractId, record.contractVersion);
    const input = entry.parseNormalizedInput(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record.inputBytes)));
    return createPresentationSnapshotResource(record, input, source);
  }
  #delivery(presentation: CardPresentation, qr?: CardPresentationDelivery["qr"]): CardPresentationDelivery {
    const value = cardPresentationDeliverySchema.parse(captureCanonicalJson({ presentation, ...(qr === undefined ? {} : { qr }) }));
    this.#bounded(value); return value;
  }
  #register(cardId: string): ActiveCall & { release(): void } {
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const call = { controller, settled };
    this.#active.set(cardId, call);
    if (!this.#accepting) controller.abort();
    return { ...call, release: () => { this.#active.delete(cardId); settle(); } };
  }
  close(): Promise<void> { return this.#lifecycle.close(); }
  #track<T>(run: () => Promise<T>): Promise<T> {
    let work: Promise<T>;
    work = Promise.resolve().then(run).finally(() => this.#work.delete(work));
    this.#work.add(work); return work;
  }
  get #accepting(): boolean { return this.#lifecycle.admission.isOpen && !this.dependencies.ownerSignal.aborted; }
  #assertOpen(signal?: AbortSignal): void {
    if (!this.#accepting || this.#storageFailed) throw new CardError("runtime_state_unavailable");
    if (signal?.aborted) throw new CardError("request_aborted");
  }
  #bounded(value: unknown): void {
    if (utf8ByteLength(canonicalJsonStringify(captureCanonicalJson(value))) > internalCanonicalJsonResponseLimitBytes) throw new CardError("presentation_capacity_exceeded");
  }
  #read(cardId: string): CardRecord {
    const record = this.dependencies.store.read(operationIdSchema.parse(cardId));
    if (record === null) throw new CardError("presentation_not_found"); return record;
  }
  #change(record: CardRecord, update: Partial<{ phase: CardRecord["phase"]; outcome: CardOutcome | null; firstCardOpenRequestId: string }>): CardRecord {
    const next = admitCardRecord({ ...record, ...update });
    if (canonicalJsonStringify(captureCanonicalJson(record)) === canonicalJsonStringify(captureCanonicalJson(next))) return record;
    return this.dependencies.store.replace(record, next);
  }
  #finish(record: CardRecord, outcome: CardOutcome): CardRecord { return this.#change(record, { phase: "closed", outcome }); }
  #expired(record: DecisionCardRecord): boolean { return record.expiresAt !== null && this.dependencies.clock.now() >= record.expiresAt; }
  #discard(record: DecisionCardRecord, reason: "returned" | "discarded" | "expired" | "owner_lost"): CardRecord {
    this.#sources[record.kind].discard?.(this.dependencies.domains, record.operationId);
    return this.#finish(record, { kind: "decision", reason });
  }
}
