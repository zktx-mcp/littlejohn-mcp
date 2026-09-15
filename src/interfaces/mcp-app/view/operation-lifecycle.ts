import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type CanonicalJson,
} from "../../../core/client.js";
import type {
  TokenSelectionReview,
  TokenSelectionReviewResult,
} from "../../../token-catalog/client.js";
import {
  type WalletReview,
  type WalletReviewResult,
} from "../../../wallet/contracts.js";
import {
  parseDeliveryUnknown,
  type DeliveryUnknown,
} from "../../operation-delivery.js";
import {
  operationToolContracts,
  type OperationToolContract,
} from "../../operation-tool-contracts.js";
import {
  presentationContracts,
} from "../registry.js";
import type { AdmittedPresentation } from "./lifecycle.js";
import { applicationIssue, type ViewIssue } from "./tool-result.js";
import { cardControlContracts } from "../card-contract.js";

export const walletObservationMilliseconds = 500;

export type ReviewContext =
  | Readonly<{
      domain: "wallet";
      review: WalletReview;
      action: OperationToolContract;
      acceptLabel: string;
      destructive: boolean;
    }>
  | Readonly<{
      domain: "token_selection";
      review: TokenSelectionReview;
      action: OperationToolContract;
      acceptLabel: string;
      destructive: boolean;
    }>;

const sameCanonicalValue = (left: unknown, right: unknown): boolean =>
  canonicalJsonStringify(captureCanonicalJson(left)) ===
    canonicalJsonStringify(captureCanonicalJson(right));

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

export const admitOperationFailure = (binding: OperationToolContract, value: CanonicalJson): ViewIssue => {
  try { return applicationIssue(cardControlContracts.read.parseFailure(value)); }
  catch {
    if (binding.recoveryOperation === undefined) throw new TypeError("Operation failure is not admitted.");
    return { kind: "operation_delivery", delivery: parseDeliveryRecovery(binding.recoveryOperation, value) };
  }
};

export const operationReviewContext = (admitted: AdmittedPresentation): ReviewContext | null | undefined => {
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
      acceptLabel: result.review.kind === "add" ? "Add token selection" : "Remove token selection",
      destructive: result.review.kind === "remove",
    });
  }
  return undefined;
};

export const operationActionInput = (context: ReviewContext): CanonicalJson => captureCanonicalJson({
  review: context.review,
  initiatedBy: "mcp_app",
});
