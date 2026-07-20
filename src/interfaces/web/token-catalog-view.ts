import {
  isTokenCatalogOperationTerminal,
  type TokenCatalogOperation,
  type TokenInspectionSuccess,
  type TokenRegistration,
} from "../../token-catalog/browser.js";
import type { NotificationNotice } from "./notification.js";

export interface TokenOperationCopy {
  readonly heading: string;
  readonly message: string;
}

export const tokenRegistrationLabel = (registration: TokenRegistration): string =>
  registration.asset.address;

const optionalMetadata = (
  value: TokenInspectionSuccess["data"]["metadata"]["name"],
): string => value.status === "available"
  ? value.value
  : `Unavailable (${value.reason.replace("_", " ")})`;

export const tokenInspectionFields = (inspection: TokenInspectionSuccess) => Object.freeze([
  Object.freeze({ label: "Name", value: optionalMetadata(inspection.data.metadata.name) }),
  Object.freeze({ label: "Symbol", value: optionalMetadata(inspection.data.metadata.symbol) }),
  Object.freeze({ label: "Raw total supply", value: inspection.data.totalSupply.raw }),
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
        heading: operation.kind === "register"
          ? "Add token"
          : "Remove token",
        message: "Review this account-specific catalog change before confirming.",
      });
    case "applying":
      return Object.freeze({
        heading: "Applying token catalog change",
        message: "Little John is committing the confirmed change.",
      });
    case "completed":
      return Object.freeze({
        heading: operation.kind === "register"
          ? "Token added"
          : "Token removed",
        message: "The account-specific token catalog is up to date.",
      });
    case "cancelled":
      return Object.freeze({
        heading: "Token catalog change cancelled",
        message: "No catalog change was made by this operation.",
      });
    case "expired":
      return Object.freeze({
        heading: "Token catalog change expired",
        message: "The review expired before confirmation.",
      });
    case "failed":
      return Object.freeze({
        heading: "Token catalog change failed",
        message: operation.failure.error.message,
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
