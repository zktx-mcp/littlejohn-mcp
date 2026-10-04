import {z} from "zod";

import {evmAddressInputSchema} from "./address-input.js";
import {jsonObject} from "../core/client.js";

export const addressTargetSchema = z.discriminatedUnion("kind", [
  jsonObject({
    kind: z.literal("address"),
    address: evmAddressInputSchema,
  }).strict(),
  jsonObject({ kind: z.literal("active_wallet") }).strict(),
]);

export type AddressTarget = z.infer<typeof addressTargetSchema>;
