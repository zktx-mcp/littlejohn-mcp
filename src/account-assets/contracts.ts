import { z, type ZodType } from "zod";

import {
  addressTargetSchema,
  calculateScaledUiAmount,
  capabilityIdSchema,
  canonicalJsonStringify,
  chainAnchorSchema,
  captureCanonicalJson,
  compareCodePointSequences,
  defineApplicationContract,
  evmAccountIdentitySchema,
  evmAddressSchema,
  evmChainIdSchema,
  formatAmount,
  generalSingleLineTextSchema,
  jsonObject,
  optionalTokenTextSchema,
  requiredErc8056ObservationSchema,
  scaledUiAmountSchema,
  uint256DecimalSchema,
  unsignedDecimalSchema,
  type ApplicationContract,
  type ApplicationFailure,
  type ScaledUiAmount,
} from "../core/client.js";
import {
  tokenSelectionSchema,
  tokenSelectionSetRevisionSchema,
} from "../token-catalog/client.js";
import {
  defaultStockTokenRank,
  defaultStockTokenRankSchema,
  officialAssetCandidateSchema,
  officialAssetSourceClassificationUnavailableReasonSchema,
  officialAssetSnapshotEvidenceSchema,
  officialAssetSnapshotRevisionSchema,
  stockFactoryClassificationUnavailableReasonSchema,
  stockFactoryVerificationSchema,
  type OfficialAssetSourceClassificationUnavailableReason,
  type OfficialAssetCandidate,
  type OfficialAssetSnapshotEvidence,
} from "../registry/client.js";
import { tokenCatalogErrorRegistry } from "../token-catalog/error-registry.js";

export const accountAssetLimits = Object.freeze({
  defaultPageSize: 5,
  maximumPageSize: 5,
});

export type AccountAssetOfficialSnapshotUnavailableReason =
  OfficialAssetSourceClassificationUnavailableReason;

const currentOfficialSnapshotRevisionShape = {
  account: evmAccountIdentitySchema,
  officialSnapshotStatus: z.literal("current"),
  officialSnapshotRevision: officialAssetSnapshotRevisionSchema,
  selectionSetRevision: tokenSelectionSetRevisionSchema.nullable(),
};
const unavailableOfficialSnapshotRevisionShape = {
  account: evmAccountIdentitySchema,
  officialSnapshotStatus: z.literal("unavailable"),
  officialSnapshotRevision: officialAssetSnapshotRevisionSchema.nullable(),
  officialSnapshotUnavailableReason: officialAssetSourceClassificationUnavailableReasonSchema,
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
const defaultCursorShape = {
  group: z.literal("default"),
  rank: defaultStockTokenRankSchema,
};
export const accountAssetCursorSchema = z.union([
  jsonObject({
    ...defaultCursorShape,
    ...currentOfficialSnapshotRevisionShape,
    ...cursorIdentityShape,
  }).strict(),
  jsonObject({
    ...defaultCursorShape,
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

type AccountAssetPosition =
  | Readonly<{ group: "default"; rank: number; address: AccountAssetCursor["address"] }>
  | Readonly<{ group: "other"; address: AccountAssetCursor["address"] }>;

export const accountAssetPositionForAddress = (
  address: AccountAssetCursor["address"],
): AccountAssetPosition => {
  const rank = defaultStockTokenRank(address);
  return rank === undefined
    ? Object.freeze({ group: "other", address })
    : Object.freeze({ group: "default", rank, address });
};

export const compareAccountAssetPositions = (
  left: AccountAssetPosition,
  right: AccountAssetPosition,
): number => {
  if (left.group !== right.group) return left.group === "default" ? -1 : 1;
  if (left.group === "default" && right.group === "default" && left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  return compareCodePointSequences(left.address, right.address);
};

const accountAssetClassificationUnavailableCauseSchema = z.discriminatedUnion("kind", [
  jsonObject({
    kind: z.literal("official_snapshot_unavailable"),
    storedRevision: officialAssetSnapshotRevisionSchema.nullable(),
    reason: officialAssetSourceClassificationUnavailableReasonSchema,
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

const officialSnapshotForClassification = (
  classification: AccountAssetClassification,
): OfficialAssetSnapshotEvidence | null => {
  if (
    classification.kind === "robinhood_stock_token" ||
    classification.kind === "custom_erc20"
  ) return classification.snapshot;
  return classification.cause.kind === "stock_factory_verification_unavailable"
    ? classification.cause.snapshot
    : null;
};

const sameOfficialSnapshotEvidence = (
  left: OfficialAssetSnapshotEvidence,
  right: OfficialAssetSnapshotEvidence,
): boolean => canonicalJsonStringify(captureCanonicalJson(left)) ===
  canonicalJsonStringify(captureCanonicalJson(right));

export const accountAssetAmountSchema = jsonObject({
  raw: uint256DecimalSchema,
  decimals: unsignedDecimalSchema.nullable(),
  formattedRaw: generalSingleLineTextSchema.nullable(),
  uiAdjusted: scaledUiAmountSchema.nullable(),
  formattedUiAdjusted: generalSingleLineTextSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.uiAdjusted !== null && value.uiAdjusted.raw !== value.raw) {
    context.addIssue({ code: "custom", message: "Account asset adjustment uses a different raw balance." });
  }
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
  rawBalance: uint256DecimalSchema,
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
  account: addressTargetSchema,
  limit: z.number().int().min(1).max(accountAssetLimits.maximumPageSize).optional(),
  cursor: accountAssetCursorSchema.optional(),
}).strict().transform((value) => ({
  account: value.account,
  limit: value.limit ?? accountAssetLimits.defaultPageSize,
  cursor: value.cursor ?? null,
}));
const collectionRequestSchema = jsonObject({
  account: addressTargetSchema,
  limit: z.number().int().min(1).max(accountAssetLimits.maximumPageSize),
  cursor: accountAssetCursorSchema.nullable(),
}).strict();

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
): boolean => left.account.chainId === right.account.chainId &&
  left.account.address === right.account.address &&
  left.officialSnapshotStatus === right.officialSnapshotStatus &&
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
  const snapshots = value.assets
    .map((entry) => officialSnapshotForClassification(entry.classification))
    .filter((snapshot): snapshot is OfficialAssetSnapshotEvidence => snapshot !== null);
  const firstSnapshot = snapshots[0];
  const positions = value.assets.map((entry) => accountAssetPositionForAddress(entry.selection.asset.address));
  if (
    positions.some((position, index) => index > 0 &&
      compareAccountAssetPositions(positions[index - 1]!, position) >= 0) ||
    value.block.chainId !== value.account.chainId ||
    value.viewRevision.account.chainId !== value.account.chainId ||
    value.viewRevision.account.address !== value.account.address ||
    value.native.asset.chainId !== value.account.chainId ||
    value.assets.some((entry) =>
      entry.selection.account.chainId !== value.account.chainId ||
      entry.selection.account.address !== value.account.address ||
      !sameBlock(entry.requiredStandards.block, value.block) ||
      !classificationMatchesView(entry.classification, value.viewRevision, value.block)) ||
    (firstSnapshot !== undefined && snapshots.some(
      (snapshot) => !sameOfficialSnapshotEvidence(snapshot, firstSnapshot),
    )) ||
    (value.nextCursor !== null && (
      !sameViewRevision(value.nextCursor, value.viewRevision) ||
      value.nextCursor.address !== value.assets.at(-1)?.selection.asset.address ||
      compareAccountAssetPositions(
        value.nextCursor,
        accountAssetPositionForAddress(value.nextCursor.address),
      ) !== 0
    ))
  ) context.addIssue({ code: "custom", message: "Account asset collection identities differ." });
});

export type AccountAssetCollectionInput = z.input<typeof collectionInputSchema>;
export type AccountAssetCollectionRequest = z.output<typeof collectionInputSchema>;
export type AccountAssetCollectionSuccess = z.output<typeof collectionSuccessSchema>;

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
]);

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
  capabilityId: "account.assets";
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
      if (
        (input.account.kind === "address" &&
          input.account.address !== success.account.address) ||
        success.assets.length > input.limit ||
        (success.nextCursor !== null && success.assets.length !== input.limit) ||
        (input.cursor !== null && (
          !sameViewRevision(input.cursor, success.viewRevision) ||
          compareAccountAssetPositions(
            input.cursor,
            accountAssetPositionForAddress(input.cursor.address),
          ) !== 0 ||
          success.assets.some((entry) => compareAccountAssetPositions(
            accountAssetPositionForAddress(entry.selection.asset.address),
            input.cursor!,
          ) <= 0)
        ))
      ) {
        throw new TypeError("Account asset collection does not match its request.");
      }
    },
  }),
});

export type AnyAccountAssetApplicationContract =
  (typeof accountAssetApplicationContracts)[keyof typeof accountAssetApplicationContracts];

export const accountAssetCapabilityIds = Object.freeze(
  Object.values(accountAssetApplicationContracts).map((contract) => contract.capabilityId).sort(),
);
