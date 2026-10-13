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
import { tokenReviewFixture } from "../token-catalog/review-fixture.js";
import { createErc20CallEncoder } from "../../src/chain/evm-standard.js";
import { chainStatusCapability } from "../../src/chain/read-contracts.js";
import { ScriptedRpc, createChainHandlerHarness, disconnectedWallet, rpcValue } from "../chain/handler-harness.js";
import { openTestOwnerSession } from "./owner-session-harness.js";
import type { RuntimeDispatchRequest } from "../../src/runtime/index.js";
import { operationControlResources } from "../../src/interfaces/operation-bindings.js";

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
  it.each([
    { kind: "add" as const, classification: "official" as const, answer: "n", missingMetadata: false },
    { kind: "add" as const, classification: "unlisted" as const, answer: "interrupt", missingMetadata: true },
    { kind: "add" as const, classification: "unlisted" as const, answer: "y", missingMetadata: false },
    { kind: "remove" as const, classification: "unlisted" as const, answer: "n", missingMetadata: false },
  ])("preserves $kind Review facts and $answer outcome for $classification tokens", async ({ kind, classification, answer, missingMetadata }) => {
    const review = tokenReviewFixture({ kind, classification, missingMetadata, createdAt: new Date().toISOString() });
    const before = JSON.stringify(review);
    const harness = createChainHandlerHarness({ encoder: await createErc20CallEncoder(), wallet: disconnectedWallet(),
      rpc: new ScriptedRpc([rpcValue("eth_chainId", "0x1237"), rpcValue("eth_getBlockByNumber", {
        number: "0x2a", hash: `0x${"ab".repeat(32)}`, timestamp: "0x65a00000", transactions: [],
      })]) });
    const requests: RuntimeDispatchRequest[] = [];
    const runtime: RuntimeDispatchPort = { async dispatchRuntimeRequest(request) {
      requests.push(request);
      if (request.path === "/api/v1/chain-status") return { status: 200, body: captureCanonicalJson(await harness.invoke(chainStatusCapability, {})) };
      if (request.path === operationControlResources.tokenSelection.reviews) return { status: 200, body: captureCanonicalJson({ review }) };
      // The action was sent but both its response and exact recovery observation
      // were lost. No synthetic terminal result can turn this into success.
      throw new Error("Synthetic response loss after dispatch.");
    } };
    const client = new LocalOperationClient({ ownerSessions: { openOwnerSession: signal => openTestOwnerSession(runtime, signal) } });
    const captured = output(true);
    const interrupt = new AbortController();
    let questions = 0;
    try {
      const exit = await runTokenCliCommand(runtime, client,
        parseTokenCliCommand(["token", kind, review.target.asset.address, "--address", review.target.account.address,
          ...(kind === "remove" ? ["--revision", review.precondition.previousSelection!.revision] : [])]),
        { ...captured.port, interruptSignal: interrupt.signal, async readLine() {
          questions += 1;
          if (answer === "interrupt") interrupt.abort();
          return answer;
        } });
      expect(questions).toBe(1);
      const text = captured.written.join("");
      if (kind === "add") {
        expect(text).toContain(`Official listing: ${classification === "official" ? "Robinhood Stock Token" : "Custom token"}`);
        expect(text).toContain("Official listing does not prove token safety or ownership of underlying shares.");
        expect(text).toContain("Some of the requested data is unavailable.");
      } else {
        expect(text).toContain("Hide token");
        expect(text).toContain("Token visibility: Shown");
        expect(text).not.toMatch(/Official listing|Name:|Symbol:/);
      }
      expect(text).toContain(`Available until: ${review.actionExpiresAt}`);
      if (missingMetadata) {
        expect(text).toContain("Name: Unavailable");
        expect(text).toContain("The token name contains unsupported text and is not shown.");
      }
      const actions = requests.filter(request => request.method === "POST" && request.path !== operationControlResources.tokenSelection.reviews);
      if (answer === "y") {
        expect(exit).toBe(8);
        expect(actions).toHaveLength(1);
        expect(actions[0]?.method === "POST" && actions[0].body).toEqual({ review, initiatedBy: "cli" });
        expect(captured.errors.join("")).toBe(`Result unknown\nThe result of this action could not be confirmed. It will not be repeated automatically.\nOperation ID: ${review.operationId}\nThe action may have occurred. Do not repeat it.\nInspect that exact operation before another state change.\n`);
        expect(requests.some(request => request.method === "GET" && request.path.endsWith(review.operationId))).toBe(true);
        expect(text).not.toContain("Not submitted.");
      } else {
        expect(exit).toBe(0);
        expect(actions).toHaveLength(0);
        expect(requests).toHaveLength(2);
        expect(text).toContain("Not submitted. This command did not apply the change.");
        expect(text).not.toMatch(/Declined|Cancelled|Completed/);
        expect(captured.errors).toEqual([]);
      }
      expect(JSON.stringify(review)).toBe(before);
    } finally { await client.close(); await harness.close(); }
  });

  it("preserves list-limit syntax, owner capacity and omission", () => {
    expect(parseTokenCliCommand(["token", "list", "--active"]))
      .not.toHaveProperty("limit");
    for (const limit of ["1", "25"]) {
      expect(parseTokenCliCommand(["token", "list", "--active", "--limit", limit]))
        .toMatchObject({ kind: "list", limit: Number(limit) });
    }
    for (const limit of ["26", "9007199254740993", "0", "01", "+1", "1.0", "1e1", " 1"])
      expect(() => parseTokenCliCommand(["token", "list", "--active", "--limit", limit]))
        .toThrow("Token CLI input is invalid");
  });

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
        .toBe("Request failed\nThis action requires an interactive terminal.\nError details\nError code: interactive_terminal_required\nReported reason: This command requires an interactive terminal.\n");
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
        "Completed", "This request set the token to Hidden for this account.",
        `Account: ${operation.result.selection.selection.account.address}`,
        `Token: ${operation.result.selection.selection.asset.address}`,
        "Network: Robinhood Chain", "Token visibility: Hidden", `Completed at: ${operation.completedAt}`, "",
      ].join("\n"));

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
