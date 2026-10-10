import {z} from "zod";

import {canonicalBase64UrlSchema} from "../core/client.js";
import {walletNamespacesSchema} from "./account-admission.js";
import {walletSdkNamespaceArrayLimit, walletSdkNamespaceLimit} from "./session-limits.js";
import {jsonObject} from "../core/client.js";
import {createEvmPrimitiveSchemaSet} from "../evm/primitives.js";

const primitives = createEvmPrimitiveSchemaSet();
export const walletConnectionSourceIdByteLength = 32;
export const walletConnectionIdSchema = z.string().startsWith("wallet-session:").refine((value) =>
  canonicalBase64UrlSchema(walletConnectionSourceIdByteLength).safeParse(value.slice("wallet-session:".length)).success,
  "Expected a secret-free Wallet session source identifier.");
export const walletConnectionLimits = Object.freeze({
  namespaces: walletSdkNamespaceLimit,
  accounts: walletSdkNamespaceArrayLimit,
  approvedMethods: walletSdkNamespaceArrayLimit,
  approvedEvents: walletSdkNamespaceArrayLimit,
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
    connectionId: walletConnectionIdSchema,
    namespaces: walletNamespacesSchema,
    expiresAt: primitives.utcTimestamp,
  }).strict(),
]);

export type WalletConnectionData = z.infer<typeof walletConnectionShapeSchema>;

export const assertCanonicalWalletConnection = (connection: WalletConnectionData): void => {
  if (connection.status === "connected") walletNamespacesSchema.parse(connection.namespaces);
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
