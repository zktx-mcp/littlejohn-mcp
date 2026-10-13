import { presentationCopy as copy, statusCopy } from "../../presentation-copy.js";
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
import {walletAccountToolContracts} from "../../wallet-account-tool-contracts.js";
import {walletAccountSelectionSchema, type WalletAccountSelection, type WalletSelectAccountInput, type WalletSelectAccountSuccess} from "../../../wallet/account-selection-contract.js";
import {selectorDeliveryUnknownSchema} from "../../operation-delivery.js";
import {
  cardControlContracts, cardPresentationSchema, cardPresentationDeliverySchema, cardPresentationMetadataKey, admitCardActionPresentation, admitCardSourceResult, isCardInputTransition,
  type CardPresentationDelivery, type CardRecord, type DecisionCardRecord,
} from "../card-contract.js";
import { cardToolContracts } from "../card-tool-contracts.js";
import { admitPresentationSnapshotResource, canonicalBase64FromBytes, operationToolInputEvidence, operationToolResultEvidence, walletOperationQrMetadataKey } from "../contracts.js";
import { presentationContracts } from "../registry.js";
import {
  readPresentationResource, assertCreatingCardState,
  type AdmittedPresentation, type CreatingCard, type PresentationViewApp,
} from "./lifecycle.js";
import { admitToolReply, applicationIssue, type ViewIssue, type ViewResult } from "./tool-result.js";
import { operationReviewContext, operationActionInput, admitOperationFailure, readWalletReviewTargets, walletObservationMilliseconds, type ReviewContext } from "./operation-lifecycle.js";
import {
  renderPresentation, renderSavedCard, renderReviewControls, renderStatus, presentTerminalResult,
  renderCardOperation, renderCardStateMessage, renderOperation, renderReadFailure, presentCardState, replaceOperationRegion, renderViewIssue,
  renderWalletDisconnectTargets, renderWalletAccountControls, renderWalletSelectedAccount, renderReadOnlyAccountSelection,
} from "./renderers.js";
import { mountSigningResult } from "./signing-lifecycle.js";
import { mountTransactionResult } from "./transaction-lifecycle.js";
import { createPresentationLifecycle } from "./presentation-lifecycle.js";

type RequestDescription = {
  decision: CanonicalJson | undefined;
  readonly label: string;
  readonly destructive: boolean;
} & (
  | { readonly kind: "signing"; readonly signing: SigningResponseContext; readonly expiresAt: string }
  | { readonly kind: "transaction"; readonly operationId: string; readonly account: EvmAccountIdentity; readonly expiresAt: string }
  | { readonly kind: "operation"; readonly operation: ReviewContext; readonly expiresAt: string }
  | { readonly kind: "wallet_selection"; readonly initial: WalletAccountSelection; selector?: WalletSelectAccountInput; readonly expiresAt: string | null }
);

type DirectOutcome =
  | { readonly kind: "operation"; readonly domain: "wallet" | "token_selection"; readonly value: CanonicalJson; readonly conclusive: boolean }
  | { readonly kind: "signing"; readonly context: SigningResponseContext; readonly value: SigningOutcome; readonly conclusive: boolean }
  | { readonly kind: "transaction"; readonly account: EvmAccountIdentity; readonly operationId: string;
      readonly value: ReturnType<typeof admitExchangeConfirmationResult>; readonly conclusive: boolean }
  | {readonly kind: "wallet_selection"; readonly value: WalletSelectAccountSuccess; readonly conclusive: true};

const admitDirectOutcome = (request: RequestDescription, value: CanonicalJson): DirectOutcome => {
  if (request.kind === "wallet_selection") {
    if (request.selector === undefined) throw new TypeError("A selected account is required.");
    return {kind: "wallet_selection", value: walletAccountToolContracts.select.contract.parsePublicSuccess(request.selector, value), conclusive: true};
  }
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

const describeRequest = (admitted: AdmittedPresentation, selection: WalletAccountSelection | undefined, expiresAt: string | null): RequestDescription => {
  if (admitted.entry.cardKind === "wallet_selection") {
    const initial = walletAccountSelectionSchema.parse(admitted.result);
    if (selection === undefined || initial.connectionId !== selection.connectionId || initial.chainId !== selection.chainId ||
        initial.connectionRevision !== selection.connectionRevision) throw new TypeError("The local selection source changed.");
    return {kind: "wallet_selection", initial, expiresAt, decision: undefined, label: copy.action.selectAccount, destructive: false};
  }
  if (admitted.entry.cardKind === "signing") {
    const review = signingReviewSchema.parse(admitted.result);
    return { kind: "signing", signing: signingResponseContext(review), expiresAt: review.actionExpiresAt,
      decision: captureCanonicalJson({ review, initiatedBy: "mcp_app" }), label: copy.action.requestSignature, destructive: true };
  }
  if (admitted.entry.cardKind === "transaction") {
    const candidate = exchangeReviewSchema.parse(admitted.result);
    if (candidate.state !== "ready_for_wallet_review") throw new TypeError("Only an admitted live transaction can accept input.");
    const review: ReadyExchangeReview = candidate;
    return { kind: "transaction", operationId: review.observation.data.operationId, account: review.observation.data.intent.account,
      expiresAt: review.observation.data.actionExpiresAt, decision: captureCanonicalJson({ review, initiatedBy: "mcp_app" }),
      label: copy.action.requestTransaction, destructive: true };
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

// Internal View invalidation is distinct from backend cancellation or teardown.
export const cardViewInvalidated = Symbol("card_view_invalidated");

export const mountCard = async (
  app: PresentationViewApp, creating: CreatingCard,
  cardOpenRequestId: string, root: HTMLElement, signal: AbortSignal,
): Promise<void> => {
  const opening = { cardId: creating.cardId, cardOpenRequestId };
  const reference: { kind: "card"; cardId: string; cardOpenRequestId?: string } = {
    kind: "card", cardId: creating.cardId,
    cardOpenRequestId,
  };
  const view = createPresentationLifecycle(root, {
    getHostCapabilities: () => app.getHostCapabilities(),
    openLink: (input, options) => app.openLink === undefined ? Promise.resolve({ isError: true }) : app.openLink(input, options),
  });
  let current: CardPresentationDelivery | undefined;
  let article: HTMLElement | undefined;
  let hasDecisionFacts = false;
  let description: RequestDescription | undefined;
  // This identifies the admitted output already rendered, not another card state.
  // Private result material stays solely in its original result lifecycle.
  let displayed: { kind: "state"; delivery: CardPresentationDelivery; complete: boolean; snapshotDisplayed?: true; fingerprint?: string } | { kind: "direct"; conclusive: boolean } | undefined;
  let diagnostic: HTMLElement | undefined;
  let openingAcknowledged = false;
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
    description = undefined; clearTimer();
  };
  signal.addEventListener("abort", () => {
    releaseDecision(); wakeObservation?.(); view.dispose();
    if (signal.reason === cardViewInvalidated) {
      root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select").forEach(control => { control.disabled = true; });
      root.querySelectorAll(".qr-region").forEach(node => node.remove());
      diagnostic?.remove();
      const issue = renderStatus(article === undefined ? statusCopy.presentationUnavailable : statusCopy.detailsUnavailable,
        article === undefined ? "page" : "inline");
      if (article === undefined) root.replaceChildren(issue);
      else article.append(issue);
    }
    current = undefined; displayed = undefined; diagnostic = undefined;
  }, { once: true });

  const hasDirectResult = (): boolean => displayed?.kind === "direct";
  const hasConclusiveDirectResult = (): boolean => displayed?.kind === "direct" && displayed.conclusive;
  const hasSavedOutcome = (record: CardRecord | null | undefined): record is Exclude<CardRecord, {kind: "preparing"}> => record !== undefined && record !== null &&
    record.kind !== "preparing" && record.outcome !== null;
  const hasClosedInputFact = (record: CardRecord | null | undefined): boolean => record !== undefined && record !== null &&
    record.kind !== "read" && record.kind !== "preparing" && record.inputState === "input_closed" && record.closeReason !== "submitted";
  const hasDisplayedResult = (): boolean => {
    if (hasDirectResult()) return true;
    if (displayed?.kind !== "state") return false;
    const record = displayed.delivery.presentation.state.record;
    if (record?.kind === "read") return displayed.snapshotDisplayed === true || record.outcome?.kind === "failure";
    return hasSavedOutcome(record) || hasClosedInputFact(record);
  };
  const clearDiagnostic = (): void => {
    diagnostic?.remove(); diagnostic = undefined;
  };
  const showIssue = (node: HTMLElement): void => {
    if (signal.aborted) return;
    clearDiagnostic();
    const record = current?.presentation.state.record;
    if (!hasDisplayedResult() && hasSavedOutcome(record) && record.kind !== "read") {
      article = renderSavedCard(record); hasDecisionFacts = false; view.replaceStatic(article);
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
          if (key === "open") openingAcknowledged = true;
          return admitted;
        },
        failure: (value) => applicationIssue(binding.contract.parseFailure(value)),
      });
    });
    serialized = work.then(() => undefined, () => undefined);
    return work;
  };
  const fail = (issue?: ViewIssue): void => {
    if (signal.aborted) return;
    readFailed = true; releaseDecision(); wakeObservation?.();
    if (displayed?.kind === "state") displayed.complete = false;
    article?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".decision-group button, .decision-group select, button[data-card-control]").forEach((control) => { control.disabled = true; });
    article?.querySelectorAll(".qr-region").forEach((node) => node.remove());
    const unavailable = renderReadFailure(hasDisplayedResult() ? "details"
      : openingAcknowledged ? "saved_state" : "opening", issue,
      article === undefined && !hasSavedOutcome(current?.presentation.state.record) ? "page" : "inline");
    const retry = document.createElement("button"); retry.type = "button"; retry.className = "action secondary";
    const purpose = openingAcknowledged ? "read" : "open";
    retry.textContent = purpose === "open" ? copy.action.retryOpening : copy.action.reloadCard;
    unavailable.append(retry);
    if (openingAcknowledged) unavailable.append(document.createTextNode(copy.scope.reloadCard));
    showIssue(unavailable);
    retry.addEventListener("click", () => {
      retry.disabled = true;
      void readState(purpose);
    }, { once: true });
  };
  const adoptReply = async (reply: ViewResult<CardPresentationDelivery>): Promise<boolean> => {
    if (!reply.ok) { fail(reply.issue); return false; }
    readFailed = false;
    await apply(reply.value);
    if (!readFailed) clearDiagnostic();
    return !readFailed;
  };
  const readState = async (key: "open" | "read"): Promise<void> => {
    try { if (await adoptReply(await callCard(key))) observe(); }
    catch { fail(); }
  };
  const pause = (): Promise<void> => new Promise((resolve) => {
    const done = (): void => { clearTimeout(delay); signal.removeEventListener("abort", done); if (wakeObservation === done) wakeObservation = undefined; resolve(); };
    const delay = setTimeout(done, walletObservationMilliseconds);
    wakeObservation = done;
    signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done();
  });
  const pendingState = (): boolean => {
    const record = current?.presentation.state.record;
    if (record === undefined || record === null) return false;
    if (record.kind === "read") return record.preparationState === "pending";
    if (record.kind === "preparing") return record.creationState === "creating";
    if (record.inputState === "input_pending" || record.outcome === null && record.closeReason === "submitted") return true;
    const display = current!.presentation.display;
    return display.kind === "operation" && display.value.kind === "wallet" && !isWalletOperationTerminalState(display.value.state);
  };
  const shouldObserve = (): boolean => pendingState() || actionPending || displayed?.kind === "direct" && !displayed.conclusive;
  const observe = (): void => {
    if (polling !== undefined || signal.aborted || readFailed || !shouldObserve()) return;
    polling = (async () => {
      while (!signal.aborted && !readFailed && shouldObserve()) {
        await pause();
        if (signal.aborted || readFailed || !shouldObserve()) return;
        await readState("read");
      }
    })().catch(() => fail())
      .finally(() => { polling = undefined; if (!signal.aborted && !readFailed && shouldObserve()) observe(); });
  };
  const stop = async (key: "discard" | "stop"): Promise<void> => {
    if (signal.aborted || controlPending) return;
    controlPending = true; releaseDecision();
    article?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".decision-group button, .decision-group select, button[data-card-control]").forEach((control) => { control.disabled = true; });
    try {
      const reply = await callCard(key);
      controlPending = false;
      if (await adoptReply(reply)) observe();
    } catch {
      controlPending = false;
      fail();
    }
  };
  const showDirectOutcome = (outcome: DirectOutcome, reply: CallToolResult): Promise<void> => {
    if (article === undefined || signal.aborted || hasConclusiveDirectResult()) return Promise.resolve();
    const saved = displayed?.kind === "state" && displayed.complete ? displayed.delivery.presentation : undefined;
    if (!outcome.conclusive && hasSavedOutcome(current?.presentation.state.record)) return Promise.resolve();
    if (outcome.kind === "operation" && saved?.display.kind === "operation" &&
        (hasSavedOutcome(saved.state.record) || saved.display.value.resultSha256 === operationToolResultEvidence(outcome.value).sha256)) {
      // Keep the already-admitted DB display, including its original QR and controls.
      return Promise.resolve();
    }
    let rendered = Promise.resolve();
    if (outcome.kind === "operation") {
      const entry = outcome.domain === "wallet" ? presentationContracts.walletOperation : presentationContracts.tokenSelectionOperation;
      const node = renderOperation(entry, outcome.value).node;
      if (outcome.conclusive) presentTerminalResult(article, node); else replaceOperationRegion(article, node);
    } else if (outcome.kind === "signing") {
      const savedRecord = saved?.state.record;
      const savedOutcome = savedRecord === undefined || savedRecord === null || savedRecord.kind === "preparing" ? undefined : savedRecord.outcome;
      if (savedOutcome?.kind === "signing" && savedOutcome.status !== "verified") return Promise.resolve();
      const notice = renderStatus(outcome.value.status === "wallet_rejected" ? statusCopy.rejected : statusCopy[outcome.value.status]);
      let completion;
      try { completion = admitSigningPrivateResult(outcome.context, outcome.value, reply._meta); }
      catch {
        notice.append(renderStatus(statusCopy.signatureUnavailable));
      }
      if (completion !== undefined && "signature" in completion) mountSigningResult(article, completion.outcome, completion.signature, signal);
      else if (outcome.conclusive) presentTerminalResult(article, notice);
      else replaceOperationRegion(article, notice);
    } else if (outcome.kind === "wallet_selection") {
      presentTerminalResult(article, renderWalletSelectedAccount(outcome.value));
    } else {
      // Its initial result renders synchronously; its existing detail read may finish later.
      rendered = mountTransactionResult(app, outcome.account, outcome.operationId, outcome.value, article, signal);
    }
    // A transport's unknown-delivery report can be supplemented by the DB.
    displayed = { kind: "direct", conclusive: outcome.conclusive };
    return rendered;
  };
  const submit = (): void => {
    if (signal.aborted || decisionStarted || controlPending || readFailed || description?.decision === undefined ||
        !current?.presentation.actions.includes("confirm")) return;
    decisionStarted = true; actionPending = true; clearTimer();
    const request = description;
    article?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".decision-group button, .decision-group select, button[data-card-control]").forEach((control) => { control.disabled = true; });
    // The saved data is unchanged, but its last rendered controls and notice
    // are no longer complete. A rejected input must be able to restore them.
    if (displayed?.kind === "state") displayed.complete = false;
    if (article !== undefined) replaceOperationRegion(article, renderStatus(statusCopy.submitting));
    let input: CanonicalJson | undefined = captureCanonicalJson({ ...opening, decision: request.decision });
    const evidence = operationToolInputEvidence(input);
    const toolName = request.kind === "operation" ? request.operation.action.mcp.name : request.kind === "signing"
      ? signingToolContracts.request.mcp.name : request.kind === "wallet_selection" ? walletAccountToolContracts.select.mcp.name : exchangeToolContracts.request.mcp.name;
    let response: Promise<CallToolResult>;
    try {
      if (request.kind === "operation" || request.kind === "wallet_selection") {
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
      try {
        const presentation = admitCardActionPresentation(metadata);
        if (!("status" in presentation)) received = admit(presentation, reply);
      } catch { /* A malformed transport is distinct from a backend unavailable value. */ }
      if (received !== undefined) {
        try { readFailed = false; await apply(received); if (!readFailed) clearDiagnostic(); confirmed = true; }
        catch { /* The exact read can recover stored facts without replaying the action. */ }
      }
      if (signal.aborted || article === undefined) return;
      const outcome = admitToolReply<DirectOutcome>(reply, { hostName: app.getHostVersion()?.name, toolName, inputEvidence: evidence }, {
        success: (value) => admitDirectOutcome(request, value),
        failure: (value) => {
          if (request.kind === "operation") return admitOperationFailure(request.operation.action, value);
          if (request.kind === "wallet_selection") {
            const recovery = selectorDeliveryUnknownSchema.safeParse(value);
            if (recovery.success) {
              if (recovery.data.cardId !== creating.cardId || request.selector === undefined ||
                  canonicalJsonStringify(captureCanonicalJson(recovery.data.selector)) !== canonicalJsonStringify(captureCanonicalJson(request.selector)) ||
                  recovery.data.recovery.input.chainId !== request.selector.chainId) throw new TypeError("Selection delivery belongs to another input.");
              return {kind: "operation_delivery" as const, delivery: recovery.data};
            }
          }
          return applicationIssue(cardControlContracts.read.parseFailure(value));
        },
      });
      if (!outcome.ok) {
        submissionIssue = outcome.issue;
        if (outcome.issue.kind === "application" && current?.presentation.state.mode === "interactive") {
          decisionStarted = false;
          await readState("read");
          if (!signal.aborted && article !== undefined && !readFailed) article.querySelector(".operation-region")?.append(renderViewIssue(outcome.issue));
        } else if (!hasSavedOutcome(current?.presentation.state.record)) {
          fail(outcome.issue);
        }
        return;
      }
      await showDirectOutcome(outcome.value, reply);
      if (!confirmed) fail();
    }).catch(() => {
      if (!signal.aborted && !hasSavedOutcome(current?.presentation.state.record)) {
        fail();
      }
    }).finally(() => { actionPending = false; observe(); });
  };

  const appendSavedRead = (node: HTMLElement): void => {
    const button = document.createElement("button"); button.type = "button"; button.className = "action secondary";
    button.textContent = copy.action.reloadCard;
    button.addEventListener("click", () => {
      button.disabled = true;
      void readState("read")
        .finally(() => { if (!signal.aborted) button.disabled = false; });
    });
    node.append(button, document.createTextNode(copy.scope.reloadCard));
  };

  const readSourceFacts = async (record: DecisionCardRecord, resourceInput: unknown, delivery: CardPresentationDelivery) => {
    const resource = admitPresentationSnapshotResource(resourceInput);
    const loaded = await readPresentationResource(app, resource, signal);
    if (signal.aborted || current !== delivery || hasConclusiveDirectResult()) return undefined;
    if (!loaded.ok) {fail(loaded.issue); return undefined;}
    const admitted = loaded.value;
    admitCardSourceResult(record, admitted.normalizedInput, admitted.result);
    const rendered = renderPresentation(admitted.entry, admitted.result);
    const operation = operationReviewContext(admitted);
    if (operation?.domain === "wallet" && operation.review.kind === "disconnect") {
      const targets = await readWalletReviewTargets(app, operation.review, signal);
      if (signal.aborted || current !== delivery || hasConclusiveDirectResult()) return undefined;
      if (!targets.ok) {fail(targets.issue); return undefined;}
      rendered.node.insertBefore(renderWalletDisconnectTargets(targets.value), rendered.node.querySelector(".operation-region"));
    }
    return {admitted, rendered};
  };

  const apply = async (delivery: CardPresentationDelivery): Promise<void> => {
    if (signal.aborted) return;
    const next = delivery.presentation;
    const record = next.state.record!;
    // A delayed read cannot reverse the transitions admitted by the card owner.
    const previousRecord = current?.presentation.state.record;
    if (previousRecord !== undefined && previousRecord !== null) {
      if (previousRecord.kind !== "preparing" && record.kind === "preparing") return;
      if (previousRecord.kind === "read" && (record.kind !== "read" || previousRecord.preparationState !== "pending" && record.preparationState !== previousRecord.preparationState)) return;
      if (previousRecord.kind !== "read" && previousRecord.kind !== "preparing" &&
          (record.kind === "read" || record.kind === "preparing" || record.kind !== previousRecord.kind || !isCardInputTransition(previousRecord, record))) return;
      if (hasSavedOutcome(previousRecord) && record.kind !== "preparing" && record.outcome === null) return;
      const previousDisplay = current!.presentation.display;
      if (previousDisplay.kind === "operation" && previousDisplay.value.kind === "wallet" && isWalletOperationTerminalState(previousDisplay.value.state) &&
          next.display.kind === "operation" && next.display.value.kind === "wallet" && !isWalletOperationTerminalState(next.display.value.state)) return;
    }
    current = delivery;
    if (!pendingState()) wakeObservation?.();
    if (hasConclusiveDirectResult()) return;
    // Identical DB data can require different controls or submission notices.
    // These request facts describe this display, never a persisted transition.
    const fingerprint = canonicalJsonStringify(captureCanonicalJson({ delivery, controlPending,
      submission: next.display.kind === "decision" && decisionStarted ? (actionPending ? "pending" : "settled") : null }));
    const previous = displayed?.kind === "state" ? displayed : undefined;
    if (previous?.complete && previous.fingerprint === fingerprint) {
      // An identical observation keeps the rendered input binding current.
      // A different admitted state still replaces it and rejects old controls.
      current = previous.delivery;
      return;
    }
    if (previous?.complete && hasSavedOutcome(previous.delivery.presentation.state.record) &&
        previous.delivery.presentation.display.kind === "operation" && next.display.kind === "summary") {
      fail();
      return;
    }
    clearTimer();
    if (next.display.kind === "decision") {
      if (record.kind === "read" || record.kind === "preparing") throw new TypeError("A decision requires its owning input state.");
      if (record.expiresAt !== null) timer = setTimeout(() => {
        article?.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".decision-group button, .decision-group select, button[data-card-control]").forEach((control) => { control.disabled = true; });
        void readState("read");
      }, Math.max(0, Date.parse(record.expiresAt) - Date.now()));
      if (decisionStarted) {
        if (article === undefined) throw new TypeError("The original decision display is required.");
        const notice = actionPending
          ? renderStatus(statusCopy.submitting)
          : renderStatus(statusCopy.actionUnknown);
        if (!actionPending) {
          if (submissionIssue?.kind === "application") notice.append(renderViewIssue(submissionIssue));
          appendSavedRead(notice);
        }
        replaceOperationRegion(article, notice);
        displayed = { kind: "state", delivery, complete: true, fingerprint };
        return;
      }
      const loaded = await readSourceFacts(record, next.display.resource, delivery);
      if (loaded === undefined || hasDisplayedResult()) return;
      const {admitted, rendered} = loaded;
      article = rendered.node; hasDecisionFacts = true; view.replace(rendered);
      if (next.actions.includes("confirm")) {
        description = describeRequest(admitted, next.selection, record.expiresAt);
        const request = description;
        const selectionControls = request.kind === "wallet_selection"
          ? renderWalletAccountControls(request.initial, next.selection!, request.expiresAt)
          : undefined;
        const controls = selectionControls ?? renderReviewControls(request.label, request.destructive, request.kind === "signing" || request.kind === "transaction" ? null : request.expiresAt);
        controls.dismiss.textContent = copy.action.closeRequest;
        replaceOperationRegion(article, controls.node);
        controls.accept.addEventListener("click", () => {
          if (request.kind === "wallet_selection") {
            const selected = selectionControls?.selectedAccount();
            if (selected === undefined || current !== delivery || !current.presentation.actions.includes("confirm")) return;
            request.selector = walletAccountToolContracts.select.contract.parseInput({connectionId: request.initial.connectionId, chainId: request.initial.chainId,
              account: selected, expectedConnectionRevision: request.initial.connectionRevision, expectedSelectionRevision: next.selection!.selectionRevision});
            request.decision = captureCanonicalJson(request.selector);
          }
          submit();
        });
        controls.dismiss.addEventListener("click", () => { void stop("discard"); }, { once: true });
        if (request.kind !== "wallet_selection") controls.accept.disabled = controlPending;
        controls.dismiss.disabled = controlPending;
      } else {
        description = undefined;
        const notice = renderStatus(statusCopy.inputUnavailable);
        if (admitted.entry === presentationContracts.walletSelection) notice.prepend(renderReadOnlyAccountSelection(walletAccountSelectionSchema.parse(admitted.result)));
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
      if (!loaded.ok) { fail(loaded.issue); return; }
      const rendered = renderPresentation(loaded.value.entry, loaded.value.result);
      article = rendered.node; hasDecisionFacts = false; view.replace(rendered);
      displayed = { kind: "state", delivery, complete: true, snapshotDisplayed: true, fingerprint };
      return;
    }
    if (next.display.kind === "operation" && next.display.review !== undefined && !hasDecisionFacts) {
      if (record.kind !== "wallet") throw new TypeError("An original Wallet source is required.");
      const loaded = await readSourceFacts(record, next.display.review, delivery);
      if (loaded === undefined) return;
      article = loaded.rendered.node; hasDecisionFacts = true; view.replace(loaded.rendered);
    }
    if (article !== undefined && hasDecisionFacts) {
      if (next.display.kind === "summary") presentCardState(article, record);
      else replaceOperationRegion(article, renderCardStateMessage(record));
    }
    else { article = renderSavedCard(record); hasDecisionFacts = false; view.replaceStatic(article); }
    if (next.display.kind === "operation") {
      const node = renderCardOperation(next.display.value, delivery.qr?.qr);
      if (next.display.value.kind !== "wallet" || isWalletOperationTerminalState(next.display.value.state)) presentTerminalResult(article, node);
      else replaceOperationRegion(article, node);
    } else if (hasSavedOutcome(record) && next.display.kind !== "summary") presentTerminalResult(article, renderCardStateMessage(record));
    if (record.kind !== "read" && record.kind !== "preparing" && record.outcome?.kind === "operation" && next.display.kind === "summary") {
      appendSavedRead(article.querySelector<HTMLElement>(".operation-region") ?? article);
    }
    if (next.actions.includes("stop") && !controlPending) {
      const button = document.createElement("button"); button.type = "button"; button.className = "action secondary";
      button.dataset["cardControl"] = "stop";
      button.textContent = record.kind === "wallet" ? copy.action.cancelConnection : copy.action.stopWaiting;
      button.addEventListener("click", () => { button.disabled = true; void stop("stop"); }, { once: true });
      article.querySelector(".operation-region")?.append(button);
    }
    displayed = { kind: "state", delivery, complete: true, fingerprint };
  };

  if (!app.getHostCapabilities()?.serverTools) {
    root.replaceChildren(renderStatus(statusCopy.directReadUnavailable, "page"));
    return;
  }
  await readState("open");
};
