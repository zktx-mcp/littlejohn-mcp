import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {createHash} from "node:crypto";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import {describe, expect, it, vi} from "vitest";
import {CapabilityBindingRegistry, CapabilityRegistry, captureCanonicalJson, parseCapabilitySuccess, parseHash32, parseUtcTimestamp, type CanonicalJson} from "../../src/core/index.js";
import {createErc20CallEncoder} from "../../src/chain/evm-standard.js";
import {transactionInspectCapability} from "../../src/chain/read-contracts.js";
import {ProductDatabase} from "../../src/runtime/database.js";
import {loadOrCreateControlCredential, createControlCredentialVerifier} from "../../src/runtime/control-credential.js";
import {createRuntimeRouteRegistry} from "../../src/runtime/http-routing.js";
import {ImmutableReadApplication, extendImmutableReadRoutes} from "../../src/interfaces/immutable-read-application.js";
import {PresentationWorkBudget} from "../../src/interfaces/presentation-work.js";
import {createMcpServer, type McpServerRuntimePort} from "../../src/interfaces/mcp.js";
import {LocalOperationClient} from "../../src/interfaces/operation-client.js";
import {createMcpAppResource} from "../../src/interfaces/mcp-app/server.js";
import {admitPresentationSnapshotResource, presentationResultPartContract} from "../../src/interfaces/mcp-app/contracts.js";
import {presentationContractRegistry} from "../../src/interfaces/mcp-app/registry.js";
import {ScriptedRpc, createChainHandlerHarness, rpcValue} from "../chain/handler-harness.js";
import {openTestOwnerSession} from "./owner-session-harness.js";
import {TokenCatalogOperationError} from "../../src/token-catalog/operation-error.js";
import {createTokenCatalogApplication} from "../../src/token-catalog/application.js";
import {createAddressTargetResolver} from "../../src/chain/address-target.js";
import {activeWalletFixturePort} from "../wallet/account-fixture.js";
import {createAccountAssetFailure} from "../../src/account-assets/errors.js";
import {accountAssetApplicationContracts} from "../../src/account-assets/client.js";
import {tokenCatalogApplicationContracts} from "../../src/token-catalog/client.js";
import {evmChainIdSchema} from "../../src/evm/identities.js";
import {createReceiptFixture} from "../receipt-activity/fixture.js";
import {receiptApplicationContracts} from "../../src/receipt-activity/application-contracts.js";

const immutableSdkConsumer = async (application: ImmutableReadApplication, database: ProductDatabase, databasePath: string) => {
  const directory = dirname(databasePath);
  const credential = await loadOrCreateControlCredential(directory, join(directory, "control.key"));
  const routes = extendImmutableReadRoutes(createRuntimeRouteRegistry({controlVerifier: createControlCredentialVerifier(credential)}), application);
  const runtime: McpServerRuntimePort = {
    async dispatchRuntimeRequest(request) {
      const match = routes.match(request.method, request.path);
      if (match.status !== "matched") throw new Error("A registered product route is required.");
      const result = routes.normalizeResult(match.route, await match.route.handler({params: match.params,
        body: request.body, query: "", signal: request.signal ?? new AbortController().signal}));
      return result.ok ? {status: 200, body: result.body} : {status: result.problem.status, body: captureCanonicalJson(result.problem)};
    },
    openOwnerSession(signal) {return openTestOwnerSession(this, signal);},
    presentationSnapshotStore: () => database.presentationSnapshotStore(),
    presentationPublicationKeys: () => ({derive: () => {throw new Error("No data card is created.");}}),
  };
  const operations = new LocalOperationClient({ownerSessions: runtime});
  const server = createMcpServer(runtime, operations, createMcpAppResource("<!doctype html><title>Unused</title>"));
  const client = new Client({name: "ordinary-activity-consumer", version: "1"}, {capabilities: {}});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);}
  catch (error) {await Promise.allSettled([client.close(), server.close(), operations.close()]); throw error;}
  return {client, close: async () => {await Promise.allSettled([client.close(), server.close(), operations.close()]);}};
};

// Keys in this fixture's canonical contracts are ASCII. This independent
// serializer verifies exact transport bytes, not the domain's computation.
const serialize = (value: CanonicalJson): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(serialize).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${serialize((value as Record<string, CanonicalJson>)[key]!)}`).join(",")}}`;
const unused = async (): Promise<never> => {throw new Error("This scenario does not use account or token queries.");};
// Application-owned reads do not invoke Chain capability bindings.
const unusedBindings = new CapabilityBindingRegistry(new CapabilityRegistry([]));
const hash = parseHash32(`0x${"77".repeat(32)}`);

describe("immutable read transport", () => {
  it("preserves a returned Token failure from the actual application through MCP and card reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-read-failure-"));
    const path = join(directory, "product.sqlite");
    const database = await ProductDatabase.open(path, parseUtcTimestamp("2026-07-15T06:00:00.000Z"));
    const token = createTokenCatalogApplication({dependencies: {
      addressTargets: createAddressTargetResolver({chainId: evmChainIdSchema.parse("eip155:4663"), activeWallet: activeWalletFixturePort(() => {throw new Error("No Wallet read.");})}),
      store: database.tokenCatalogReadStore(),
    }, operations: {review: unused, decide: unused, getOperation: () => {throw new Error("No operation read.");},
      prepareReview: unused, getReviewSource: () => {throw new Error("No Review read.");}, discardPreparedReview() {}}});
    const snapshots = database.presentationSnapshotStore();
    const prepare = vi.fn(snapshots.prepare);
    const application = new ImmutableReadApplication({signal: new AbortController().signal, work: new PresentationWorkBudget(),
      snapshots: {...snapshots, prepare}, bindings: unusedBindings, token, accountAssets: {list: unused},
      activity: {get: () => {throw new Error("No Activity read.");}, list: () => {throw new Error("No Activity read.");}, inspect: unused}});
    let consumer: Awaited<ReturnType<typeof immutableSdkConsumer>> | undefined;
    const input = tokenCatalogApplicationContracts.selection.parseInput({account: {kind: "address", address: `0x${"11".repeat(20)}`},
      asset: {kind: "erc20", chainId: "eip155:4663", address: `0x${"22".repeat(20)}`}});
    const expected = {ok: false, error: {category: "state", code: "token_selection_not_found", issues: [],
      message: "The token has no account selection.", retryable: false}};
    try {
      expect(await token.getSelection(input)).toEqual(expected);
      consumer = await immutableSdkConsumer(application, database, path);
      const reply = await consumer.client.callTool({name: "token_get_selection", arguments: input});
      expect(reply).toMatchObject({isError: true, structuredContent: expected});
      expect(reply.content).toEqual([{type: "text", text: serialize(captureCanonicalJson(expected))}]);
      await expect(application.executeCard({capabilityId: "token.selection", input}, new AbortController().signal)).resolves.toEqual(expected);
      expect(prepare).not.toHaveBeenCalled();
    } finally {await consumer?.close(); await application.close(); database.close(); await rm(directory, {recursive: true, force: true});}
  });

  it("admits returned Account failures against their own contract before delivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-account-failure-"));
    const path = join(directory, "product.sqlite");
    const database = await ProductDatabase.open(path, parseUtcTimestamp("2026-07-15T06:00:00.000Z"));
    let value = createAccountAssetFailure("wallet_not_connected");
    const application = new ImmutableReadApplication({signal: new AbortController().signal, work: new PresentationWorkBudget(),
      snapshots: database.presentationSnapshotStore(), bindings: unusedBindings, accountAssets: {list: async () => value},
      token: {getSelection: unused, listSelections: unused},
      activity: {get: () => {throw new Error("No Activity read.");}, list: () => {throw new Error("No Activity read.");}, inspect: unused}});
    let consumer: Awaited<ReturnType<typeof immutableSdkConsumer>> | undefined;
    try {
      consumer = await immutableSdkConsumer(application, database, path);
      const request = {name: "account_list_assets", arguments: {account: {kind: "active_wallet"}}};
      expect(await consumer.client.callTool(request)).toMatchObject({isError: true, structuredContent: value});
      // This is a valid Token failure, but the Account contract does not admit it.
      value = new TokenCatalogOperationError("token_selection_not_found").failure;
      await expect(application.executeCard({capabilityId: "account.assets",
        input: accountAssetApplicationContracts.collection.parseInput(request.arguments)}, new AbortController().signal)).rejects.toThrow();
      expect(await consumer.client.callTool(request)).toMatchObject({isError: true, structuredContent: {ok: false, error: {code: "internal_error"}}});
    } finally {await consumer?.close(); await application.close(); database.close(); await rm(directory, {recursive: true, force: true});}
  });

  it("delivers a large Activity page made of individually admitted receipt records without a component descriptor", async () => {
    const test = await createReceiptFixture();
    let consumer: Awaited<ReturnType<typeof immutableSdkConsumer>> | undefined;
    let application: ImmutableReadApplication | undefined;
    try {
      const originalLog = test.receipt.logs[2] as Record<string, unknown>;
      // Transfer movements coalesce by asset. Swap observations are retained
      // independently; each has a distinct actual source log position.
      for (let index = 3; index < 131; index += 1) test.receipt.logs.push({...originalLog, logIndex: `0x${index.toString(16)}`});
      for (let index = 0; index < 25; index += 1) {
        const transactionHash = parseHash32(`0x${index.toString(16).padStart(64, "0")}`);
        test.tx.hash = transactionHash; test.receipt.transactionHash = transactionHash; test.block.transactions = [transactionHash];
        for (const log of test.receipt.logs) (log as Record<string, unknown>)["transactionHash"] = transactionHash;
        const result = await test.activity.inspect(test.reference.account, transactionHash, new AbortController().signal);
        expect(result.status).toBe("observed");
        expect(result.record).not.toBeNull();
        const length = Buffer.byteLength(serialize(captureCanonicalJson(result.record)));
        expect(length).toBeLessThanOrEqual(65_535);
        expect(length).toBeGreaterThan(65_535 / 25);
      }
      const input = {account: test.reference.account, cursor: null};
      const original = receiptApplicationContracts.list.parsePublicSuccess(input, test.activity.list(input.account));
      const originalBytes = Buffer.from(serialize(captureCanonicalJson(original)));
      expect(originalBytes.length).toBeGreaterThan(1_048_575 / 2);
      let reads = 0;
      application = new ImmutableReadApplication({signal: new AbortController().signal, work: new PresentationWorkBudget(),
        snapshots: test.database.presentationSnapshotStore(), bindings: unusedBindings, accountAssets: {list: unused},
        token: {getSelection: unused, listSelections: unused}, activity: {
          get: value => receiptApplicationContracts.get.parsePublicSuccess(value, test.activity.get(value.account, value.transactionHash)),
          list: value => {reads += 1; const page = test.activity.list(value.account, value.cursor?.after ?? null);
            return receiptApplicationContracts.list.parsePublicSuccess(value,
              {...page, nextCursor: page.nextCursor === null ? null : {account: page.account, after: page.nextCursor}});}, inspect: unused}});
      consumer = await immutableSdkConsumer(application, test.database, test.path);
      const reply = await consumer.client.callTool({name: "activity_list_transactions", arguments: input});
      expect(reply.isError).not.toBe(true);
      const reference = admitPresentationSnapshotResource(reply.structuredContent);
      expect(reply._meta?.["littlejohn/operation-tool-result"]).toBeUndefined();
      const pieces: Buffer[] = [];
      for (let index = 0; index < reference.descriptor.resultChunkCount; index += 1) {
        let count = 1;
        for (let partIndex = 0; partIndex < count; partIndex += 1) {
          const input = {snapshotUri: reference.descriptor.snapshotUri, index, partIndex};
          const reply = await consumer.client.callTool({name: "presentation_get_result_part", arguments: input});
          const part = presentationResultPartContract.parsePublicSuccess(input, reply.structuredContent);
          if (part.kind !== "presentation_result_part") throw new Error("The complete page is required.");
          count = part.partCount; pieces.push(Buffer.from(part.canonicalBase64, "base64"));
        }
      }
      const bytes = Buffer.concat(pieces);
      expect(bytes.equals(originalBytes)).toBe(true);
      const decoded = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
      const admitted = receiptApplicationContracts.list.parsePublicSuccess(input, decoded);
      expect(admitted.records.map(record => record.transactionHash)).toEqual(Array.from({length: 25}, (_, index) => `0x${index.toString(16).padStart(64, "0")}`));
      expect(reads).toBe(1);
    } finally {await consumer?.close(); await application?.close(); await test.close();}
    // This fixture admits 25 receipts and reconstructs the complete large page.
    // Runner headroom does not change product deadlines or result assertions.
  }, 20_000);

  it("keeps the original read permit after cancellation until its source settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-read-settlement-"));
    const database = await ProductDatabase.open(join(directory, "product.sqlite"), parseUtcTimestamp("2026-07-15T06:00:00.000Z"));
    const work = new PresentationWorkBudget();
    // 62 existing reservations leave exactly one complete read allowance.
    // 64 * (65,536 + 8,388,607) exceeds the accepted 536,870,912-byte bound.
    const otherPermits = Array.from({length: 62}, () => work.reserveRead(65_536));
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const started = new Promise<void>(resolve => {entered = resolve;});
    const application = new ImmutableReadApplication({signal: new AbortController().signal, work,
      snapshots: database.presentationSnapshotStore(), bindings: unusedBindings,
      accountAssets: {list: unused}, token: {getSelection: async () => {
        entered(); await gate; throw new TokenCatalogOperationError("token_selection_not_found");
      }, listSelections: unused}, activity: {get: () => {throw new Error("No Activity query.");}, list: () => {throw new Error("No Activity page.");}, inspect: unused}});
    const caller = new AbortController();
    const pending = application.getResult({contractId: "token.selection", input: {account: {kind: "address", address: `0x${"11".repeat(20)}`},
      asset: {chainId: "eip155:4663", kind: "erc20", address: `0x${"22".repeat(20)}`}}}, caller.signal);
    try {
      await Promise.race([started, pending.then(() => {throw new Error("The source must be entered before settlement.");})]); caller.abort();
      expect(() => work.reserveRead(65_536)).toThrow("busy");
      release(); await pending;
      work.reserveRead(65_536).release();
    } finally {
      release(); await Promise.allSettled([pending]); await application.close();
      for (const permit of otherPermits) permit.release();
      database.close(); await rm(directory, {recursive: true, force: true});
    }
  });

  for (const {calldataBytes, failStorage} of [{calldataBytes: 512, failStorage: false}, {calldataBytes: 600_000, failStorage: false},
    {calldataBytes: 600_000, failStorage: true}]) it(`delivers a ${calldataBytes}-byte transaction query once${failStorage ? " with rejected storage" : ""} through the actual MCP SDK and owning parser`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "littlejohn-immutable-"));
    const database = await ProductDatabase.open(join(directory, "product.sqlite"), parseUtcTimestamp("2026-07-15T06:00:00.000Z"));
    const inputHex = `0x${"12".repeat(calldataBytes)}`;
    const rpc = new ScriptedRpc([rpcValue("eth_chainId", "0x1237"), rpcValue("eth_getTransactionByHash", {
      hash, from: `0x${"11".repeat(20)}`, to: `0x${"22".repeat(20)}`, value: "0x20000000000001",
      input: inputHex, nonce: "0x20000000000001", gas: "0x20000000000001", type: "0x2", chainId: "0x1237",
      accessList: [], maxFeePerGas: "0x20000000000001", maxPriorityFeePerGas: "0x1",
      blockNumber: null, blockHash: null, transactionIndex: null,
    })]);
    const chain = createChainHandlerHarness({rpc, encoder: await createErc20CallEncoder()});
    const sourceValues: CanonicalJson[] = [];
    const invoke = CapabilityBindingRegistry.prototype.invoke;
    const observed = vi.spyOn(CapabilityBindingRegistry.prototype, "invoke").mockImplementation(async function(this: CapabilityBindingRegistry, definition, input, options) {
      const result = await invoke.call(this, definition, input, options);
      if (this === chain.registry) sourceValues.push(captureCanonicalJson(result)); return result;
    });
    const application = new ImmutableReadApplication({signal: new AbortController().signal, work: new PresentationWorkBudget(),
      snapshots: database.presentationSnapshotStore(), bindings: chain.registry,
      accountAssets: {list: unused}, token: {getSelection: unused, listSelections: unused},
      activity: {get: () => {throw new Error("No Activity query.");}, list: () => {throw new Error("No Activity page.");}, inspect: unused}});
    const credential = await loadOrCreateControlCredential(directory, join(directory, "control.key"));
    const routes = extendImmutableReadRoutes(createRuntimeRouteRegistry({controlVerifier: createControlCredentialVerifier(credential)}), application);
    const runtime: McpServerRuntimePort = {
      async dispatchRuntimeRequest(request) {
        expect(request.requestClass).toBe("local_control");
        const match = routes.match(request.method, request.path);
        if (match.status !== "matched") throw new Error("The product route must own this request.");
        const result = routes.normalizeResult(match.route, await match.route.handler({params: match.params,
          body: request.body, query: "", signal: request.signal ?? new AbortController().signal}));
        return result.ok ? {status: 200, body: result.body} : {status: result.problem.status, body: captureCanonicalJson(result.problem)};
      },
      openOwnerSession(signal) {return openTestOwnerSession(this, signal);},
      presentationSnapshotStore: () => database.presentationSnapshotStore(),
      presentationPublicationKeys: () => ({derive: () => {throw new Error("A data query never publishes a card.");}}),
    };
    const operations = new LocalOperationClient({ownerSessions: runtime});
    const server = createMcpServer(runtime, operations, createMcpAppResource("<!doctype html><title>Unused View</title>"));
    const client = new Client({name: "ordinary-immutable-consumer", version: "1.0.0"}, {capabilities: {}});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const raw = new Database(join(directory, "product.sqlite"), {readonly: true});
    try {
      if (failStorage) {
        const writer = new Database(join(directory, "product.sqlite"));
        try {writer.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON presentation_snapshot BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END");}
        finally {writer.close();}
      }
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const reply = await client.callTool({name: "read_inspect_transaction", arguments: {transactionHash: hash}});
      expect(sourceValues).toHaveLength(1);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(rpc.remainingSteps).toBe(0);
      if (failStorage) {
        expect(reply).toMatchObject({isError: true, structuredContent: {ok: false, error: {code: "runtime_state_unavailable"}}});
        if (!Array.isArray(reply.content)) throw new Error("The SDK failure must carry bounded MCP content.");
        expect(reply.content.some(item => item.type === "resource_link")).toBe(false);
        expect(raw.prepare("SELECT 1 FROM presentation_snapshot LIMIT 1").get()).toBeUndefined();
        return;
      }
      expect(reply.isError).not.toBe(true);
      expect(presentationContractRegistry.forContract(transactionInspectCapability)).toBeUndefined();
      let canonical: CanonicalJson;
      if (calldataBytes === 512) {
        canonical = captureCanonicalJson(reply.structuredContent);
        expect(raw.prepare("SELECT 1 FROM presentation_snapshot LIMIT 1").get()).toBeUndefined();
      } else {
        // The raw input hex alone exceeds the packet budget, independently of
        // the formatter, metadata, or the evidence projection.
        expect(Buffer.byteLength(inputHex)).toBeGreaterThan(1_048_575);
        const reference = admitPresentationSnapshotResource(reply.structuredContent);
        expect(reply.content).toContainEqual(expect.objectContaining({type: "resource_link", uri: reference.descriptor.snapshotUri}));
        expect(reply._meta).toBeUndefined();
        const resource = await client.readResource({uri: reference.descriptor.snapshotUri});
        const content = resource.contents[0];
        if (content === undefined || !("text" in content)) throw new Error("Exact metadata is required.");
        expect(JSON.parse(content.text)).toEqual(reference);
        const bytes: Buffer[] = [];
        for (let index = 0; index < reference.descriptor.resultChunkCount; index += 1) {
          let partCount = 1;
          for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
            const input = {snapshotUri: reference.descriptor.snapshotUri, index, partIndex};
            const result = await client.callTool({name: "presentation_get_result_part", arguments: input});
            const part = presentationResultPartContract.parsePublicSuccess(input, result.structuredContent);
            if (part.kind !== "presentation_result_part") throw new Error("A missing part cannot complete the source.");
            partCount = part.partCount;
            const decoded = Buffer.from(part.canonicalBase64, "base64");
            expect(decoded.toString("base64")).toBe(part.canonicalBase64);
            expect(decoded.length).toBeGreaterThan(0); expect(decoded.length).toBeLessThanOrEqual(65_536);
            bytes.push(decoded);
          }
        }
        const complete = Buffer.concat(bytes);
        expect(complete.length).toBe(reference.descriptor.resultUtf8Bytes);
        expect(createHash("sha256").update(complete).digest("hex")).toBe(reference.descriptor.resultSha256);
        expect(complete.equals(Buffer.from(serialize(sourceValues[0]!)))).toBe(true);
        canonical = captureCanonicalJson(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(complete)));
        const lastIndex = reference.descriptor.resultChunkCount - 1;
        const lastLength = complete.length - lastIndex * 262_144;
        const missingLastPart = Math.ceil(lastLength / 65_536);
        expect(missingLastPart).toBeLessThan(4); // Admitted position syntax, missing actual part.
        for (const input of [{snapshotUri: reference.descriptor.snapshotUri, index: reference.descriptor.resultChunkCount, partIndex: 0},
          {snapshotUri: reference.descriptor.snapshotUri, index: lastIndex, partIndex: missingLastPart}]) {
          const reply = await client.callTool({name: "presentation_get_result_part", arguments: input});
          expect(reply.structuredContent).toEqual({kind: "presentation_unavailable", status: "unavailable", reason: "snapshot_inconsistent"});
        }
        const writer = new Database(join(directory, "product.sqlite"));
        try {
          const original = writer.prepare("SELECT result_bytes AS bytes FROM presentation_snapshot WHERE snapshot_id = ?").get(reference.descriptor.snapshotId) as {bytes: Buffer};
          const corrupt = Buffer.from(original.bytes); corrupt[0] = 0x5b;
          writer.prepare("UPDATE presentation_snapshot SET result_bytes = ? WHERE snapshot_id = ?").run(corrupt, reference.descriptor.snapshotId);
          const corruptReply = await client.callTool({name: "presentation_get_result_part", arguments: {snapshotUri: reference.descriptor.snapshotUri, index: 0, partIndex: 0}});
          expect(corruptReply.structuredContent).toEqual({kind: "presentation_unavailable", status: "unavailable", reason: "snapshot_inconsistent"});
          writer.prepare("UPDATE presentation_snapshot SET result_bytes = ? WHERE snapshot_id = ?").run(original.bytes, reference.descriptor.snapshotId);
        } finally {writer.close();}
        await expect(client.readResource({uri: "ui://littlejohn/presentation/unknown.html"})).rejects.toThrow();
        await expect(client.callTool({name: "presentation_get_result_part", arguments: {snapshotUri: "littlejohn://presentation/reviews/" + Buffer.alloc(32, 1).toString("base64url") + "/sha256/" + "0".repeat(64), index: 0, partIndex: 0}})).resolves.toMatchObject({isError: true});
      }
      const admitted = parseCapabilitySuccess(transactionInspectCapability, {transactionHash: hash}, canonical);
      expect(admitted.data.nonce).toBe("9007199254740993");
      expect(admitted.data.input).toBe(inputHex);
      expect(admitted.data.value.raw).toBe("9007199254740993");
      expect(canonical).toEqual(sourceValues[0]);
      expect(observed).toHaveBeenCalledTimes(1);
    } finally {
      raw.close(); await Promise.allSettled([client.close(), server.close(), operations.close()]);
      await application.close(); observed.mockRestore(); await chain.close(); database.close();
      await rm(directory, {recursive: true, force: true});
    }
  });
});
