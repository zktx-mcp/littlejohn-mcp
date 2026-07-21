import { z, type ZodType } from "zod";

import {
  applicationFailureSchemaFor,
  calculateScaledUiAmount,
  canonicalBase64UrlSchema,
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
  requiredErc8056ObservationSchema,
  scaledUiAmountSchema,
  tokenStandardObservationResultSchema,
  unsignedDecimalSchema,
  utcTimestampSchema,
  type ApplicationContract,
  type ApplicationFailure,
  type Erc20AssetIdentity,
  type ScaledUiAmount,
} from "../core/browser.js";
import {
  tokenDisplayTextSchema,
  tokenSelectionSchema,
  tokenSelectionSetRevisionSchema,
} from "../token-catalog/browser.js";
import { officialAssetCandidatePageSize } from "../registry/browser.js";
import { accountAssetErrorRegistry } from "./error-registry.js";

export const accountAssetLimits = Object.freeze({
  defaultPageSize: 5,
  maximumPageSize: 5,
});

const sourceLabelSchema = tokenDisplayTextSchema.nullable();
const snapshotRevisionSchema = canonicalBase64UrlSchema(16);

export const accountAssetViewRevisionSchema = jsonObject({
  officialSnapshotStatus: z.enum(["current", "unavailable"]),
  officialSnapshotRevision: snapshotRevisionSchema.nullable(),
  selectionSetRevision: tokenSelectionSetRevisionSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.officialSnapshotStatus === "current" && value.officialSnapshotRevision === null) {
    context.addIssue({ code: "custom", message: "A current official snapshot requires a revision." });
  }
});
export type AccountAssetViewRevision = z.infer<typeof accountAssetViewRevisionSchema>;

const cursorCommon = {
  officialSnapshotStatus: z.enum(["current", "unavailable"]),
  officialSnapshotRevision: snapshotRevisionSchema.nullable(),
  selectionSetRevision: tokenSelectionSetRevisionSchema.nullable(),
  address: evmAddressSchema,
};
export const accountAssetCursorSchema = z.discriminatedUnion("group", [
  jsonObject({
    group: z.literal("default"),
    rank: z.number().int().min(0).max(4),
    ...cursorCommon,
  }).strict(),
  jsonObject({
    group: z.literal("other"),
    ...cursorCommon,
  }).strict(),
]);
export type AccountAssetCursor = z.infer<typeof accountAssetCursorSchema>;

const officialSnapshotEvidenceSchema = jsonObject({
  sourceUri: z.string().url(),
  sourceObservedAt: utcTimestampSchema,
  rawResponseDigest: hash32Schema,
  memberSetDigest: hash32Schema,
  revision: snapshotRevisionSchema,
}).strict();

export const accountAssetOfficialCandidateSchema = jsonObject({
  assetUid: hash32Schema,
  contractAddress: evmAddressSchema,
  sourceName: sourceLabelSchema,
  sourceSymbol: sourceLabelSchema,
}).strict();
export type AccountAssetOfficialCandidate = z.infer<typeof accountAssetOfficialCandidateSchema>;

const stockFactoryVerificationSchema = jsonObject({
  assetUid: hash32Schema,
  contractAddress: evmAddressSchema,
  block: chainAnchorSchema,
  proxyAddress: evmAddressSchema,
  proxyCodeHash: hash32Schema,
  implementationAddress: evmAddressSchema,
  implementationCodeHash: hash32Schema,
  tokenCodeHash: hash32Schema,
}).strict();

export const accountAssetClassificationSchema = z.discriminatedUnion("kind", [
  jsonObject({
    kind: z.literal("robinhood_stock_token"),
    snapshot: officialSnapshotEvidenceSchema,
    member: accountAssetOfficialCandidateSchema,
    verification: stockFactoryVerificationSchema,
  }).strict().superRefine((value, context) => {
    if (
      value.member.assetUid !== value.verification.assetUid ||
      value.member.contractAddress !== value.verification.contractAddress
    ) context.addIssue({ code: "custom", message: "Official asset verification identity differs." });
  }),
  jsonObject({
    kind: z.literal("custom_erc20"),
    snapshot: officialSnapshotEvidenceSchema,
  }).strict(),
  jsonObject({
    kind: z.literal("classification_unavailable"),
    storedRevision: snapshotRevisionSchema.nullable(),
    snapshot: officialSnapshotEvidenceSchema.nullable(),
    member: accountAssetOfficialCandidateSchema.nullable(),
    reason: z.enum([
      "factory_identity_mismatch",
      "source_inconsistent",
      "source_unavailable",
      "token_code_missing",
      "token_identity_mismatch",
    ]),
  }).strict().superRefine((value, context) => {
    if ((value.snapshot === null) !== (value.member === null) ||
      (value.snapshot !== null && value.snapshot.revision !== value.storedRevision)) {
      context.addIssue({ code: "custom", message: "Unavailable classification evidence is incomplete." });
    }
  }),
]);
export type AccountAssetClassification = z.infer<typeof accountAssetClassificationSchema>;

const currentTokenTextSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("available"), value: tokenDisplayTextSchema }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.enum(["call_failed", "malformed", "unsafe_text"]),
  }).strict(),
]);

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
  name: currentTokenTextSchema,
  symbol: currentTokenTextSchema,
  classification: accountAssetClassificationSchema,
  amount: accountAssetAmountSchema,
  requiredStandards: requiredErc8056ObservationSchema,
}).strict().superRefine((value, context) => {
  if (!value.selection.included ||
    value.selection.asset.address !== value.requiredStandards.asset.address ||
    value.selection.asset.chainId !== value.requiredStandards.asset.chainId) {
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

const exactInputSchema = jsonObject({
  asset: erc20AssetIdentitySchema,
  viewRevision: accountAssetViewRevisionSchema,
}).strict();

export const accountAssetOfficialCandidateCursorSchema = jsonObject({
  assetUid: hash32Schema,
  contractAddress: evmAddressSchema,
  officialSnapshotRevision: snapshotRevisionSchema,
  selectionSetRevision: tokenSelectionSetRevisionSchema,
}).strict();
export type AccountAssetOfficialCandidateCursor = z.infer<
  typeof accountAssetOfficialCandidateCursorSchema
>;

const officialCandidateInputSchema = jsonObject({
  viewRevision: accountAssetViewRevisionSchema,
  cursor: accountAssetOfficialCandidateCursorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (
    value.viewRevision.officialSnapshotStatus !== "current" ||
    value.viewRevision.officialSnapshotRevision === null ||
    value.viewRevision.selectionSetRevision === null ||
    (value.cursor !== undefined && (
      value.cursor.officialSnapshotRevision !== value.viewRevision.officialSnapshotRevision ||
      value.cursor.selectionSetRevision !== value.viewRevision.selectionSetRevision
    ))
  ) context.addIssue({ code: "custom", message: "Official candidate revisions are invalid." });
}).transform((value) => ({
  viewRevision: value.viewRevision,
  cursor: value.cursor ?? null,
}));

const officialCandidateRequestSchema = jsonObject({
  viewRevision: accountAssetViewRevisionSchema,
  cursor: accountAssetOfficialCandidateCursorSchema.nullable(),
}).strict();

const sameBlock = (
  left: z.output<typeof chainAnchorSchema>,
  right: z.output<typeof chainAnchorSchema>,
): boolean => left.chainId === right.chainId &&
  left.blockHash === right.blockHash &&
  left.blockNumber === right.blockNumber &&
  left.blockTimestamp === right.blockTimestamp;

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
  return classification.storedRevision === revision.officialSnapshotRevision &&
    (revision.officialSnapshotStatus === "current"
      ? classification.snapshot !== null
      : classification.snapshot === null);
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
      value.nextCursor.officialSnapshotRevision !== value.viewRevision.officialSnapshotRevision ||
      value.nextCursor.officialSnapshotStatus !== value.viewRevision.officialSnapshotStatus ||
      value.nextCursor.selectionSetRevision !== value.viewRevision.selectionSetRevision ||
      value.nextCursor.address !== value.assets.at(-1)?.selection.asset.address
    ))
  ) context.addIssue({ code: "custom", message: "Account asset collection identities differ." });
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

const officialCandidateSuccessSchema = jsonObject({
  account: evmAccountIdentitySchema,
  viewRevision: accountAssetViewRevisionSchema,
  candidates: z.array(accountAssetOfficialCandidateSchema)
    .max(officialAssetCandidatePageSize),
  nextCursor: accountAssetOfficialCandidateCursorSchema.nullable(),
}).strict().superRefine((value, context) => {
  for (let index = 1; index < value.candidates.length; index += 1) {
    const previous = value.candidates[index - 1]!;
    const current = value.candidates[index]!;
    if (
      current.assetUid < previous.assetUid ||
      current.assetUid === previous.assetUid && current.contractAddress <= previous.contractAddress
    ) context.addIssue({ code: "custom", message: "Official candidates are not in canonical order." });
  }
  if (
    value.viewRevision.officialSnapshotStatus !== "current" ||
    value.viewRevision.officialSnapshotRevision === null ||
    value.viewRevision.selectionSetRevision === null ||
    (value.nextCursor !== null && (
      value.nextCursor.officialSnapshotRevision !== value.viewRevision.officialSnapshotRevision ||
      value.nextCursor.selectionSetRevision !== value.viewRevision.selectionSetRevision ||
      value.nextCursor.assetUid !== value.candidates.at(-1)?.assetUid ||
      value.nextCursor.contractAddress !== value.candidates.at(-1)?.contractAddress
    ))
  ) context.addIssue({ code: "custom", message: "Official candidate result revisions differ." });
});

export type AccountAssetCollectionInput = z.input<typeof collectionInputSchema>;
export type AccountAssetCollectionRequest = z.output<typeof collectionInputSchema>;
export type AccountAssetCollectionSuccess = z.output<typeof collectionSuccessSchema>;
export type AccountAssetExactInput = z.output<typeof exactInputSchema>;
export type AccountAssetExactSuccess = z.output<typeof exactSuccessSchema>;
export type AccountAssetOfficialCandidateInput = z.input<typeof officialCandidateInputSchema>;
export type AccountAssetOfficialCandidateRequest = z.output<typeof officialCandidateInputSchema>;
export type AccountAssetOfficialCandidateSuccess = z.output<typeof officialCandidateSuccessSchema>;

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

const officialCandidateApplicationContract = defineApplicationContract({
  inputSchema: officialCandidateInputSchema,
  correlationInputSchema: officialCandidateRequestSchema,
  successSchema: officialCandidateSuccessSchema,
  internalContextSchema: jsonObject({}).strict(),
  errorRegistry: accountAssetErrorRegistry,
  failureCodes: wholeRequestFailureCodes,
  validatePublicSuccess: (input, success) => {
    if (
      input.viewRevision.officialSnapshotStatus !== success.viewRevision.officialSnapshotStatus ||
      input.viewRevision.officialSnapshotRevision !== success.viewRevision.officialSnapshotRevision ||
      input.viewRevision.selectionSetRevision !== success.viewRevision.selectionSetRevision ||
      (input.cursor !== null && success.candidates.some((candidate) =>
        candidate.assetUid < input.cursor!.assetUid ||
        candidate.assetUid === input.cursor!.assetUid &&
        candidate.contractAddress <= input.cursor!.contractAddress))
    ) throw new TypeError("Official candidate result does not match its request.");
  },
});

export const accountAssetOfficialCandidateQueryContract = Object.freeze({
  inputSchema: officialCandidateInputSchema,
  successSchema: officialCandidateSuccessSchema,
  failureCodes: officialCandidateApplicationContract.failureCodes,
  parseInput: officialCandidateApplicationContract.parseInput,
  parsePublicSuccess: officialCandidateApplicationContract.parsePublicSuccess,
  parseFailure: officialCandidateApplicationContract.parseFailure,
  normalizeFailure: officialCandidateApplicationContract.normalizeFailure,
});

export interface AccountAssetRequestContract<Input, Success> {
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
  inputSchema: ZodType<Input>;
  correlationInputSchema?: ZodType<Input>;
  successSchema: ZodType<Success>;
  failureCodes: readonly string[];
  validatePublicSuccess: (input: Input, success: Success) => void;
}>): AccountAssetApplicationContract<Input, Success> => {
  const capabilityId = capabilityIdSchema.parse(options.capabilityId);
  const applicationContract = defineApplicationContract({
    inputSchema: options.inputSchema,
    ...(options.correlationInputSchema === undefined
      ? {}
      : { correlationInputSchema: options.correlationInputSchema }),
    successSchema: options.successSchema,
    internalContextSchema: jsonObject({}).strict(),
    errorRegistry: accountAssetErrorRegistry,
    failureCodes: options.failureCodes,
    validatePublicSuccess: options.validatePublicSuccess,
  });
  return Object.freeze({
    capabilityId,
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
    inputSchema: collectionInputSchema,
    correlationInputSchema: collectionRequestSchema,
    successSchema: collectionSuccessSchema,
    failureCodes: wholeRequestFailureCodes,
    validatePublicSuccess: (input, success) => {
      if (success.assets.length > input.limit ||
        (success.nextCursor !== null && success.assets.length !== input.limit) ||
        (input.cursor !== null && (
          input.cursor.officialSnapshotRevision !== success.viewRevision.officialSnapshotRevision ||
          input.cursor.officialSnapshotStatus !== success.viewRevision.officialSnapshotStatus ||
          input.cursor.selectionSetRevision !== success.viewRevision.selectionSetRevision
        ))) throw new TypeError("Account asset collection does not match its request.");
    },
  }),
  exact: defineAccountAssetContract({
    capabilityId: "account.asset",
    inputSchema: exactInputSchema,
    successSchema: exactSuccessSchema,
    failureCodes: [...wholeRequestFailureCodes, "token_selection_not_found"],
    validatePublicSuccess: (input, success) => {
      if (
        input.asset.chainId !== success.asset.selection.asset.chainId ||
        input.asset.address !== success.asset.selection.asset.address ||
        input.viewRevision.officialSnapshotRevision !== success.viewRevision.officialSnapshotRevision ||
        input.viewRevision.officialSnapshotStatus !== success.viewRevision.officialSnapshotStatus ||
        input.viewRevision.selectionSetRevision !== success.viewRevision.selectionSetRevision
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
