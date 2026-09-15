import type { SigningOutcome } from "../../../review/signing-contracts.js";
import { renderSigningResult, renderOperationMessage, replaceOperationRegion } from "./renderers.js";

export const mountSigningResult = (
  article: HTMLElement,
  outcome: Extract<SigningOutcome, { status: "verified" }>,
  signature: string | undefined,
  signal: AbortSignal,
): void => {
  let panel: HTMLElement | undefined;
  const releaseResult = (): void => {
    signature = undefined; panel?.replaceChildren(); panel = undefined;
  };
  signal.addEventListener("abort", releaseResult, { once: true });
  if (signal.aborted) { releaseResult(); return; }
  if (signature === undefined) throw new TypeError("An admitted signature is required.");
  const rendered = renderSigningResult(outcome, signature);
  panel = rendered.node;
  replaceOperationRegion(article, panel);
  rendered.dismiss.addEventListener("click", () => {
    releaseResult();
    replaceOperationRegion(article, renderOperationMessage("Signature dismissed",
      "The product no longer retains this result. External copies and the signature's validity are unchanged.", "unavailable"));
  }, { once: true });
};
