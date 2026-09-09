import { z } from "zod";
import {
  evmAccountIdentitySchema, hash32Schema, jsonObject,
  uint256DecimalSchema, utcTimestampSchema,
  type EvmAccountIdentity,
} from "../core/client.js";
import { reviewedRequestReferenceSchema } from "../review/request-reference.js";
import { receiptActivityLimits } from "./limits.js";

export const receivedWalletTransactionSchema = jsonObject({
  transactionHash: hash32Schema,
  reference: reviewedRequestReferenceSchema,
  receivedAt: utcTimestampSchema,
}).strict();
export type ReceivedWalletTransaction = z.infer<typeof receivedWalletTransactionSchema>;

// This is the complete dependency observation for a new command, not a ledger
// record or a value from which a consumer reconstructs one. Included transactions
// are settled nonce dependencies even when their execution reverted.
export const unresolvedTransactionSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("pending"), transactionHash: hash32Schema, nonce: uint256DecimalSchema }).strict(),
  jsonObject({ status: z.literal("not_found"), transactionHash: hash32Schema, nonce: uint256DecimalSchema.nullable() }).strict(),
  jsonObject({ status: z.literal("unavailable"), transactionHash: hash32Schema, nonce: uint256DecimalSchema.nullable() }).strict(),
]);
export const accountTransactionDependenciesSchema = jsonObject({
  account: evmAccountIdentitySchema,
  unresolved: z.array(unresolvedTransactionSchema).max(receiptActivityLimits.records),
}).strict();
export type AccountTransactionDependencies = z.infer<typeof accountTransactionDependenciesSchema>;

declare const walletReceiptReservation: unique symbol;
export interface WalletReceiptReservation { readonly [walletReceiptReservation]: true }

export interface TransactionReceiptAdmissionPort {
  // Pure in-memory capacity admission. It writes no row or request marker.
  reserveWalletTransaction(): WalletReceiptReservation;
  // Releasing an already consumed/released reservation is harmless.
  releaseWalletTransaction(reservation: WalletReceiptReservation): void;
  // The hash/reference pair is either committed together or the call throws.
  // This method never performs a chain lookup or another wallet request.
  recordWalletTransaction(reservation: WalletReceiptReservation, value: ReceivedWalletTransaction): void;
  // The initial lookup belongs to the original still-waiting command. It
  // publishes the owner's canonical observation; consumers read that record
  // through Activity, never reconstruct it from a Wallet outcome.
  inspectWalletTransaction(value: ReceivedWalletTransaction, signal: AbortSignal): Promise<void>;
  // One bounded explicit command; unavailable evidence remains unresolved.
  reconcileAccount(account: EvmAccountIdentity, signal: AbortSignal): Promise<AccountTransactionDependencies>;
  currentDependencies(account: EvmAccountIdentity): AccountTransactionDependencies;
}
