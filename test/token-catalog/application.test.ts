import { describe, expect, it, vi } from "vitest";

import {
  createObservationAuthority,
  createCanonicalClock,
  parseCapabilityDataAt,
  parseUnsignedDecimal,
  parseUtcTimestamp,
  sourceReferenceSchema,
  walletConnectionCapability,
} from "../../src/core/index.js";
import { createTokenCatalogApplication } from "../../src/token-catalog/application.js";
import { createAddressTargetResolver } from "../../src/chain/address-target.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import type {
  TokenCatalogOperationCoordinatorPort,
  TokenCatalogQueryStore,
} from "../../src/token-catalog/ports.js";
import {
  chainId,
  createInspectionSuccess,
  createTokenOperation,
  createTokenSelectionDetail,
  tokenAddress,
  walletAddress,
} from "./harness.js";

const asset = Object.freeze({ kind: "erc20" as const, chainId, address: tokenAddress });
const account = Object.freeze({ chainId, address: walletAddress });
const activeTarget = Object.freeze({ kind: "active_wallet" as const });

const activeWallet = () => {
  const observedAt = parseUtcTimestamp("2026-07-18T00:00:03.000Z");
  const clock = createCanonicalClock(() => observedAt);
  const topicDigest = "A".repeat(43);
  const sourceId = `wallet-session:${topicDigest}`;
  return Object.freeze({
    capture: () => Object.freeze({
      connection: parseCapabilityDataAt(walletConnectionCapability, {
        status: "connected",
        ...account,
        approvedMethods: ["eth_sendTransaction"],
        approvedEvents: ["accountsChanged", "chainChanged"],
        expiresAt: "2026-07-19T00:00:00.000Z",
      }, observedAt),
      connectionRevision: parseUnsignedDecimal("1"),
      sessionSource: Object.freeze({
        sourceId,
        candidateId: sourceId,
        topicDigest,
        observationAuthority: createObservationAuthority({
          clock,
          sourceClass: "wallet_session",
          owner: "WalletConnect session",
          reference: sourceReferenceSchema.parse({ kind: "wallet_session", sourceId, topicDigest }),
        }),
      }),
    }),
  });
};

describe("token catalog application", () => {
  it("reads an explicit account while Wallet capture is unavailable", async () => {
    const detail = createTokenSelectionDetail(await createInspectionSuccess());
    const explicitTarget = { kind: "address" as const, address: walletAddress };
    const application = createTokenCatalogApplication({
      dependencies: {
        addressTargets: createAddressTargetResolver({
          chainId,
          activeWallet: Object.freeze({
            capture: () => { throw new Error("Wallet capture must not run."); },
          }),
        }),
        store: Object.freeze({
          getSelection: () => detail,
          getSelectionState: () => undefined,
          listSelections: () => Object.freeze({ selections: [detail.selection], nextCursor: null }),
        }),
      },
      operations: Object.freeze({
        review: async () => { throw new Error("not used"); },
        decide: async () => { throw new Error("not used"); },
        getOperation: () => { throw new Error("not used"); },
      }),
    });
    expect(application.getSelection({ account: explicitTarget, asset })).toEqual(detail);
    expect(application.listSelections({ account: explicitTarget, limit: 25 })).toEqual({
      account,
      selections: [detail.selection],
      nextCursor: null,
    });
  });

  it("derives query scope from the active wallet and rejects cross-account storage output", async () => {
    const detail = createTokenSelectionDetail(await createInspectionSuccess());
    const getSelection = vi.fn((_account, _asset) => detail);
    const listSelections = vi.fn(() => Object.freeze({ selections: [detail.selection], nextCursor: null }));
    const operations = Object.freeze({
      review: async () => { throw new Error("not used"); },
      decide: async () => { throw new Error("not used"); },
      getOperation: () => { throw new Error("not used"); },
    }) satisfies TokenCatalogOperationCoordinatorPort;
    const application = createTokenCatalogApplication({
      dependencies: {
        addressTargets: createAddressTargetResolver({ chainId, activeWallet: activeWallet() }),
        store: Object.freeze({ getSelection, listSelections, getSelectionState: () => undefined }),
      },
      operations,
    });

    expect(application.getSelection({ account: activeTarget, asset })).toEqual(detail);
    expect(getSelection).toHaveBeenCalledWith(account, asset);
    expect(application.listSelections({ account: activeTarget, limit: 25 })).toEqual({
      account,
      selections: [detail.selection],
      nextCursor: null,
    });
    expect(listSelections).toHaveBeenCalledWith({ account, limit: 25, cursor: null });

    const foreign = Object.freeze({
      ...detail,
      selection: Object.freeze({
        ...detail.selection,
        account: Object.freeze({ chainId, address: `0x${"ff".repeat(20)}` as never }),
      }),
    });
    const invalidStore: TokenCatalogQueryStore = Object.freeze({
      getSelection: () => foreign,
      getSelectionState: () => undefined,
      listSelections: () => Object.freeze({ selections: [foreign.selection], nextCursor: null }),
    });
    const guarded = createTokenCatalogApplication({
      dependencies: {
        addressTargets: createAddressTargetResolver({ chainId, activeWallet: activeWallet() }),
        store: invalidStore,
      },
      operations,
    });
    expect(guarded.getSelection({ account: activeTarget, asset }))
      .toMatchObject({ ok: false, error: { code: "internal_error" } });
    expect(guarded.listSelections({ account: activeTarget, limit: 25 }))
      .toMatchObject({ ok: false, error: { code: "internal_error" } });
  });

  it("passes the exact Review, action, and operation identity through one management owner", async () => {
    const operation = await createTokenOperation({ kind: "add", initiatedBy: "cli" });
    const review = vi.fn(async () => Object.freeze({ review: operation.review }));
    const decide = vi.fn(async () => operation);
    const getOperation = vi.fn(() => operation);
    const application = createTokenCatalogApplication({
      dependencies: {
        addressTargets: createAddressTargetResolver({ chainId, activeWallet: activeWallet() }),
        store: Object.freeze({
          getSelection: () => undefined,
          getSelectionState: () => undefined,
          listSelections: () => Object.freeze({ selections: [], nextCursor: null }),
        }),
      },
      operations: Object.freeze({ review, decide, getOperation }),
    });

    expect(await application.review({ kind: "add", account: activeTarget, asset }))
      .toEqual({ review: operation.review });
    expect(review).toHaveBeenCalledWith({ kind: "add", account: activeTarget, asset });
    expect(await application.decide({ review: operation.review, initiatedBy: "cli" }))
      .toEqual(operation);
    expect(decide).toHaveBeenCalledWith({ review: operation.review, initiatedBy: "cli" });
    expect(application.getOperation({ operationId: operation.operationId })).toEqual(operation);
    expect(getOperation).toHaveBeenCalledWith(operation.operationId);
  });

  it("does not let malformed input or undeclared coordinator failures escape a public contract", async () => {
    const operation = await createTokenOperation({ kind: "add" });
    const application = createTokenCatalogApplication({
      dependencies: {
        addressTargets: createAddressTargetResolver({ chainId, activeWallet: activeWallet() }),
        store: Object.freeze({
          getSelection: () => undefined,
          getSelectionState: () => undefined,
          listSelections: () => Object.freeze({ selections: [], nextCursor: null }),
        }),
      },
      operations: Object.freeze({
        review: async () => { throw new TokenCatalogOperationError("token_operation_not_found"); },
        decide: async () => { throw new TokenCatalogOperationError("token_operation_not_found"); },
        getOperation: () => { throw new TokenCatalogOperationError("token_operation_not_found"); },
      }),
    });

    expect(await application.review({ kind: "add", account: activeTarget, asset: {} } as never))
      .toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await application.review({ kind: "add", account: activeTarget, asset }))
      .toMatchObject({ ok: false, error: { code: "internal_error" } });
    expect(await application.decide({ review: operation.review, initiatedBy: "mcp_app" }))
      .toMatchObject({ ok: false, error: { code: "internal_error" } });
    expect(application.getOperation({ operationId: operation.operationId }))
      .toMatchObject({ ok: false, error: { code: "token_operation_not_found" } });
  });
});
