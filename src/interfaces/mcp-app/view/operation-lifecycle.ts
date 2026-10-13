import { presentationCopy as copy } from "../../presentation-copy.js";
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
  type WalletDisconnectTarget,
} from "../../../wallet/contracts.js";
import {readWalletDisconnectTargets} from "../../../wallet/disconnect-target-reader.js";
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
import type { AdmittedPresentation, PresentationViewApp } from "./lifecycle.js";
import {admitToolReply, applicationIssue, type ViewIssue, type ViewResult} from "./tool-result.js";
import { cardControlContracts } from "../card-contract.js";
import {bytesFromCanonicalBase64, operationToolInputEvidence, presentationMcpTools, presentationReadFailureSchema,
  presentationSnapshotChunkSchema, presentationSnapshotUriPrefix, presentationUnavailableSchema} from "../contracts.js";

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
  if (delivery.action === "select_account") throw new TypeError("An operation recovery cannot describe a local account selection.");
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
      acceptLabel: result.review.kind === "connect" ? copy.action.connect : copy.action.disconnect,
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
      acceptLabel: result.review.kind === "add" ? copy.action.showToken : copy.action.hideToken,
      destructive: result.review.kind === "remove",
    });
  }
  return undefined;
};

export const operationActionInput = (context: ReviewContext): CanonicalJson => captureCanonicalJson({
  review: context.review,
  initiatedBy: "mcp_app",
});

export const readWalletReviewTargets = async (
  app: PresentationViewApp, review: Extract<WalletReview, {kind: "disconnect"}>, signal: AbortSignal,
): Promise<ViewResult<readonly WalletDisconnectTarget[]>> => {
  let issue: ViewIssue | undefined;
  try {
    const targets = await readWalletDisconnectTargets(review, {
      readResultChunk: async (snapshotId, index) => {
        if (signal.aborted) throw new DOMException("View ended.", "AbortError");
        if (!app.getHostCapabilities()?.serverTools) throw new TypeError("The Host cannot read exact Wallet targets.");
        const input = {snapshotUri: `${presentationSnapshotUriPrefix}${snapshotId.slice("sha256:".length)}`, index};
        const reply = await app.callServerTool({name: presentationMcpTools.getSnapshotChunk, arguments: input}, {signal});
        const admitted = admitToolReply(reply, {hostName: app.getHostVersion()?.name,
          toolName: presentationMcpTools.getSnapshotChunk, inputEvidence: operationToolInputEvidence(input)}, {
          success: (value) => {
            const unavailable = presentationUnavailableSchema.safeParse(value);
            return unavailable.success ? unavailable.data : presentationSnapshotChunkSchema.parse(value);
          },
          failure: (value) => applicationIssue(presentationReadFailureSchema.parse(value)),
        });
        if (!admitted.ok) { issue = admitted.issue; throw new TypeError("Wallet target read failed."); }
        if (admitted.value.kind === "presentation_unavailable") {
          issue = {kind: "presentation", unavailable: admitted.value};
          throw new TypeError("Wallet target facts are unavailable.");
        }
        if (admitted.value.snapshotId !== snapshotId || admitted.value.index !== index) throw new TypeError("Wallet target chunk differs.");
        return bytesFromCanonicalBase64(admitted.value.canonicalBase64);
      },
    });
    return {ok: true, value: targets};
  } catch (error) {
    if (issue !== undefined) return {ok: false, issue};
    throw error;
  }
};
