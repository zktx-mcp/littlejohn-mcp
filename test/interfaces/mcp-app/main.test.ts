// @vitest-environment jsdom

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { admitMcpToolResultForDelivery } from "../../../src/interfaces/mcp-result.js";
import { capturedCodexCreatingApplicationFailure } from "./error-carriage-fixture.js";

interface MockAppInstance {
  emit(result: CallToolResult): void;
}

const appState = vi.hoisted(() => ({ instance: undefined as unknown }));

vi.mock("@modelcontextprotocol/ext-apps", () => {
  class App {
    readonly #listeners: ((result: CallToolResult) => void)[] = [];
    onteardown: (() => Promise<Record<string, never>>) | undefined;

    constructor(..._arguments: unknown[]) { appState.instance = this; }

    addEventListener(name: string, listener: (result: CallToolResult) => void): void {
      if (name === "toolresult") this.#listeners.push(listener);
    }

    async connect(): Promise<void> {}
    getHostCapabilities(): Record<string, never> { return {}; }
    getHostVersion(): Readonly<{ name: string; version: string }> {
      return { name: "chatgpt", version: "physical-capture" };
    }
    async callServerTool(): Promise<never> { throw new Error("Unexpected tool call."); }
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
  await vi.waitFor(() => expect(root.querySelector(".status-error")).not.toBeNull());
  return root;
};

describe("MCP App creating tool-error presentation", () => {
  beforeEach(() => {
    vi.resetModules();
    appState.instance = undefined;
    document.body.innerHTML = '<main id="app"></main>';
  });

  it("renders an admitted unavailable result without claiming corrupt data", async () => {
    const unavailable = { kind: "presentation_unavailable", status: "unavailable", reason: "snapshot_missing" };
    const root = await renderCreatingResult({ isError: false, content: [], structuredContent: unavailable });
    expect(root.textContent).toContain("The requested presentation is unavailable.");
    expect(root.textContent).toContain("snapshot_missing");
    expect(root.textContent).not.toContain("could not verify the data");
  });

  it("keeps an unregistered captured qualification failure generic", async () => {
    const root = await renderCreatingResult(capturedCodexCreatingApplicationFailure);
    expect(root.textContent).toContain("The tool call ended with an error before a displayable result was available.");
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
      "Little John could not deliver this MCP result because it exceeds the supported response size.",
    );
    expect(root.textContent).not.toContain(
      "Little John could not verify the data required to display this result.",
    );
  });
});
