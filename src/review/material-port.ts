import type { DynamicFeeTransactionRequest } from "../core/client.js";
import type { ReadyExchangeReview } from "./contracts.js";
import type { ReviewedRequestReference } from "./request-reference.js";
import type { ExchangeCommand } from "./exchange.js";

declare const reservationType: unique symbol;
export interface ExchangeReviewReservation { readonly [reservationType]: true }
export interface ExchangeReviewMaterial {
  readonly review: ReadyExchangeReview;
  readonly request: DynamicFeeTransactionRequest;
}
export interface ConsumedExchangeRequest {
  readonly request: DynamicFeeTransactionRequest;
  readonly reference: ReviewedRequestReference;
}

export interface ExchangeReviewMaterialStore {
  reserve(operationId: string, createdAt: string, expiresAt: string): ExchangeReviewReservation;
  publish(reservation: ExchangeReviewReservation, review: ReadyExchangeReview, request: DynamicFeeTransactionRequest, command: ExchangeCommand): void;
  read(operationId: string): ExchangeReviewMaterial | null;
  consume(review: ReadyExchangeReview): ConsumedExchangeRequest;
  discard(operationId: string): void;
  release(reservation: ExchangeReviewReservation): void;
  close(): void;
}
