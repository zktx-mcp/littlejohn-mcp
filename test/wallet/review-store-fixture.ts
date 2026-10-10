import {canonicalJsonStringify, captureCanonicalJson} from "../../src/core/index.js";
import {parseWalletReview, type WalletPreparedReview, type WalletReviewStore} from "../../src/wallet/contracts.js";
import {WalletOperationError} from "../../src/wallet/operation-error.js";

// A storage port fixture for coordinator lifecycle checks. ProductDatabase tests
// own durable admission, lossless target snapshots and transaction atomicity.
export const memoryWalletReviewStore = (): WalletReviewStore => {
  const sources = new Map<string, WalletPreparedReview>();
  const equal = (left: unknown, right: unknown) => canonicalJsonStringify(captureCanonicalJson(left)) === canonicalJsonStringify(captureCanonicalJson(right));
  return {
    prepare: (input, value) => Object.freeze({input, review: parseWalletReview(value)}),
    commit: (prepared) => {sources.set(prepared.review.operationId, prepared); return prepared.review;},
    discard() {},
    get: (id) => {const source = sources.get(id); if (source === undefined) throw new WalletOperationError("wallet_operation_not_found"); return source;},
    read: (review) => {const source = sources.get(review.operationId); if (source === undefined || !equal(review, source.review)) throw new WalletOperationError("state_conflict"); return source.review;},
    readTargets: (review) => {if (review.precondition.targetSet.kind !== "inline") throw new Error("Durable snapshot targets require the product database."); return review.precondition.targetSet.targets;},
  };
};
