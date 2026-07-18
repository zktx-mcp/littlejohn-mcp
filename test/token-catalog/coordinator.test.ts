import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCanonicalClock,
  createObservationAuthority,
  parseCapabilityDataAt,
  parseHash32,
  parseUtcTimestamp,
  sourceReferenceSchema,
  walletConnectionCapability,
} from "../../src/core/index.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { RuntimeOperationError } from "../../src/runtime/errors.js";
import { ensureOwnerOnlyDirectory, runtimePaths } from "../../src/runtime/paths.js";
import type { WalletSessionSource } from "../../src/runtime/source-identity.js";
import {
  TokenCatalogCoordinator,
} from "../../src/token-catalog/coordinator.js";
import {
  getTokenCatalogOperationFailure,
  TokenCatalogOperationError,
} from "../../src/token-catalog/operation-error.js";
import {
  tokenCatalogContractLimits,
  tokenRegistrationWithInspectionSchema,
} from "../../src/token-catalog/contracts.js";
import { createInspectionBinding, chainId, tokenAddress, walletAddress } from "./harness.js";

const directories: string[] = [];
let currentTime = "2026-07-18T00:00:03.000Z";

afterEach(async () => {
  currentTime = "2026-07-18T00:00:03.000Z";
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createSessionSource = (clock: ReturnType<typeof createCanonicalClock>): WalletSessionSource => {
  const topicDigest = "A".repeat(43);
  const sourceId = `wallet-session:${topicDigest}`;
  return Object.freeze({
    sourceId,
    candidateId: sourceId,
    topicDigest,
    observationAuthority: createObservationAuthority({
      clock,
      sourceClass: "wallet_session",
      owner: "WalletConnect session",
      reference: sourceReferenceSchema.parse({ kind: "wallet_session", sourceId, topicDigest }),
    }),
  });
};

const createState = async (
  inspection = createInspectionBinding(),
  onRegister?: () => void,
  readProjectionError?: () => Error | undefined,
) => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-token-coordinator-"));
  directories.push(directory);
  await ensureOwnerOnlyDirectory(directory);
  const path = runtimePaths(directory).database;
  const database = await ProductDatabase.open(path, parseUtcTimestamp(currentTime));
  database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
  const connection = database.walletStore().replace("0", parseCapabilityDataAt(walletConnectionCapability, {
    status: "connected",
    chainId,
    address: walletAddress,
    approvedMethods: ["eth_sendTransaction"],
    approvedEvents: ["accountsChanged", "chainChanged"],
    expiresAt: "2026-07-19T00:00:00.000Z",
  }, parseUtcTimestamp(currentTime)), parseUtcTimestamp(currentTime));
  const clock = createCanonicalClock(() => currentTime);
  let sessionSource = createSessionSource(clock);
  let liveConnection = connection.connection;
  const controller = new AbortController();
  const catalogStore = database.tokenCatalogStore();
  const operationStore = onRegister === undefined
    ? catalogStore
    : Object.freeze({
        ...catalogStore,
        register: (input: Parameters<typeof catalogStore.register>[0]) => {
          onRegister();
          return catalogStore.register(input);
        },
      });
  const createCoordinator = (signal: AbortSignal = controller.signal) => new TokenCatalogCoordinator({
      activeWallet: {
        capture: () => Object.freeze({ connection: liveConnection, sessionSource }),
      },
      inspection,
      store: operationStore,
      clock,
      readWalletProjection: () => {
        const error = readProjectionError?.();
        if (error !== undefined) throw error;
        return database.walletStore().read();
      },
      signal,
    });
  const coordinator = createCoordinator();
  return {
    path,
    database,
    coordinator,
    controller,
    createCoordinator,
    replaceSessionSource: () => { sessionSource = createSessionSource(clock); },
    disconnectLive: () => { liveConnection = { status: "disconnected", reason: "deleted" }; },
    reconnectProjection: () => {
      const before = database.walletStore().read();
      const disconnected = database.walletStore().replace(
        before.revision,
        { status: "disconnected", reason: "disconnected" },
        parseUtcTimestamp(currentTime),
      );
      const reconnected = database.walletStore().replace(
        disconnected.revision,
        connection.connection,
        parseUtcTimestamp(currentTime),
      );
      liveConnection = reconnected.connection;
    },
  };
};

const failureCode = (error: unknown) => getTokenCatalogOperationFailure(error)?.error.code;

describe("token catalog operation coordinator", () => {
  it("keeps registration mutation absent until exact-interface confirmation", async () => {
    const state = await createState();
    const start = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: "Example", visibility: "visible" },
    }, "web");
    expect("ok" in start).toBe(false);
    if ("ok" in start) throw new Error("Registration start failed.");
    expect(start.operation).toMatchObject({
      kind: "register",
      state: "awaiting_confirmation",
      interactionInterface: "web",
      account: { chainId, address: walletAddress },
      review: { proposedSettings: { userLabel: "Example", visibility: "visible" } },
    });
    const rawBefore = new Database(state.path, { readonly: true });
    for (const table of ["contract", "token_contract", "token_contract_inspection", "wallet_token_registration"]) {
      expect(rawBefore.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    rawBefore.close();

    const concurrent = await state.coordinator.startUnregistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      expectedRevision: Buffer.alloc(16, 9).toString("base64url"),
    }, "web");
    expect(concurrent).toMatchObject({ ok: false, error: { code: "token_operation_conflict" } });
    await expect(state.coordinator.confirm("web", {
      operationId: start.operation.operationId,
      reviewDigest: parseHash32(`0x${"00".repeat(32)}`),
    })).rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");
    await expect(state.coordinator.cancel(start.operation.operationId, "cli"))
      .rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");
    await expect(state.coordinator.confirm("cli", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    })).rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");

    const completed = await state.coordinator.confirm("web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    });
    expect(completed).toMatchObject({ state: "completed", result: { registration: { userLabel: "Example" } } });
    expect(state.database.tokenCatalogStore().listRegistrations({
      account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
    }).registrations).toHaveLength(1);
    await expect(state.coordinator.confirm("web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    })).rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");
    state.coordinator.close();
    state.database.close();
  });

  it("validates the canonical confirmation input before operation lookup or state comparison", async () => {
    const state = await createState();
    const start = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    if ("ok" in start) throw new Error("Registration start failed.");

    const validInput = {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    };
    const malformedInputs = [
      {
        name: "operation identifier",
        value: { ...validInput, operationId: "not-an-operation-id" },
      },
      {
        name: "review digest",
        value: { ...validInput, reviewDigest: "0x00" },
      },
      {
        name: "unknown field",
        value: { ...validInput, confirmation: true },
      },
    ] as const;

    for (const malformed of malformedInputs) {
      await expect(
        state.coordinator.confirm("web", malformed.value as never),
        malformed.name,
      ).rejects.toSatisfy((error: unknown) => failureCode(error) === "invalid_input");
      expect(state.coordinator.getOperation(start.operation.operationId), malformed.name).toEqual(start.operation);
    }

    expect((await state.coordinator.cancel(start.operation.operationId, "web")).state).toBe("cancelled");
    state.coordinator.close();
    state.database.close();
  });

  it("holds the single-operation reservation for the complete asynchronous inspection", async () => {
    let releaseInspection!: () => void;
    const inspectionGate = new Promise<void>((resolveGate) => { releaseInspection = resolveGate; });
    const state = await createState(createInspectionBinding(chainId, () => inspectionGate));
    const pending = state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await state.coordinator.startRegistration({
        asset: { kind: "erc20", chainId, address: tokenAddress },
        settings: { userLabel: null, visibility: "visible" },
      }, "web")).toMatchObject({ ok: false, error: { code: "token_operation_conflict" } });
    }
    releaseInspection();
    const started = await pending;
    expect("ok" in started).toBe(false);
    if (!("ok" in started)) {
      expect(started.operation.state).toBe("awaiting_confirmation");
      await state.coordinator.cancel(started.operation.operationId);
    }
    state.coordinator.close();
    state.database.close();
  });

  it("aborts an unfinished inspection when the owner closes without leaving operation state", async () => {
    let releaseInspection!: () => void;
    const inspectionGate = new Promise<void>((resolveGate) => { releaseInspection = resolveGate; });
    const state = await createState(createInspectionBinding(chainId, () => inspectionGate));
    const pending = state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    state.coordinator.close();
    releaseInspection();
    expect(await pending).toMatchObject({ ok: false, error: { code: "request_aborted" } });
    expect(state.database.tokenCatalogStore().listRegistrations({
      account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
    }).registrations).toEqual([]);
    state.database.close();
  });

  it("fails closed when the live session changes or the wallet deletes it before confirmation", async () => {
    for (const invalidate of [
      (state: Awaited<ReturnType<typeof createState>>) => { state.replaceSessionSource(); },
      (state: Awaited<ReturnType<typeof createState>>) => { state.disconnectLive(); },
    ]) {
      const state = await createState();
      const start = await state.coordinator.startRegistration({
        asset: { kind: "erc20", chainId, address: tokenAddress },
        settings: { userLabel: null, visibility: "visible" },
      }, "cli");
      if ("ok" in start) throw new Error("Registration start failed.");
      invalidate(state);
      await expect(state.coordinator.confirm("cli", {
        operationId: start.operation.operationId,
        reviewDigest: start.operation.review.reviewDigest,
      })).rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");
      expect(state.database.tokenCatalogStore().listRegistrations({
        account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
      }).registrations).toEqual([]);
      expect(state.coordinator.getOperation(start.operation.operationId).state).toBe("awaiting_confirmation");
      state.coordinator.close();
      state.database.close();
    }
  });

  it("applies update and removal through new revisions without changing the captured inspection", async () => {
    const state = await createState();
    const registrationStart = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: "Initial", visibility: "visible" },
    }, "cli");
    if ("ok" in registrationStart) throw new Error("Registration start failed.");
    const registered = await state.coordinator.confirm("cli", {
      operationId: registrationStart.operation.operationId,
      reviewDigest: registrationStart.operation.review.reviewDigest,
    });
    if (registered.kind !== "register" || registered.state !== "completed") {
      throw new Error("Registration did not complete.");
    }
    const registeredResult = tokenRegistrationWithInspectionSchema.parse(registered.result);

    const updateStart = await state.coordinator.startRegistrationUpdate({
      asset: registeredResult.registration.asset,
      expectedRevision: registeredResult.registration.revision,
      changes: { userLabel: null, visibility: "hidden" },
    }, "web");
    if ("ok" in updateStart) throw new Error("Registration update start failed.");
    expect(updateStart.operation.review.inspection).toEqual(registeredResult.inspection);
    const updated = await state.coordinator.confirm("web", {
      operationId: updateStart.operation.operationId,
      reviewDigest: updateStart.operation.review.reviewDigest,
    });
    if (updated.kind !== "update_registration" || updated.state !== "completed") {
      throw new Error("Registration update did not complete.");
    }
    const updatedResult = tokenRegistrationWithInspectionSchema.parse(updated.result);
    expect(updatedResult.registration).toMatchObject({ userLabel: null, visibility: "hidden" });
    expect(updatedResult.registration.revision).not.toBe(registeredResult.registration.revision);
    expect(updatedResult.inspection).toEqual(registeredResult.inspection);

    const removalStart = await state.coordinator.startUnregistration({
      asset: updatedResult.registration.asset,
      expectedRevision: updatedResult.registration.revision,
    }, "web");
    if ("ok" in removalStart) throw new Error("Registration removal start failed.");
    const removed = await state.coordinator.confirm("web", {
      operationId: removalStart.operation.operationId,
      reviewDigest: removalStart.operation.review.reviewDigest,
    });
    expect(removed).toMatchObject({
      kind: "unregister",
      state: "completed",
      result: { removedRevision: updatedResult.registration.revision },
    });
    expect(state.database.tokenCatalogStore().listRegistrations({
      account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
    }).registrations).toEqual([]);
    state.coordinator.close();
    state.database.close();
  });

  it("records one failed operation and rolls back storage when applying fails", async () => {
    const state = await createState();
    const start = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    if ("ok" in start) throw new Error("Registration start failed.");
    const raw = new Database(state.path);
    raw.exec(`CREATE TRIGGER reject_token_registration
      BEFORE INSERT ON wallet_token_registration
      BEGIN SELECT RAISE(ABORT, 'injected registration failure'); END`);
    const failed = await state.coordinator.confirm("web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    });
    expect(failed).toMatchObject({
      state: "failed",
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect((await state.coordinator.cancel(start.operation.operationId)).state).toBe("failed");
    for (const table of ["contract", "token_contract", "token_contract_inspection", "wallet_token_registration"]) {
      expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    raw.close();
    state.coordinator.close();
    state.database.close();
  });

  it("normalizes inherited runtime failures without losing their declared meaning", async () => {
    const state = await createState(
      createInspectionBinding(),
      undefined,
      () => new RuntimeOperationError("runtime_state_unavailable"),
    );
    const result = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    state.coordinator.close();
    state.database.close();
  });

  it("normalizes a runtime failure during confirmation and leaves the operation cancellable", async () => {
    let projectionUnavailable = false;
    const state = await createState(
      createInspectionBinding(),
      undefined,
      () => projectionUnavailable ? new RuntimeOperationError("runtime_state_unavailable") : undefined,
    );
    const start = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    if ("ok" in start) throw new Error("Registration start failed.");

    projectionUnavailable = true;
    await expect(state.coordinator.confirm("web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    })).rejects.toSatisfy((error: unknown) => failureCode(error) === "runtime_state_unavailable");
    expect(state.coordinator.getOperation(start.operation.operationId).state).toBe("awaiting_confirmation");
    expect((await state.coordinator.cancel(start.operation.operationId, "web")).state).toBe("cancelled");

    state.coordinator.close();
    state.database.close();
  });

  it("closes an applying operation when a dependency reports an undeclared failure", async () => {
    const state = await createState(createInspectionBinding(), () => {
      throw new TokenCatalogOperationError("token_registration_not_found");
    });
    const start = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    if ("ok" in start) throw new Error("Registration start failed.");

    const failed = await state.coordinator.confirm("web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    });
    expect(failed).toMatchObject({
      state: "failed",
      failure: { error: { code: "internal_error" } },
    });
    expect(state.coordinator.getOperation(start.operation.operationId)).toEqual(failed);

    const successor = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    expect("ok" in successor).toBe(false);
    if (!("ok" in successor)) await state.coordinator.cancel(successor.operation.operationId);

    state.coordinator.close();
    state.database.close();
  });

  it("retains the single-operation slot through a reentrant applying transaction", async () => {
    let reentrantStart: Promise<unknown> | undefined;
    let state!: Awaited<ReturnType<typeof createState>>;
    state = await createState(createInspectionBinding(), () => {
      reentrantStart = state.coordinator.startRegistration({
        asset: { kind: "erc20", chainId, address: tokenAddress },
        settings: { userLabel: null, visibility: "visible" },
      }, "web");
    });
    const start = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    if ("ok" in start) throw new Error("Registration start failed.");

    const completed = await state.coordinator.confirm("web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    });
    expect(completed.state).toBe("completed");
    expect(await reentrantStart).toMatchObject({
      ok: false,
      error: { code: "token_operation_conflict" },
    });

    state.coordinator.close();
    state.database.close();
  });

  it("rejects confirmation after reconnect and does not restore operations in a successor owner", async () => {
    const state = await createState();
    const start = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    if ("ok" in start) throw new Error("Registration start failed.");
    state.reconnectProjection();
    await expect(state.coordinator.confirm("web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    })).rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");
    state.coordinator.close();

    const successor = state.createCoordinator(new AbortController().signal);
    expect(successor.getCurrentOperation()).toBeNull();
    let missingOperation: unknown;
    try { successor.getOperation(start.operation.operationId); }
    catch (error) { missingOperation = error; }
    expect(failureCode(missingOperation)).toBe("token_operation_not_found");
    expect(state.database.tokenCatalogStore().listRegistrations({
      account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
    }).registrations).toEqual([]);
    successor.close();
    state.database.close();
  });

  it("expires, cancels, retains, and removes operations without persistent partial state", async () => {
    const state = await createState();
    const cancelledStart = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    if ("ok" in cancelledStart) throw new Error("Registration start failed.");
    expect((await state.coordinator.cancel(cancelledStart.operation.operationId, "web")).state).toBe("cancelled");
    expect((await state.coordinator.cancel(cancelledStart.operation.operationId)).state).toBe("cancelled");

    const expiringStart = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "hidden" },
    }, "web");
    if ("ok" in expiringStart) throw new Error("Registration start failed.");
    expect(state.coordinator.getOperation(cancelledStart.operation.operationId).state).toBe("cancelled");
    expect(state.coordinator.getCurrentOperation()?.operationId).toBe(expiringStart.operation.operationId);
    currentTime = "2026-07-18T00:05:04.000Z";
    expect(state.coordinator.getOperation(expiringStart.operation.operationId).state).toBe("expired");
    currentTime = "2026-07-18T00:10:05.000Z";
    expect(() => state.coordinator.getOperation(expiringStart.operation.operationId)).toThrow();
    expect(state.database.tokenCatalogStore().listRegistrations({
      account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
    }).registrations).toEqual([]);
    state.coordinator.close();
    state.database.close();
  });

  it("does not extend expired-operation retention when expiry is first observed late", async () => {
    const state = await createState();
    const start = await state.coordinator.startRegistration({
      asset: { kind: "erc20", chainId, address: tokenAddress },
      settings: { userLabel: null, visibility: "visible" },
    }, "web");
    if ("ok" in start) throw new Error("Registration start failed.");
    currentTime = "2026-07-18T00:10:04.000Z";
    let missingOperation: unknown;
    try { state.coordinator.getOperation(start.operation.operationId); }
    catch (error) { missingOperation = error; }
    expect(failureCode(missingOperation)).toBe("token_operation_not_found");
    expect(state.coordinator.getCurrentOperation()).toBeNull();
    state.coordinator.close();
    state.database.close();
  });
});
