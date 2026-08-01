import type { ZodType } from "zod";

import {
  assertDirectApplicationErrorRegistryExtension,
  capabilityIdSchema,
  defineApplicationContract,
  jsonObject,
  referenceHistoryInputSchema,
  referenceHistorySuccessSchema,
  referenceMarketReadFailureCodes,
  referencePriceInputSchema,
  referencePriceSuccessSchema,
  referenceWatchlistInputSchema,
  referenceWatchlistMutationCommonFailureCodes,
  referenceWatchlistMutationInputSchema,
  referenceWatchlistReorderInputSchema,
  referenceWatchlistSuccessSchema,
  type ApplicationContract,
  type ReferenceHistoryInput,
  type ReferenceHistorySuccess,
  type ReferencePriceInput,
  type ReferencePriceSuccess,
  type ReferenceWatchlistMutationInput,
  type ReferenceWatchlistReorderInput,
  type ReferenceWatchlistSuccess,
} from "../core/browser.js";
import { tokenCatalogErrorRegistry } from "../token-catalog/error-registry.js";
import { referenceMarketErrorDefinitions } from "./error-definitions.js";

export const referenceMarketErrorRegistry =
  tokenCatalogErrorRegistry.extend(referenceMarketErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(
  tokenCatalogErrorRegistry,
  referenceMarketErrorRegistry,
);

export const referenceMarketCapabilities = Object.freeze({
  add: "market.add_watchlist_pair",
  history: "market.reference_history",
  price: "market.reference_price",
  remove: "market.remove_watchlist_pair",
  reorder: "market.reorder_watchlist_pairs",
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

export interface ReferenceMarketApplicationContract<
  Input,
  Success,
  CapabilityId extends ReferenceMarketCapabilityId = ReferenceMarketCapabilityId,
> {
  readonly capabilityId: CapabilityId;
  readonly contractVersion: "1";
  readonly applicationContract: ApplicationContract<Input, Record<string, never>, Success>;
  readonly inputSchema: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly failureCodes: readonly string[];
  parseInput(value: unknown): Input;
  parsePublicSuccess(input: unknown, value: unknown): Success;
  parseFailure(value: unknown): ReturnType<ApplicationContract<Input, Record<string, never>, Success>["parseFailure"]>;
  normalizeFailure(value: unknown): ReturnType<ApplicationContract<Input, Record<string, never>, Success>["normalizeFailure"]>;
}

const defineReferenceMarketContract = <Input, Success, CapabilityId extends ReferenceMarketCapabilityId>(options: Readonly<{
  capabilityId: CapabilityId;
  contractVersion: "1";
  inputSchema: ZodType<Input>;
  successSchema: ZodType<Success>;
  failureCodes: readonly string[];
  validatePublicSuccess?: (input: Input, success: Success) => void;
}>): ReferenceMarketApplicationContract<Input, Success, CapabilityId> => {
  capabilityIdSchema.parse(options.capabilityId);
  const applicationContract = defineApplicationContract({
    contractVersion: options.contractVersion,
    inputSchema: options.inputSchema,
    successSchema: options.successSchema,
    internalContextSchema: jsonObject({}).strict(),
    errorRegistry: referenceMarketErrorRegistry,
    failureCodes: options.failureCodes,
    ...(options.validatePublicSuccess === undefined
      ? {}
      : { validatePublicSuccess: options.validatePublicSuccess }),
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
    parseFailure: applicationContract.parseFailure,
    normalizeFailure: applicationContract.normalizeFailure,
  });
};

const watchlistContains = (watchlist: ReferenceWatchlistSuccess, pairId: string): boolean =>
  watchlist.entries.some((entry) => entry.pairId === pairId);

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
    failureCodes: referenceMarketReadFailureCodes,
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
    failureCodes: referenceMarketReadFailureCodes,
    validatePublicSuccess: (input, success) => {
      if (input.pairId !== success.pair.pairId || input.window !== success.window) {
        throw new TypeError("Reference history result does not match its request.");
      }
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
    failureCodes: referenceWatchlistMutationCommonFailureCodes,
  }),
  add: defineReferenceMarketContract<
    ReferenceWatchlistMutationInput,
    ReferenceWatchlistSuccess,
    typeof referenceMarketCapabilities.add
  >({
    capabilityId: referenceMarketCapabilities.add,
    contractVersion: "1",
    inputSchema: referenceWatchlistMutationInputSchema,
    successSchema: referenceWatchlistSuccessSchema,
    failureCodes: [
      ...referenceWatchlistMutationCommonFailureCodes,
      "watchlist_full",
      "watchlist_pair_already_saved",
    ],
    validatePublicSuccess: (input, success) => {
      if (!watchlistContains(success, input.pairId) || success.revision === input.expectedRevision) {
        throw new TypeError("Added watchlist result does not match its request.");
      }
    },
  }),
  remove: defineReferenceMarketContract<
    ReferenceWatchlistMutationInput,
    ReferenceWatchlistSuccess,
    typeof referenceMarketCapabilities.remove
  >({
    capabilityId: referenceMarketCapabilities.remove,
    contractVersion: "1",
    inputSchema: referenceWatchlistMutationInputSchema,
    successSchema: referenceWatchlistSuccessSchema,
    failureCodes: [
      ...referenceWatchlistMutationCommonFailureCodes,
      "watchlist_pair_not_found",
    ],
    validatePublicSuccess: (input, success) => {
      if (watchlistContains(success, input.pairId) || success.revision === input.expectedRevision) {
        throw new TypeError("Removed watchlist result does not match its request.");
      }
    },
  }),
  reorder: defineReferenceMarketContract<
    ReferenceWatchlistReorderInput,
    ReferenceWatchlistSuccess,
    typeof referenceMarketCapabilities.reorder
  >({
    capabilityId: referenceMarketCapabilities.reorder,
    contractVersion: "1",
    inputSchema: referenceWatchlistReorderInputSchema,
    successSchema: referenceWatchlistSuccessSchema,
    failureCodes: [
      ...referenceWatchlistMutationCommonFailureCodes,
      "watchlist_order_conflict",
    ],
    validatePublicSuccess: (input, success) => {
      if (success.entries.map((entry) => entry.pairId).join("\0") !== input.pairIds.join("\0")) {
        throw new TypeError("Reordered watchlist result does not match its request.");
      }
    },
  }),
});

export type AnyReferenceMarketApplicationContract =
  (typeof referenceMarketApplicationContracts)[keyof typeof referenceMarketApplicationContracts];
