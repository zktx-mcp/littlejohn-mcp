import { describe, expect, it } from "vitest";

import { runCli, type CliTerminalPort } from "../../src/cli.js";
import {
  captureCanonicalJson,
  chainAnchorSchema,
  chainStatusCapability,
  erc20AssetIdentitySchema,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  parseTokenCliCommand,
  runTokenCliCommand,
  type TokenCliOutputPort,
} from "../../src/interfaces/cli-token.js";
import type { RuntimeDispatchPort } from "../../src/interfaces/http-client.js";
import type { RuntimeDispatchRequest, RuntimeDispatchResponse } from "../../src/runtime/index.js";
import {
  tokenCatalogOperationSchema,
  tokenCatalogControlRoutes,
  tokenInspectionDigest,
  tokenRegistrationSchema,
  type TokenCatalogOperation,
} from "../../src/token-catalog/index.js";
import {
  bindForHarness,
  createCapabilityHarness,
  invokeBinding,
} from "../core/capability-harness.js";
import { createInspectionSuccess, walletAddress } from "../token-catalog/harness.js";

const tokenAddress = `0x${"12".repeat(20)}`;
const tokenAsset = erc20AssetIdentitySchema.parse({
  kind: "erc20",
  chainId: "eip155:4663",
  address: tokenAddress,
});
const operationId = "A".repeat(43);
const createdAt = "2026-07-18T00:00:03.000Z";
const expiresAt = "2026-07-18T00:05:03.000Z";

const chainStatusSuccess = async (): Promise<CanonicalJson> => {
  const anchor = chainAnchorSchema.parse({
    chainId: tokenAsset.chainId,
    blockNumber: "100",
    blockHash: `0x${"11".repeat(32)}`,
    blockTimestamp: "2026-07-18T00:00:00.000Z",
  });
  const harness = createCapabilityHarness(() => createdAt);
  const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) => {
    observations.record("rpc_chain_id", {
      source: context.ports.observations.get("chain_rpc"),
      claims: [{ role: "chain_id", value: tokenAsset.chainId }],
    });
    observations.record("latest_block", {
      source: context.ports.observations.get("chain_rpc"),
      claims: [{ role: "latest_block", value: anchor, chainAnchor: anchor }],
    });
    return { status: "success", data: { chainId: tokenAsset.chainId, latestBlock: anchor } };
  });
  const result = await invokeBinding(chainStatusCapability, binding, {});
  if (!result.ok) throw new TypeError("Chain status fixture failed.");
  return result as unknown as CanonicalJson;
};

const operations = async (): Promise<Readonly<{
  awaiting: TokenCatalogOperation;
  completed: TokenCatalogOperation;
  cancelled: TokenCatalogOperation;
}>> => {
  const inspection = await createInspectionSuccess({ asset: tokenAsset, block: { kind: "latest" } });
  const common = {
    operationId,
    kind: "register" as const,
    interactionInterface: "cli" as const,
    createdAt,
    expiresAt,
    account: { chainId: tokenAsset.chainId, address: walletAddress },
    asset: tokenAsset,
    review: {
      previousRegistration: null,
      proposedSettings: { userLabel: null, visibility: "visible" as const },
      inspection,
      reviewDigest: `0x${"ef".repeat(32)}`,
    },
    failure: null,
  };
  const awaiting = tokenCatalogOperationSchema.parse({ ...common, state: "awaiting_confirmation", result: null });
  const cancelled = tokenCatalogOperationSchema.parse({ ...common, state: "cancelled", result: null });
  const completed = tokenCatalogOperationSchema.parse({
    ...common,
    state: "completed",
    result: {
      registration: {
        account: common.account,
        asset: tokenAsset,
        revision: Buffer.alloc(16, 2).toString("base64url"),
        inspectionDigest: tokenInspectionDigest(inspection),
        userLabel: null,
        visibility: "visible",
        createdAt,
        updatedAt: createdAt,
      },
      inspection,
    },
  });
  return Object.freeze({ awaiting, completed, cancelled });
};

const existingRegistrationOperations = async () => {
  const inspection = await createInspectionSuccess({ asset: tokenAsset, block: { kind: "latest" } });
  const previous = tokenRegistrationSchema.parse({
    account: { chainId: tokenAsset.chainId, address: walletAddress },
    asset: tokenAsset,
    revision: Buffer.alloc(16, 4).toString("base64url"),
    inspectionDigest: tokenInspectionDigest(inspection),
    userLabel: "Old label",
    visibility: "visible",
    createdAt,
    updatedAt: createdAt,
  });
  const common = {
    operationId,
    state: "awaiting_confirmation" as const,
    interactionInterface: "cli" as const,
    createdAt,
    expiresAt,
    account: previous.account,
    asset: previous.asset,
    result: null,
    failure: null,
  };
  const update = tokenCatalogOperationSchema.parse({
    ...common,
    kind: "update_registration",
    review: {
      previousRegistration: previous,
      proposedSettings: { userLabel: "New label", visibility: "hidden" },
      inspection,
      reviewDigest: `0x${"ab".repeat(32)}`,
    },
  });
  const unregister = tokenCatalogOperationSchema.parse({
    ...common,
    kind: "unregister",
    review: {
      previousRegistration: previous,
      proposedSettings: null,
      inspection,
      reviewDigest: `0x${"cd".repeat(32)}`,
    },
  });
  const updated = tokenRegistrationSchema.parse({
    ...previous,
    revision: Buffer.alloc(16, 5).toString("base64url"),
    userLabel: "New label",
    visibility: "hidden",
    updatedAt: "2026-07-18T00:00:04.000Z",
  });
  return Object.freeze({
    previous,
    update: Object.freeze({
      awaiting: update,
      completed: tokenCatalogOperationSchema.parse({
        ...update,
        state: "completed",
        result: { registration: updated, inspection },
      }),
    }),
    unregister: Object.freeze({
      awaiting: unregister,
      completed: tokenCatalogOperationSchema.parse({
        ...unregister,
        state: "completed",
        result: { asset: previous.asset, removedRevision: previous.revision },
      }),
    }),
  });
};

type RuntimeHandler = (
  request: RuntimeDispatchRequest,
) => RuntimeDispatchResponse | Promise<RuntimeDispatchResponse>;

class FakeRuntime implements RuntimeDispatchPort {
  readonly ownerState = "deferred" as const;
  readonly requests: RuntimeDispatchRequest[] = [];
  startCount = 0;
  stopCount = 0;
  readonly #handler: RuntimeHandler;

  constructor(handler: RuntimeHandler) {
    this.#handler = handler;
  }

  async dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    this.requests.push(request);
    return await this.#handler(request);
  }

  async start(): Promise<void> { this.startCount += 1; }
  async stop(): Promise<void> { this.stopCount += 1; }
}

const outputPort = (options: {
  readonly confirmationLine?: string;
  readonly interruptOnConfirmation?: boolean;
  readonly inputIsTTY?: boolean;
  readonly outputIsTTY?: boolean;
} = {}) => {
  const output: string[] = [];
  const errors: string[] = [];
  const prompts: string[] = [];
  const controller = new AbortController();
  const port: TokenCliOutputPort = Object.freeze({
    inputIsTTY: options.inputIsTTY ?? true,
    outputIsTTY: options.outputIsTTY ?? true,
    interruptSignal: controller.signal,
    writeOutput: (value: string) => { output.push(value); },
    writeError: (value: string) => { errors.push(value); },
    readLine: async (prompt: string) => {
      prompts.push(prompt);
      if (options.interruptOnConfirmation === true) {
        controller.abort();
        await new Promise<never>(() => undefined);
      }
      return options.confirmationLine ?? "n";
    },
  });
  return Object.freeze({
    port,
    output,
    errors,
    prompts,
    interrupt: () => { controller.abort(); },
  });
};

describe("token CLI", () => {
  it("uses the exact closed command grammar and canonicalizes EVM address input", () => {
    expect(parseTokenCliCommand([
      "token", "inspect", `0x${tokenAddress.slice(2).toUpperCase()}`, "--block", "123", "--json",
    ])).toEqual({
      kind: "inspect",
      address: tokenAddress,
      block: { kind: "number", blockNumber: "123" },
      json: true,
    });
    expect(parseTokenCliCommand([
      "token", "update", tokenAddress, "--revision", Buffer.alloc(16, 1).toString("base64url"),
      "--clear-label", "--visibility", "hidden",
    ])).toMatchObject({
      kind: "update",
      changes: { userLabel: null, visibility: "hidden" },
    });
    expect(parseTokenCliCommand([
      "token", "register", tokenAddress, "--label", "--leading",
    ])).toMatchObject({ kind: "register", settings: { userLabel: "--leading" } });
    expect(parseTokenCliCommand([
      "token", "update", tokenAddress, "--revision", Buffer.alloc(16, 1).toString("base64url"),
      "--label", "--leading",
    ])).toMatchObject({ kind: "update", changes: { userLabel: "--leading" } });
    for (const invalid of [
      ["token", "inspect", tokenAddress],
      ["token", "register", tokenAddress, "--json"],
      ["token", "update", tokenAddress, "--revision", "bad", "--label", "x", "--clear-label"],
      ["token", "list", "--limit", "26"],
      ["token", "confirm", operationId],
    ]) expect(() => parseTokenCliCommand(invalid)).toThrow();
  });

  it("shows the server review, confirms only through the CLI port, and never asks for a digest", async () => {
    const status = await chainStatusSuccess();
    const operationSet = await operations();
    const runtime = new FakeRuntime((request) => {
      if (request.path === "/api/v1/chain-status") return { status: 200, body: status };
      if (request.path === tokenCatalogControlRoutes.operations) {
        return { status: 200, body: captureCanonicalJson({ operation: operationSet.awaiting }) };
      }
      if (request.path === tokenCatalogControlRoutes.confirmation(operationId)) {
        return { status: 200, body: captureCanonicalJson(operationSet.completed) };
      }
      throw new Error("Unexpected request.");
    });
    const output = outputPort({ confirmationLine: "Y" });
    const command = parseTokenCliCommand(["token", "register", tokenAddress]);

    expect(await runTokenCliCommand(runtime, command, output.port)).toBe(0);
    expect(output.prompts).toEqual(["Confirm this token catalog change? [y/N] "]);
    expect(output.output.join("\n")).toContain("Add token");
    expect(output.output.join("\n")).toContain("Block hash:");
    expect(output.output.join("\n")).toContain("Runtime code hash:");
    expect(output.output.join("\n")).toContain("Evidence coverage: complete");
    expect(output.output.join("\n")).toContain("Token added.");
    expect(output.output.join("\n").match(/Reviewed token inspection/gu)).toHaveLength(1);
    expect(output.output.join("\n")).not.toContain(operationSet.awaiting.review.reviewDigest);
    expect(runtime.requests).toEqual([
      expect.objectContaining({ requestClass: "public_read", method: "GET", path: "/api/v1/chain-status" }),
      {
        requestClass: "local_control",
        method: "POST",
        path: tokenCatalogControlRoutes.operations,
        body: {
          interactionInterface: "cli",
          request: {
            kind: "register",
            asset: tokenAsset,
            settings: { userLabel: null, visibility: "visible" },
          },
        },
      },
      {
        requestClass: "local_control",
        method: "POST",
        path: tokenCatalogControlRoutes.confirmation(operationId),
        body: { reviewDigest: operationSet.awaiting.review.reviewDigest },
      },
    ]);
  });

  it("completes update and unregister through the same exact review and confirmation lifecycle", async () => {
    const status = await chainStatusSuccess();
    const fixture = await existingRegistrationOperations();
    for (const testCase of [
      {
        arguments: [
          "token", "update", tokenAddress, "--revision", fixture.previous.revision,
          "--label", "New label", "--visibility", "hidden",
        ],
        operation: fixture.update,
        outcome: "Token settings updated.",
      },
      {
        arguments: ["token", "unregister", tokenAddress, "--revision", fixture.previous.revision],
        operation: fixture.unregister,
        outcome: "Token removed.",
      },
    ] as const) {
      const runtime = new FakeRuntime((request) => {
        if (request.path === "/api/v1/chain-status") return { status: 200, body: status };
        if (request.path === tokenCatalogControlRoutes.operations) {
          return { status: 200, body: captureCanonicalJson({ operation: testCase.operation.awaiting }) };
        }
        if (request.path === tokenCatalogControlRoutes.confirmation(operationId)) {
          return { status: 200, body: captureCanonicalJson(testCase.operation.completed) };
        }
        throw new Error("Unexpected request.");
      });
      const output = outputPort({ confirmationLine: "y" });
      expect(await runTokenCliCommand(
        runtime,
        parseTokenCliCommand(testCase.arguments),
        output.port,
      )).toBe(0);
      expect(output.prompts).toEqual(["Confirm this token catalog change? [y/N] "]);
      expect(output.output.join("\n")).toContain(testCase.outcome);
      expect(runtime.requests.map((request) => request.path)).toEqual([
        "/api/v1/chain-status",
        tokenCatalogControlRoutes.operations,
        tokenCatalogControlRoutes.confirmation(operationId),
      ]);
    }
  });

  it("cancels the exact started operation on decline or interruption without confirming", async () => {
    for (const input of [
      { confirmationLine: "n" },
      { confirmationLine: "yes" },
      { confirmationLine: " y" },
      { confirmationLine: "y " },
      { confirmationLine: "" },
      { confirmationLine: "y", interruptOnConfirmation: true },
    ] as const) {
      const status = await chainStatusSuccess();
      const operationSet = await operations();
      const runtime = new FakeRuntime((request) => {
        if (request.path === "/api/v1/chain-status") return { status: 200, body: status };
        if (request.path === tokenCatalogControlRoutes.operations) {
          return { status: 200, body: captureCanonicalJson({ operation: operationSet.awaiting }) };
        }
        if (request.method === "DELETE" && request.path === tokenCatalogControlRoutes.operation(operationId)) {
          return { status: 200, body: captureCanonicalJson({ operation: operationSet.cancelled }) };
        }
        throw new Error("Unexpected request.");
      });
      const output = outputPort(input);
      const command = parseTokenCliCommand(["token", "register", tokenAddress]);

      expect(await runTokenCliCommand(runtime, command, output.port)).toBe(0);
      expect(runtime.requests.at(-1)).toMatchObject({
        requestClass: "local_control",
        method: "DELETE",
        path: tokenCatalogControlRoutes.operation(operationId),
      });
      expect(runtime.requests.some((request) => request.path.endsWith("/confirmation"))).toBe(false);
      expect(output.output.join("\n")).toContain("Token catalog change cancelled.");
    }
  });

  it("does not admit a change after pre-start interruption and cancels a start that settles with interruption", async () => {
    const status = await chainStatusSuccess();
    const operationSet = await operations();

    const beforeStartOutput = outputPort({ confirmationLine: "y" });
    const beforeStartRuntime = new FakeRuntime((request) => {
      beforeStartOutput.interrupt();
      return { status: 200, body: status };
    });
    expect(await runTokenCliCommand(
      beforeStartRuntime,
      parseTokenCliCommand(["token", "register", tokenAddress]),
      beforeStartOutput.port,
    )).not.toBe(0);
    expect(beforeStartRuntime.requests).toHaveLength(1);
    expect(beforeStartRuntime.requests[0]?.path).toBe("/api/v1/chain-status");

    const settlingOutput = outputPort({ confirmationLine: "y" });
    const settlingRuntime = new FakeRuntime((request) => {
      if (request.path === "/api/v1/chain-status") return { status: 200, body: status };
      if (request.path === tokenCatalogControlRoutes.operations) {
        settlingOutput.interrupt();
        return { status: 200, body: captureCanonicalJson({ operation: operationSet.awaiting }) };
      }
      if (request.method === "DELETE") {
        return { status: 200, body: captureCanonicalJson({ operation: operationSet.cancelled }) };
      }
      throw new Error("Unexpected request.");
    });
    expect(await runTokenCliCommand(
      settlingRuntime,
      parseTokenCliCommand(["token", "register", tokenAddress]),
      settlingOutput.port,
    )).toBe(0);
    expect(settlingRuntime.requests.map((request) => request.method)).toEqual(["GET", "POST", "DELETE"]);
    expect(settlingRuntime.requests.at(-1)?.path).toBe(tokenCatalogControlRoutes.operation(operationId));
  });

  it("permits non-interactive operation reads and cancellation but rejects every confirmation flow", async () => {
    const operationSet = await operations();
    const runtime = new FakeRuntime((request) => ({
      status: 200,
      body: captureCanonicalJson({
        operation: request.method === "DELETE" ? operationSet.cancelled : operationSet.awaiting,
      }),
    }));
    for (const command of ["operation", "cancel"] as const) {
      const readOutput = outputPort({ inputIsTTY: false, outputIsTTY: false });
      expect(await runTokenCliCommand(
        runtime,
        parseTokenCliCommand(["token", command, operationId, "--json"]),
        readOutput.port,
      )).toBe(0);
      expect(readOutput.output.join("")).toContain(operationId);
    }
    expect(runtime.requests.map((request) => request.method)).toEqual(["GET", "DELETE"]);

    const revision = Buffer.alloc(16, 4).toString("base64url");
    const mutations = [
      ["token", "register", tokenAddress],
      ["token", "update", tokenAddress, "--revision", revision, "--visibility", "hidden"],
      ["token", "unregister", tokenAddress, "--revision", revision],
    ] as const;
    for (const argumentsInput of mutations) {
      for (const terminalState of [
        { inputIsTTY: false, outputIsTTY: true },
        { inputIsTTY: true, outputIsTTY: false },
      ]) {
        const rejectedRuntime = new FakeRuntime(() => { throw new Error("Rejected commands must not dispatch."); });
        const output = outputPort(terminalState);
        expect(await runTokenCliCommand(
          rejectedRuntime,
          parseTokenCliCommand(argumentsInput),
          output.port,
        )).toBe(2);
        expect(output.errors).toEqual([
          "interactive_terminal_required: This command requires an interactive terminal.\n",
        ]);
        expect(rejectedRuntime.requests).toEqual([]);
      }
    }
  });

  it("dispatches each remaining command through its exact request class, route, and body", async () => {
    const status = await chainStatusSuccess();
    const revision = Buffer.alloc(16, 4).toString("base64url");
    const cases = [
      {
        arguments: ["token", "inspect", tokenAddress, "--block", "latest"],
        expected: {
          requestClass: "public_read",
          method: "POST",
          path: "/api/v1/token-inspections",
          body: { asset: tokenAsset, block: { kind: "latest" } },
        },
      },
      {
        arguments: ["token", "get", tokenAddress],
        expected: {
          requestClass: "local_control",
          method: "GET",
          path: tokenCatalogControlRoutes.registration(tokenAsset.chainId, tokenAsset.address),
        },
      },
      {
        arguments: ["token", "list", "--limit", "2", "--cursor", tokenAddress],
        expected: {
          requestClass: "local_control",
          method: "POST",
          path: tokenCatalogControlRoutes.registrationQueries,
          body: { limit: 2, cursor: tokenAddress },
        },
      },
      {
        arguments: ["token", "update", tokenAddress, "--revision", revision, "--visibility", "hidden"],
        expected: {
          requestClass: "local_control",
          method: "POST",
          path: tokenCatalogControlRoutes.operations,
          body: {
            interactionInterface: "cli",
            request: {
              kind: "update_registration",
              asset: tokenAsset,
              expectedRevision: revision,
              changes: { visibility: "hidden" },
            },
          },
        },
      },
      {
        arguments: ["token", "unregister", tokenAddress, "--revision", revision],
        expected: {
          requestClass: "local_control",
          method: "POST",
          path: tokenCatalogControlRoutes.operations,
          body: {
            interactionInterface: "cli",
            request: { kind: "unregister", asset: tokenAsset, expectedRevision: revision },
          },
        },
      },
      {
        arguments: ["token", "cancel", operationId],
        expected: {
          requestClass: "local_control",
          method: "DELETE",
          path: tokenCatalogControlRoutes.operation(operationId),
        },
      },
    ] as const;

    for (const testCase of cases) {
      const runtime = new FakeRuntime((request) => {
        if (request.path === "/api/v1/chain-status") return { status: 200, body: status };
        throw new Error("Stop after capturing the command request.");
      });
      const output = outputPort({ confirmationLine: "y" });
      expect(await runTokenCliCommand(
        runtime,
        parseTokenCliCommand(testCase.arguments),
        output.port,
      )).not.toBe(0);
      expect(runtime.requests.at(-1)).toMatchObject(testCase.expected);
    }
  });

  it("routes token commands through the CLI runtime lifecycle", async () => {
    const operationSet = await operations();
    const runtime = new FakeRuntime(() => ({
      status: 200,
      body: captureCanonicalJson({ operation: operationSet.awaiting }),
    }));
    const output = outputPort({ inputIsTTY: false, outputIsTTY: false });
    let disposed = false;
    const terminal: CliTerminalPort = Object.freeze({
      ...output.port,
      columns: undefined,
      rows: undefined,
      showQr: () => { throw new Error("Token operation read must not show QR."); },
      hideQr: () => { throw new Error("Token operation read must not hide QR."); },
      dispose: () => { disposed = true; },
    });

    expect(await runCli(["token", "operation", operationId, "--json"], {
      createRuntime: async () => runtime,
      terminal,
      waitForPoll: async () => undefined,
      terminateProcess: () => undefined,
    })).toBe(0);
    expect(runtime.startCount).toBe(1);
    expect(runtime.stopCount).toBe(1);
    expect(disposed).toBe(true);
    expect(output.output.join("")).toContain(operationId);
  });
});
