import {defineReadCapability, createCapabilitySuccessSchema, type CapabilityId, type SuccessValidationContext} from "../core/client.js";
import {evmChainIdSchema, type EvmChainId} from "./identities.js";
import {createEvmEvidenceSchemaSet} from "./evidence.js";

type EvmReadOptions<Input, Data> = Omit<Parameters<typeof defineReadCapability<Input, Data>>[0],
  "nativeChainIdSchema" | "nativeEvidence" | "validateSuccess"> & {
    readonly validateSuccess?: (data: Data, context: Omit<SuccessValidationContext, "chainId"> & {
      readonly chainId: EvmChainId;
    }) => void;
  };

export const defineEvmReadCapability = <Input, Data>(options: EvmReadOptions<Input, Data>) =>
  defineReadCapability<Input, Data>({ ...options, nativeChainIdSchema: evmChainIdSchema,
    nativeEvidence: createEvmEvidenceSchemaSet(),
    validateSuccess: (data, context) => options.validateSuccess?.(data,
      { ...context, chainId: evmChainIdSchema.parse(context.chainId) }),
  });

export const createEvmCapabilitySuccessSchema = <Data>(capabilityId: CapabilityId,
  version: "1", dataSchema: import("zod").ZodType<Data>) =>
  createCapabilitySuccessSchema(capabilityId, version, dataSchema,
    evmChainIdSchema, createEvmEvidenceSchemaSet());
