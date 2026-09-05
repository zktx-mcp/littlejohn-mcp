import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCanonicalClock,
  createObservationAuthority,
  parseCapabilityDataAt,
  parseUtcTimestamp,
  sourceReferenceSchema,
  walletConnectionCapability,
} from "../../src/core/index.js";
import { createRobinhoodOfficialAssetSourceClient } from "../../src/registry/official-assets.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { createAddressTargetResolver } from "../../src/chain/address-target.js";
import { ensureOwnerOnlyDirectory, runtimePaths } from "../../src/runtime/paths.js";
import type { WalletSessionSource } from "../../src/runtime/source-identity.js";
import type { TokenInspectionSuccess } from "../../src/token-catalog/contracts.js";
import { TokenCatalogCoordinator } from "../../src/token-catalog/coordinator.js";
import { getTokenCatalogOperationFailure } from "../../src/token-catalog/operation-error.js";
import type { TokenAdditionChainReadPort } from "../../src/token-catalog/ports.js";
import { createInspectionSuccess, chainId, tokenAddress, walletAddress } from "./harness.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const createSessionSource = (
  clock: ReturnType<typeof createCanonicalClock>,
  byte = 0,
): WalletSessionSource => {
  const topicDigest = Buffer.alloc(32, byte).toString("base64url");
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
  chainReads?: TokenAdditionChainReadPort,
  disconnected = false,
  afterChainRead?: () => void,
) => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-token-operation-"));
  directories.push(directory);
  await ensureOwnerOnlyDirectory(directory);
  const path = runtimePaths(directory).database;
  let currentTime = "2026-07-18T00:00:03.000Z";
  const clock = createCanonicalClock(() => currentTime);
  let database = await ProductDatabase.open(path, parseUtcTimestamp(currentTime));
  database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
  const connected = disconnected
    ? database.walletStore().read()
    : database.walletStore().replace(
        "0",
        parseCapabilityDataAt(walletConnectionCapability, {
          status: "connected",
          chainId,
          address: walletAddress,
          approvedMethods: ["eth_sendTransaction"],
          approvedEvents: ["accountsChanged", "chainChanged"],
          expiresAt: "2026-07-19T00:00:00.000Z",
        }, parseUtcTimestamp(currentTime)),
        false,
        parseUtcTimestamp(currentTime),
      );
  const controller = new AbortController();
  const sourceResult = await createRobinhoodOfficialAssetSourceClient({
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
  if (sourceResult.status !== "observed") throw new Error("Expected official source observation.");
  const officialSnapshot = database.officialAssetSnapshotStore().replaceSnapshot(
    sourceResult.observation,
    null,
  );
  const chainInputs: Array<Parameters<TokenAdditionChainReadPort["inspectAndVerifyOfficial"]>[0]> = [];
  const inspections: TokenInspectionSuccess[] = [];
  const additionChainReads: TokenAdditionChainReadPort = chainReads ?? Object.freeze({
    async inspectAndVerifyOfficial(
      input: Parameters<TokenAdditionChainReadPort["inspectAndVerifyOfficial"]>[0],
    ) {
      chainInputs.push(input);
      const inspection = await createInspectionSuccess({
        asset: input.asset,
        block: input.block === null
          ? { kind: "latest" }
          : { kind: "number", blockNumber: input.block.blockNumber },
      });
      inspections.push(inspection);
      const result = Object.freeze({
        inspection,
        officialVerification: null,
      });
      afterChainRead?.();
      return result;
    },
  });
  let sessionSource = createSessionSource(clock);
  let walletCaptures = 0;
  const activeWallet = Object.freeze({
    capture: () => {
      walletCaptures += 1;
      return Object.freeze({
        connection: connected.connection,
        connectionRevision: connected.revision,
        ...(connected.connection.status === "connected" ? { sessionSource } : {}),
      });
    },
  });
  const createCoordinator = () => new TokenCatalogCoordinator({
    addressTargets: createAddressTargetResolver({ chainId, activeWallet }),
    additionChainReads,
    officialAssets: Object.freeze({ readStored: () => officialSnapshot }),
    store: database.tokenCatalogStore(),
    clock,
    signal: controller.signal,
  });
  return {
    path,
    get database() { return database; },
    coordinator: createCoordinator(),
    createCoordinator,
    chainInputs,
    inspections,
    get walletCaptures() { return walletCaptures; },
    setSessionSource(byte: number) { sessionSource = createSessionSource(clock, byte); },
    setNow(value: string) { currentTime = value; },
    async reopen() {
      database.close();
      database = await ProductDatabase.open(path, parseUtcTimestamp(currentTime));
    },
  };
};

const failureCode = (error: unknown) => getTokenCatalogOperationFailure(error)?.error.code;
const asset = Object.freeze({ kind: "erc20" as const, chainId, address: tokenAddress });
const account = Object.freeze({ chainId, address: walletAddress });
const activeTarget = Object.freeze({ kind: "active_wallet" as const });

describe("token selection durable operations", () => {
  it("keeps an explicit disconnected Review pure and retains its account only on confirmed addition", async () => {
    const state = await createState(undefined, true);
    const explicitTarget = Object.freeze({ kind: "address" as const, address: walletAddress });
    expect(state.database.accountTokenSelectionStore().isAccountRetained(account)).toBe(false);

    const review = (await state.coordinator.review({
      kind: "add",
      account: explicitTarget,
      asset,
    })).review;
    expect(review.target.account).toEqual(account);
    expect(review.precondition.accountTarget).toEqual({ kind: "address" });
    expect(state.walletCaptures).toBe(0);
    expect(state.database.accountTokenSelectionStore().isAccountRetained(account)).toBe(false);

    const operation = await state.coordinator.decide({ review, initiatedBy: "cli" });
    expect(operation.result.outcome).toBe("selection_added");
    expect(state.walletCaptures).toBe(0);
    expect(state.database.accountTokenSelectionStore().isAccountRetained(account)).toBe(true);
    expect(state.database.tokenCatalogStore().getSelection(account, asset)?.selection.included)
      .toBe(true);
    await state.coordinator.close();
    state.database.close();
  });

  it("keeps Review creation pure, commits mutation and terminal result together, and reopens the exact result", async () => {
    const state = await createState();
    const review = (await state.coordinator.review({ kind: "add", account: activeTarget, asset })).review;
    expect(Date.parse(review.actionExpiresAt) - Date.parse(review.createdAt)).toBe(300_000);

    const before = new Database(state.path, { readonly: true });
    for (const table of [
      "contract",
      "token_contract",
      "token_contract_inspection",
      "account_token_selection_state",
      "account_token_selection",
      "token_selection_operation",
    ]) expect(before.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table)
      .toEqual({ count: 0 });
    before.close();
    expect(state.chainInputs).toHaveLength(1);
    expect(state.chainInputs[0]?.block).toBeNull();

    const operation = await state.coordinator.decide({ review, initiatedBy: "mcp_app" });
    expect(operation).toMatchObject({
      operationId: review.operationId,
      review,
      state: "completed",
      result: { outcome: "selection_added" },
    });
    expect(state.chainInputs).toHaveLength(2);
    expect(state.chainInputs[1]?.block).toEqual(review.fixedEvidence.inspectionBlock);
    expect(state.inspections[0]?.data.metadata.name.observationId)
      .not.toBe(state.inspections[1]?.data.metadata.name.observationId);
    if (review.kind !== "add") throw new Error("Expected one token addition Review.");
    expect(Object.keys(review.decision.name)).not.toContain("observationId");
    expect(state.coordinator.getOperation(review.operationId)).toEqual(operation);

    const after = new Database(state.path, { readonly: true });
    expect(after.prepare("SELECT COUNT(*) AS count FROM account_token_selection").get())
      .toEqual({ count: 1 });
    expect(after.prepare("SELECT COUNT(*) AS count FROM token_selection_operation").get())
      .toEqual({ count: 1 });
    after.close();

    expect(await state.coordinator.decide({ review, initiatedBy: "mcp_app" })).toEqual(operation);
    await state.coordinator.close();
    await state.reopen();
    const successor = state.createCoordinator();
    expect(successor.getOperation(review.operationId)).toEqual(operation);
    expect(state.database.tokenCatalogStore().getSelection(
      { chainId, address: walletAddress },
      asset,
    )?.selection.included).toBe(true);
    await successor.close();
    state.database.close();
  });

  it("rejects stale and expired actions without creating an operation", async () => {
    const stale = await createState();
    const first = (await stale.coordinator.review({ kind: "add", account: activeTarget, asset })).review;
    const second = (await stale.coordinator.review({ kind: "add", account: activeTarget, asset })).review;
    await stale.coordinator.decide({ review: first, initiatedBy: "cli" });
    await expect(stale.coordinator.decide({ review: second, initiatedBy: "mcp_app" }))
      .rejects.toSatisfy((error: unknown) => failureCode(error) === "token_selection_revision_changed");
    expect(stale.database.tokenCatalogStore().readOperation(second.operationId)).toBeNull();
    await stale.coordinator.close();
    stale.database.close();

    const expired = await createState();
    const review = (await expired.coordinator.review({ kind: "add", account: activeTarget, asset })).review;
    expired.setNow(review.actionExpiresAt);
    await expect(expired.coordinator.decide({ review, initiatedBy: "cli" }))
      .rejects.toSatisfy((error: unknown) => failureCode(error) === "token_review_expired");
    expect(expired.database.tokenCatalogStore().readOperation(review.operationId)).toBeNull();
    expect(expired.database.tokenCatalogStore().getSelection(
      { chainId, address: walletAddress },
      asset,
    )).toBeUndefined();
    await expired.coordinator.close();
    expired.database.close();
  });

  it("rejects active session-source drift during decision Chain work", async () => {
    let state!: Awaited<ReturnType<typeof createState>>;
    let chainCalls = 0;
    state = await createState(undefined, false, () => {
      chainCalls += 1;
      if (chainCalls === 2) state.setSessionSource(2);
    });
    const review = (await state.coordinator.review({
      kind: "add",
      account: activeTarget,
      asset,
    })).review;
    await expect(state.coordinator.decide({ review, initiatedBy: "cli" }))
      .rejects.toSatisfy((error: unknown) => failureCode(error) === "state_conflict");
    expect(state.database.tokenCatalogStore().readOperation(review.operationId)).toBeNull();
    expect(state.database.tokenCatalogStore().getSelection(account, asset)).toBeUndefined();
    await state.coordinator.close();
    state.database.close();
  });

  it("rolls back the selection when the terminal operation cannot be stored", async () => {
    const state = await createState();
    const review = (await state.coordinator.review({ kind: "add", account: activeTarget, asset })).review;
    const raw = new Database(state.path);
    raw.exec(`CREATE TRIGGER reject_token_operation BEFORE INSERT ON token_selection_operation
      BEGIN SELECT RAISE(ABORT, 'reject terminal operation'); END`);
    raw.close();

    await expect(state.coordinator.decide({ review, initiatedBy: "cli" })).rejects.toBeDefined();
    const check = new Database(state.path, { readonly: true });
    expect(check.prepare("SELECT COUNT(*) AS count FROM account_token_selection").get())
      .toEqual({ count: 0 });
    expect(check.prepare("SELECT COUNT(*) AS count FROM token_selection_operation").get())
      .toEqual({ count: 0 });
    check.close();
    await state.coordinator.close();
    state.database.close();
  });
});

describe("token catalog coordinator lifecycle", () => {
  it("publishes close before abort reentry and drains the admitted call", async () => {
    const operationFailure = new Error("chain dependency stopped");
    let releaseChainRead!: () => void;
    let markChainReadStarted!: () => void;
    const chainReadGate = new Promise<void>((resolveGate) => { releaseChainRead = resolveGate; });
    const chainReadStarted = new Promise<void>((resolveStarted) => {
      markChainReadStarted = resolveStarted;
    });
    let coordinator!: TokenCatalogCoordinator;
    let reenteredClose!: Promise<void>;
    let chainCalls = 0;
    let operationAbortObserved = false;
    const chainReads: TokenAdditionChainReadPort = Object.freeze({
      async inspectAndVerifyOfficial(
        _input: Parameters<TokenAdditionChainReadPort["inspectAndVerifyOfficial"]>[0],
        signal: AbortSignal,
      ): Promise<never> {
        chainCalls += 1;
        signal.addEventListener("abort", () => {
          operationAbortObserved = true;
          reenteredClose = coordinator.close();
        }, { once: true });
        markChainReadStarted();
        await chainReadGate;
        throw operationFailure;
      },
    });
    const state = await createState(chainReads);
    coordinator = state.coordinator;
    const operation = coordinator.review({ kind: "add", account: activeTarget, asset });
    await chainReadStarted;

    let closeSettled = false;
    const closing = coordinator.close();
    void closing.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );
    expect(operationAbortObserved).toBe(true);
    expect(reenteredClose).toBe(closing);
    expect(coordinator.close()).toBe(closing);
    expect(chainCalls).toBe(1);
    await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
    expect(closeSettled).toBe(false);
    await expect(coordinator.review({ kind: "add", account: activeTarget, asset })).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "runtime_state_unavailable",
    );

    releaseChainRead();
    await expect(operation).rejects.toSatisfy(
      (error: unknown) => failureCode(error) === "internal_error",
    );
    await expect(closing).resolves.toBeUndefined();
    expect(closeSettled).toBe(true);
    expect(coordinator.close()).toBe(closing);
    state.database.close();
  });
});
