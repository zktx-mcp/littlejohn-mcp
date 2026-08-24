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

  it("renders the captured Codex application failure as a generic tool error", async () => {
    const root = await renderCreatingResult(capturedCodexCreatingApplicationFailure);
    expect(root.textContent).toContain(
      "The tool call ended with an error before a displayable result was available.",
    );
    expect(root.textContent).not.toContain(
      "Little John could not verify the data required to display this result.",
    );
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
