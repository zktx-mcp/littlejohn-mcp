import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type ApplicationFailure,
  type CanonicalJson,
} from "../../../core/client.js";
import type {
  TokenCatalogOperation,
  TokenSelectionReview,
  TokenSelectionReviewResult,
} from "../../../token-catalog/client.js";
import {
  createWalletOperationCancellation,
  walletOperationAllowsQr,
  type WalletManagementOperation,
  type WalletQrMatrix,
  type WalletReview,
  type WalletReviewResult,
} from "../../../wallet/contracts.js";
import {
  isWalletOperationCancellableState,
  isWalletOperationTerminalState,
} from "../../../wallet/operation-state.js";
import {
  parseDeliveryUnknown,
  type DeliveryUnknown,
} from "../../operation-delivery.js";
import {
  operationToolContracts,
  type OperationToolContract,
} from "../../operation-tool-contracts.js";
import {
  admitWalletOperationQrMetadata,
  operationToolResultEvidence,
  walletOperationQrMetadataKey,
} from "../contracts.js";
import {
  presentationContracts,
  type PresentationContractEntry,
} from "../registry.js";
import type { AdmittedPresentation, PresentationViewApp } from "./lifecycle.js";
import { recoverCodexOperationToolResult } from "./codex-operation-result-adapter.js";
import {
  renderExactReadFailure,
  renderOperation,
  renderOperationMessage,
  renderReviewControls,
  replaceOperationRegion,
} from "./renderers.js";

const walletObservationMilliseconds = 500;
const invalidOperationResultMessage =
  "Little John could not verify this operation result. No action was repeated.";
const exactReadUnavailableMessage =
  "Little John could not read the exact operation. Retrying reads only its reserved operation ID.";

class OperationResultAdmissionError extends TypeError {}

export interface OperationViewApp extends PresentationViewApp {
  requestTeardown(): Promise<unknown>;
}

type ReviewContext =
  | Readonly<{
      domain: "wallet";
      review: WalletReview;
      action: OperationToolContract;
      exact: OperationToolContract;
      operationEntry: PresentationContractEntry;
      acceptLabel: string;
      destructive: boolean;
    }>
  | Readonly<{
      domain: "token_selection";
      review: TokenSelectionReview;
      action: OperationToolContract;
      exact: OperationToolContract;
      operationEntry: PresentationContractEntry;
      acceptLabel: string;
      destructive: boolean;
    }>;

type OperationValue =
  | WalletManagementOperation
  | TokenCatalogOperation;

type ToolOutcome =
  | Readonly<{ status: "success"; value: unknown; result: CallToolResult }>
  | Readonly<{ status: "failure"; failure: ApplicationFailure }>
  | Readonly<{ status: "delivery_unknown"; delivery: DeliveryUnknown }>;

const requireOperationEntry = (
  entry: PresentationContractEntry,
): PresentationContractEntry => {
  if (entry.presentationKind !== "operation") {
    throw new TypeError("Review operation binding is not an operation presentation.");
  }
  return entry;
};

const sameCanonicalValue = (left: unknown, right: unknown): boolean =>
  canonicalJsonStringify(captureCanonicalJson(left)) ===
    canonicalJsonStringify(captureCanonicalJson(right));

const exactOperationNotFoundCode = (binding: OperationToolContract): string => {
  const matches = binding.contract.failureCodes.filter((code) =>
    code.endsWith("_operation_not_found"));
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new TypeError("Exact operation failure ownership is incomplete.");
  }
  return matches[0];
};

const parseDeliveryRecovery = (
  binding: OperationToolContract,
  value: CanonicalJson,
): DeliveryUnknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Operation delivery recovery is invalid.");
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || keys.join("\0") !== ["delivery", "recovery"].join("\0")) {
    throw new TypeError("Operation delivery recovery is invalid.");
  }
  const delivery = parseDeliveryUnknown(value["delivery"]);
  const recovery = value["recovery"];
  if (typeof recovery !== "object" || recovery === null || Array.isArray(recovery)) {
    throw new TypeError("Operation delivery recovery is invalid.");
  }
  const recoveryKeys = Object.keys(recovery);
  if (
    recoveryKeys.length !== 2 ||
    recoveryKeys.join("\0") !== ["arguments", "tool"].join("\0") ||
    recovery["tool"] !== binding.mcp.name ||
    !sameCanonicalValue(recovery["arguments"], { operationId: delivery.operationId })
  ) throw new TypeError("Operation delivery recovery does not name the exact operation.");
  return delivery;
};

const admitToolOutcome = (
  binding: OperationToolContract,
  input: CanonicalJson,
  result: CallToolResult,
  value: CanonicalJson,
): ToolOutcome => {
  try {
    const admitted = binding.contract.parsePublicSuccess(input, value);
    if (result.isError === true) throw new TypeError("Successful operation result is marked as an error.");
    return Object.freeze({ status: "success", value: admitted, result });
  } catch (successError) {
    try {
      const failure = binding.contract.parseFailure(value);
      if (result.isError !== true) throw new TypeError("Operation failure is not marked as an error.");
      return Object.freeze({ status: "failure", failure });
    } catch {
      if (binding.recoveryOperation !== undefined && result.isError === true) {
        const delivery = parseDeliveryRecovery(binding.recoveryOperation, value);
        return Object.freeze({ status: "delivery_unknown", delivery });
      }
      throw successError;
    }
  }
};

const callBinding = async (
  app: OperationViewApp,
  binding: OperationToolContract,
  input: CanonicalJson,
  signal: AbortSignal,
): Promise<ToolOutcome> => {
  const result = await app.callServerTool({
    name: binding.mcp.name,
    arguments: input as Record<string, unknown>,
  }, { signal } satisfies RequestOptions);
  try {
    return admitToolOutcome(
      binding,
      input,
      result,
      captureCanonicalJson(result.structuredContent),
    );
  } catch {
    try {
      const recovered = recoverCodexOperationToolResult({
        hostName: app.getHostVersion()?.name,
        toolName: binding.mcp.name,
        normalizedInput: input,
        result,
      });
      return admitToolOutcome(binding, input, result, recovered);
    } catch {
      throw new OperationResultAdmissionError("Operation result admission failed.");
    }
  }
};

const reviewContext = (admitted: AdmittedPresentation): ReviewContext | null | undefined => {
  if (admitted.entry === presentationContracts.walletReview) {
    const result = admitted.result as unknown as WalletReviewResult;
    if (result.status !== "review") return null;
    const action = result.review.kind === "connect"
      ? operationToolContracts.walletConnect
      : operationToolContracts.walletDisconnect;
    return Object.freeze({
      domain: "wallet",
      review: result.review,
      action,
      exact: operationToolContracts.walletOperation,
      operationEntry: requireOperationEntry(presentationContracts.walletOperation),
      acceptLabel: result.review.kind === "connect" ? "Connect wallet" : "Disconnect wallet",
      destructive: result.review.kind === "disconnect",
    });
  }
  if (admitted.entry === presentationContracts.tokenSelectionReview) {
    const result = admitted.result as unknown as TokenSelectionReviewResult;
    const action = result.review.kind === "add"
      ? operationToolContracts.tokenAdd
      : operationToolContracts.tokenRemove;
    return Object.freeze({
      domain: "token_selection",
      review: result.review,
      action,
      exact: operationToolContracts.tokenOperation,
      operationEntry: requireOperationEntry(presentationContracts.tokenSelectionOperation),
      acceptLabel: result.review.kind === "add" ? "Add token selection" : "Remove token selection",
      destructive: result.review.kind === "remove",
    });
  }
  return undefined;
};

const actionInput = (context: ReviewContext): CanonicalJson => captureCanonicalJson({
  review: context.review,
  initiatedBy: "mcp_app",
});

const exactInput = (context: ReviewContext): CanonicalJson => captureCanonicalJson({
  operationId: context.review.operationId,
});

const assertOperationMatchesReview = (
  context: ReviewContext,
  operation: OperationValue,
): void => {
  if (
    operation.operationId !== context.review.operationId ||
    operation.domain !== context.domain ||
    !sameCanonicalValue(operation.review, context.review)
  ) throw new TypeError("Exact operation does not match the fixed Review.");
};

const parseOperation = (
  context: ReviewContext,
  outcome: Extract<ToolOutcome, { status: "success" }>,
): Readonly<{ operation: OperationValue; qr?: WalletQrMatrix }> => {
  const operation = outcome.value as OperationValue;
  assertOperationMatchesReview(context, operation);
  if (context.domain !== "wallet") return Object.freeze({ operation });
  const walletOperation = operation as WalletManagementOperation;
  const privateValue = outcome.result._meta?.[walletOperationQrMetadataKey];
  if (privateValue === undefined) return Object.freeze({ operation });
  let metadata: ReturnType<typeof admitWalletOperationQrMetadata>;
  try { metadata = admitWalletOperationQrMetadata(privateValue); }
  catch { return Object.freeze({ operation }); }
  if (
    metadata.operationId !== walletOperation.operationId ||
    metadata.resultSha256 !== operationToolResultEvidence(walletOperation).sha256 ||
    !walletOperationAllowsQr(walletOperation) ||
    Date.parse(walletOperation.review.actionExpiresAt) <= Date.now()
  ) return Object.freeze({ operation });
  return Object.freeze({
    operation,
    qr: metadata.qr,
  });
};

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

const failureMessage = (failure: ApplicationFailure): string => failure.error.message;

export const mountOperationReview = async (
  app: OperationViewApp,
  admitted: AdmittedPresentation,
  article: HTMLElement,
  signal: AbortSignal,
): Promise<boolean> => {
  if (admitted.entry.presentationKind !== "review") return false;
  const context = reviewContext(admitted);
  if (context === undefined) {
    throw new TypeError("Review operation binding is not registered.");
  }
  if (context === null) {
    replaceOperationRegion(article, renderOperationMessage(
      "No decision required",
      "This fixed result requires no state change.",
      "unavailable",
    ));
    return true;
  }
  const fixedContext = context;
  if (!app.getHostCapabilities()?.serverTools) {
    replaceOperationRegion(article, renderOperationMessage(
      "Direct controls unavailable",
      "This Host session did not admit App tool calls. This decision remains read-only.",
      "unavailable",
    ));
    return true;
  }

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let callInFlight = false;

  const stopDeadline = (): void => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  };
  signal.addEventListener("abort", () => {
    stopped = true;
    stopDeadline();
  }, { once: true });

  const renderReadFailure = (message: string): void => {
    stopDeadline();
    const failure = renderExactReadFailure(message);
    replaceOperationRegion(article, failure.node);
    failure.retry.addEventListener("click", () => {
      failure.retry.disabled = true;
      void readExact();
    }, { once: true });
  };

  const renderDeliveryUnknown = (): void => {
    renderReadFailure(
      "The action response was not proven. Do not repeat the action; read only its reserved operation ID.",
    );
  };

  const renderInvalidResult = (): void => {
    stopped = true;
    stopDeadline();
    replaceOperationRegion(article, renderOperationMessage(
      "Operation unavailable",
      invalidOperationResultMessage,
      "error",
    ));
  };

  const renderReviewReady = (): void => {
    stopDeadline();
    const remaining = Date.parse(fixedContext.review.actionExpiresAt) - Date.now();
    if (remaining <= 0) {
      replaceOperationRegion(article, renderOperationMessage(
        "Decision expired",
        "This decision can no longer create an operation.",
        "unavailable",
      ));
      return;
    }
    const controls = renderReviewControls(
      fixedContext.acceptLabel,
      fixedContext.destructive,
      fixedContext.review.actionExpiresAt,
    );
    replaceOperationRegion(article, controls.node);
    deadlineTimer = setTimeout(() => {
      controls.accept.disabled = true;
      controls.dismiss.disabled = true;
      renderReviewReady();
    }, remaining);
    controls.accept.addEventListener("click", () => {
      controls.accept.disabled = true;
      controls.dismiss.disabled = true;
      stopDeadline();
      void decide();
    }, { once: true });
    controls.dismiss.addEventListener("click", () => {
      controls.accept.disabled = true;
      controls.dismiss.disabled = true;
      stopDeadline();
      void app.requestTeardown();
    }, { once: true });
  };

  const renderAdmittedOperation = (
    operation: OperationValue,
    qr?: WalletQrMatrix,
  ): void => {
    assertOperationMatchesReview(fixedContext, operation);
    stopDeadline();
    if (fixedContext.domain !== "wallet") {
      replaceOperationRegion(article, renderOperation(fixedContext.operationEntry, captureCanonicalJson(operation)).node);
      stopped = true;
      return;
    }
    const walletOperation = operation as WalletManagementOperation;
    const terminal = isWalletOperationTerminalState(walletOperation.state);
    const rendered = renderOperation(
      fixedContext.operationEntry,
      captureCanonicalJson(walletOperation),
      {
        ...(qr === undefined ? {} : { qr }),
        cancellable: isWalletOperationCancellableState(walletOperation.state),
      },
    );
    replaceOperationRegion(article, rendered.node);
    if (terminal) {
      stopped = true;
      return;
    }
    if (rendered.cancel !== undefined) {
      rendered.cancel.addEventListener("click", () => {
        rendered.cancel!.disabled = true;
        void cancel(walletOperation);
      }, { once: true });
    }
    void observeWallet();
  };

  const handleOutcome = (outcome: ToolOutcome): void => {
    if (stopped || signal.aborted) return;
    if (outcome.status === "delivery_unknown") {
      renderDeliveryUnknown();
      return;
    }
    if (outcome.status === "failure") {
      renderReadFailure(failureMessage(outcome.failure));
      return;
    }
    try {
      const admittedOperation = parseOperation(fixedContext, outcome);
      renderAdmittedOperation(admittedOperation.operation, admittedOperation.qr);
    } catch { renderInvalidResult(); }
  };

  async function decide(): Promise<void> {
    if (stopped || callInFlight) return;
    callInFlight = true;
    replaceOperationRegion(article, renderOperationMessage(
      "Applying action",
      "Little John is revalidating this decision before any effect.",
    ));
    try {
      handleOutcome(await callBinding(app, fixedContext.action, actionInput(fixedContext), signal));
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof OperationResultAdmissionError) renderInvalidResult();
        else renderDeliveryUnknown();
      }
    } finally { callInFlight = false; }
  }

  async function readExact(): Promise<void> {
    if (stopped || callInFlight) return;
    callInFlight = true;
    replaceOperationRegion(article, renderOperationMessage(
      "Reading operation",
      "Little John is reading only the reserved operation ID.",
    ));
    try {
      const outcome = await callBinding(app, fixedContext.exact, exactInput(fixedContext), signal);
      if (outcome.status === "failure" &&
        outcome.failure.error.code === exactOperationNotFoundCode(fixedContext.exact)) {
        renderReviewReady();
        return;
      }
      handleOutcome(outcome);
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof OperationResultAdmissionError) renderInvalidResult();
        else renderReadFailure(exactReadUnavailableMessage);
      }
    } finally { callInFlight = false; }
  }

  async function observeWallet(): Promise<void> {
    if (stopped || signal.aborted) return;
    try { await delay(walletObservationMilliseconds, signal); }
    catch { return; }
    if (stopped || signal.aborted || callInFlight) return;
    callInFlight = true;
    try {
      const outcome = await callBinding(app, fixedContext.exact, exactInput(fixedContext), signal);
      handleOutcome(outcome);
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof OperationResultAdmissionError) renderInvalidResult();
        else renderReadFailure(exactReadUnavailableMessage);
      }
    } finally { callInFlight = false; }
  }

  async function cancel(operation: WalletManagementOperation): Promise<void> {
    if (stopped || callInFlight || !isWalletOperationCancellableState(operation.state)) return;
    callInFlight = true;
    replaceOperationRegion(article, renderOperationMessage(
      "Cancelling connection attempt",
      "Little John is cancelling only this exact active operation.",
    ));
    try {
      const input = captureCanonicalJson(createWalletOperationCancellation(operation));
      handleOutcome(await callBinding(app, operationToolContracts.walletCancel, input, signal));
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof OperationResultAdmissionError) renderInvalidResult();
        else renderReadFailure(exactReadUnavailableMessage);
      }
    } finally { callInFlight = false; }
  }

  await readExact();
  return true;
};
