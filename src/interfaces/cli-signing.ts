import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {addressTargetSchema, type AddressTarget} from "../evm/address-target.js";
import {captureCanonicalJson, operationIdSchema, type ApplicationFailure} from "../core/index.js";
import { requestBodyLimitBytes } from "../runtime/http-limits.js";
import { signingCommandSchema, signingResponseContext, createSigningCompletion, type SigningReview } from "../review/signing-contracts.js";
import { signingInterfaceErrorMappings } from "../review/signing-error-mappings.js";
import { createSigningFailure } from "../review/signing-errors.js";
import { signingBindings } from "./signing-bindings.js";
import { signingOutcomeText, signingReviewText } from "./signing-presentation.js";
import { readCliDecision, type CliDecisionPort } from "./cli-operation.js";
import { deliveryUnknownCliExitCode } from "./delivery-exit.js";
import type { LocalOperationClient, LocalOperationResult } from "./operation-client.js";

export type SigningCliCommand =
  | Readonly<{ kind: "start"; account: AddressTarget; file: string }>
  | Readonly<{ kind: "get_review" | "cancel_review"; operationId: string }>;
const invalid = (): never => { throw new TypeError("Signing command input is invalid."); };
export const parseSigningCliCommand = (args: readonly string[]): SigningCliCommand => {
  const [domain, action, ...rest] = args;
  if (domain !== "signing") return invalid();
  if (action === "get-review" || action === "cancel-review") {
    if (rest.length !== 1) return invalid();
    return { kind: action === "get-review" ? "get_review" : "cancel_review", operationId: operationIdSchema.parse(rest[0]) };
  }
  if (action !== "start") return invalid();
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index]!;
    if (flags.has(key) || !["--active", "--address", "--file"].includes(key)) return invalid();
    const value = key === "--active" ? "true" : rest[++index];
    if (value === undefined || value.length === 0 || value.startsWith("--")) return invalid();
    flags.set(key, value);
  }
  if (flags.has("--active") === flags.has("--address") || !flags.has("--file")) return invalid();
  return { kind: "start", account: addressTargetSchema.parse(flags.has("--active") ? { kind: "active_wallet" } : { kind: "address", address: flags.get("--address") }), file: flags.get("--file")! };
};

const readPayload = async (file: string, signal: AbortSignal): Promise<unknown> => {
  signal.throwIfAborted();
  const source = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal.throwIfAborted();
    const stat = await source.stat();
    signal.throwIfAborted();
    if (!stat.isFile() || stat.size > requestBodyLimitBytes) return invalid();
    const bytes = Buffer.alloc(requestBodyLimitBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await source.read(bytes, length, bytes.length - length, null);
      signal.throwIfAborted();
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > requestBodyLimitBytes) return invalid();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { await source.close(); }
};

export interface SigningCliOutputPort extends CliDecisionPort {
  writeError(value: string): void;
  writeSignature(value: string, expiresAt: string, signal: AbortSignal): Promise<"written" | "unavailable">;
}

export const runSigningCliCommand = async (client: LocalOperationClient, command: SigningCliCommand,
  output: SigningCliOutputPort): Promise<number> => {
  const fail = (failure: ApplicationFailure): number => {
    output.writeError(`${failure.error.code}: ${failure.error.message}\n`);
    return signingInterfaceErrorMappings.get(failure.error.code).cliExitCode;
  };
  if (command.kind !== "start") {
    if (command.kind === "get_review") {
      const result = await client.invoke(signingBindings.get.identity, { operationId: command.operationId }, output.interruptSignal);
      if ("status" in result) return deliveryUnknownCliExitCode;
      if (!result.ok) return fail(result.failure);
      output.writeOutput(`${result.value.review === null ? "The decision is unavailable." : signingReviewText(result.value.review)}\n`);
    } else {
      const result = await client.invoke(signingBindings.cancel.identity, { operationId: command.operationId }, output.interruptSignal);
      if ("status" in result) { output.writeError("Discard was not confirmed. The original decision keeps its expiry.\n"); return deliveryUnknownCliExitCode; }
      if (!result.ok) return fail(result.failure);
      output.writeOutput(`${result.value.status === "discarded" ? "Decision discarded." : "The decision is unavailable."}\n`);
    }
    return 0;
  }
  if (!output.inputIsTTY || !output.outputIsTTY) return fail(createSigningFailure("interactive_terminal_required"));
  let created: LocalOperationResult<SigningReview> | undefined;
  let input: unknown;
  try {
    const payload = await readPayload(command.file, output.interruptSignal);
    output.interruptSignal.throwIfAborted();
    input = signingCommandSchema.parse(captureCanonicalJson({ account: command.account, payload }));
  } catch { return fail(createSigningFailure(output.interruptSignal.aborted ? "request_aborted" : "invalid_input")); }
  try {
    const pending = client.invoke(signingBindings.start.identity, input, output.interruptSignal);
    input = undefined; created = await pending;
  } catch { return fail(createSigningFailure("internal_error")); }
  if ("status" in created) return fail(createSigningFailure("runtime_state_unavailable"));
  if (!created.ok) return fail(created.failure);
  let review: SigningReview | undefined = created.value;
  created = undefined;
  output.writeOutput(`${signingReviewText(review)}\n`);
  const context = signingResponseContext(review);
  const expiresAt = review.actionExpiresAt;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.max(0, Date.parse(review.actionExpiresAt) - Date.now()));
  timer.unref();
  try {
    const answer = await readCliDecision({ ...output, interruptSignal: AbortSignal.any([output.interruptSignal, deadline.signal]) }, "Request this data signature in the Wallet? [y/N] ");
    if (answer !== "accepted" || output.interruptSignal.aborted || deadline.signal.aborted) {
      review = undefined;
      const result = await client.invoke(signingBindings.cancel.identity, { operationId: context.operationId });
      output.writeOutput("This CLI decision sent no signature request. " + ("status" in result || !result.ok
        ? "Discard was not confirmed; the decision keeps its original expiry.\n"
        : result.value.status === "discarded" ? "Decision discarded.\n" : "The decision was already unavailable.\n"));
      return 0;
    }
    const pending = client.invoke(signingBindings.request.identity, { review, initiatedBy: "cli" }, AbortSignal.any([output.interruptSignal, deadline.signal]));
    review = undefined;
    let result: Awaited<typeof pending> | undefined = await pending;
    if ("status" in result) { output.writeError(`${signingOutcomeText(createSigningCompletion(context, "delivery_unknown").outcome)}\n`); return deliveryUnknownCliExitCode; }
    if (!result.ok) return fail(result.failure);
    const outcome = result.value.outcome;
    let signature: string | undefined = "signature" in result.value ? result.value.signature : undefined;
    result = undefined;
    try {
      output.writeOutput(`${signingOutcomeText(outcome)}\n`);
      if (outcome.status !== "verified") return outcome.status === "delivery_unknown" ? deliveryUnknownCliExitCode : 2;
      if (signature === undefined) throw new TypeError("The admitted verified response omitted its signature.");
      const delivery = output.writeSignature(signature, expiresAt, AbortSignal.any([output.interruptSignal, deadline.signal]));
      signature = undefined;
      if (await delivery === "unavailable") {
        output.writeError("Signature delivery unavailable. The direct delivery lifetime ended. No signature is displayed and no request will be repeated.\n");
        return 2;
      }
      return 0;
    } finally { signature = undefined; }
  } finally { clearTimeout(timer); review = undefined; }
};
