import { z, type ZodType } from "zod";

import {
  applicationFailureSchemaFor,
  calculateScaledUiAmount,
  capabilityIdSchema,
  chainAnchorSchema,
  defineApplicationContract,
  erc20AssetIdentitySchema,
  evmAccountIdentitySchema,
  evmAddressSchema,
  evmChainIdSchema,
  formatAmount,
  generalSingleLineTextSchema,
  hash32Schema,
  jsonObject,
  optionalTokenTextSchema,
  requiredErc8056ObservationSchema,
  scaledUiAmountSchema,
  tokenDisplayTextSchema,
  tokenStandardObservationResultSchema,
  unsignedDecimalSchema,
  type ApplicationContract,
  type ApplicationFailure,
  type Erc20AssetIdentity,
  type ScaledUiAmount,
} from "../core/browser.js";
import {
  tokenSelectionSchema,
  tokenSelectionSetRevisionSchema,
} from "../token-catalog/browser.js";
import {
  officialAssetCandidateSchema,
  officialAssetSourceDefinition,
  officialAssetSnapshotEvidenceSchema,
  officialAssetSnapshotRevisionSchema,
  stockFactoryClassificationUnavailableReasonSchema,
  stockFactoryVerificationSchema,
  type OfficialAssetCandidate,
  type OfficialAssetSourceMember,
} from "../registry/browser.js";
import { officialAssetCandidateListDigest } from "../registry/official-asset-contract.js";
import { tokenCatalogErrorRegistry } from "../token-catalog/error-registry.js";

export const accountAssetLimits = Object.freeze({
  defaultPageSize: 5,
  maximumPageSize: 5,
});

const accountAssetOfficialSnapshotUnavailableReasons = Object.freeze([
  "source_inconsistent",
  "source_unavailable",
] as const);
const accountAssetOfficialSnapshotUnavailableReasonSchema = z.enum(
  accountAssetOfficialSnapshotUnavailableReasons,
);
export type AccountAssetOfficialSnapshotUnavailableReason =
  z.infer<typeof accountAssetOfficialSnapshotUnavailableReasonSchema>;

const currentOfficialSnapshotRevisionShape = {
  officialSnapshotStatus: z.literal("current"),
  officialSnapshotRevision: officialAssetSnapshotRevisionSchema,
  selectionSetRevision: tokenSelectionSetRevisionSchema.nullable(),
};
const unavailableOfficialSnapshotRevisionShape = {
  officialSnapshotStatus: z.literal("unavailable"),
  officialSnapshotRevision: officialAssetSnapshotRevisionSchema.nullable(),
  officialSnapshotUnavailableReason: accountAssetOfficialSnapshotUnavailableReasonSchema,
  selectionSetRevision: tokenSelectionSetRevisionSchema.nullable(),
};
export const accountAssetViewRevisionSchema = z.discriminatedUnion("officialSnapshotStatus", [
  jsonObject(currentOfficialSnapshotRevisionShape).strict(),
  jsonObject(unavailableOfficialSnapshotRevisionShape).strict(),
]);
export type AccountAssetViewRevision = z.infer<typeof accountAssetViewRevisionSchema>;

const cursorIdentityShape = {
  address: evmAddressSchema,
};
export const accountAssetCursorSchema = z.union([
  jsonObject({
    group: z.literal("default"),
    rank: z.number().int().min(0).max(4),
    ...currentOfficialSnapshotRevisionShape,
    ...cursorIdentityShape,
  }).strict(),
  jsonObject({
    group: z.literal("default"),
    rank: z.number().int().min(0).max(4),
    ...unavailableOfficialSnapshotRevisionShape,
    ...cursorIdentityShape,
  }).strict(),
  jsonObject({
    group: z.literal("other"),
    ...currentOfficialSnapshotRevisionShape,
    ...cursorIdentityShape,
  }).strict(),
  jsonObject({
    group: z.literal("other"),
    ...unavailableOfficialSnapshotRevisionShape,
    ...cursorIdentityShape,
  }).strict(),
]);
export type AccountAssetCursor = z.infer<typeof accountAssetCursorSchema>;

const accountAssetClassificationUnavailableCauseSchema = z.discriminatedUnion("kind", [
  jsonObject({
    kind: z.literal("official_snapshot_unavailable"),
    storedRevision: officialAssetSnapshotRevisionSchema.nullable(),
    reason: accountAssetOfficialSnapshotUnavailableReasonSchema,
  }).strict(),
  jsonObject({
    kind: z.literal("stock_factory_verification_unavailable"),
    snapshot: officialAssetSnapshotEvidenceSchema,
    member: officialAssetCandidateSchema,
    reason: stockFactoryClassificationUnavailableReasonSchema,
  }).strict(),
]);

export const accountAssetClassificationSchema = z.discriminatedUnion("kind", [
  jsonObject({
    kind: z.literal("robinhood_stock_token"),
    snapshot: officialAssetSnapshotEvidenceSchema,
    member: officialAssetCandidateSchema,
    verification: stockFactoryVerificationSchema,
  }).strict().superRefine((value, context) => {
    if (
      value.member.assetUid !== value.verification.assetUid ||
      value.member.contractAddress !== value.verification.contractAddress
    ) context.addIssue({ code: "custom", message: "Official asset verification identity differs." });
  }),
  jsonObject({
    kind: z.literal("custom_erc20"),
    snapshot: officialAssetSnapshotEvidenceSchema,
  }).strict(),
  jsonObject({
    kind: z.literal("classification_unavailable"),
    cause: accountAssetClassificationUnavailableCauseSchema,
  }).strict(),
]);
export type AccountAssetClassification = z.infer<typeof accountAssetClassificationSchema>;

const officialMemberForClassification = (
  classification: AccountAssetClassification,
): OfficialAssetCandidate | null => {
  if (classification.kind === "robinhood_stock_token") return classification.member;
  if (classification.kind === "custom_erc20") return null;
  return classification.cause.kind === "stock_factory_verification_unavailable"
    ? classification.cause.member
    : null;
};

export const accountAssetAmountSchema = jsonObject({
  raw: unsignedDecimalSchema,
  decimals: unsignedDecimalSchema.nullable(),
  formattedRaw: generalSingleLineTextSchema.nullable(),
  uiAdjusted: scaledUiAmountSchema.nullable(),
  formattedUiAdjusted: generalSingleLineTextSchema.nullable(),
}).strict().superRefine((value, context) => {
  const expectedRaw = value.decimals === null ? null : formatAmount(value.raw, value.decimals);
  const expectedUi = value.decimals !== null && value.uiAdjusted?.status === "available"
    ? formatAmount(value.uiAdjusted.adjustedRaw, value.decimals)
    : null;
  if (value.formattedRaw !== expectedRaw || value.formattedUiAdjusted !== expectedUi) {
    context.addIssue({ code: "custom", message: "Account asset amount formatting is inconsistent." });
  }
});
export type AccountAssetAmount = z.infer<typeof accountAssetAmountSchema>;

export const nativeAccountAssetSchema = jsonObject({
  kind: z.literal("native"),
  asset: jsonObject({ kind: z.literal("native"), chainId: evmChainIdSchema }).strict(),
  rawBalance: unsignedDecimalSchema,
  classification: z.literal("native"),
}).strict();
export type NativeAccountAsset = z.infer<typeof nativeAccountAssetSchema>;

export const contractAccountAssetSchema = jsonObject({
  kind: z.literal("erc20"),
  selection: tokenSelectionSchema,
  name: optionalTokenTextSchema,
  symbol: optionalTokenTextSchema,
  classification: accountAssetClassificationSchema,
  amount: accountAssetAmountSchema,
  requiredStandards: requiredErc8056ObservationSchema,
}).strict().superRefine((value, context) => {
  const officialMember = officialMemberForClassification(value.classification);
  if (!value.selection.included ||
    value.selection.asset.address !== value.requiredStandards.asset.address ||
    value.selection.asset.chainId !== value.requiredStandards.asset.chainId ||
    (officialMember !== null &&
      officialMember.contractAddress !== value.selection.asset.address)) {
    context.addIssue({ code: "custom", message: "Account asset selection and observation differ." });
  }
  const multiplier = value.requiredStandards.values?.currentMultiplier;
  if (
    (multiplier === undefined) !== (value.amount.uiAdjusted === null) ||
    (multiplier !== undefined && value.amount.uiAdjusted?.multiplier !== multiplier)
  ) {
    context.addIssue({ code: "custom", message: "Account asset amount and multiplier differ." });
  }
});
export type ContractAccountAsset = z.infer<typeof contractAccountAssetSchema>;

const collectionInputSchema = jsonObject({
  limit: z.number().int().min(1).max(accountAssetLimits.maximumPageSize).optional(),
  cursor: accountAssetCursorSchema.optional(),
}).strict().transform((value) => ({
  limit: value.limit ?? accountAssetLimits.defaultPageSize,
  cursor: value.cursor ?? null,
}));
const collectionRequestSchema = jsonObject({
  limit: z.number().int().min(1).max(accountAssetLimits.maximumPageSize),
  cursor: accountAssetCursorSchema.nullable(),
}).strict();

const overviewInputSchema = jsonObject({}).strict();

const exactInputSchema = jsonObject({
  asset: erc20AssetIdentitySchema,
  viewRevision: accountAssetViewRevisionSchema,
}).strict();

export const normalizeAccountAssetOfficialCandidateSearch = (
  value: string,
): string | null => {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
  return normalized === "" ? null : normalized;
};

const normalizedOfficialCandidateSearchSchema = tokenDisplayTextSchema
  .refine((value) => value.length > 0, "Official candidate search cannot be empty.")
  .refine(
    (value) => normalizeAccountAssetOfficialCandidateSearch(value) === value,
    "Official candidate search is not normalized.",
  );

const officialCandidateSearchInputSchema = tokenDisplayTextSchema
  .nullable()
  .optional()
  .transform((value) =>
    value === undefined || value === null
      ? null
      : normalizeAccountAssetOfficialCandidateSearch(value))
  .pipe(normalizedOfficialCandidateSearchSchema.nullable());

const sameBlock = (
  left: z.output<typeof chainAnchorSchema>,
  right: z.output<typeof chainAnchorSchema>,
): boolean => left.chainId === right.chainId &&
  left.blockHash === right.blockHash &&
  left.blockNumber === right.blockNumber &&
  left.blockTimestamp === right.blockTimestamp;

const sameViewRevision = (
  left: AccountAssetViewRevision,
  right: AccountAssetViewRevision,
): boolean => left.officialSnapshotStatus === right.officialSnapshotStatus &&
  left.officialSnapshotRevision === right.officialSnapshotRevision &&
  left.selectionSetRevision === right.selectionSetRevision &&
  (left.officialSnapshotStatus === "current" ||
    (right.officialSnapshotStatus === "unavailable" &&
      left.officialSnapshotUnavailableReason === right.officialSnapshotUnavailableReason));

const classificationMatchesView = (
  classification: AccountAssetClassification,
  revision: AccountAssetViewRevision,
  block: z.output<typeof chainAnchorSchema>,
): boolean => {
  if (classification.kind === "robinhood_stock_token") {
    return revision.officialSnapshotStatus === "current" &&
      classification.snapshot.revision === revision.officialSnapshotRevision &&
      sameBlock(classification.verification.block, block);
  }
  if (classification.kind === "custom_erc20") {
    return revision.officialSnapshotStatus === "current" &&
      classification.snapshot.revision === revision.officialSnapshotRevision;
  }
  return classification.cause.kind === "official_snapshot_unavailable"
    ? revision.officialSnapshotStatus === "unavailable" &&
      classification.cause.storedRevision === revision.officialSnapshotRevision &&
      classification.cause.reason === revision.officialSnapshotUnavailableReason
    : revision.officialSnapshotStatus === "current" &&
      classification.cause.snapshot.revision === revision.officialSnapshotRevision;
};

const collectionSuccessSchema = jsonObject({
  account: evmAccountIdentitySchema,
  block: chainAnchorSchema,
  viewRevision: accountAssetViewRevisionSchema,
  native: nativeAccountAssetSchema,
  assets: z.array(contractAccountAssetSchema).max(accountAssetLimits.maximumPageSize),
  nextCursor: accountAssetCursorSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (
    value.block.chainId !== value.account.chainId ||
    value.native.asset.chainId !== value.account.chainId ||
    value.assets.some((entry) =>
      entry.selection.account.chainId !== value.account.chainId ||
      entry.selection.account.address !== value.account.address ||
      !sameBlock(entry.requiredStandards.block, value.block) ||
      !classificationMatchesView(entry.classification, value.viewRevision, value.block)) ||
    (value.nextCursor !== null && (
      !sameViewRevision(value.nextCursor, value.viewRevision) ||
      value.nextCursor.address !== value.assets.at(-1)?.selection.asset.address
    ))
  ) context.addIssue({ code: "custom", message: "Account asset collection identities differ." });
});

const officialOverviewAssetSchema = contractAccountAssetSchema.superRefine((value, context) => {
  const member = officialMemberForClassification(value.classification);
  if (
    value.classification.kind === "custom_erc20" ||
    member === null
  ) {
    context.addIssue({
      code: "custom",
      message: "The Stock Token overview contains a non-official asset.",
    });
  }
});

const accountAssetOverviewStockTokenMemberSchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("selected"),
    asset: officialOverviewAssetSchema,
  }).strict(),
  jsonObject({
    status: z.literal("available_to_add"),
    candidate: officialAssetCandidateSchema,
  }).strict(),
]);

const accountAssetOverviewStockTokensSchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("current"),
    candidateListDigest: hash32Schema,
    members: z.array(accountAssetOverviewStockTokenMemberSchema)
      .min(1)
      .max(officialAssetSourceDefinition.memberLimit),
  }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: accountAssetOfficialSnapshotUnavailableReasonSchema,
  }).strict(),
]);

const overviewSuccessSchema = jsonObject({
  account: evmAccountIdentitySchema,
  block: chainAnchorSchema,
  viewRevision: accountAssetViewRevisionSchema,
  native: nativeAccountAssetSchema,
  stockTokens: accountAssetOverviewStockTokensSchema,
}).strict().superRefine((value, context) => {
  if (
    value.block.chainId !== value.account.chainId ||
    value.native.asset.chainId !== value.account.chainId ||
    (value.stockTokens.status === "current") !==
      (value.viewRevision.officialSnapshotStatus === "current")
  ) {
    context.addIssue({ code: "custom", message: "Account asset overview state differs." });
    return;
  }
  if (value.stockTokens.status !== "current") {
    if (
      value.viewRevision.officialSnapshotStatus !== "unavailable" ||
      value.stockTokens.reason !== value.viewRevision.officialSnapshotUnavailableReason
    ) context.addIssue({ code: "custom", message: "Account asset overview reason differs." });
    return;
  }
  const digestMembers: OfficialAssetSourceMember[] = [];
  for (const entry of value.stockTokens.members) {
    const asset = entry.status === "selected" ? entry.asset : null;
    const classification = asset?.classification;
    const member = entry.status === "available_to_add"
      ? entry.candidate
      : classification === undefined
        ? null
        : officialMemberForClassification(classification);
    if (
      member === null ||
      (asset !== null && (
        asset.selection.account.chainId !== value.account.chainId ||
        asset.selection.account.address !== value.account.address ||
        !sameBlock(asset.requiredStandards.block, value.block) ||
        !classificationMatchesView(asset.classification, value.viewRevision, value.block)
      ))
    ) {
      context.addIssue({
        code: "custom",
        message: "Account asset overview member identity differs.",
      });
      return;
    }
    digestMembers.push(Object.freeze({
      assetUid: member.assetUid,
      contractAddress: member.contractAddress,
      ...(member.sourceName === null ? {} : { sourceName: member.sourceName }),
      ...(member.sourceSymbol === null ? {} : { sourceSymbol: member.sourceSymbol }),
    }));
  }
  if (
    value.viewRevision.selectionSetRevision === null ||
    officialAssetCandidateListDigest(digestMembers) !==
      value.stockTokens.candidateListDigest
  ) {
    context.addIssue({
      code: "custom",
      message: "Account asset overview official member commitment differs.",
    });
  }
});

const exactSuccessSchema = jsonObject({
  account: evmAccountIdentitySchema,
  block: chainAnchorSchema,
  viewRevision: accountAssetViewRevisionSchema,
  asset: contractAccountAssetSchema,
  totalSupply: unsignedDecimalSchema,
  standards: tokenStandardObservationResultSchema,
}).strict().superRefine((value, context) => {
  const required = value.asset.requiredStandards;
  const completeValues = value.standards.requiredErc8056;
  const requiredObservationMismatch =
    value.standards.standards[1]?.status !== required.erc165.status ||
    value.standards.standards[2]?.status !== required.erc8056.status ||
    value.standards.standards[3]?.status !== required.pendingMultiplier.status ||
    (required.values === undefined) !== (completeValues === undefined) ||
    (required.values !== undefined && completeValues !== undefined && (
      required.values.currentMultiplier !== completeValues.currentMultiplier ||
      required.values.pendingMultiplier !== completeValues.pendingMultiplier ||
      required.values.pendingEffectiveAt !== completeValues.pendingEffectiveAt
    )) ||
    (value.standards.calculatedBalance !== undefined && (
      value.asset.amount.uiAdjusted === null ||
      value.standards.calculatedBalance.status !== value.asset.amount.uiAdjusted.status ||
      value.standards.calculatedBalance.multiplier !== value.asset.amount.uiAdjusted.multiplier ||
      (value.standards.calculatedBalance.status === "available" &&
        value.asset.amount.uiAdjusted.status === "available" &&
        value.standards.calculatedBalance.adjustedRaw !== value.asset.amount.uiAdjusted.adjustedRaw)
    ));
  if (
    value.asset.selection.account.chainId !== value.account.chainId ||
    value.asset.selection.account.address !== value.account.address ||
    !sameBlock(value.asset.requiredStandards.block, value.block) ||
    !sameBlock(value.standards.block, value.block) ||
    value.standards.asset.address !== value.asset.selection.asset.address ||
    value.standards.account?.address !== value.account.address ||
    !classificationMatchesView(value.asset.classification, value.viewRevision, value.block) ||
    requiredObservationMismatch
  ) context.addIssue({ code: "custom", message: "Exact account asset identities differ." });
});

export type AccountAssetCollectionInput = z.input<typeof collectionInputSchema>;
export type AccountAssetCollectionRequest = z.output<typeof collectionInputSchema>;
export type AccountAssetCollectionSuccess = z.output<typeof collectionSuccessSchema>;
export type AccountAssetOverviewInput = z.output<typeof overviewInputSchema>;
export type AccountAssetOverviewSuccess = z.output<typeof overviewSuccessSchema>;
export type AccountAssetOverviewStockTokenMember =
  z.output<typeof accountAssetOverviewStockTokenMemberSchema>;
export type AccountAssetExactInput = z.output<typeof exactInputSchema>;
export type AccountAssetExactSuccess = z.output<typeof exactSuccessSchema>;

export const filterAccountAssetOfficialCandidates = (
  candidates: readonly OfficialAssetCandidate[],
  searchInput: unknown,
): readonly OfficialAssetCandidate[] => {
  const search = officialCandidateSearchInputSchema.parse(searchInput);
  if (search === null) return candidates;
  return candidates.filter((candidate) => {
    const name = candidate.sourceName === null
      ? null
      : normalizeAccountAssetOfficialCandidateSearch(candidate.sourceName);
    const symbol = candidate.sourceSymbol === null
      ? null
      : normalizeAccountAssetOfficialCandidateSearch(candidate.sourceSymbol);
    return name?.includes(search) === true || symbol?.includes(search) === true;
  });
};

export const createAccountAssetAmount = (input: Readonly<{
  raw: string;
  decimals: string | null;
  multiplier: string | null;
}>): AccountAssetAmount => {
  const uiAdjusted: ScaledUiAmount | null = input.multiplier === null
    ? null
    : calculateScaledUiAmount(input.raw, input.multiplier);
  return accountAssetAmountSchema.parse({
    raw: input.raw,
    decimals: input.decimals,
    formattedRaw: input.decimals === null ? null : formatAmount(input.raw, input.decimals),
    uiAdjusted,
    formattedUiAdjusted: input.decimals !== null && uiAdjusted?.status === "available"
      ? formatAmount(uiAdjusted.adjustedRaw, input.decimals)
      : null,
  });
};

const wholeRequestFailureCodes = Object.freeze([
  "chain_response_unavailable",
  "internal_error",
  "invalid_input",
  "port_conflict",
  "rate_limited",
  "request_aborted",
  "runtime_busy",
  "runtime_state_unavailable",
  "source_inconsistent",
  "source_unavailable",
  "state_conflict",
  "wallet_not_connected",
  "wallet_session_unusable",
]);

const overviewApplicationContract = defineApplicationContract({
  contractVersion: "1",
  inputSchema: overviewInputSchema,
  successSchema: overviewSuccessSchema,
  internalContextSchema: jsonObject({}).strict(),
  errorRegistry: tokenCatalogErrorRegistry,
  failureCodes: wholeRequestFailureCodes,
  validatePublicSuccess: (_input, success) => {
    if (
      (success.viewRevision.officialSnapshotStatus === "current" &&
        success.stockTokens.status !== "current") ||
      (success.viewRevision.officialSnapshotStatus === "unavailable" &&
        success.stockTokens.status !== "unavailable")
    ) throw new TypeError("Account asset overview does not match its revision.");
  },
});

export const accountAssetOverviewQueryContract = Object.freeze({
  contractVersion: overviewApplicationContract.contractVersion,
  inputSchema: overviewInputSchema,
  successSchema: overviewSuccessSchema,
  failureCodes: overviewApplicationContract.failureCodes,
  parseInput: overviewApplicationContract.parseInput,
  parsePublicSuccess: overviewApplicationContract.parsePublicSuccess,
  parseFailure: overviewApplicationContract.parseFailure,
  normalizeFailure: overviewApplicationContract.normalizeFailure,
});

export interface AccountAssetRequestContract<Input, Success> {
  readonly contractVersion: "1";
  readonly inputSchema: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly failureCodes: readonly string[];
  parseInput(value: unknown): Input;
  parsePublicSuccess(input: unknown, value: unknown): Success;
  parseFailure(value: unknown): ApplicationFailure;
  normalizeFailure(value: unknown): ApplicationFailure;
}

export interface AccountAssetApplicationContract<Input, Success>
  extends AccountAssetRequestContract<Input, Success> {
  readonly capabilityId: ReturnType<typeof capabilityIdSchema.parse>;
  readonly applicationContract: ApplicationContract<Input, Record<string, never>, Success>;
}

const defineAccountAssetContract = <Input, Success>(options: Readonly<{
  capabilityId: "account.assets" | "account.asset";
  contractVersion: "1";
  inputSchema: ZodType<Input>;
  correlationInputSchema?: ZodType<Input>;
  successSchema: ZodType<Success>;
  failureCodes: readonly string[];
  validatePublicSuccess: (input: Input, success: Success) => void;
}>): AccountAssetApplicationContract<Input, Success> => {
  const capabilityId = capabilityIdSchema.parse(options.capabilityId);
  const applicationContract = defineApplicationContract({
    contractVersion: options.contractVersion,
    inputSchema: options.inputSchema,
    ...(options.correlationInputSchema === undefined
      ? {}
      : { correlationInputSchema: options.correlationInputSchema }),
    successSchema: options.successSchema,
    internalContextSchema: jsonObject({}).strict(),
    errorRegistry: tokenCatalogErrorRegistry,
    failureCodes: options.failureCodes,
    validatePublicSuccess: options.validatePublicSuccess,
  });
  return Object.freeze({
    capabilityId,
    contractVersion: applicationContract.contractVersion,
    applicationContract,
    inputSchema: options.inputSchema,
    successSchema: options.successSchema,
    failureCodes: applicationContract.failureCodes,
    parseInput: applicationContract.parseInput,
    parsePublicSuccess: applicationContract.parsePublicSuccess,
    parseFailure: applicationContract.parseFailure,
    normalizeFailure: applicationContract.normalizeFailure,
  });
};

export const accountAssetApplicationContracts = Object.freeze({
  collection: defineAccountAssetContract({
    capabilityId: "account.assets",
    contractVersion: "1",
    inputSchema: collectionInputSchema,
    correlationInputSchema: collectionRequestSchema,
    successSchema: collectionSuccessSchema,
    failureCodes: wholeRequestFailureCodes,
    validatePublicSuccess: (input, success) => {
      if (success.assets.length > input.limit ||
        (success.nextCursor !== null && success.assets.length !== input.limit) ||
        (input.cursor !== null && !sameViewRevision(input.cursor, success.viewRevision))) {
        throw new TypeError("Account asset collection does not match its request.");
      }
    },
  }),
  exact: defineAccountAssetContract({
    capabilityId: "account.asset",
    contractVersion: "1",
    inputSchema: exactInputSchema,
    successSchema: exactSuccessSchema,
    failureCodes: [...wholeRequestFailureCodes, "token_selection_not_found"],
    validatePublicSuccess: (input, success) => {
      if (
        input.asset.chainId !== success.asset.selection.asset.chainId ||
        input.asset.address !== success.asset.selection.asset.address ||
        !sameViewRevision(input.viewRevision, success.viewRevision)
      ) throw new TypeError("Exact account asset result does not match its request.");
    },
  }),
});

export type AnyAccountAssetApplicationContract =
  (typeof accountAssetApplicationContracts)[keyof typeof accountAssetApplicationContracts];

export const accountAssetCapabilityIds = Object.freeze(
  Object.values(accountAssetApplicationContracts).map((contract) => contract.capabilityId).sort(),
);

export type { Erc20AssetIdentity };
