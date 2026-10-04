import { z } from "zod";
import {deepFreezeValue, generalSingleLineTextSchema, hash32Schema, jsonObject, sourceReferenceSchema, utcTimestampSchema} from "../core/client.js";
import {evmAddressSchema, type EvmAddress} from "../evm/identities.js";
import {productChainId} from "../registry/product-identity.js";
import {productUsdgAsset} from "../registry/product-assets.js";
import { poolPriceProtocolSchema } from "../protocols/pool-price-contract.js";
import { stockTokenPricesErrorDefinitions } from "./error-definitions.js";

export const poolCandidateProtocolSchema = poolPriceProtocolSchema;
export type PoolCandidateProtocol = z.infer<typeof poolCandidateProtocolSchema>;

export const poolCandidateSchema = jsonObject({
  poolId: generalSingleLineTextSchema,
  baseAddress: evmAddressSchema,
  quoteAddress: evmAddressSchema,
  sourceDexId: generalSingleLineTextSchema,
  sourceLabels: z.array(generalSingleLineTextSchema),
  protocol: poolCandidateProtocolSchema.nullable(),
  status: z.enum(["candidate", "unsupported", "invalid"]),
}).strict().superRefine((value, context) => {
  if (value.status === "unsupported") {
    if (value.protocol !== null) context.addIssue({ code: "custom", message: "Unsupported hints cannot select a protocol." });
  } else {
    if (value.protocol === null) {
      context.addIssue({ code: "custom", message: "A supported hint must select its exact protocol." });
      return;
    }
    const valid = (value.protocol === "uniswap_v4" ? hash32Schema : evmAddressSchema)
      .safeParse(value.poolId).success;
    if (valid !== (value.status === "candidate")) {
      context.addIssue({ code: "custom", message: "Candidate ID admission differs from its declared format outcome." });
    }
  }
});
export type PoolCandidate = z.infer<typeof poolCandidateSchema>;

export const poolCandidateSourceResultSchema = jsonObject({
  chainId: z.literal(productChainId),
  stockTokenAddress: evmAddressSchema,
  quoteAddress: z.literal(productUsdgAsset.address),
  coverage: z.literal("provider_reported"),
  sourceOwner: generalSingleLineTextSchema,
  reference: sourceReferenceSchema,
  observedAt: utcTimestampSchema,
  candidates: z.array(poolCandidateSchema),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const candidate of value.candidates) {
    if (!((candidate.baseAddress === value.stockTokenAddress && candidate.quoteAddress === value.quoteAddress) ||
        (candidate.quoteAddress === value.stockTokenAddress && candidate.baseAddress === value.quoteAddress))) {
      context.addIssue({ code: "custom", message: "Candidate pair differs from the requested assets." });
    }
    if (seen.has(candidate.poolId)) context.addIssue({ code: "custom", message: "Candidate identity is duplicated." });
    seen.add(candidate.poolId);
  }
});
export type PoolCandidateSourceResult = z.infer<typeof poolCandidateSourceResultSchema>;

export const poolCandidateSourceFailureCodes = [
  "source_unavailable", "source_inconsistent", "rate_limited", stockTokenPricesErrorDefinitions[0].code,
] as const;
export class PoolCandidateSourceError extends Error {
  constructor(readonly code: typeof poolCandidateSourceFailureCodes[number]) {
    super(code);
  }
}

export const admitPoolCandidateSourceResult = (
  stockTokenAddress: EvmAddress,
  value: unknown,
): PoolCandidateSourceResult => {
  const parsed = poolCandidateSourceResultSchema.parse(value);
  if (parsed.stockTokenAddress !== stockTokenAddress) throw new TypeError("Candidate source changed the requested token.");
  return deepFreezeValue(parsed);
};
