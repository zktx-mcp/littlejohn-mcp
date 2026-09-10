import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
} from "../../src/core/index.js";
import { createWalletFailure } from "../../src/wallet/errors.js";
import {
  assertWalletOperationTransition,
  operationFailure,
  parseWalletDirectAction,
  parseWalletManagementOperation,
  parseWalletOperationCancellation,
  createWalletOperationCancellation,
  parseWalletOperationPresentation,
  parseWalletReview,
  walletOperationAllowsQr,
  walletOperationIdByteLength,
  walletOperationInputLimits,
  walletReviewDigest,
  type WalletManagementOperation,
  type WalletNonterminalManagementOperation,
  type WalletReview,
} from "../../src/wallet/contracts.js";
import {
  isWalletOperationCancellableState,
  walletInitiators,
  type WalletOperationState,
} from "../../src/wallet/operation-state.js";

const operationId = Buffer.alloc(walletOperationIdByteLength, 7).toString("base64url");
const otherOperationId = Buffer.alloc(walletOperationIdByteLength, 8).toString("base64url");
const createdAt = "2026-07-14T00:00:00.000Z";
const actionExpiresAt = "2026-07-14T00:05:00.000Z";
const sourceId = `wallet-session:${Buffer.alloc(32, 9).toString("base64url")}`;
const address = "0x1111111111111111111111111111111111111111";

const disconnected = Object.freeze({ status: "disconnected" as const, reason: "no_session" as const });
const connected = Object.freeze({
  status: "connected" as const,
  address,
  chainId: "eip155:4663",
  approvedMethods: Object.freeze(["eth_sendTransaction"]),
  approvedEvents: Object.freeze(["accountsChanged", "chainChanged"]),
  expiresAt: "2026-07-15T00:00:00.000Z",
});

const createReview = (
  kind: "connect" | "disconnect",
  id = operationId,
  connectionRevision = "3",
): WalletReview => {
  const withoutDigest = kind === "connect"
    ? {
        contractVersion: "1" as const,
        domain: "wallet" as const,
        kind,
        operationId: id,
        createdAt,
        actionExpiresAt,
        target: { chainId: "eip155:4663" },
        decision: {
          requiredMethods: ["eth_sendTransaction"] as const,
          optionalMethods: ["personal_sign", "eth_signTypedData_v4"] as const,
          requiredEvents: ["accountsChanged", "chainChanged"] as const,
        },
        precondition: { connectionRevision, connection: disconnected },
        fixedEvidence: { sessionSourceIds: [] as const },
      }
    : {
        contractVersion: "1" as const,
        domain: "wallet" as const,
        kind,
        operationId: id,
        createdAt,
        actionExpiresAt,
        target: { chainId: "eip155:4663" },
        decision: { action: "disconnect_session" as const },
        precondition: { connectionRevision, connection: connected },
        fixedEvidence: { sessionSourceIds: [sourceId] as const },
      };
  return parseWalletReview({
    ...withoutDigest,
    reviewDigest: walletReviewDigest(withoutDigest),
  });
};

const createOperation = (
  kind: "connect" | "disconnect",
  state: WalletOperationState,
  overrides: Readonly<Record<string, unknown>> = {},
): WalletManagementOperation => {
  const review = createReview(kind);
  const result = state === "completed"
    ? kind === "connect"
      ? { outcome: "connected", connectionRevision: "4", connection: connected }
      : {
          outcome: "disconnected",
          connectionRevision: "4",
          connection: { status: "disconnected", reason: "disconnected" },
        }
    : null;
  return parseWalletManagementOperation({
    contractVersion: "1",
    domain: "wallet",
    operationId: review.operationId,
    kind,
    initiatedBy: "mcp_app",
    review,
    state,
    terminationTarget: state === "cancelling" ? "cancelled" : null,
    result,
    failure: state === "failed" ? operationFailure(createWalletFailure("wallet_timeout")) : null,
    peerRefusalCode: state === "rejected" ? 5000 : null,
    ...overrides,
  });
};

const qr = Object.freeze({
  size: 21,
  rows: Object.freeze(Array.from({ length: 21 }, () => "0".repeat(21))),
});

describe("wallet immutable Review and durable operation contracts", () => {
  it("projects cancellation only from the owner's cancellable operation states", () => {
    for (const state of ["starting_connection", "awaiting_wallet_approval"] as const) {
      const operation = createOperation("connect", state);
      expect(createWalletOperationCancellation(operation)).toEqual({
        operationId: operation.operationId,
        reviewDigest: operation.review.reviewDigest,
        expectedState: state,
        connectionRevision: operation.review.precondition.connectionRevision,
      });
    }
    for (const state of ["validating_session", "cancelling", "completed", "failed"] as const) {
      expect(() => createWalletOperationCancellation(createOperation("connect", state)))
        .toThrow("not cancellable");
    }
  });
  it("uses one exact canonical action envelope for decisions and cancellation", () => {
    const byteLength = (value: unknown): number => Buffer.byteLength(
      canonicalJsonStringify(captureCanonicalJson(value)),
      "utf8",
    );
    const actionForRevisionDigits = (digitCount: number) => {
      const review = createReview("connect", operationId, "9".repeat(digitCount));
      return { review, initiatedBy: "mcp_app" as const };
    };
    const baselineAction = actionForRevisionDigits(1);
    const exactAction = actionForRevisionDigits(1 + 16_384 - byteLength(baselineAction));
    const overAction = actionForRevisionDigits(2 + 16_384 - byteLength(baselineAction));
    expect(walletOperationInputLimits).toEqual({ actionUtf8Bytes: 16_384 });
    expect(byteLength(exactAction)).toBe(16_384);
    expect(byteLength(overAction)).toBe(16_385);
    expect(parseWalletDirectAction(exactAction)).toEqual(exactAction);
    expect(() => parseWalletDirectAction(overAction)).toThrow("canonical byte limit");

    const cancellationForRevisionDigits = (digitCount: number) => ({
      operationId,
      reviewDigest: exactAction.review.reviewDigest,
      expectedState: "starting_connection" as const,
      connectionRevision: "9".repeat(digitCount),
    });
    const baselineCancellation = cancellationForRevisionDigits(1);
    const exactCancellation = cancellationForRevisionDigits(
      1 + 16_384 - byteLength(baselineCancellation),
    );
    const overCancellation = cancellationForRevisionDigits(
      2 + 16_384 - byteLength(baselineCancellation),
    );
    expect(byteLength(exactCancellation)).toBe(16_384);
    expect(byteLength(overCancellation)).toBe(16_385);
    expect(parseWalletOperationCancellation(exactCancellation)).toEqual(exactCancellation);
    expect(() => parseWalletOperationCancellation(overCancellation)).toThrow("canonical byte limit");

    const projectedCancellation = {
      operationId,
      reviewDigest: exactAction.review.reviewDigest,
      expectedState: "starting_connection" as const,
      connectionRevision: exactAction.review.precondition.connectionRevision,
    };
    expect(byteLength(projectedCancellation)).toBeLessThan(16_384);
    expect(parseWalletOperationCancellation(projectedCancellation)).toEqual(projectedCancellation);

    const maximumIdentifiers = (prefix: "e" | "m") => Object.freeze(
      Array.from({ length: 64 }, (_, index) =>
        `${prefix}${String(index).padStart(2, "0")}_${"x".repeat(60)}`),
    );
    const maximumProductionOperation = parseWalletManagementOperation({
      contractVersion: "1",
      domain: "wallet",
      operationId,
      kind: "connect",
      initiatedBy: "mcp_app",
      review: exactAction.review,
      state: "completed",
      terminationTarget: null,
      result: {
        outcome: "connected",
        connectionRevision: String(
          BigInt(exactAction.review.precondition.connectionRevision) + 1n,
        ),
        connection: {
          status: "connected",
          address,
          chainId: "eip155:4663",
          approvedMethods: maximumIdentifiers("m"),
          approvedEvents: maximumIdentifiers("e"),
          expiresAt: "2026-07-15T00:00:00.000Z",
        },
      },
      failure: null,
      peerRefusalCode: null,
    });
    expect(byteLength(maximumProductionOperation)).toBeLessThan(65_535);
  });

  it("binds every Review field into one digest and rejects changed structure", () => {
    const review = createReview("connect");
    expect(Object.isFrozen(review)).toBe(true);
    expect(parseWalletReview(review)).toEqual(review);

    expect(() => parseWalletReview({
      ...review,
      target: { chainId: "eip155:1" },
    })).toThrow("Wallet Review is inconsistent");
    expect(() => parseWalletReview({
      ...review,
      actionExpiresAt: "2026-07-14T00:05:00.001Z",
    })).toThrow("Wallet Review is inconsistent");
    expect(createReview("disconnect").fixedEvidence.sessionSourceIds).toEqual([sourceId]);
  });

  it.each(["connect", "disconnect"] as const)(
    "rejects a %s Review interval even with an independently recomputed digest",
    (kind) => {
      const { reviewDigest: _digest, ...original } = createReview(kind);
      const changed = { ...original, actionExpiresAt: "2026-07-14T00:05:00.001Z" };
      const reviewDigest = `0x${createHash("sha256").update(canonicalJsonStringify({
        digestKind: "wallet_connection_change_review",
        digestVersion: "1",
        review: captureCanonicalJson(changed),
      })).digest("hex")}`;
      expect(reviewDigest).toBe(walletReviewDigest(changed));
      expect(() => parseWalletReview({ ...changed, reviewDigest })).toThrow("Wallet Review is inconsistent");
    },
  );

  it("admits direct decisions only with the complete Review and final initiator vocabulary", () => {
    const review = createReview("connect");
    expect(walletInitiators).toEqual(["cli", "mcp_app"]);
    expect(parseWalletDirectAction({ review, initiatedBy: "cli" }))
      .toEqual({ review, initiatedBy: "cli" });
    expect(parseWalletDirectAction({ review, initiatedBy: "mcp_app" }))
      .toEqual({ review, initiatedBy: "mcp_app" });
    expect(() => parseWalletDirectAction({ review, initiatedBy: "web" })).toThrow();
    expect(() => parseWalletDirectAction({
      review: { ...review, operationId: otherOperationId },
      initiatedBy: "cli",
    })).toThrow();
  });

  it("binds a complete ordered unresolved session set within the existing action byte cap", () => {
    const { reviewDigest: _digest, ...base } = createReview("disconnect");
    const sourceIds = Array.from({ length: 256 }, (_, value) =>
      `wallet-session:${Buffer.alloc(32, value).toString("base64url")}`).sort();
    const input = { ...base,
      precondition: { connectionRevision: "9223372036854775807", connection: { status: "unresolved", sessionCount: "256" } },
      fixedEvidence: { sessionSourceIds: sourceIds },
    };
    const review = parseWalletReview({ ...input, reviewDigest: walletReviewDigest(input) });
    const action = { review, initiatedBy: "mcp_app" };
    expect(Buffer.byteLength(JSON.stringify(action), "utf8")).toBeLessThanOrEqual(16_384);
    expect(parseWalletDirectAction(action).review.fixedEvidence.sessionSourceIds).toEqual(sourceIds);

    const independentDigest = (value: unknown) => `0x${createHash("sha256").update(canonicalJsonStringify({
      digestKind: "wallet_connection_change_review", digestVersion: "1", review: captureCanonicalJson(value),
    })).digest("hex")}`;
    for (const ids of [[sourceIds[1]!, sourceIds[0]!], [sourceIds[0]!, sourceIds[0]!]]) {
      const invalid = { ...input, precondition: { ...input.precondition, connection: { status: "unresolved", sessionCount: "2" } }, fixedEvidence: { sessionSourceIds: ids } };
      expect(() => parseWalletReview({ ...invalid, reviewDigest: independentDigest(invalid) })).toThrow("strictly ordered and unique");
    }
    const incomplete = { ...input, fixedEvidence: { sessionSourceIds: sourceIds.slice(1) } };
    expect(() => parseWalletReview({ ...incomplete, reviewDigest: independentDigest(incomplete) })).toThrow("Wallet Review is inconsistent");
  });

  it("makes operation kind, state payload, Review, and initiator one immutable value", () => {
    const starting = createOperation("connect", "starting_connection");
    expect(starting).toMatchObject({
      kind: "connect",
      initiatedBy: "mcp_app",
      state: "starting_connection",
      result: null,
      failure: null,
      peerRefusalCode: null,
      review: { kind: "connect" },
    });
    expect(Object.isFrozen(starting)).toBe(true);

    const failed = createOperation("disconnect", "failed");
    expect(failed).toMatchObject({
      kind: "disconnect",
      state: "failed",
      result: null,
      failure: { error: { code: "wallet_timeout" } },
      review: { kind: "disconnect" },
    });

    expect(() => createOperation("connect", "completed", {
      result: {
        outcome: "connected",
        connectionRevision: "3",
        connection: connected,
      },
    })).toThrow("Wallet operation result is inconsistent");
  });

  it("allows only declared transitions without replacing Review or initiator identity", () => {
    const starting = createOperation("connect", "starting_connection");
    const awaiting = createOperation("connect", "awaiting_wallet_approval");
    expect(assertWalletOperationTransition(
      starting as WalletNonterminalManagementOperation,
      awaiting,
    )).toEqual(awaiting);

    expect(() => assertWalletOperationTransition(
      starting as WalletNonterminalManagementOperation,
      createOperation("connect", "rejected"),
    ))
      .toThrow("Wallet operation transition is invalid");
    expect(() => assertWalletOperationTransition(starting as WalletNonterminalManagementOperation, createOperation(
      "connect",
      "awaiting_wallet_approval",
      { initiatedBy: "cli" },
    ))).toThrow("Wallet operation transition is invalid");
    expect(() => assertWalletOperationTransition(starting as WalletNonterminalManagementOperation, {
      ...awaiting,
      review: createReview("connect", otherOperationId),
      operationId: starting.operationId,
    } as unknown as WalletManagementOperation)).toThrow();
  });

  it("binds cancellation to the exact active state, Review digest, and connection revision", () => {
    const awaiting = createOperation("connect", "awaiting_wallet_approval");
    const input = {
      operationId: awaiting.operationId,
      reviewDigest: awaiting.review.reviewDigest,
      expectedState: awaiting.state,
      connectionRevision: awaiting.review.precondition.connectionRevision,
    };
    expect(parseWalletOperationCancellation(input)).toEqual(input);
    expect(isWalletOperationCancellableState(awaiting.state)).toBe(true);
    expect(() => parseWalletOperationCancellation({ ...input, expectedState: "validating_session" }))
      .toThrow();
    expect(() => parseWalletOperationCancellation({ operationId: awaiting.operationId }))
      .toThrow();
  });

  it("permits QR only on the exact active approval state and never on terminal values", () => {
    const awaiting = createOperation("connect", "awaiting_wallet_approval");
    expect(walletOperationAllowsQr(awaiting)).toBe(true);
    expect(parseWalletOperationPresentation({ operation: awaiting, qr })).toEqual({
      operation: awaiting,
      qr,
    });

    const completed = createOperation("connect", "completed");
    expect(walletOperationAllowsQr(completed)).toBe(false);
    expect(parseWalletOperationPresentation({ operation: completed })).toEqual({ operation: completed });
    expect(() => parseWalletOperationPresentation({ operation: completed, qr }))
      .toThrow("QR is not active");
  });
});
