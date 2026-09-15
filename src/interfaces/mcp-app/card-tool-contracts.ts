import { cardControlContracts, cardReadStartContract } from "./card-contract.js";

const read = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} as const;
const control = { ...read, readOnlyHint: false, destructiveHint: true } as const;

export const cardToolContracts = Object.freeze({
  read: {
    contract: cardControlContracts.read,
    mcp: {
      name: "presentation_get_card",
      description: "Read the saved state of one exact card or immutable snapshot. This does not record an opening, retrieve a signature or repeat a Wallet request.",
      visibility: ["model", "app"] as const,
      annotations: read,
    },
  },
  open: {
    contract: cardControlContracts.open,
    mcp: {
      name: "presentation_start_view",
      description: "Admit one View execution for this saved card. Retries reuse its opening request ID. Another opening closes only an unsubmitted decision; admitted work continues and is read without replay.",
      visibility: ["app"] as const,
      annotations: control,
    },
  },
  discard: {
    contract: cardControlContracts.discard,
    mcp: {
      name: "presentation_cancel_decision",
      description: "Discard one ready card decision locally. This cannot reject or cancel a request already delivered to the Wallet.",
      visibility: ["app"] as const,
      annotations: control,
    },
  },
  stop: {
    contract: cardControlContracts.stop,
    mcp: {
      name: "presentation_cancel_wait",
      description: "Explicitly stop the original local wait or request cancellation of this card's cancellable Wallet operation. Read its saved state without resending or claiming remote cancellation.",
      visibility: ["app"] as const,
      annotations: control,
    },
  },
});
export const cardReadStartTool = Object.freeze({
  contract: cardReadStartContract,
  mcp: { name: "presentation_start_read", description: "Start a Stock Token trade-history chart and return its saved card reference immediately. The backend collects the data once; read the card to display progress and its exact stored result. Do not also call the completed-data query for this same chart.",
    visibility: ["model"] as const,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
});
