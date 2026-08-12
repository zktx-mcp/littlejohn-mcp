import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
  type CanonicalJson,
} from "../../../src/core/client.js";
import {
  createOperationToolResultDescriptor,
  operationToolResultMetadataKey,
} from "../../../src/interfaces/mcp-app/contracts.js";
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
