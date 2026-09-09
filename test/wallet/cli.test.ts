import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  runCli,
  type CliDependencies,
  type CliRuntimePort,
  type CliTerminalPort,
} from "../../src/cli.js";
import { operationControlResources } from "../../src/interfaces/operation-bindings.js";
import {
  runtimeReleased,
  type RuntimeShutdownOutcome,
} from "../../src/runtime/shutdown.js";
import type {
  RuntimeDispatchRequest,
  RuntimeDispatchResponse,
} from "../../src/runtime/index.js";
import {
  parseWalletManagementOperation,
  parseWalletReview,
  walletReviewDigest,
  type WalletManagementOperation,
  type WalletReview,
} from "../../src/wallet/contracts.js";
import { walletInterfaceErrorMappings } from "../../src/wallet/errors.js";
import type { TerminalQrRendering } from "../../src/wallet/terminal-qr.js";
import { openTestOwnerSession } from "../interfaces/owner-session-harness.js";

const operationId = Buffer.alloc(32, 21).toString("base64url");
const sourceId = `wallet-session:${Buffer.alloc(32, 22).toString("base64url")}`;
const disconnected = Object.freeze({ status: "disconnected" as const, reason: "no_session" as const });
const connected = Object.freeze({
  status: "connected" as const,
  address: "0x1111111111111111111111111111111111111111",
  chainId: "eip155:4663",
  approvedMethods: Object.freeze(["eth_sendTransaction"]),
  approvedEvents: Object.freeze(["accountsChanged", "chainChanged"]),
  expiresAt: "2026-07-15T00:00:00.000Z",
});
const qr = Object.freeze({
  size: 21,
  rows: Object.freeze(Array.from({ length: 21 }, (_unused, row) =>
    Array.from({ length: 21 }, (_other, column) => (row + column) % 2 === 0 ? "1" : "0").join(""))),
});

const review = (kind: "connect" | "disconnect"): WalletReview => {
  const common = {
    contractVersion: "1" as const,
    domain: "wallet" as const,
    operationId,
    createdAt: "2026-07-14T00:00:00.000Z",
    actionExpiresAt: "2026-07-14T00:05:00.000Z",
    target: { chainId: "eip155:4663" },
  };
  const withoutDigest = kind === "connect"
    ? {
        ...common,
        kind,
        decision: {
          requiredMethods: ["eth_sendTransaction"] as const,
          requiredEvents: ["accountsChanged", "chainChanged"] as const,
        },
        precondition: { connectionRevision: "3", connection: disconnected },
        fixedEvidence: { sessionSourceIds: [] as const },
      }
    : {
        ...common,
        kind,
        decision: { action: "disconnect_session" as const },
        precondition: { connectionRevision: "3", connection: connected },
        fixedEvidence: { sessionSourceIds: [sourceId] as const },
      };
  return parseWalletReview({ ...withoutDigest, reviewDigest: walletReviewDigest(withoutDigest) });
};

const operation = (
  kind: "connect" | "disconnect",
  state: WalletManagementOperation["state"],
): WalletManagementOperation => {
  const admittedReview = review(kind);
  return parseWalletManagementOperation({
    contractVersion: "1",
    domain: "wallet",
    operationId,
    kind,
    initiatedBy: "cli",
    review: admittedReview,
    state,
    terminationTarget: state === "cancelling" ? "cancelled" : null,
    result: state === "completed"
      ? kind === "connect"
        ? { outcome: "connected", connectionRevision: "4", connection: connected }
        : {
            outcome: "disconnected",
            connectionRevision: "4",
            connection: { status: "disconnected", reason: "disconnected" },
          }
      : null,
    failure: null,
    peerRefusalCode: state === "rejected" ? 5000 : null,
  });
};

const successResponse = (body: unknown): RuntimeDispatchResponse => Object.freeze({
  status: 200,
  body: captureCanonicalJson(body),
});

class FakeRuntime implements CliRuntimePort {
  readonly ownerState: CliRuntimePort["ownerState"] = "deferred";
  readonly requests: RuntimeDispatchRequest[] = [];
  readonly #handle: (request: RuntimeDispatchRequest) =>
    RuntimeDispatchResponse | Promise<RuntimeDispatchResponse>;
  startCount = 0;
  stopCount = 0;

  constructor(handle: (request: RuntimeDispatchRequest) =>
    RuntimeDispatchResponse | Promise<RuntimeDispatchResponse>) {
    this.#handle = handle;
  }

  async start(): Promise<void> { this.startCount += 1; }

  presentationSnapshotStore(): never {
    throw new Error("Wallet CLI must not request the MCP snapshot store.");
  }

  async dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    this.requests.push(Object.freeze({ ...request }));
    return await this.#handle(request);
  }

  openOwnerSession(signal?: AbortSignal) { return openTestOwnerSession(this, signal); }

  async stop(): Promise<RuntimeShutdownOutcome> {
    this.stopCount += 1;
    return runtimeReleased;
  }
}

interface FakeTerminal {
  readonly terminal: CliTerminalPort;
  readonly output: string[];
  readonly errors: string[];
  readonly prompts: string[];
  readonly qrEvents: string[];
}

const fakeTerminal = (input: Readonly<{
  inputIsTTY?: boolean;
  outputIsTTY?: boolean;
  answer?: string;
}> = {}): FakeTerminal => {
  const output: string[] = [];
  const errors: string[] = [];
  const prompts: string[] = [];
  const qrEvents: string[] = [];
  const controller = new AbortController();
  return Object.freeze({
    output,
    errors,
    prompts,
    qrEvents,
    terminal: Object.freeze({
      inputIsTTY: input.inputIsTTY ?? true,
      outputIsTTY: input.outputIsTTY ?? true,
      columns: 120,
      rows: 80,
      interruptSignal: controller.signal,
      writeOutput(value: string): void { output.push(value); },
      writeError(value: string): void { errors.push(value); },
      showQr(_rendering: TerminalQrRendering): void { qrEvents.push("show"); },
      hideQr(): void { qrEvents.push("hide"); },
      async readLine(prompt: string): Promise<string> {
        prompts.push(prompt);
        return input.answer ?? "n";
      },
      dispose(): void { qrEvents.push("dispose"); },
    }),
  });
};

const dependencies = (
  runtime: FakeRuntime,
  terminal: FakeTerminal,
): CliDependencies => Object.freeze({
  createRuntime: async () => runtime,
  terminal: terminal.terminal,
  waitForPoll: async () => undefined,
  createMcp: () => { throw new Error("Wallet CLI must not create MCP."); },
});

const bodyOf = (request: RuntimeDispatchRequest): CanonicalJson | undefined =>
  request.method === "POST" ? request.body : undefined;

describe("wallet CLI final operation projection", () => {
  it("requires an interactive terminal before creating runtime or a Review", async () => {
    let runtimeCreated = false;
    const runtime = new FakeRuntime(() => { throw new Error("must not dispatch"); });
    const terminal = fakeTerminal({ inputIsTTY: false });
    const result = await runCli(["wallet", "connect"], {
      ...dependencies(runtime, terminal),
      createRuntime: async () => {
        runtimeCreated = true;
        return runtime;
      },
    });

    expect(result.exitCode).toBe(walletInterfaceErrorMappings.get("interactive_terminal_required").cliExitCode);
    expect(runtimeCreated).toBe(false);
    expect(runtime.requests).toEqual([]);
  });

  it("prints the complete immutable Review and decline creates no operation", async () => {
    const admittedReview = review("disconnect");
    const runtime = new FakeRuntime((request) => {
      expect(request.path).toBe(operationControlResources.wallet.reviews);
      return successResponse({ status: "review", review: admittedReview });
    });
    const terminal = fakeTerminal({ answer: "no" });

    const result = await runCli(["wallet", "disconnect"], dependencies(runtime, terminal));
    expect(result.exitCode).toBe(0);
    expect(runtime.requests).toHaveLength(1);
    expect(bodyOf(runtime.requests[0]!)).toEqual({ kind: "disconnect" });
    expect(terminal.output.join("\n")).toContain(`Review digest: ${admittedReview.reviewDigest}`);
    expect(terminal.output.join("\n")).toContain("Declined. No Wallet operation was created.");
  });

  it("uses the same Review/action owner, presents active QR, and observes only the exact operation", async () => {
    const admittedReview = review("connect");
    const awaiting = operation("connect", "awaiting_wallet_approval");
    const rejected = operation("connect", "rejected");
    let presentationReads = 0;
    const runtime = new FakeRuntime((request) => {
      if (request.path === operationControlResources.wallet.reviews) {
        return successResponse({ status: "review", review: admittedReview });
      }
      if (request.path === operationControlResources.wallet.decisions) return successResponse(awaiting);
      if (request.path === operationControlResources.wallet.presentation(operationId)) {
        presentationReads += 1;
        return successResponse(presentationReads === 1
          ? { operation: awaiting, qr }
          : { operation: rejected });
      }
      throw new Error(`Unexpected request ${request.method} ${request.path}`);
    });
    const terminal = fakeTerminal({ answer: "y" });

    const result = await runCli(["wallet", "connect"], dependencies(runtime, terminal));
    expect(result.exitCode).toBe(walletInterfaceErrorMappings.get("wallet_user_rejected").cliExitCode);
    expect(runtime.requests.map(({ path }) => path)).toEqual([
      operationControlResources.wallet.reviews,
      operationControlResources.wallet.decisions,
      operationControlResources.wallet.presentation(operationId),
      operationControlResources.wallet.presentation(operationId),
    ]);
    expect(bodyOf(runtime.requests[1]!)).toEqual({ review: admittedReview, initiatedBy: "cli" });
    expect(terminal.qrEvents).toEqual(["show", "hide", "dispose"]);
    expect(terminal.errors.join("")).toContain("wallet_user_rejected");
  });

  it("redraws a fitting resized QR and withdraws it below either dimension without changing its operation", async () => {
    const awaiting = operation("connect", "awaiting_wallet_approval");
    const rejected = operation("connect", "rejected");
    // The 21-module matrix and four-module quiet zone require 30 columns
    // (including the spare column) and 15 rows at two vertical modules per cell.
    const sizes = [[40, 20], [40, 20], [50, 25], [29, 25], [50, 14], [30, 15]] as const;
    let current = 0;
    let presentationReads = 0;
    const runtime = new FakeRuntime((request) => {
      if (request.path === operationControlResources.wallet.reviews) return successResponse({ status: "review", review: review("connect") });
      if (request.path === operationControlResources.wallet.decisions) return successResponse(awaiting);
      if (request.path === operationControlResources.wallet.presentation(operationId)) {
        current = presentationReads++;
        return successResponse(current < sizes.length ? { operation: awaiting, qr } : { operation: rejected });
      }
      throw new Error(`Unexpected request ${request.path}`);
    });
    const captured = fakeTerminal({ answer: "y" });
    const observed: string[] = [];
    const terminal: FakeTerminal = { ...captured, terminal: {
      ...captured.terminal,
      get columns() { return sizes[Math.min(current, sizes.length - 1)]![0]; },
      get rows() { return sizes[Math.min(current, sizes.length - 1)]![1]; },
      showQr(rendering) { expect(rendering.minimum).toEqual({ columns: 30, rows: 15 }); observed.push(`show:${current}`); },
      hideQr() { observed.push(`hide:${current}`); },
    } };
    const result = await runCli(["wallet", "connect"], dependencies(runtime, terminal));
    expect(result.exitCode).toBe(walletInterfaceErrorMappings.get("wallet_user_rejected").cliExitCode);
    expect(observed).toEqual(["show:0", "show:2", "hide:3", "show:5", "hide:6"]);
    expect(captured.output.join("")).toContain("Minimum terminal dimensions for this QR: 30 columns x 15 rows");
    expect(runtime.requests.filter(request => request.path === operationControlResources.wallet.decisions)).toHaveLength(1);
    expect(runtime.requests.every(request => [operationControlResources.wallet.reviews,
      operationControlResources.wallet.decisions, operationControlResources.wallet.presentation(operationId)].includes(request.path))).toBe(true);
  });

  it("cancels only after exact read and sends the complete correlation tuple", async () => {
    const awaiting = operation("connect", "awaiting_wallet_approval");
    const cancelled = operation("connect", "cancelled");
    const runtime = new FakeRuntime((request) => {
      if (request.path === operationControlResources.wallet.operation(operationId)) {
        return successResponse(awaiting);
      }
      if (request.path === operationControlResources.wallet.cancellation(operationId)) {
        return successResponse(cancelled);
      }
      throw new Error(`Unexpected request ${request.path}`);
    });
    const terminal = fakeTerminal({ answer: "y" });

    const result = await runCli(["wallet", "cancel", operationId], dependencies(runtime, terminal));
    expect(result.exitCode).toBe(0);
    expect(runtime.requests.map(({ path }) => path)).toEqual([
      operationControlResources.wallet.operation(operationId),
      operationControlResources.wallet.cancellation(operationId),
    ]);
    expect(bodyOf(runtime.requests[1]!)).toEqual({
      operationId,
      reviewDigest: awaiting.review.reviewDigest,
      expectedState: "awaiting_wallet_approval",
      connectionRevision: awaiting.review.precondition.connectionRevision,
    });
    expect(terminal.output.join("")).toContain(`Wallet operation ${operationId}: cancelled`);
  });

  it("renders an exact durable terminal operation as lossless canonical JSON", async () => {
    const completed = operation("disconnect", "completed");
    const runtime = new FakeRuntime((request) => {
      expect(request.path).toBe(operationControlResources.wallet.operation(operationId));
      return successResponse(completed);
    });
    const terminal = fakeTerminal();

    const result = await runCli(
      ["wallet", "operation", operationId, "--json"],
      dependencies(runtime, terminal),
    );
    expect(result.exitCode).toBe(0);
    expect(terminal.output).toEqual([`${canonicalJsonStringify(completed as unknown as CanonicalJson)}\n`]);
  });

  it("does not resend a decision when its response and exact recovery read are unavailable", async () => {
    const admittedReview = review("disconnect");
    let decisionCalls = 0;
    const runtime = new FakeRuntime((request) => {
      if (request.path === operationControlResources.wallet.reviews) {
        return successResponse({ status: "review", review: admittedReview });
      }
      if (request.path === operationControlResources.wallet.decisions) {
        decisionCalls += 1;
        throw new Error("response unavailable after send");
      }
      if (request.path === operationControlResources.wallet.operation(operationId)) {
        throw new Error("exact recovery unavailable");
      }
      throw new Error(`Unexpected request ${request.path}`);
    });
    const terminal = fakeTerminal({ answer: "y" });

    const result = await runCli(["wallet", "disconnect"], dependencies(runtime, terminal));
    expect(result.exitCode).toBe(8);
    expect(decisionCalls).toBe(1);
    expect(runtime.requests.map(({ path }) => path)).toEqual([
      operationControlResources.wallet.reviews,
      operationControlResources.wallet.decisions,
      operationControlResources.wallet.operation(operationId),
    ]);
    expect(terminal.errors.join("")).toContain("Do not repeat it.");
  });
});
