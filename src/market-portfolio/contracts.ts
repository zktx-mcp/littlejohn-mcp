import { z, type ZodType } from "zod";

import {
  assertDirectApplicationErrorRegistryExtension,
  capabilityIdSchema,
  canonicalJsonStringify,
  canonicalSha256,
  captureCanonicalJson,
  deepFreezeValue,
  defineApplicationContract,
  findReferencePair,
  hash32Schema,
  jsonObject,
  operationIdSchema,
  parseHash32,
  referenceHistoryInputSchema,
  referenceHistorySuccessSchema,
  referenceMarketLimits,
  referenceMarketManifestVersion,
  referenceMarketReadFailureCodes,
  referencePairManifestEntrySchema,
  referencePriceInputSchema,
  referencePriceSuccessSchema,
  referenceWatchlistInputSchema,
  referenceWatchlistMutationCommonFailureCodes,
  referenceWatchlistMutationInputSchema,
  referenceWatchlistReorderInputSchema,
  referenceWatchlistRevisionSchema,
  referenceWatchlistSuccessSchema,
  unsignedDecimalSchema,
  utcTimestampSchema,
  utf8ByteLength,
  type ApplicationContract,
  type CanonicalJson,
  type ReferenceHistoryInput,
  type ReferenceHistorySuccess,
  type ReferencePairId,
  type ReferencePairManifestEntry,
  type ReferencePriceInput,
  type ReferencePriceSuccess,
  type ReferenceWatchlistMutationInput,
  type ReferenceWatchlistReorderInput,
  type ReferenceWatchlistSuccess,
} from "../core/client.js";
import { tokenCatalogErrorRegistry } from "../token-catalog/error-registry.js";
import { referenceMarketErrorDefinitions } from "./error-definitions.js";
import {
  parseStockTokenMarketResult,
  stockTokenMarketInputSchema,
  stockTokenMarketResultSchema,
  type StockTokenMarketInput,
  type StockTokenMarketResult,
} from "./stock-token-market.js";

export const referenceMarketErrorRegistry =
  tokenCatalogErrorRegistry.extend(referenceMarketErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(
  tokenCatalogErrorRegistry,
  referenceMarketErrorRegistry,
);

export const referenceMarketCapabilities = Object.freeze({
  add: "market.add_watchlist_pair",
  history: "market.reference_history",
  operation: "market.watchlist_operation",
  price: "market.reference_price",
  remove: "market.remove_watchlist_pair",
  reorder: "market.reorder_watchlist_pairs",
  review: "market.watchlist_change_review",
  stockTokenMarket: "market.stock_token_market",
  watchlist: "market.watchlist",
} as const);
export type ReferenceMarketCapabilityId =
  (typeof referenceMarketCapabilities)[keyof typeof referenceMarketCapabilities];
export const referenceMarketCapabilityIds: readonly ReferenceMarketCapabilityId[] = Object.freeze(
  Object.values(referenceMarketCapabilities).sort(),
);
export type ReferenceMarketMutationCapabilityId =
  | typeof referenceMarketCapabilities.add
  | typeof referenceMarketCapabilities.remove
  | typeof referenceMarketCapabilities.reorder;

export const referenceWatchlistOperationKinds = Object.freeze([
  "add",
  "remove",
  "reorder",
] as const);
export type ReferenceWatchlistOperationKind =
  typeof referenceWatchlistOperationKinds[number];
export const referenceWatchlistInitiators = Object.freeze(["cli", "mcp_app"] as const);
export type ReferenceWatchlistInitiator = typeof referenceWatchlistInitiators[number];

export const referenceWatchlistOperationLimits = Object.freeze({
  directActionUtf8Bytes: 16_384,
  reviewActionMilliseconds: 300_000,
});

export interface ReferenceMarketApplicationContract<
  Input,
  Success,
  CapabilityId extends ReferenceMarketCapabilityId = ReferenceMarketCapabilityId,
  Context = Record<string, never>,
> {
  readonly capabilityId: CapabilityId;
  readonly contractVersion: "1";
  readonly applicationContract: ApplicationContract<Input, Context, Success>;
  readonly inputSchema: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly failureCodes: readonly string[];
  parseInput(value: unknown): Input;
  parsePublicSuccess(input: unknown, value: unknown): Success;
  parseBoundSuccess(input: unknown, context: unknown, value: unknown): Success;
  parseFailure(value: unknown): ReturnType<ApplicationContract<Input, Context, Success>["parseFailure"]>;
  normalizeFailure(value: unknown): ReturnType<ApplicationContract<Input, Context, Success>["normalizeFailure"]>;
}

const defineReferenceMarketContract = <
  Input,
  Success,
  CapabilityId extends ReferenceMarketCapabilityId,
  Context = Record<string, never>,
>(options: Readonly<{
  capabilityId: CapabilityId;
  contractVersion: "1";
  inputSchema: ZodType<Input>;
  successSchema: ZodType<Success>;
  failureCodes: readonly string[];
  internalContextSchema?: ZodType<Context>;
  validatePublicSuccess?: (input: Input, success: Success) => void;
  validateBoundSuccess?: (input: Input, context: Context, success: Success) => void;
}>): ReferenceMarketApplicationContract<Input, Success, CapabilityId, Context> => {
  capabilityIdSchema.parse(options.capabilityId);
  const applicationContract = defineApplicationContract({
    contractVersion: options.contractVersion,
    inputSchema: options.inputSchema,
    successSchema: options.successSchema,
    internalContextSchema: options.internalContextSchema ?? jsonObject({}).strict() as ZodType<Context>,
    errorRegistry: referenceMarketErrorRegistry,
    failureCodes: options.failureCodes,
    ...(options.validatePublicSuccess === undefined
      ? {}
      : { validatePublicSuccess: options.validatePublicSuccess }),
    ...(options.validateBoundSuccess === undefined
      ? {}
      : { validateBoundSuccess: options.validateBoundSuccess }),
  });
  return Object.freeze({
    capabilityId: options.capabilityId,
    contractVersion: applicationContract.contractVersion,
    applicationContract,
    inputSchema: options.inputSchema,
    successSchema: options.successSchema,
    failureCodes: applicationContract.failureCodes,
    parseInput: applicationContract.parseInput,
    parsePublicSuccess: applicationContract.parsePublicSuccess,
    parseBoundSuccess: applicationContract.parseBoundSuccess,
    parseFailure: applicationContract.parseFailure,
    normalizeFailure: applicationContract.normalizeFailure,
  });
};

const sameAccount = (
  left: ReferenceWatchlistSuccess["account"],
  right: ReferenceWatchlistSuccess["account"],
): boolean => left.chainId === right.chainId && left.address === right.address;

const sameEntries = (
  left: readonly ReferencePairManifestEntry[],
  right: readonly ReferencePairManifestEntry[],
): boolean => left.length === right.length &&
  left.every((entry, index) => entry.pairId === right[index]?.pairId);

const watchlistContains = (watchlist: ReferenceWatchlistSuccess, pairId: string): boolean =>
  watchlist.entries.some((entry) => entry.pairId === pairId);

const reviewPreconditionSchema = z.object({
  account: referenceWatchlistSuccessSchema.shape.account,
  connectionRevision: unsignedDecimalSchema,
  watchlistRevision: referenceWatchlistRevisionSchema,
  currentEntries: z.array(referencePairManifestEntrySchema).max(referenceMarketLimits.watchlistEntries),
}).strict().superRefine((value, context) => {
  if (new Set(value.currentEntries.map((entry) => entry.pairId)).size !== value.currentEntries.length) {
    context.addIssue({ code: "custom", message: "Reference watchlist Review entries are duplicated." });
  }
});

const reviewCommonShape = {
  contractVersion: z.literal("1"),
  domain: z.literal("reference_watchlist"),
  operationId: operationIdSchema,
  createdAt: utcTimestampSchema,
  actionExpiresAt: utcTimestampSchema,
  precondition: reviewPreconditionSchema,
  fixedEvidence: z.object({
    manifestVersion: z.literal(referenceMarketManifestVersion),
  }).strict(),
} as const;

const addReviewWithoutDigestSchema = z.object({
  ...reviewCommonShape,
  kind: z.literal("add"),
  target: z.object({ pair: referencePairManifestEntrySchema }).strict(),
  decision: z.object({ action: z.literal("add_watchlist_pair") }).strict(),
}).strict();
const removeReviewWithoutDigestSchema = z.object({
  ...reviewCommonShape,
  kind: z.literal("remove"),
  target: z.object({ pair: referencePairManifestEntrySchema }).strict(),
  decision: z.object({ action: z.literal("remove_watchlist_pair") }).strict(),
}).strict();
const reorderReviewWithoutDigestSchema = z.object({
  ...reviewCommonShape,
  kind: z.literal("reorder"),
  target: z.object({
    entries: z.array(referencePairManifestEntrySchema).max(referenceMarketLimits.watchlistEntries),
  }).strict().superRefine((value, context) => {
    if (new Set(value.entries.map((entry) => entry.pairId)).size !== value.entries.length) {
      context.addIssue({ code: "custom", message: "Reference watchlist target entries are duplicated." });
    }
  }),
  decision: z.object({ action: z.literal("reorder_watchlist_pairs") }).strict(),
}).strict();

const referenceWatchlistReviewWithoutDigestSchema = z.discriminatedUnion("kind", [
  addReviewWithoutDigestSchema,
  removeReviewWithoutDigestSchema,
  reorderReviewWithoutDigestSchema,
]);
export type ReferenceWatchlistReviewWithoutDigest = z.infer<
  typeof referenceWatchlistReviewWithoutDigestSchema
>;

export const referenceWatchlistReviewDigest = (inputValue: unknown) => {
  const review = referenceWatchlistReviewWithoutDigestSchema.parse(
    captureCanonicalJson(inputValue),
  );
  return parseHash32(`0x${canonicalSha256({
    digestKind: "reference_watchlist_change_review",
    digestVersion: "1",
    review: review as unknown as CanonicalJson,
  })}`);
};

export type ReferenceWatchlistProjectionFailure =
  | "watchlist_full"
  | "watchlist_order_conflict"
  | "watchlist_pair_already_saved"
  | "watchlist_pair_not_found";

export type ReferenceWatchlistReviewProjection = Readonly<{
  target:
    | Readonly<{ pair: ReferencePairManifestEntry }>
    | Readonly<{ entries: readonly ReferencePairManifestEntry[] }>;
  decision: Readonly<{
    action: "add_watchlist_pair" | "remove_watchlist_pair" | "reorder_watchlist_pairs";
  }>;
  fixedEvidence: Readonly<{ manifestVersion: typeof referenceMarketManifestVersion }>;
  nextEntries: readonly ReferencePairManifestEntry[];
}>;

export const createReferenceWatchlistReviewProjection = (input: Readonly<{
  kind: ReferenceWatchlistOperationKind;
  currentEntries: readonly ReferencePairManifestEntry[];
  pairId?: ReferencePairId;
  pairIds?: readonly ReferencePairId[];
}>):
  | Readonly<{ status: "success"; projection: ReferenceWatchlistReviewProjection }>
  | Readonly<{ status: "rejected"; reason: ReferenceWatchlistProjectionFailure }> => {
  const currentEntries = z.array(referencePairManifestEntrySchema)
    .max(referenceMarketLimits.watchlistEntries)
    .parse(captureCanonicalJson(input.currentEntries));
  const currentIds = currentEntries.map((entry) => entry.pairId);
  if (input.kind === "add") {
    const pair = findReferencePair(input.pairId as ReferencePairId);
    if (currentIds.length >= referenceMarketLimits.watchlistEntries) {
      return Object.freeze({ status: "rejected", reason: "watchlist_full" });
    }
    if (currentIds.includes(pair.pairId)) {
      return Object.freeze({ status: "rejected", reason: "watchlist_pair_already_saved" });
    }
    return deepFreezeValue({
      status: "success",
      projection: {
        target: { pair },
        decision: { action: "add_watchlist_pair" },
        fixedEvidence: { manifestVersion: referenceMarketManifestVersion },
        nextEntries: [...currentEntries, pair],
      },
    });
  }
  if (input.kind === "remove") {
    const pair = findReferencePair(input.pairId as ReferencePairId);
    if (!currentIds.includes(pair.pairId)) {
      return Object.freeze({ status: "rejected", reason: "watchlist_pair_not_found" });
    }
    return deepFreezeValue({
      status: "success",
      projection: {
        target: { pair },
        decision: { action: "remove_watchlist_pair" },
        fixedEvidence: { manifestVersion: referenceMarketManifestVersion },
        nextEntries: currentEntries.filter((entry) => entry.pairId !== pair.pairId),
      },
    });
  }
  const pairIds = input.pairIds ?? [];
  if (
    new Set(pairIds).size !== pairIds.length ||
    pairIds.length !== currentIds.length ||
    pairIds.some((pairId) => !currentIds.includes(pairId))
  ) return Object.freeze({ status: "rejected", reason: "watchlist_order_conflict" });
  const entries = pairIds.map(findReferencePair);
  return deepFreezeValue({
    status: "success",
    projection: {
      target: { entries },
      decision: { action: "reorder_watchlist_pairs" },
      fixedEvidence: { manifestVersion: referenceMarketManifestVersion },
      nextEntries: entries,
    },
  });
};

const validateReferenceWatchlistReview = (
  review: ReferenceWatchlistReviewWithoutDigest & { readonly reviewDigest: string },
  context: z.core.$RefinementCtx,
): void => {
  const expectedDigest = referenceWatchlistReviewDigest(
    (({ reviewDigest: _digest, ...withoutDigest }) => withoutDigest)(review),
  );
  const request = review.kind === "reorder"
    ? { kind: review.kind, currentEntries: review.precondition.currentEntries,
        pairIds: review.target.entries.map((entry) => entry.pairId) }
    : { kind: review.kind, currentEntries: review.precondition.currentEntries,
        pairId: review.target.pair.pairId };
  const derived = createReferenceWatchlistReviewProjection(request);
  if (
    Date.parse(review.actionExpiresAt) - Date.parse(review.createdAt) !==
      referenceWatchlistOperationLimits.reviewActionMilliseconds ||
    expectedDigest !== review.reviewDigest ||
    derived.status !== "success" ||
    canonicalJsonStringify({
      target: review.target,
      decision: review.decision,
      fixedEvidence: review.fixedEvidence,
    } as unknown as CanonicalJson) !== canonicalJsonStringify({
      target: derived.status === "success" ? derived.projection.target : null,
      decision: derived.status === "success" ? derived.projection.decision : null,
      fixedEvidence: derived.status === "success" ? derived.projection.fixedEvidence : null,
    } as unknown as CanonicalJson)
  ) context.addIssue({ code: "custom", message: "Reference watchlist Review is inconsistent." });
};

const addReviewSchema = addReviewWithoutDigestSchema.extend({
  reviewDigest: hash32Schema,
}).strict().superRefine(validateReferenceWatchlistReview);
const removeReviewSchema = removeReviewWithoutDigestSchema.extend({
  reviewDigest: hash32Schema,
}).strict().superRefine(validateReferenceWatchlistReview);
const reorderReviewSchema = reorderReviewWithoutDigestSchema.extend({
  reviewDigest: hash32Schema,
}).strict().superRefine(validateReferenceWatchlistReview);
export const referenceWatchlistReviewSchema = z.discriminatedUnion("kind", [
  addReviewSchema,
  removeReviewSchema,
  reorderReviewSchema,
]);
export type ReferenceWatchlistReview = z.infer<typeof referenceWatchlistReviewSchema>;

export const parseReferenceWatchlistReview = (value: unknown): ReferenceWatchlistReview =>
  deepFreezeValue(referenceWatchlistReviewSchema.parse(captureCanonicalJson(value)));

export const referenceWatchlistReviewRequestSchema = z.discriminatedUnion("kind", [
  referenceWatchlistMutationInputSchema.extend({ kind: z.literal("add") }).strict(),
  referenceWatchlistMutationInputSchema.extend({ kind: z.literal("remove") }).strict(),
  referenceWatchlistReorderInputSchema.extend({ kind: z.literal("reorder") }).strict(),
]);
export type ReferenceWatchlistReviewRequest = z.infer<
  typeof referenceWatchlistReviewRequestSchema
>;
export const referenceWatchlistReviewResultSchema = z.object({
  review: referenceWatchlistReviewSchema,
}).strict();
export type ReferenceWatchlistReviewResult = z.infer<
  typeof referenceWatchlistReviewResultSchema
>;

export const referenceWatchlistDirectActionSchema = z.object({
  review: referenceWatchlistReviewSchema,
  initiatedBy: z.enum(referenceWatchlistInitiators),
}).strict().superRefine((action, context) => {
  if (utf8ByteLength(canonicalJsonStringify(action as unknown as CanonicalJson)) >
    referenceWatchlistOperationLimits.directActionUtf8Bytes) {
    context.addIssue({ code: "custom", message: "Reference watchlist action is too large." });
  }
});
export type ReferenceWatchlistDirectAction = z.infer<
  typeof referenceWatchlistDirectActionSchema
>;

const operationResultForKind = <Kind extends ReferenceWatchlistOperationKind>(kind: Kind) =>
  z.object({
    outcome: z.literal(kind === "add"
      ? "watchlist_pair_added"
      : kind === "remove"
        ? "watchlist_pair_removed"
        : "watchlist_pairs_reordered"),
    watchlist: referenceWatchlistSuccessSchema,
  }).strict();

const operationForKind = <Kind extends ReferenceWatchlistOperationKind>(kind: Kind) =>
  z.object({
    contractVersion: z.literal("1"),
    domain: z.literal("reference_watchlist"),
    operationId: operationIdSchema,
    kind: z.literal(kind),
    initiatedBy: z.enum(referenceWatchlistInitiators),
    review: kind === "add"
      ? addReviewSchema
      : kind === "remove"
        ? removeReviewSchema
        : reorderReviewSchema,
    state: z.literal("completed"),
    completedAt: utcTimestampSchema,
    result: operationResultForKind(kind),
  }).strict().superRefine((operation, context) => {
    const projection = operation.review.kind === "reorder"
      ? createReferenceWatchlistReviewProjection({
          kind: operation.review.kind,
          currentEntries: operation.review.precondition.currentEntries,
          pairIds: operation.review.target.entries.map((entry) => entry.pairId),
        })
      : createReferenceWatchlistReviewProjection({
          kind: operation.review.kind,
          currentEntries: operation.review.precondition.currentEntries,
          pairId: operation.review.target.pair.pairId,
        });
    const changed = projection.status === "success" && !sameEntries(
      operation.review.precondition.currentEntries,
      projection.projection.nextEntries,
    );
    if (
      operation.operationId !== operation.review.operationId ||
      operation.completedAt < operation.review.createdAt ||
      !sameAccount(operation.result.watchlist.account, operation.review.precondition.account) ||
      projection.status !== "success" ||
      !sameEntries(operation.result.watchlist.entries, projection.projection.nextEntries) ||
      (changed
        ? operation.result.watchlist.revision === operation.review.precondition.watchlistRevision
        : operation.result.watchlist.revision !== operation.review.precondition.watchlistRevision)
    ) context.addIssue({ code: "custom", message: "Reference watchlist operation is inconsistent." });
  });

const addOperationSchema = operationForKind("add");
const removeOperationSchema = operationForKind("remove");
const reorderOperationSchema = operationForKind("reorder");
export const referenceWatchlistOperationSchema = z.discriminatedUnion("kind", [
  addOperationSchema,
  removeOperationSchema,
  reorderOperationSchema,
]);
export type ReferenceWatchlistOperation = z.infer<typeof referenceWatchlistOperationSchema>;
export type ReferenceWatchlistOperationVariant<Kind extends ReferenceWatchlistOperationKind> =
  Extract<ReferenceWatchlistOperation, { readonly kind: Kind }>;
export const parseReferenceWatchlistOperation = (value: unknown): ReferenceWatchlistOperation =>
  deepFreezeValue(referenceWatchlistOperationSchema.parse(captureCanonicalJson(value)));

export const referenceWatchlistOperationInputSchema = z.object({
  operationId: operationIdSchema,
}).strict();
export type ReferenceWatchlistOperationInput = z.infer<
  typeof referenceWatchlistOperationInputSchema
>;

type ActionForKind<Kind extends ReferenceWatchlistOperationKind> =
  ReferenceWatchlistDirectAction & {
    readonly review: Extract<ReferenceWatchlistReview, { readonly kind: Kind }>;
  };
const actionSchemaForKind = <Kind extends ReferenceWatchlistOperationKind>(kind: Kind) =>
  referenceWatchlistDirectActionSchema.refine(
    (action): action is ActionForKind<Kind> => action.review.kind === kind,
    `Reference watchlist action must carry a ${kind} Review.`,
  ) as ZodType<ActionForKind<Kind>>;
const operationSchemaForKind = <Kind extends ReferenceWatchlistOperationKind>(kind: Kind) =>
  referenceWatchlistOperationSchema.refine(
    (operation): operation is ReferenceWatchlistOperationVariant<Kind> => operation.kind === kind,
    `Reference watchlist operation must be ${kind}.`,
  ) as ZodType<ReferenceWatchlistOperationVariant<Kind>>;

const validateActionOperation = <Kind extends ReferenceWatchlistOperationKind>(
  input: ActionForKind<Kind>,
  success: ReferenceWatchlistOperationVariant<Kind>,
): void => {
  if (
    success.operationId !== input.review.operationId ||
    success.review.reviewDigest !== input.review.reviewDigest ||
    canonicalJsonStringify(success.review as unknown as CanonicalJson) !==
      canonicalJsonStringify(input.review as unknown as CanonicalJson)
  ) throw new TypeError("Reference watchlist operation does not match its action.");
};

const readFailures = referenceMarketReadFailureCodes;
export const stockTokenMarketFailureCodes = Object.freeze([
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
] as const);
const watchlistReadFailures = referenceWatchlistMutationCommonFailureCodes;
const reviewFailures = Object.freeze([
  ...referenceWatchlistMutationCommonFailureCodes,
  "watchlist_full",
  "watchlist_order_conflict",
  "watchlist_pair_already_saved",
  "watchlist_pair_not_found",
]);
const actionFailures = Object.freeze([
  ...reviewFailures,
  "watchlist_review_expired",
]);
const operationFailures = Object.freeze([
  ...referenceWatchlistMutationCommonFailureCodes,
  "watchlist_operation_not_found",
]);

export const referenceMarketApplicationContracts = Object.freeze({
  price: defineReferenceMarketContract<
    ReferencePriceInput,
    ReferencePriceSuccess,
    typeof referenceMarketCapabilities.price
  >({
    capabilityId: referenceMarketCapabilities.price,
    contractVersion: "1",
    inputSchema: referencePriceInputSchema,
    successSchema: referencePriceSuccessSchema,
    failureCodes: readFailures,
    validatePublicSuccess: (input, success) => {
      if (input.pairId !== success.pair.pairId) {
        throw new TypeError("Reference price result does not match its request.");
      }
    },
  }),
  history: defineReferenceMarketContract<
    ReferenceHistoryInput,
    ReferenceHistorySuccess,
    typeof referenceMarketCapabilities.history
  >({
    capabilityId: referenceMarketCapabilities.history,
    contractVersion: "1",
    inputSchema: referenceHistoryInputSchema,
    successSchema: referenceHistorySuccessSchema,
    failureCodes: readFailures,
    validatePublicSuccess: (input, success) => {
      if (input.pairId !== success.pair.pairId || input.window !== success.window) {
        throw new TypeError("Reference history result does not match its request.");
      }
    },
  }),
  stockTokenMarket: defineReferenceMarketContract<
    StockTokenMarketInput,
    StockTokenMarketResult,
    typeof referenceMarketCapabilities.stockTokenMarket
  >({
    capabilityId: referenceMarketCapabilities.stockTokenMarket,
    contractVersion: "1",
    inputSchema: stockTokenMarketInputSchema,
    successSchema: stockTokenMarketResultSchema,
    failureCodes: stockTokenMarketFailureCodes,
    validatePublicSuccess: (input, success) => {
      parseStockTokenMarketResult(input, success);
    },
  }),
  watchlist: defineReferenceMarketContract<
    Record<string, never>,
    ReferenceWatchlistSuccess,
    typeof referenceMarketCapabilities.watchlist
  >({
    capabilityId: referenceMarketCapabilities.watchlist,
    contractVersion: "1",
    inputSchema: referenceWatchlistInputSchema,
    successSchema: referenceWatchlistSuccessSchema,
    failureCodes: watchlistReadFailures,
  }),
  watchlistChangeReview: defineReferenceMarketContract<
  ReferenceWatchlistReviewRequest,
  ReferenceWatchlistReviewResult,
  typeof referenceMarketCapabilities.review
  >({
    capabilityId: referenceMarketCapabilities.review,
    contractVersion: "1",
    inputSchema: referenceWatchlistReviewRequestSchema,
    successSchema: referenceWatchlistReviewResultSchema,
    failureCodes: reviewFailures,
    validatePublicSuccess: (input, success) => {
      const pairIds = success.review.kind === "reorder"
        ? success.review.target.entries.map((entry) => entry.pairId)
        : [success.review.target.pair.pairId];
      const requestedIds = input.kind === "reorder" ? input.pairIds : [input.pairId];
      if (
        success.review.kind !== input.kind ||
        success.review.precondition.watchlistRevision !== input.expectedRevision ||
        pairIds.join("\0") !== requestedIds.join("\0")
      ) throw new TypeError("Reference watchlist Review does not match its request.");
    },
  }),
  add: defineReferenceMarketContract({
    capabilityId: referenceMarketCapabilities.add,
    contractVersion: "1",
    inputSchema: actionSchemaForKind("add"),
    successSchema: operationSchemaForKind("add"),
    failureCodes: actionFailures,
    validatePublicSuccess: validateActionOperation,
  }),
  remove: defineReferenceMarketContract({
    capabilityId: referenceMarketCapabilities.remove,
    contractVersion: "1",
    inputSchema: actionSchemaForKind("remove"),
    successSchema: operationSchemaForKind("remove"),
    failureCodes: actionFailures,
    validatePublicSuccess: validateActionOperation,
  }),
  reorder: defineReferenceMarketContract({
    capabilityId: referenceMarketCapabilities.reorder,
    contractVersion: "1",
    inputSchema: actionSchemaForKind("reorder"),
    successSchema: operationSchemaForKind("reorder"),
    failureCodes: actionFailures,
    validatePublicSuccess: validateActionOperation,
  }),
  operation: defineReferenceMarketContract({
    capabilityId: referenceMarketCapabilities.operation,
    contractVersion: "1",
    inputSchema: referenceWatchlistOperationInputSchema,
    successSchema: referenceWatchlistOperationSchema,
    failureCodes: operationFailures,
    validatePublicSuccess: (input, success) => {
      if (input.operationId !== success.operationId) {
        throw new TypeError("Reference watchlist operation identity mismatch.");
      }
    },
  }),
});

export type AnyReferenceMarketApplicationContract =
  (typeof referenceMarketApplicationContracts)[keyof typeof referenceMarketApplicationContracts];
