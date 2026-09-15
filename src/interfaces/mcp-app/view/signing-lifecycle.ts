import type { SigningOutcome } from "../../../review/signing-contracts.js";
import { renderSigningResult, renderOperationMessage, replaceOperationRegion } from "./renderers.js";

// Keep success visible briefly before offering another copy; this is not a request deadline.
const copyAcknowledgementMilliseconds = 2_000;

export const mountSigningResult = (
  article: HTMLElement,
  outcome: Extract<SigningOutcome, { status: "verified" }>,
  signature: string | undefined,
  signal: AbortSignal,
): void => {
  let panel: HTMLElement | undefined;
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
  const releaseResult = (): void => {
    clearTimeout(copyResetTimer); copyResetTimer = undefined;
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
rendered.copy.addEventListener("click", () => {
  if (signature === undefined || signal.aborted || rendered.copy.disabled) return;
  const currentPanel = panel;
  if (navigator.clipboard?.writeText === undefined) { rendered.copyStatus.textContent = "Select the complete value and copy it manually."; return; }
  rendered.copy.style.minWidth = `${rendered.copy.getBoundingClientRect().width}px`;
  rendered.copy.disabled = true;
  rendered.copy.textContent = "Copying…";
  rendered.copyStatus.textContent = "";
  const failed = (): void => {
    if (panel === currentPanel && !signal.aborted) {
      rendered.copy.disabled = false;
      rendered.copy.textContent = "Copy signature";
      rendered.copyStatus.textContent = "Clipboard access failed. Select the complete value and copy it manually.";
    }
  };
  try {
    void navigator.clipboard.writeText(signature).then(() => {
      if (panel === currentPanel && !signal.aborted) {
        rendered.copy.textContent = "Copied";
        rendered.copyStatus.textContent = "Copied to your clipboard.";
        copyResetTimer = setTimeout(() => {
          copyResetTimer = undefined;
          if (panel === currentPanel && !signal.aborted) {
            rendered.copy.textContent = "Copy signature";
            rendered.copy.disabled = false;
          }
        }, copyAcknowledgementMilliseconds);
      }
    }, failed);
  } catch { failed(); }
});
};
