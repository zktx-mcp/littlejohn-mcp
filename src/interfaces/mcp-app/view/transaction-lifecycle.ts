import { receiptApplicationContracts } from "../../../receipt-activity/application-contracts.js";
import { chainInvocationDeadlineMs } from "../../../chain/invocation-limits.js";
import { operationToolInputEvidence } from "../contracts.js";
import { recoverCodexOperationToolResult } from "./codex-operation-result-adapter.js";
import { canonicalJsonStringify, captureCanonicalJson } from "../../../core/client.js";
import { exchangeReviewSchema, readyExchangeReviewSchema, type ReadyExchangeReview } from "../../../review/contracts.js";
import { admitExchangeConfirmationResult, exchangeApplicationContracts } from "../../../review/application-contracts.js";
import { exchangeToolContracts, activityToolContracts } from "../../exchange-tool-contracts.js";
import { walletOutcomeText, exchangeReviewSections, transactionRecordSections, transactionSectionsText } from "../../exchange-presentation.js";
import type { AdmittedPresentation, PresentationViewApp } from "./lifecycle.js";
import { renderReviewControls, renderOperationMessage, replaceOperationRegion, renderTransactionSections } from "./renderers.js";

export const mountTransactionReview = async (app: PresentationViewApp, admitted: AdmittedPresentation,
  article: HTMLElement, signal: AbortSignal): Promise<void> => {
  const candidate = exchangeReviewSchema.parse(admitted.result);
  if (candidate.state !== "ready_for_wallet_review") {
    replaceOperationRegion(article, renderOperationMessage("No Wallet request", "Resolve the stated condition and start a new decision.", "unavailable"));
    return;
  }
  let review: ReadyExchangeReview | undefined = candidate;
  const operationId = review.observation.data.operationId;
  const account = review.observation.data.intent.account;
  const expiresAt = review.observation.data.actionExpiresAt;
  let sent = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = new AbortController();
  const message = (title: string, body: string, status: "pending" | "unavailable" | "error" = "unavailable") => {
    replaceOperationRegion(article, renderOperationMessage(title, body, status));
  };
  const release = () => { review = undefined; if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  signal.addEventListener("abort", () => { release(); request.abort(); }, { once: true });
  if (!app.getHostCapabilities()?.serverTools) {
    release(); message("Direct controls unavailable", "This Host session did not admit direct App tool calls."); return;
  }
  try {
    const response = await app.callServerTool({ name: exchangeToolContracts.get.mcp.name, arguments: { operationId } }, { signal });
    if (signal.aborted) return;
    if (response.isError === true) throw new TypeError("The decision read failed.");
    let live: ReadyExchangeReview | null;
    try { live = exchangeApplicationContracts.get.parsePublicSuccess({ operationId }, response.structuredContent); }
    catch {
      const restored = recoverCodexOperationToolResult({ hostName: app.getHostVersion()?.name, toolName: exchangeToolContracts.get.mcp.name,
        inputEvidence: operationToolInputEvidence({ operationId }), result: response });
      live = exchangeApplicationContracts.get.parsePublicSuccess({ operationId }, restored);
    }
    if (live === null || canonicalJsonStringify(captureCanonicalJson(live)) !== canonicalJsonStringify(captureCanonicalJson(review))) {
      release(); message("Decision unavailable", "This exact decision was consumed, discarded or expired. A new command creates a new decision."); return;
    }
  } catch { release(); message("Decision unavailable", "The current decision could not be established. No Wallet request was sent."); return; }
  const controls = renderReviewControls("Request in Wallet", true, expiresAt);
  controls.dismiss.textContent = "Discard decision";
  replaceOperationRegion(article, controls.node);
  timer = setTimeout(() => {
    release(); controls.accept.disabled = true; controls.dismiss.disabled = true;
    request.abort();
    message(sent ? "Waiting ended" : "Decision expired", sent ? walletOutcomeText({ status: "delivery_unknown" }) : "No Wallet request was sent. A new command is required.");
  }, Math.max(0, Date.parse(expiresAt) - Date.now()));
  controls.dismiss.addEventListener("click", () => {
    controls.accept.disabled = true; controls.dismiss.disabled = true; release();
    void app.callServerTool({ name: exchangeToolContracts.cancel.mcp.name, arguments: { operationId } }, { signal })
      .then((response) => {
        if (signal.aborted) return;
        if (response.isError === true) throw new TypeError("Discard failed.");
        const result = exchangeApplicationContracts.cancel.parsePublicSuccess({ operationId }, response.structuredContent);
        message(result.status === "discarded" ? "Decision discarded" : "Decision unavailable", result.status === "discarded"
          ? "This control sent no Wallet request." : "The decision was already consumed, discarded or expired. This does not establish another control's outcome.");
      }).catch(() => { if (!signal.aborted) message("Discard not confirmed", "No Wallet request was made by this control. The original decision expires at its displayed deadline."); });
  }, { once: true });
  controls.accept.addEventListener("click", () => {
    if (sent || review === undefined || signal.aborted || Date.parse(expiresAt) <= Date.now()) return;
    controls.accept.disabled = true; controls.dismiss.disabled = true; sent = true;
    if (timer !== undefined) clearTimeout(timer);
    const responseWait = Math.max(0, Date.parse(expiresAt) - Date.now()) + chainInvocationDeadlineMs;
    timer = setTimeout(() => { release(); request.abort(); message("Response wait ended", walletOutcomeText({ status: "delivery_unknown" })); }, responseWait);
    let input: Record<string, unknown> | undefined = captureCanonicalJson({ review, initiatedBy: "mcp_app" }) as Record<string, unknown>;
    const inputEvidence = operationToolInputEvidence(input);
    const pending = app.callServerTool({ name: exchangeToolContracts.request.mcp.name,
      arguments: input },
      { signal: AbortSignal.any([signal, request.signal]), timeout: responseWait, maxTotalTimeout: responseWait, resetTimeoutOnProgress: false });
    review = undefined; input = undefined;
    const waiting = renderOperationMessage("Waiting for the Wallet", `Local Wallet waiting ends at ${expiresAt}. If a hash arrives, the initial result lookup has a separate finite wait. Ending this display cannot cancel a delivered Wallet request.`, "pending");
    const stop = document.createElement("button"); stop.type = "button"; stop.className = "action secondary"; stop.textContent = "Stop waiting";
    waiting.append(stop); replaceOperationRegion(article, waiting);
    stop.addEventListener("click", () => { release(); request.abort(); message("Waiting ended", walletOutcomeText({ status: "delivery_unknown" })); }, { once: true });
    void pending.then(async (response) => {
      if (signal.aborted || request.signal.aborted) return;
      release();
      let value: unknown = response.structuredContent;
      try {
        if (response.isError === true) exchangeApplicationContracts.request.parseFailure(value);
        else admitExchangeConfirmationResult(operationId, value);
      } catch { value = recoverCodexOperationToolResult({ hostName: app.getHostVersion()?.name, toolName: exchangeToolContracts.request.mcp.name, inputEvidence, result: response }); }
      if (response.isError === true) {
        const failure = exchangeApplicationContracts.request.parseFailure(value);
        message("Request could not complete", failure.error.message, "error"); return;
      }
      const result = admitExchangeConfirmationResult(operationId, value);
      message(result.kind === "wallet_result" ? "Wallet result" : "A new decision is required",
        result.kind === "wallet_result" ? walletOutcomeText(result.outcome) : transactionSectionsText(exchangeReviewSections(result.review)));
      if (result.kind === "wallet_result" && result.outcome.status === "hash_returned" && result.outcome.recording === "recorded") {
        const input = { account, transactionHash: result.outcome.transactionHash };
        try {
          const read = await app.callServerTool({ name: activityToolContracts.get.mcp.name, arguments: input }, { signal });
          if (signal.aborted) return;
          if (read.isError === true) throw new TypeError("Stored result unavailable.");
          let record;
          try { record = receiptApplicationContracts.get.parsePublicSuccess(input, read.structuredContent); }
          catch { record = receiptApplicationContracts.get.parsePublicSuccess(input, recoverCodexOperationToolResult({
            hostName: app.getHostVersion()?.name, toolName: activityToolContracts.get.mcp.name,
            inputEvidence: operationToolInputEvidence(input), result: read })); }
          replaceOperationRegion(article, renderTransactionSections(transactionRecordSections(record)));
        } catch {
          if (!signal.aborted) message("Stored result unavailable", `${walletOutcomeText(result.outcome)} The local result could not be displayed; this does not change execution.`);
        }
      }
    }).catch(() => { if (!signal.aborted && !request.signal.aborted) { release(); message("Response unavailable", walletOutcomeText({ status: "delivery_unknown" })); } });
  }, { once: true });
};
