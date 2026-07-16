import { z } from "zod";

import {
  robinhoodChainIdentity,
  robinhoodWalletNamespaceRequirements,
} from "./identities.js";
import { jsonObject } from "./json-object.js";
import {
  compareCodePointSequences,
  createPrimitiveSchemaSet,
} from "./primitives.js";

const primitives = createPrimitiveSchemaSet();
const eligibleSessionCountSchema = primitives.unsignedDecimal
  .regex(/^(?:[2-9]|[1-9][0-9]+)$/, "Unresolved wallet state requires at least two eligible sessions.");

const walletConnectionShapeSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("unknown"), reason: z.enum(["reconciling", "owner_unavailable"]) }).strict(),
  jsonObject({
    status: z.literal("disconnected"),
    reason: z.enum(["no_session", "expired", "deleted", "disconnected", "unusable_store"]),
  }).strict(),
  jsonObject({ status: z.literal("unresolved"), eligibleSessionCount: eligibleSessionCountSchema }).strict(),
  jsonObject({
    status: z.literal("connected"),
    account: z.string(),
    address: primitives.evmAddress,
    chainId: z.literal(robinhoodChainIdentity.caip2),
    approvedMethods: z.array(primitives.fixedIdentifier).max(64),
    approvedEvents: z.array(primitives.fixedIdentifier).max(64),
    expiresAt: primitives.utcTimestamp,
  }).strict(),
]);

export type WalletConnectionData = z.infer<typeof walletConnectionShapeSchema>;

const assertOrderedUnique = (values: readonly string[], label: string): void => {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodePointSequences(values[index - 1] ?? "", values[index] ?? "") >= 0) {
      throw new TypeError(`${label} must be unique and canonically ordered.`);
    }
  }
};

export const assertCanonicalWalletConnection = (connection: WalletConnectionData): void => {
  if (connection.status !== "connected") return;
  if (connection.account !== `${robinhoodChainIdentity.caip2}:${connection.address}`) {
    throw new TypeError("The CAIP-10 account does not match the address.");
  }
  assertOrderedUnique(connection.approvedMethods, "Approved wallet methods");
  assertOrderedUnique(connection.approvedEvents, "Approved wallet events");
  if (
    !robinhoodWalletNamespaceRequirements.methods.every((method) =>
      connection.approvedMethods.some((approved) => approved === method)) ||
    !robinhoodWalletNamespaceRequirements.events.every((event) =>
      connection.approvedEvents.some((approved) => approved === event))
  ) throw new TypeError("Required wallet namespace approval is incomplete.");
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
