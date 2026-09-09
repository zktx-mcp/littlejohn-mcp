import { createApplicationFailure } from "../core/index.js";
import { normalizePinnedEvmReadFailure } from "../chain/index.js";
import { getRuntimeOperationFailure } from "../runtime/errors.js";
import { receiptActivityErrorRegistry, receiptActivityFailureCode } from "./errors.js";
export const normalizeReceiptActivityFailure = (error: unknown, signal: AbortSignal) => createApplicationFailure(
  receiptActivityErrorRegistry, receiptActivityFailureCode(error) ?? getRuntimeOperationFailure(error)?.error.code ??
    normalizePinnedEvmReadFailure(error, signal) ?? "internal_error",
);
