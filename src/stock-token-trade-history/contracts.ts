import {
  capabilityIdSchema,
  defineApplicationContract,
  jsonObject,
} from "../core/client.js";
import { tokenCatalogErrorRegistry } from "../token-catalog/error-registry.js";
import {
  parseStockTokenTradeHistoryResult,
  stockTokenTradeHistoryInputSchema,
  stockTokenTradeHistoryResultSchema,
} from "./stock-token-trade-history.js";

export const stockTokenTradeHistoryCapabilityId = capabilityIdSchema.parse(
  "market.stock_token_trade_history",
);
export const stockTokenTradeHistoryCapabilityIds = Object.freeze([
  stockTokenTradeHistoryCapabilityId,
]);

export const stockTokenTradeHistoryFailureCodes = Object.freeze([
  "chain_response_unavailable",
  "internal_error",
  "invalid_input",
  "official_asset_response_too_large",
  "official_asset_response_unavailable",
  "rate_limited",
  "request_aborted",
  "result_too_large",
  "runtime_busy",
  "runtime_state_unavailable",
  "source_inconsistent",
  "source_unavailable",
  "state_conflict",
] as const);

export const stockTokenTradeHistoryErrorRegistry = tokenCatalogErrorRegistry;

const applicationContract = defineApplicationContract({
  contractVersion: "1",
  inputSchema: stockTokenTradeHistoryInputSchema,
  successSchema: stockTokenTradeHistoryResultSchema,
  internalContextSchema: jsonObject({}).strict(),
  errorRegistry: stockTokenTradeHistoryErrorRegistry,
  failureCodes: stockTokenTradeHistoryFailureCodes,
  validatePublicSuccess: (input, success) => {
    parseStockTokenTradeHistoryResult(input, success);
  },
});

export const stockTokenTradeHistoryApplicationContract = Object.freeze({
  capabilityId: stockTokenTradeHistoryCapabilityId,
  contractVersion: applicationContract.contractVersion,
  applicationContract,
  inputSchema: stockTokenTradeHistoryInputSchema,
  successSchema: stockTokenTradeHistoryResultSchema,
  failureCodes: applicationContract.failureCodes,
  parseInput: applicationContract.parseInput,
  parsePublicSuccess: applicationContract.parsePublicSuccess,
  parseFailure: applicationContract.parseFailure,
  normalizeFailure: applicationContract.normalizeFailure,
});
