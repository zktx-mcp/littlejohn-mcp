import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type CanonicalJson,
} from "../../../src/core/client.js";
import {
  createOperationToolResultDescriptor,
  operationToolResultEvidence,
  operationToolResultLimits,
  operationToolResultMetadataKey,
} from "../../../src/interfaces/mcp-app/contracts.js";
import { admitMcpToolResultForDelivery } from "../../../src/interfaces/mcp-result.js";
import {recoverCodexOperationToolResult} from "../../../src/interfaces/mcp-app/view/codex-operation-result-adapter.js";
import { admitToolReply, applicationIssue } from "../../../src/interfaces/mcp-app/view/tool-result.js";
import { createMcpToolResult, maximumMcpToolResultUtf8Bytes } from "../../../src/interfaces/mcp-result.js";
import { activityToolContracts } from "../../../src/interfaces/exchange-tool-contracts.js";
import { signingToolContracts } from "../../../src/interfaces/signing-tool-contracts.js";

const toolName = "wallet_get_operation";
const normalizedInput = captureCanonicalJson({ operationId: "fixed-operation" });
const complete = captureCanonicalJson({
  kind: "operation",
  topLevelAbsent: null,
  nested: { absent: null, label: "transport €" },
  sequence: ["alpha", null, { absent: null, label: "omega" }],
});

const delivered = captureCanonicalJson({
  kind: "operation",
  nested: { label: "transport €" },
  sequence: ["alpha", null, { label: "omega" }],
});

const canonicalObjectAtBytes = (byteLength: number): CanonicalJson => {
  const empty = captureCanonicalJson({ payload: "" });
  const overhead = Buffer.byteLength(canonicalJsonStringify(empty), "utf8");
  return captureCanonicalJson({ payload: "x".repeat(byteLength - overhead) });
};

const rawResult = (structuredContent: CanonicalJson): CallToolResult => ({
  content: [{ type: "text", text: canonicalJsonStringify(complete) }],
  structuredContent: structuredContent as Record<string, unknown>,
  _meta: {
    [operationToolResultMetadataKey]: createOperationToolResultDescriptor({
      toolName,
      normalizedInput,
      result: complete,
      isError: false,
    }),
  },
});

describe("Codex operation-result transport adapter", () => {
  const lookup = activityToolContracts.get;
  const lookupInput = lookup.contract.parseInput({ account: { chainId: "eip155:4663", address: `0x${"11".repeat(20)}` },
    transactionHash: `0x${"22".repeat(32)}` });
  const lookupContext = { toolName: lookup.mcp.name, inputEvidence: operationToolResultEvidence(lookupInput) };
  const lookupOwner = {
    success: (value: CanonicalJson) => lookup.contract.parsePublicSuccess(lookupInput, value),
    failure: (value: CanonicalJson) => applicationIssue(lookup.contract.parseFailure(value)),
  };
  const absentResult = (): CallToolResult => ({ ...createMcpToolResult(lookup.mcp.name, null, false),
    _meta: { [operationToolResultMetadataKey]: createOperationToolResultDescriptor({
      toolName: lookup.mcp.name, normalizedInput: lookupInput, result: null, isError: false,
    }) },
  });

  it("admits standard nullable carriage first and recovers only the measured null-elided envelope", () => {
    const standard = absentResult();
    expect(admitToolReply({ ...standard, content: [] }, { ...lookupContext, hostName: "standard" }, lookupOwner))
      .toEqual({ ok: true, value: null });
    const elided = { ...standard, structuredContent: {} };
    expect(admitToolReply(elided, { ...lookupContext, hostName: "chatgpt" }, lookupOwner))
      .toEqual({ ok: true, value: null });
    expect(() => admitToolReply(elided, { ...lookupContext, hostName: "Claude" }, lookupOwner)).toThrow("standard admission");
    for (const value of [null, {}, { value: null, extra: true }]) {
      expect(() => admitToolReply({ ...standard, structuredContent: value as unknown as Record<string, unknown> },
        { ...lookupContext, hostName: "standard" }, lookupOwner)).toThrow();
    }
  });

  it("returns the owner-admitted signing object from its direct null-elided result", () => {
    const binding = signingToolContracts.get;
    const input = binding.contract.parseInput({ operationId: Buffer.alloc(32, 1).toString("base64url") });
    const canonical = { operationId: input.operationId, review: null };
    const result = createMcpToolResult(binding.mcp.name, canonical, false);
    result._meta = { [operationToolResultMetadataKey]: createOperationToolResultDescriptor({
      toolName: binding.mcp.name, normalizedInput: input, result: canonical, isError: false,
    }) };
    result.structuredContent = { operationId: input.operationId };
    expect(admitToolReply(result, { hostName: "chatgpt", toolName: binding.mcp.name,
      inputEvidence: operationToolResultEvidence(input) }, {
      success: (value) => binding.contract.parsePublicSuccess(input, value),
      failure: (value) => applicationIssue(binding.contract.parseFailure(value)),
    })).toEqual({ ok: true, value: canonical });
  });

  it("rejects a whole-result wrapper instead of selecting its intact nested text", () => {
    const original = absentResult();
    const wrapper = { ...original, structuredContent: { value: false } };
    const result = { ...original, structuredContent: {}, content: [{ type: "text" as const,
      text: canonicalJsonStringify(captureCanonicalJson(wrapper)) }] };
    expect(() => admitToolReply(result, { ...lookupContext, hostName: "chatgpt" }, lookupOwner))
      .toThrow("nullable MCP success envelope is invalid");
  });

  it("rejects oversized UTF-8 canonical text before JSON parsing", () => {
    const result = absentResult();
    const text = canonicalJsonStringify(captureCanonicalJson({
      value: "€".repeat(Math.ceil(maximumMcpToolResultUtf8Bytes / 3)),
    }));
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(maximumMcpToolResultUtf8Bytes);
    expect(text.length).toBeLessThan(maximumMcpToolResultUtf8Bytes);
    result.structuredContent = {};
    result.content = [{ type: "text", text }];
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(() => admitToolReply(result, { ...lookupContext, hostName: "chatgpt" }, lookupOwner))
        .toThrow("text exceeds its source bound");
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });

  it.each([
    ["tool", { toolName: "exchange_get_review" }],
    ["input", { inputSha256: "f".repeat(64) }],
    ["result", { resultSha256: "f".repeat(64) }],
    ["wire digest", { resultUtf8Bytes: 14, resultSha256: operationToolResultEvidence({ value: null }).sha256 }],
    ["error meaning", { isError: true }],
  ] as const)("rejects a nullable recovery with changed %s evidence", (_label, change) => {
    const result = absentResult();
    const descriptor = result._meta![operationToolResultMetadataKey] as Record<string, unknown>;
    result.structuredContent = {};
    result._meta = { [operationToolResultMetadataKey]: { ...descriptor, ...change } };
    expect(() => admitToolReply(result, { ...lookupContext, hostName: "chatgpt" }, lookupOwner)).toThrow();
  });

  it("admits descriptor input and result only through their transport owners", () => {
    expect(operationToolResultLimits).toEqual({
      inputBytes: 65_536,
      resultBytes: 65_535,
    });

    const exactResult = canonicalObjectAtBytes(65_535);
    const descriptor = createOperationToolResultDescriptor({
      toolName,
      normalizedInput: canonicalObjectAtBytes(65_536),
      result: exactResult,
      isError: false,
    });
    expect(descriptor).toMatchObject({ toolName, isError: false });
    expect(admitMcpToolResultForDelivery({
      structuredContent: exactResult as Record<string, unknown>,
      content: [{ type: "text", text: canonicalJsonStringify(exactResult) }],
      _meta: { [operationToolResultMetadataKey]: descriptor },
    }).status).toBe("admitted");

    expect(() => createOperationToolResultDescriptor({
      toolName,
      normalizedInput: canonicalObjectAtBytes(65_537),
      result: complete,
      isError: false,
    })).toThrow();
    expect(() => createOperationToolResultDescriptor({
      toolName,
      normalizedInput,
      result: canonicalObjectAtBytes(65_536),
      isError: false,
    })).toThrow();
  });

  it("reverses only recursive object-null omission while preserving array null positions", () => {
    expect(recoverCodexOperationToolResult({
      hostName: "chatgpt",
      toolName,
      inputEvidence: operationToolResultEvidence(normalizedInput),
      result: rawResult(delivered),
    })).toEqual(complete);
  });

  it("rejects a non-null value change instead of repairing from schema knowledge", () => {
    const changed = captureCanonicalJson({
      kind: "operation",
      nested: { label: "changed" },
      sequence: ["alpha", null, { label: "omega" }],
    });
    expect(() => recoverCodexOperationToolResult({
      hostName: "chatgpt",
      toolName,
      inputEvidence: operationToolResultEvidence(normalizedInput),
      result: rawResult(changed),
    })).toThrow("changed more than object null properties");
  });
});
