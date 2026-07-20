import {
  canonicalJsonStringify,
  compareCodePointSequences,
  createEvidenceSummary,
  deepFreezeValue,
  type CanonicalJson,
} from "../core/index.js";
import {
  tokenInspectionDigest,
  tokenRegistrationWithInspectionSchema,
  type TokenInspectionSuccess,
  type TokenRegistrationWithInspection,
} from "../token-catalog/index.js";
import {
  type AccountAssetEntryWithReferences,
} from "./contracts.js";

const metadataEvidence = (
  inspection: TokenInspectionSuccess,
  observation: TokenInspectionSuccess["data"]["metadata"]["name"],
  conclusionId: "name_observed" | "symbol_observed",
) => {
  const sources = inspection.evidence.sources.filter(
    (source) => source.observationId === observation.observationId,
  );
  const conclusions = inspection.evidence.conclusions.filter(
    (conclusion) => conclusion.id === conclusionId,
  );
  if (sources.length !== 1 || conclusions.length !== 1) {
    throw new TypeError("Token metadata evidence is incomplete.");
  }
  return Object.freeze({ observation, source: sources[0]!, conclusion: conclusions[0]! });
};

export const projectAccountAssetEntry = (
  inputValue: TokenRegistrationWithInspection,
): AccountAssetEntryWithReferences => {
  const input = tokenRegistrationWithInspectionSchema.parse(inputValue);
  if (input.registration.inspectionDigest !== tokenInspectionDigest(input.inspection)) {
    throw new TypeError("Token registration inspection digest is invalid.");
  }
  const name = metadataEvidence(input.inspection, input.inspection.data.metadata.name, "name_observed");
  const symbol = metadataEvidence(input.inspection, input.inspection.data.metadata.symbol, "symbol_observed");
  const unavailableObservationIds = [name, symbol]
    .filter((field) => field.observation.status === "unavailable")
    .map((field) => field.observation.observationId)
    .sort(compareCodePointSequences);
  const summary = createEvidenceSummary(
    [name.conclusion, symbol.conclusion],
    unavailableObservationIds.length === 0
      ? []
      : [{ code: "partial_result", observationIds: unavailableObservationIds }],
  );
  const projected: AccountAssetEntryWithReferences = {
    registration: input.registration,
    metadata: {
      evaluatedAt: input.inspection.meta.evaluatedAt,
      block: input.inspection.data.block,
      name,
      symbol,
      coverage: summary.coverage,
      warnings: [...summary.warnings],
    },
  };
  if (canonicalJsonStringify(projected.registration as unknown as CanonicalJson) !==
    canonicalJsonStringify(input.registration as unknown as CanonicalJson)) {
    throw new TypeError("Account asset registration projection is invalid.");
  }
  return deepFreezeValue(projected);
};
