import { exchangeApplicationContracts } from "../review/application-contracts.js";
import { receiptApplicationContracts } from "../receipt-activity/application-contracts.js";

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const command = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
export const exchangeToolContracts = Object.freeze({
  start: Object.freeze({ contract: exchangeApplicationContracts.start, mcp: Object.freeze({ name: "exchange_start_review", description: "Create a temporary USDG/Stock Token transaction decision. This may read prior known results; it never sends a transaction. Quantities are token units, not shares. On MCP Apps hosts this call supplies the original decision card and any available choices.", visibility: ["model"] as const, annotations: command }) }),
  get: Object.freeze({ contract: exchangeApplicationContracts.get, mcp: Object.freeze({ name: "exchange_get_review", description: "Read one live transaction decision; consumed or expired material is unavailable.", visibility: ["model", "app"] as const, annotations: read }) }),
  cancel: Object.freeze({ contract: exchangeApplicationContracts.cancel, mcp: Object.freeze({ name: "exchange_cancel_review", description: "Discard one unconsumed transaction decision. This cannot cancel a delivered Wallet request.", visibility: ["app"] as const, annotations: { ...read, readOnlyHint: false } }) }),
  request: Object.freeze({ contract: exchangeApplicationContracts.request, mcp: Object.freeze({ name: "exchange_request_transaction", description: "Directly confirm this complete decision and request its transaction in the Wallet once.", visibility: ["app"] as const, annotations: { ...command, destructiveHint: true } }) }),
});

export const activityToolContracts = Object.freeze({
  get: Object.freeze({ contract: receiptApplicationContracts.get, mcp: Object.freeze({ name: "activity_get_transaction", description: "Read the stored transaction and its actual result without a network lookup.", visibility: ["model", "app"] as const, annotations: read }) }),
  list: Object.freeze({ contract: receiptApplicationContracts.list, mcp: Object.freeze({ name: "activity_list_transactions", description: "List the account's recorded transactions without network work.", visibility: ["model", "app"] as const, annotations: read }) }),
  inspect: Object.freeze({ contract: receiptApplicationContracts.inspect, mcp: Object.freeze({ name: "activity_inspect_transaction", description: "Explicitly re-read one transaction and receipt within a finite wait and update its ledger. This cannot resend or replace a transaction.", visibility: ["model", "app"] as const, annotations: command }) }),
});
