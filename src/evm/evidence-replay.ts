import {createValueConclusionIdentityDeclaration, createValueConclusionIdentity, type ValueConclusionIdentityDeclaration} from "../core/client.js";
import {evmAddressSchema, type EvmAddress} from "./identities.js";
export type EvmAddressConclusionIdentityDeclaration = ValueConclusionIdentityDeclaration;
export const createEvmAddressConclusionIdentityDeclaration = (prefix: string): EvmAddressConclusionIdentityDeclaration =>
  createValueConclusionIdentityDeclaration(prefix, evmAddressSchema, "0x0000000000000000000000000000000000000000", "<address>");
export const createEvmAddressConclusionIdentity = (declaration: EvmAddressConclusionIdentityDeclaration, address: EvmAddress) =>
  createValueConclusionIdentity(declaration, evmAddressSchema.parse(address));

import { createEvidenceReplayDefinition } from "../core/client.js";
import { createAmountSchemaSet } from "./amounts.js";
import { createEvmPrimitiveSchemaSet } from "./primitives.js";
import { createEvmEvidenceSchemaSet } from "./evidence.js";

export const createEvmEvidenceReplayDefinition = (
  input: Omit<Parameters<typeof createEvidenceReplayDefinition>[0], "valueSchemas">,
) => createEvidenceReplayDefinition({
  ...input,
  valueSchemas: {
    chainAnchor: createEvmPrimitiveSchemaSet().chainAnchor,
    asset: createAmountSchemaSet().assetIdentity,
    evidence: createEvmEvidenceSchemaSet(),
  },
});
