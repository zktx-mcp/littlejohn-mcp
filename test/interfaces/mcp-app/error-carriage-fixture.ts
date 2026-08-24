import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const capturedResult: CallToolResult = {
  content: [{
    type: "text" as const,
    text:
      "{\"error\":{\"category\":\"input\",\"code\":\"qualification_application_error\",\"issues\":[],\"message\":\"Synthetic canonical application failure for Host carriage qualification.\",\"retryable\":false},\"ok\":false}",
  }],
  structuredContent: {
    ok: false,
    error: {
      code: "qualification_application_error",
      category: "input",
      message: "Synthetic canonical application failure for Host carriage qualification.",
      retryable: false,
      issues: [],
    },
  },
};

export const capturedCodexCreatingApplicationFailure: CallToolResult =
  Object.freeze(capturedResult);
