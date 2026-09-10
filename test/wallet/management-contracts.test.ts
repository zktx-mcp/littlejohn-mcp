import { describe, expect, it } from "vitest";

import {
  parseWalletManagementOperation,
  parseWalletReview,
  walletManagementCapabilityIdList,
  walletManagementContractList,
  walletManagementContracts,
  walletReviewDigest,
  type WalletReview,
} from "../../src/wallet/contracts.js";

const operationId = Buffer.alloc(32, 61).toString("base64url");
const otherOperationId = Buffer.alloc(32, 62).toString("base64url");

const review = (id = operationId): WalletReview => {
  const withoutDigest = {
    contractVersion: "1" as const,
    domain: "wallet" as const,
    kind: "connect" as const,
    operationId: id,
    createdAt: "2026-07-14T00:00:00.000Z",
    actionExpiresAt: "2026-07-14T00:05:00.000Z",
    target: { chainId: "eip155:4663" },
    decision: {
      requiredMethods: ["eth_sendTransaction"] as const,
      optionalMethods: ["personal_sign", "eth_signTypedData_v4"] as const,
      requiredEvents: ["accountsChanged", "chainChanged"] as const,
    },
    precondition: {
      connectionRevision: "3",
      connection: { status: "disconnected" as const, reason: "no_session" as const },
    },
    fixedEvidence: { sessionSourceIds: [] as const },
  };
  return parseWalletReview({ ...withoutDigest, reviewDigest: walletReviewDigest(withoutDigest) });
};

const operation = (value = review()) => parseWalletManagementOperation({
  contractVersion: "1",
  domain: "wallet",
  operationId: value.operationId,
  kind: "connect",
  initiatedBy: "cli",
  review: value,
  state: "starting_connection",
  terminationTarget: null,
  result: null,
  failure: null,
  peerRefusalCode: null,
});

describe("wallet application contract ownership", () => {
  it("owns one closed contract list for Review, decisions, exact read, and cancellation", () => {
    expect(walletManagementCapabilityIdList).toEqual([
      "wallet.connection_change_review",
      "wallet.connect",
      "wallet.disconnect",
      "wallet.operation",
      "wallet.cancel_operation",
    ]);
    expect(walletManagementContractList.map((contract) => contract.contractVersion))
      .toEqual(["1", "1", "1", "1", "1"]);
    expect(new Set(walletManagementCapabilityIdList).size)
      .toBe(walletManagementCapabilityIdList.length);
  });

  it("keeps Review creation pure in its public result vocabulary", () => {
    const candidate = review();
    expect(walletManagementContracts.review.parsePublicSuccess(
      { kind: "connect" },
      { status: "review", review: candidate },
    )).toEqual({ status: "review", review: candidate });
    expect(walletManagementContracts.review.parsePublicSuccess(
      { kind: "connect" },
      {
        status: "current_connection",
        connectionRevision: "4",
        connection: {
          status: "connected",
          address: "0x1111111111111111111111111111111111111111",
          chainId: "eip155:4663",
          approvedMethods: ["eth_sendTransaction"],
          approvedEvents: ["accountsChanged", "chainChanged"],
          expiresAt: "2026-07-15T00:00:00.000Z",
        },
      },
    )).toMatchObject({ status: "current_connection" });
    expect(() => walletManagementContracts.review.parsePublicSuccess(
      { kind: "disconnect" },
      { status: "review", review: candidate },
    )).toThrow("does not match its request");
  });

  it("binds a decision result to the complete carried Review identity", () => {
    const candidate = review();
    const action = { review: candidate, initiatedBy: "cli" as const };
    const started = operation(candidate);
    expect(walletManagementContracts.connect.parsePublicSuccess(action, started)).toEqual(started);

    expect(() => walletManagementContracts.connect.parsePublicSuccess(
      action,
      operation(review(otherOperationId)),
    )).toThrow("does not match its direct action");
    expect(() => walletManagementContracts.disconnect.parseInput(action)).toThrow();
  });

  it("binds exact reads and cancellation results to their requested identity", () => {
    const started = operation();
    expect(walletManagementContracts.operation.parsePublicSuccess(
      { operationId },
      started,
    )).toEqual(started);
    expect(() => walletManagementContracts.operation.parsePublicSuccess(
      { operationId: otherOperationId },
      started,
    )).toThrow("does not match its request");

    const cancellation = {
      operationId,
      reviewDigest: started.review.reviewDigest,
      expectedState: "starting_connection" as const,
      connectionRevision: started.review.precondition.connectionRevision,
    };
    expect(walletManagementContracts.cancelOperation.parsePublicSuccess(
      cancellation,
      started,
    )).toEqual(started);
    expect(() => walletManagementContracts.cancelOperation.parsePublicSuccess(
      { ...cancellation, connectionRevision: "4" },
      started,
    )).toThrow("does not match its request");
  });
});
