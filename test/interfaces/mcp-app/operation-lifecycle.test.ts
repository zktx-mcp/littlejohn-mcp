import {PresentationWorkBudget} from "../../../src/interfaces/presentation-work.js";
import {mkdtemp, rm} from "node:fs/promises";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import {canonicalJsonStringify, captureCanonicalJson, createCanonicalClock, parseUtcTimestamp} from "../../../src/core/index.js";
import {createOwnerInstanceId} from "../../../src/runtime/runtime-identity.js";
import {ProductDatabase} from "../../../src/runtime/database.js";
import {PresentationCardApplication} from "../../../src/interfaces/mcp-app/card-application.js";
import {cardControlContracts, cardPresentationMetadataKey, presentationCardMetadataKey, serializeCardActionPresentation, type CardRecord} from "../../../src/interfaces/mcp-app/card-contract.js";
import {cardToolContracts} from "../../../src/interfaces/mcp-app/card-tool-contracts.js";
import {operationToolContracts} from "../../../src/interfaces/operation-tool-contracts.js";
import {walletAccountToolContracts} from "../../../src/interfaces/wallet-account-tool-contracts.js";
import {withCardReference} from "../../../src/interfaces/mcp-app/server.js";
import {canonicalBase64FromBytes, createWalletOperationQrMetadata, snapshotIdFromUri, walletOperationQrMetadataKey} from "../../../src/interfaces/mcp-app/contracts.js";
import {mountCard, createCardOpenRequestId} from "../../../src/interfaces/mcp-app/view/card-lifecycle.js";
import {admitPresentationToolResult, type PresentationViewApp} from "../../../src/interfaces/mcp-app/view/lifecycle.js";
import {readWalletReviewTargets} from "../../../src/interfaces/mcp-app/view/operation-lifecycle.js";
import {createPresentationSnapshot} from "../../../src/runtime/presentation-snapshot-server.js";
import {presentationSnapshotLimits} from "../../../src/runtime/presentation-snapshot.js";
import {CardDomainError, type CardDomains} from "../../../src/interfaces/mcp-app/card-sources.js";
import {CardError} from "../../../src/interfaces/mcp-app/card-errors.js";
import {parseWalletManagementOperation, parseWalletReview, walletReviewDigest, type WalletNonterminalManagementOperation, type WalletManagementOperation} from "../../../src/wallet/contracts.js";
import {walletAccountSelectionSchema} from "../../../src/wallet/account-selection-contract.js";
import {walletConnectionDataSchema} from "../../../src/wallet/connection-contract.js";
import {walletDisconnectTargetSchema} from "../../../src/wallet/operation-contract.js";
import {evmAccountIdentitySchema} from "../../../src/evm/identities.js";
import {WalletOperationError, createWalletFailure} from "../../../src/wallet/operation-error.js";
import {normalizeWalletError} from "../../../src/wallet/errors.js";
import {stockTokenTradeHistoryUnavailableFixture} from "../stock-token-trade-history-fixture.js";

const createdAt = "2026-08-12T00:00:00.000Z";
const operationId = Buffer.alloc(32, 17).toString("base64url");
const connectionId = `wallet-session:${"A".repeat(43)}`;
const chainId = "eip155:4663";
const accounts = ["11", "22"].map((part) => evmAccountIdentitySchema.parse({chainId, address: `0x${part.repeat(20)}`}));
const connection = walletConnectionDataSchema.parse({status: "connected", connectionId, expiresAt: "2026-08-13T00:00:00.000Z",
  namespaces: [{key: "eip155", accounts: accounts.map((account) => `${chainId}:${account.address}`),
    methods: ["eth_sendTransaction"], events: ["accountsChanged", "chainChanged"]}]});
const qr = {size: 21, rows: Array.from({length: 21}, (_, index) => index === 0 ? `1${"0".repeat(20)}` : "0".repeat(21))};
const cleanup: (() => Promise<void>)[] = [];
const {JSDOM} = createRequire(import.meta.url)("jsdom") as {JSDOM: new (html: string) => {window: Pick<Window, "document" | "close"> & {HTMLElement: typeof HTMLElement; Event: typeof Event}}};
let dom: InstanceType<typeof JSDOM>;
beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(new Date(createdAt)); dom = new JSDOM("<!doctype html><body></body>");
  vi.stubGlobal("document", dom.window.document); vi.stubGlobal("HTMLElement", dom.window.HTMLElement); vi.stubGlobal("Event", dom.window.Event);});
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); dom.window.close(); vi.unstubAllGlobals(); vi.useRealTimers();});
const unexpected = async (): Promise<never> => {throw new Error("Unexpected domain call.");};
const reply = (value: unknown, metadata: Record<string, unknown> = {}): CallToolResult => ({content: [],
  structuredContent: captureCanonicalJson(value) as Record<string, unknown>, _meta: metadata});

const fixture = async (kind: "wallet" | "wallet_selection" | "read" = "wallet", options: {mount?: boolean; lostOpening?: boolean; lostAction?: boolean; badQr?: boolean; unavailableChunks?: boolean; actionFailure?: "wallet_session_unusable" | "walletconnect_unavailable"; review?: import("../../../src/wallet/contracts.js").WalletReview; snapshots?: readonly import("../../../src/runtime/presentation-snapshot.js").PresentationSnapshotRecord[]} = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "littlejohn-view-card-"));
  const database = await ProductDatabase.open(join(directory, "product.sqlite3"), parseUtcTimestamp(createdAt));
  database.ownerStore().publishOwner(createOwnerInstanceId(), Buffer.alloc(32, 7).toString("base64url"), parseUtcTimestamp(createdAt));
  database.configuredChainStore().insertConfiguredChainIfAbsent(accounts[0]!.chainId);
  const walletStore = database.walletStore();
  const initial = walletStore.read();
  const observedSources = options.review?.kind === "disconnect" ? (options.review.precondition.targetSet.kind === "inline"
    ? options.review.precondition.targetSet.targets.map((target) => target.sourceId)
    : (options.snapshots ?? []).filter((snapshot) => snapshot.contractId === "wallet.disconnect_target")
      .map((snapshot) => walletDisconnectTargetSchema.parse(JSON.parse(new TextDecoder().decode(snapshot.resultBytes))).sourceId)).sort()
    : kind === "wallet_selection" ? [connectionId] : [];
  const initialConnection = walletConnectionDataSchema.parse(kind === "wallet_selection" ? connection : options.review?.kind === "disconnect"
    ? {status: "unresolved", sessionCount: "2"} : {status: "disconnected", reason: "no_session"});
  walletStore.replace(initial.revision, initialConnection, null, null, parseUtcTimestamp(createdAt), [], observedSources);
  const current = walletStore.read();
  const unsigned = {contractVersion: "1", domain: "wallet", kind: "connect", operationId, createdAt,
    actionExpiresAt: "2026-08-12T00:05:00.000Z", target: {chainId},
    decision: {requiredMethods: ["eth_sendTransaction"], optionalMethods: ["personal_sign", "eth_signTypedData_v4"], requiredEvents: ["accountsChanged", "chainChanged"]},
    precondition: {connectionRevision: current.revision, connection: {status: "disconnected", reason: "no_session"}}, fixedEvidence: {sessionSourceIds: []}};
  const review = options.review ?? parseWalletReview({...unsigned, reviewDigest: walletReviewDigest(unsigned)});
  for (const snapshot of options.snapshots ?? []) {
    const committed = database.presentationSnapshotStore().commit({contractId: snapshot.contractId, contractVersion: snapshot.contractVersion,
      normalizedInput: JSON.parse(new TextDecoder().decode(snapshot.inputBytes)), admittedResult: JSON.parse(new TextDecoder().decode(snapshot.resultBytes))});
    if (committed.status !== "available" || committed.value.snapshotId !== snapshot.snapshotId) throw new Error("Exact fixture snapshot required.");
  }
  const reviews = database.walletReviewStore();
  const operations = database.walletOperationStore();
  const prepareReview = vi.fn(async () => ({status: "review" as const, prepared: reviews.prepare({kind: review.kind}, review)}));
  const decide = vi.fn(async (input: Parameters<CardDomains["wallet"]["decide"]>[0], admission?: Parameters<CardDomains["wallet"]["decide"]>[1]) => {
    const value = parseWalletManagementOperation({contractVersion: "1", domain: "wallet", kind: input.review.kind, operationId,
      initiatedBy: input.initiatedBy, review: input.review, state: input.review.kind === "connect" ? "awaiting_wallet_approval" : "disconnecting", terminationTarget: null,
      result: null, failure: null, peerRefusalCode: null}) as WalletNonterminalManagementOperation;
    const created = operations.create(value, admission);
    return options.actionFailure === undefined ? created : transition(parseWalletManagementOperation({
      ...created, state: "failed", failure: createWalletFailure(options.actionFailure),
    }));
  });
  const get = vi.fn(async (id: string) => {const value = operations.read(id); if (value === null) throw new WalletOperationError("wallet_operation_not_found"); return value;});
  const transition = (next: WalletManagementOperation) => {
    const before = operations.read(next.operationId);
    if (before === null || before.state === "completed") throw new Error("Active operation required.");
    return operations.transition({operationId: next.operationId, reviewDigest: before.review.reviewDigest,
      connectionRevision: before.review.precondition.connectionRevision, expectedState: before.state as WalletNonterminalManagementOperation["state"], operation: next});
  };
  const cancel = vi.fn(async () => transition(parseWalletManagementOperation({...operations.read(operationId), state: "cancelled"})));
  const getAccountSelection = vi.fn(async () => {
    const state = walletStore.read(); const preference = walletStore.readPreference(accounts[0]!.chainId);
    if (state.connection.status !== "connected") throw new WalletOperationError("wallet_not_connected");
    return walletAccountSelectionSchema.parse({connectionId: state.connection.connectionId, connectionRevision: state.revision, chainId,
      selectionRevision: preference.selectionRevision, account: preference.account, eligibleAccounts: accounts});
  });
  const selectAccount = vi.fn(async (input: Parameters<CardDomains["wallet"]["selectAccount"]>[0], _signal?: AbortSignal, admission?: Parameters<CardDomains["wallet"]["selectAccount"]>[2]) => walletStore.selectAccount(input, admission));
  let chunkFailure = options.unavailableChunks ?? false;
  let controlFailure = false;
  let lostOpening = options.lostOpening ?? false;
  let readResolve!: (value: ReturnType<typeof stockTokenTradeHistoryUnavailableFixture>) => void;
  const readPending = new Promise<ReturnType<typeof stockTokenTradeHistoryUnavailableFixture>>((resolve) => {readResolve = resolve;});
  const readExecution = vi.fn(async () => captureCanonicalJson(await readPending));
  const cards = new PresentationCardApplication({work: new PresentationWorkBudget(),ownerSignal: new AbortController().signal, clock: createCanonicalClock(() => new Date().toISOString()),
    store: database.presentationCardStore(), snapshots: database.presentationSnapshotStore(), reviews: {readPresentation: () => {throw new Error("No private source is required.");}}, readExecution: {execute: readExecution}, domains: {
      wallet: {prepareReview, discardPreparedReview: reviews.discard, getReviewSource: (id) => {const source = reviews.get(id); return {input: source.input, result: {status: "review", review: source.review}};},
        review: unexpected, decide, get, cancel, getAccountSelection, selectAccount, getPresentation: async (id) => {const operation = await get(id); return {operation, ...(operation.state === "awaiting_wallet_approval" ? {qr} : {})};}},
      token: {prepareReview: unexpected, discardPreparedReview: () => {}, getReviewSource: () => {throw new Error("Unexpected Token source.");}, review: unexpected, decide: unexpected, getOperation: () => {throw new Error("Unexpected Token operation.");}},
      signing: {prepareConfirm: unexpected, start: unexpected, confirm: unexpected, get: () => {throw new Error("Unexpected signing source.");}, cancel: () => {throw new Error("Unexpected signing cancellation.");}},
      exchange: {prepareConfirm: unexpected, start: unexpected, confirm: unexpected, get: () => {throw new Error("Unexpected transaction source.");}, cancel: () => {throw new Error("Unexpected transaction cancellation.");}},
    }});
  const created = kind === "read" ? await cards.startRead({capabilityId: "market.stock_token_trade_history", input: {symbol: "AAPL", period: {count: 1, unit: "day"}}}, new AbortController().signal)
    : await cards.startDecision({kind, source: {kind: "new", input: kind === "wallet" ? {kind: review.kind} : {chainId}}}, new AbortController().signal);
  const creating = withCardReference(reply(created, {[presentationCardMetadataKey]: {kind: "card", cardId: created.cardId}}));
  const calls = vi.fn(async (request: {name: string; arguments?: Record<string, unknown>}, config?: {signal?: AbortSignal}): Promise<CallToolResult> => {
    const key = (Object.keys(cardToolContracts) as (keyof typeof cardToolContracts)[]).find((key) => request.name === cardToolContracts[key].mcp.name);
    if (key !== undefined) {
      if (controlFailure) return {...reply(createWalletFailure("runtime_state_unavailable")), isError: true};
      const input = cardControlContracts[key].parseInput(request.arguments);
      const delivery = key === "read" ? await cards.get(input) : key === "open" ? await cards.open(input) : key === "discard" ? await cards.cancelDecision(input) : await cards.cancelWait(input);
      if (key === "open" && lostOpening) {lostOpening = false; throw new Error("Opening reply lost.");}
      return reply(delivery.presentation, delivery.qr === undefined ? {} : {[walletOperationQrMetadataKey]: delivery.qr});
    }
    if (request.name === "presentation_get_snapshot_chunk") {
      if (chunkFailure) return reply({kind: "presentation_unavailable", status: "unavailable", reason: "snapshot_missing"});
      const chunk = database.presentationSnapshotStore().readResultChunk({snapshotId: snapshotIdFromUri(request.arguments?.["snapshotUri"]), index: request.arguments?.["index"] as number});
      if (chunk.status !== "available") throw new Error("Exact saved chunk is required.");
      return reply({kind: "presentation_snapshot_chunk", snapshotId: chunk.value.snapshotId, index: chunk.value.index, canonicalBase64: canonicalBase64FromBytes(chunk.value.bytes)});
    }
    const walletAction = review.kind === "connect" ? operationToolContracts.walletConnect : operationToolContracts.walletDisconnect;
    if (request.name !== walletAction.mcp.name && request.name !== walletAccountToolContracts.select.mcp.name) throw new Error("No unrelated call is allowed.");
    try {
      const input = request.arguments!;
      const delivery = await cards.action({cardId: input["cardId"], cardOpenRequestId: input["cardOpenRequestId"]}, input["decision"], config?.signal ?? new AbortController().signal);
      if (options.lostAction) throw new Error("Admitted action reply lost.");
      const metadata: Record<string, unknown> = {[cardPresentationMetadataKey]: serializeCardActionPresentation(delivery.presentation)};
      if (delivery.qr !== undefined) metadata[walletOperationQrMetadataKey] = options.badQr ? {...delivery.qr, resultSha256: "0".repeat(64)} : delivery.qr;
      return reply(delivery.result, metadata);
    } catch (error) {
      if (options.lostAction) throw error;
      const failure = error instanceof CardError || error instanceof CardDomainError ? error.failure : normalizeWalletError(error).failure;
      return {...reply(failure), isError: true};
    }
  });
  const app = {getHostCapabilities: () => ({serverTools: {}}), getHostVersion: () => ({name: "standard", version: "1"}), callServerTool: calls, readServerResource: unexpected};
  const controllers: AbortController[] = [];
  const mount = async (root: HTMLElement = document.body) => {
    if (root === document.body) controllers.forEach((controller) => controller.abort());
    const controller = new AbortController(); controllers.push(controller);
    const admitted = await admitPresentationToolResult(app, creating, controller.signal);
    if (admitted.status !== "card") throw new Error("Card acknowledgement required.");
    await mountCard(app, admitted.card, createCardOpenRequestId(), root, controller.signal);
  };
  const stored = (): CardRecord | null => database.presentationCardStore().read(created.cardId);
  cleanup.push(async () => {controllers.forEach((controller) => controller.abort()); readResolve(stockTokenTradeHistoryUnavailableFixture()); await cards.close(); database.close(); await rm(directory, {recursive: true, force: true});});
  if (options.mount !== false) await mount();
  return {database, cards, created, creating, stored, calls, decide, review, prepareReview, selectAccount, cancel, mount, accounts, getAccountSelection, readExecution,
    controlsFailed: (value: boolean) => {controlFailure = value;}, chunksFailed: (value: boolean) => {chunkFailure = value;}, completeRead: () => readResolve(stockTokenTradeHistoryUnavailableFixture()),
    changePreference: () => {const state = walletStore.read(); const preference = walletStore.readPreference(accounts[0]!.chainId); return walletStore.selectAccount({connectionId, chainId: accounts[0]!.chainId,
      account: accounts[1]!, expectedConnectionRevision: state.revision, expectedSelectionRevision: preference.selectionRevision});},
    changeConnection: () => {if (connection.status !== "connected") throw new Error("Connected fixture required."); const state = walletStore.read(); walletStore.replace(state.revision, {...connection, expiresAt: parseUtcTimestamp("2026-08-14T00:00:00.000Z")}, null, null, parseUtcTimestamp(createdAt), [], [connectionId]);},
    complete: () => {const state = walletStore.read(); const connected = walletStore.replace(state.revision, connection, null, null, parseUtcTimestamp(createdAt), [], [connectionId]);
      return transition(parseWalletManagementOperation({...operations.read(operationId), state: "completed", result: {kind: "connected", connectionId, connectionRevision: connected.revision}}));},
    fail: () => transition(parseWalletManagementOperation({...operations.read(operationId), state: "failed", failure: createWalletFailure("wallet_pairing_code_unavailable")})),
    accept: () => [...document.querySelectorAll("button")].find((button) => button.textContent === (review.kind === "connect" ? "Connect wallet" : "Disconnect wallet"))!.click(),
    choose: () => {const select = document.querySelector("select")!; select.value = `${chainId}:${accounts[0]!.address}`; select.dispatchEvent(new Event("change", {bubbles: true}));
      [...document.querySelectorAll("button")].find((button) => button.textContent === "Select account")!.click();},
  };
};

describe("card View source and input lifecycle", () => {
  it("opens the same immutable decision in multiple Views without closing input or constructing another Review", async () => {
    const test = await fixture(); const before = test.stored();
    await test.mount();
    expect(test.stored()).toEqual(before); expect(before).toMatchObject({inputState: "input_pending", closeReason: null});
    expect(document.body.textContent).toContain("Choose an action"); expect(test.prepareReview).toHaveBeenCalledOnce(); expect(test.decide).not.toHaveBeenCalled();
  });
  it("keeps input closed while the original Wallet operation remains pending, restores its private QR on remount, and settles once", async () => {
    const test = await fixture(); test.accept();
    await vi.waitFor(() => expect(document.querySelector("svg")).not.toBeNull());
    expect(test.stored()).toMatchObject({inputState: "input_closed", closeReason: "submitted", outcome: null});
    await test.mount(); expect(document.querySelector("svg")).not.toBeNull(); expect(document.body.textContent).toContain("Waiting for approval");
    expect(document.body.textContent).toContain(chainId);
    expect(document.body.textContent).toContain("does not transfer assets");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Connect wallet")).toBe(false);
    expect(JSON.stringify(test.stored())).not.toContain('"rows"');
    test.complete(); await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Wallet connected"));
    expect(document.querySelector("svg")).toBeNull(); expect(test.stored()).toMatchObject({inputState: "input_closed", outcome: {kind: "operation"}});
    const calls = test.calls.mock.calls.length; await vi.advanceTimersByTimeAsync(2000); expect(test.calls).toHaveBeenCalledTimes(calls);
    await test.mount(); expect(document.body.textContent).toContain("Wallet connected"); expect(document.body.textContent).toContain(chainId);
    expect(test.prepareReview).toHaveBeenCalledOnce(); expect(test.decide).toHaveBeenCalledOnce();
  });
  it("rejects an uncorrelated QR while preserving the admitted operation", async () => {
    const test = await fixture("wallet", {badQr: true}); test.accept();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Waiting for approval"));
    expect(document.querySelector("svg")).toBeNull(); expect(test.decide).toHaveBeenCalledOnce();
  });
  it.each([
    ["wallet_session_unusable", "The WalletConnect session cannot satisfy this request."],
    ["walletconnect_unavailable", "WalletConnect could not complete the wallet action."],
  ] as const)("retains an immediate %s connection failure and its original requested scope on remount", async (code, message) => {
    const test = await fixture("wallet", {actionFailure: code}); test.accept();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Connection request failed"));
    const terminal = test.stored();
    expect(terminal).toMatchObject({inputState: "input_closed", closeReason: "submitted", outcome: {kind: "operation"}});
    const assertResult = () => {
      expect(document.body.textContent).toContain(code);
      expect(document.body.textContent).toContain(message);
      expect(document.body.textContent).toContain(chainId);
      expect(document.body.textContent).toContain("eth_sendTransaction");
      expect(document.body.textContent).toContain("personal_sign, eth_signTypedData_v4");
      expect(document.body.textContent).toContain("accountsChanged, chainChanged");
      expect(document.body.textContent).toContain(operationId);
      expect(document.body.textContent).not.toContain("Wallet connected");
      expect(document.querySelectorAll("button, svg")).toHaveLength(0);
      if (code === "wallet_session_unusable") expect(document.body.textContent).toContain(
        "If a session remains, disconnect it, then connect again to request the missing permissions.");
      else expect(document.body.textContent).not.toContain("missing permissions");
    };
    assertResult();
    await test.mount(); assertResult();
    expect(test.stored()).toEqual(terminal);
    expect(test.database.walletReviewStore().get(operationId).review).toEqual(test.review);
    expect(test.prepareReview).toHaveBeenCalledOnce(); expect(test.decide).toHaveBeenCalledOnce(); expect(test.cancel).not.toHaveBeenCalled();
  });
  it("removes active QR and controls when the saved original connection fails, then reopens that same terminal source", async () => {
    const test = await fixture(); test.accept();
    await vi.waitFor(() => expect(document.querySelector("svg")).not.toBeNull());
    test.fail(); await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Connection request failed"));
    const terminal = test.stored();
    expect(terminal).toMatchObject({inputState: "input_closed", outcome: {kind: "operation"}});
    expect(document.body.textContent).toContain("wallet_pairing_code_unavailable");
    expect(document.body.textContent).toContain("The wallet pairing code could not be created.");
    expect(document.body.textContent).not.toContain("missing permissions");
    expect(document.querySelectorAll("button, svg")).toHaveLength(0);
    const calls = test.calls.mock.calls.length; await vi.advanceTimersByTimeAsync(2000); expect(test.calls).toHaveBeenCalledTimes(calls);
    await test.mount();
    expect(document.body.textContent).toContain("Connection request failed");
    expect(document.body.textContent).toContain("wallet_pairing_code_unavailable");
    expect(document.body.textContent).toContain("The wallet pairing code could not be created.");
    expect(document.body.textContent).toContain(chainId); expect(document.body.textContent).toContain("eth_sendTransaction");
    expect(document.querySelectorAll("button, svg")).toHaveLength(0);
    expect(test.stored()).toEqual(terminal); expect(test.database.walletReviewStore().get(operationId).review).toEqual(test.review);
    expect(test.prepareReview).toHaveBeenCalledOnce(); expect(test.decide).toHaveBeenCalledOnce(); expect(test.cancel).not.toHaveBeenCalled();
  });
  it("retries a lost opening with the same correlation without changing the decision", async () => {
    const test = await fixture("wallet", {lostOpening: true}); const before = test.stored();
    expect(document.querySelector("button")?.textContent).toBe("Retry opening");
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Choose an action"));
    const inputs = test.calls.mock.calls.filter(([request]) => request.name === "presentation_start_view").map(([request]) => request.arguments);
    expect(inputs).toHaveLength(2); expect(inputs[1]).toEqual(inputs[0]); expect(test.stored()).toEqual(before); expect(test.decide).not.toHaveBeenCalled();
  });
  it("disables direct input on an admitted read failure and restores it only after a successful exact read", async () => {
    const test = await fixture(); const before = test.stored(); test.controlsFailed(true); await vi.advanceTimersByTimeAsync(500);
    expect(document.body.textContent).toContain("runtime_state_unavailable"); expect(document.querySelector<HTMLButtonElement>("button")!.textContent).toBe("Read saved state again");
    expect(test.stored()).toEqual(before); expect(test.decide).not.toHaveBeenCalled();
    test.controlsFailed(false); document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Choose an action")); expect(test.stored()).toEqual(before);
  });
  it("recovers a lost action reply from saved work without repeating the decision", async () => {
    const test = await fixture("wallet", {lostAction: true}); test.accept();
    await vi.waitFor(() => expect(document.body.textContent).toContain("direct response could not be confirmed"));
    const count = test.calls.mock.calls.length; await vi.advanceTimersByTimeAsync(1000); expect(test.calls).toHaveBeenCalledTimes(count);
    document.querySelector<HTMLButtonElement>("button")!.click(); await vi.waitFor(() => expect(document.body.textContent).toContain("Waiting for approval"));
    expect(test.decide).toHaveBeenCalledOnce(); expect(document.body.textContent).not.toContain("Choose an action");
  });
  it("keeps a read card readonly during preparation and presents its exact saved result", async () => {
    const test = await fixture("read"); expect(test.stored()).toMatchObject({preparationState: "pending"}); expect(test.stored()).not.toHaveProperty("inputState");
    expect(document.querySelectorAll("button")).toHaveLength(0); test.completeRead(); await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Trades in USDG"));
    expect(test.stored()).toMatchObject({preparationState: "completed", outcome: {kind: "snapshot"}}); expect(test.readExecution).toHaveBeenCalledOnce();
    await test.mount(); expect(test.readExecution).toHaveBeenCalledOnce(); expect(document.querySelectorAll("button")).toHaveLength(0);
  });
  it("retains stored read completion when chunks are unavailable and retries only those same bytes", async () => {
    const test = await fixture("read", {mount: false}); test.completeRead(); await vi.waitFor(() => expect(test.stored()).toMatchObject({preparationState: "completed"}));
    const before = test.stored(); test.chunksFailed(true); await test.mount(); expect(document.body.textContent).toContain("snapshot_missing");
    test.chunksFailed(false); document.querySelector<HTMLButtonElement>("button")!.click(); await vi.waitFor(() => expect(document.body.textContent).toContain("Trades in USDG"));
    expect(test.stored()).toEqual(before); expect(test.readExecution).toHaveBeenCalledOnce();
  });
});

describe("local Wallet account controls", () => {
  it.each(["disconnected", "expired"] as const)("closes the original input when its owner confirms the connection is %s", async (reason) => {
    const test = await fixture("wallet_selection");
    const projection = test.database.walletStore(); const current = projection.read();
    if (reason === "expired") vi.setSystemTime(new Date("2026-08-13T00:00:00.001Z"));
    projection.replace(current.revision, {status: "disconnected", reason}, null, null, parseUtcTimestamp(new Date().toISOString()), [], []);
    await vi.advanceTimersByTimeAsync(500);
    expect(test.stored()).toMatchObject({inputState: "input_closed", closeReason: "invalidated", outcome: null});
    expect(document.querySelector("select")).toBeNull(); expect(document.body.textContent).toContain("Input closed");
    expect(test.selectAccount).not.toHaveBeenCalled(); expect(test.decide).not.toHaveBeenCalled();
  });
  it("keeps transiently unavailable observation pending and restores controls only after the same source is available", async () => {
    const test = await fixture("wallet_selection"); const before = test.stored();
    const read = test.getAccountSelection.getMockImplementation();
    if (read === undefined) throw new Error("Canonical account selection producer required.");
    test.getAccountSelection.mockRejectedValue(new WalletOperationError("runtime_state_unavailable"));
    await vi.advanceTimersByTimeAsync(500);
    expect(test.stored()).toEqual(before); expect(test.stored()).toMatchObject({inputState: "input_pending", closeReason: null});
    expect(document.querySelector("select")).toBeNull(); expect(document.body.textContent).toContain("Decision input unavailable");
    expect(test.selectAccount).not.toHaveBeenCalled();
    test.getAccountSelection.mockImplementation(read); await vi.advanceTimersByTimeAsync(500);
    expect(test.stored()).toEqual(before); expect(document.querySelector("select")).not.toBeNull();
    test.choose(); await vi.waitFor(() => expect(document.body.textContent).toContain("Account selected"));
    expect(test.selectAccount).toHaveBeenCalledOnce();
  });
  it("keeps healthy input pending after a stale selection revision and admits a new explicit choice from the latest read", async () => {
    const test = await fixture("wallet_selection"); const original = test.stored(); const changed = test.changePreference(); test.choose();
    await vi.waitFor(() => expect(document.body.textContent).toContain("state_conflict"));
    expect(test.stored()).toEqual(original); expect(test.selectAccount).toHaveBeenCalledOnce();
    expect(test.selectAccount.mock.calls[0]![0].expectedSelectionRevision).toBe("0");
    expect(document.querySelector<HTMLSelectElement>("select")!.disabled).toBe(false);
    test.choose(); await vi.waitFor(() => expect(document.body.textContent).toContain("Account selected"));
    expect(test.selectAccount).toHaveBeenCalledTimes(2);
    expect(test.selectAccount.mock.calls[1]![0].expectedSelectionRevision).toBe(changed.selectionRevision);
    expect(test.stored()).toMatchObject({inputState: "input_closed", outcome: {kind: "wallet_selection", value: {account: accounts[0]}}});
  });
  it("uses the immutable account list and latest selection revision after another writer changes only the preference", async () => {
    const test = await fixture("wallet_selection"); const original = test.stored(); const changed = test.changePreference();
    expect(original).toMatchObject({expiresAt: null}); expect(document.querySelector(".deadline-copy")).toBeNull();
    await vi.advanceTimersByTimeAsync(500); expect(test.stored()).toEqual(original); test.choose();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Account selected"));
    expect(test.selectAccount).toHaveBeenCalledOnce(); expect(test.selectAccount.mock.calls[0]![0]).toMatchObject({account: accounts[0], expectedSelectionRevision: changed.selectionRevision});
    expect(test.stored()).toMatchObject({inputState: "input_closed", outcome: {kind: "wallet_selection", value: {account: accounts[0]}}}); expect(test.decide).not.toHaveBeenCalled();
  });
  it("does not retarget a selection card after its connection facts change", async () => {
    const test = await fixture("wallet_selection"); test.changeConnection(); await vi.advanceTimersByTimeAsync(500);
    expect(test.stored()).toMatchObject({inputState: "input_closed", closeReason: "invalidated"}); expect(document.querySelector("select")).toBeNull();
    expect(test.selectAccount).not.toHaveBeenCalled();
  });
  it("recovers a lost local selection reply from the committed card and does not infer success from current preference", async () => {
    const test = await fixture("wallet_selection", {lostAction: true}); test.choose();
    await vi.waitFor(() => expect(document.body.textContent).toContain("direct response could not be confirmed")); test.changePreference();
    document.querySelector<HTMLButtonElement>("button")!.click(); await vi.waitFor(() => expect(document.body.textContent).toContain("Account selected"));
    expect(document.body.textContent).toContain(accounts[0]!.address); expect(test.stored()).toMatchObject({outcome: {kind: "wallet_selection", value: {account: accounts[0]}}});
    expect(test.selectAccount).toHaveBeenCalledOnce();
  });
});

describe("immutable Wallet disconnection target delivery", () => {
  const targets = () => {
    const target = {status: "available" as const, sourceId: connectionId, connection};
    const facts = createPresentationSnapshot({contractId: "wallet.disconnect_target", contractVersion: "1", normalizedInput: {sourceId: connectionId}, admittedResult: captureCanonicalJson(target)});
    if (facts.status !== "available") throw new Error("Exact target facts required.");
    const reference = (value: typeof facts.value) => ({snapshotId: value.snapshotId, contractId: value.contractId as "wallet.disconnect_target" | "wallet.disconnect_targets",
      contractVersion: "1" as const, resultDigest: value.resultDigest, resultLength: value.resultBytes.length});
    const secondId = `wallet-session:${Buffer.alloc(32, 2).toString("base64url")}`;
    const second = {status: "available" as const, sourceId: secondId, connection: {...connection, connectionId: secondId}};
    const secondFacts = createPresentationSnapshot({contractId: "wallet.disconnect_target", contractVersion: "1", normalizedInput: {sourceId: secondId}, admittedResult: captureCanonicalJson(second)});
    if (secondFacts.status !== "available") throw new Error("Second exact target required.");
    const manifest = createPresentationSnapshot({contractId: "wallet.disconnect_targets", contractVersion: "1", normalizedInput: {operationId, connectionRevision: "1"},
      admittedResult: [{sourceId: connectionId, facts: reference(facts.value)}, {sourceId: secondId, facts: reference(secondFacts.value)}]});
    if (manifest.status !== "available") throw new Error("Exact manifest required.");
    const unsigned = {contractVersion: "1", domain: "wallet", kind: "disconnect", operationId, createdAt, actionExpiresAt: "2026-08-12T00:05:00.000Z",
      target: {chainId}, decision: {action: "disconnect_session"}, precondition: {connectionRevision: "1", targetSet: {kind: "snapshot", reference: reference(manifest.value)}}};
    const review = parseWalletReview({...unsigned, reviewDigest: walletReviewDigest(unsigned)});
    if (review.kind !== "disconnect") throw new Error("Disconnect Review required.");
    return {target, second, review, facts: facts.value, secondFacts: secondFacts.value, manifest: manifest.value, unsigned};
  };
  it("remounts the original complete disconnect subjects beside the submitted operation without preparing another Review", async () => {
    const source = targets();
    const test = await fixture("wallet", {review: source.review, snapshots: [source.manifest, source.facts, source.secondFacts]});
    test.accept();
    await vi.waitFor(() => expect(test.stored()).toMatchObject({inputState: "input_closed", closeReason: "submitted"}));
    const reopened = await test.cards.open({cardId: test.created.cardId, cardOpenRequestId: Buffer.alloc(32, 91).toString("base64url")});
    if (reopened.presentation.display.kind !== "operation" || reopened.presentation.display.review === undefined) throw new Error("Original operation source required.");
    expect(reopened.presentation.display.review.normalizedInput).toEqual({kind: "disconnect"});
    expect(Buffer.byteLength(canonicalJsonStringify(captureCanonicalJson(reopened)), "utf8")).toBeLessThanOrEqual(65_535);
    await test.mount();
    expect(document.body.textContent).toContain(chainId);
    for (const target of [source.target, source.second]) {
      expect(document.body.textContent).toContain(target.sourceId);
      if (target.connection.status !== "connected") throw new Error("The exact fixture target must carry connected facts.");
      for (const namespace of target.connection.namespaces) for (const account of namespace.accounts) {
        expect(document.body.textContent).toContain(account.slice(account.lastIndexOf(":") + 1));
      }
    }
    expect(document.body.textContent).toContain("Disconnecting");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Disconnect wallet")).toBe(false);
    expect(test.prepareReview).toHaveBeenCalledOnce(); expect(test.decide).toHaveBeenCalledOnce();
    expect(test.calls.mock.calls.some(([request]) => request.name === "presentation_get_snapshot_chunk" &&
      snapshotIdFromUri(request.arguments?.["snapshotUri"]) === source.secondFacts.snapshotId)).toBe(true);
  });
  it("admits the complete manifest and exact source facts before returning the disconnection subjects", async () => {
    const source = targets();
    const calls = vi.fn(async (request: Parameters<PresentationViewApp["callServerTool"]>[0]) => {
      const id = snapshotIdFromUri(request.arguments?.["snapshotUri"]);
      const record = [source.manifest, source.facts, source.secondFacts].find((record) => record.snapshotId === id);
      if (record === undefined) throw new Error("An exact immutable target snapshot is required.");
      const index = request.arguments?.["index"] as number;
      return reply({kind: "presentation_snapshot_chunk", snapshotId: id, index, canonicalBase64: canonicalBase64FromBytes(record.resultBytes.slice(
        index * presentationSnapshotLimits.resultChunkBytes, (index + 1) * presentationSnapshotLimits.resultChunkBytes))});
    });
    const app = {getHostCapabilities: () => ({serverTools: {}}), getHostVersion: () => ({name: "standard", version: "1"}), callServerTool: calls, readServerResource: unexpected};
    expect(await readWalletReviewTargets(app, source.review, new AbortController().signal)).toEqual({ok: true, value: [source.target, source.second]});
    expect(calls.mock.calls.map(([request]) => snapshotIdFromUri(request.arguments?.["snapshotUri"]))).toEqual([source.manifest.snapshotId, source.facts.snapshotId, source.secondFacts.snapshotId]);
    const changed = {...source.unsigned, operationId: Buffer.alloc(32, 39).toString("base64url")};
    const wrongReview = parseWalletReview({...changed, reviewDigest: walletReviewDigest(changed)});
    if (wrongReview.kind !== "disconnect") throw new Error("Disconnect Review required.");
    calls.mockClear();
    await expect(readWalletReviewTargets(app, wrongReview, new AbortController().signal)).rejects.toThrow("does not belong to this input");
    expect(calls).not.toHaveBeenCalled();
  });
  it("preserves unavailable fact delivery without returning a usable prefix of the target set", async () => {
    const source = targets();
    const app = {getHostCapabilities: () => ({serverTools: {}}), getHostVersion: () => ({name: "standard", version: "1"}), readServerResource: unexpected,
      callServerTool: async (request: Parameters<PresentationViewApp["callServerTool"]>[0]) => {
        const id = snapshotIdFromUri(request.arguments?.["snapshotUri"]);
        const record = id === source.manifest.snapshotId ? source.manifest : id === source.facts.snapshotId ? source.facts : undefined;
        return record === undefined ? reply({kind: "presentation_unavailable", status: "unavailable", reason: "snapshot_missing"})
          : reply({kind: "presentation_snapshot_chunk", snapshotId: id, index: 0, canonicalBase64: canonicalBase64FromBytes(record.resultBytes)});
      }};
    expect(await readWalletReviewTargets(app, source.review, new AbortController().signal)).toEqual({ok: false,
      issue: {kind: "presentation", unavailable: {kind: "presentation_unavailable", status: "unavailable", reason: "snapshot_missing"}}});
  });
});
