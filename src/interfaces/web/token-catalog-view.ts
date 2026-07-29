import {
  isTokenCatalogOperationTerminal,
  type TokenCatalogOperation,
  type TokenInspectionSuccess,
  type TokenSelection,
} from "../../token-catalog/browser.js";
import type { NotificationNotice } from "./notification.js";
import {
  humanFailureText,
  presentHumanFailure,
} from "./human-failures.js";
import {
  tokenOptionalTextUnavailableReasonLabel,
} from "./human-labels.js";

export interface TokenOperationCopy {
  readonly heading: string;
  readonly message: string;
}

export const tokenSelectionLabel = (selection: TokenSelection): string =>
  selection.asset.address;

const optionalMetadata = (
  value: TokenInspectionSuccess["data"]["metadata"]["name"],
): string => value.status === "available"
  ? value.value
  : `Unavailable (${tokenOptionalTextUnavailableReasonLabel(value.reason)})`;

export const tokenInspectionFields = (inspection: TokenInspectionSuccess) => Object.freeze([
  Object.freeze({ label: "Name", value: optionalMetadata(inspection.data.metadata.name) }),
  Object.freeze({ label: "Symbol", value: optionalMetadata(inspection.data.metadata.symbol) }),
  Object.freeze({
    label: "Decimals",
    value: inspection.data.totalSupply.decimals.status === "available"
      ? inspection.data.totalSupply.decimals.value
      : inspection.data.totalSupply.decimals.status === "unavailable"
        ? `Unavailable (${inspection.data.totalSupply.decimals.reason})`
        : "Not observed",
  }),
]);

export const tokenOperationCopy = (
  operation: TokenCatalogOperation,
): TokenOperationCopy => {
  switch (operation.state) {
    case "awaiting_confirmation":
      return Object.freeze({
        heading: operation.kind === "add"
          ? "Add token"
          : "Remove token",
        message: "Review this account token change before confirming.",
      });
    case "applying":
      return Object.freeze({
        heading: "Applying token selection change",
        message: "Little John is committing the confirmed change.",
      });
    case "completed":
      return Object.freeze({
        heading: operation.kind === "add"
          ? "Token added"
          : "Token removed",
        message: "The account token selection is up to date.",
      });
    case "cancelled":
      return Object.freeze({
        heading: "Token selection change cancelled",
        message: "No account token change was made by this operation.",
      });
    case "expired":
      return Object.freeze({
        heading: "Token selection change expired",
        message: "The review expired before confirmation.",
      });
    case "failed":
      return Object.freeze({
        heading: "Token selection change failed",
        message: humanFailureText(presentHumanFailure(
          operation.kind === "add"
            ? "stock_token_add"
            : "stock_token_remove",
          operation.failure,
        )),
      });
  }
};

export const tokenOperationNotification = (
  operation: TokenCatalogOperation,
): NotificationNotice | undefined => {
  if (!isTokenCatalogOperationTerminal(operation.state)) return undefined;
  const copy = tokenOperationCopy(operation);
  return Object.freeze({
    id: operation.operationId,
    tone: operation.state === "completed"
      ? "success"
      : operation.state === "cancelled"
        ? "neutral"
        : "error",
    ...copy,
  });
};
