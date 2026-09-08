import { z } from "zod";

import { evmAddressSchema, evmChainIdSchema } from "./identities.js";
import { jsonObject } from "./json-object.js";
import {
  isStrictlyOrderedUnique,
  createPrimitiveSchemaSet,
} from "./primitives.js";

const primitives = createPrimitiveSchemaSet();
export const walletConnectionLimits = Object.freeze({
  approvedMethods: 64,
  approvedEvents: 64,
} as const);
export const walletConnectionStatusDefinitions = Object.freeze({
  unknown: Object.freeze({ reasons: Object.freeze(["reconciling", "observation_unavailable"] as const) }),
  disconnected: Object.freeze({
    reasons: Object.freeze(["no_session", "expired", "disconnected"] as const),
  }),
  unresolved: Object.freeze({ reasons: Object.freeze([] as const) }),
  connected: Object.freeze({ reasons: Object.freeze([] as const) }),
});
const sessionCountSchema = primitives.unsignedDecimal
  .regex(/^[1-9][0-9]*$/, "Unresolved wallet state requires at least one session.");

const walletConnectionShapeSchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("unknown"),
    reason: z.enum(walletConnectionStatusDefinitions.unknown.reasons),
  }).strict(),
  jsonObject({
    status: z.literal("disconnected"),
    reason: z.enum(walletConnectionStatusDefinitions.disconnected.reasons),
  }).strict(),
  jsonObject({ status: z.literal("unresolved"), sessionCount: sessionCountSchema }).strict(),
  jsonObject({
    status: z.literal("connected"),
    address: evmAddressSchema,
    chainId: evmChainIdSchema,
    approvedMethods: z.array(primitives.fixedIdentifier).max(walletConnectionLimits.approvedMethods),
    approvedEvents: z.array(primitives.fixedIdentifier).max(walletConnectionLimits.approvedEvents),
    expiresAt: primitives.utcTimestamp,
  }).strict(),
]);

export type WalletConnectionData = z.infer<typeof walletConnectionShapeSchema>;

const assertOrderedUnique = (values: readonly string[], label: string): void => {
  if (!isStrictlyOrderedUnique(values)) {
    throw new TypeError(`${label} must be unique and canonically ordered.`);
  }
};

export const assertCanonicalWalletConnection = (connection: WalletConnectionData): void => {
  if (connection.status !== "connected") return;
  assertOrderedUnique(connection.approvedMethods, "Approved wallet methods");
  assertOrderedUnique(connection.approvedEvents, "Approved wallet events");
};

export const walletConnectionDataSchema = walletConnectionShapeSchema.superRefine((connection, context) => {
  try { assertCanonicalWalletConnection(connection); }
  catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Wallet connection data is invalid.",
    });
  }
});
