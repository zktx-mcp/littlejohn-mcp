import { extendReviewPresentationRoutes } from "../../src/interfaces/review-presentation-routes.js";
import { extendSigningRoutes } from "../../src/interfaces/signing-routes.js";
import { signingBindings } from "../../src/interfaces/signing-bindings.js";
import { signingApplicationContracts } from "../../src/review/signing-application-contracts.js";
import { createSigningFixture, command as signingCommand, signer, message } from "../review/signing-fixture.js";
import { parseSigningCliCommand, runSigningCliCommand } from "../../src/interfaces/cli-signing.js";
import { writeFile } from "node:fs/promises";
import { createSigningCodec } from "../../src/chain/evm-standard.js";
import { liveReviewPresentationIdentity } from "../../src/interfaces/review-presentation-binding.js";
import { dirname, resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createReceiptFixture } from "../receipt-activity/fixture.js";
import { createReviewApplication } from "../../src/review/application.js";
import { FixedHttpOwner } from "../../src/runtime/http-owner.js";
import { loadOrCreateControlCredential, deriveRuntimeConfigurationMac } from "../../src/runtime/control-credential.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { runtimeReleased } from "../../src/runtime/shutdown.js";
import { extendExchangeRoutes } from "../../src/interfaces/exchange-routes.js";
import { exchangeBindings, activityBindings } from "../../src/interfaces/exchange-bindings.js";
import { LocalOperationClient } from "../../src/interfaces/operation-client.js";
import { parseExchangeCliCommand, runExchangeCliCommand } from "../../src/interfaces/cli-exchange.js";
import { McpAppPresentationService, createMcpAppResource } from "../../src/interfaces/mcp-app/server.js";
import { captureCanonicalJson, canonicalJsonStringify } from "../../src/core/index.js";
import { exchangeApplicationContracts } from "../../src/review/application-contracts.js";
import { presentationSnapshotMetadataKey, admitPresentationSnapshotResource } from "../../src/interfaces/mcp-app/contracts.js";

const fixture = async (signing?: ReturnType<typeof createSigningFixture>) => {
  const base = await createReceiptFixture();
  const send = vi.fn(async () => ({ response: Promise.resolve({ status: "hash_returned" as const, transactionHash: base.hash }) }));
  const clock = signing?.clock ?? base.deps.clock;
  const application = createReviewApplication({ preparation: { ...base.deps, clock, activeWallet: signing?.activeWallet ?? base.deps.activeWallet, transactions: base.transactions },
    receiptInvocationPorts: base.invocationPorts, nativeUnitAuthority: base.nativeUnitAuthority, codec: base.codec, signingCodec: createSigningCodec(),
    walletRequests: signing?.wallet ?? { hasPendingRequest: () => false, startRequest: send }, ledger: base.database.transactionLedgerStore() });
  const root = dirname(base.path);
  const credential = await loadOrCreateControlCredential(root, resolve(root, "control.key"));
  const owner = new FixedHttpOwner({ ownerStore: base.database.ownerStore(), credential,
    configurationMac: deriveRuntimeConfigurationMac(credential, readRuntimeConfiguration({})), now: () => clock.now(), onPortOwnershipAcquired: () => undefined,
    applicationFactory: ({ routes }) => ({ routes: extendReviewPresentationRoutes(extendSigningRoutes(extendExchangeRoutes({ routes, exchange: application.exchange,
      activity: application.activity }), application.signing), application.presentations),
      shutdown: async () => { await application.close(); return runtimeReleased; }, close: () => application.close() }),
  });
  try { await owner.start(); }
  catch (error) {
    await application.close();
    const closed = await owner.closeApplication();
    if ("permit" in closed) await owner.releaseListener(closed.permit);
    await base.close();
    throw error;
  }
  const client = new LocalOperationClient({ ownerSessions: owner });
  const presentation = new McpAppPresentationService(base.database.presentationSnapshotStore(), createMcpAppResource("<!doctype html><title>Test</title>"), {
    async read(operationId) {
      const result = await client.invoke(liveReviewPresentationIdentity, { operationId });
      if ("status" in result || !result.ok) throw new Error("Live read failed.");
      return result.value;
    },
  });
  return { ...base, application, owner, client, presentation, send,
    async closeAll() {
      await client.close();
      const closed = await owner.closeApplication();
      if ("permit" in closed) await owner.releaseListener(closed.permit);
      await base.close();
    },
  };
};

describe("exchange interface handoff", () => {
  it("carries signing through the shared application, native owner and memory presentation without a ledger result", async () => {
    const signing = createSigningFixture();
    const test = await fixture(signing);
    try {
      const started = await test.client.invoke(signingBindings.start.identity, signingCommand);
      if (!("ok" in started) || !started.ok) throw new Error("Admitted signing decision required.");
      const review = started.value;
      const value = captureCanonicalJson(review);
      const handoff = await test.presentation.present(signingApplicationContracts.start, signingCommand,
        { structuredContent: value as Record<string, unknown>, content: [{ type: "text", text: canonicalJsonStringify(value) }] });
      expect(handoff.status).toBe("available");
      if (handoff.status !== "available") throw new Error("Memory presentation required.");
      const resource = admitPresentationSnapshotResource(handoff.delivery.result._meta?.[presentationSnapshotMetadataKey]);
      expect(resource.descriptor.source.kind).toBe("review_memory");
      expect(test.database.presentationSnapshotStore().read(resource.descriptor.snapshotId).status).toBe("unavailable");
      const pending = test.client.invoke(signingBindings.request.identity, { review, initiatedBy: "mcp_app" });
      await signing.sent;
      const signature = await signer.signMessage({ message });
      signing.reply({ status: "signature_returned", signature });
      expect(await pending).toMatchObject({ ok: true, value: { outcome: { status: "verified" }, signature } });
      expect(test.application.activity.list({ account: review.account, cursor: null }).records).toEqual([]);
      expect(await test.presentation.getSnapshot(resource.descriptor.snapshotUri)).toMatchObject({ kind: "presentation_unavailable" });
      expect(await test.client.invoke(signingBindings.get.identity, { operationId: review.operationId })).toEqual({ ok: true, value: { operationId: review.operationId, review: null } });
      expect(signing.startRequest).toHaveBeenCalledOnce();
    } finally { await test.closeAll(); await signing.close(); }
  });

  it("delivers the exact usable signature only after the independent TTY decision", async () => {
    const signing = createSigningFixture();
    const test = await fixture(signing);
    const output: string[] = [];
    const file = resolve(dirname(test.path), "message.json");
    const terminal = { inputIsTTY: true, outputIsTTY: true, interruptSignal: new AbortController().signal,
      writeOutput: (value: string) => { output.push(value); }, writeError: (value: string) => { output.push(value); }, readLine: vi.fn(async () => "n") };
    try {
      await writeFile(file, JSON.stringify(signingCommand.payload));
      const command = parseSigningCliCommand(["signing", "start", "--active", "--file", file]);
      for (const extra of ["--json", "--yes", "--output"]) expect(() => parseSigningCliCommand(["signing", "start", "--active", "--file", file, extra])).toThrow();
      expect(await runSigningCliCommand(test.client, command, { ...terminal, inputIsTTY: false })).toBe(2);
      expect(signing.startRequest).not.toHaveBeenCalled();
      expect(terminal.readLine).not.toHaveBeenCalled();
      expect(await runSigningCliCommand(test.client, command, terminal)).toBe(0);
      expect(output.join("\n")).toContain("Decision discarded");
      expect(signing.startRequest).not.toHaveBeenCalled();
      terminal.readLine.mockResolvedValue("y");
      const pending = runSigningCliCommand(test.client, command, terminal);
      await signing.sent;
      const signature = await signer.signMessage({ message });
      signing.reply({ status: "signature_returned", signature });
      expect(await pending).toBe(0);
      expect(output.filter((line) => line.includes(signature))).toEqual([`Signature: ${signature}\n`]);
      expect(signing.startRequest).toHaveBeenCalledOnce();
    } finally { await test.closeAll(); await signing.close(); }
  });
  it("carries a live decision through authenticated HTTP and removes its presentation after the one Wallet call", async () => {
    const test = await fixture();
    try {
      const started = await test.client.invoke(exchangeBindings.start.identity, test.input.request);
      expect(started).toMatchObject({ ok: true, value: { state: "ready_for_wallet_review" } });
      if (!("ok" in started) || !started.ok || started.value.state !== "ready_for_wallet_review") throw new Error("Ready decision required.");
      const review = started.value;
      expect(test.send).not.toHaveBeenCalled();
      const value = captureCanonicalJson(review);
      const handoff = await test.presentation.present(exchangeApplicationContracts.start, test.input.request,
        { structuredContent: value as Record<string, unknown>, content: [{ type: "text", text: canonicalJsonStringify(value) }] });
      expect(handoff.status).toBe("available");
      if (handoff.status !== "available") throw new Error("Live presentation required.");
      const resource = admitPresentationSnapshotResource(handoff.delivery.result._meta?.[presentationSnapshotMetadataKey]);
      expect(resource.descriptor.source.kind).toBe("review_memory");
      expect(test.database.presentationSnapshotStore().read(resource.descriptor.snapshotId).status).toBe("unavailable");
      const result = await test.client.invoke(exchangeBindings.request.identity, { review, initiatedBy: "mcp_app" });
      expect(result).toMatchObject({ ok: true, value: { kind: "wallet_result", outcome: { status: "hash_returned", recording: "recorded", lookup: "completed" } } });
      expect(test.send).toHaveBeenCalledTimes(1);
      expect(await test.presentation.getSnapshot(resource.descriptor.snapshotUri)).toMatchObject({ kind: "presentation_unavailable" });
      const duplicate = await test.client.invoke(exchangeBindings.request.identity, { review, initiatedBy: "mcp_app" });
      expect(duplicate).not.toMatchObject({ ok: true, value: { kind: "wallet_result" } });
      expect(test.send).toHaveBeenCalledTimes(1);
      const response = await test.owner.dispatchRuntimeRequest({ requestClass: "public_read", method: "POST", path: activityBindings.get.path,
        body: captureCanonicalJson({ account: test.reference.account, transactionHash: test.hash }) });
      expect(response.body).toMatchObject({ inspection: { data: { execution: "success", requestComparison: "matched", effectComparison: "matched" } } });
    } finally { await test.closeAll(); }
  });

  it("uses the independent TTY decision path, discards decline and never sends for a non-TTY call", async () => {
    const test = await fixture();
    vi.spyOn(Date, "now").mockImplementation(() => Date.parse(test.deps.clock.now()));
    const output: string[] = [];
    const terminal = { inputIsTTY: true, outputIsTTY: true, interruptSignal: new AbortController().signal,
      writeOutput: (text: string) => { output.push(text); }, writeError: (text: string) => { output.push(text); }, readLine: vi.fn(async () => "n") };
    try {
      const command = { kind: "start" as const, input: test.input.request, json: false as const };
      expect(await runExchangeCliCommand(test.owner, test.client, command, { ...terminal, inputIsTTY: false })).not.toBe(0);
      expect(test.send).not.toHaveBeenCalled();
      expect(terminal.readLine).not.toHaveBeenCalled();
      expect(await runExchangeCliCommand(test.owner, test.client, command, terminal)).toBe(0);
      expect(output.join("\n")).toContain("Decision discarded");
      expect(test.send).not.toHaveBeenCalled();
      terminal.readLine.mockResolvedValue("y");
      expect(await runExchangeCliCommand(test.owner, test.client, command, terminal)).toBe(0);
      expect(test.send).toHaveBeenCalledTimes(1);
      expect(output.join("\n")).toContain(test.hash);
      const parsed = parseExchangeCliCommand(["activity", "get", test.hash, "--address", test.reference.account.address, "--json"]);
      expect(await runExchangeCliCommand(test.owner, test.client, parsed, terminal)).toBe(0);
      expect(output.at(-1)).toContain('"requestComparison":"matched"');
    } finally { await test.closeAll(); }
  });
});
