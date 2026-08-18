import { z, type ZodType } from "zod";

import {
  createEvidenceSchemaSet,
  evidenceConclusionCountLimit,
  evidenceObservationCountLimit,
  evidenceWarningCountLimit,
  type Conclusion,
  type Coverage,
  type EvidenceSource,
  type Warning,
} from "./evidence.js";
import { evmChainIdSchema, type EvmChainId } from "./identities.js";
import { jsonObject } from "./json-object.js";
import { createPrimitiveSchemaSet, type UtcTimestamp } from "./primitives.js";

const contractPrimitives = createPrimitiveSchemaSet();
const contractEvidence = createEvidenceSchemaSet();

export const readCapabilityLimits = Object.freeze({
  runtimeCodeBytes: 262_144,
  transactionCalldataBytes: 2_097_152,
  transactionLogTopics: 4,
  transactionReceiptLogs: 4_096,
  transactionAccessListEntries: 1_024,
  transactionAccessListStorageKeyOccurrences: 4_096,
  transactionType: 127,
  accountTokenAddresses: 50,
});

export const maximumSuccessUtf8Bytes = 8_388_607 as const;

export const capabilityIdPatternSource =
  "[a-z][a-z0-9]*(?:_[a-z0-9]+)*\\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*";

const capabilityIdAsciiLengthLimit = 64 as const;

export const createCapabilityIdSchema = () => z
  .string()
  .min(1)
  .max(capabilityIdAsciiLengthLimit)
  .regex(new RegExp("^" + capabilityIdPatternSource + "$"))
  .brand("CapabilityId");

export const capabilityIdSchema = createCapabilityIdSchema();
export type CapabilityId = z.infer<typeof capabilityIdSchema>;

export interface CapabilitySuccess<Data> {
  readonly ok: true;
  readonly meta: {
    readonly capabilityId: CapabilityId;
    readonly contractVersion: "1";
    readonly chainId: EvmChainId;
    readonly evaluatedAt: UtcTimestamp;
  };
  readonly data: Data;
  readonly evidence: {
    readonly sources: readonly EvidenceSource[];
    readonly conclusions: readonly Conclusion[];
    readonly coverage: Coverage;
  };
  readonly warnings: readonly Warning[];
}

export const createCapabilitySuccessSchema = <Data>(
  capabilityId: CapabilityId,
  contractVersion: "1",
  dataSchema: ZodType<Data>,
) => jsonObject({
  ok: z.literal(true),
  meta: jsonObject({
    capabilityId: z.literal(capabilityId),
    contractVersion: z.literal(contractVersion),
    chainId: evmChainIdSchema,
    evaluatedAt: contractPrimitives.utcTimestamp,
  }).strict(),
  data: dataSchema,
  evidence: jsonObject({
    sources: z.array(contractEvidence.evidenceSource).max(evidenceObservationCountLimit),
    conclusions: z.array(contractEvidence.conclusion).max(evidenceConclusionCountLimit),
    coverage: contractEvidence.coverage,
  }).strict(),
  warnings: z.array(contractEvidence.warning).max(evidenceWarningCountLimit),
}).strict();

export const assertCapabilitySuccessChainScope = <Data>(
  success: CapabilitySuccess<Data>,
): void => {
  if (success.evidence.sources.some((source) =>
    source.chainAnchor !== undefined && source.chainAnchor.chainId !== success.meta.chainId)) {
    throw new TypeError("Evidence chain scope mismatch.");
  }
};
