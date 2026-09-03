import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type CanonicalJson,
} from "../../../src/core/client.js";
import {
  createOperationToolResultDescriptor,
  operationToolResultLimits,
  operationToolResultMetadataKey,
} from "../../../src/interfaces/mcp-app/contracts.js";
import { admitMcpToolResultForDelivery } from "../../../src/interfaces/mcp-result.js";
import { recoverCodexOperationToolResult } from
  "../../../src/interfaces/mcp-app/view/codex-operation-result-adapter.js";

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
      normalizedInput,
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
      normalizedInput,
      result: rawResult(changed),
    })).toThrow("changed more than object null properties");
  });
});
