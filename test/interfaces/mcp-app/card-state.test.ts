import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanonicalClock, parseUtcTimestamp, captureCanonicalJson } from "../../../src/core/index.js";
import { ProductDatabase } from "../../../src/runtime/database.js";
import {createOwnerInstanceId} from "../../../src/runtime/runtime-identity.js";
import { PresentationCardApplication } from "../../../src/interfaces/mcp-app/card-application.js";
import { signingReviewSchema } from "../../../src/review/signing-contracts.js";
import type { CardDomains } from "../../../src/interfaces/mcp-app/card-sources.js";
import type { DecisionCardRecord as CardRecord, PresentationCardStore } from "../../../src/interfaces/mcp-app/card-contract.js";
import { cardReferenceContract, cardControlContracts, cardReadStartContract } from "../../../src/interfaces/mcp-app/card-contract.js";
import {tokenCatalogApplicationContracts} from "../../../src/token-catalog/contracts.js";
import { createPresentationSnapshot } from "../../../src/runtime/presentation-snapshot-server.js";
import { descriptorForPresentationSnapshot } from "../../../src/interfaces/mcp-app/contracts.js";
import { createSigningCodec } from "../../../src/chain/evm-standard.js";
import { createSigningFixture, command, message, signer } from "../../review/signing-fixture.js";
import { createTokenOperation } from "../../token-catalog/harness.js";
import { createTokenCatalogFailure } from "../../../src/token-catalog/errors.js";
import { walletReviewResultSchema, parseWalletReview, walletReviewDigest, parseWalletManagementOperation } from "../../../src/wallet/contracts.js";
import { WalletOperationError } from "../../../src/wallet/operation-error.js";

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
  wallet: { prepareReview: unexpected, getReviewSource: () => {throw new Error("Unexpected Review source");}, discardPreparedReview: () => {}, getAccountSelection: unexpected, selectAccount: unexpected, review: unexpected, decide: unexpected, get: unexpected, getPresentation: unexpected, cancel: unexpected },
  token: { prepareReview: unexpected, getReviewSource: () => {throw new Error("Unexpected Token source");}, discardPreparedReview: () => {}, review: unexpected, decide: unexpected, getOperation: () => { throw new Error("Unexpected Token operation."); } },
  exchange: { prepareConfirm: unexpected, start: unexpected, confirm: unexpected, get: () => { throw new Error("Unexpected Review read."); }, cancel: () => { throw new Error("Unexpected Review discard."); } },
});
const setup = async (options: { codec?: ReturnType<typeof createSigningCodec>; store?: (value: PresentationCardStore) => PresentationCardStore } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "littlejohn-cards-"));
  const path = join(root, "product.sqlite3");
  const signing = createSigningFixture(options.codec);
  const database = await ProductDatabase.open(path, parseUtcTimestamp(signing.clock.now()));
  database.ownerStore().publishOwner(createOwnerInstanceId(), Buffer.alloc(32, 7).toString("base64url"), parseUtcTimestamp(signing.clock.now()));
  const domains: CardDomains = { ...unusedDomains(), signing: {
    start: signing.coordinator.start.bind(signing.coordinator), prepareConfirm: vi.fn(signing.coordinator.prepareConfirm.bind(signing.coordinator)), confirm: signing.coordinator.confirm.bind(signing.coordinator),
    cancel: signing.coordinator.cancel.bind(signing.coordinator),
    get: (operationId) => ({ operationId, review: signing.coordinator.get(operationId) }),
  } };
  const owner = new AbortController();
  const dependencies = { ownerSignal: owner.signal, clock: signing.clock, store: options.store?.(database.presentationCardStore()) ?? database.presentationCardStore(),
    snapshots: database.presentationSnapshotStore(), reviews: { readPresentation: vi.fn((id: string) => signing.materials.readPresentation(id)) }, domains, readExecution: { execute: unexpected } };
  const cards = new PresentationCardApplication(dependencies);
  await cards.initialize();
  cleanup.push(async () => {
    if (signing.startRequest.mock.calls.length !== 0) signing.reply({ status: "wallet_rejected" });
    await cards.close(); await signing.close(); database.close(); await rm(root, { recursive: true, force: true });
  });
  const start = async () => {
    const created = await cards.startDecision({kind: "signing", source: {kind: "new", input: command}}, new AbortController().signal);
    const state = await cards.get({kind: "card", cardId: created.cardId}).then((delivery) => delivery.presentation.state);
    if (state.record === null || state.record.kind !== "signing") throw new Error("Stateful signing card required.");
    const review = signingReviewSchema.parse(signing.coordinator.get(state.record.operationId));
    return { review, record: state.record, context: { cardId: state.record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") } };
  };
  return { cards, database, path, signing, domains, dependencies, start, owner };
};
const anotherOpening = (record: Pick<CardRecord, "cardId">) => ({ cardId: record.cardId, cardOpenRequestId: Buffer.alloc(32, 93).toString("base64url") });

describe("backend card state", () => {
  it.each(["operation", "deadline", "source"] as const)("rejects a validly shaped durable Wallet source %s mismatch before operation reads or controls", async (field) => {
    const test = await setup();
    const now = parseUtcTimestamp(test.signing.clock.now());
    const current = test.database.walletStore().read();
    const projection = test.database.walletStore().replace(current.revision, {status: "disconnected", reason: "no_session"}, null, null, now, [], []);
    const withoutDigest = {contractVersion: "1", domain: "wallet", kind: "connect", operationId: Buffer.alloc(32, 61).toString("base64url"),
      createdAt: now, actionExpiresAt: new Date(Date.parse(now) + 300_000).toISOString(), target: {chainId: "eip155:4663"},
      decision: {requiredMethods: ["eth_sendTransaction"], optionalMethods: ["personal_sign", "eth_signTypedData_v4"], requiredEvents: ["accountsChanged", "chainChanged"]},
      precondition: {connectionRevision: projection.revision, connection: {status: "disconnected", reason: "no_session"}}, fixedEvidence: {sessionSourceIds: []}};
    const review = parseWalletReview({...withoutDigest, reviewDigest: walletReviewDigest(withoutDigest)});
    const reviews = test.database.walletReviewStore();
    const get = vi.fn(async () => {throw new WalletOperationError("wallet_operation_not_found");});
    const cards = new PresentationCardApplication({...test.dependencies, domains: {...test.domains, wallet: {...test.domains.wallet,
      prepareReview: async (input) => ({status: "review", prepared: reviews.prepare(input, review)}), discardPreparedReview: reviews.discard,
      getReviewSource: (id) => {const original = reviews.get(id); return {input: original.input, result: {status: "review", review: original.review}};},
      get, getPresentation: get}}});
    cleanup.push(() => cards.close()); await cards.initialize();
    const created = await cards.startDecision({kind: "wallet", source: {kind: "new", input: {kind: "connect"}}}, new AbortController().signal);
    expect((await cards.open(anotherOpening(created))).presentation.actions).toEqual(["confirm", "discard"]);
    const retained = test.database.presentationCardStore().read(created.cardId);
    if (retained?.kind !== "wallet") throw new Error("Wallet card required.");
    let replacement: {snapshotId: string; resultDigest: string} | undefined;
    if (field === "source") {
      const different = {...withoutDigest, precondition: {...withoutDigest.precondition, connectionRevision: "2"}};
      const changedReview = parseWalletReview({...different, reviewDigest: walletReviewDigest(different)});
      const snapshot = test.database.presentationSnapshotStore().commit({contractId: "wallet.connection_change_review", contractVersion: "1",
        normalizedInput: {kind: "connect"}, admittedResult: captureCanonicalJson({status: "review", review: changedReview})});
      if (snapshot.status !== "available") throw new Error("Independently admitted replacement snapshot required.");
      replacement = {snapshotId: snapshot.value.snapshotId, resultDigest: snapshot.value.resultDigest};
    }
    const changed = {...retained, ...(field === "operation" ? {operationId: Buffer.alloc(32, 62).toString("base64url")}
      : field === "deadline" ? {expiresAt: new Date(Date.parse(review.actionExpiresAt) + 1_000).toISOString()} : replacement)};
    const raw = new Database(test.path);
    try {raw.prepare("UPDATE presentation_card SET operation_id = ?, record_json = ? WHERE card_id = ?").run(changed.operationId, canonicalFixture(changed), created.cardId);}
    finally {raw.close();}
    // Index and JSON agree, and the complete row schema remains valid. Only source correlation is wrong.
    expect(test.database.presentationCardStore().read(created.cardId)).toEqual(changed);
    get.mockClear();
    await expect(cards.open(anotherOpening(created))).rejects.toMatchObject({failure: {error: {code: "presentation_inconsistent"}}});
    expect(get).not.toHaveBeenCalled(); expect(test.signing.startRequest).not.toHaveBeenCalled();
  });

  it("rejects another valid private account in saved metadata without consuming the original source", async () => {
    const test = await setup(); const {review, record} = await test.start();
    const changed = {...record, context: {...record.context, account: {...review.account, address: `0x${"2".repeat(40)}`}}};
    const raw = new Database(test.path);
    try {raw.prepare("UPDATE presentation_card SET record_json = ? WHERE card_id = ?").run(canonicalFixture(changed), record.cardId);}
    finally {raw.close();}
    expect(test.database.presentationCardStore().read(record.cardId)).toEqual(changed);
    await expect(test.cards.open(anotherOpening(record))).rejects.toMatchObject({failure: {error: {code: "presentation_inconsistent"}}});
    expect(test.signing.coordinator.get(review.operationId)).toEqual(review);
    expect(test.domains.signing.prepareConfirm).not.toHaveBeenCalled(); expect(test.signing.startRequest).not.toHaveBeenCalled();
  });

  it("preserves pending cards while the winning real preparation is held and keeps a racing loser from discarding its opaque material", async () => {
    const test = await setup(); const first = await test.start();
    const second = await test.cards.startDecision({kind: "signing", source: {kind: "existing", operationId: first.review.operationId}}, new AbortController().signal);
    const secondBefore = test.database.presentationCardStore().read(second.cardId);
    let release!: () => void; let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {release = resolve;});
    const preparedEntry = new Promise<void>((resolve) => {entered = resolve;});
    const actual = test.signing.coordinator.prepareConfirm.bind(test.signing.coordinator);
    let firstPreparation = true;
    vi.spyOn(test.domains.signing, "prepareConfirm").mockImplementation(async (input, signal) => {
      const prepared = await actual(input, signal);
      if (firstPreparation) {firstPreparation = false; entered(); await barrier;}
      return prepared;
    });
    const discard = vi.spyOn(test.domains.signing, "cancel");
    void test.signing.sent.then(() => test.signing.reply({status: "wallet_rejected"}));
    const winning = test.cards.action(first.context, {review: first.review, initiatedBy: "mcp_app"}, new AbortController().signal);
    void winning.catch(() => undefined);
    try {
      expect(await Promise.race([preparedEntry.then(() => "prepared"), winning.then(() => "completed")])).toBe("prepared");
      expect(test.signing.materials.readPresentation(first.review.operationId)).toEqual({status: "unavailable", reason: "runtime_unavailable"});
      for (const card of [first.record, second]) {
        const reference = {kind: "card" as const, cardId: card.cardId};
        const read = await test.cards.get(reference);
        const opened = await test.cards.open(anotherOpening(card));
        for (const result of [read, opened]) expect(result.presentation).toMatchObject({state: {record: {inputState: "input_pending", closeReason: null, dispatchId: null}}, display: {kind: "summary"}, actions: []});
      }
      expect(test.database.presentationCardStore().read(first.record.cardId)).toEqual(first.record);
      expect(test.database.presentationCardStore().read(second.cardId)).toEqual(secondBefore);
      expect(discard).not.toHaveBeenCalled(); expect(test.signing.startRequest).not.toHaveBeenCalled();
      await expect(test.cards.action(anotherOpening(second), {review: first.review, initiatedBy: "mcp_app"}, new AbortController().signal))
        .rejects.toMatchObject({failure: {error: {code: "review_unavailable"}}});
      expect(test.database.presentationCardStore().read(second.cardId)).toEqual(secondBefore);
      release();
      expect(await winning).toMatchObject({result: {outcome: {status: "wallet_rejected"}}});
      expect(test.signing.startRequest).toHaveBeenCalledOnce();
      expect((await test.cards.open(anotherOpening(second))).presentation.state).toMatchObject({record: {inputState: "input_closed", closeReason: "invalidated"}});
    } finally {release(); await Promise.allSettled([winning]);}
  });

  it("retains the exact signature source after temporary SDK observation denial and admits fresh explicit input without a new Review", async () => {
    const test = await setup(); const {review, record, context} = await test.start();
    vi.spyOn(test.signing.activeWallet, "validateBoundAccount").mockRejectedValueOnce(new WalletOperationError("runtime_state_unavailable"));
    await expect(test.cards.action(context, {review, initiatedBy: "mcp_app"}, new AbortController().signal))
      .rejects.toMatchObject({failure: {error: {code: "runtime_state_unavailable"}}});
    expect(test.database.presentationCardStore().read(record.cardId)).toEqual(record);
    expect(test.signing.coordinator.get(review.operationId)).toEqual(review);
    expect(test.signing.startRequest).not.toHaveBeenCalled();
    void test.signing.sent.then(() => test.signing.reply({status: "wallet_rejected"}));
    expect(await test.cards.action(context, {review, initiatedBy: "mcp_app"}, new AbortController().signal))
      .toMatchObject({result: {outcome: {status: "wallet_rejected", operationId: review.operationId}}});
    expect(test.signing.startRequest).toHaveBeenCalledOnce();
  });

  it("retains a failed read creation key and closes further publication when precommit reservation cleanup fails", async () => {
    const test = await setup();
    const publicInput = {account: {kind: "address", address: `0x${"1".repeat(40)}`}, limit: 1};
    const input = tokenCatalogApplicationContracts.selections.parseInput(publicInput);
    const result = tokenCatalogApplicationContracts.selections.parsePublicSuccess(input, {account: {chainId: "eip155:4663", address: publicInput.account.address}, selections: [], nextCursor: null});
    const execute = vi.fn(async () => captureCanonicalJson(result));
    const startDecision = vi.spyOn(test.domains.signing, "start");
    const real = test.database.presentationCardStore();
    const cards = new PresentationCardApplication({...test.dependencies, store: {...real,
      commitCreation() {throw new Error("Injected precommit failure");},
      discardCreation() {throw new Error("Injected reservation cleanup failure");},
    }, readExecution: {execute}});
    cleanup.push(() => cards.close()); await cards.initialize();
    const readCommand = cardReadStartContract.parseInput({capabilityId: "token.selections", input: publicInput});
    const key = Buffer.alloc(32, 66).toString("base64url");
    await expect(cards.startRead(readCommand, new AbortController().signal, key)).rejects.toMatchObject({failure: {error: {code: "runtime_state_unavailable"}}});
    const retained = real.beginCreation("read", captureCanonicalJson(readCommand), key);
    expect(retained.status).toBe("creating");
    expect(real.read(retained.cardId)).toMatchObject({kind: "preparing", creationState: "creating"});
    for (const publicationKey of [key, Buffer.alloc(32, 67).toString("base64url")]) {
      await expect(cards.startRead(readCommand, new AbortController().signal, publicationKey)).rejects.toMatchObject({failure: {error: {code: "runtime_state_unavailable"}}});
    }
    await expect(cards.startDecision({kind: "signing", source: {kind: "new", input: command}}, new AbortController().signal))
      .rejects.toMatchObject({failure: {error: {code: "runtime_state_unavailable"}}});
    expect(execute).not.toHaveBeenCalled(); expect(startDecision).not.toHaveBeenCalled();
    const raw = new Database(test.path, {readonly: true});
    try {
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_publication").get()).toEqual({count: 1});
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_card").get()).toEqual({count: 1});
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_snapshot").get()).toEqual({count: 0});
    } finally {raw.close();}
  });

  it.each(["connect", "disconnect"] as const)("publishes the canonical %s no-decision result as immutable information without creating an operation", async (kind) => {
    const test = await setup();
    const value = kind === "connect" ? {status: "current_connection" as const, connectionId: `wallet-session:${"A".repeat(43)}`, connectionRevision: "0"}
      : {status: "already_disconnected" as const, reason: "no_session" as const, connectionRevision: "0"};
    const prepareReview = vi.fn(async () => {const admitted = walletReviewResultSchema.parse(value); if (admitted.status === "review") throw new Error("No decision expected."); return admitted;});
    const wallet: CardDomains["wallet"] = {...test.domains.wallet, prepareReview};
    const cards = new PresentationCardApplication({...test.dependencies, domains: {...test.domains, wallet}});
    cleanup.push(() => cards.close());
    await cards.initialize();
    const created = await cards.startDecision({kind: "wallet", source: {kind: "new", input: {kind}}}, new AbortController().signal);
    const saved = (await cards.get({kind: "card", cardId: created.cardId})).presentation;
    expect(saved).toMatchObject({state: {mode: "static", record: {kind: "read", preparationState: "completed"}}, display: {kind: "snapshot"}, actions: []});
    if (saved.state.record?.kind !== "read" || saved.state.record.snapshotId === null) throw new Error("Immutable no-decision snapshot required.");
    const result = test.database.presentationSnapshotStore().read(saved.state.record.snapshotId);
    if (result.status !== "available") throw new Error("Exact saved result required.");
    expect(JSON.parse(new TextDecoder().decode(result.value.resultBytes))).toEqual(value);
    expect((await cards.open(anotherOpening({cardId: created.cardId}))).presentation).toEqual(saved);
    expect(prepareReview).toHaveBeenCalledExactlyOnceWith({kind});
    const raw = new Database(test.path, {readonly: true});
    try {
      expect(raw.prepare("SELECT count(*) AS count FROM wallet_operation").get()).toEqual({count: 0});
      expect(raw.prepare("SELECT count(*) AS count FROM wallet_review").get()).toEqual({count: 0});
    } finally {raw.close();}
  });

  it("rejects admission from an ended owner without consuming the existing decision", async () => {
    const test = await setup(); const { review, record, context } = await test.start();
    test.owner.abort();
    const replacement = new PresentationCardApplication(test.dependencies);
    try {
      await expect(replacement.initialize()).rejects.toThrow("Local runtime state is unavailable.");
      await expect(test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal))
        .rejects.toThrow("Local runtime state is unavailable.");
      await expect(test.cards.startDecision({kind: "signing", source: {kind: "new", input: command}}, new AbortController().signal))
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
    expect(stored).toMatchObject({ inputState: "input_closed", outcome: { kind: "signing", status: "delivery_unknown" } });
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
    const input = {cardId: record.cardId, descriptor};
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
    expect(() => test.cards.getReference({ ...input, cardId: Buffer.alloc(32, 20).toString("base64url") })).toThrow("This exact card is not retained.");
    expect(test.database.presentationCardStore().read(record.cardId)).toEqual(record);
    expect(test.signing.startRequest).not.toHaveBeenCalled();
  });

  it("keeps two publications of one Review independent until its one real consumption invalidates the other", async () => {
    const test = await setup(); const {review, record, context} = await test.start();
    const opened = await Promise.all([test.cards.open(context), test.cards.open({...context}), test.cards.open(anotherOpening(record))]);
    expect(opened.map((value) => value.presentation.state.mode)).toEqual(["interactive", "interactive", "interactive"]);
    expect(test.database.presentationCardStore().read(record.cardId)).toEqual(record);
    const another = await test.cards.startDecision({kind: "signing", source: {kind: "existing", operationId: review.operationId}}, new AbortController().signal);
    expect(another.cardId).not.toBe(record.cardId);
    expect((await test.cards.open(anotherOpening(another))).presentation.state.mode).toBe("interactive");
    expect(test.signing.coordinator.get(review.operationId)).toEqual(review);
    expect(test.signing.startRequest).not.toHaveBeenCalled();
    const pending = test.cards.action(context, {review, initiatedBy: "mcp_app"}, new AbortController().signal);
    await test.signing.sent;
    expect((await test.cards.open(anotherOpening(another))).presentation.state).toMatchObject({mode: "static",
      record: {inputState: "input_closed", closeReason: "invalidated", outcome: null}});
    await expect(test.cards.action(anotherOpening(another), {review, initiatedBy: "mcp_app"}, new AbortController().signal)).rejects.toThrow("Local state changed");
    test.signing.reply({status: "wallet_rejected"});
    expect(await pending).toMatchObject({result: {outcome: {status: "wallet_rejected"}}});
    expect(test.signing.startRequest).toHaveBeenCalledOnce();
  });

  it("lets an overtaking stop close the ready card before a delayed action arrives", async () => {
    const test = await setup(); const { review, record, context } = await test.start();
    await test.cards.open(context).then((delivery) => delivery.presentation.state);
    expect(await test.cards.cancelDecision({ cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static" });
    await expect(test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal)).rejects.toThrow();
    expect(test.signing.startRequest).not.toHaveBeenCalled();
  });

  it("rejects a different admitted decision without consuming either live source", async () => {
    const test = await setup(); const first = await test.start(); const second = await test.start();
    await test.cards.open(first.context).then((delivery) => delivery.presentation.state);
    await expect(test.cards.action(first.context, { review: second.review, initiatedBy: "mcp_app" }, new AbortController().signal)).rejects.toThrow("Local state changed");
    expect(test.domains.signing.prepareConfirm).not.toHaveBeenCalled();
    expect(test.signing.coordinator.get(first.review.operationId)).toEqual(first.review);
    expect(test.signing.coordinator.get(second.review.operationId)).toEqual(second.review);
    expect(await test.cards.get({ kind: "card", cardId: first.record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ record: { inputState: "input_pending" } });
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
    expect(test.domains.signing.prepareConfirm).toHaveBeenCalledOnce();
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
    await test.signing.sent;
    transport.abort();
    expect((await test.cards.open(anotherOpening(record))).presentation.state).toMatchObject({ record: { inputState: "input_closed", closeReason: "submitted", outcome: null } });
    const signature = await signer.signMessage({ message });
    test.signing.reply({ status: "signature_returned", signature });
    expect(await pending).toMatchObject({result: {outcome: {status: "verified"}, signature}});
    const saved = await test.cards.get({ kind: "card", cardId: record.cardId });
    expect(saved.presentation.state).toMatchObject({ record: { inputState: "input_closed", outcome: { kind: "signing", status: "verified" },
      context: { account: review.account, method: "personal_sign" } } });
    expect(JSON.stringify(saved)).not.toContain(signature);
    expect(JSON.stringify(saved)).not.toContain(message);
    expect(test.signing.startRequest).toHaveBeenCalledOnce();
  });

  it("discards prepared private material and sends no effect when the card admission commit fails", async () => {
    const test = await setup({store: (store) => ({...store, commitDecision() {throw new Error("Injected storage failure");}})});
    // An accidental dispatch settles normally, so the write guard is proved by
    // the observed rejection and absent effect rather than a hanging Wallet future.
    void test.signing.sent.then(() => test.signing.reply({status: "wallet_rejected"}));
    const { review, context } = await test.start(); await test.cards.open(context).then((delivery) => delivery.presentation.state);
    await expect(test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal)).rejects.toThrow("Injected storage failure");
    expect(test.signing.startRequest).not.toHaveBeenCalled();
    expect(test.signing.materials.read(review.operationId)).toBeNull();
    expect(test.database.presentationCardStore().read(context.cardId)).toMatchObject({inputState: "input_pending", closeReason: null, dispatchId: null});
    expect((await test.cards.get({kind: "card", cardId: context.cardId})).presentation.state).toMatchObject({record: {inputState: "input_closed", closeReason: "invalidated"}});
  });

  it("preserves the verified domain response and returns unavailable presentation when its outcome write fails", async () => {
    const test = await setup({store: (store) => ({...store, replace(before, after) {
      if (after.kind === "signing" && after.outcome?.kind === "signing" && after.outcome.status === "verified") throw new Error("Injected storage failure");
      return store.replace(before, after);
    }})});
    const {review, context} = await test.start(); await test.cards.open(context);
    const pending = test.cards.action(context, { review, initiatedBy: "mcp_app" }, new AbortController().signal);
    await test.signing.sent;
    const signature = await signer.signMessage({ message }); test.signing.reply({ status: "signature_returned", signature });
    expect(await pending).toMatchObject({ result: { outcome: { status: "verified" }, signature }, presentation: {status: "unavailable", cardId: context.cardId} });
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
    expect(await test.cards.get({ kind: "card", cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static", record: {closeReason: "expired"} });
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
      record: {closeReason: "owner_lost"} });
    await expect(next.action(context, {review, initiatedBy: "mcp_app"}, new AbortController().signal)).rejects.toThrow();
    expect(test.signing.startRequest).not.toHaveBeenCalled();
    expect((test.database.presentationCardStore().read(record.cardId) as CardRecord).inputState).toBe("input_closed");
  });

  it("keeps expiry as the saved outcome when a CLI discard arrives after the deadline", async () => {
    vi.useFakeTimers();
    const test = await setup();
    const { record } = await test.start();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await test.signing.coordinator.cancel(record.operationId)).toMatchObject({ status: "unavailable" });
    expect(await test.cards.get({ kind: "card", cardId: record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static",
      record: {closeReason: "expired"} });
    expect(test.signing.startRequest).not.toHaveBeenCalled();
  });

  it("keeps admitted CLI work on opening and leaves explicit CLI cancellation with its caller", async () => {
    const test = await setup();
    const { review, context } = await test.start();
    const controller = new AbortController();
    const pending = test.domains.signing.confirm({review, initiatedBy: "cli"}, controller.signal);
    await test.signing.sent;
    expect(await test.cards.open(context).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static",
      record: {inputState: "input_closed", closeReason: "invalidated", outcome: null} });
    controller.abort();
    expect(await pending).toMatchObject({ outcome: { status: "delivery_unknown" } });
    expect(test.signing.startRequest).toHaveBeenCalledOnce();
  });

  it("observes an exact admitted Token operation while snapshot reads remain immutable and independent of its card", async () => {
    const test = await setup(); const operation = await createTokenOperation({kind: "remove"});
    if (operation.review.kind !== "remove") throw new Error("Removal fixture required.");
    const previousSelection = operation.review.precondition.previousSelection;
    if (previousSelection === null) throw new Error("Existing selection required for removal input.");
    const request = {kind: "remove" as const, account: {kind: "active_wallet" as const}, asset: operation.review.target.asset, expectedRevision: previousSelection.revision};
    const source = test.database.tokenCatalogStore();
    // This port supplies an already admitted canonical operation. It performs no mutation.
    const getOperation = vi.fn(() => operation);
    const token: CardDomains["token"] = {
      prepareReview: async (input) => source.prepareReviewSource(input, {review: operation.review}),
      getReviewSource: (operationId) => source.readReviewSource(operationId),
      discardPreparedReview: (prepared) => source.discardReviewSource(prepared),
      review: unexpected, decide: unexpected, getOperation,
    };
    const cards = new PresentationCardApplication({...test.dependencies,
      clock: createCanonicalClock(() => operation.review.createdAt), domains: {...test.domains, token}});
    cleanup.push(() => cards.close());
    await cards.initialize();
    const created = await cards.startDecision({kind: "token_selection", source: {kind: "new", input: request}}, new AbortController().signal);
    const state = (await cards.get({kind: "card", cardId: created.cardId})).presentation.state;
    if (state.record?.kind !== "token_selection" || state.record.snapshotId === null) throw new Error("Stored selection Review required.");
    expect(state).toMatchObject({record: {inputState: "input_closed", closeReason: "invalidated", outcome: {kind: "operation"}}});
    const alias = {kind: "snapshot" as const, snapshotId: state.record.snapshotId};
    getOperation.mockClear();
    const immutable = (await cards.get(alias)).presentation;
    expect(cardControlContracts.read.parsePublicSuccess(alias, immutable)).toMatchObject({state: {mode: "static", reference: alias, record: null}, actions: []});
    expect(getOperation).not.toHaveBeenCalled();
    expect(() => cardControlContracts.read.parsePublicSuccess({...alias, snapshotId: `sha256:${"e".repeat(64)}`}, immutable)).toThrow();
    const opening = (await cards.open(anotherOpening(state.record))).presentation;
    expect(opening).toMatchObject({state: {reference: {kind: "card", cardId: created.cardId}, record: {inputState: "input_closed", outcome: {kind: "operation"}}}, display: {kind: "operation"}, actions: []});
    expect(getOperation).toHaveBeenCalledExactlyOnceWith({operationId: operation.operationId});
    const descriptor = immutable.display.kind === "snapshot" ? immutable.display.resource.descriptor : undefined;
    expect(cards.getReference({cardId: created.cardId, descriptor})).toEqual({kind: "card", cardId: created.cardId});
  });

  it("preserves an original pending Wallet reply while a terminal read wins presentation and later unavailable details keep its facts", async () => {
    const test = await setup();
    const base = { contractVersion: "1", domain: "wallet", kind: "connect", operationId: Buffer.alloc(32, 71).toString("base64url"),
      createdAt: "2026-07-14T00:00:00.000Z", actionExpiresAt: "2026-07-14T00:05:00.000Z", target: { chainId: "eip155:4663" },
      decision: { requiredMethods: ["eth_sendTransaction"], optionalMethods: ["personal_sign", "eth_signTypedData_v4"], requiredEvents: ["accountsChanged", "chainChanged"] },
      precondition: { connectionRevision: "0", connection: { status: "disconnected", reason: "no_session" } }, fixedEvidence: { sessionSourceIds: [] } };
    const review = parseWalletReview({ ...base, reviewDigest: walletReviewDigest(base) });
    const operations = test.database.walletOperationStore();
    const reviews = test.database.walletReviewStore();
    const get = vi.fn(async (operationId: string) => {
      const operation = operations.read(operationId);
      if (operation === null) throw new WalletOperationError("wallet_operation_not_found");
      return operation;
    });
    const getPresentation = vi.fn(async (operationId: string) => ({operation: await get(operationId)}));
    const replace = vi.fn(test.dependencies.store.replace);
    let releaseReply!: () => void; let admitted!: () => void;
    const replyGate = new Promise<void>((resolve) => {releaseReply = resolve;});
    const operationAdmitted = new Promise<void>((resolve) => {admitted = resolve;});
    let captured: ReturnType<typeof operations.create> | undefined;
    const decide = vi.fn(async (_input: Parameters<CardDomains["wallet"]["decide"]>[0], admission?: Parameters<CardDomains["wallet"]["decide"]>[1]) => {
      const operation = parseWalletManagementOperation({contractVersion: "1", domain: "wallet", kind: "connect", operationId: review.operationId,
        initiatedBy: "mcp_app", review, state: "starting_connection", terminationTarget: null, result: null, failure: null, peerRefusalCode: null});
      if (operation.state !== "starting_connection") throw new Error("Active fixture required.");
      captured = operations.create(operation, admission);
      admitted(); await replyGate;
      return captured;
    });
    const cards = new PresentationCardApplication({ ...test.dependencies, store: { ...test.dependencies.store, replace }, clock: createCanonicalClock(() => review.createdAt),
      domains: {...test.domains, wallet: {...test.domains.wallet,
        prepareReview: async (input) => ({status: "review", prepared: reviews.prepare(input, review)}),
        discardPreparedReview: (prepared) => reviews.discard(prepared),
        getReviewSource: (operationId) => {const source = reviews.get(operationId); return {input: source.input, result: {status: "review", review: source.review}};},
        decide, get, getPresentation}}});
    cleanup.push(() => cards.close());
    await cards.initialize();
    let pending: ReturnType<PresentationCardApplication["action"]> | undefined;
    try {
    const created = await cards.startDecision({kind: "wallet", source: {kind: "new", input: {kind: "connect"}}}, new AbortController().signal);
    const state = await cards.get({kind: "card", cardId: created.cardId}).then((delivery) => delivery.presentation.state);
    if (state.record === null) throw new Error("Card required.");
    const context = { cardId: state.record.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url") }; await cards.open(context).then((delivery) => delivery.presentation.state);
    pending = cards.action(context, {review, initiatedBy: "mcp_app"}, new AbortController().signal);
    void pending.catch(() => undefined);
    expect(await Promise.race([operationAdmitted.then(() => "admitted"), pending.then(() => "returned")])).toBe("admitted");
    get.mockClear(); getPresentation.mockClear(); replace.mockClear();
    const readOnly = await cards.get({ kind: "card", cardId: context.cardId });
    expect(readOnly.presentation).toMatchObject({ state: { record: { inputState: "input_closed", closeReason: "submitted" } }, actions: [] });
    expect(get).toHaveBeenCalledOnce(); expect(getPresentation).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
    get.mockClear();
    await cards.get({ kind: "card", ...context });
    expect(get).toHaveBeenCalledOnce(); expect(getPresentation).toHaveBeenCalledOnce(); expect(replace).not.toHaveBeenCalled();
    expect(await cards.open(anotherOpening(state.record)).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static", record: { inputState: "input_closed", closeReason: "submitted" } });
    const original = operations.read(review.operationId);
    if (original?.state !== "starting_connection") throw new Error("Active stored operation required.");
    const cancelling = operations.transition({operationId: original.operationId, reviewDigest: review.reviewDigest,
      connectionRevision: review.precondition.connectionRevision, expectedState: "starting_connection",
      operation: parseWalletManagementOperation({...original, state: "cancelling", terminationTarget: "cancelled"})});
    operations.transition({operationId: original.operationId, reviewDigest: review.reviewDigest,
      connectionRevision: review.precondition.connectionRevision, expectedState: "cancelling",
      operation: parseWalletManagementOperation({...cancelling, state: "cancelled", terminationTarget: null})});
    expect(await cards.get({ kind: "card", cardId: state.record.cardId }).then((delivery) => delivery.presentation.state)).toMatchObject({ mode: "static" });
    get.mockClear(); await cards.open(anotherOpening(state.record)).then((delivery) => delivery.presentation.state);
    expect(get).toHaveBeenCalledOnce(); expect(get).toHaveBeenCalledWith(review.operationId); expect(decide).toHaveBeenCalledOnce();
    const terminal = (await cards.get({ kind: "card", cardId: context.cardId })).presentation.state;
    expect(terminal).toMatchObject({record: {outcome: {kind: "operation"}}});
    if (captured === undefined) throw new Error("The original admitted reply is required.");
    releaseReply();
    const delivery = await pending;
    expect(delivery.result).toEqual(captured);
    expect(captured.state).toBe("starting_connection");
    if ("status" in delivery.presentation) throw new Error("A current terminal presentation must remain available.");
    expect(delivery.presentation.state).toEqual(terminal);
    expect(delivery.presentation.display).toMatchObject({kind: "operation", value: {state: "cancelled"}});
    expect(delivery.presentation.actions).toEqual([]);
    get.mockRejectedValueOnce(new WalletOperationError("runtime_state_unavailable"));
    const withoutDetails = await cards.get({ kind: "card", cardId: context.cardId });
    expect(withoutDetails.presentation.state).toEqual(terminal);
    expect(withoutDetails.presentation.display).toEqual({ kind: "summary" });
    expect(withoutDetails.presentation.actions).toEqual([]);
    } finally {releaseReply(); if (pending !== undefined) await Promise.allSettled([pending]);}
  });
});
