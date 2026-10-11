import type {TransactionChainReadPort} from "../chain/transaction-reads.js";
import { z } from "zod";
import {evmAccountIdentitySchema, type EvmAccountIdentity} from "../evm/identities.js";
import {hash32Schema, jsonObject, utcTimestampSchema} from "../core/client.js";
import {chainAnchorSchema} from "../evm/primitives.js";
import {uint256DecimalSchema} from "../evm/amounts.js";
import { reviewedRequestReferenceSchema } from "../review/request-reference.js";

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
export const ledgerRevisionMaximum = (1n << 63n) - 1n;
export const ledgerRevisionSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u)
  .refine(value => BigInt(value) <= ledgerRevisionMaximum);
export const transactionDependencyEventSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("begin"), account: evmAccountIdentitySchema, revision: ledgerRevisionSchema,
    block: chainAnchorSchema, source: z.custom<TransactionChainReadPort["observationAuthority"]>(value => typeof value === "object" && value !== null && Object.isFrozen(value)), confirmedNonce: uint256DecimalSchema}).strict(),
  jsonObject({kind: z.literal("dependency"), value: unresolvedTransactionSchema}).strict(),
  jsonObject({kind: z.literal("complete"), account: evmAccountIdentitySchema, revision: ledgerRevisionSchema}).strict(),
]);
export type TransactionDependencyEvent = z.infer<typeof transactionDependencyEventSchema>;

declare const walletReceiptReservation: unique symbol;
export interface WalletReceiptReservation { readonly [walletReceiptReservation]: true }

export interface TransactionReceiptAdmissionPort {
  // Memory-only handoff identity. It writes no row and promises no disk capacity.
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
  // One bounded command emits begin, zero or more dependencies, then complete.
  // The observer cannot configure execution or storage. Failure emits no complete.
  reconcileAccount(account: EvmAccountIdentity, signal: AbortSignal,
    observe: (event: TransactionDependencyEvent) => void): Promise<void>;
  currentRevision(account: EvmAccountIdentity): string;
}
