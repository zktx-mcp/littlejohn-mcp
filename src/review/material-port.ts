import type {DynamicFeeTransactionRequest} from "../evm/transaction-request.js";
import type { ReadyExchangeReview } from "./contracts.js";
import type { ReviewedRequestReference } from "./request-reference.js";
import type { ExchangeCommand } from "./exchange.js";
import type { SigningCommand, SigningReview, SigningResponseContext } from "./signing-contracts.js";
import type { SigningPayload } from "./signing-payload.js";

declare const reservationType: unique symbol;
export interface RequestReviewReservation { readonly [reservationType]: true }
export interface ExchangeReviewMaterial {
  readonly review: ReadyExchangeReview;
  readonly request: DynamicFeeTransactionRequest;
}
export interface ConsumedExchangeRequest {
  readonly request: DynamicFeeTransactionRequest;
  readonly reference: ReviewedRequestReference;
}

export type RequestReviewMaterial =
  | Readonly<{ kind: "transaction"; review: ReadyExchangeReview; request: DynamicFeeTransactionRequest; command: ExchangeCommand }>
  | Readonly<{ kind: "signing"; review: SigningReview; command: SigningCommand }>;
export type ConsumedRequest =
  | (Readonly<{ kind: "transaction" }> & ConsumedExchangeRequest)
  | Readonly<{ kind: "signing"; payload: SigningPayload; context: SigningResponseContext }>;
export interface RequestReviewMaterialStore {
  reserve(operationId: string, createdAt: string, expiresAt: string): RequestReviewReservation;
  publish(reservation: RequestReviewReservation, material: RequestReviewMaterial): void;
  read(operationId: string): RequestReviewMaterial | null;
  consume(review: ReadyExchangeReview | SigningReview): ConsumedRequest;
  discard(operationId: string): void;
  release(reservation: RequestReviewReservation): void;
  close(): void;
}
