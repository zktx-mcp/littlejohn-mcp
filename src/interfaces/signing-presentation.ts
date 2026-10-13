import { presentationCopy as copy, statusCopy, networkText, networkBindingText, exactDataText } from "./presentation-copy.js";
import { signingReviewSchema, type SigningOutcome } from "../review/signing-contracts.js";
import { personalSigningHex } from "../review/signing-payload.js";

export const signingReviewFields = (input: unknown): readonly (readonly [string, string])[] => {
  const review = signingReviewSchema.parse(input);
  return [[copy.label.account, review.account.address], [copy.label.network, networkText(review.account.chainId)],
    [copy.label.signingMethod, copy.method[review.method]], [copy.label.availableUntil, review.actionExpiresAt],
    [copy.label.networkBinding, review.payload.kind === "personal" || !Object.hasOwn(review.payload.domain, "chainId")
      ? copy.scope.noNetworkBinding : networkBindingText(networkText(review.account.chainId))],
    [copy.label.dataLimits, copy.scope.signing],
    [copy.label.dataToSign, exactDataText(review.payload)],
    ...(review.payload.kind === "personal" ? [[copy.label.messageBytes, personalSigningHex(review.payload)] as const] : []),
  ];
};
export const signingReviewText = (input: unknown): string => [copy.title.signature, ...signingReviewFields(input).map(([label, value]) => `${label}: ${value}`)].join("\n");
export const signingStatusText = (status: SigningOutcome["status"]): string =>
  (status === "wallet_rejected" ? statusCopy.rejected : statusCopy[status]).message;
export const signingOutcomeText = (outcome: SigningOutcome): string => signingStatusText(outcome.status);
