import { z } from "zod";
import { captureCanonicalJson, canonicalJsonStringify, createEvidenceFactIdentityDeclaration, createEvidenceObservationTargetDeclaration, createExactConclusionIdentityDeclaration, jsonObject, staticScopeExclusionSchema } from "../../core/client.js";
import { createEvmEvidenceReplayDefinition } from "../../evm/evidence-replay.js";
import {defineEvmReadCapability} from "../../evm/capability.js";
import {evmAddressSchema} from "../../evm/identities.js";
import { officialAssetSnapshotEvidenceSchema } from "../../registry/official-asset-contract.js";
import { officialAssetErrorRegistry } from "../../registry/error-registry.js";
import { uniswapV4PoolCatalog } from "./catalog.js";
import { uniswapV4PoolIdSchema, uniswapV4PoolKeySchema } from "./identity.js";

const conclusion = createExactConclusionIdentityDeclaration("pool_candidates_observed");
const definition = createEvmEvidenceReplayDefinition({ capabilityId: "uniswap_v4.list_pools", conclusions: [conclusion], warningCodes: [] });
const fact = createEvidenceFactIdentityDeclaration(definition, "official_membership");
const target = createEvidenceObservationTargetDeclaration(definition, {
  slotId: "official_membership", fact, kind: "source", purpose: "official_membership",
  sourceClass: "web_api", roles: { value: "official_membership" },
});
const exclusions = [
  { id: "candidate_catalog", message: "Only the packaged USDG pool candidates are covered; this is not an all-market or best-route result." },
  { id: "live_execution", message: "Pool existence, deployed code, liquidity, quote, StockFactory identity and execution are checked separately before a transaction decision." },
].map((value) => staticScopeExclusionSchema.parse(value));
export const uniswapV4PoolsInputSchema = jsonObject({ stockTokenAddress: evmAddressSchema }).strict();
export const uniswapV4PoolsDataSchema = jsonObject({
  stockTokenAddress: evmAddressSchema,
  snapshot: officialAssetSnapshotEvidenceSchema,
  officialMember: z.boolean(),
  candidates: z.array(jsonObject({ poolId: uniswapV4PoolIdSchema, stockTokenAddress: evmAddressSchema, poolKey: uniswapV4PoolKeySchema }).strict())
    .max(uniswapV4PoolCatalog.length),
}).strict().superRefine((value, context) => {
  const expected = value.officialMember ? uniswapV4PoolCatalog.filter((pool) => pool.stockTokenAddress === value.stockTokenAddress) : [];
  if (canonicalJsonStringify(captureCanonicalJson(expected)) !== canonicalJsonStringify(captureCanonicalJson(value.candidates))) {
    context.addIssue({ code: "custom", message: "Pool candidates do not match the exact admitted catalog and selected asset." });
  }
});
export const uniswapV4PoolsEvidence = Object.freeze({
  definition, target,
  observationTargets: () => [target],
  declaration: (_input: z.infer<typeof uniswapV4PoolsInputSchema>, data: z.infer<typeof uniswapV4PoolsDataSchema>, binder: import("../../core/client.js").EvidenceReplayBinder) => {
    const bound = binder.bind(target);
    return {
      observationExpectations: [{ slot: bound.slot, claims: [{ role: bound.roles.value, value: captureCanonicalJson({
        stockTokenAddress: data.stockTokenAddress, snapshot: data.snapshot, officialMember: data.officialMember,
      }) }] }], observationReferences: [],
      factRequirements: [{ fact, outcome: "observed" as const, observationSlots: [bound.slot], requiredObservationSlots: [bound.slot], minimumObservationCount: 1 }],
      conclusionDrafts: [{ conclusion, outcomeFact: fact, evidenceFacts: [fact], freshnessRuleId: "official_asset_snapshot_current" as const }], warningRequirements: [],
    };
  },
  staticScopeExclusions: exclusions,
});
export const uniswapV4PoolsCapability = defineEvmReadCapability({
  capabilityId: "uniswap_v4.list_pools", contractVersion: "1", inputSchema: uniswapV4PoolsInputSchema,
  dataSchema: uniswapV4PoolsDataSchema, failureCodes: officialAssetErrorRegistry.values().map((value) => value.code), evidence: uniswapV4PoolsEvidence,
  validateIntrinsicData(data, context) {
    uniswapV4PoolsDataSchema.parse(data);
    for (const exclusion of exclusions) context.assertDeclaredScopeExclusion(exclusion);
  },
  validateRequest(input, data) {
    if (input.stockTokenAddress !== data.stockTokenAddress) throw new TypeError("Pool listing changed its selected asset.");
  },
});
