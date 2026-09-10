import { canonicalJsonStringify, captureCanonicalJson } from "../../../core/client.js";
import { signingApplicationContracts } from "../../../review/signing-application-contracts.js";
import { admitSigningOutcome, createSigningCompletion, signingReviewSchema, signingResponseContext, type SigningReview } from "../../../review/signing-contracts.js";
import { signingToolContracts } from "../../signing-tool-contracts.js";
import { admitSigningPrivateResult } from "../../signing-result.js";
import { signingOutcomeText } from "../../signing-presentation.js";
import { operationToolInputEvidence } from "../contracts.js";
import { recoverCodexOperationToolResult } from "./codex-operation-result-adapter.js";
import type { AdmittedPresentation, PresentationViewApp } from "./lifecycle.js";
import { renderReviewControls, renderOperationMessage, replaceOperationRegion, renderSigningResult } from "./renderers.js";

export const mountSigningReview = async (app: PresentationViewApp, admitted: AdmittedPresentation,
  article: HTMLElement, signal: AbortSignal): Promise<void> => {
  let review: SigningReview | undefined = signingReviewSchema.parse(admitted.result);
  const context = signingResponseContext(review);
  const expiresAt = review.actionExpiresAt;
  let sent = false;
  let signature: string | undefined;
  let panel: HTMLElement | undefined;
  const waiting = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const releaseReview = (): void => { review = undefined; clearTimeout(timer); timer = undefined; };
  const releaseResult = (): void => { signature = undefined; panel?.replaceChildren(); panel = undefined; };
  const message = (title: string, text: string, status: "pending" | "unavailable" | "error" = "unavailable"): void => {
    releaseResult(); replaceOperationRegion(article, renderOperationMessage(title, text, status));
  };
  const unknown = (): string => signingOutcomeText(createSigningCompletion(context, "delivery_unknown").outcome);
  signal.addEventListener("abort", () => { releaseReview(); releaseResult(); waiting.abort(); }, { once: true });
  if (signal.aborted) { releaseReview(); return; }
  if (!app.getHostCapabilities()?.serverTools) {
    releaseReview(); message("Direct controls unavailable", "This Host session did not admit direct App tool calls."); return;
  }
  try {
    const response = await app.callServerTool({ name: signingToolContracts.get.mcp.name, arguments: { operationId: context.operationId } }, { signal });
    if (signal.aborted) return;
    if (response.isError === true) throw new TypeError("Decision unavailable.");
    let live: SigningReview | null;
    try { live = signingApplicationContracts.get.parsePublicSuccess({ operationId: context.operationId }, response.structuredContent).review; }
    catch { live = signingApplicationContracts.get.parsePublicSuccess({ operationId: context.operationId }, recoverCodexOperationToolResult({
      hostName: app.getHostVersion()?.name, toolName: signingToolContracts.get.mcp.name,
      inputEvidence: operationToolInputEvidence({ operationId: context.operationId }), result: response,
    })).review; }
    if (live === null || canonicalJsonStringify(captureCanonicalJson(live)) !== canonicalJsonStringify(captureCanonicalJson(review))) throw new TypeError("Decision changed.");
  } catch { releaseReview(); if (!signal.aborted) message("Decision unavailable", "This exact decision cannot be used. No signature request was sent by this control."); return; }
  if (Date.now() >= Date.parse(expiresAt)) { releaseReview(); message("Decision expired", "No signature request was sent by this control."); return; }
  const controls = renderReviewControls("Request signature in Wallet", true, expiresAt);
  controls.dismiss.textContent = "Discard decision";
  replaceOperationRegion(article, controls.node);
  timer = setTimeout(() => {
    releaseReview(); waiting.abort();
    message(sent ? "Waiting ended" : "Decision expired", sent ? unknown() : "No signature request was sent by this control.");
  }, Math.max(0, Date.parse(expiresAt) - Date.now()));
  controls.dismiss.addEventListener("click", () => {
    controls.accept.disabled = true; controls.dismiss.disabled = true; releaseReview();
    void app.callServerTool({ name: signingToolContracts.cancel.mcp.name, arguments: { operationId: context.operationId } }, { signal }).then((response) => {
      if (signal.aborted) return;
      if (response.isError === true) throw new TypeError("Discard failed.");
      const result = signingApplicationContracts.cancel.parsePublicSuccess({ operationId: context.operationId }, response.structuredContent);
      message(result.status === "discarded" ? "Decision discarded" : "Decision unavailable", "This control sent no signature request.");
    }).catch(() => { if (!signal.aborted) message("Discard not confirmed", "This control sent no signature request. The decision retains its original expiry."); });
  }, { once: true });
  controls.accept.addEventListener("click", () => {
    if (sent || review === undefined || signal.aborted) return;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) { releaseReview(); message("Decision expired", "No signature request was sent by this control."); return; }
    sent = true; controls.accept.disabled = true; controls.dismiss.disabled = true;
    let input: Record<string, unknown> | undefined = { review, initiatedBy: "mcp_app" };
    const inputEvidence = operationToolInputEvidence(input);
    const pending = app.callServerTool({ name: signingToolContracts.request.mcp.name, arguments: input }, {
      signal: AbortSignal.any([signal, waiting.signal]), timeout: remaining, maxTotalTimeout: remaining, resetTimeoutOnProgress: false,
    });
    review = undefined; input = undefined;
    const region = renderOperationMessage("Waiting for the Wallet", `Waiting ends at ${expiresAt}. Ending this display cannot cancel the Wallet request.`, "pending");
    const stop = document.createElement("button"); stop.type = "button"; stop.className = "action secondary"; stop.textContent = "Stop waiting";
    region.append(stop); replaceOperationRegion(article, region);
    stop.addEventListener("click", () => { releaseReview(); waiting.abort(); message("Waiting ended", unknown()); }, { once: true });
    void pending.then((response) => {
      if (signal.aborted || waiting.signal.aborted) return;
      if (Date.now() >= Date.parse(expiresAt)) { releaseReview(); waiting.abort(); message("Waiting ended", unknown()); return; }
      releaseReview();
      let value: unknown = response.structuredContent;
      try {
        if (response.isError === true) signingApplicationContracts.request.parseFailure(value);
        else admitSigningOutcome(context, value);
      } catch { value = recoverCodexOperationToolResult({ hostName: app.getHostVersion()?.name,
        toolName: signingToolContracts.request.mcp.name, inputEvidence, result: response }); }
      if (response.isError === true) { message("Request could not complete", signingApplicationContracts.request.parseFailure(value).error.message, "error"); return; }
      const outcome = admitSigningOutcome(context, value);
      let completion;
      try { completion = admitSigningPrivateResult(context, outcome, response._meta); }
      catch { message("Signature delivery unavailable", "The private result could not be matched to the verified outcome. No signature is displayed and the request will not be repeated.", "error"); return; }
      if (signal.aborted || waiting.signal.aborted || Date.now() >= Date.parse(expiresAt)) { message("Waiting ended", unknown()); return; }
      if (!("signature" in completion)) { message("Wallet result", signingOutcomeText(completion.outcome)); return; }
      signature = completion.signature;
      const rendered = renderSigningResult(completion.outcome, signature);
      panel = rendered.node; replaceOperationRegion(article, panel);
      rendered.dismiss.addEventListener("click", () => { releaseResult(); message("Signature dismissed", "The product no longer retains this result. External copies and the signature's validity are unchanged."); }, { once: true });
      rendered.copy.addEventListener("click", () => {
        if (signature === undefined || signal.aborted) return;
        const currentPanel = panel;
        if (navigator.clipboard?.writeText === undefined) { rendered.copyStatus.textContent = "Select the complete value and copy it manually."; return; }
        const failed = (): void => {
          if (panel === currentPanel && !signal.aborted) rendered.copyStatus.textContent = "Clipboard access failed. Select the complete value and copy it manually.";
        };
        try {
          void navigator.clipboard.writeText(signature).then(() => {
            if (panel === currentPanel && !signal.aborted) rendered.copyStatus.textContent = "Copied to your clipboard.";
          }, failed);
        } catch { failed(); }
      });
    }).catch(() => { if (!signal.aborted && !waiting.signal.aborted) { releaseReview(); message("Response unavailable", unknown()); } });
  }, { once: true });
};
