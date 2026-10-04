import { z } from "zod";
import {createPrimitiveSchemaSet} from "../core/client.js";
import {guardJsonSchema, jsonObject} from "../core/client.js";
import {evmAddressSchema, evmChainIdSchema} from "./identities.js";

export const createEvmPrimitiveSchemaSet = () => {
  const common = createPrimitiveSchemaSet();
  const blockSelector = z.discriminatedUnion("kind", [
    jsonObject({ kind: z.literal("latest") }).strict(),
    jsonObject({ kind: z.literal("number"), blockNumber: common.unsignedDecimal }).strict(),
  ]);
  return Object.freeze({ ...common, blockSelector, evmAddress: evmAddressSchema,
    chainAnchor: jsonObject({ chainId: evmChainIdSchema, blockNumber: common.unsignedDecimal,
      blockHash: common.hash32, blockTimestamp: common.utcTimestamp }).strict() });
};
const schemas = createEvmPrimitiveSchemaSet();
export const chainAnchorSchema = guardJsonSchema(schemas.chainAnchor);
export type ChainAnchor = import("zod").infer<typeof chainAnchorSchema>;
export const blockSelectorSchema = guardJsonSchema(schemas.blockSelector);
export type BlockSelector = import("zod").infer<typeof blockSelectorSchema>;
