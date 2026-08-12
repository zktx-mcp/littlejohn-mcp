import type { ApplicationFailure } from "../core/index.js";
import {
  LocalOperationClient,
  type LocalOperationIdentity,
  type LocalOperationResult,
} from "./operation-client.js";
import type { DeliveryUnknown } from "./operation-delivery.js";

export interface CliDecisionPort {
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
  readonly interruptSignal: AbortSignal;
  writeOutput(value: string): void;
  readLine(prompt: string): Promise<string>;
}

export type AtomicCliDecisionResult<Review, Operation> =
  | Readonly<{ status: "completed"; review: Review; operation: Operation }>
  | Readonly<{ status: "declined"; review: Review }>
  | Readonly<{ status: "failed"; failure: ApplicationFailure }>
  | Readonly<{ status: "delivery_unknown"; delivery: DeliveryUnknown }>;

export type CliDecisionAnswer = "accepted" | "declined" | "interrupted";

export const readCliDecision = async (
  output: CliDecisionPort,
  prompt: string,
): Promise<CliDecisionAnswer> => {
  if (output.interruptSignal.aborted) return "interrupted";
  let resolveInterrupt!: (value: "interrupted") => void;
  const interrupted = new Promise<"interrupted">((resolve) => {
    resolveInterrupt = resolve;
  });
  const onAbort = (): void => { resolveInterrupt("interrupted"); };
  output.interruptSignal.addEventListener("abort", onAbort, { once: true });
  try {
    const answer = output.readLine(prompt).then(
      (value): CliDecisionAnswer => /^y$/iu.test(value.trim()) ? "accepted" : "declined",
      (): CliDecisionAnswer => "declined",
    );
    return await Promise.race([answer, interrupted]);
  } finally {
    output.interruptSignal.removeEventListener("abort", onAbort);
  }
};

const failed = <Review, Operation>(
  result: Exclude<LocalOperationResult<unknown>, Readonly<{ ok: true; value: unknown }>>,
): AtomicCliDecisionResult<Review, Operation> => "status" in result
  ? Object.freeze({ status: "delivery_unknown", delivery: result })
  : Object.freeze({ status: "failed", failure: result.failure });

export const runAtomicCliDecision = async <
  ReviewInput,
  ReviewResult,
  Review,
  ActionInput,
  Operation,
>(input: Readonly<{
  client: LocalOperationClient;
  reviewIdentity: LocalOperationIdentity<ReviewInput, ReviewResult>;
  reviewInput: ReviewInput;
  selectReview(result: ReviewResult): Review;
  actionIdentity: LocalOperationIdentity<ActionInput, Operation>;
  actionInput(review: Review): ActionInput;
  formatReview(review: Review): string;
  formatOperation(operation: Operation): string;
  prompt: string;
  output: CliDecisionPort;
}>): Promise<AtomicCliDecisionResult<Review, Operation>> => {
  const reviewed = await input.client.invoke(
    input.reviewIdentity,
    input.reviewInput,
    input.output.interruptSignal,
  );
  if (!("ok" in reviewed) || !reviewed.ok) {
    return failed<Review, Operation>(reviewed);
  }
  const review = input.selectReview(reviewed.value);
  input.output.writeOutput(`${input.formatReview(review)}\n`);

  const decision = await readCliDecision(input.output, input.prompt);
  if (decision !== "accepted" || input.output.interruptSignal.aborted) {
    input.output.writeOutput("Declined. No operation or state change was created.\n");
    return Object.freeze({ status: "declined", review });
  }

  const decided = await input.client.invoke(
    input.actionIdentity,
    input.actionInput(review),
    input.output.interruptSignal,
  );
  if (!("ok" in decided) || !decided.ok) {
    return failed<Review, Operation>(decided);
  }
  input.output.writeOutput(`${input.formatOperation(decided.value)}\n`);
  return Object.freeze({ status: "completed", review, operation: decided.value });
};
