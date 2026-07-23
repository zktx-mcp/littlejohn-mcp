import { z } from "zod";

import {
  canonicalSha256,
  captureCanonicalJson,
  deepFreezeValue,
  referenceWatchlistMutationInputSchema,
  referenceWatchlistReorderInputSchema,
  referenceWatchlistRevisionSchema,
} from "../core/browser.js";
import { referenceMarketCapabilities } from "../market-portfolio/contracts.js";

export const referenceMarketDeliveryActions = Object.freeze(["add", "remove", "reorder"] as const);
export type ReferenceMarketDeliveryAction = typeof referenceMarketDeliveryActions[number];

const requestDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const referenceMarketDeliveryUnknownSchema = z.object({
  status: z.literal("delivery_unknown"),
  action: z.enum(referenceMarketDeliveryActions),
  requestDigest: requestDigestSchema,
  expectedRevision: referenceWatchlistRevisionSchema,
  resendAllowed: z.literal(false),
  verificationCapability: z.literal(referenceMarketCapabilities.watchlist),
}).strict();
export type ReferenceMarketDeliveryUnknown = z.infer<typeof referenceMarketDeliveryUnknownSchema>;

type ReferenceMarketDeliveryInput = Readonly<{
  action: ReferenceMarketDeliveryAction;
  request: unknown;
}>;

export const createReferenceMarketDeliveryUnknown = (
  input: ReferenceMarketDeliveryInput,
): ReferenceMarketDeliveryUnknown => {
  const request = input.action === "reorder"
    ? referenceWatchlistReorderInputSchema.parse(input.request)
    : referenceWatchlistMutationInputSchema.parse(input.request);
  return deepFreezeValue(referenceMarketDeliveryUnknownSchema.parse({
    status: "delivery_unknown",
    action: input.action,
    requestDigest: canonicalSha256(captureCanonicalJson({
      domain: "littlejohn.reference-market-watchlist.delivery.v1",
      capabilityId: referenceMarketCapabilities[input.action],
      request: captureCanonicalJson(request),
    })),
    expectedRevision: request.expectedRevision,
    resendAllowed: false,
    verificationCapability: referenceMarketCapabilities.watchlist,
  }));
};

export const parseReferenceMarketDeliveryUnknown = (
  value: unknown,
): ReferenceMarketDeliveryUnknown => deepFreezeValue(referenceMarketDeliveryUnknownSchema.parse(value));
