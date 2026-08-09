import {
  projectAccountAssetExactView,
  type AccountAssetViewRevision,
} from "../../account-assets/browser.js";
import {
  isTokenCatalogOperationTerminal,
  type TokenCatalogOperation,
} from "../../token-catalog/browser.js";
import type { DeliveryUnknown } from "../operation-delivery.js";
import type {
  AccountAssetExactReadState,
  ConnectedAccount,
  ConnectedAccountObservation,
} from "./account-assets-controller.js";
import { observeConnectedAccount } from "./account-assets-controller.js";
import type {
  OfficialStockTokenCandidate,
  StockTokenAddDialogPresentation,
  StockTokenAddStatus,
} from "./stock-token-add-dialog.js";
import type {
  StockTokenInformationDialogPresentation,
} from "./stock-token-information-dialog.js";
import type {
  StockTokenRemoveDialogPresentation,
  StockTokenRemoveSubject,
} from "./stock-token-remove-dialog.js";
import {
  type HumanFailurePresentation,
} from "./human-failures.js";

export type StockTokenActionIntent =
  | "starting_add"
  | "confirming_add"
  | "closing_add"
  | "starting_remove"
  | "confirming_remove"
  | "closing_remove";

export type StockTokenFailedAction =
  | "start_add"
  | "confirm_add"
  | "cancel_add"
  | "start_remove"
  | "confirm_remove"
  | "cancel_remove";

export type StockTokenTaskFailure = Readonly<{
  action: StockTokenFailedAction;
  presentation: HumanFailurePresentation;
  candidate?: OfficialStockTokenCandidate;
}>;

export type StockTokenAddFormContext = Readonly<{
  account: ConnectedAccount;
  viewRevision: AccountAssetViewRevision;
  candidates: readonly OfficialStockTokenCandidate[];
}>;

export type StockTokenAddContext = Readonly<{
  taskId: number;
  form: StockTokenAddFormContext;
  candidate: OfficialStockTokenCandidate | null;
  failure?: StockTokenTaskFailure;
}>;

export type StockTokenRemoveContext = Readonly<{
  taskId: number;
  account: ConnectedAccount;
  subject: StockTokenRemoveSubject;
  failure?: StockTokenTaskFailure;
}>;

export type StockTokenDelivery = Readonly<{
  task: "add" | "remove";
  result: DeliveryUnknown;
}>;

export type StockTokenOperationAction = "confirm" | "cancel";

export type StockTokenOperationRequestState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "pending"; action: StockTokenOperationAction }>
  | Readonly<{ status: "delivery_unknown"; delivery: DeliveryUnknown }>;

export type StockTokenOperationTaskPresentation = Readonly<{
  operation: TokenCatalogOperation;
  account: ConnectedAccountObservation;
  request: StockTokenOperationRequestState;
  actions: readonly StockTokenOperationAction[];
  terminal: boolean;
}>;

export type StockTokenAccountObservationNotice = Readonly<{
  heading: string;
  message: string;
}>;

export const stockTokenAccountObservationNotice = (
  observation: ConnectedAccountObservation,
): StockTokenAccountObservationNotice | undefined => {
  switch (observation.status) {
    case "exact":
      return undefined;
    case "unobserved":
      return Object.freeze({
        heading: "No connected account",
        message: "Confirmation is unavailable until the operation account is connected.",
      });
    case "different_chain":
      return Object.freeze({
        heading: "Different network",
        message: "Confirmation is unavailable on the current wallet network.",
      });
    case "different_address":
      return Object.freeze({
        heading: "Different account",
        message: "Confirmation is unavailable for the current wallet address.",
      });
    case "revision_changed":
      return Object.freeze({
        heading: "Wallet connection changed",
        message: "Confirmation is unavailable because this operation belongs to an earlier wallet connection.",
      });
  }
};

const operationIntentAction = (
  intent: StockTokenActionIntent | undefined,
): StockTokenOperationAction | undefined => {
  switch (intent) {
    case "confirming_add":
    case "confirming_remove":
      return "confirm";
    case "closing_add":
    case "closing_remove":
      return "cancel";
    case "starting_add":
    case "starting_remove":
    case undefined:
      return undefined;
  }
};

export const presentStockTokenOperationTask = ({
  operation,
  account,
  pending,
  actionIntent,
  delivery,
}: Readonly<{
  operation: TokenCatalogOperation | null;
  account: ConnectedAccount | undefined;
  pending: boolean;
  actionIntent: StockTokenActionIntent | undefined;
  delivery: StockTokenDelivery | undefined;
}>): StockTokenOperationTaskPresentation | undefined => {
  if (operation === null) return undefined;
  const expected = Object.freeze({
    chainId: operation.account.chainId,
    address: operation.account.address,
    connectionRevision: operation.connectionRevision,
  });
  const accountObservation = observeConnectedAccount(expected, account);
  const correlatedDelivery = delivery?.result.operationId === operation.operationId
    ? delivery.result
    : undefined;
  const pendingAction = pending ? operationIntentAction(actionIntent) : undefined;
  const request: StockTokenOperationRequestState = correlatedDelivery !== undefined
    ? Object.freeze({ status: "delivery_unknown", delivery: correlatedDelivery })
    : pendingAction === undefined
      ? Object.freeze({ status: "idle" })
      : Object.freeze({ status: "pending", action: pendingAction });
  const terminal = isTokenCatalogOperationTerminal(operation.state);
  const actions: StockTokenOperationAction[] = [];
  if (
    request.status === "idle" &&
    operation.interactionInterface === "web" &&
    operation.state === "awaiting_confirmation"
  ) {
    if (accountObservation.status === "exact") actions.push("confirm");
    actions.push("cancel");
  }
  return Object.freeze({
    operation,
    account: accountObservation,
    request,
    actions: Object.freeze(actions),
    terminal,
  });
};

export const operationMatchesStockTokenAddition = (
  operation: TokenCatalogOperation,
  form: StockTokenAddFormContext,
  candidate: OfficialStockTokenCandidate,
): boolean =>
  operation.kind === "add" &&
  operation.asset.address === candidate.contractAddress &&
  operation.review.officialEvidence !== null &&
  operation.review.officialEvidence.assetUid === candidate.assetUid &&
  operation.review.officialSnapshotRevision ===
    form.viewRevision.officialSnapshotRevision &&
  operation.review.officialEvidence.snapshotRevision ===
    form.viewRevision.officialSnapshotRevision &&
  operation.account.chainId === form.account.chainId &&
  operation.account.address === form.account.address &&
  operation.connectionRevision === form.account.connectionRevision &&
  operation.review.selectionSetRevision ===
    form.viewRevision.selectionSetRevision;

export type StockTokenAddTaskPresentation = Readonly<{
  presentation: StockTokenAddDialogPresentation | undefined;
  claimsOperation: boolean;
}>;

export const presentStockTokenAddTask = ({
  context,
  actionIntent,
  operationTask,
  delivery,
}: Readonly<{
  context: StockTokenAddContext | undefined;
  actionIntent: StockTokenActionIntent | undefined;
  operationTask: StockTokenOperationTaskPresentation | undefined;
  delivery: StockTokenDelivery | undefined;
}>): StockTokenAddTaskPresentation => {
  if (context === undefined) {
    return Object.freeze({ presentation: undefined, claimsOperation: false });
  }
  const matchedTask = context.candidate !== null &&
    operationTask?.operation.kind === "add" &&
    operationMatchesStockTokenAddition(
      operationTask.operation,
      context.form,
      context.candidate,
    )
    ? Object.freeze({
        candidate: context.candidate,
        operation: operationTask.operation,
      })
    : undefined;
  const claimsOperation = matchedTask !== undefined;
  let addStatus: StockTokenAddStatus;
  if (context.failure !== undefined) {
    addStatus = {
      status: "error",
      failure: context.failure,
      candidate: context.failure.candidate ?? context.candidate,
    };
  } else if (delivery?.task === "add" && context.candidate !== null) {
    addStatus = {
      status: "delivery_unknown",
      candidate: context.candidate,
      delivery: delivery.result,
    };
  } else if (
    (
      actionIntent === "starting_add" ||
      actionIntent === "confirming_add" ||
      actionIntent === "closing_add"
    ) &&
    context.candidate !== null
  ) {
    addStatus = { status: "adding", candidate: context.candidate };
  } else if (matchedTask !== undefined) {
    switch (matchedTask.operation.state) {
      case "applying":
      case "awaiting_confirmation":
        addStatus = {
          status: "adding",
          candidate: matchedTask.candidate,
        };
        break;
      case "cancelled":
      case "completed":
      case "expired":
      case "failed":
        addStatus = {
          status: "terminal",
          candidate: matchedTask.candidate,
          operation: matchedTask.operation,
        };
        break;
    }
  } else {
    addStatus = { status: "idle" };
  }

  const active = addStatus.status === "adding";
  const operationBound = claimsOperation || delivery?.task === "add";
  return Object.freeze({
    presentation: Object.freeze({
      candidates: context.form.candidates,
      addStatus: Object.freeze(addStatus),
      inputsLocked: active || operationBound,
      dismissible: !active,
    }),
    claimsOperation,
  });
};

export type StockTokenInformationTaskPresentation = Readonly<{
  presentation: StockTokenInformationDialogPresentation | undefined;
}>;

export const presentStockTokenInformationTask = (
  exactRead: AccountAssetExactReadState,
): StockTokenInformationTaskPresentation => {
  if (exactRead.status === "idle") {
    return Object.freeze({ presentation: undefined });
  }
  if (exactRead.status === "loading") {
    return Object.freeze({
      presentation: {
        status: "loading",
        selection: exactRead.selection,
      },
    });
  }
  if (exactRead.status === "error") {
    return Object.freeze({
      presentation: {
        status: "error",
        selection: exactRead.selection,
        failure: exactRead.failure,
      },
    });
  }
  const row = projectAccountAssetExactView(exactRead.result);
  if (row.classification.kind !== "robinhood_stock_token") {
    return Object.freeze({
      presentation: {
        status: "classification_mismatch",
        selection: exactRead.selection,
        message: row.classification.kind === "custom_erc20"
          ? "This token is not available in the current Stock Token list."
          : row.classification.limitation,
      },
    });
  }
  return Object.freeze({
    presentation: { status: "available", result: exactRead.result },
  });
};

export const operationMatchesStockTokenRemoval = (
  operation: TokenCatalogOperation | null,
  context: StockTokenRemoveContext,
): boolean =>
  operation?.kind === "remove" &&
  operation.account.chainId === context.account.chainId &&
  operation.account.address === context.account.address &&
  operation.connectionRevision === context.account.connectionRevision &&
  operation.asset.chainId === context.subject.selection.asset.chainId &&
  operation.asset.address === context.subject.selection.asset.address &&
  operation.review.previousSelection?.account.chainId ===
    context.subject.selection.account.chainId &&
  operation.review.previousSelection.account.address ===
    context.subject.selection.account.address &&
  operation.review.previousSelection?.revision ===
    context.subject.selection.revision;

export type StockTokenRemoveTaskPresentation = Readonly<{
  presentation: StockTokenRemoveDialogPresentation | undefined;
  claimsOperation: boolean;
}>;

export const presentStockTokenRemoveTask = ({
  context,
  actionIntent,
  operationTask,
  delivery,
}: Readonly<{
  context: StockTokenRemoveContext | undefined;
  actionIntent: StockTokenActionIntent | undefined;
  operationTask: StockTokenOperationTaskPresentation | undefined;
  delivery: StockTokenDelivery | undefined;
}>): StockTokenRemoveTaskPresentation => {
  if (context === undefined) {
    return Object.freeze({ presentation: undefined, claimsOperation: false });
  }
  const matchedTask = operationTask?.operation.kind === "remove" &&
    operationMatchesStockTokenRemoval(operationTask.operation, context)
    ? Object.freeze({
        operation: operationTask.operation,
        task: operationTask,
      })
    : undefined;
  const claimsOperation = matchedTask !== undefined;
  let presentation: StockTokenRemoveDialogPresentation;
  if (context.failure !== undefined) {
    presentation = {
      status: "error",
      subject: context.subject,
      failure: context.failure,
    };
  } else if (delivery?.task === "remove") {
    presentation = {
      status: "delivery_unknown",
      subject: context.subject,
      delivery: delivery.result,
    };
  } else if (actionIntent === "confirming_remove") {
    presentation = { status: "removing", subject: context.subject };
  } else if (actionIntent === "closing_remove") {
    presentation = { status: "closing", subject: context.subject };
  } else if (matchedTask !== undefined) {
    switch (matchedTask.operation.state) {
      case "awaiting_confirmation":
        presentation = {
          status: "ready",
          subject: context.subject,
          operation: matchedTask.operation,
          operationTask: matchedTask.task,
        };
        break;
      case "applying":
        presentation = { status: "removing", subject: context.subject };
        break;
      case "cancelled":
      case "completed":
      case "expired":
      case "failed":
        presentation = {
          status: "terminal",
          subject: context.subject,
          operation: matchedTask.operation,
        };
        break;
    }
  } else {
    presentation = { status: "preparing", subject: context.subject };
  }
  return Object.freeze({ presentation: Object.freeze(presentation), claimsOperation });
};
