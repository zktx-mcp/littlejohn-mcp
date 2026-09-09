import {
  admitDynamicFeeTransactionRequest, canonicalJsonStringify, captureCanonicalJson,
  dynamicFeeRequestCommitment, deepFreezeValue, operationIdSchema, utcTimestampSchema,
  utf8ByteLength, type CanonicalClock, type CanonicalJson,
} from "../core/index.js";
import { exchangeReviewSchema, type ReadyExchangeReview } from "../review/contracts.js";
import { ExchangeError } from "../review/errors.js";
import { exchangeLimits } from "../review/limits.js";
import type { ConsumedExchangeRequest, ExchangeReviewMaterial, ExchangeReviewMaterialStore, ExchangeReviewReservation } from "../review/material-port.js";
import { createReviewedRequestReference } from "../review/request-reference.js";
import { exchangeApplicationContracts } from "../review/application-contracts.js";
import { createPresentationSnapshot } from "./presentation-snapshot-server.js";
import type { ReviewPresentationSource } from "./presentation-snapshot.js";

interface Slot {
  readonly token: object;
  readonly createdAt: string;
  expiresAt: string;
  material?: ExchangeReviewMaterial;
  presentationInput?: CanonicalJson;
}

export const createExchangeReviewMaterialStore = (clock: CanonicalClock): ExchangeReviewMaterialStore & ReviewPresentationSource => {
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
    if (closed) throw new ExchangeError("runtime_state_unavailable");
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
    reserve(operationId: string, createdAtInput: string, expiresAtInput: string): ExchangeReviewReservation {
      const now = admitOpen();
      const id = operationIdSchema.parse(operationId);
      const createdAt = utcTimestampSchema.parse(createdAtInput);
      const expiresAt = utcTimestampSchema.parse(expiresAtInput);
      if (createdAt > now || expiresAt <= now || expiresAt <= createdAt ||
          Date.parse(expiresAt) - Date.parse(createdAt) > exchangeLimits.reviewLifetimeMilliseconds) {
        throw new ExchangeError("exchange_review_expired");
      }
      if (slots.has(id)) throw new ExchangeError("state_conflict");
      if (slots.size >= exchangeLimits.liveReviews) throw new ExchangeError("exchange_capacity_exceeded");
      const token = Object.freeze({});
      const reservation = Object.freeze({}) as ExchangeReviewReservation;
      reservations.set(reservation, { id, token });
      slots.set(id, { token, createdAt, expiresAt });
      arm();
      return reservation;
    },
    publish(reservation: ExchangeReviewReservation, reviewInput: ReadyExchangeReview, requestInput: Parameters<ExchangeReviewMaterialStore["publish"]>[2], command: Parameters<ExchangeReviewMaterialStore["publish"]>[3]): void {
      admitOpen();
      const entry = reservations.get(reservation);
      const slot = entry === undefined ? undefined : slots.get(entry.id);
      if (entry === undefined || slot === undefined || slot.token !== entry.token || slot.material !== undefined) {
        throw new ExchangeError("exchange_review_unavailable");
      }
      const review = captureReview(reviewInput);
      const presentationInput = captureCanonicalJson(exchangeApplicationContracts.start.parseInput(command));
      exchangeApplicationContracts.start.parsePublicSuccess(presentationInput, review);
      const data = review.observation.data;
      const request = admitDynamicFeeTransactionRequest(requestInput);
      if (data.operationId !== entry.id || data.createdAt !== slot.createdAt || data.actionExpiresAt > slot.expiresAt ||
          dynamicFeeRequestCommitment(request) !== data.walletRequestCommitment ||
          utf8ByteLength(encoded(request)) > exchangeLimits.privateRequestUtf8Bytes) {
        throw new TypeError("Private material does not match its exact Review reservation.");
      }
      // Parsing may run before the final admission; expiry never publishes a
      // request after a long producer or caller-controlled capture.
      admitOpen();
      if (slots.get(entry.id) !== slot) throw new ExchangeError("exchange_review_expired");
      if (data.actionExpiresAt <= admitOpen()) throw new ExchangeError("exchange_review_expired");
      slot.expiresAt = data.actionExpiresAt;
      slot.material = Object.freeze({ review, request });
      slot.presentationInput = presentationInput;
      arm();
    },
    read(operationId: string): ExchangeReviewMaterial | null {
      admitOpen();
      return slots.get(operationIdSchema.parse(operationId))?.material ?? null;
    },
    readPresentation(operationId: string) {
      const id = operationIdSchema.parse(operationId);
      try { admitOpen(); }
      catch { return Object.freeze({ status: "unavailable" as const, reason: "runtime_unavailable" as const }); }
      const slot = slots.get(id);
      if (slot?.material === undefined || slot.presentationInput === undefined) return Object.freeze({ status: "unavailable" as const, reason: "snapshot_missing" as const });
      const snapshot = createPresentationSnapshot({ contractId: exchangeApplicationContracts.start.capabilityId, contractVersion: "1",
        normalizedInput: slot.presentationInput, admittedResult: captureCanonicalJson(slot.material.review) });
      if (snapshot.status === "unavailable") return snapshot;
      return Object.freeze({ status: "available" as const, value: Object.freeze({ operationId: id, expiresAt: slot.expiresAt, snapshot: snapshot.value }) });
    },
    consume(reviewInput: ReadyExchangeReview): ConsumedExchangeRequest {
      admitOpen();
      const review = captureReview(reviewInput);
      const id = review.observation.data.operationId;
      const material = slots.get(id)?.material;
      if (material === undefined || encoded(review) !== encoded(material.review)) throw new ExchangeError("exchange_review_unavailable");
      const reference = createReviewedRequestReference(material.review, material.request);
      admitOpen();
      if (slots.get(id)?.material !== material) throw new ExchangeError("exchange_review_expired");
      slots.delete(id);
      arm();
      return Object.freeze({ request: material.request, reference });
    },
    release(reservation: ExchangeReviewReservation): void {
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
