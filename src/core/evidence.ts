import { z } from "zod";

import {
  canonicalJsonStringify,
  captureCanonicalJson,
} from "./canonical-json.js";
import {
  canonicalBase64UrlSchema,
  compareCodePointSequences,
  createPrimitiveSchemaSet,
  prefixedCanonicalBase64UrlSchema,
} from "./primitives.js";
import { deepFreezeValue } from "./immutability.js";
import { guardJsonSchema, jsonObject } from "./json-object.js";

const definitionKeys = <Definition extends Readonly<Record<string, unknown>>>(definition: Definition) =>
  Object.freeze(Object.keys(definition)) as unknown as readonly [Extract<keyof Definition, string>, ...Extract<keyof Definition, string>[]];

const defineOrderedVocabulary = <
  const Values extends readonly [string, ...string[]],
>(...values: Values): Readonly<Values> => Object.freeze(values);

export const evidenceObservationCountLimit = 128 as const;
export const evidenceConclusionCountLimit = 64 as const;
export const evidenceReplayFactRequirementCountLimit = 128 as const;
export const evidenceWarningCountLimit = 64 as const;

export const sourceReferenceKinds = defineOrderedVocabulary(
  "public",
  "configured_rpc",
  "wallet_session",
  "wallet_sdk",
  "validated_input",
);
type SourceReferenceKind = (typeof sourceReferenceKinds)[number];

export const conclusionStatuses = defineOrderedVocabulary(
  "established",
  "not_applicable",
  "unavailable",
);
type ConclusionStatus = (typeof conclusionStatuses)[number];

export const factEvidenceAuthorities = defineOrderedVocabulary(
  "external",
  "validated_input",
  "none",
);
type FactEvidenceAuthority = (typeof factEvidenceAuthorities)[number];

export const freshnessStatuses = defineOrderedVocabulary(
  "fresh",
  "stale",
  "unknown",
);

export const coverageStatuses = defineOrderedVocabulary(
  "complete",
  "partial",
  "unavailable",
);
type CoverageStatus = (typeof coverageStatuses)[number];

export const sourceClassDefinitions = deepFreezeValue({
  official_document: {
    external: true,
    referenceKinds: ["public"],
    invocationReferenceCardinality: "single",
  },
  web_api: {
    external: true,
    referenceKinds: ["public"],
    invocationReferenceCardinality: "single",
  },
  public_dataset: {
    external: true,
    referenceKinds: ["public"],
    invocationReferenceCardinality: "single",
  },
  chain_rpc: {
    external: true,
    referenceKinds: ["public", "configured_rpc"],
    invocationReferenceCardinality: "single",
  },
  contract_verification_service: {
    external: true,
    referenceKinds: ["public"],
    invocationReferenceCardinality: "multiple_same_owner",
  },
  wallet_sdk: {
    external: true,
    referenceKinds: ["wallet_sdk"],
    invocationReferenceCardinality: "single",
  },
  wallet_session: {
    external: true,
    referenceKinds: ["wallet_session"],
    invocationReferenceCardinality: "single",
  },
  validated_input: {
    external: false,
    referenceKinds: ["validated_input"],
    invocationReferenceCardinality: "single",
  },
} satisfies Record<string, {
  readonly external: boolean;
  readonly referenceKinds: readonly SourceReferenceKind[];
  readonly invocationReferenceCardinality: "single" | "multiple_same_owner";
}>);

export const sourceClasses = definitionKeys(sourceClassDefinitions);
export const externalSourceClasses = Object.freeze(sourceClasses.filter((sourceClass) =>
  sourceClassDefinitions[sourceClass].external)) as readonly [
    Exclude<(typeof sourceClasses)[number], "validated_input">,
    ...Exclude<(typeof sourceClasses)[number], "validated_input">[],
  ];

export const sourceClassAcceptsReference = (
  sourceClass: (typeof sourceClasses)[number],
  referenceKind: SourceReferenceKind,
): boolean => sourceClassDefinitions[sourceClass].referenceKinds.includes(referenceKind as never);

export const invocationSourceIdentity = (
  sourceClass: (typeof sourceClasses)[number],
  owner: string,
  reference: Readonly<{ readonly kind: SourceReferenceKind; readonly sourceId: string }>,
  exactReference: string,
): string => sourceClassDefinitions[sourceClass].invocationReferenceCardinality === "single"
  ? `${owner}\u0000${reference.kind}\u0000${reference.sourceId}\u0000${exactReference}`
  : `${owner}\u0000${reference.kind}\u0000${reference.sourceId}`;

export const factOutcomeDefinitions = deepFreezeValue({
  not_observed: { conclusionStatus: "unavailable", evidenceAuthority: "none" },
  not_present: { conclusionStatus: "not_applicable", evidenceAuthority: "none" },
  not_requested: { conclusionStatus: "not_applicable", evidenceAuthority: "none" },
  observed: { conclusionStatus: "established", evidenceAuthority: "external" },
  pending: { conclusionStatus: "established", evidenceAuthority: "external" },
  source_failed: { conclusionStatus: "unavailable", evidenceAuthority: "external" },
  source_inconsistent: { conclusionStatus: "unavailable", evidenceAuthority: "external" },
  unsupported: { conclusionStatus: "not_applicable", evidenceAuthority: "none" },
  validated_input: { conclusionStatus: "established", evidenceAuthority: "validated_input" },
} satisfies Record<string, {
  readonly conclusionStatus: ConclusionStatus;
  readonly evidenceAuthority: FactEvidenceAuthority;
}>);

export const factOutcomes = definitionKeys(factOutcomeDefinitions);

export const freshnessRuleDefinitions = deepFreezeValue({
  official_asset_snapshot_current: {
    status: "fresh",
    sourceClasses: ["web_api"],
    anchor: "any",
  },
  trade_history_archive_current: {
    status: "fresh",
    sourceClasses: ["public_dataset"],
    anchor: "any",
  },
  trade_history_archive_stale: {
    status: "stale",
    sourceClasses: ["public_dataset"],
    anchor: "any",
  },
  trade_history_archive_unavailable: {
    status: "unknown",
    sourceClasses: ["public_dataset"],
    anchor: "any",
  },
  chain_anchor_exact: {
    status: "fresh",
    sourceClasses: ["chain_rpc"],
    anchor: "consistent_present",
  },
  contract_source_at_chain_anchor: {
    status: "fresh",
    sourceClasses: ["contract_verification_service"],
    anchor: "consistent_present",
  },
  wallet_session_current: {
    status: "fresh",
    sourceClasses: ["wallet_sdk", "wallet_session"],
    anchor: "any",
  },
  validated_input_current: {
    status: "fresh",
    sourceClasses: ["validated_input"],
    anchor: "any",
  },
  pending_transaction_observed: {
    status: "unknown",
    sourceClasses: ["chain_rpc"],
    anchor: "absent",
    exactSourceCount: 1,
    purpose: "transaction",
  },
} as const);

export const freshnessRuleIds = definitionKeys(freshnessRuleDefinitions);

export const warningDefinitions = Object.freeze({
  decimals_unavailable: Object.freeze({
    message: "Token decimals are unavailable for an exact display amount.",
  }),
  partial_result: Object.freeze({
    message: "Some requested results are unavailable.",
  }),
  unsupported_transaction_type: Object.freeze({
    message: "The transaction type is not interpreted.",
  }),
} as const);

export const fieldIssueDefinitions = deepFreezeValue({
  invalid_value: { message: "The field value is invalid." },
} as const);

export type WarningCode = keyof typeof warningDefinitions;

export const warningCodes = Object.freeze(
  Object.keys(warningDefinitions).sort(compareCodePointSequences),
) as readonly [WarningCode, ...WarningCode[]];
export type FieldIssueCode = keyof typeof fieldIssueDefinitions;
export const fieldIssueCodes = definitionKeys(fieldIssueDefinitions);

export const isStrictlyOrderedUnique = (values: readonly string[]): boolean => {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodePointSequences(values[index - 1] ?? "", values[index] ?? "") >= 0) return false;
  }
  return true;
};

const coverageStatusForCounts = (
  established: number,
  notApplicable: number,
  unavailable: number,
): CoverageStatus => {
  const total = established + notApplicable + unavailable;
  if (total > 0 && unavailable === total) return "unavailable";
  if (unavailable > 0) return "partial";
  return "complete";
};

export const createEvidenceSchemaSet = () => {
  const primitive = createPrimitiveSchemaSet();
  const invocationId = prefixedCanonicalBase64UrlSchema("inv:", 32).brand("InvocationId");
  const observationId = prefixedCanonicalBase64UrlSchema("obs:", 32).brand("ObservationId");
  const sourceClass = z.enum(sourceClasses);
  const externalSourceClass = z.enum(externalSourceClasses);
  const digest = canonicalBase64UrlSchema(32);
  const factOutcome = z.enum(factOutcomes);
  const freshnessRuleId = z.enum(freshnessRuleIds);
  const warningCode = z.enum(warningCodes);
  const fieldIssueCode = z.enum(fieldIssueCodes);

  const publicSourceReference = jsonObject({
    kind: z.literal(sourceReferenceKinds[0]),
    sourceId: primitive.fixedIdentifier,
    uri: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.href === value
      );
    }, "Public references must be canonical HTTPS URLs without user information."),
  }).strict();
  const officialIdentityStatementList = z.array(primitive.generalSingleLineText)
    .min(1)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: "Official identity evidence statements must be unique.",
        });
      }
    });
  const officialIdentityEvidence = jsonObject({
    sourceOwner: primitive.generalSingleLineText,
    sourceClass: z.literal("official_document"),
    reference: publicSourceReference,
    sourceRevision: primitive.generalSingleLineText.optional(),
    coverage: primitive.generalSingleLineText,
    exclusions: officialIdentityStatementList,
    supportedConclusions: officialIdentityStatementList,
    unsupportedConclusions: officialIdentityStatementList,
  }).strict().superRefine((value, context) => {
    const conclusions = [
      ...value.supportedConclusions,
      ...value.unsupportedConclusions,
    ];
    if (new Set(conclusions).size !== conclusions.length) {
      context.addIssue({
        code: "custom",
        message: "Supported and unsupported identity conclusions must not overlap.",
      });
    }
  });
  const sourceReference = z.discriminatedUnion("kind", [
    publicSourceReference,
    jsonObject({
        kind: z.literal(sourceReferenceKinds[1]),
        sourceId: prefixedCanonicalBase64UrlSchema("rpc:", 32),
        publicOrigin: z.url().refine((value) => {
          const url = new URL(value);
          return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            url.username === "" &&
            url.password === "" &&
            url.pathname === "/" &&
            url.search === "" &&
            url.hash === "" &&
            url.origin === value
          );
        }, "Expected a normalized public origin."),
        configurationDigest: digest,
      })
      .strict(),
    jsonObject({
        kind: z.literal(sourceReferenceKinds[2]),
        sourceId: prefixedCanonicalBase64UrlSchema("wallet-session:", 32),
        topicDigest: digest,
      })
      .strict(),
    jsonObject({
        kind: z.literal(sourceReferenceKinds[3]),
        sourceId: prefixedCanonicalBase64UrlSchema("wallet-sdk:", 16),
      })
      .strict(),
    jsonObject({
        kind: z.literal(sourceReferenceKinds[4]),
        sourceId: primitive.fixedIdentifier,
      })
      .strict(),
  ]).superRefine((value, context) => {
    if (value.kind === "configured_rpc" && value.sourceId !== "rpc:" + value.configurationDigest) {
      context.addIssue({ code: "custom", message: "RPC source identity does not match its digest." });
    }
    if (value.kind === "wallet_session" && value.sourceId !== "wallet-session:" + value.topicDigest) {
      context.addIssue({ code: "custom", message: "Wallet session identity does not match its digest." });
    }
  });

  const evidenceSourceRecordFields = {
    observationId,
    invocationId,
    sourceClass,
    owner: primitive.generalSingleLineText,
    purpose: primitive.snakeCaseCode,
    observedAt: primitive.utcTimestamp,
    reference: sourceReference,
    chainAnchor: primitive.chainAnchor.optional(),
  };
  const validateEvidenceSourceRecord = (
    value: {
      readonly sourceClass: (typeof sourceClasses)[number];
      readonly reference: { readonly kind: SourceReferenceKind };
    },
    context: z.RefinementCtx,
  ): void => {
    if (!sourceClassAcceptsReference(value.sourceClass, value.reference.kind)) {
      context.addIssue({ code: "custom", message: "Evidence source class and reference are inconsistent." });
    }
  };
  const evidenceSourceRecord = jsonObject(evidenceSourceRecordFields)
    .strict()
    .superRefine(validateEvidenceSourceRecord);
  const evidenceSource = jsonObject({
    ...evidenceSourceRecordFields,
    recordDigest: digest,
  })
    .strict()
    .superRefine(validateEvidenceSourceRecord);

  const freshness = jsonObject({
      status: z.enum(freshnessStatuses),
      ruleId: freshnessRuleId,
      evaluatedAt: primitive.utcTimestamp,
      observationIds: z.array(observationId).min(1).max(evidenceObservationCountLimit),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.status !== freshnessRuleDefinitions[value.ruleId].status) {
        context.addIssue({ code: "custom", message: "Freshness status does not match its rule." });
      }
      if (!isStrictlyOrderedUnique(value.observationIds)) {
        context.addIssue({ code: "custom", message: "Observation identifiers must be unique and ordered." });
      }
    });

  const conclusion = jsonObject({
      id: primitive.fixedIdentifier,
      status: z.enum(conclusionStatuses),
      reason: factOutcome,
      observationIds: z.array(observationId).min(1).max(evidenceObservationCountLimit),
      freshness,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.status !== factOutcomeDefinitions[value.reason].conclusionStatus) {
        context.addIssue({ code: "custom", message: "Conclusion status does not match its reason." });
      }
      if (!isStrictlyOrderedUnique(value.observationIds)) {
        context.addIssue({ code: "custom", message: "Conclusion evidence must be unique and ordered." });
      }
      if (value.observationIds.join("\0") !== value.freshness.observationIds.join("\0")) {
        context.addIssue({ code: "custom", message: "Conclusion freshness must use the same evidence." });
      }
    });

  const coverage = jsonObject({
      status: z.enum(coverageStatuses),
      established: z.array(primitive.fixedIdentifier).max(evidenceConclusionCountLimit),
      notApplicable: z.array(primitive.fixedIdentifier).max(evidenceConclusionCountLimit),
      unavailable: z.array(primitive.fixedIdentifier).max(evidenceConclusionCountLimit),
    })
    .strict()
    .superRefine((value, context) => {
      for (const ids of [value.established, value.notApplicable, value.unavailable]) {
        if (!isStrictlyOrderedUnique(ids)) {
          context.addIssue({ code: "custom", message: "Coverage identifiers must be unique and ordered." });
        }
      }
      const combined = [...value.established, ...value.notApplicable, ...value.unavailable];
      if (new Set(combined).size !== combined.length) {
        context.addIssue({ code: "custom", message: "Coverage outcomes must not overlap." });
      }
      if (value.status !== coverageStatusForCounts(
        value.established.length,
        value.notApplicable.length,
        value.unavailable.length,
      )) context.addIssue({ code: "custom", message: "Coverage status does not match its outcomes." });
    });

  const warning = jsonObject({
      code: warningCode,
      message: primitive.warningMessage,
      observationIds: z.array(observationId).min(1).max(evidenceObservationCountLimit),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.message !== warningDefinitions[value.code].message) {
        context.addIssue({ code: "custom", message: "Warning message does not match its code." });
      }
      if (!isStrictlyOrderedUnique(value.observationIds)) {
        context.addIssue({ code: "custom", message: "Warning evidence must be unique and ordered." });
      }
    });

  const staticScopeExclusion = jsonObject({ id: primitive.snakeCaseCode, message: primitive.generalSingleLineText })
    .strict();

  const fieldIssue = jsonObject({
      path: z.string().regex(/^(?:|\/(?:[^~/]|~0|~1)*)*$/, "Expected an RFC 6901 JSON Pointer."),
      code: fieldIssueCode,
      message: primitive.generalSingleLineText,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.message !== fieldIssueDefinitions[value.code].message) {
        context.addIssue({ code: "custom", message: "Field issue message does not match its code." });
      }
    });

  return Object.freeze({
    invocationId,
    observationId,
    sourceClass,
    externalSourceClass,
    digest,
    factOutcome,
    freshnessRuleId,
    warningCode,
    fieldIssueCode,
    officialIdentityEvidence,
    sourceReference,
    evidenceSourceRecord,
    evidenceSource,
    freshness,
    conclusion,
    coverage,
    warning,
    staticScopeExclusion,
    fieldIssue,
  });
};

const publicSchemas = createEvidenceSchemaSet();
const authoritySchemas = createEvidenceSchemaSet();
const authoritySourceReferenceSchema = guardJsonSchema(authoritySchemas.sourceReference);
const authorityWarningSchema = guardJsonSchema(authoritySchemas.warning);
const authorityCoverageSchema = guardJsonSchema(authoritySchemas.coverage);
const authorityFieldIssueSchema = guardJsonSchema(authoritySchemas.fieldIssue);

export const invocationIdSchema = publicSchemas.invocationId;
export type InvocationId = z.infer<typeof invocationIdSchema>;

export const observationIdSchema = publicSchemas.observationId;
export type ObservationId = z.infer<typeof observationIdSchema>;

export const sourceClassSchema = publicSchemas.sourceClass;
export type SourceClass = z.infer<typeof sourceClassSchema>;

export const externalSourceClassSchema = publicSchemas.externalSourceClass;
export type ExternalSourceClass = z.infer<typeof externalSourceClassSchema>;

export const digestSchema = publicSchemas.digest;
export const factOutcomeSchema = publicSchemas.factOutcome;
export type FactOutcome = z.infer<typeof factOutcomeSchema>;

export const freshnessRuleIdSchema = publicSchemas.freshnessRuleId;
export const warningCodeSchema = publicSchemas.warningCode;
export const officialIdentityEvidenceSchema = guardJsonSchema(
  publicSchemas.officialIdentityEvidence,
);
export type OfficialIdentityEvidence = z.infer<typeof officialIdentityEvidenceSchema>;
export const sourceReferenceSchema = guardJsonSchema(publicSchemas.sourceReference);
export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export const sourceReferenceIdentity = (referenceInput: SourceReference): string =>
  canonicalJsonStringify(captureCanonicalJson(sourceReferenceSchema.parse(referenceInput)));

export const evidenceSourceRecordSchema = guardJsonSchema(publicSchemas.evidenceSourceRecord);
export type EvidenceSourceRecord = z.infer<typeof evidenceSourceRecordSchema>;

export const evidenceSourceSchema = guardJsonSchema(publicSchemas.evidenceSource);
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const freshnessSchema = guardJsonSchema(publicSchemas.freshness);
export type Freshness = z.infer<typeof freshnessSchema>;

export const conclusionSchema = guardJsonSchema(publicSchemas.conclusion);
export type Conclusion = z.infer<typeof conclusionSchema>;

export const coverageSchema = guardJsonSchema(publicSchemas.coverage);
export type Coverage = z.infer<typeof coverageSchema>;

export const warningSchema = guardJsonSchema(publicSchemas.warning);
export type Warning = z.infer<typeof warningSchema>;

export const staticScopeExclusionSchema = guardJsonSchema(publicSchemas.staticScopeExclusion);
export type StaticScopeExclusion = z.infer<typeof staticScopeExclusionSchema>;

export const fieldIssueSchema = guardJsonSchema(publicSchemas.fieldIssue);
export type FieldIssue = z.infer<typeof fieldIssueSchema>;

export const createFieldIssue = (code: FieldIssueCode, path: string): FieldIssue =>
  deepFreezeValue(authorityFieldIssueSchema.parse({
    path,
    code,
    message: Object.hasOwn(fieldIssueDefinitions, code) ? fieldIssueDefinitions[code].message : undefined,
  }));

export const parseExternalSourceClass = (value: unknown): ExternalSourceClass =>
  authoritySchemas.externalSourceClass.parse(value);

export const parseSourceReference = (value: unknown): SourceReference =>
  authoritySourceReferenceSchema.parse(value);

export const createWarning = (
  code: WarningCode,
  observationIds: readonly ObservationId[],
): Warning => {
  const parsed = authorityWarningSchema.parse({
    code,
    message: Object.hasOwn(warningDefinitions, code) ? warningDefinitions[code].message : undefined,
    observationIds,
  });
  return deepFreezeValue({
    ...parsed,
    observationIds: [...parsed.observationIds],
  }) as Warning;
};

export const deriveCoverage = (conclusions: readonly Conclusion[]): Coverage => {
  const established: string[] = [];
  const notApplicable: string[] = [];
  const unavailable: string[] = [];
  for (const conclusion of conclusions) {
    if (conclusion.status === "established") established.push(conclusion.id);
    else if (conclusion.status === "not_applicable") notApplicable.push(conclusion.id);
    else unavailable.push(conclusion.id);
  }
  const status = coverageStatusForCounts(established.length, notApplicable.length, unavailable.length);
  const parsed = authorityCoverageSchema.parse({
    status,
    established: established.sort(compareCodePointSequences),
    notApplicable: notApplicable.sort(compareCodePointSequences),
    unavailable: unavailable.sort(compareCodePointSequences),
  });
  return deepFreezeValue({
    ...parsed,
    established: [...parsed.established],
    notApplicable: [...parsed.notApplicable],
    unavailable: [...parsed.unavailable],
  }) as Coverage;
};

export const createEvidenceSummary = (
  conclusions: readonly Conclusion[],
  warningInputs: readonly Readonly<{
    code: WarningCode;
    observationIds: readonly ObservationId[];
  }>[],
): Readonly<{ coverage: Coverage; warnings: readonly Warning[] }> => {
  const warnings = warningInputs
    .map((input) => createWarning(input.code, input.observationIds))
    .sort((left, right) => {
      const codeOrder = compareCodePointSequences(left.code, right.code);
      return codeOrder === 0
        ? compareCodePointSequences(left.observationIds.join("\0"), right.observationIds.join("\0"))
        : codeOrder;
    });
  for (let index = 1; index < warnings.length; index += 1) {
    if (
      warnings[index - 1]?.code === warnings[index]?.code &&
      warnings[index - 1]?.observationIds.join("\0") === warnings[index]?.observationIds.join("\0")
    ) throw new TypeError("Warnings must be unique and ordered.");
  }
  return deepFreezeValue({ coverage: deriveCoverage(conclusions), warnings });
};
