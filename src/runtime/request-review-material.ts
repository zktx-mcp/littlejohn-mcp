import {admitDynamicFeeTransactionRequest, dynamicFeeRequestCommitment} from "../evm/transaction-request.js";
import {canonicalJsonStringify, captureCanonicalJson, deepFreezeValue, operationIdSchema, utcTimestampSchema, utf8ByteLength, type CanonicalClock, type CanonicalJson} from "../core/index.js";
import { exchangeReviewSchema, type ReadyExchangeReview } from "../review/contracts.js";
import { RequestReviewError } from "../review/request-errors.js";
import { exchangeLimits } from "../review/limits.js";
import { requestReviewLimits } from "../review/request-limits.js";
import type { ConsumedRequest, RequestReviewMaterial, RequestReviewMaterialStore, RequestReviewReservation } from "../review/material-port.js";
import { signingApplicationContracts } from "../review/signing-application-contracts.js";
import { signingDirectDecisionSchema, signingResponseContext, signingReviewSchema, type SigningReview } from "../review/signing-contracts.js";
import { createReviewedRequestReference } from "../review/request-reference.js";
import { exchangeApplicationContracts } from "../review/application-contracts.js";
import { createPresentationSnapshot } from "./presentation-snapshot-server.js";
import type { ReviewPresentationSource } from "./presentation-snapshot.js";

interface Slot {
  readonly token: object;
  readonly createdAt: string;
  expiresAt: string;
  material?: RequestReviewMaterial;
  presentationInput?: CanonicalJson;
}

export const createRequestReviewMaterialStore = (clock: CanonicalClock): RequestReviewMaterialStore & ReviewPresentationSource => {
  const slots = new Map<string, Slot>();
  const reservations = new WeakMap<object, { id: string; token: object }>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduled: string | undefined;
  const close = (): void => {
    closed = true;
    slots.clear();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    scheduled = undefined;
  };
  const encoded = (value: unknown) => canonicalJsonStringify(captureCanonicalJson(value));
  const expire = (): string => {
    const now = clock.now();
    for (const [id, slot] of slots) if (slot.expiresAt <= now) slots.delete(id);
    return now;
  };
  const arm = (): void => {
    const next = [...slots.values()].map(({ expiresAt }) => expiresAt).sort()[0];
    if (next === scheduled) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    scheduled = next;
    if (next === undefined || closed) return;
    const delay = Date.parse(next) - Date.parse(clock.now());
    timer = setTimeout(() => {
      timer = undefined;
      scheduled = undefined;
      try { expire(); arm(); }
      catch { close(); }
    }, Math.max(0, delay));
    timer.unref();
  };
  const admitOpen = (): string => {
    if (closed) throw new RequestReviewError("runtime_state_unavailable");
    const now = expire();
    arm();
    return now;
  };
  const captureReview = (input: ReadyExchangeReview): ReadyExchangeReview => {
    const review = exchangeReviewSchema.parse(captureCanonicalJson(input));
    if (review.state !== "ready_for_wallet_review") throw new TypeError("Private material requires an executable Review.");
    return deepFreezeValue(review);
  };
  return Object.freeze({
    reserve(operationId: string, createdAtInput: string, expiresAtInput: string): RequestReviewReservation {
      const now = admitOpen();
      const id = operationIdSchema.parse(operationId);
      const createdAt = utcTimestampSchema.parse(createdAtInput);
      const expiresAt = utcTimestampSchema.parse(expiresAtInput);
      if (createdAt > now || expiresAt <= now || expiresAt <= createdAt ||
          Date.parse(expiresAt) - Date.parse(createdAt) > requestReviewLimits.reviewLifetimeMilliseconds) {
        throw new RequestReviewError("review_expired");
      }
      if (slots.has(id)) throw new RequestReviewError("state_conflict");
      if (slots.size >= requestReviewLimits.liveReviews) throw new RequestReviewError("review_capacity_exceeded");
      const token = Object.freeze({});
      const reservation = Object.freeze({}) as RequestReviewReservation;
      reservations.set(reservation, { id, token });
      slots.set(id, { token, createdAt, expiresAt });
      arm();
      return reservation;
    },
    publish(reservation: RequestReviewReservation, input: RequestReviewMaterial): void {
      admitOpen();
      const entry = reservations.get(reservation);
      const slot = entry === undefined ? undefined : slots.get(entry.id);
      if (entry === undefined || slot === undefined || slot.token !== entry.token || slot.material !== undefined) {
        throw new RequestReviewError("review_unavailable");
      }
      let material: RequestReviewMaterial;
      if (input.kind === "transaction") {
        const review = captureReview(input.review);
        const command = exchangeApplicationContracts.start.parseInput(input.command);
        exchangeApplicationContracts.start.parsePublicSuccess(command, review);
        const request = admitDynamicFeeTransactionRequest(input.request);
        if (dynamicFeeRequestCommitment(request) !== review.observation.data.walletRequestCommitment ||
            utf8ByteLength(encoded(request)) > exchangeLimits.privateRequestUtf8Bytes) {
          throw new TypeError("Private transaction material differs from its Review.");
        }
        material = deepFreezeValue({ kind: "transaction", review, request, command });
      } else {
        const review = signingReviewSchema.parse(captureCanonicalJson(input.review));
        signingDirectDecisionSchema.parse({ review, initiatedBy: "mcp_app" });
        const command = signingApplicationContracts.start.parseInput(input.command);
        signingApplicationContracts.start.parsePublicSuccess(command, review);
        material = deepFreezeValue({ kind: "signing", review, command });
      }
      const data = material.kind === "transaction" ? material.review.observation.data : material.review;
      if (data.operationId !== entry.id || data.createdAt !== slot.createdAt || data.actionExpiresAt > slot.expiresAt) {
        throw new TypeError("Private material does not match its exact Review reservation.");
      }
      // Parsing may run before the final admission; expiry never publishes a
      // request after a long producer or caller-controlled capture.
      admitOpen();
      if (slots.get(entry.id) !== slot) throw new RequestReviewError("review_expired");
      if (data.actionExpiresAt <= admitOpen()) throw new RequestReviewError("review_expired");
      slot.expiresAt = data.actionExpiresAt;
      slot.material = material;
      slot.presentationInput = captureCanonicalJson(material.command);
      arm();
    },
    read(operationId: string): RequestReviewMaterial | null {
      admitOpen();
      return slots.get(operationIdSchema.parse(operationId))?.material ?? null;
    },
    readPresentation(operationId: string) {
      const id = operationIdSchema.parse(operationId);
      try { admitOpen(); }
      catch { return Object.freeze({ status: "unavailable" as const, reason: "runtime_unavailable" as const }); }
      const slot = slots.get(id);
      if (slot?.material === undefined || slot.presentationInput === undefined) return Object.freeze({ status: "unavailable" as const, reason: "snapshot_missing" as const });
      const contract = slot.material.kind === "transaction" ? exchangeApplicationContracts.start : signingApplicationContracts.start;
      const snapshot = createPresentationSnapshot({ contractId: contract.capabilityId, contractVersion: "1",
        normalizedInput: slot.presentationInput, admittedResult: captureCanonicalJson(slot.material.review) });
      if (snapshot.status === "unavailable") return snapshot;
      return Object.freeze({ status: "available" as const, value: Object.freeze({ operationId: id, expiresAt: slot.expiresAt, snapshot: snapshot.value }) });
    },
    consume(reviewInput: ReadyExchangeReview | SigningReview): ConsumedRequest {
      admitOpen();
      const review = "observation" in reviewInput ? captureReview(reviewInput) : signingReviewSchema.parse(captureCanonicalJson(reviewInput));
      const id = "observation" in review ? review.observation.data.operationId : review.operationId;
      const material = slots.get(id)?.material;
      if (material === undefined || encoded(review) !== encoded(material.review)) throw new RequestReviewError("review_unavailable");
      const result: ConsumedRequest = material.kind === "transaction"
        ? { kind: "transaction", request: material.request, reference: createReviewedRequestReference(material.review, material.request) }
        : { kind: "signing", payload: material.review.payload, context: signingResponseContext(material.review) };
      admitOpen();
      if (slots.get(id)?.material !== material) throw new RequestReviewError("review_expired");
      slots.delete(id);
      arm();
      return deepFreezeValue(result);
    },
    release(reservation: RequestReviewReservation): void {
      const entry = reservations.get(reservation);
      if (entry !== undefined && slots.get(entry.id)?.token === entry.token) {
        slots.delete(entry.id);
        arm();
      }
      reservations.delete(reservation);
    },
    discard(operationId: string): void {
      admitOpen();
      slots.delete(operationIdSchema.parse(operationId));
      arm();
    },
    close,
  });
};
