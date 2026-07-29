import {
  projectAccountAssetExactView,
  type AccountAssetExactSuccess,
  type AccountAssetViewRevision,
} from "../../account-assets/browser.js";
import type {
  TokenCatalogOperation,
} from "../../token-catalog/browser.js";
import type { DeliveryUnknown } from "../operation-delivery.js";
import type {
  AccountAssetExactReadState,
  ConnectedAccount,
} from "./account-assets-controller.js";
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
import { invalidBrowserResponse } from "./browser-client.js";
import {
  presentBrowserRequestFailure,
  presentHumanFailure,
  type HumanFailurePresentation,
  type HumanFailureTaskContext,
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

const terminalOperationFailure = (
  operation: TokenCatalogOperation,
  action: StockTokenFailedAction,
  context: HumanFailureTaskContext,
): StockTokenTaskFailure => Object.freeze({
  action,
  presentation: operation.state === "failed"
    ? presentHumanFailure(context, operation.failure)
    : presentBrowserRequestFailure(context, invalidBrowserResponse()),
});

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
  subject: StockTokenRemoveSubject;
  failure?: StockTokenTaskFailure;
}>;

export type StockTokenDelivery = Readonly<{
  task: "add" | "remove";
  result: DeliveryUnknown;
}>;

export const operationMatchesStockTokenCandidate = (
  operation: TokenCatalogOperation,
  candidate: OfficialStockTokenCandidate,
  officialSnapshotRevision: string | null,
): boolean =>
  operation.kind === "add" &&
  operation.asset.address === candidate.contractAddress &&
  operation.review.officialEvidence !== null &&
  operation.review.officialEvidence.assetUid === candidate.assetUid &&
  operation.review.officialSnapshotRevision === officialSnapshotRevision &&
  operation.review.officialEvidence.snapshotRevision ===
    officialSnapshotRevision;

export type StockTokenAddTaskPresentation = Readonly<{
  presentation: StockTokenAddDialogPresentation | undefined;
  claimsOperation: boolean;
}>;

export const presentStockTokenAddTask = ({
  context,
  actionIntent,
  operation,
  delivery,
}: Readonly<{
  context: StockTokenAddContext | undefined;
  actionIntent: StockTokenActionIntent | undefined;
  operation: TokenCatalogOperation | null;
  delivery: StockTokenDelivery | undefined;
}>): StockTokenAddTaskPresentation => {
  if (context === undefined) {
    return Object.freeze({ presentation: undefined, claimsOperation: false });
  }
  const claimsOperation = context.candidate !== null &&
    operation !== null &&
    operationMatchesStockTokenCandidate(
      operation,
      context.candidate,
      context.form.viewRevision.officialSnapshotRevision,
    );
  const activeOperation = claimsOperation && operation?.kind === "add"
    ? operation
    : null;
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
  } else if (activeOperation !== null) {
    addStatus =
      activeOperation.state === "awaiting_confirmation" ||
      activeOperation.state === "applying"
      ? {
          status: "adding",
          candidate: context.candidate!,
        }
      : {
          status: "error",
          failure: terminalOperationFailure(
            activeOperation,
            "confirm_add",
            "stock_token_add",
          ),
          candidate: context.candidate,
        };
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

const exactStockTokenResult = (
  exactRead: AccountAssetExactReadState,
): AccountAssetExactSuccess | undefined =>
  exactRead.status === "available" &&
  projectAccountAssetExactView(exactRead.result).classification.kind ===
    "robinhood_stock_token"
    ? exactRead.result
    : undefined;

export type StockTokenInformationTaskPresentation = Readonly<{
  presentation: StockTokenInformationDialogPresentation | undefined;
}>;

export const presentStockTokenInformationTask = (
  exactRead: AccountAssetExactReadState,
): StockTokenInformationTaskPresentation => {
  if (exactRead.status === "idle") {
    return Object.freeze({ presentation: undefined });
  }
  const result = exactStockTokenResult(exactRead);
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
  if (result === undefined) {
    return Object.freeze({
      presentation: {
        status: "classification_mismatch",
        selection: exactRead.selection,
        message: "This token is not available in the current Stock Token list.",
      },
    });
  }
  return Object.freeze({
    presentation: { status: "available", result },
  });
};

const operationMatchesRemoval = (
  operation: TokenCatalogOperation | null,
  context: StockTokenRemoveContext,
): operation is Extract<TokenCatalogOperation, { kind: "remove" }> =>
  operation?.kind === "remove" &&
  operation.asset.address === context.subject.selection.asset.address &&
  operation.review.previousSelection?.revision ===
    context.subject.selection.revision;

export type StockTokenRemoveTaskPresentation = Readonly<{
  presentation: StockTokenRemoveDialogPresentation | undefined;
  claimsOperation: boolean;
}>;

export const presentStockTokenRemoveTask = ({
  context,
  actionIntent,
  operation,
  delivery,
}: Readonly<{
  context: StockTokenRemoveContext | undefined;
  actionIntent: StockTokenActionIntent | undefined;
  operation: TokenCatalogOperation | null;
  delivery: StockTokenDelivery | undefined;
}>): StockTokenRemoveTaskPresentation => {
  if (context === undefined) {
    return Object.freeze({ presentation: undefined, claimsOperation: false });
  }
  const claimsOperation = operationMatchesRemoval(operation, context);
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
  } else if (claimsOperation) {
    presentation = operation.state === "awaiting_confirmation"
      ? { status: "ready", subject: context.subject, operation }
      : operation.state === "applying"
        ? { status: "removing", subject: context.subject }
        : {
            status: "error",
            subject: context.subject,
            failure: terminalOperationFailure(
              operation,
              "confirm_remove",
              "stock_token_remove",
            ),
          };
  } else {
    presentation = { status: "preparing", subject: context.subject };
  }
  return Object.freeze({ presentation: Object.freeze(presentation), claimsOperation });
};
