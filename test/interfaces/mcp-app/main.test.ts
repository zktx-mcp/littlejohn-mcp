// @vitest-environment jsdom

import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { admitMcpToolResultForDelivery } from "../../../src/interfaces/mcp-result.js";
import { capturedCodexCreatingApplicationFailure } from "./error-carriage-fixture.js";
import {presentationCardMetadataKey} from "../../../src/interfaces/mcp-app/card-contract.js";

interface MockAppInstance {
  emit(result: CallToolResult): void;
  onteardown?: () => Promise<Record<string, never>>;
}

const appState = vi.hoisted(() => ({ instance: undefined as unknown, initialized: true, tools: false,
  connect: undefined as (() => Promise<void>) | undefined,
  call: undefined as ((input: CallToolRequest["params"]) => Promise<CallToolResult>) | undefined }));

vi.mock("@modelcontextprotocol/ext-apps", () => {
  class App {
    readonly #listeners: ((result: CallToolResult) => void)[] = [];
    onteardown: (() => Promise<Record<string, never>>) | undefined;

    constructor(..._arguments: unknown[]) { appState.instance = this; }

    addEventListener(name: string, listener: (result: CallToolResult) => void): void {
      if (name === "toolresult") this.#listeners.push(listener);
    }

    async connect(): Promise<void> { await appState.connect?.(); }
    getHostCapabilities(): {serverTools?: Record<string, never>} { return appState.tools ? {serverTools: {}} : {}; }
    getHostVersion(): Readonly<{ name: string; version: string }> | undefined {
      return appState.initialized ? { name: "chatgpt", version: "physical-capture" } : undefined;
    }
    async callServerTool(input: CallToolRequest["params"]): Promise<CallToolResult> {
      if (appState.call === undefined) throw new Error("Unexpected tool call.");
      return appState.call(input);
    }
    async readServerResource(): Promise<never> { throw new Error("Unexpected resource read."); }
    async openLink(): Promise<never> { throw new Error("Unexpected link open."); }

    emit(result: CallToolResult): void {
      for (const listener of this.#listeners) listener(result);
    }
  }
  return { App };
});

const renderCreatingResult = async (result: CallToolResult): Promise<HTMLElement> => {
  await import("../../../src/interfaces/mcp-app/view/main.js");
  const app = appState.instance as MockAppInstance | undefined;
  if (app === undefined) throw new TypeError("Mock App was not constructed.");
  app.emit(result);
  const root = document.getElementById("app");
  if (!(root instanceof HTMLElement)) throw new TypeError("App root is unavailable.");
  await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
  return root;
};

describe("MCP App creating tool-error presentation", () => {
  beforeEach(async () => {
    await (appState.instance as MockAppInstance | undefined)?.onteardown?.();
    vi.resetModules();
    appState.instance = undefined;
    appState.initialized = true; appState.tools = false; appState.connect = undefined; appState.call = undefined;
    document.body.innerHTML = '<main id="app"></main>';
  });

  it("rejects an obsolete top-level snapshot-unavailable packet", async () => {
    const unavailable = { kind: "presentation_unavailable", status: "unavailable", reason: "snapshot_missing" };
    const root = await renderCreatingResult({ isError: false, content: [], structuredContent: unavailable });
    expect(root.textContent).toContain("could not verify the data");
    expect(root.textContent).not.toContain("snapshot_missing");
  });

  it("keeps an unregistered captured qualification failure generic", async () => {
    const root = await renderCreatingResult(capturedCodexCreatingApplicationFailure);
    expect(root.textContent).toContain("Little John could not verify the data needed to show this result.");
    expect(root.textContent).not.toContain("qualification_application_error");
    expect(root.textContent).not.toContain(
      "Little John could not verify the data required to display this result.",
    );
  });

  it.each([true, false])("renders a registered failure through its owning schema (standard flag: %s)", async (standard) => {
    const failure = { ok: false, error: { code: "runtime_state_unavailable", category: "runtime", message: "Local runtime state is unavailable.", retryable: false, issues: [] } };
    const root = await renderCreatingResult({ ...(standard ? { isError: true } : {}), structuredContent: failure,
      content: [{ type: "text", text: '{"error":{"category":"runtime","code":"runtime_state_unavailable","issues":[],"message":"Local runtime state is unavailable.","retryable":false},"ok":false}' }] });
    expect(root.textContent).toContain("Request failed");
    expect(root.textContent).toContain("runtime_state_unavailable");
    expect(root.textContent).toContain("Local runtime state is unavailable.");
    expect(root.textContent).not.toContain("Presentation unavailable");
  });

  it("renders the captured Codex delivery failure with its owned statement", async () => {
    const delivery = admitMcpToolResultForDelivery({
      content: [{ type: "text", text: "x".repeat(1_048_576) }],
    });
    if (delivery.status !== "too_large") throw new TypeError("Expected delivery failure.");
    const { isError: _isError, ...capturedCodexResult } = delivery.result;
    const root = await renderCreatingResult(capturedCodexResult);
    expect(root.textContent).toContain(
      "Little John could not verify the data needed to show this result.",
    );
    expect(root.textContent).not.toContain(
      "Little John could not verify the data required to display this result.",
    );
  });

  it("uses card identity for repeated publication acknowledgements without restarting the View", async () => {
    await import("../../../src/interfaces/mcp-app/view/main.js");
    const app = appState.instance as MockAppInstance;
    const cardId = Buffer.alloc(32, 37).toString("base64url");
    const creating = (disposition: "created" | "existing"): CallToolResult => ({structuredContent: {kind: "card", cardId, disposition},
      content: [{type: "resource_link", name: `presentation_card_${cardId}`, uri: `littlejohn://presentation/cards/${cardId}`, mimeType: "application/json"}],
      _meta: {[presentationCardMetadataKey]: {kind: "card", cardId}}});
    app.emit(creating("created"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Unavailable"));
    const displayed = document.getElementById("app")!.firstElementChild;
    app.emit(creating("existing"));
    await Promise.resolve();
    expect(document.getElementById("app")!.firstElementChild).toBe(displayed);
    expect(document.body.textContent).not.toContain("could not verify the data");
  });

  const exactClosedCard = () => {
    const cardId = Buffer.alloc(32, 37).toString("base64url");
    const reference = {kind: "card", cardId};
    const link = {type: "resource_link" as const, name: `presentation_card_${cardId}`,
      uri: `littlejohn://presentation/cards/${cardId}`, mimeType: "application/json"};
    const value = {state: {mode: "static", reference, record: {kind: "token_selection", cardId, contractVersion: "1",
      operationId: Buffer.alloc(32, 38).toString("base64url"), resultDigest: "a".repeat(64), snapshotId: `sha256:${"b".repeat(64)}`,
      inputState: "input_closed", closeReason: "expired", dispatchId: null, expiresAt: "2026-08-12T00:05:00.000Z", outcome: null}},
      display: {kind: "summary"}, actions: []};
    const calls = vi.fn(async (input: CallToolRequest["params"]): Promise<CallToolResult> => {
      expect(input.name).toBe("presentation_start_view"); expect(input.arguments?.["cardId"]).toBe(cardId);
      return {content: [], structuredContent: value};
    });
    appState.tools = true; appState.call = calls;
    return {cardId, reference, link, calls};
  };

  it("keeps one exact opening and admitted saved facts across carrier changes and rejects retargeting", async () => {
    const test = exactClosedCard();
    await import("../../../src/interfaces/mcp-app/view/main.js");
    const app = appState.instance as MockAppInstance;
    app.emit({content: [test.link]});
    await vi.waitFor(() => expect(document.body.textContent).toContain("This request has expired"));
    const displayed = document.getElementById("app")!.firstElementChild;
    app.emit({content: [test.link], structuredContent: {kind: "card", cardId: test.cardId, disposition: "existing"},
      _meta: undefined, isError: undefined});
    await Promise.resolve();
    expect(test.calls).toHaveBeenCalledOnce();
    expect(document.getElementById("app")!.firstElementChild).toBe(displayed);
    const other = Buffer.alloc(32, 39).toString("base64url");
    app.emit({content: [], structuredContent: {kind: "card", cardId: other, disposition: "created"}});
    await vi.waitFor(() => expect(document.body.textContent).toContain("Some details could not be displayed."));
    expect(document.body.textContent).toContain("This request has expired");
    expect(document.getElementById("app")!.firstElementChild).toBe(displayed);
    expect(test.calls).toHaveBeenCalledOnce();
    app.emit({content: [test.link]}); await Promise.resolve();
    expect(test.calls).toHaveBeenCalledOnce();
  });

  it("holds one admitted identity until connection settles and ignores post-teardown delivery", async () => {
    const test = exactClosedCard();
    let finish!: () => void;
    appState.connect = () => new Promise<void>(resolve => {finish = resolve;});
    const loading = import("../../../src/interfaces/mcp-app/view/main.js");
    await vi.waitFor(() => expect(appState.instance).toBeDefined());
    const app = appState.instance as MockAppInstance;
    app.emit({content: [test.link]}); app.emit({content: [test.link]}); await Promise.resolve();
    expect(test.calls).not.toHaveBeenCalled();
    finish(); await loading;
    await vi.waitFor(() => expect(document.body.textContent).toContain("This request has expired"));
    expect(test.calls).toHaveBeenCalledOnce();
    await app.onteardown!(); const before = document.body.textContent;
    app.emit({content: [], structuredContent: {kind: "card", cardId: Buffer.alloc(32, 41).toString("base64url"), disposition: "created"}});
    await Promise.resolve();
    expect(document.body.textContent).toBe(before); expect(test.calls).toHaveBeenCalledOnce();
  });

  it("does not read a card from a notification before Host initialization", async () => {
    const test = exactClosedCard();
    appState.initialized = false;
    await import("../../../src/interfaces/mcp-app/view/main.js");
    (appState.instance as MockAppInstance).emit({content: [test.link]});
    expect(document.body.textContent).toContain("could not verify the data");
    expect(test.calls).not.toHaveBeenCalled();
  });

  it("retains an admitted failure when a later notification cannot be trusted", async () => {
    const root = await renderCreatingResult({isError: true, content: [], structuredContent: {
      ok: false, error: {code: "runtime_state_unavailable", category: "runtime",
        message: "Local runtime state is unavailable.", retryable: false, issues: []}}});
    (appState.instance as MockAppInstance).emit({content: [], structuredContent: {
      kind: "card", cardId: Buffer.alloc(32, 42).toString("base64url"), disposition: "created"}});
    await vi.waitFor(() => expect(root.textContent).toContain("Some details could not be displayed."));
    expect(root.textContent).toContain("runtime_state_unavailable");
    expect(root.querySelectorAll("article")).toHaveLength(1);
  });

});
