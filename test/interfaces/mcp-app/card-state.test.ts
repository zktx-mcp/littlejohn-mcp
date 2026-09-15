import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanonicalClock, parseUtcTimestamp } from "../../../src/core/index.js";
import { ProductDatabase } from "../../../src/runtime/database.js";
import { PresentationCardApplication } from "../../../src/interfaces/mcp-app/card-application.js";
import { signingReviewSchema } from "../../../src/review/signing-contracts.js";
import type { CardDomains } from "../../../src/interfaces/mcp-app/card-sources.js";
import type { DecisionCardRecord as CardRecord, PresentationCardStore } from "../../../src/interfaces/mcp-app/card-contract.js";
import { cardReferenceContract, cardControlContracts } from "../../../src/interfaces/mcp-app/card-contract.js";
import { createPresentationSnapshot } from "../../../src/runtime/presentation-snapshot-server.js";
import { descriptorForPresentationSnapshot } from "../../../src/interfaces/mcp-app/contracts.js";
import { createSigningCodec } from "../../../src/chain/evm-standard.js";
import { createSigningFixture, command, message, signer } from "../../review/signing-fixture.js";
import { createTokenOperation } from "../../token-catalog/harness.js";
import { createTokenCatalogFailure } from "../../../src/token-catalog/errors.js";
import { parseWalletReview, walletReviewDigest, parseWalletManagementOperation, type WalletManagementOperation } from "../../../src/wallet/contracts.js";
import { WalletOperationError } from "../../../src/wallet/errors.js";

// Independent JSON ordering for these admitted ASCII-key fixtures; Node crypto supplies SHA-256.
const canonicalFixture = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalFixture((value as Record<string, unknown>)[key])}`).join(",")}}`;
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
const unexpected = async (): Promise<never> => { throw new Error("Unexpected domain call."); };
const unusedDomains = (): Pick<CardDomains, "wallet" | "token" | "exchange"> => ({
  wallet: { review: unexpected, decide: unexpected, get: unexpected, getPresentation: unexpected, cancel: unexpected },
  token: { review: unexpected, decide: unexpected, getOperation: () => { throw new Error("Unexpected Token operation."); } },
  exchange: { start: unexpected, confirm: unexpected, get: () => { throw new Error("Unexpected Review read."); }, cancel: () => { throw new Error("Unexpected Review discard."); } },
});
const setup = async (options: { codec?: ReturnType<typeof createSigningCodec>; store?: (value: PresentationCardStore) => PresentationCardStore } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "littlejohn-cards-"));
  const path = join(root, "product.sqlite3");
  const signing = createSigningFixture(options.codec);
  const database = await ProductDatabase.open(path, parseUtcTimestamp(signing.clock.now()));
  const domains: CardDomains = { ...unusedDomains(), signing: {
    start: signing.coordinator.start.bind(signing.coordinator), confirm: vi.fn(signing.coordinator.confirm.bind(signing.coordinator)),
    cancel: signing.coordinator.cancel.bind(signing.coordinator),
    get: (operationId) => ({ operationId, review: signing.coordinator.get(operationId) }),
  } };
  const owner = new AbortController();
  const dependencies = { ownerSignal: owner.signal, clock: signing.clock, store: options.store?.(database.presentationCardStore()) ?? database.presentationCardStore(),
    snapshots: database.presentationSnapshotStore(), reviews: { readPresentation: vi.fn((id: string) => signing.materials.readPresentation(id)) }, domains, readExecution: { execute: unexpected } };
  const cards = new PresentationCardApplication(dependencies);
  cleanup.push(async () => {
    if (signing.startRequest.mock.calls.length !== 0) signing.reply({ status: "wallet_rejected" });
    await cards.close(); await signing.close(); database.close(); await rm(root, { recursive: true, force: true });
  });
  const start = async () => {
    const created = await cards.startReview("signing", command, new AbortController().signal);
    const review = signingReviewSchema.parse(created.value);
    const state = await cards.get(created.reference).then((delivery) => delivery.presentation.state);
    if (state.record === null || state.record.kind === "read") throw new Error("Stateful card required.");
    return { review, record: state.record, context: { cardId: state.record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") } };
  };
  return { cards, database, path, signing, domains, dependencies, start, owner };
};
const anotherOpening = (record: Pick<CardRecord, "cardId">) => ({ cardId: record.cardId, cardOpenRequestId: Buffer.alloc(32, 93).toString("base64url") });

describe("backend card state", () => {
  it("rejects admission from an ended owner without consuming the existing decision", async () => {
    const test = await setup(); const { review, record, context } = await test.start();
    test.owner.abort();
    const replacement = new PresentationCardApplication(test.dependencies);
    try {
      await expect(replacement.initialize()).rejects.toThrow("Local runtime state is unavailable.");
      await expect(test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal))
        .rejects.toThrow("Local runtime state is unavailable.");
      await expect(test.cards.startReview("signing", command, new AbortController().signal))
        .rejects.toThrow("Local runtime state is unavailable.");
      expect(test.database.presentationCardStore().read(record.cardId)).toEqual(record);
      expect(test.signing.startRequest).not.toHaveBeenCalled();
    } finally { await replacement.close(); }
  });

  it("settles admitted signing on owner abort before application cleanup and ignores a late signature", async () => {
    const test = await setup(); const { review, record, context } = await test.start();
    await test.cards.open(context);
    const pending = test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal);
    await test.signing.sent;
    test.owner.abort();
    expect(await pending).toMatchObject({ result: { outcome: { status: "delivery_unknown" } } });
    const stored = test.database.presentationCardStore().read(record.cardId);
    expect(stored).toMatchObject({ phase: "closed", outcome: { kind: "signing", status: "delivery_unknown" } });
    const signature = await signer.signMessage({ message });
    test.signing.reply({ status: "signature_returned", signature });
    await test.cards.close();
    expect(test.database.presentationCardStore().read(record.cardId)).toEqual(stored);
    expect(test.signing.startRequest).toHaveBeenCalledOnce();
  });

  it("resolves only the existing card at the complete presentation source without opening it", async () => {
    const test = await setup(); const { review, record } = await test.start();
    const prepared = createPresentationSnapshot({ contractId: "signing.start_review", contractVersion: "1", normalizedInput: command, admittedResult: review });
    if (prepared.status !== "available") throw new Error("Snapshot required");
    const source = { kind: "review_memory" as const, operationId: review.operationId, expiresAt: review.actionExpiresAt };
    const descriptor = descriptorForPresentationSnapshot(prepared.value, source);
    const input = { operationId: review.operationId, descriptor };
    expect(test.cards.getReference(input)).toEqual({ kind: "card", cardId: record.cardId });
    expect(test.database.presentationCardStore().read(record.cardId)).toEqual(record);
    for (const altered of [
      { ...descriptor, resultSha256: "f".repeat(64) },
      descriptorForPresentationSnapshot(prepared.value, { kind: "sqlite" }),
      descriptorForPresentationSnapshot(prepared.value, { ...source, operationId: Buffer.alloc(32, 19).toString("base64url") }),
      descriptorForPresentationSnapshot(prepared.value, { ...source, expiresAt: parseUtcTimestamp("2099-01-01T00:00:00.000Z") }),
    ]) {
      const admitted = cardReferenceContract.parseInput({ ...input, descriptor: altered });
      expect(() => test.cards.getReference(admitted)).toThrow("Card identity or state is inconsistent.");
    }
    expect(() => test.cards.getReference({ ...input, operationId: Buffer.alloc(32, 20).toString("base64url") })).toThrow("This exact card is not retained.");
    expect(test.database.presentationCardStore().read(record.cardId)).toEqual(record);
    expect(test.signing.startRequest).not.toHaveBeenCalled();
  });

  it("records the received first opening, admits retries and closes a different opening", async () => {
    const test = await setup();
    const { review, record, context } = await test.start();
    expect(record.firstCardOpenRequestId).toBeNull();
    const initial = await Promise.all([test.cards.open(context).then((delivery) => delivery.presentation.state), test.cards.open({ ...context }).then((delivery) => delivery.presentation.state)]);
    expect(initial.map((value) => value.mode)).toEqual(["interactive", "interactive"]);
    expect(initial.map((value) => value.record !== null && value.record.kind !== "read" ? value.record.firstCardOpenRequestId : undefined)).toEqual([context.cardOpenRequestId, context.cardOpenRequestId]);
    expect(await test.cards.get({ kind: "card", cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ record: { phase: "ready" } });
    test.dependencies.reviews.readPresentation.mockClear();
    const returned = await test.cards.open(anotherOpening(record)).then((delivery) => delivery.presentation.state);
    expect(returned).toMatchObject({ mode: "static", record: { outcome: { kind: "decision", reason: "returned" } } });
    expect(test.signing.coordinator.get(review.operationId)).toBeNull();
    expect(test.dependencies.reviews.readPresentation).not.toHaveBeenCalled();
    await expect(test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal)).rejects.toThrow();
    const replay = test.database.presentationCardStore().insert({ ...record, cardId: Buffer.alloc(32, 92).toString("base64url") });
    expect(replay).toEqual(returned.record);
    expect(test.signing.startRequest).not.toHaveBeenCalled();
    expect(test.domains.signing.confirm).not.toHaveBeenCalled();
  });

  it("lets an overtaking stop close the ready card before a delayed action arrives", async () => {
    const test = await setup(); const { review, record, context } = await test.start();
    await test.cards.open(context).then((delivery) => delivery.presentation.state);
    expect(await test.cards.cancelWait({ cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static" });
    await expect(test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal)).rejects.toThrow();
    expect(test.signing.startRequest).not.toHaveBeenCalled();
  });

  it("rejects a different admitted decision without consuming either live source", async () => {
    const test = await setup(); const first = await test.start(); const second = await test.start();
    await test.cards.open(first.context).then((delivery) => delivery.presentation.state);
    await expect(test.cards.action(first.context, { review: second.review, initiatedBy: "mcp_app" }, new AbortController().signal)).rejects.toThrow("Local state changed");
    expect(test.domains.signing.confirm).not.toHaveBeenCalled();
    expect(test.signing.coordinator.get(first.review.operationId)).toEqual(first.review);
    expect(test.signing.coordinator.get(second.review.operationId)).toEqual(second.review);
    expect(await test.cards.get({ kind: "card", cardId: first.record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ record: { phase: "ready" } });
    await test.cards.cancelDecision({ cardId: first.record.cardId }).then((delivery) => delivery.presentation.state);
    await test.cards.cancelDecision({ cardId: second.record.cardId }).then((delivery) => delivery.presentation.state);
  });

  it("persists the verified status without the signature or consumed data, and reopens it without a live read", async () => {
    const test = await setup(); const { review, record, context } = await test.start();
    await test.cards.open(context).then((delivery) => delivery.presentation.state);
    const pending = test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal);
    await test.signing.sent;
    const signature = await signer.signMessage({ message });
    test.signing.reply({ status: "signature_returned", signature });
    expect(await pending).toMatchObject({ result: { outcome: { status: "verified" }, signature } });
    const read = test.dependencies.reviews.readPresentation;
    read.mockClear();
    expect(await test.cards.open(anotherOpening(record)).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static", record: { outcome: { kind: "signing", status: "verified" } } });
    expect(await test.cards.cancelWait({ cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ record: { outcome: { status: "verified" } } });
    expect(read).not.toHaveBeenCalled();
    const raw = new Database(test.path, { readonly: true });
    try {
      const json = (raw.prepare("SELECT record_json AS value FROM presentation_card").get() as { value: string }).value;
      expect(json).not.toContain(signature); expect(json).not.toContain(message); expect(json).not.toContain("payload");
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_snapshot").get()).toEqual({ count: 0 });
      expect(JSON.parse(json).resultDigest).toBe(createHash("sha256").update(canonicalFixture(review)).digest("hex"));
    } finally { raw.close(); }
    expect(test.signing.startRequest).toHaveBeenCalledOnce();
  });

  it("ends the original wait without transport cancellation and ignores a later genuine signature", async () => {
    const codec = createSigningCodec(); const recoverAddress = vi.fn(codec.recoverAddress);
    const test = await setup({ codec: { ...codec, recoverAddress } });
    const { review, record, context } = await test.start(); await test.cards.open(context).then((delivery) => delivery.presentation.state);
    const requestSignal = new AbortController();
    const pending = test.cards.action(context, { review, initiatedBy: "mcp_app" }, requestSignal.signal);
    await test.signing.sent;
    await expect(test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal)).rejects.toThrow("Local state changed");
    expect(test.domains.signing.confirm).toHaveBeenCalledOnce();
    expect(await test.cards.cancelWait({ cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ record: { outcome: { kind: "signing", status: "delivery_unknown" } } });
    expect(requestSignal.signal.aborted).toBe(false);
    expect(await pending).toMatchObject({ result: { outcome: { status: "delivery_unknown" } } });
    test.signing.reply({ status: "signature_returned", signature: await signer.signMessage({ message }) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recoverAddress).not.toHaveBeenCalled();
    expect(await test.cards.get({ kind: "card", cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ record: { outcome: { status: "delivery_unknown" } } });
    expect(test.signing.startRequest).toHaveBeenCalledOnce();
  });

  it("keeps an in-flight real verification from publishing after local termination", async () => {
    const codec = createSigningCodec();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const recovering = new Promise<void>((resolve) => { entered = resolve; });
    const test = await setup({ codec: { ...codec, recoverAddress: async (hash, signature) => {
      entered(); await gate; return codec.recoverAddress(hash, signature);
    } } });
    const { review, record, context } = await test.start(); await test.cards.open(context).then((delivery) => delivery.presentation.state);
    const pending = test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal);
    try {
      await test.signing.sent;
      test.signing.reply({ status: "signature_returned", signature: await signer.signMessage({ message }) });
      await recovering;
      expect(await test.cards.cancelWait({ cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ record: { outcome: { status: "delivery_unknown" } } });
      release(); await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await pending).toMatchObject({ result: { outcome: { status: "delivery_unknown" } } });
      expect(await test.cards.open(anotherOpening(record)).then((delivery) => delivery.presentation.state)).toMatchObject({ record: { outcome: { status: "delivery_unknown" } } });
    } finally { release(); }
  });

  it("keeps the admitted App request after transport closure and publishes only its saved classification", async () => {
    const test = await setup(); const { review, record, context } = await test.start();
    await test.cards.open(context);
    const transport = new AbortController();
    const pending = test.cards.action(context, { review, initiatedBy: "mcp_app" }, transport.signal);
    const endedDelivery = expect(pending).rejects.toMatchObject({ failure: { error: { code: "request_aborted" } } });
    await test.signing.sent;
    transport.abort();
    expect((await test.cards.open(anotherOpening(record))).presentation.state).toMatchObject({ record: { phase: "pending", outcome: null } });
    const signature = await signer.signMessage({ message });
    test.signing.reply({ status: "signature_returned", signature });
    await endedDelivery;
    const saved = await test.cards.get({ kind: "card", cardId: record.cardId });
    expect(saved.presentation.state).toMatchObject({ record: { phase: "closed", outcome: { kind: "signing", status: "verified" },
      context: { account: review.account, method: "personal_sign" } } });
    expect(JSON.stringify(saved)).not.toContain(signature);
    expect(JSON.stringify(saved)).not.toContain(message);
    expect(test.signing.startRequest).toHaveBeenCalledOnce();
  });

  it("prevents dispatch on a failed predecessor write and preserves a verified response when only its state write fails", async () => {
    let failure: "dispatching" | "verified" | undefined = "dispatching";
    const test = await setup({ store: (store) => ({ ...store, replace(before, after) {
      if ((failure === "dispatching" && after.phase === "dispatching") ||
          (failure === "verified" && after.outcome?.kind === "signing" && after.outcome.status === "verified")) throw new Error("Injected storage failure");
      return store.replace(before, after);
    } }) });
    const { review, context } = await test.start(); await test.cards.open(context).then((delivery) => delivery.presentation.state);
    await expect(test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal)).rejects.toThrow("Injected storage failure");
    expect(test.signing.startRequest).not.toHaveBeenCalled();
    failure = "verified";
    const pending = test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal);
    await test.signing.sent;
    const signature = await signer.signMessage({ message }); test.signing.reply({ status: "signature_returned", signature });
    expect(await pending).toMatchObject({ result: { outcome: { status: "verified" }, signature } });
    await expect(test.cards.get({ kind: "card", cardId: context.cardId }).then((delivery) => delivery.presentation.state)).rejects.toThrow("Local runtime state is unavailable");
    expect(test.signing.startRequest).toHaveBeenCalledOnce();
  });

  it("joins the existing close process, settles waiting and preserves its result for another owner", async () => {
    const test = await setup(); const { review, record, context } = await test.start();
    await test.cards.open(context).then((delivery) => delivery.presentation.state);
    let settled = false;
    const pending = test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal).then((value) => { settled = true; return value; });
    await test.signing.sent;
    try {
      const first = test.cards.close(); const second = test.cards.close();
      expect(second).toBe(first); await second;
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({ result: { outcome: { status: "delivery_unknown" } } });
      const replacement = new PresentationCardApplication(test.dependencies);
      try { expect(await replacement.get({ kind: "card", cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static", record: { outcome: { status: "delivery_unknown" } } }); }
      finally { await replacement.close(); }
    } finally { test.signing.reply({ status: "wallet_rejected" }); await pending; }
  });

  it("closes an expired unsubmitted decision from the owner clock without sending", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-10T00:00:00.000Z"));
    const test = await setup(); const { record, context } = await test.start();
    await test.cards.open(context).then((delivery) => delivery.presentation.state); await vi.advanceTimersByTimeAsync(300_000);
    expect(await test.cards.get({ kind: "card", cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static", record: { outcome: { reason: "expired" } } });
    expect(test.signing.startRequest).not.toHaveBeenCalled();
  });

  it("closes an unsubmitted decision on owner startup without needing a previous View", async () => {
    const test = await setup();
    const { record, context, review } = await test.start();
    await test.cards.close();
    const next = new PresentationCardApplication(test.dependencies);
    cleanup.push(() => next.close());
    await next.initialize();
    expect(await next.open(context).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static",
      record: { firstCardOpenRequestId: null, outcome: { kind: "decision", reason: "owner_lost" } } });
    await expect(next.decideWithoutView("signing", { review, initiatedBy: "cli" }, new AbortController().signal)).rejects.toThrow();
    expect(test.signing.startRequest).not.toHaveBeenCalled();
    expect(test.database.presentationCardStore().read(record.cardId)?.phase).toBe("closed");
  });

  it("keeps expiry as the saved outcome when a CLI discard arrives after the deadline", async () => {
    vi.useFakeTimers();
    const test = await setup();
    const { record } = await test.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await test.cards.cancelReview("signing", record.operationId)).toMatchObject({ status: "unavailable" });
    expect(await test.cards.get({ kind: "card", cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static",
      record: { outcome: { kind: "decision", reason: "expired" } } });
    expect(test.signing.startRequest).not.toHaveBeenCalled();
  });

  it("keeps admitted CLI work on opening and leaves explicit CLI cancellation with its caller", async () => {
    const test = await setup();
    const { review, context } = await test.start();
    const controller = new AbortController();
    const pending = test.cards.decideWithoutView("signing", { review, initiatedBy: "cli" }, controller.signal);
    await test.signing.sent;
    expect(await test.cards.open(context).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static",
      record: { phase: "pending", outcome: null } });
    controller.abort();
    expect(await pending).toMatchObject({ outcome: { status: "delivery_unknown" } });
    expect(test.signing.startRequest).toHaveBeenCalledOnce();
  });

  it("adopts Token operations through their exact operation ID and reopens their fixed result", async () => {
    const test = await setup(); const operation = await createTokenOperation({ kind: "remove" });
    if (operation.review.kind !== "remove") throw new Error("Removal fixture required.");
    const previousSelection = operation.review.precondition.previousSelection;
    if (previousSelection === null) throw new Error("Existing selection required for removal input.");
    let stored = false;
    const getOperation = vi.fn(() => stored ? operation : createTokenCatalogFailure("token_operation_not_found"));
    const decide = vi.fn(async () => { stored = true; return operation; });
    const cards = new PresentationCardApplication({ ...test.dependencies,
      clock: createCanonicalClock(() => operation.review.createdAt),
      domains: { ...test.domains, token: { review: async () => ({ review: operation.review }), decide, getOperation } },
    });
    cleanup.push(() => cards.close());
    const created = await cards.startReview("token_selection", { kind: "remove", account: { kind: "active_wallet" }, asset: operation.review.target.asset, expectedRevision: previousSelection.revision }, new AbortController().signal);
    const state = await cards.get(created.reference).then((delivery) => delivery.presentation.state);
    if (state.record === null) throw new Error("Card required.");
    if (state.record.kind !== "token_selection" || state.record.snapshotId === null) throw new Error("Stored selection Review required.");
    const alias = { kind: "snapshot" as const, snapshotId: state.record.snapshotId };
    const aliased = (await cards.get(alias)).presentation;
    expect(cardControlContracts.read.parsePublicSuccess(alias, aliased).state.reference).toEqual(created.reference);
    expect(aliased.state.record).toMatchObject({ firstCardOpenRequestId: null });
    expect(() => cardControlContracts.read.parsePublicSuccess({ ...alias, snapshotId: `sha256:${"e".repeat(64)}` }, aliased)).toThrow();
    const context = { cardId: state.record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") };
    await cards.open(context).then((delivery) => delivery.presentation.state);
    expect((await cards.action(context, { review: operation.review, initiatedBy: "mcp_app" }, new AbortController().signal)).result).toEqual(operation);
    getOperation.mockClear();
    expect(await cards.open(anotherOpening(state.record)).then((delivery) => delivery.presentation.state)).toMatchObject({ record: { phase: "closed", outcome: { kind: "operation" } } });
    expect((await cards.get(alias)).presentation.state).toMatchObject({ reference: created.reference, record: { phase: "closed", outcome: { kind: "operation" } } });
    expect(getOperation).toHaveBeenCalledWith({ operationId: operation.operationId }); expect(decide).toHaveBeenCalledOnce();
  });

  it("uses one Wallet observation, skips unchanged writes and preserves terminal facts when details fail", async () => {
    const test = await setup();
    const base = { contractVersion: "1", domain: "wallet", kind: "connect", operationId: Buffer.alloc(32, 71).toString("base64url"),
      createdAt: "2026-07-14T00:00:00.000Z", actionExpiresAt: "2026-07-14T00:05:00.000Z", target: { chainId: "eip155:4663" },
      decision: { requiredMethods: ["eth_sendTransaction"], optionalMethods: ["personal_sign", "eth_signTypedData_v4"], requiredEvents: ["accountsChanged", "chainChanged"] },
      precondition: { connectionRevision: "0", connection: { status: "disconnected", reason: "no_session" } }, fixedEvidence: { sessionSourceIds: [] } };
    const review = parseWalletReview({ ...base, reviewDigest: walletReviewDigest(base) });
    let operation: WalletManagementOperation | undefined;
    const get = vi.fn(async () => { if (!operation) throw new WalletOperationError("wallet_operation_not_found"); return operation; });
    const getPresentation = vi.fn(async () => { if (!operation) throw new WalletOperationError("wallet_operation_not_found"); return { operation }; });
    const replace = vi.fn(test.dependencies.store.replace);
    const decide = vi.fn(async () => operation = parseWalletManagementOperation({ contractVersion: "1", domain: "wallet", kind: "connect", operationId: review.operationId,
      initiatedBy: "mcp_app", review, state: "starting_connection", terminationTarget: null, result: null, failure: null, peerRefusalCode: null }));
    const cards = new PresentationCardApplication({ ...test.dependencies, store: { ...test.dependencies.store, replace }, clock: createCanonicalClock(() => review.createdAt),
      domains: { ...test.domains, wallet: { ...test.domains.wallet, review: async () => ({ status: "review", review }), decide, get, getPresentation } } });
    cleanup.push(() => cards.close());
    const created = await cards.startReview("wallet", { kind: "connect" }, new AbortController().signal);
    const state = await cards.get(created.reference).then((delivery) => delivery.presentation.state);
    if (state.record === null) throw new Error("Card required.");
    const context = { cardId: state.record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") }; await cards.open(context).then((delivery) => delivery.presentation.state);
    await cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal);
    get.mockClear(); getPresentation.mockClear(); replace.mockClear();
    const readOnly = await cards.get({ kind: "card", cardId: context.cardId });
    expect(readOnly.presentation).toMatchObject({ state: { record: { phase: "pending" } }, actions: [] });
    expect(get).toHaveBeenCalledOnce(); expect(getPresentation).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
    get.mockClear();
    await cards.get({ kind: "card", ...context });
    expect(get).not.toHaveBeenCalled(); expect(getPresentation).toHaveBeenCalledOnce(); expect(replace).not.toHaveBeenCalled();
    expect(await cards.open(anotherOpening(state.record)).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static", record: { phase: "pending" } });
    operation = parseWalletManagementOperation({ ...operation, state: "cancelled" });
    expect(await cards.get({ kind: "card", cardId: state.record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static" });
    get.mockClear(); await cards.open(anotherOpening(state.record)).then((delivery) => delivery.presentation.state);
    expect(get).toHaveBeenCalledOnce(); expect(get).toHaveBeenCalledWith(review.operationId); expect(decide).toHaveBeenCalledOnce();
    const terminal = (await cards.get({ kind: "card", cardId: context.cardId })).presentation.state;
    get.mockRejectedValueOnce(new WalletOperationError("runtime_state_unavailable"));
    const withoutDetails = await cards.get({ kind: "card", cardId: context.cardId });
    expect(withoutDetails.presentation.state).toEqual(terminal);
    expect(withoutDetails.presentation.display).toEqual({ kind: "summary" });
    expect(withoutDetails.presentation.actions).toEqual([]);
  });
});
