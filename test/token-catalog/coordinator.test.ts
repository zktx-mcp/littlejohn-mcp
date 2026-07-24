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
import {
  createOfficialAssetSourceClient,
  officialAssetSnapshotRevisionSchema,
  type CommittedOfficialAssetSnapshot,
} from "../../src/registry/index.js";
import type { WalletSessionSource } from "../../src/runtime/source-identity.js";
import {
  TokenCatalogCoordinator,
} from "../../src/token-catalog/coordinator.js";
import { createTokenCatalogFailure } from "../../src/token-catalog/errors.js";
import {
  getTokenCatalogOperationFailure,
  TokenCatalogOperationError,
} from "../../src/token-catalog/operation-error.js";
import {
  tokenCatalogContractLimits,
  tokenSelectionDetailSchema,
} from "../../src/token-catalog/contracts.js";
import type { TokenAdditionChainReadPort } from "../../src/token-catalog/ports.js";
import { createInspectionSuccess, chainId, tokenAddress, walletAddress } from "./harness.js";

const directories: string[] = [];
let currentTime = "2026-07-18T00:00:03.000Z";
let operationIdSequence = 0;

const nextOperationId = () => {
  operationIdSequence += 1;
  return Buffer.alloc(32, operationIdSequence).toString("base64url");
};

const startAddition = (
  coordinator: TokenCatalogCoordinator,
  input: Parameters<TokenCatalogCoordinator["startAddition"]>[0],
  interactionInterface: "cli" | "web",
  operationId = nextOperationId(),
) => coordinator.startAddition(input, { operationId, interactionInterface });

const startRemoval = (
  coordinator: TokenCatalogCoordinator,
  input: Parameters<TokenCatalogCoordinator["startRemoval"]>[0],
  interactionInterface: "cli" | "web",
  operationId = nextOperationId(),
) => coordinator.startRemoval(input, { operationId, interactionInterface });

const confirmOperation = (
  coordinator: TokenCatalogCoordinator,
  interactionInterface: "cli" | "web",
  input: Parameters<TokenCatalogCoordinator["confirm"]>[1],
) => coordinator.confirm({ operationId: input.operationId, interactionInterface }, input);

afterEach(async () => {
  currentTime = "2026-07-18T00:00:03.000Z";
  operationIdSequence = 0;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const createSessionSource = (
  clock: ReturnType<typeof createCanonicalClock>,
  topicDigest = "A".repeat(43),
): WalletSessionSource => {
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

const createAdditionChainReads = (
  beforeResult?: () => Promise<void>,
): TokenAdditionChainReadPort => Object.freeze({
  async inspectAndVerifyOfficial(
    { asset }: Parameters<TokenAdditionChainReadPort["inspectAndVerifyOfficial"]>[0],
    signal: Parameters<TokenAdditionChainReadPort["inspectAndVerifyOfficial"]>[1],
  ) {
    if (signal.aborted) return createTokenCatalogFailure("request_aborted");
    await beforeResult?.();
    if (signal.aborted) return createTokenCatalogFailure("request_aborted");
    return Object.freeze({
      inspection: await createInspectionSuccess({ asset, block: { kind: "latest" } }),
      officialVerification: null,
    });
  },
});

const createState = async (
  additionChainReads = createAdditionChainReads(),
  onRegister?: () => void,
  captureError?: () => Error | undefined,
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
  let liveConnectionRevision = connection.revision;
  const controller = new AbortController();
  const catalogStore = database.tokenCatalogStore();
  const observation = await createOfficialAssetSourceClient({
    fetch: (async () => new Response(JSON.stringify({
      assets: [{
        id: `0x${"11".repeat(32)}`,
        status: "ASSET_STATUS_ACTIVE",
        deployments: [{ chainId: 4663, contractAddress: `0x${"56".repeat(20)}` }],
        tokenName: "Unrelated Stock Token",
        tokenSymbol: "OTHER",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    now: () => new Date(currentTime),
  }).read(controller.signal);
  const officialSnapshot = database.officialAssetSnapshotStore().replaceSnapshot(observation, null);
  const operationStore = onRegister === undefined
    ? catalogStore
    : Object.freeze({
        ...catalogStore,
        applyConfirmation: (input: Parameters<typeof catalogStore.applyConfirmation>[0]) => {
          if (input.kind === "add") onRegister();
          return catalogStore.applyConfirmation(input);
        },
      });
  const createCoordinator = (signal: AbortSignal = controller.signal) => new TokenCatalogCoordinator({
      activeWallet: {
        capture: () => {
          const error = captureError?.();
          if (error !== undefined) throw error;
          return Object.freeze({
            connection: liveConnection,
            connectionRevision: liveConnectionRevision,
            sessionSource,
          });
        },
      },
      additionChainReads,
      officialAssets: Object.freeze({
        synchronize: async () => Object.freeze({ status: "current" as const, snapshot: officialSnapshot }),
        readStored: () => officialSnapshot,
        close: async () => undefined,
      }),
      store: operationStore,
      clock,
      signal,
    });
  const coordinator = createCoordinator();
  return {
    path,
    database,
    coordinator,
    controller,
    createCoordinator,
    republishSessionSource: () => { sessionSource = createSessionSource(clock); },
    replaceSessionAuthority: () => {
      const sourceId = `wallet-sdk:${Buffer.alloc(16, 7).toString("base64url")}`;
      sessionSource = Object.freeze({
        ...sessionSource,
        observationAuthority: createObservationAuthority({
          clock,
          sourceClass: "wallet_sdk",
          owner: "WalletConnect SDK",
          reference: sourceReferenceSchema.parse({ kind: "wallet_sdk", sourceId }),
        }),
      });
    },
    replaceSessionSource: () => {
      sessionSource = createSessionSource(clock, `${"C".repeat(42)}A`);
    },
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
      liveConnectionRevision = reconnected.revision;
    },
  };
};

const failureCode = (error: unknown) => getTokenCatalogOperationFailure(error)?.error.code;

describe("token catalog operation coordinator", () => {
  it("keeps selection mutation absent until exact-interface confirmation", async () => {
    const state = await createState();
    const start = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    expect("ok" in start).toBe(false);
    if ("ok" in start) throw new Error("Selection start failed.");
    expect(start.operation).toMatchObject({
      kind: "add",
      state: "awaiting_confirmation",
      interactionInterface: "web",
      account: { chainId, address: walletAddress },
    });
    const rawBefore = new Database(state.path, { readonly: true });
    for (const table of ["contract", "token_contract", "token_contract_inspection", "wallet_token_selection"]) {
      expect(rawBefore.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    rawBefore.close();

    const concurrent = await startRemoval(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
      expectedRevision: Buffer.alloc(16, 9).toString("base64url"),
    }, "web");
    expect(concurrent).toMatchObject({ ok: false, error: { code: "token_operation_conflict" } });
    await expect(confirmOperation(state.coordinator, "web", {
      operationId: start.operation.operationId,
      reviewDigest: parseHash32(`0x${"00".repeat(32)}`),
    })).rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");
    await expect(state.coordinator.cancel(start.operation.operationId, "cli"))
      .rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");
    await expect(confirmOperation(state.coordinator, "cli", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    })).rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");

    const completed = await confirmOperation(state.coordinator, "web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    });
    expect(completed).toMatchObject({ state: "completed", result: { selection: {
      account: { chainId, address: walletAddress },
      asset: { kind: "erc20", chainId, address: tokenAddress },
    } } });
    expect(state.database.tokenCatalogStore().listSelections({
      account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
    }).selections).toHaveLength(1);
    await expect(confirmOperation(state.coordinator, "web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    })).rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");
    state.coordinator.close();
    state.database.close();
  });

  it("validates the canonical confirmation input before operation lookup or state comparison", async () => {
    const state = await createState();
    const start = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    if ("ok" in start) throw new Error("Selection start failed.");

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
        confirmOperation(state.coordinator, "web", malformed.value as never),
        malformed.name,
      ).rejects.toSatisfy((error: unknown) => failureCode(error) === "invalid_input");
      expect(state.coordinator.getOperation(start.operation.operationId), malformed.name).toEqual(start.operation);
    }

    expect((await state.coordinator.cancel(start.operation.operationId, "web")).state).toBe("cancelled");
    state.coordinator.close();
    state.database.close();
  });

  it("holds the single-operation reservation for the complete asynchronous token-addition chain read", async () => {
    let markAdditionReadEntered!: () => void;
    let releaseAdditionRead!: () => void;
    const additionReadEntered = new Promise<void>((resolveEntered) => { markAdditionReadEntered = resolveEntered; });
    const additionReadGate = new Promise<void>((resolveGate) => { releaseAdditionRead = resolveGate; });
    const state = await createState(createAdditionChainReads(async () => {
      markAdditionReadEntered();
      await additionReadGate;
    }));
    const pending = startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    await additionReadEntered;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await startAddition(state.coordinator, {
        asset: { kind: "erc20", chainId, address: tokenAddress },
      }, "web")).toMatchObject({ ok: false, error: { code: "token_operation_conflict" } });
    }
    releaseAdditionRead();
    const started = await pending;
    expect("ok" in started).toBe(false);
    if (!("ok" in started)) {
      expect(started.operation.state).toBe("awaiting_confirmation");
      await state.coordinator.cancel(started.operation.operationId);
    }
    state.coordinator.close();
    state.database.close();
  });

  it("aborts an unfinished token-addition chain read when the owner closes without leaving operation state", async () => {
    let markAdditionReadEntered!: () => void;
    let releaseAdditionRead!: () => void;
    const additionReadEntered = new Promise<void>((resolveEntered) => { markAdditionReadEntered = resolveEntered; });
    const additionReadGate = new Promise<void>((resolveGate) => { releaseAdditionRead = resolveGate; });
    const state = await createState(createAdditionChainReads(async () => {
      markAdditionReadEntered();
      await additionReadGate;
    }));
    const pending = startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    await additionReadEntered;
    const close = state.coordinator.close();
    expect(state.coordinator.close()).toBe(close);
    await expect(startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web")).rejects.toSatisfy((error: unknown) =>
      failureCode(error) === "runtime_state_unavailable");
    let closeSettled = false;
    void close.then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseAdditionRead();
    expect(await pending).toMatchObject({ ok: false, error: { code: "request_aborted" } });
    await close;
    expect(closeSettled).toBe(true);
    expect(() => state.coordinator.getCurrentOperation()).toThrow();
    expect(state.database.tokenCatalogStore().listSelections({
      account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
    }).selections).toEqual([]);
    state.database.close();
  });

  it("preserves continuity when the same live session is republished as a new object", async () => {
    const state = await createState();
    const start = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "cli");
    if ("ok" in start) throw new Error("Selection start failed.");
    state.republishSessionSource();
    const completed = await confirmOperation(state.coordinator, "cli", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    });
    expect(completed.state).toBe("completed");
    state.coordinator.close();
    state.database.close();
  });

  it("fails closed when the live session identity changes or the wallet deletes it before confirmation", async () => {
    for (const invalidate of [
      (state: Awaited<ReturnType<typeof createState>>) => { state.replaceSessionSource(); },
      (state: Awaited<ReturnType<typeof createState>>) => { state.replaceSessionAuthority(); },
      (state: Awaited<ReturnType<typeof createState>>) => { state.disconnectLive(); },
    ]) {
      const state = await createState();
      const start = await startAddition(state.coordinator, {
        asset: { kind: "erc20", chainId, address: tokenAddress },
      }, "cli");
      if ("ok" in start) throw new Error("Selection start failed.");
      invalidate(state);
      await expect(confirmOperation(state.coordinator, "cli", {
        operationId: start.operation.operationId,
        reviewDigest: start.operation.review.reviewDigest,
      })).rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");
      expect(state.database.tokenCatalogStore().listSelections({
        account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
      }).selections).toEqual([]);
      expect(state.coordinator.getOperation(start.operation.operationId).state).toBe("awaiting_confirmation");
      state.coordinator.close();
      state.database.close();
    }
  });

  it("removes the exact selection revision without deleting contract identity", async () => {
    const state = await createState();
    const additionStart = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "cli");
    if ("ok" in additionStart) throw new Error("Selection start failed.");
    const registered = await confirmOperation(state.coordinator, "cli", {
      operationId: additionStart.operation.operationId,
      reviewDigest: additionStart.operation.review.reviewDigest,
    });
    if (registered.kind !== "add" || registered.state !== "completed") {
      throw new Error("Selection did not complete.");
    }
    const registeredResult = tokenSelectionDetailSchema.parse(registered.result);

    const removalStart = await startRemoval(state.coordinator, {
      asset: registeredResult.selection.asset,
      expectedRevision: registeredResult.selection.revision,
    }, "web");
    if ("ok" in removalStart) throw new Error("Selection removal start failed.");
    const removed = await confirmOperation(state.coordinator, "web", {
      operationId: removalStart.operation.operationId,
      reviewDigest: removalStart.operation.review.reviewDigest,
    });
    expect(removed).toMatchObject({
      kind: "remove",
      state: "completed",
      result: { selection: { included: false } },
    });
    const removedSelection = tokenSelectionDetailSchema.parse(removed.result).selection;
    const readditionStart = await startAddition(state.coordinator, {
      asset: registeredResult.selection.asset,
    }, "web");
    if ("ok" in readditionStart) throw new Error("Selection re-addition start failed.");
    expect(readditionStart.operation.review.previousSelection).toMatchObject({
      included: false,
      revision: removedSelection.revision,
    });
    const readded = await confirmOperation(state.coordinator, "web", {
      operationId: readditionStart.operation.operationId,
      reviewDigest: readditionStart.operation.review.reviewDigest,
    });
    expect(readded).toMatchObject({
      kind: "add",
      state: "completed",
      failure: null,
      result: { selection: { included: true } },
    });
    const selections = state.database.tokenCatalogStore().listSelections({
      account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
    }).selections;
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({ included: true });
    expect(selections[0]?.revision).not.toBe(registeredResult.selection.revision);
    const raw = new Database(state.path, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM token_contract").get()).toEqual({ count: 1 });
    raw.close();
    state.coordinator.close();
    state.database.close();
  });

  it("records one failed operation and rolls back storage when applying fails", async () => {
    const state = await createState();
    const start = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    if ("ok" in start) throw new Error("Selection start failed.");
    const raw = new Database(state.path);
    raw.exec(`CREATE TRIGGER reject_token_selection
      BEFORE INSERT ON wallet_token_selection
      BEGIN SELECT RAISE(ABORT, 'injected selection failure'); END`);
    const failed = await confirmOperation(state.coordinator, "web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    });
    expect(failed).toMatchObject({
      state: "failed",
      failure: { error: { code: "runtime_state_unavailable" } },
    });
    expect((await state.coordinator.cancel(start.operation.operationId)).state).toBe("failed");
    for (const table of ["contract", "token_contract", "token_contract_inspection", "wallet_token_selection"]) {
      expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
    raw.close();
    state.coordinator.close();
    state.database.close();
  });

  it("normalizes inherited runtime failures without losing their declared meaning", async () => {
    const state = await createState(
      createAdditionChainReads(),
      undefined,
      () => new RuntimeOperationError("runtime_state_unavailable"),
    );
    const result = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
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
      createAdditionChainReads(),
      undefined,
      () => projectionUnavailable ? new RuntimeOperationError("runtime_state_unavailable") : undefined,
    );
    const start = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    if ("ok" in start) throw new Error("Selection start failed.");

    projectionUnavailable = true;
    await expect(confirmOperation(state.coordinator, "web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    })).rejects.toSatisfy((error: unknown) => failureCode(error) === "runtime_state_unavailable");
    expect(state.coordinator.getOperation(start.operation.operationId).state).toBe("awaiting_confirmation");
    expect((await state.coordinator.cancel(start.operation.operationId, "web")).state).toBe("cancelled");

    state.coordinator.close();
    state.database.close();
  });

  it("closes an applying operation when a dependency reports an undeclared failure", async () => {
    const state = await createState(createAdditionChainReads(), () => {
      throw new Error("The dependency returned an undeclared failure.");
    });
    const start = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    if ("ok" in start) throw new Error("Selection start failed.");

    const failed = await confirmOperation(state.coordinator, "web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    });
    expect(failed).toMatchObject({
      state: "failed",
      failure: { error: { code: "internal_error" } },
    });
    expect(state.coordinator.getOperation(start.operation.operationId)).toEqual(failed);

    const successor = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    expect("ok" in successor).toBe(false);
    if (!("ok" in successor)) await state.coordinator.cancel(successor.operation.operationId);

    state.coordinator.close();
    state.database.close();
  });

  it("retains the single-operation slot through a reentrant applying transaction", async () => {
    let reentrantStart: Promise<unknown> | undefined;
    let state!: Awaited<ReturnType<typeof createState>>;
    state = await createState(createAdditionChainReads(), () => {
      reentrantStart = startAddition(state.coordinator, {
        asset: { kind: "erc20", chainId, address: tokenAddress },
      }, "web");
    });
    const start = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    if ("ok" in start) throw new Error("Selection start failed.");

    const completed = await confirmOperation(state.coordinator, "web", {
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

  it("waits for an admitted confirmation transaction before close releases operation state", async () => {
    let close: Promise<void> | undefined;
    let state!: Awaited<ReturnType<typeof createState>>;
    state = await createState(createAdditionChainReads(), () => {
      close = state.coordinator.close();
    });
    const start = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    if ("ok" in start) throw new Error("Selection start failed.");

    const completed = await confirmOperation(state.coordinator, "web", {
      operationId: start.operation.operationId,
      reviewDigest: start.operation.review.reviewDigest,
    });
    expect(completed.state).toBe("completed");
    await close;
    expect(state.database.tokenCatalogStore().getSelection(
      { chainId, address: walletAddress },
      { kind: "erc20", chainId, address: tokenAddress },
    )).toEqual(completed.result);
    expect(() => state.coordinator.getCurrentOperation()).toThrow();
    state.database.close();
  });

  it("rejects confirmation after reconnect and does not restore operations in a successor owner", async () => {
    const state = await createState();
    const start = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    if ("ok" in start) throw new Error("Selection start failed.");
    state.reconnectProjection();
    await expect(confirmOperation(state.coordinator, "web", {
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
    expect(state.database.tokenCatalogStore().listSelections({
      account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
    }).selections).toEqual([]);
    successor.close();
    state.database.close();
  });

  it("expires, cancels, retains, and removes operations without persistent partial state", async () => {
    const state = await createState();
    const cancelledStart = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    if ("ok" in cancelledStart) throw new Error("Selection start failed.");
    expect((await state.coordinator.cancel(cancelledStart.operation.operationId, "web")).state).toBe("cancelled");
    expect((await state.coordinator.cancel(cancelledStart.operation.operationId)).state).toBe("cancelled");

    const expiringStart = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    if ("ok" in expiringStart) throw new Error("Selection start failed.");
    expect(state.coordinator.getOperation(cancelledStart.operation.operationId).state).toBe("cancelled");
    expect(state.coordinator.getCurrentOperation()?.operationId).toBe(expiringStart.operation.operationId);
    currentTime = "2026-07-18T00:05:04.000Z";
    expect(state.coordinator.getOperation(expiringStart.operation.operationId).state).toBe("expired");
    currentTime = "2026-07-18T00:10:05.000Z";
    expect(() => state.coordinator.getOperation(expiringStart.operation.operationId)).toThrow();
    expect(state.database.tokenCatalogStore().listSelections({
      account: { chainId, address: walletAddress }, limit: tokenCatalogContractLimits.listMaximumLimit, cursor: null,
    }).selections).toEqual([]);
    state.coordinator.close();
    state.database.close();
  });

  it("does not extend expired-operation retention when expiry is first observed late", async () => {
    const state = await createState();
    const start = await startAddition(state.coordinator, {
      asset: { kind: "erc20", chainId, address: tokenAddress },
    }, "web");
    if ("ok" in start) throw new Error("Selection start failed.");
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
