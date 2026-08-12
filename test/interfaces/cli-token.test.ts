import { describe, expect, it } from "vitest";

import {
  parseTokenCliCommand,
  runTokenCliCommand,
  tokenCliCommandRequiresInteractiveTerminal,
  type TokenCliOutputPort,
} from "../../src/interfaces/cli-token.js";
import { LocalOperationClient } from "../../src/interfaces/operation-client.js";
import type { RuntimeDispatchPort } from "../../src/interfaces/http-client.js";
import type { RuntimeOwnerSessionPort } from "../../src/runtime/index.js";

const address = `0x${"12".repeat(20)}`;
const checksummedInput = "0x1212121212121212121212121212121212121212";
const operationId = Buffer.alloc(32, 22).toString("base64url");
const revision = "AAAAAAAAAAAAAAAAAAAAAA";

const unreachableRuntime = Object.freeze({
  async dispatchRuntimeRequest(): Promise<never> {
    throw new Error("This command must fail before a public read.");
  },
}) as RuntimeDispatchPort;

const unreachableOwner = Object.freeze({
  async openOwnerSession(): Promise<never> {
    throw new Error("This command must fail before an owner session opens.");
  },
}) as RuntimeOwnerSessionPort;

const output = (inputIsTTY: boolean, outputIsTTY = true) => {
  const written: string[] = [];
  const errors: string[] = [];
  const port: TokenCliOutputPort = Object.freeze({
    inputIsTTY,
    outputIsTTY,
    interruptSignal: new AbortController().signal,
    writeOutput(value: string): void { written.push(value); },
    writeError(value: string): void { errors.push(value); },
    async readLine(): Promise<string> { return "y"; },
  });
  return Object.freeze({ port, written, errors });
};

describe("token CLI operation projection", () => {
  it("uses the final closed grammar derived from read and operation bindings", () => {
    expect(parseTokenCliCommand(["token", "get", checksummedInput, "--json"]))
      .toEqual({ kind: "get", address, json: true });
    expect(parseTokenCliCommand(["token", "list", "--limit", "25", "--cursor", address]))
      .toEqual({ kind: "list", limit: 25, cursor: address, json: false });
    expect(parseTokenCliCommand(["token", "add", address]))
      .toEqual({ kind: "add", address, json: false });
    expect(parseTokenCliCommand(["token", "remove", address, "--revision", revision]))
      .toEqual({ kind: "remove", address, expectedRevision: revision, json: false });
    expect(parseTokenCliCommand(["token", "operation", operationId, "--json"]))
      .toEqual({ kind: "operation", operationId, json: true });

    expect(() => parseTokenCliCommand(["token", "add", address, "--json"])).toThrow();
  });

  it("requires a live interactive terminal only for direct decisions", () => {
    expect(tokenCliCommandRequiresInteractiveTerminal(parseTokenCliCommand([
      "token", "add", address,
    ]))).toBe(true);
    expect(tokenCliCommandRequiresInteractiveTerminal(parseTokenCliCommand([
      "token", "remove", address, "--revision", revision,
    ]))).toBe(true);
    expect(tokenCliCommandRequiresInteractiveTerminal(parseTokenCliCommand([
      "token", "operation", operationId,
    ]))).toBe(false);
    expect(tokenCliCommandRequiresInteractiveTerminal(parseTokenCliCommand([
      "token", "get", address,
    ]))).toBe(false);
  });

  it("rejects a non-interactive decision before any review or state change", async () => {
    const client = new LocalOperationClient({ ownerSessions: unreachableOwner });
    const captured = output(false);
    try {
      const exitCode = await runTokenCliCommand(
        unreachableRuntime,
        client,
        parseTokenCliCommand(["token", "add", address]),
        captured.port,
      );

      expect(exitCode).not.toBe(0);
      expect(captured.written).toEqual([]);
      expect(captured.errors.join(""))
        .toBe("interactive_terminal_required: This command requires an interactive terminal.\n");
    } finally {
      await client.close();
    }
  });
});
