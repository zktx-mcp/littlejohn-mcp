// @vitest-environment jsdom

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type CanonicalJson,
} from "../../../src/core/client.js";
import {
  createOperationToolResultDescriptor,
  createWalletOperationQrMetadata,
  operationToolResultMetadataKey,
  walletOperationQrMetadataKey,
} from "../../../src/interfaces/mcp-app/contracts.js";
import { presentationContracts } from "../../../src/interfaces/mcp-app/registry.js";
import { createDeliveryUnknown } from "../../../src/interfaces/operation-delivery.js";
import {
  mountOperationReview,
  type OperationViewApp,
} from "../../../src/interfaces/mcp-app/view/operation-lifecycle.js";
import {
  renderPresentation,
} from "../../../src/interfaces/mcp-app/view/renderers.js";
import { operationToolContracts } from "../../../src/interfaces/operation-tool-contracts.js";
import {
  parseWalletManagementOperation,
  parseWalletReview,
  walletOperationIdByteLength,
  walletReviewDigest,
} from "../../../src/wallet/contracts.js";
import { createWalletFailure } from "../../../src/wallet/errors.js";
import { walletManagementContracts } from "../../../src/wallet/management-contracts.js";

const createdAt = "2026-08-12T00:00:00.000Z";
const actionExpiresAt = "2026-08-12T00:05:00.000Z";
const operationId = Buffer.alloc(walletOperationIdByteLength, 17).toString("base64url");

const reviewWithoutDigest = Object.freeze({
  contractVersion: "1" as const,
  domain: "wallet" as const,
  operationId,
  kind: "connect" as const,
  createdAt,
  actionExpiresAt,
  target: { chainId: "eip155:4663" as const },
  decision: {
    requiredMethods: ["eth_sendTransaction"] as const,
    optionalMethods: ["personal_sign", "eth_signTypedData_v4"] as const,
    requiredEvents: ["accountsChanged", "chainChanged"] as const,
  },
  precondition: {
    connectionRevision: "0",
    connection: { status: "disconnected" as const, reason: "no_session" as const },
  },
  fixedEvidence: { sessionSourceIds: [] as const },
});

const review = parseWalletReview({
  ...reviewWithoutDigest,
  reviewDigest: walletReviewDigest(reviewWithoutDigest),
});
const reviewResult = walletManagementContracts.review.parsePublicSuccess(
  { kind: "connect" },
  { status: "review", review },
);
const admittedReview = Object.freeze({
  entry: presentationContracts.walletReview,
  normalizedInput: captureCanonicalJson({ kind: "connect" }),
  result: captureCanonicalJson(reviewResult),
});
const noDecisionResult = walletManagementContracts.review.parsePublicSuccess(
  { kind: "disconnect" },
  {
    status: "already_disconnected",
    connectionRevision: "0",
    connection: { status: "disconnected", reason: "no_session" },
  },
);
const admittedNoDecision = Object.freeze({
  entry: presentationContracts.walletReview,
  normalizedInput: captureCanonicalJson({ kind: "disconnect" }),
  result: captureCanonicalJson(noDecisionResult),
});

const activeOperation = parseWalletManagementOperation({
  contractVersion: "1",
  domain: "wallet",
  operationId,
  kind: "connect",
  initiatedBy: "mcp_app",
  review,
  state: "awaiting_wallet_approval",
  terminationTarget: null,
  result: null,
  failure: null,
  peerRefusalCode: null,
});
const terminalOperation = parseWalletManagementOperation({
  ...activeOperation,
  state: "completed",
  result: {
    outcome: "connected",
    connectionRevision: "1",
    connection: {
      status: "connected",
      address: "0x1111111111111111111111111111111111111111",
      chainId: "eip155:4663",
      approvedMethods: ["eth_sendTransaction"],
      approvedEvents: ["accountsChanged", "chainChanged"],
      expiresAt: "2026-08-13T00:00:00.000Z",
    },
  },
});
const qr = {
  size: 21,
  rows: Array.from({ length: 21 }, (_, index) =>
    index === 0 ? `1${"0".repeat(20)}` : "0".repeat(21)),
};

type ToolCall = Readonly<{ name: string; argumentsValue: Record<string, unknown> }>;

const app = (input: Readonly<{
  serverTools: boolean;
  calls: ToolCall[];
  hostName?: string;
  result?: (call: ToolCall) => CallToolResult | Promise<CallToolResult>;
}>): OperationViewApp => ({
  getHostCapabilities: () => input.serverTools ? { serverTools: {} } : {},
  getHostVersion: () => ({ name: input.hostName ?? "standard-host", version: "1.0.0" }),
  readServerResource: async () => { throw new TypeError("Unexpected resource read."); },
  callServerTool: async ({ name, arguments: argumentsValue }) => {
    const call = Object.freeze({ name, argumentsValue: argumentsValue ?? {} });
    input.calls.push(call);
    if (input.result === undefined) throw new TypeError("Unexpected tool call.");
    return await input.result(call);
  },
  requestTeardown: async () => ({}),
});

const article = (): HTMLElement => renderPresentation(
  presentationContracts.walletReview,
  admittedReview.result,
).node;

const toolResult = (value: unknown, extra: Partial<CallToolResult> = {}): CallToolResult => ({
  content: [{
    type: "text",
    text: canonicalJsonStringify(captureCanonicalJson(value)),
  }],
  structuredContent: captureCanonicalJson(value) as Record<string, unknown>,
  ...extra,
});

const withoutObjectNullProperties = (value: CanonicalJson): CanonicalJson => {
  if (Array.isArray(value)) return value.map(withoutObjectNullProperties);
  if (value === null || typeof value !== "object") return value;
  return captureCanonicalJson(Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== null)
    .map(([key, entry]) => [key, withoutObjectNullProperties(entry)])));
};

const codexToolResult = (
  call: ToolCall,
  value: unknown,
  extra: Partial<CallToolResult> = {},
): CallToolResult => {
  const canonical = captureCanonicalJson(value);
  const isError = extra.isError === true;
  return toolResult(canonical, {
    ...extra,
    structuredContent: withoutObjectNullProperties(canonical) as Record<string, unknown>,
    _meta: {
      ...extra._meta,
      [operationToolResultMetadataKey]: createOperationToolResultDescriptor({
        toolName: call.name,
        normalizedInput: call.argumentsValue,
        result: canonical,
        isError,
      }),
    },
  });
};

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP App operation lifecycle", () => {
  it("terminates a no-op Review without creating App authority", async () => {
    const calls: ToolCall[] = [];
    const card = renderPresentation(
      presentationContracts.walletReview,
      admittedNoDecision.result,
    ).node;

    expect(await mountOperationReview(
      app({ serverTools: true, calls }),
      admittedNoDecision,
      card,
      new AbortController().signal,
    )).toBe(true);

    expect(calls).toEqual([]);
    expect(card.textContent).toContain("No decision required");
    expect(card.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps a fixed Review read-only when the Host has no App tool capability", async () => {
    const calls: ToolCall[] = [];
    const card = article();

    expect(await mountOperationReview(
      app({ serverTools: false, calls }),
      admittedReview,
      card,
      new AbortController().signal,
    )).toBe(true);

    expect(calls).toEqual([]);
    expect(card.textContent).toContain("Direct controls unavailable");
    expect(card.querySelectorAll("button")).toHaveLength(0);
  });

  it("reads only the reserved operation before exposing one fixed decision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdAt));
    const calls: ToolCall[] = [];
    const card = article();

    await mountOperationReview(app({
      serverTools: true,
      calls,
      result: () => toolResult(createWalletFailure("wallet_operation_not_found"), { isError: true }),
    }), admittedReview, card, new AbortController().signal);

    expect(calls).toEqual([{
      name: operationToolContracts.walletOperation.mcp.name,
      argumentsValue: { operationId },
    }]);
    expect([...card.querySelectorAll("button")].map((button) => button.textContent))
      .toEqual(["Connect wallet", "Dismiss"]);
  });

  it("uses one Review, exposes QR only while active, and stops exact reads at terminal state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdAt));
    const calls: ToolCall[] = [];
    const card = article();
    let exactReads = 0;

    await mountOperationReview(app({
      serverTools: true,
      hostName: "chatgpt",
      calls,
      result: (call) => {
        if (call.name === operationToolContracts.walletOperation.mcp.name) {
          exactReads += 1;
          return exactReads === 1
            ? codexToolResult(
                call,
                createWalletFailure("wallet_operation_not_found"),
                { isError: true },
              )
            : codexToolResult(call, terminalOperation);
        }
        if (call.name === operationToolContracts.walletConnect.mcp.name) {
          return codexToolResult(call, activeOperation, {
            _meta: {
              [walletOperationQrMetadataKey]: createWalletOperationQrMetadata(
                activeOperation,
                qr,
              ),
            },
          });
        }
        throw new TypeError(`Unexpected operation tool ${call.name}.`);
      },
    }), admittedReview, card, new AbortController().signal);

    const accept = [...card.querySelectorAll("button")]
      .find((button) => button.textContent === "Connect wallet");
    if (accept === undefined) throw new TypeError("Wallet decision control is missing.");
    accept.click();
    await settle();

    expect(calls[1]).toEqual({
      name: operationToolContracts.walletConnect.mcp.name,
      argumentsValue: { review, initiatedBy: "mcp_app" },
    });
    expect(card.querySelector('svg[aria-label="Active WalletConnect pairing code"]'))
      .not.toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(calls[2]).toEqual({
      name: operationToolContracts.walletOperation.mcp.name,
      argumentsValue: { operationId },
    });
    expect(card.textContent).toContain("Wallet connected");
    expect(card.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(3);
  });

  it("ignores QR metadata whose digest does not bind the admitted active operation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdAt));
    const calls: ToolCall[] = [];
    const card = article();
    const controller = new AbortController();

    await mountOperationReview(app({
      serverTools: true,
      calls,
      result: (call) => {
        if (call.name === operationToolContracts.walletOperation.mcp.name) {
          return toolResult(createWalletFailure("wallet_operation_not_found"), { isError: true });
        }
        if (call.name === operationToolContracts.walletConnect.mcp.name) {
          return toolResult(activeOperation, {
            _meta: {
              [walletOperationQrMetadataKey]: {
                ...createWalletOperationQrMetadata(activeOperation, qr),
                resultSha256: "0".repeat(64),
              },
            },
          });
        }
        throw new TypeError(`Unexpected operation tool ${call.name}.`);
      },
    }), admittedReview, card, controller.signal);

    const accept = [...card.querySelectorAll("button")]
      .find((button) => button.textContent === "Connect wallet");
    if (accept === undefined) throw new TypeError("Wallet decision control is missing.");
    accept.click();
    await settle();

    expect(card.textContent).toContain("Waiting for approval in the external wallet");
    expect(card.querySelector('svg[aria-label="Active WalletConnect pairing code"]')).toBeNull();
    controller.abort();
  });

  it("stops controls on a Codex result change other than object-null omission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdAt));
    const calls: ToolCall[] = [];
    const card = article();

    await mountOperationReview(app({
      serverTools: true,
      hostName: "chatgpt",
      calls,
      result: (call) => {
        if (call.name === operationToolContracts.walletOperation.mcp.name) {
          return toolResult(createWalletFailure("wallet_operation_not_found"), { isError: true });
        }
        if (call.name === operationToolContracts.walletConnect.mcp.name) {
          const raw = codexToolResult(call, activeOperation);
          return {
            ...raw,
            structuredContent: {
              ...(raw.structuredContent ?? {}),
              state: "failed",
            },
          };
        }
        throw new TypeError(`Unexpected operation tool ${call.name}.`);
      },
    }), admittedReview, card, new AbortController().signal);

    const accept = [...card.querySelectorAll("button")]
      .find((button) => button.textContent === "Connect wallet");
    if (accept === undefined) throw new TypeError("Wallet decision control is missing.");
    accept.click();
    await settle();

    expect(card.textContent).toContain(
      "Little John could not verify this operation result. No action was repeated.",
    );
    expect(card.textContent).not.toContain("invalid_union");
    expect(card.querySelectorAll("button")).toHaveLength(0);
  });

  it("requires an exact read before restoring a Review whose action was not admitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdAt));
    const calls: ToolCall[] = [];
    const card = article();

    await mountOperationReview(app({
      serverTools: true,
      calls,
      result: (call) => {
        if (call.name === operationToolContracts.walletOperation.mcp.name) {
          return toolResult(createWalletFailure("wallet_operation_not_found"), { isError: true });
        }
        if (call.name === operationToolContracts.walletConnect.mcp.name) {
          return toolResult({
            delivery: createDeliveryUnknown("decide", operationId),
            recovery: {
              arguments: { operationId },
              tool: operationToolContracts.walletOperation.mcp.name,
            },
          }, { isError: true });
        }
        throw new TypeError(`Unexpected operation tool ${call.name}.`);
      },
    }), admittedReview, card, new AbortController().signal);

    const accept = [...card.querySelectorAll("button")]
      .find((button) => button.textContent === "Connect wallet");
    if (accept === undefined) throw new TypeError("Wallet decision control is missing.");
    accept.click();
    await settle();

    expect(card.textContent).toContain("Do not repeat the action");
    const retry = [...card.querySelectorAll("button")]
      .find((button) => button.textContent === "Read exact operation again");
    if (retry === undefined) throw new TypeError("Exact operation recovery control is missing.");
    retry.click();
    await settle();

    expect(calls.map((call) => call.name)).toEqual([
      operationToolContracts.walletOperation.mcp.name,
      operationToolContracts.walletConnect.mcp.name,
      operationToolContracts.walletOperation.mcp.name,
    ]);
    expect(card.textContent).not.toContain("Do not repeat the action");
    expect([...card.querySelectorAll("button")].map((button) => button.textContent))
      .toEqual(["Connect wallet", "Dismiss"]);
  });
});
