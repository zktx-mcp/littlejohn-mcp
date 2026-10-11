import {PresentationWorkBudget} from "../../src/interfaces/presentation-work.js";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHmac, hkdfSync} from "node:crypto";
import Database from "better-sqlite3";
import {afterEach, describe, expect, it, vi} from "vitest";
import {canonicalJsonStringify, captureCanonicalJson, parseUtcTimestamp, sha256Bytes, fixedIdentifierSchema} from "../../src/core/index.js";
import {parseEvmAccountIdentity, parseEvmChainId} from "../../src/evm/identities.js";
import {ProductDatabase} from "../../src/runtime/database.js";
import {createOwnerInstanceId, createProfileId} from "../../src/runtime/runtime-identity.js";
import {loadOrCreateControlCredential} from "../../src/runtime/control-credential.js";
import {createPresentationPublicationKeyOwner} from "../../src/runtime/presentation-publication-key.js";
import {admitCardRecord, type DecisionCardRecord, type ReadCardRecord} from "../../src/interfaces/mcp-app/card-contract.js";
import {parseWalletReview, parseWalletManagementOperation, walletReviewDigest} from "../../src/wallet/operation-contract.js";
import {walletConnectionDataSchema} from "../../src/wallet/connection-contract.js";
import {walletAccountSelectionContracts} from "../../src/wallet/account-selection-contract.js";
import {tokenCatalogApplicationContracts, createTokenAdditionReviewProjection, parseTokenSelectionReview, tokenSelectionReviewDigest,
  tokenSelectionRevisionSchema, tokenSelectionSetRevisionSchema} from "../../src/token-catalog/contracts.js";
import {createRobinhoodOfficialAssetSourceClient} from "../../src/registry/official-assets.js";
import {createInspectionSuccess} from "../token-catalog/harness.js";
import {McpAppPresentationService, createMcpAppResource} from "../../src/interfaces/mcp-app/server.js";
import {createPresentationSnapshotResource} from "../../src/interfaces/mcp-app/contracts.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const now = parseUtcTimestamp("2026-09-11T00:00:00.000Z");
const chainId = parseEvmChainId("eip155:4663");
const a = parseEvmAccountIdentity({chainId, address: "0x" + "1".repeat(40)});
const b = parseEvmAccountIdentity({chainId, address: "0x" + "2".repeat(40)});
const id = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
const connectionId = "wallet-session:" + id(3);
const json = (value: unknown) => canonicalJsonStringify(captureCanonicalJson(value));
const inputDigest = (value: unknown) => sha256Bytes(new TextEncoder().encode(json(value)));
const rejection = (run: () => unknown): unknown => {try {run();} catch (error) {return error;} throw new Error("An aborted admission must reject.");};
const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), "littlejohn-publication-"));
  const path = join(directory, "product.sqlite3"); const database = await ProductDatabase.open(path, now);
  cleanup.push(async () => {database.close(); await rm(directory, {recursive: true, force: true});});
  database.configuredChainStore().insertConfiguredChainIfAbsent(chainId);
  database.ownerStore().publishOwner(createOwnerInstanceId(), id(7), now);
  return {database, directory, path, store: database.presentationCardStore()};
};
const privateCard = (cardId: string, byte = 1): DecisionCardRecord => {
  const card = admitCardRecord({cardId, kind: "signing", contractVersion: "1", operationId: id(byte), resultDigest: "a".repeat(64), snapshotId: null,
    inputState: "input_pending", closeReason: null, dispatchId: null, expiresAt: "2026-09-11T00:05:00.000Z", outcome: null,
    context: {account: a, method: "personal_sign"}});
  if (card.kind !== "signing") throw new Error("Signing card required."); return card;
};
const createPrivate = (test: Awaited<ReturnType<typeof setup>>, key: string | null = null) => {
  const reserved = test.store.beginCreation("signing", {kind: "signing", source: {kind: "new", input: {}}}, key);
  if (reserved.status !== "reserved") throw new Error("Fresh reservation required.");
  const card = privateCard(reserved.cardId); test.store.commitCreation(reserved.reservation, card); return card;
};
const readInput = tokenCatalogApplicationContracts.selections.parseInput({account: {kind: "address", address: a.address}, limit: 1});
const createRead = (test: Awaited<ReturnType<typeof setup>>, key: string | null = null): ReadCardRecord => {
  const reserved = test.store.beginCreation("read", {capabilityId: "token.selections", input: readInput}, key);
  if (reserved.status !== "reserved") throw new Error("Fresh read reservation required.");
  const record = admitCardRecord({cardId: reserved.cardId, kind: "read", contractVersion: "1", contractId: "token.selections", inputDigest: inputDigest(readInput),
    snapshotId: null, preparationState: "pending", outcome: null});
  if (record.kind !== "read") throw new Error("Read card required.");
  test.store.commitCreation(reserved.reservation, record, undefined, undefined, undefined);
  return record;
};
const snapshotInput = {contractId: "token.selections", contractVersion: "1", normalizedInput: captureCanonicalJson(readInput),
  admittedResult: captureCanonicalJson(tokenCatalogApplicationContracts.selections.parsePublicSuccess(readInput, {account: a, selections: [], nextCursor: null}))};
const connectReview = (operationId: string, revision: string) => {
  const value = {contractVersion: "1", domain: "wallet", kind: "connect", operationId, createdAt: now, actionExpiresAt: "2026-09-11T00:05:00.000Z",
    target: {chainId}, decision: {requiredMethods: ["eth_sendTransaction"], optionalMethods: ["personal_sign", "eth_signTypedData_v4"], requiredEvents: ["accountsChanged", "chainChanged"]},
    precondition: {connectionRevision: revision, connection: {status: "disconnected", reason: "no_session"}}, fixedEvidence: {sessionSourceIds: []}};
  return parseWalletReview({...value, reviewDigest: walletReviewDigest(value)});
};
const reserveWallet = (test: Awaited<ReturnType<typeof setup>>, operationId: string) => {
  const reserved = test.store.beginCreation("wallet", {kind: "wallet", source: {kind: "new", input: {kind: "connect"}}}, id(8));
  if (reserved.status !== "reserved") throw new Error("Fresh reservation required.");
  const prepared = test.database.walletReviewStore().prepare({kind: "connect"}, connectReview(operationId, "1"));
  const snapshot = {contractId: "wallet.connection_change_review", contractVersion: "1", normalizedInput: captureCanonicalJson(prepared.input),
    admittedResult: captureCanonicalJson({status: "review", review: prepared.review})};
  const result = test.database.presentationSnapshotStore().prepare(snapshot);
  if (result.status !== "available") throw new Error("Wallet snapshot required.");
  const card = admitCardRecord({cardId: reserved.cardId, kind: "wallet", contractVersion: "1", operationId,
    resultDigest: result.value.resultDigest, snapshotId: result.value.snapshotId, inputState: "input_pending", closeReason: null, dispatchId: null,
    expiresAt: prepared.review.actionExpiresAt, outcome: null});
  if (card.kind !== "wallet") throw new Error("Wallet card required.");
  return {reserved, prepared, snapshot, card};
};

describe("atomic presentation publication", () => {
  it("derives profile/thread/turn keys in the separate publication HMAC domain", async () => {
    const test = await setup(); const credentialPath = join(test.directory, "control.credential");
    const credential = await loadOrCreateControlCredential(test.directory, credentialPath);
    const profileId = test.database.ownerStore().readProfile().profileId;
    const owner = createPresentationPublicationKeyOwner({credential, profileId});
    const context = {threadId: fixedIdentifierSchema.parse("thread_1"), turnId: fixedIdentifierSchema.parse("turn_1")};
    const secret = Buffer.from((await readFile(credentialPath, "utf8")).trim(), "base64url");
    const key = hkdfSync("sha256", secret, Buffer.alloc(0), Buffer.from("littlejohn/presentation-publication/v1"), 32);
    const expected = createHmac("sha256", Buffer.from(key)).update(JSON.stringify({profileId, threadId: context.threadId, turnId: context.turnId})).digest("base64url");
    expect(owner.derive(context)).toBe(expected);
    expect(owner.derive({...context, turnId: fixedIdentifierSchema.parse("turn_2")})).not.toBe(expected);
    expect(owner.derive({...context, threadId: fixedIdentifierSchema.parse("thread_2")})).not.toBe(expected);
    expect(createPresentationPublicationKeyOwner({credential, profileId: createProfileId()}).derive(context)).not.toBe(expected);
    const reserved = test.store.beginCreation("signing", {}, expected);
    if (reserved.status !== "reserved") throw new Error("Fresh reservation required.");
    const raw = new Database(test.path, {readonly: true});
    try {
      const rows = raw.prepare("SELECT * FROM presentation_publication").all();
      expect(json(rows)).not.toContain(context.threadId); expect(json(rows)).not.toContain(context.turnId); expect(json(rows)).not.toContain(secret.toString("base64url"));
    } finally {raw.close();}
  });

  it("returns one reserved or created identity for racing ordinary publications and independent identities for charts", async () => {
    const test = await setup(); const key = id(8);
    const results = await Promise.all([1, 2].map(value => Promise.resolve().then(() => test.store.beginCreation("signing", {value}, key))));
    expect(results.map(value => value.status)).toEqual(["reserved", "creating"]);
    expect(results[0]!.cardId).toBe(results[1]!.cardId);
    const first = results[0]!; if (first.status !== "reserved") throw new Error("One producer required.");
    test.store.commitCreation(first.reservation, privateCard(first.cardId));
    expect(test.store.beginCreation("signing", {different: true}, key)).toEqual({status: "existing", cardId: first.cardId});
    const chartOne = test.store.beginCreation("read", {chart: 1}, null); const chartTwo = test.store.beginCreation("read", {chart: 2}, null);
    expect(chartOne.cardId).not.toBe(chartTwo.cardId);
    if (chartOne.status === "reserved") test.store.discardCreation(chartOne.reservation);
    if (chartTwo.status === "reserved") test.store.discardCreation(chartTwo.reservation);
  });

  it("retains a creating key on cleanup failure and releases it only after complete rollback cleanup", async () => {
    const test = await setup(); const key = id(8); const creation = test.store.beginCreation("signing", {}, key);
    if (creation.status !== "reserved") throw new Error("Fresh creation required.");
    const raw = new Database(test.path);
    try {
      raw.exec("CREATE TRIGGER refuse_publication_cleanup BEFORE DELETE ON presentation_publication BEGIN SELECT RAISE(ABORT, 'cleanup refused'); END");
      expect(() => test.store.discardCreation(creation.reservation)).toThrow();
      expect(test.store.beginCreation("signing", {}, key)).toEqual({status: "creating", cardId: creation.cardId});
      expect(test.store.read(creation.cardId)).toMatchObject({kind: "preparing", creationState: "creating"});
      raw.exec("DROP TRIGGER refuse_publication_cleanup"); test.store.discardCreation(creation.reservation);
      expect(test.store.read(creation.cardId)).toBeNull();
      const replacement = test.store.beginCreation("signing", {}, key); expect(replacement.status).toBe("reserved"); expect(replacement.cardId).not.toBe(creation.cardId);
      if (replacement.status === "reserved") test.store.discardCreation(replacement.reservation);
    } finally {raw.close();}
  });

  it("releases a failed direct-source admission without consuming healthy pending input", async () => {
    const test = await setup(); const card = createPrivate(test);
    const wrong = test.store.prepareDecision(card, id(2));
    expect(() => test.store.commitDecision(wrong, {kind: "signing", operationId: id(9), resultDigest: card.resultDigest})).toThrow();
    expect(test.store.read(card.cardId)).toEqual(card);
    const retry = test.store.prepareDecision(card, id(3));
    const closed = test.store.commitDecision(retry, {kind: "signing", operationId: card.operationId!, resultDigest: card.resultDigest});
    expect(closed).toMatchObject({inputState: "input_closed", dispatchId: id(3), outcome: null});
    expect(() => test.store.replace(closed, card)).toThrow();
  });

  it("rolls back a prepared Wallet Review, snapshot and publication together and preserves preparation for retry", async () => {
    const test = await setup(); test.database.walletStore().replace("0", {status: "disconnected", reason: "no_session"}, null, null, now, [], []);
    const source = reserveWallet(test, id(1)); const raw = new Database(test.path);
    try {
      raw.exec("CREATE TRIGGER fail_card_commit BEFORE UPDATE ON presentation_card BEGIN SELECT RAISE(ABORT, 'card write refused'); END");
      expect(() => test.store.commitCreation(source.reserved.reservation, source.card, source.snapshot, source.prepared)).toThrow();
      expect(raw.prepare("SELECT count(*) AS count FROM wallet_review").get()).toEqual({count: 0});
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_snapshot").get()).toEqual({count: 0});
      expect(raw.prepare("SELECT stage FROM presentation_publication").get()).toEqual({stage: "creating"});
      expect(test.store.read(source.card.cardId)).toMatchObject({kind: "preparing", creationState: "creating"});
      raw.exec("DROP TRIGGER fail_card_commit");
      expect(test.store.commitCreation(source.reserved.reservation, source.card, source.snapshot, source.prepared)).toEqual(source.card);
      expect(test.database.walletReviewStore().read(source.prepared.review)).toEqual(source.prepared.review);
      expect(() => test.database.walletReviewStore().commit(source.prepared)).toThrow();
      test.store.discardCreation(source.reserved.reservation);
      expect(raw.prepare("SELECT stage FROM presentation_publication").get()).toEqual({stage: "created"});
    } finally {raw.close();}
  });

  it("commits the Wallet pre-effect operation and card closure once and rolls both back on a card write failure", async () => {
    const test = await setup(); test.database.walletStore().replace("0", {status: "disconnected", reason: "no_session"}, null, null, now, [], []);
    const source = reserveWallet(test, id(1)); test.store.commitCreation(source.reserved.reservation, source.card, source.snapshot, source.prepared);
    const operation = parseWalletManagementOperation({contractVersion: "1", domain: "wallet", operationId: id(1), kind: "connect", initiatedBy: "mcp_app",
      review: source.prepared.review, state: "starting_connection", terminationTarget: null, result: null, failure: null, peerRefusalCode: null});
    if (operation.state !== "starting_connection") throw new Error("Active Wallet fixture required.");
    const raw = new Database(test.path);
    try {
      const caller = new AbortController();
      const aborted = test.store.prepareDecision(source.card, id(12), caller.signal);
      caller.abort();
      expect(rejection(() => test.database.walletOperationStore().create(operation, aborted))).toMatchObject({failure: {error: {code: "request_aborted"}}});
      expect(test.database.walletOperationStore().read(id(1))).toBeNull();
      expect(test.store.read(source.card.cardId)).toEqual(source.card);
      test.store.discardDecision(aborted);
      const first = test.store.prepareDecision(source.card, id(2));
      expect(() => test.store.prepareDecision(source.card, id(3))).toThrow();
      raw.exec("CREATE TRIGGER fail_card_commit BEFORE UPDATE ON presentation_card BEGIN SELECT RAISE(ABORT, 'card write refused'); END");
      expect(() => test.database.walletOperationStore().create(operation, first)).toThrow();
      expect(test.database.walletOperationStore().read(id(1))).toBeNull(); expect(test.store.read(source.card.cardId)).toEqual(source.card);
      test.store.discardDecision(first); raw.exec("DROP TRIGGER fail_card_commit");
      const retry = test.store.prepareDecision(source.card, id(4));
      expect(test.database.walletOperationStore().create(operation, retry)).toEqual(operation);
      expect(test.store.read(source.card.cardId)).toMatchObject({inputState: "input_closed", closeReason: "submitted", dispatchId: id(4), outcome: null});
      expect(() => test.store.commitDecision(retry, {kind: "wallet", operationId: id(1), resultDigest: source.card.resultDigest})).toThrow();
      expect(raw.prepare("SELECT count(*) AS count FROM wallet_operation").get()).toEqual({count: 1});
    } finally {raw.close();}
  });

  it("makes selection and the exact card outcome one transaction across two store instances", async () => {
    const test = await setup(); test.database.walletStore().replace("0", walletConnectionDataSchema.parse({status: "connected", connectionId,
      expiresAt: "2026-09-12T00:00:00.000Z", namespaces: [{key: "eip155", accounts: [`${chainId}:${a.address}`, `${chainId}:${b.address}`], methods: [], events: []}]}), null, null, now, [], [connectionId]);
    const input = {chainId}; const initial = walletAccountSelectionContracts.get.parsePublicSuccess(input,
      {connectionId, connectionRevision: "1", chainId, selectionRevision: "0", account: null, eligibleAccounts: [a, b]});
    const snapshot = {contractId: "wallet.account_selection", contractVersion: "1", normalizedInput: captureCanonicalJson(input), admittedResult: captureCanonicalJson(initial)};
    const prepared = test.database.presentationSnapshotStore().prepare(snapshot); if (prepared.status !== "available") throw new Error("Selection snapshot required.");
    const reserved = test.store.beginCreation("wallet_selection", {kind: "wallet_selection", source: {kind: "new", input}}, id(8));
    if (reserved.status !== "reserved") throw new Error("Selection reservation required.");
    const card = admitCardRecord({cardId: reserved.cardId, kind: "wallet_selection", contractVersion: "1", operationId: null,
      resultDigest: prepared.value.resultDigest, snapshotId: prepared.value.snapshotId, expiresAt: null, inputState: "input_pending", closeReason: null, dispatchId: null, outcome: null,
      context: {connectionId, chainId, originalConnectionRevision: "1"}});
    if (card.kind !== "wallet_selection") throw new Error("Selection card required."); test.store.commitCreation(reserved.reservation, card, snapshot);
    const second = await ProductDatabase.open(test.path, now); cleanup.push(async () => {second.close();});
    const firstAdmission = test.store.prepareDecision(card, id(2)); const secondAdmission = second.presentationCardStore().prepareDecision(card, id(3));
    const action = walletAccountSelectionContracts.select.parseInput({connectionId, chainId, account: b, expectedConnectionRevision: "1", expectedSelectionRevision: "0"});
    const raw = new Database(test.path);
    try {
      // The first store has no live competing admission while this independent guard is checked.
      test.store.discardDecision(firstAdmission);
      const caller = new AbortController(); const aborted = test.store.prepareDecision(card, id(12), caller.signal);
      caller.abort();
      expect(rejection(() => test.database.walletStore().selectAccount(action, aborted))).toMatchObject({failure: {error: {code: "request_aborted"}}});
      expect(test.database.walletStore().readPreference(chainId)).toMatchObject({account: null, selectionRevision: "0"});
      expect(test.store.read(card.cardId)).toEqual(card); test.store.discardDecision(aborted);
      const failed = test.store.prepareDecision(card, id(2));
      raw.exec("CREATE TRIGGER fail_card_commit BEFORE UPDATE ON presentation_card BEGIN SELECT RAISE(ABORT, 'card write refused'); END");
      expect(() => test.database.walletStore().selectAccount(action, failed)).toThrow();
      expect(test.database.walletStore().readPreference(chainId)).toMatchObject({account: null, selectionRevision: "0"});
      expect(test.store.read(card.cardId)).toEqual(card); test.store.discardDecision(failed);
      raw.exec("DROP TRIGGER fail_card_commit");
      const completedCaller = new AbortController();
      const retry = test.store.prepareDecision(card, id(4), completedCaller.signal); const selected = test.database.walletStore().selectAccount(action, retry);
      completedCaller.abort();
      expect(selected).toMatchObject({account: b, selectionRevision: "1"});
      expect(test.store.read(card.cardId)).toMatchObject({inputState: "input_closed", closeReason: "submitted", dispatchId: id(4), outcome: {kind: "wallet_selection", value: selected}});
      expect(() => second.walletStore().selectAccount({...action, account: a}, secondAdmission)).toThrow();
      second.presentationCardStore().discardDecision(secondAdmission);
      expect(test.database.walletStore().readPreference(chainId)).toMatchObject({account: b, selectionRevision: "1"});
    } finally {raw.close();}
  });

  it("settles old-generation creation and read reservations without rerunning their producers", async () => {
    const test = await setup(); const keyed = test.store.beginCreation("signing", {}, id(8)); const chart = test.store.beginCreation("read", {}, null);
    const read = createRead(test); test.database.close();
    const reopened = await ProductDatabase.open(test.path, now); cleanup.push(async () => {reopened.close();});
    reopened.ownerStore().publishOwner(createOwnerInstanceId(), id(7), now);
    expect(reopened.presentationCardStore().read(keyed.cardId)).toMatchObject({kind: "preparing", creationState: "owner_lost"});
    expect(reopened.presentationCardStore().read(chart.cardId)).toMatchObject({kind: "preparing", creationState: "owner_lost"});
    expect(reopened.presentationCardStore().read(read.cardId)).toMatchObject({kind: "read", preparationState: "failed", outcome: {kind: "failure", failureCode: "runtime_state_unavailable"}});
    expect(reopened.presentationCardStore().beginCreation("signing", {}, id(8))).toEqual({status: "existing", cardId: keyed.cardId});
  });

  it("atomically commits the exact completed snapshot with its pending read card", async () => {
    const test = await setup(); const read = createRead(test); const raw = new Database(test.path);
    try {
      raw.exec("CREATE TRIGGER fail_card_commit BEFORE UPDATE ON presentation_card BEGIN SELECT RAISE(ABORT, 'card write refused'); END");
      expect(() => test.store.completeRead(read, snapshotInput)).toThrow();
      expect(raw.prepare("SELECT count(*) AS count FROM presentation_snapshot").get()).toEqual({count: 0});
      expect(test.store.read(read.cardId)).toEqual(read);
      raw.exec("DROP TRIGGER fail_card_commit");
      const completed = test.store.completeRead(read, snapshotInput);
      expect(completed.preparationState).toBe("completed");
      expect(test.database.presentationSnapshotStore().read(completed.snapshotId!)).toMatchObject({status: "available", value: {inputDigest: read.inputDigest}});
      expect(() => test.store.completeRead(read, snapshotInput)).toThrow();
    } finally {raw.close();}
  });

  it("bounds only unsettled read reservations and releases them exactly once", () => {
    const work = new PresentationWorkBudget();
    const permits = Array.from({length: 63}, () => work.reserveRead(65_536));
    expect(() => work.reserveRead(65_536)).toThrow("busy");
    permits[0]!.release();
    const next = work.reserveRead(65_536); next.release();
    for (const permit of permits) permit.release();
    work.reserveRead(65_536).release();
  });

  it("rejects a retained Wallet Review before the model part can read its bytes", async () => {
    const test = await setup();
    test.database.walletStore().replace("0", {status: "disconnected", reason: "no_session"}, null, null, now, [], []);
    const source = reserveWallet(test, id(1));
    test.store.commitCreation(source.reserved.reservation, source.card, source.snapshot, source.prepared);
    const store = test.database.presentationSnapshotStore();
    const readResultChunk = vi.fn(store.readResultChunk);
    const service = new McpAppPresentationService({...store, readResultChunk}, createMcpAppResource("<!doctype html><title>Unused</title>"),
      {read: async () => {throw new Error("A stored source never reads live Review material.");}});
    const metadata = store.readMetadata(source.card.snapshotId!);
    if (metadata.status !== "available") throw new Error("A committed, admitted private source is required.");
    const uri = createPresentationSnapshotResource(metadata.value, captureCanonicalJson({kind: "connect"})).descriptor.snapshotUri;
    await expect(service.getResultPart({snapshotUri: uri, index: 0, partIndex: 0})).rejects.toThrow("Only exact immutable data");
    expect(readResultChunk).not.toHaveBeenCalled();
  });

  it("admits closed history at startup but rejects a corrupt publication at its exact lookup", async () => {
    const test = await setup(); const creation = test.store.beginCreation("signing", {}, id(8));
    test.database.close(); const raw = new Database(test.path);
    try {raw.prepare("UPDATE presentation_publication SET stage = 'created'").run();} finally {raw.close();}
    const reopened = await ProductDatabase.open(test.path, now); cleanup.push(async () => {reopened.close();});
    reopened.ownerStore().publishOwner(createOwnerInstanceId(), id(7), now);
    expect(() => reopened.presentationCardStore().read(creation.cardId)).toThrow("unavailable");
    expect(() => reopened.presentationCardStore().beginCreation("signing", {}, id(8))).toThrow("unavailable");
  });

  it("commits Token Review creation and its selection mutation with the card in the same product database", async () => {
    const test = await setup(); const inspection = await createInspectionSuccess();
    const official = await createRobinhoodOfficialAssetSourceClient({fetch: (async () => new Response(JSON.stringify({assets: [{id: "0x" + "11".repeat(32), status: "ASSET_STATUS_ACTIVE", deployments: [{chainId: 4663, contractAddress: "0x" + "56".repeat(20)}], tokenName: "Other Stock Token", tokenSymbol: "OTHER"}]}), {status: 200, headers: {"content-type": "application/json"}})) as typeof fetch,
      now: () => new Date(now)}).read(new AbortController().signal);
    if (official.status !== "observed") throw new Error("Official observation required.");
    const officialSnapshot = test.database.officialAssetSnapshotStore().replaceSnapshot(official.observation, null);
    const input = tokenCatalogApplicationContracts.selectionChangeReview.parseInput({kind: "add", account: {kind: "address", address: a.address}, asset: inspection.data.asset});
    const fields = {contractVersion: "1", domain: "token_selection", operationId: id(5), kind: "add", createdAt: now, actionExpiresAt: "2026-09-11T00:05:00.000Z",
      target: {account: a, asset: inspection.data.asset}, precondition: {accountTarget: {kind: "address"}, previousSelection: null, selectionSetRevision: null},
      ...createTokenAdditionReviewProjection({inspection, officialSnapshotRevision: officialSnapshot.revision, officialMember: null, officialVerification: null})};
    const review = parseTokenSelectionReview({...fields, reviewDigest: tokenSelectionReviewDigest(fields)});
    const token = test.database.tokenCatalogStore().prepareReviewSource(input, {review});
    const snapshot = {contractId: "token.selection_change_review", contractVersion: "1", normalizedInput: captureCanonicalJson(input), admittedResult: captureCanonicalJson({review})};
    const prepared = test.database.presentationSnapshotStore().prepare(snapshot); if (prepared.status !== "available") throw new Error("Token snapshot required.");
    const reservation = test.store.beginCreation("token_selection", {kind: "token_selection", source: {kind: "new", input: captureCanonicalJson(input)}}, id(8));
    if (reservation.status !== "reserved") throw new Error("Token reservation required.");
    const card = admitCardRecord({cardId: reservation.cardId, kind: "token_selection", contractVersion: "1", operationId: id(5), resultDigest: prepared.value.resultDigest,
      snapshotId: prepared.value.snapshotId, inputState: "input_pending", closeReason: null, dispatchId: null, expiresAt: review.actionExpiresAt, outcome: null});
    if (card.kind !== "token_selection") throw new Error("Token card required.");
    test.store.commitCreation(reservation.reservation, card, snapshot, undefined, token);
    expect(test.database.tokenCatalogStore().readReviewSource(id(5))).toEqual({input, result: {review}});
    const action = {action: {review, initiatedBy: "mcp_app" as const}, walletAdmission: null,
      selectionRevision: tokenSelectionRevisionSchema.parse(Buffer.alloc(16, 1).toString("base64url")), selectionSetRevision: tokenSelectionSetRevisionSchema.parse(Buffer.alloc(16, 2).toString("base64url")),
      inspection, officialVerification: null, completedAt: parseUtcTimestamp("2026-09-11T00:00:01.000Z")};
    const failed = test.store.prepareDecision(card, id(6)); const raw = new Database(test.path);
    try {
      test.store.discardDecision(failed);
      const caller = new AbortController(); const aborted = test.store.prepareDecision(card, id(12), caller.signal);
      caller.abort();
      expect(rejection(() => test.database.tokenCatalogStore().applySelectionChange({...action, cardAdmission: aborted}))).toMatchObject({failure: {error: {code: "request_aborted"}}});
      for (const table of ["account", "account_token_selection_state", "account_token_selection", "token_contract_inspection", "token_selection_operation"]) {
        expect(raw.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({count: 0});
      }
      expect(test.store.read(card.cardId)).toEqual(card); test.store.discardDecision(aborted);
      const failedWrite = test.store.prepareDecision(card, id(6));
      raw.exec("CREATE TRIGGER fail_card_commit BEFORE UPDATE ON presentation_card BEGIN SELECT RAISE(ABORT, 'card write refused'); END");
      expect(() => test.database.tokenCatalogStore().applySelectionChange({...action, cardAdmission: failedWrite})).toThrow();
      expect(raw.prepare("SELECT count(*) AS count FROM token_selection_operation").get()).toEqual({count: 0});
      expect(raw.prepare("SELECT count(*) AS count FROM account_token_selection").get()).toEqual({count: 0});
      expect(raw.prepare("SELECT count(*) AS count FROM token_contract_inspection").get()).toEqual({count: 0});
      expect(test.store.read(card.cardId)).toEqual(card); test.store.discardDecision(failedWrite); raw.exec("DROP TRIGGER fail_card_commit");
    } finally {raw.close();}
    const admission = test.store.prepareDecision(card, id(6));
    const operation = test.database.tokenCatalogStore().applySelectionChange({...action, cardAdmission: admission});
    expect(operation.result.selection.selection).toMatchObject({account: a, asset: inspection.data.asset, included: true});
    expect(test.store.read(card.cardId)).toMatchObject({inputState: "input_closed", closeReason: "submitted", dispatchId: id(6), outcome: {kind: "operation"}});
  });
});
