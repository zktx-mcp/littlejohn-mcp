import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {captureCanonicalJson, canonicalJsonStringify, operationIdByteLength, type CanonicalJson} from "../../../core/client.js";
import {type EvmAccountIdentity} from "../../../evm/identities.js";
import { chainInvocationDeadlineMs } from "../../../chain/invocation-limits.js";
import { signingReviewSchema, signingResponseContext, admitSigningOutcome, type SigningResponseContext, type SigningOutcome } from "../../../review/signing-contracts.js";
import type { WalletManagementOperation } from "../../../wallet/contracts.js";
import { isWalletOperationTerminalState } from "../../../wallet/operation-state.js";
import { exchangeReviewSchema, type ReadyExchangeReview } from "../../../review/contracts.js";
import { admitExchangeConfirmationResult } from "../../../review/application-contracts.js";
import { signingToolContracts } from "../../signing-tool-contracts.js";
import { exchangeToolContracts } from "../../exchange-tool-contracts.js";
import { admitSigningPrivateResult } from "../../signing-result.js";
import { signingOutcomeText } from "../../signing-presentation.js";
import {
  cardControlContracts, cardPresentationSchema, cardPresentationDeliverySchema, cardPresentationMetadataKey, admitCardActionPresentation, isCardPhaseTransition,
  type CardPresentationDelivery,
} from "../card-contract.js";
import { cardToolContracts } from "../card-tool-contracts.js";
import { canonicalBase64FromBytes, operationToolInputEvidence, operationToolResultEvidence, walletOperationQrMetadataKey } from "../contracts.js";
import { presentationContracts } from "../registry.js";
import {
  admitPresentationData, readPresentationResource, assertCreatingCardState,
  type AdmittedPresentation, type CreatingCard, type PresentationViewApp,
} from "./lifecycle.js";
import { admitToolReply, applicationIssue, type ViewIssue, type ViewResult } from "./tool-result.js";
import { operationReviewContext, operationActionInput, admitOperationFailure, walletObservationMilliseconds, type ReviewContext } from "./operation-lifecycle.js";
import {
  renderPresentation, renderSavedCard, renderReviewControls, renderOperationMessage,
  renderCardOperation, renderOperation, renderExactReadFailure, replaceOperationRegion, renderViewIssue,
} from "./renderers.js";
import { mountSigningResult } from "./signing-lifecycle.js";
import { mountTransactionResult } from "./transaction-lifecycle.js";
import { createPresentationLifecycle } from "./presentation-lifecycle.js";

type RequestDescription = {
  decision: CanonicalJson | undefined;
  readonly expiresAt: string;
  readonly label: string;
  readonly destructive: boolean;
} & (
  | { readonly kind: "signing"; readonly signing: SigningResponseContext }
  | { readonly kind: "transaction"; readonly operationId: string; readonly account: EvmAccountIdentity }
  | { readonly kind: "operation"; readonly operation: ReviewContext }
);

type DirectOutcome =
  | { readonly kind: "operation"; readonly domain: "wallet" | "token_selection"; readonly value: CanonicalJson; readonly conclusive: boolean }
  | { readonly kind: "signing"; readonly context: SigningResponseContext; readonly value: SigningOutcome; readonly conclusive: boolean }
  | { readonly kind: "transaction"; readonly account: EvmAccountIdentity; readonly operationId: string;
      readonly value: ReturnType<typeof admitExchangeConfirmationResult>; readonly conclusive: boolean };

const admitDirectOutcome = (request: RequestDescription, value: CanonicalJson): DirectOutcome => {
  if (request.kind === "operation") {
    const operation = request.operation.action.contract.parsePublicSuccess(operationActionInput(request.operation), value);
    return { kind: "operation", domain: request.operation.domain, value: captureCanonicalJson(operation), conclusive: request.operation.domain !== "wallet" ||
      isWalletOperationTerminalState((operation as WalletManagementOperation).state) };
  }
  if (request.kind === "signing") {
    const outcome = admitSigningOutcome(request.signing, value);
    return { kind: "signing", context: request.signing, value: outcome, conclusive: outcome.status !== "delivery_unknown" };
  }
  const outcome = admitExchangeConfirmationResult(request.operationId, value);
  return { kind: "transaction", account: request.account, operationId: request.operationId, value: outcome,
    conclusive: outcome.kind !== "wallet_result" || outcome.outcome.status !== "delivery_unknown" };
};

const describeRequest = (admitted: AdmittedPresentation): RequestDescription => {
  if (admitted.entry.cardKind === "signing") {
    const review = signingReviewSchema.parse(admitted.result);
    return { kind: "signing", signing: signingResponseContext(review), expiresAt: review.actionExpiresAt,
      decision: captureCanonicalJson({ review, initiatedBy: "mcp_app" }), label: "Request signature in Wallet", destructive: true };
  }
  if (admitted.entry.cardKind === "transaction") {
    const candidate = exchangeReviewSchema.parse(admitted.result);
    if (candidate.state !== "ready_for_wallet_review") throw new TypeError("Only an admitted live transaction can accept input.");
    const review: ReadyExchangeReview = candidate;
    return { kind: "transaction", operationId: review.observation.data.operationId, account: review.observation.data.intent.account,
      expiresAt: review.observation.data.actionExpiresAt, decision: captureCanonicalJson({ review, initiatedBy: "mcp_app" }),
      label: "Request in Wallet", destructive: true };
  }
  const operation = operationReviewContext(admitted);
  if (operation === null || operation === undefined) throw new TypeError("The saved card has no matching operation Review.");
  return { kind: "operation", operation, expiresAt: operation.review.actionExpiresAt,
    decision: operationActionInput(operation), label: operation.acceptLabel, destructive: operation.destructive };
};

export const createCardOpenRequestId = (): string => {
  const bytes = new Uint8Array(operationIdByteLength);
  crypto.getRandomValues(bytes);
  return canonicalBase64FromBytes(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

export const mountCard = async (
  app: PresentationViewApp, creating: CreatingCard, result: CallToolResult | undefined,
  cardOpenRequestId: string | undefined, root: HTMLElement, signal: AbortSignal,
): Promise<void> => {
  const opening = creating.entry === "decision" ? { cardId: creating.cardId, cardOpenRequestId } : undefined;
  if (opening !== undefined && cardOpenRequestId === undefined) throw new TypeError("A decision View requires its opening identity.");
  const reference: { kind: "card"; cardId: string; cardOpenRequestId?: string } = {
    kind: "card", cardId: creating.cardId,
    ...(opening === undefined ? {} : { cardOpenRequestId: opening.cardOpenRequestId! }),
  };
  const view = createPresentationLifecycle(root, {
    getHostCapabilities: () => app.getHostCapabilities(),
    openLink: (input, options) => app.openLink === undefined ? Promise.resolve({ isError: true }) : app.openLink(input, options),
  });
  let current: CardPresentationDelivery | undefined;
  let article: HTMLElement | undefined;
  let description: RequestDescription | undefined;
  // This identifies the admitted output already rendered, not another card state.
  // Private result material stays solely in its original result lifecycle.
  let displayed: { kind: "state"; delivery: CardPresentationDelivery; complete: boolean; fingerprint?: string } | { kind: "direct"; conclusive: boolean } | undefined;
  let diagnostic: HTMLElement | undefined;
  let openingAcknowledged = opening === undefined;
  let decisionStarted = false;
  let actionPending = false;
  let controlPending = false;
  let submissionIssue: ViewIssue | undefined;
  let readFailed = false;
  let polling: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wakeObservation: (() => void) | undefined;
  let serialized: Promise<unknown> = Promise.resolve();
  const clearTimer = (): void => { clearTimeout(timer); timer = undefined; };
  const releaseDecision = (): void => {
    if (description !== undefined) description.decision = undefined;
    description = undefined; result = undefined; clearTimer();
  };
  signal.addEventListener("abort", () => { releaseDecision(); wakeObservation?.(); view.dispose(); current = undefined; displayed = undefined; diagnostic = undefined; }, { once: true });

  const hasDirectResult = (): boolean => displayed?.kind === "direct";
  const hasConclusiveDirectResult = (): boolean => displayed?.kind === "direct" && displayed.conclusive;
  const hasDisplayedResult = (): boolean => hasDirectResult() ||
    displayed?.kind === "state" && displayed.delivery.presentation.state.record?.phase === "closed";
  const clearDiagnostic = (): void => {
    diagnostic?.remove(); diagnostic = undefined;
  };
  const showIssue = (node: HTMLElement): void => {
    if (signal.aborted) return;
    clearDiagnostic();
    const record = current?.presentation.state.record;
    if (!hasDisplayedResult() && record?.phase === "closed") {
      article = renderSavedCard(record); view.replaceStatic(article);
      displayed = { kind: "state", delivery: current!, complete: false };
    }
    if (article !== undefined && (hasDisplayedResult() || pendingState() && !readFailed)) article.append(node);
    else {
      if (article !== undefined) replaceOperationRegion(article, node);
      else root.replaceChildren(node);
      displayed = undefined;
    }
    diagnostic = node;
  };

  const admit = (presentation: unknown, reply: CallToolResult): CardPresentationDelivery => {
    const qr = reply._meta?.[walletOperationQrMetadataKey];
    const value = cardPresentationSchema.parse(captureCanonicalJson(presentation));
    let delivery: CardPresentationDelivery;
    try { delivery = cardPresentationDeliverySchema.parse(captureCanonicalJson({ presentation: value, ...(qr === undefined ? {} : { qr }) })); }
    catch { delivery = { presentation: value }; }
    const record = delivery.presentation.state.record;
    if (record === null) throw new TypeError("A saved card response is required.");
    assertCreatingCardState(creating, record);
    return delivery;
  };
  const callCard = (key: keyof typeof cardToolContracts): Promise<ViewResult<CardPresentationDelivery>> => {
    const work = serialized.then(async () => {
      if (signal.aborted) throw new DOMException("View ended.", "AbortError");
      const binding = cardToolContracts[key];
      const input = binding.contract.parseInput(key === "open" ? opening : key === "read" ? reference : { cardId: creating.cardId });
      const reply = await app.callServerTool({ name: binding.mcp.name, arguments: captureCanonicalJson(input) as Record<string, unknown> }, { signal });
      return admitToolReply(reply, { hostName: app.getHostVersion()?.name, toolName: binding.mcp.name,
        inputEvidence: operationToolInputEvidence(input) }, {
        success: (value) => {
          const admitted = admit(binding.contract.parsePublicSuccess(input as never, value), reply);
          if (key === "read" && reference.cardOpenRequestId === undefined && admitted.presentation.state.record?.kind !== "read" && admitted.qr !== undefined) {
            throw new TypeError("A saved decision read cannot carry QR material.");
          }
          if (key === "open") openingAcknowledged = true;
          return admitted;
        },
        failure: (value) => applicationIssue(binding.contract.parseFailure(value)),
      });
    });
    serialized = work.then(() => undefined, () => undefined);
    return work;
  };
  const fail = (message: string, issue?: ViewIssue): void => {
    if (signal.aborted) return;
    readFailed = true; clearTimer(); wakeObservation?.();
    const unavailable = renderExactReadFailure(message, issue);
    const retry = openingAcknowledged ? "read" : "open";
    unavailable.retry.textContent = retry === "open" ? "Retry opening" : "Read saved state again";
    showIssue(unavailable.node);
    unavailable.retry.addEventListener("click", () => {
      unavailable.retry.disabled = true;
      void readState(retry, "Saved state remains unavailable. No action will be repeated.");
    }, { once: true });
  };
  const adoptReply = async (reply: ViewResult<CardPresentationDelivery>, unavailable: string): Promise<boolean> => {
    if (!reply.ok) { fail(unavailable, reply.issue); return false; }
    readFailed = false;
    await apply(reply.value);
    if (!readFailed) clearDiagnostic();
    return !readFailed;
  };
  const readState = async (key: "open" | "read", unavailable: string): Promise<void> => {
    try { if (await adoptReply(await callCard(key), unavailable)) observe(); }
    catch { fail(unavailable); }
  };
  const pause = (): Promise<void> => new Promise((resolve) => {
    const done = (): void => { clearTimeout(delay); signal.removeEventListener("abort", done); if (wakeObservation === done) wakeObservation = undefined; resolve(); };
    const delay = setTimeout(done, walletObservationMilliseconds);
    wakeObservation = done;
    signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done();
  });
  const pendingState = (): boolean => current?.presentation.state.record?.phase === "pending" || current?.presentation.state.record?.phase === "dispatching";
  const shouldObserve = (): boolean => current?.presentation.state.record?.phase !== "closed" &&
    (pendingState() || actionPending || displayed?.kind === "direct" && !displayed.conclusive);
  const observe = (): void => {
    if (polling !== undefined || signal.aborted || readFailed || !shouldObserve()) return;
    polling = (async () => {
      while (!signal.aborted && !readFailed && shouldObserve()) {
        await pause();
        if (signal.aborted || readFailed || !shouldObserve()) return;
        await readState("read", "The current saved state could not be read. No request will be repeated.");
      }
    })().catch(() => fail("The current saved state could not be read. No request will be repeated."))
      .finally(() => { polling = undefined; if (!signal.aborted && !readFailed && shouldObserve()) observe(); });
  };
  const stop = async (key: "discard" | "stop"): Promise<void> => {
    if (signal.aborted || controlPending) return;
    controlPending = true; releaseDecision();
    article?.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true; });
    try {
      const reply = await callCard(key);
      controlPending = false;
      if (await adoptReply(reply, "The local control result was not confirmed. No remote cancellation is established.")) observe();
    } catch {
      controlPending = false;
      fail("The local control result was not confirmed. No remote cancellation is established.");
    }
  };
  const showDirectOutcome = (outcome: DirectOutcome, reply: CallToolResult): Promise<void> => {
    if (article === undefined || signal.aborted || hasConclusiveDirectResult()) return Promise.resolve();
    const saved = displayed?.kind === "state" && displayed.complete ? displayed.delivery.presentation : undefined;
    if (!outcome.conclusive && current?.presentation.state.record?.phase === "closed") return Promise.resolve();
    if (outcome.kind === "operation" && saved?.display.kind === "operation" &&
        (saved.state.record?.phase === "closed" || saved.display.value.resultSha256 === operationToolResultEvidence(outcome.value).sha256)) {
      // Keep the already-admitted DB display, including its original QR and controls.
      return Promise.resolve();
    }
    let rendered = Promise.resolve();
    if (outcome.kind === "operation") {
      const entry = outcome.domain === "wallet" ? presentationContracts.walletOperation : presentationContracts.tokenSelectionOperation;
      replaceOperationRegion(article, renderOperation(entry, outcome.value).node);
    } else if (outcome.kind === "signing") {
      const savedOutcome = saved?.state.record?.outcome;
      if (savedOutcome?.kind === "signing" && savedOutcome.status !== "verified") return Promise.resolve();
      const notice = renderOperationMessage(outcome.value.status === "verified" ? "Signature verified" : "Signature request ended",
        signingOutcomeText(outcome.value), "unavailable");
      let completion;
      try { completion = admitSigningPrivateResult(outcome.context, outcome.value, reply._meta); }
      catch {
        notice.append(renderOperationMessage("Signature delivery unavailable", "The private value could not be matched to the verified response. No signature is displayed and no request will be repeated.", "error"));
      }
      if (completion !== undefined && "signature" in completion) mountSigningResult(article, completion.outcome, completion.signature, signal);
      else replaceOperationRegion(article, notice);
    } else {
      // Its initial result renders synchronously; its existing detail read may finish later.
      rendered = mountTransactionResult(app, outcome.account, outcome.operationId, outcome.value, article, signal);
    }
    // A transport's unknown-delivery report can be supplemented by the DB.
    displayed = { kind: "direct", conclusive: outcome.conclusive };
    return rendered;
  };
  const submit = (): void => {
    if (signal.aborted || opening === undefined || decisionStarted || controlPending || description?.decision === undefined) return;
    decisionStarted = true; actionPending = true; clearTimer();
    const request = description;
    article?.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true; });
    if (article !== undefined) replaceOperationRegion(article, renderOperationMessage("Submitting decision", "The backend is checking and recording this decision."));
    let input: CanonicalJson | undefined = captureCanonicalJson({ ...opening, decision: request.decision });
    const evidence = operationToolInputEvidence(input);
    const toolName = request.kind === "operation" ? request.operation.action.mcp.name : request.kind === "signing"
      ? signingToolContracts.request.mcp.name : exchangeToolContracts.request.mcp.name;
    let response: Promise<CallToolResult>;
    try {
      if (request.kind === "operation") {
        response = app.callServerTool({ name: toolName, arguments: input as Record<string, unknown> }, { signal });
      } else {
        const responseWait = Math.max(0, Date.parse(request.expiresAt) - Date.now()) + (request.kind === "transaction" ? chainInvocationDeadlineMs : 0);
        response = app.callServerTool({ name: toolName, arguments: input as Record<string, unknown> }, {
          signal, timeout: responseWait, maxTotalTimeout: responseWait, resetTimeoutOnProgress: false,
        });
      }
    } catch (error) { response = Promise.reject(error); }
    input = undefined; releaseDecision(); observe();
    void response.then(async (reply) => {
      if (signal.aborted) return;
      const metadata = reply._meta?.[cardPresentationMetadataKey];
      let confirmed = false;
      let received: CardPresentationDelivery | undefined;
      let unavailable = "The response presentation could not be verified. No action will be repeated.";
      try {
        const presentation = admitCardActionPresentation(metadata);
        if ("status" in presentation) unavailable = "The backend could not provide the saved card state. No action will be repeated.";
        else received = admit(presentation, reply);
      } catch { /* A malformed transport is distinct from a backend unavailable value. */ }
      if (received !== undefined) {
        try { readFailed = false; await apply(received); if (!readFailed) clearDiagnostic(); confirmed = true; }
        catch { unavailable = "The saved result could not be displayed. No action will be repeated."; }
      }
      if (signal.aborted || article === undefined) return;
      const outcome = admitToolReply<DirectOutcome>(reply, { hostName: app.getHostVersion()?.name, toolName, inputEvidence: evidence }, {
        success: (value) => admitDirectOutcome(request, value),
        failure: (value) => request.kind === "operation" ? admitOperationFailure(request.operation.action, value)
          : applicationIssue(cardControlContracts.read.parseFailure(value)),
      });
      if (!outcome.ok) {
        submissionIssue = outcome.issue;
        if (current?.presentation.state.record?.phase !== "closed") {
          fail(unavailable, outcome.issue);
        }
        return;
      }
      await showDirectOutcome(outcome.value, reply);
      if (!confirmed) fail(unavailable);
    }).catch(() => {
      if (!signal.aborted && current?.presentation.state.record?.phase !== "closed") {
        fail("The direct response could not be confirmed. Read its saved state; no action will be repeated.");
      }
    }).finally(() => { actionPending = false; observe(); });
  };

  const appendSavedRead = (node: HTMLElement, label = "Read saved state"): void => {
    const button = document.createElement("button"); button.type = "button"; button.className = "action secondary";
    button.textContent = label;
    button.addEventListener("click", () => {
      button.disabled = true;
      void readState("read", "Saved state remains unavailable. No action will be repeated.")
        .finally(() => { if (!signal.aborted) button.disabled = false; });
    });
    node.append(button);
  };

  const apply = async (delivery: CardPresentationDelivery): Promise<void> => {
    if (signal.aborted) return;
    const next = delivery.presentation;
    const record = next.state.record!;
    // A delayed read cannot reverse the transitions admitted by the card owner.
    const previousRecord = current?.presentation.state.record;
    if (previousRecord !== undefined && previousRecord !== null && !isCardPhaseTransition(previousRecord.phase, record.phase)) return;
    current = delivery;
    if (record.phase === "closed") wakeObservation?.();
    if (hasConclusiveDirectResult()) return;
    // Identical DB data can require different controls or submission notices.
    // These request facts describe this display, never a persisted transition.
    const fingerprint = canonicalJsonStringify(captureCanonicalJson({ delivery, controlPending,
      submission: next.display.kind === "review" && decisionStarted ? (actionPending ? "pending" : "settled") : null }));
    const previous = displayed?.kind === "state" ? displayed : undefined;
    if (previous?.complete && previous.fingerprint === fingerprint) return;
    if (previous?.complete && previous.delivery.presentation.state.record?.phase === "closed" &&
        previous.delivery.presentation.display.kind === "operation" && next.display.kind === "summary") {
      fail("The latest read could not confirm the stored details. The previously confirmed result remains displayed.");
      return;
    }
    clearTimer();
    if (next.display.kind === "review") {
      if (record.kind !== "read" && record.expiresAt !== null) timer = setTimeout(() => {
        void readState("read", "The decision deadline state could not be read.");
      }, Math.max(0, Date.parse(record.expiresAt) - Date.now()));
      if (decisionStarted) {
        if (article === undefined) throw new TypeError("The original decision display is required.");
        const notice = actionPending
          ? renderOperationMessage("Submitting decision", "The backend is checking and recording this decision.")
          : renderOperationMessage("Decision delivery not confirmed", "The saved card has no accepted decision at this read. The earlier submission could not be confirmed. This View will not submit it again.", "unavailable");
        if (!actionPending) {
          if (submissionIssue?.kind === "application") notice.append(renderViewIssue(submissionIssue));
          appendSavedRead(notice, "Read saved state again");
        }
        replaceOperationRegion(article, notice);
        displayed = { kind: "state", delivery, complete: true, fingerprint };
        return;
      }
      const loaded = creating.entry === "decision" && result !== undefined ? await admitPresentationData(app, result, signal)
        : await readPresentationResource(app, next.display.resource, signal);
      if (signal.aborted || current !== delivery || hasDisplayedResult()) return;
      if (!loaded.ok) { fail("The saved decision data could not be read.", loaded.issue); return; }
      const admitted = loaded.value;
      const rendered = renderPresentation(admitted.entry, admitted.result);
      article = rendered.node; view.replace(rendered);
      if (next.actions.includes("confirm")) {
        if (opening === undefined || reference.cardOpenRequestId === undefined) throw new TypeError("A read-only View cannot submit a decision.");
        description = describeRequest(admitted);
        const controls = renderReviewControls(description.label, description.destructive, description.expiresAt);
        controls.dismiss.textContent = "Discard decision";
        replaceOperationRegion(article, controls.node);
        controls.accept.addEventListener("click", submit, { once: true });
        controls.dismiss.addEventListener("click", () => { void stop("discard"); }, { once: true });
        controls.accept.disabled = controlPending; controls.dismiss.disabled = controlPending;
      } else {
        description = undefined;
        const notice = renderOperationMessage("Read-only review", "This decision has not been submitted. Use its original decision card to choose.");
        replaceOperationRegion(article, notice);
        appendSavedRead(notice);
      }
      displayed = { kind: "state", delivery, complete: true, fingerprint };
      return;
    }
    releaseDecision();
    if (next.display.kind === "snapshot") {
      const loaded = await readPresentationResource(app, next.display.resource, signal);
      if (signal.aborted || current !== delivery || hasConclusiveDirectResult()) return;
      if (!loaded.ok) { fail("The saved result data could not be read.", loaded.issue); return; }
      const rendered = renderPresentation(loaded.value.entry, loaded.value.result);
      article = rendered.node; view.replace(rendered);
      displayed = { kind: "state", delivery, complete: true, fingerprint };
      return;
    }
    article = renderSavedCard(record); view.replaceStatic(article);
    if (next.display.kind === "operation") replaceOperationRegion(article,
      renderCardOperation(next.display.value, delivery.qr?.qr));
    if (record.phase === "closed" && record.outcome?.kind === "operation" && next.display.kind === "summary") {
      appendSavedRead(article.querySelector<HTMLElement>(".operation-region") ?? article);
    }
    if (next.actions.includes("stop") && !controlPending) {
      const button = document.createElement("button"); button.type = "button"; button.className = "action secondary";
      button.textContent = record.kind === "wallet" ? "Cancel connection attempt" : "Stop waiting";
      button.addEventListener("click", () => { button.disabled = true; void stop("stop"); }, { once: true });
      article.querySelector(".operation-region")?.append(button);
    }
    displayed = { kind: "state", delivery, complete: true, fingerprint };
  };

  if (!app.getHostCapabilities()?.serverTools) {
    root.replaceChildren(renderOperationMessage("Direct controls unavailable", "This Host cannot read the saved card. No action was requested.", "unavailable"));
    return;
  }
  await readState(opening === undefined ? "read" : "open", "The saved card could not be displayed. No action will be repeated.");
};
