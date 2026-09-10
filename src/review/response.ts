import type { ExchangeWalletOutcome } from "./response-contract.js";
import {
  deepFreezeValue,
} from "../core/index.js";
import type { CanonicalClock } from "../core/index.js";
import type { TransactionReceiptAdmissionPort, WalletReceiptReservation } from "../receipt-activity/admission.js";
import { walletTransactionResponseSchema, type WalletRequestAttempt } from "../wallet/request-contract.js";
import type { ReviewedRequestReference } from "./request-reference.js";

export interface ExchangeResponse {
  readonly result: Promise<ExchangeWalletOutcome>;
  readonly settled: Promise<void>;
  close(): void;
}

// This continuation receives no Review, raw request, grant or retry function.
// The only durable write it can authorize is the actually returned hash paired
// with the comparison reference fixed before that request.
export const observeExchangeResponse = (
  attempt: WalletRequestAttempt,
  referenceInput: ReviewedRequestReference,
  reservationInput: WalletReceiptReservation,
  expiresAt: string,
  clock: CanonicalClock,
  receipts: TransactionReceiptAdmissionPort,
  signal: AbortSignal,
): ExchangeResponse => {
  let reference: ReviewedRequestReference | undefined = referenceInput;
  let reservation: WalletReceiptReservation | undefined = reservationInput;
  let waiting = true;
  let closed = false;
  let knownHash: Extract<ExchangeWalletOutcome, { status: "hash_returned" }> | undefined;
  let resolve!: (value: ExchangeWalletOutcome) => void;
  const result = new Promise<ExchangeWalletOutcome>((done) => { resolve = done; });
  const endWait = (outcome: ExchangeWalletOutcome): void => {
    if (!waiting) return;
    waiting = false;
    clearTimeout(timer);
    signal.removeEventListener("abort", stopWaiting);
    resolve(deepFreezeValue(outcome));
  };
  const stopWaiting = (): void => endWait(knownHash ?? { status: "delivery_unknown" });
  const timer = setTimeout(stopWaiting, Math.max(0, Date.parse(expiresAt) - Date.parse(clock.now())));
  timer.unref();
  signal.addEventListener("abort", stopWaiting, { once: true });
  if (signal.aborted) stopWaiting();
  const release = (): void => {
    reference = undefined;
    if (reservation !== undefined) {
      const retained = reservation;
      reservation = undefined;
      receipts.releaseWalletTransaction(retained);
    }
  };
  const receive = async (input: Awaited<WalletRequestAttempt["response"]>): Promise<void> => {
    if (closed) return;
    const outcome = walletTransactionResponseSchema.parse(input);
    if (outcome.status === "hash_returned") knownHash = {
      status: "hash_returned", transactionHash: outcome.transactionHash, recording: "failed", lookup: "not_started",
    };
    if (waiting && (signal.aborted || clock.now() >= expiresAt)) endWait({ status: "delivery_unknown" });
    if (outcome.status !== "hash_returned") {
      endWait({ status: outcome.status });
      return;
    }
    if (reference === undefined || reservation === undefined) return;
    const value = { transactionHash: outcome.transactionHash, reference, receivedAt: clock.now() };
    // Store failure changes neither the observed hash nor external execution.
    try { receipts.recordWalletTransaction(reservation, value); }
    catch {
      endWait({ status: "hash_returned", transactionHash: value.transactionHash, recording: "failed", lookup: "not_started" });
      return;
    }
    release();
    if (!waiting) return;
    knownHash = { status: "hash_returned", transactionHash: value.transactionHash, recording: "recorded", lookup: "failed" };
    // The Wallet wait has ended. This is the separately bounded initial Chain
    // invocation, not an extension of the signature wait or a late-response poll.
    clearTimeout(timer);
    signal.removeEventListener("abort", stopWaiting);
    let lookup: "completed" | "failed";
    try { await receipts.inspectWalletTransaction(value, signal); lookup = "completed"; }
    catch { lookup = "failed"; }
    endWait({ status: "hash_returned", transactionHash: value.transactionHash, recording: "recorded", lookup });
  };
  const settled = attempt.response.then(receive, stopWaiting).catch(stopWaiting)
    .finally(release);
  return Object.freeze({
    result, settled,
    close(): void {
      if (closed) return;
      closed = true;
      stopWaiting();
      release();
    },
  });
};
