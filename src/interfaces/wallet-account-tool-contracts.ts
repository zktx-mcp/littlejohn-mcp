import {walletAccountSelectionContracts} from "../wallet/account-selection-contract.js";

export const walletAccountToolContracts = Object.freeze({
  get: Object.freeze({contract: walletAccountSelectionContracts.get,
    mcp: Object.freeze({name: "wallet_get_account_selection", description: "Read eligible Robinhood accounts and the effective account for new requests. Fresh observation may update derived connection state and invalidate an unavailable preference; this does not select an account or change Wallet permissions.",
      visibility: ["model", "app"] as const,
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false}}),
    cli: {domain: "wallet" as const, command: "account-selection", argumentSyntax: "[--json]"},
  }),
  select: Object.freeze({contract: walletAccountSelectionContracts.select,
    mcp: Object.freeze({name: "wallet_select_account", description: "Directly select one currently eligible local account. This does not switch Wallet networks or send a request.",
      visibility: ["app"] as const,
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false}}),
    cli: {domain: "wallet" as const, command: "select-account", argumentSyntax: ""},
  }),
});
