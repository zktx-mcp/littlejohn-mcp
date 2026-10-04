import {capabilityIdSchema} from "../core/client.js";
import {defineEvmReadCapability} from "../evm/capability.js";
import { officialAssetErrorRegistry } from "../registry/error-registry.js";
import { officialAssetCandidateListDigest, officialAssetMemberSetDigest } from "../registry/official-asset-contract.js";
import { createStockTokenPriceEvidence, createStockTokensEvidence } from "./capability-evidence.js";
import { stockTokenPricesErrorDefinitions } from "./error-definitions.js";
import {
  assertStockTokenPricesData, assertStockTokenPricesRequest,
  stockTokenPricesDataSchema, stockTokenPricesInputSchema, stockTokensDataSchema, stockTokensInputSchema,
} from "./result.js";

export const stockTokenPricesErrorRegistry = officialAssetErrorRegistry.extend(stockTokenPricesErrorDefinitions);
export const stockTokensFailureCodes = Object.freeze([
  "chain_response_unavailable", "internal_error", "invalid_input",
  "official_asset_response_too_large", "official_asset_response_unavailable",
  "rate_limited", "request_aborted", "result_too_large", "runtime_busy",
  "runtime_state_unavailable", "source_inconsistent", "source_unavailable", "state_conflict",
] as const);
export const stockTokenPricesFailureCodes = Object.freeze([
  ...stockTokensFailureCodes, stockTokenPricesErrorDefinitions[0].code,
] as const);
const pricesId = capabilityIdSchema.parse("market.stock_token_prices");
const tokensId = capabilityIdSchema.parse("market.stock_tokens");
export const stockTokenPriceCapabilityIds = Object.freeze([pricesId, tokensId]);
export const stockTokenPricesEvidence = createStockTokenPriceEvidence(pricesId);
export const stockTokensEvidence = createStockTokensEvidence(tokensId);
export const stockTokenPricesCapability = defineEvmReadCapability({
  capabilityId: pricesId, contractVersion: "1", inputSchema: stockTokenPricesInputSchema,
  dataSchema: stockTokenPricesDataSchema, failureCodes: stockTokenPricesFailureCodes,
  evidence: stockTokenPricesEvidence,
  validateIntrinsicData(data, context) {
    for (const exclusion of stockTokenPricesEvidence.staticScopeExclusions) context.assertDeclaredScopeExclusion(exclusion);
    assertStockTokenPricesData(data);
  },
  validateDataContext(data, context) {
    if (data.snapshot.sourceObservedAt > context.evaluatedAt ||
        (data.status !== "selection_unavailable" && data.source.observedAt > context.evaluatedAt)) throw new TypeError("Price observation is later than evaluation.");
  },
  validateRequest: assertStockTokenPricesRequest,
});
export const stockTokensCapability = defineEvmReadCapability({
  capabilityId: tokensId, contractVersion: "1", inputSchema: stockTokensInputSchema,
  dataSchema: stockTokensDataSchema, failureCodes: stockTokensFailureCodes,
  evidence: stockTokensEvidence,
  validateIntrinsicData(data, context) {
    for (const exclusion of stockTokensEvidence.staticScopeExclusions) context.assertDeclaredScopeExclusion(exclusion);
    if (officialAssetMemberSetDigest(data.members) !== data.snapshot.memberSetDigest ||
        officialAssetCandidateListDigest(data.members) !== data.snapshot.candidateListDigest ||
        new Set(data.members.map((member) => member.contractAddress)).size !== data.members.length ||
        data.members.some((member, index) => index > 0 && member.assetUid <= data.members[index - 1]!.assetUid)) {
      throw new TypeError("Official token catalog differs from its admitted source snapshot.");
    }
  },
  validateDataContext(data, context) {
    if (data.snapshot.sourceObservedAt > context.evaluatedAt) throw new TypeError("Catalog observation is later than evaluation.");
  },
});
