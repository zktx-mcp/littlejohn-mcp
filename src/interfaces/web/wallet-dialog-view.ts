import type {
  WalletConnectionData,
} from "../../core/browser.js";
import type {
  WalletCurrentOperationProjection,
  WalletManagementOperation,
  WalletOperationPresentation,
} from "../../wallet/operation-contract.js";
import {
  isWalletOperationCancellableState,
  isWalletOperationConfirmableState,
  isWalletOperationTerminalState,
  type WalletOperationKind,
} from "../../wallet/operation-state.js";
import type { NotificationNotice } from "./notification.js";
import {
  humanFailureText,
  presentHumanFailure,
} from "./human-failures.js";

export type WalletConnectionAction = Extract<WalletOperationKind, "connect" | "disconnect">;
export type WalletOperationAction = "confirm" | "cancel";

export interface WalletDialogCopy {
  readonly heading: string;
  readonly message: string;
}

export interface WalletDialogField {
  readonly label: string;
  readonly value: string;
  readonly valueKind: "identifier" | "text";
}

const walletApprovalMessage =
  "Scan with Robinhood Wallet.";

const canStartConnection = (connection: WalletConnectionData): boolean =>
  connection.status === "disconnected";

export const walletNavigationLabel = (
  state: WalletCurrentOperationProjection | undefined,
): "Connect wallet" | "Disconnect wallet" | "Wallet" => {
  if (state?.status !== "absent") return "Wallet";
  if (canStartConnection(state.connection)) return "Connect wallet";
  return state.connection.status === "connected"
    ? "Disconnect wallet"
    : "Wallet";
};

export const walletConnectionActions = (
  state: WalletCurrentOperationProjection,
): readonly WalletConnectionAction[] => {
  if (state.status === "present") return Object.freeze([]);
  if (canStartConnection(state.connection)) return Object.freeze(["connect"]);
  if (state.connection.status === "connected") {
    return Object.freeze(["disconnect"]);
  }
  if (state.connection.status === "unresolved") {
    return Object.freeze(["disconnect"]);
  }
  return Object.freeze([]);
};

export const walletOperationActions = (
  presentation: WalletOperationPresentation,
): readonly WalletOperationAction[] => {
  const { operation } = presentation;
  if (
    presentation.access !== "interactive" ||
    isWalletOperationTerminalState(operation.state)
  ) return Object.freeze([]);
  const actions: WalletOperationAction[] = [];
  if (isWalletOperationConfirmableState(operation.state)) actions.push("confirm");
  if (isWalletOperationCancellableState(operation.state)) actions.push("cancel");
  return Object.freeze(actions);
};

export const walletOperationNotice = (
  presentation: WalletOperationPresentation,
): string | undefined =>
  presentation.access === "read_only" &&
  !isWalletOperationTerminalState(presentation.operation.state)
    ? "This operation is controlled by the CLI. Continue there."
    : undefined;

export const walletConnectionCopy = (
  connection: WalletConnectionData,
): WalletDialogCopy => {
  switch (connection.status) {
    case "connected":
      return Object.freeze({
        heading: "Wallet connected",
        message: "The Robinhood Chain session is ready.",
      });
    case "disconnected":
      return Object.freeze({
        heading: "Wallet disconnected",
        message: "Connect Robinhood Wallet to use the selected address.",
      });
    case "unknown":
      return Object.freeze({
        heading: "Checking wallet connection",
        message: "Wallet state is not available yet.",
      });
    case "unresolved":
      return Object.freeze({
        heading: "Wallet connection needs attention",
        message: `The current wallet state cannot be used. Wallet sessions found: ${connection.sessionCount}.`,
      });
  }
};

export const walletConnectionFields = (
  connection: WalletConnectionData,
): readonly WalletDialogField[] =>
  connection.status === "connected"
    ? Object.freeze([
        Object.freeze({
          label: "Address",
          value: connection.address,
          valueKind: "identifier",
        }),
        Object.freeze({
          label: "Network",
          value: "Robinhood Chain",
          valueKind: "text",
        }),
      ])
    : Object.freeze([]);

export const walletOperationCopy = (
  operation: WalletManagementOperation,
): WalletDialogCopy => {
  switch (operation.state) {
    case "starting_connection":
      return Object.freeze({
        heading: "Starting wallet connection",
        message: "The Robinhood Wallet connection request is being prepared.",
      });
    case "awaiting_confirmation":
      return Object.freeze({
        heading: "Disconnect wallet",
        message: "Confirm before removing every wallet session in this local profile.",
      });
    case "awaiting_wallet_approval":
      return Object.freeze({
        heading: "Connect Robinhood Wallet",
        message: walletApprovalMessage,
      });
    case "disconnecting":
      return Object.freeze({
        heading: "Disconnecting wallet",
        message: "Wallet sessions in this local profile are being removed.",
      });
    case "cancelling":
      return Object.freeze({
        heading: "Cancelling wallet connection",
        message: "The pending wallet connection request is being cancelled.",
      });
    case "validating_session":
      return Object.freeze({
        heading: "Validating wallet connection",
        message: "The approved Robinhood Chain session is being verified.",
      });
    case "completed":
      if (operation.kind === "disconnect") {
        return operation.result.outcome === "already_disconnected"
          ? Object.freeze({
              heading: "Wallet already disconnected",
              message: "No wallet session was active in this local profile.",
            })
          : Object.freeze({
            heading: "Wallet disconnected",
            message: "No wallet session remains in this local profile.",
          });
      }
      return Object.freeze({
        heading: "Wallet connected",
        message: "The Robinhood Chain session is ready.",
      });
    case "cancelled":
      return Object.freeze({
        heading: operation.kind === "disconnect"
          ? "Wallet disconnection cancelled"
          : "Wallet connection cancelled",
        message: "No further wallet change will be made by this operation.",
      });
    case "rejected":
      return Object.freeze({
        heading: "Wallet connection rejected",
        message: "Robinhood Wallet did not approve the connection.",
      });
    case "failed":
      return Object.freeze({
        heading: operation.kind === "disconnect"
          ? "Wallet disconnection failed"
          : "Wallet connection failed",
        message: humanFailureText(presentHumanFailure(
          operation.kind === "disconnect"
            ? "wallet_disconnection"
            : "wallet_connection",
          operation.failure,
        )),
      });
    case "expired":
      return Object.freeze({
        heading: operation.kind === "disconnect"
          ? "Wallet disconnection expired"
          : "Wallet connection expired",
        message: "The request expired before completion.",
      });
  }
};

export const walletOperationNotification = (
  operation: WalletManagementOperation,
): NotificationNotice | undefined => {
  if (!isWalletOperationTerminalState(operation.state)) return undefined;
  const copy = walletOperationCopy(operation);
  const tone: NotificationNotice["tone"] = operation.state === "completed"
    ? operation.kind === "disconnect" &&
        operation.result.outcome === "already_disconnected"
      ? "neutral"
      : "success"
    : operation.state === "cancelled"
      ? "neutral"
      : "error";
  return Object.freeze({
    id: operation.operationId,
    tone,
    ...copy,
  });
};

export const walletOperationConfirmationMessage = (
  _operation: WalletManagementOperation,
): string => "Every existing wallet session in this local profile will be disconnected.";
