import { z } from "zod";

import { uint256DecimalSchema } from "./amounts.js";
import { canonicalSha256, captureCanonicalJson, type CanonicalJson } from "./canonical-json.js";
import { evmAddressSchema, evmChainIdSchema } from "./identities.js";
import { deepFreezeValue } from "./immutability.js";
import { guardJsonSchema, jsonObject } from "./json-object.js";
import { hexBytesSchema, parseHash32, type Hash32 } from "./primitives.js";

const callSchema = jsonObject({
  type: z.literal("2"),
  accessList: z.tuple([]),
  chainId: evmChainIdSchema,
  from: evmAddressSchema,
  to: evmAddressSchema,
  value: uint256DecimalSchema,
  data: hexBytesSchema,
  nonce: uint256DecimalSchema,
  maxFeePerGas: uint256DecimalSchema,
  maxPriorityFeePerGas: uint256DecimalSchema,
}).strict().superRefine((request, context) => {
  if (BigInt(request.maxPriorityFeePerGas) > BigInt(request.maxFeePerGas)) {
    context.addIssue({ code: "custom", message: "Transaction gas or fee bounds are invalid." });
  }
});

export const dynamicFeeTransactionCallSchema = guardJsonSchema(callSchema);
export type DynamicFeeTransactionCall = z.infer<typeof dynamicFeeTransactionCallSchema>;
const requestSchema = callSchema.safeExtend({
  gasLimit: uint256DecimalSchema.refine((value) => value !== "0", "Gas limit must be positive."),
});

export const dynamicFeeTransactionRequestSchema = guardJsonSchema(requestSchema);
export type DynamicFeeTransactionRequest = z.infer<typeof dynamicFeeTransactionRequestSchema>;

export const admitDynamicFeeTransactionRequest = (input: unknown): DynamicFeeTransactionRequest =>
  deepFreezeValue(dynamicFeeTransactionRequestSchema.parse(captureCanonicalJson(input)));

export const dynamicFeeRequestCommitmentVersion = "1";

export const dynamicFeeRequestCommitment = (input: unknown): Hash32 => {
  const request = admitDynamicFeeTransactionRequest(input);
  return parseHash32(`0x${canonicalSha256({
    digestKind: "wallet_request",
    digestVersion: dynamicFeeRequestCommitmentVersion,
    request: request as unknown as CanonicalJson,
  })}`);
};
