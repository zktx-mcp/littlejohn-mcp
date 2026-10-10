import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
} from "../../src/core/index.js";
import {walletDisconnectManifestSchema} from "../../src/wallet/operation-contract.js";
import { createWalletFailure } from "../../src/wallet/operation-error.js";
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
  connectionId: sourceId,
  namespaces: [{key: "eip155", accounts: [`eip155:4663:${address}`], methods: ["eth_sendTransaction"], events: ["accountsChanged", "chainChanged"]}],
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
        precondition: { connectionRevision, targetSet: {kind: "inline" as const, targets: [{status: "available" as const, sourceId, connection: connected}]} },
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
      ? { kind: "connected", connectionRevision: "4", connectionId: sourceId }
      : {
          kind: "disconnected", connectionRevision: "4",
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
  it("retains the direct-action cap and rejects aggregate targets before external work", () => {
    expect(walletOperationInputLimits).toEqual({actionUtf8Bytes: 16_384});
    const connectedAccounts = Array.from({length: 64}, (_, index) => `eip155:4663:0x${index.toString(16).padStart(40, "0")}`);
    const methods = Array.from({length: 64}, (_, index) => `m${index.toString().padStart(2, "0")}_${"x".repeat(60)}`);
    const sourceIds = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)].map(value => `wallet-session:${value.toString("base64url")}`).sort();
    const targets = sourceIds.map(source => ({status: "available" as const, sourceId: source,
      connection: {...connected, connectionId: source, namespaces: [{key: "eip155", accounts: connectedAccounts, methods, events: []}]}}));
    const {reviewDigest: _digest, ...original} = createReview("disconnect");
    const reviewed = (values: typeof targets) => {
      const fields = {...original, precondition: {connectionRevision: "3", targetSet: {kind: "inline", targets: values}}};
      return parseWalletReview({...fields, reviewDigest: walletReviewDigest(fields)});
    };
    for (const target of targets) expect(parseWalletDirectAction({review: reviewed([target]), initiatedBy: "mcp_app"}).review).toEqual(reviewed([target]));
    const combined = {review: reviewed(targets), initiatedBy: "mcp_app"};
    expect(Buffer.byteLength(canonicalJsonStringify(captureCanonicalJson(combined)))).toBeGreaterThan(16_384);
    expect(() => parseWalletDirectAction(combined)).toThrow("canonical byte limit");
    const cancellation = {operationId, reviewDigest: createReview("connect").reviewDigest, expectedState: "starting_connection", connectionRevision: "9223372036854775807"};
    expect(parseWalletOperationCancellation(cancellation)).toEqual(cancellation);
    expect(() => parseWalletOperationCancellation({...cancellation, connectionRevision: "9223372036854775808"})).toThrow();
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
    const disconnect = createReview("disconnect");
    if (disconnect.kind !== "disconnect" || disconnect.precondition.targetSet.kind !== "inline") throw new Error("Inline disconnect fixture required.");
    expect(disconnect.precondition.targetSet.targets.map(value => value.sourceId)).toEqual([sourceId]);
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

  it("admits a sorted immutable target manifest and rejects duplicate or reordered source identities", () => {
    const sourceIds = Array.from({length: 256}, (_, value) => `wallet-session:${Buffer.alloc(32, value).toString("base64url")}`).sort();
    const references = sourceIds.map((sourceId, index) => ({sourceId, facts: {snapshotId: "sha256:" + index.toString(16).padStart(64, "0"),
      contractId: "wallet.disconnect_target", contractVersion: "1", resultDigest: "a".repeat(64), resultLength: 120}}));
    expect(walletDisconnectManifestSchema.parse(references)).toEqual(references);
    for (const values of [[references[1]!, references[0]!], [references[0]!, references[0]!]]) expect(() => walletDisconnectManifestSchema.parse(values)).toThrow();
    const {reviewDigest: _digest, ...fields} = createReview("disconnect");
    const value = {...fields, precondition: {connectionRevision: "9223372036854775807", targetSet: {kind: "snapshot",
      reference: {snapshotId: "sha256:" + "b".repeat(64), contractId: "wallet.disconnect_targets", contractVersion: "1", resultDigest: "c".repeat(64), resultLength: 60_000}}}};
    const review = parseWalletReview({...value, reviewDigest: walletReviewDigest(value)});
    expect(parseWalletDirectAction({review, initiatedBy: "mcp_app"}).review).toEqual(review);
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
        kind: "connected", connectionRevision: "3", connectionId: sourceId,
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
