import {z} from "zod";
import {canonicalJsonStringify, operationIdByteLength, operationIdSchema, utf8ByteLength} from "../core/client.js";
import {walletConnectionIdSchema, walletConnectionSourceIdByteLength} from "./connection-contract.js";

export const walletProductRecoverySchema = z.object({operationId: operationIdSchema.nullable()}).strict();
export const walletCleanupRecoverySchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("management"), operationId: operationIdSchema}).strict(),
  z.object({kind: z.literal("expiry"), sourceId: walletConnectionIdSchema}).strict(),
]);
export type WalletProductRecovery = z.infer<typeof walletProductRecoverySchema>;
export type WalletCleanupRecovery = z.infer<typeof walletCleanupRecoverySchema>;

const operationIdBytes = Math.ceil(operationIdByteLength * 4 / 3);
const sourceIdBytes = "wallet-session:".length + Math.ceil(walletConnectionSourceIdByteLength * 4 / 3);
export const walletAuthorityRecoveryLimits = Object.freeze({
  productBytes: utf8ByteLength(canonicalJsonStringify({operationId: ""})) + operationIdBytes,
  cleanupBytes: Math.max(
    utf8ByteLength(canonicalJsonStringify({kind: "management", operationId: ""})) + operationIdBytes,
    utf8ByteLength(canonicalJsonStringify({kind: "expiry", sourceId: ""})) + sourceIdBytes,
  ),
});
