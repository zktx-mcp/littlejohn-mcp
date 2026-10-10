import { cardControlContracts, cardReadStartContract, cardDecisionStartContract } from "./card-contract.js";

const read = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} as const;
const control = { ...read, readOnlyHint: false, destructiveHint: true } as const;
const stateRead = { ...control, openWorldHint: true } as const;

export const cardToolContracts = Object.freeze({
  read: {
    contract: cardControlContracts.read,
    mcp: {
      name: "presentation_get_card",
      description: "Read one exact saved card or immutable snapshot. Pending account selection may publish derived Wallet observation; an existing Wallet operation may settle its original expiry. This does not retrieve a signature or repeat a Wallet request.",
      visibility: ["model", "app"] as const,
      annotations: stateRead,
    },
  },
  open: {
    contract: cardControlContracts.open,
    mcp: {
      name: "presentation_start_view",
      description: "Read this exact card and recheck its original source. Opening a new View never closes input or repeats domain work.",
      visibility: ["app"] as const,
      annotations: stateRead,
    },
  },
  discard: {
    contract: cardControlContracts.discard,
    mcp: {
      name: "presentation_cancel_decision",
      description: "Discard one ready card decision locally. This cannot reject or cancel a request already delivered to the Wallet.",
      visibility: ["app"] as const,
      annotations: stateRead,
    },
  },
  stop: {
    contract: cardControlContracts.stop,
    mcp: {
      name: "presentation_cancel_wait",
      description: "Explicitly stop the original local wait or request cancellation of this card's cancellable Wallet operation. Read its saved state without resending or claiming remote cancellation.",
      visibility: ["app"] as const,
      annotations: stateRead,
    },
  },
});
export const cardReadStartTool = Object.freeze({
  contract: cardReadStartContract,
  mcp: { name: "presentation_start_read", description: "Explicitly create a read card from one registered immutable input. General cards are limited to one per prompt; charts may be separate. The backend reads once and retains the exact result. Additional evidence uses data tools without creating cards.",
    visibility: ["model"] as const,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
});
export const cardDecisionStartTool = Object.freeze({
  contract: cardDecisionStartContract,
  mcp: {name: "presentation_start_decision", description: "Explicitly create one card for a new decision or the same existing Review. This does not confirm, select, sign or send. Request one general card per prompt and use data tools for additional facts.",
    visibility: ["model"] as const,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true},
  },
});
