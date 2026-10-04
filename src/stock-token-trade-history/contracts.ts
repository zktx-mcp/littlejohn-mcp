import {capabilityIdSchema} from "../core/client.js";
import {defineEvmReadCapability} from "../evm/capability.js";
import { officialAssetErrorRegistry } from "../registry/error-registry.js";
import { createStockTokenTradeHistoryEvidence } from "./capability-evidence.js";
import { stockTokenTradeHistoryInputSchema } from "./period-contract.js";
import {
  assertStockTokenTradeHistoryDataAt,
  assertStockTokenTradeHistoryIntrinsicData,
  assertStockTokenTradeHistoryRequest,
  stockTokenTradeHistoryDataSchema,
} from "./result.js";

const stockTokenTradeHistoryCapabilityId = capabilityIdSchema.parse(
  "market.stock_token_trade_history",
);
export const stockTokenTradeHistoryCapabilityIds = Object.freeze([
  stockTokenTradeHistoryCapabilityId,
]);

export const stockTokenTradeHistoryMaximumSuccessUtf8Bytes = 600_000 as const;

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

export const stockTokenTradeHistoryErrorRegistry = officialAssetErrorRegistry;
export const stockTokenTradeHistoryEvidence = createStockTokenTradeHistoryEvidence(
  stockTokenTradeHistoryCapabilityId,
);

export const stockTokenTradeHistoryCapability = defineEvmReadCapability({
  capabilityId: stockTokenTradeHistoryCapabilityId,
  contractVersion: "1",
  inputSchema: stockTokenTradeHistoryInputSchema,
  dataSchema: stockTokenTradeHistoryDataSchema,
  maximumSuccessUtf8Bytes: stockTokenTradeHistoryMaximumSuccessUtf8Bytes,
  failureCodes: stockTokenTradeHistoryFailureCodes,
  evidence: stockTokenTradeHistoryEvidence,
  validateIntrinsicData: (data, context) => {
    for (const exclusion of stockTokenTradeHistoryEvidence.staticScopeExclusions) {
      context.assertDeclaredScopeExclusion(exclusion);
    }
    assertStockTokenTradeHistoryIntrinsicData(data);
  },
  validateDataContext: (data, context) => {
    assertStockTokenTradeHistoryDataAt(data, context.evaluatedAt);
  },
  validateSuccess: (data, context) => {
    if ("block" in data && data.block.chainId !== context.chainId) {
      throw new TypeError("Trade-history success chain scope is inconsistent.");
    }
  },
  validateRequest: assertStockTokenTradeHistoryRequest,
});
