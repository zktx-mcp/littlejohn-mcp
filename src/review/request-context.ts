import { z } from "zod";
import { jsonObject, operationIdSchema } from "../core/client.js";
import { signingResponseContextSchema } from "./signing-contracts.js";

export const walletRequestResponseContextSchema = z.discriminatedUnion("kind", [
  jsonObject({ kind: z.literal("transaction"), operationId: operationIdSchema }).strict(),
  jsonObject({ kind: z.literal("signing"), context: signingResponseContextSchema }).strict(),
]);
export type WalletRequestResponseContext = z.infer<typeof walletRequestResponseContextSchema>;
