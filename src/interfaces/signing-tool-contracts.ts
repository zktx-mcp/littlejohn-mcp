import { signingApplicationContracts } from "../review/signing-application-contracts.js";

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const signingToolContracts = Object.freeze({
  start: { contract: signingApplicationContracts.start, mcp: { name: "signing_start_review", description: "Create a temporary decision for exact UTF-8/hex personal data or EIP-712 typed data. Typed integers are decimal strings. This cannot request a signature.", visibility: ["model"] as const,
    annotations: { ...read, readOnlyHint: false, idempotentHint: false } } },
  get: { contract: signingApplicationContracts.get, mcp: { name: "signing_get_review", description: "Read one live signing decision. Consumed or expired data is unavailable; this never retrieves a signature.", visibility: ["model", "app"] as const, annotations: read } },
  cancel: { contract: signingApplicationContracts.cancel, mcp: { name: "signing_cancel_review", description: "Discard one unconsumed signing decision. This cannot cancel a request already delivered to the Wallet.", visibility: ["app"] as const, annotations: { ...read, readOnlyHint: false } } },
  request: { contract: signingApplicationContracts.request, mcp: { name: "signing_request_signature", description: "Directly confirm the complete decision and request one signature in the external Wallet. A verified signature is delivered only to the direct App.", visibility: ["app"] as const,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } } },
});
