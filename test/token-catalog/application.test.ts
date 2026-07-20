import { describe, expect, it } from "vitest";

import {
  parseCapabilityDataAt,
  parseEvmAddress,
  parseEvmChainId,
  parseUtcTimestamp,
  parseUnsignedDecimal,
  walletConnectionCapability,
  type EvmAccountIdentity,
} from "../../src/core/index.js";
import { RuntimeOperationError } from "../../src/runtime/errors.js";
import { createTokenCatalogApplication } from "../../src/token-catalog/application.js";
import {
  tokenCatalogOperationSchema,
  tokenInspectionDigest,
  tokenRegistrationWithInspectionSchema,
  type TokenCatalogAwaitingOperation,
  type TokenCatalogOperation,
  type TokenCatalogTerminalOperation,
} from "../../src/token-catalog/contracts.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import type {
  TokenCatalogApplicationDependencies,
  TokenCatalogOperationCoordinatorPort,
} from "../../src/token-catalog/ports.js";
import type { ActiveWalletReadPort } from "../../src/wallet/coordinator.js";
import { chainId, createInspectionSuccess, tokenAddress, walletAddress } from "./harness.js";

const now = parseUtcTimestamp("2026-07-18T00:00:03.000Z");
const connectionRevision = parseUnsignedDecimal("0");
const webControl = Object.freeze({
  operationId: "A".repeat(43),
  interactionInterface: "web" as const,
});
const connected = parseCapabilityDataAt(walletConnectionCapability, {
  status: "connected",
  chainId,
  address: walletAddress,
  approvedMethods: ["eth_sendTransaction"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt: "2026-07-19T00:00:00.000Z",
}, now);

const unavailable = (): never => { throw new Error("Operation fixture is unavailable."); };
const operations = Object.freeze({
  startRegistration: async () => unavailable(),
  startUnregistration: async () => unavailable(),
  getOperation: unavailable,
  getCurrentOperation: () => null,
  confirm: async () => unavailable(),
  cancel: async () => unavailable(),
}) satisfies TokenCatalogOperationCoordinatorPort;

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

describe("token catalog internal application", () => {
  it("derives the account from the live wallet and never accepts caller-owned account scope", async () => {
    const inspection = await createInspectionSuccess();
    const stored = tokenRegistrationWithInspectionSchema.parse({
      registration: {
        account: { chainId, address: walletAddress },
        asset: inspection.data.asset,
        revision: "AQEBAQEBAQEBAQEBAQEBAQ",
        inspectionDigest: tokenInspectionDigest(inspection),
        createdAt: now,
      },
      inspection,
    });
    let observedAccount: EvmAccountIdentity | undefined;
    const store = Object.freeze({
      getRegistration: (account: EvmAccountIdentity) => { observedAccount = account; return stored; },
      listRegistrations: (request: Parameters<TokenCatalogApplicationDependencies["store"]["listRegistrations"]>[0]) => {
        observedAccount = request.account;
        return { registrations: [stored.registration], nextCursor: null };
      },
    }) satisfies TokenCatalogApplicationDependencies["store"];
    const application = createTokenCatalogApplication({
      dependencies: {
        activeWallet: { capture: () => ({ connection: connected, connectionRevision, sessionSource: {} as never }) },
        store,
      },
      operations,
    });

    const result = application.getRegistration({ asset: inspection.data.asset });
    expect("ok" in result).toBe(false);
    expect(observedAccount).toEqual({ chainId, address: walletAddress });
    const listed = application.listRegistrations({ limit: 1 });
    expect("ok" in listed).toBe(false);
    expect(observedAccount).toEqual({ chainId, address: walletAddress });
    const forged = application.getRegistration({
      asset: inspection.data.asset,
      account: { chainId, address: `0x${"56".repeat(20)}` },
    } as never);
    expect(forged).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("distinguishes live-wallet and storage failures from invalid caller input", async () => {
    const inspection = await createInspectionSuccess();
    const create = (
      capture: ActiveWalletReadPort["capture"],
      getRegistration: TokenCatalogApplicationDependencies["store"]["getRegistration"] = () => undefined,
    ) => createTokenCatalogApplication({
      dependencies: {
        activeWallet: { capture },
        store: {
          getRegistration,
          listRegistrations: unavailable,
        },
      },
      operations,
    });

    expect(create(() => ({ connection: { status: "disconnected", reason: "no_session" }, connectionRevision }))
      .getRegistration({ asset: inspection.data.asset }))
      .toMatchObject({ ok: false, error: { code: "wallet_not_connected" } });
    expect(create(() => ({ connection: connected, connectionRevision }))
      .getRegistration({ asset: inspection.data.asset }))
      .toMatchObject({ ok: false, error: { code: "wallet_session_unusable" } });
    expect(create(
      () => ({ connection: connected, connectionRevision, sessionSource: {} as never }),
      () => { throw new TokenCatalogOperationError("runtime_state_unavailable"); },
    ).getRegistration({ asset: inspection.data.asset }))
      .toMatchObject({ ok: false, error: { code: "runtime_state_unavailable" } });
    expect(create(
      () => ({ connection: connected, connectionRevision, sessionSource: {} as never }),
      () => { throw new RuntimeOperationError("runtime_state_unavailable"); },
    ).getRegistration({ asset: inspection.data.asset }))
      .toMatchObject({ ok: false, error: { code: "runtime_state_unavailable" } });
    expect(create(() => ({ connection: connected, connectionRevision, sessionSource: {} as never }))
      .getRegistration({ asset: { ...inspection.data.asset, chainId: parseEvmChainId("eip155:1") } }))
      .toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("rejects query-store results outside the captured live account", async () => {
    const inspection = await createInspectionSuccess();
    const wrongAccountRegistration = tokenRegistrationWithInspectionSchema.parse({
      registration: {
        account: { chainId, address: `0x${"56".repeat(20)}` },
        asset: inspection.data.asset,
        revision: "AQEBAQEBAQEBAQEBAQEBAQ",
        inspectionDigest: tokenInspectionDigest(inspection),
        createdAt: now,
      },
      inspection,
    });
    const application = createTokenCatalogApplication({
      dependencies: {
        activeWallet: {
          capture: () => ({ connection: connected, connectionRevision, sessionSource: {} as never }),
        },
        store: {
          getRegistration: () => wrongAccountRegistration,
          listRegistrations: () => ({
            registrations: [wrongAccountRegistration.registration],
            nextCursor: null,
          }),
        },
      },
      operations,
    });

    expect(application.getRegistration({ asset: inspection.data.asset }))
      .toMatchObject({ ok: false, error: { code: "internal_error" } });
    expect(application.listRegistrations({ limit: 1 }))
      .toMatchObject({ ok: false, error: { code: "internal_error" } });
  });

  it("rejects a started operation outside the requested interaction interface", async () => {
    const inspection = await createInspectionSuccess();
    const operation = tokenCatalogOperationSchema.parse({
      operationId: "A".repeat(43),
      kind: "register",
      state: "awaiting_confirmation",
      interactionInterface: "cli",
      createdAt: now,
      expiresAt: "2026-07-18T00:05:03.000Z",
      account: { chainId, address: walletAddress },
      connectionRevision,
      asset: inspection.data.asset,
      review: {
        previousRegistration: null,
        inspection,
        reviewDigest: `0x${"ab".repeat(32)}`,
      },
      result: null,
      failure: null,
    }) as TokenCatalogAwaitingOperation<"register">;
    const maliciousOperations = Object.freeze({
      ...operations,
      startRegistration: async () => ({ operation }),
    }) as unknown as TokenCatalogOperationCoordinatorPort;
    const application = createTokenCatalogApplication({
      dependencies: {
        activeWallet: { capture: () => ({ connection: connected, connectionRevision, sessionSource: {} as never }) },
        store: { getRegistration: unavailable, listRegistrations: unavailable },
      },
      operations: maliciousOperations,
    });

    expect(await application.startRegistration({ asset: inspection.data.asset }, webControl))
      .toMatchObject({ ok: false, error: { code: "internal_error" } });
  });

  it("allows only failures declared by the exact application contract", async () => {
    const inspection = await createInspectionSuccess();
    const create = (startRegistration: TokenCatalogOperationCoordinatorPort["startRegistration"]) =>
      createTokenCatalogApplication({
        dependencies: {
          activeWallet: { capture: () => ({ connection: connected, connectionRevision, sessionSource: {} as never }) },
          store: { getRegistration: unavailable, listRegistrations: unavailable },
        },
        operations: Object.freeze({ ...operations, startRegistration }),
      });

    const declared = new TokenCatalogOperationError("rate_limited").failure;
    expect(await create(async () => declared).startRegistration({ asset: inspection.data.asset }, webControl))
      .toEqual(declared);

    const undeclared = new TokenCatalogOperationError("token_operation_not_found").failure;
    expect(await create(async () => undeclared).startRegistration({ asset: inspection.data.asset }, webControl))
      .toMatchObject({ ok: false, error: { code: "internal_error" } });

    const malformed = {
      ...declared,
      error: { ...declared.error, message: "Forged failure message." },
    };
    expect(await create(async () => malformed as never)
      .startRegistration({ asset: inspection.data.asset }, webControl))
      .toMatchObject({ ok: false, error: { code: "internal_error" } });
  });

  it("validates awaited start and cancellation results against the frozen normalized request", async () => {
    const inspection = await createInspectionSuccess();
    const operation = tokenCatalogOperationSchema.parse({
      operationId: "A".repeat(43),
      kind: "register",
      state: "awaiting_confirmation",
      interactionInterface: "web",
      createdAt: now,
      expiresAt: "2026-07-18T00:05:03.000Z",
      account: { chainId, address: walletAddress },
      connectionRevision,
      asset: inspection.data.asset,
      review: {
        previousRegistration: null,
        inspection,
        reviewDigest: `0x${"ab".repeat(32)}`,
      },
      result: null,
      failure: null,
    }) as TokenCatalogAwaitingOperation<"register">;
    const cancelled = tokenCatalogOperationSchema.parse({
      ...operation,
      state: "cancelled",
    }) as TokenCatalogTerminalOperation;
    const startGate = deferred<Readonly<{ operation: TokenCatalogAwaitingOperation<"register"> }>>();
    const cancelGate = deferred<TokenCatalogTerminalOperation>();
    let receivedStart: unknown;
    let receivedCancellationId: string | undefined;
    const delayedOperations = Object.freeze({
      ...operations,
      startRegistration: async (request: unknown) => {
        receivedStart = request;
        return startGate.promise;
      },
      cancel: async (operationId: string) => {
        receivedCancellationId = operationId;
        return cancelGate.promise;
      },
    }) satisfies TokenCatalogOperationCoordinatorPort;
    const application = createTokenCatalogApplication({
      dependencies: {
        activeWallet: { capture: () => ({ connection: connected, connectionRevision, sessionSource: {} as never }) },
        store: { getRegistration: unavailable, listRegistrations: unavailable },
      },
      operations: delayedOperations,
    });

    const startInput = { asset: { ...inspection.data.asset } };
    const pendingStart = application.startRegistration(startInput, webControl);
    startInput.asset = { ...startInput.asset, address: parseEvmAddress(`0x${"34".repeat(20)}`) };
    startGate.resolve({ operation });
    expect(await pendingStart).toEqual({ operation });
    expect(receivedStart).toEqual({
      asset: inspection.data.asset,
    });
    expect(Object.isFrozen(receivedStart)).toBe(true);

    const cancelInput = { operationId: operation.operationId };
    const pendingCancellation = application.cancelOperation(cancelInput);
    cancelInput.operationId = "B".repeat(43);
    cancelGate.resolve(cancelled);
    expect(await pendingCancellation).toEqual({ operation: cancelled });
    expect(receivedCancellationId).toBe(operation.operationId);
  });

  it("rejects a nonterminal cancellation result", async () => {
    const inspection = await createInspectionSuccess();
    const applying = tokenCatalogOperationSchema.parse({
      operationId: "A".repeat(43),
      kind: "register",
      state: "applying",
      interactionInterface: "web",
      createdAt: now,
      expiresAt: "2026-07-18T00:05:03.000Z",
      account: { chainId, address: walletAddress },
      connectionRevision,
      asset: inspection.data.asset,
      review: {
        previousRegistration: null,
        inspection,
        reviewDigest: `0x${"ab".repeat(32)}`,
      },
      result: null,
      failure: null,
    });
    const application = createTokenCatalogApplication({
      dependencies: {
        activeWallet: { capture: () => ({ connection: connected, connectionRevision, sessionSource: {} as never }) },
        store: { getRegistration: unavailable, listRegistrations: unavailable },
      },
      operations: Object.freeze({
        ...operations,
        cancel: async () => applying,
      }) as unknown as TokenCatalogOperationCoordinatorPort,
    });

    expect(await application.cancelOperation({ operationId: applying.operationId }))
      .toMatchObject({ ok: false, error: { code: "internal_error" } });
  });
});
