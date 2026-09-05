import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
} from "../../src/core/index.js";
import {
  parseTokenCliCommand,
  runTokenCliCommand,
  tokenCliCommandRequiresInteractiveTerminal,
  type TokenCliOutputPort,
} from "../../src/interfaces/cli-token.js";
import { LocalOperationClient } from "../../src/interfaces/operation-client.js";
import type { RuntimeDispatchPort } from "../../src/interfaces/http-client.js";
import {
  jsonContentType,
  noStoreCacheControl,
  type RuntimeOwnerSessionPort,
} from "../../src/runtime/index.js";
import {
  parseOwnerInstanceId,
  parseProfileId,
  parseRuntimeConfigurationMac,
  parseRuntimeRevision,
} from "../../src/runtime/runtime-identity.js";
import { createTokenOperation } from "../token-catalog/harness.js";

const address = `0x${"12".repeat(20)}`;
const checksummedInput = "0x1212121212121212121212121212121212121212";
const operationId = Buffer.alloc(32, 22).toString("base64url");
const revision = "AAAAAAAAAAAAAAAAAAAAAA";
const activeTarget = Object.freeze({ kind: "active_wallet" as const });
const accountAddress = `0x${"34".repeat(20)}`;

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
    expect(parseTokenCliCommand(["token", "get", checksummedInput, "--active", "--json"]))
      .toEqual({ kind: "get", account: activeTarget, address, json: true });
    expect(parseTokenCliCommand([
      "token", "get", checksummedInput, "--address", accountAddress,
    ])).toEqual({
      kind: "get",
      account: { kind: "address", address: accountAddress },
      address,
      json: false,
    });
    expect(parseTokenCliCommand([
      "token", "list", "--active", "--limit", "25", "--cursor", address,
    ])).toEqual({ kind: "list", account: activeTarget, limit: 25, cursor: address, json: false });
    expect(parseTokenCliCommand(["token", "add", address, "--active"]))
      .toEqual({ kind: "add", account: activeTarget, address, json: false });
    expect(parseTokenCliCommand([
      "token", "remove", address, "--active", "--revision", revision,
    ])).toEqual({
      kind: "remove",
      account: activeTarget,
      address,
      expectedRevision: revision,
      json: false,
    });
    expect(parseTokenCliCommand(["token", "operation", operationId, "--json"]))
      .toEqual({ kind: "operation", operationId, json: true });

    expect(() => parseTokenCliCommand(["token", "add", address, "--active", "--json"])).toThrow();
    expect(() => parseTokenCliCommand(["token", "get", address])).toThrow();
    expect(() => parseTokenCliCommand([
      "token", "get", address, "--active", "--address", accountAddress,
    ])).toThrow();
    expect(() => parseTokenCliCommand(["token", "add", address])).toThrow();
  });

  it("requires a live interactive terminal only for direct decisions", () => {
    expect(tokenCliCommandRequiresInteractiveTerminal(parseTokenCliCommand([
      "token", "add", address, "--active",
    ]))).toBe(true);
    expect(tokenCliCommandRequiresInteractiveTerminal(parseTokenCliCommand([
      "token", "remove", address, "--active", "--revision", revision,
    ]))).toBe(true);
    expect(tokenCliCommandRequiresInteractiveTerminal(parseTokenCliCommand([
      "token", "operation", operationId,
    ]))).toBe(false);
    expect(tokenCliCommandRequiresInteractiveTerminal(parseTokenCliCommand([
      "token", "get", address, "--active",
    ]))).toBe(false);
  });

  it("rejects a non-interactive decision before any review or state change", async () => {
    const client = new LocalOperationClient({ ownerSessions: unreachableOwner });
    const captured = output(false);
    try {
      const exitCode = await runTokenCliCommand(
        unreachableRuntime,
        client,
        parseTokenCliCommand(["token", "add", address, "--active"]),
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

  it("keeps removal inspection absent in JSON without changing human operation output", async () => {
    const operation = await createTokenOperation({ kind: "remove", initiatedBy: "cli" });
    const ownerSessions: RuntimeOwnerSessionPort = Object.freeze({
      async openOwnerSession() {
        return Object.freeze({
          identity: Object.freeze({
            profileId: parseProfileId(Buffer.alloc(16, 1).toString("base64url")),
            ownerInstanceId: parseOwnerInstanceId(Buffer.alloc(16, 2).toString("base64url")),
            configurationMac: parseRuntimeConfigurationMac(
              Buffer.alloc(32, 3).toString("base64url"),
            ),
            ownerRevision: parseRuntimeRevision("1"),
          }),
          usable: true,
          async send() {
            return Object.freeze({
              status: "response_received" as const,
              response: Object.freeze({
                statusCode: 200,
                contentType: jsonContentType,
                cacheControl: noStoreCacheControl,
                bytes: new TextEncoder().encode(
                  `${canonicalJsonStringify(captureCanonicalJson(operation))}\n`,
                ),
              }),
            });
          },
          close() {},
        });
      },
    });
    const client = new LocalOperationClient({ ownerSessions });
    try {
      const human = output(false, false);
      expect(await runTokenCliCommand(
        unreachableRuntime,
        client,
        parseTokenCliCommand(["token", "operation", operation.operationId]),
        human.port,
      )).toBe(0);
      expect(human.written.join("")).toBe([
        `Token selection operation ${operation.operationId}: completed`,
        "Action: remove",
        "Outcome: selection_removed",
        `Completed at: ${operation.completedAt}`,
        `Review digest: ${operation.review.reviewDigest}`,
        `Selection-set revision: ${operation.result.selectionSetRevision}`,
        `Account: ${operation.result.selection.selection.account.address}`,
        `Token: ${operation.result.selection.selection.asset.address}`,
        `Chain: ${operation.result.selection.selection.asset.chainId}`,
        `Revision: ${operation.result.selection.selection.revision}`,
        "",
      ].join("\n"));
      expect(human.written.join("")).not.toContain("Inspection");

      const json = output(false, false);
      expect(await runTokenCliCommand(
        unreachableRuntime,
        client,
        parseTokenCliCommand(["token", "operation", operation.operationId, "--json"]),
        json.port,
      )).toBe(0);
      expect(JSON.parse(json.written.join(""))).toEqual(operation);
      expect(JSON.parse(json.written.join(""))
        .result.selection.historicalInspection).toBeNull();
    } finally {
      await client.close();
    }
  });
});
