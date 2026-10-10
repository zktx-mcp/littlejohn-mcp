import { z } from "zod";
import { fixedIdentifierSchema, isStrictlyOrderedUnique } from "../core/client.js";
import { evmAccountIdentitySchema } from "../evm/identities.js";
import { walletConnectionIdSchema } from "./connection-contract.js";
import { walletLocalRevisionSchema } from "./local-revision.js";
import { walletSdkNamespaceArrayLimit } from "./session-limits.js";

export const walletBoundAccountReferenceSchema = z.object({
  connectionId: walletConnectionIdSchema,
  account: evmAccountIdentitySchema,
  requiredMethods: z.array(fixedIdentifierSchema).max(2 * walletSdkNamespaceArrayLimit).refine(isStrictlyOrderedUnique),
  permissionRevision: walletLocalRevisionSchema,
}).strict();
export type WalletBoundAccountReference = z.infer<typeof walletBoundAccountReferenceSchema>;
