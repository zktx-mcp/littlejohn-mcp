import { describe, expect, it } from "vitest";

import { createWalletFailure } from "../../src/wallet/errors.js";
import {
  assertWalletOperationTransition,
  operationFailure,
  parseWalletDirectAction,
  parseWalletManagementOperation,
  parseWalletOperationCancellation,
  parseWalletOperationPresentation,
  parseWalletReview,
  walletOperationAllowsQr,
  walletOperationIdByteLength,
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
          requiredEvents: ["accountsChanged", "chainChanged"] as const,
        },
        precondition: { connectionRevision: "3", connection: disconnected },
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
        precondition: { connectionRevision: "3", connection: connected },
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
