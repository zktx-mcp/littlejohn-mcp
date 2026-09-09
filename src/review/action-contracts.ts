import { capabilityIdSchema } from "../core/client.js";
import { exchangeApplicationContracts } from "./application-contracts.js";

// These identities distinguish user meaning. Native function names and encoding
// belong to the protocol registration, not to the confirmation lifecycle.
export const exchangeActionContracts = Object.freeze({
  sent: Object.freeze({ actionId: capabilityIdSchema.parse("exchange.sent_quantity"), contractVersion: "1", confirmation: exchangeApplicationContracts.request }),
  received: Object.freeze({ actionId: capabilityIdSchema.parse("exchange.received_quantity"), contractVersion: "1", confirmation: exchangeApplicationContracts.request }),
  erc20: Object.freeze({ actionId: capabilityIdSchema.parse("exchange.token_allowance"), contractVersion: "1", confirmation: exchangeApplicationContracts.request }),
  permit2: Object.freeze({ actionId: capabilityIdSchema.parse("exchange.router_allowance"), contractVersion: "1", confirmation: exchangeApplicationContracts.request }),
});
