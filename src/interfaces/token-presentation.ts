import type { TokenSelectionReview } from "../token-catalog/client.js";
import { presentationCopy as copy, coverageText, tokenTextIssue, visibilityText } from "./presentation-copy.js";

type TokenReviewField = readonly [label: string, value: string];

// Complete human decision facts, separate from the canonical Review used by
// action admission. App and CLI compose these same groups in this order.
export const tokenReviewPresentation = (review: TokenSelectionReview) => Object.freeze({
  targetFields: [
    [copy.label.account, review.target.account.address],
    [copy.label.token, review.target.asset.address],
    [copy.title.tokenVisibility, visibilityText(review.precondition.previousSelection?.included === true)],
  ] as readonly TokenReviewField[],
  effect: copy.scope.tokenVisibility,
  metadataLimitations: review.kind === "add" ? (["name", "symbol"] as const).flatMap(field => {
    const text = review.decision[field];
    return text.status === "unavailable" ? [tokenTextIssue(field, text.reason)] : [];
  }) : [],
  metadataFields: review.kind === "add" ? [
    ...(["name", "symbol"] as const).map((field): TokenReviewField => {
      const text = review.decision[field];
      return [copy.label[field], text.status === "available" ? text.value : copy.label.unavailable];
    }),
    [copy.label.officialListing, review.decision.officialClassification === "official"
      ? copy.classification.robinhood_stock_token : copy.classification.custom_erc20] as TokenReviewField,
  ] : [],
  classificationLimitation: review.kind === "add" ? copy.scope.officialClassification : null,
  warnings: review.kind === "add" ? review.decision.warningCodes.map(code => code === "decimals_unavailable"
    ? copy.scope.amountUnavailable : coverageText("partial")) : [],
});
