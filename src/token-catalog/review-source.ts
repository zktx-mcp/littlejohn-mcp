import type {TokenSelectionReviewRequest, TokenSelectionReviewResult} from "./contracts.js";

export interface PreparedTokenSelectionReview {
  readonly input: TokenSelectionReviewRequest;
  readonly result: TokenSelectionReviewResult;
}
export interface TokenSelectionReviewSource {
  readonly input: TokenSelectionReviewRequest;
  readonly result: TokenSelectionReviewResult;
}
