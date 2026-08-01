import { z } from "zod";

import {
  canonicalSha256,
  canonicalJsonStringify,
  compareCodePointSequences,
  captureCanonicalJson,
  deepFreezeValue,
  getCapabilityDefinitionSnapshot,
  type CanonicalJson,
} from "../core/index.js";
import { tokenCatalogErrorDefinitions } from "./error-definitions.js";
import {
  tokenCatalogApplicationContractList,
  tokenCatalogDigestVersions,
  tokenCatalogOperationConfirmationContract,
  tokenInspectCapability,
  tokenInspectionSuccessProjectionSchema,
} from "./contract-schema.js";
import {
  tokenCatalogOperationKinds,
  tokenCatalogOperationStates,
} from "./state.js";

export * from "./contract-schema.js";

export const tokenCatalogCapabilityIds = Object.freeze([
  getCapabilityDefinitionSnapshot(tokenInspectCapability).capabilityId,
  ...tokenCatalogApplicationContractList.map((contract) => contract.capabilityId),
].sort());

const tokenInspectionProjectionIdentity = canonicalJsonStringify(
  tokenInspectionSuccessProjectionSchema,
);

const normalizeGeneratedRequiredArrays = (value: CanonicalJson): CanonicalJson => {
  if (Array.isArray(value)) return value.map(normalizeGeneratedRequiredArrays);
  if (typeof value !== "object" || value === null) return value;
  const normalized: Record<string, CanonicalJson> = {};
  for (const [key, entry] of Object.entries(value)) {
    normalized[key] = key === "required" && Array.isArray(entry)
      ? [...entry].map(String).sort(compareCodePointSequences)
      : normalizeGeneratedRequiredArrays(entry);
  }
  return normalized;
};

const substituteTokenInspectionProjection = (value: CanonicalJson): CanonicalJson => {
  if (Array.isArray(value)) return value.map(substituteTokenInspectionProjection);
  if (typeof value !== "object" || value === null) return value;
  if (
    !Object.hasOwn(value, "$schema") &&
    canonicalJsonStringify(normalizeGeneratedRequiredArrays(value)) === tokenInspectionProjectionIdentity
  ) return tokenInspectionSuccessProjectionSchema;
  const projected: Record<string, CanonicalJson> = {};
  for (const [key, entry] of Object.entries(value)) {
    projected[key] = substituteTokenInspectionProjection(entry);
  }
  return projected;
};

const projectSchema = (schema: z.ZodType, io: "input" | "output"): CanonicalJson =>
  substituteTokenInspectionProjection(captureCanonicalJson(JSON.parse(JSON.stringify(z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io,
  })))));

export const tokenCatalogContractProjection = deepFreezeValue({
  contractVersion: "1" as const,
  inspection: getCapabilityDefinitionSnapshot(tokenInspectCapability),
  applications: tokenCatalogApplicationContractList.map((contract) => ({
    capabilityId: contract.capabilityId,
    contractVersion: contract.contractVersion,
    inputSchema: projectSchema(contract.inputSchema, "input"),
    successSchema: projectSchema(contract.successSchema, "output"),
    failureCodes: contract.failureCodes,
  })),
  operationConfirmation: {
    contractVersion: tokenCatalogOperationConfirmationContract.contractVersion,
    inputSchema: projectSchema(tokenCatalogOperationConfirmationContract.inputSchema, "input"),
    successSchema: projectSchema(tokenCatalogOperationConfirmationContract.successSchema, "output"),
    failureCodes: tokenCatalogOperationConfirmationContract.failureCodes,
  },
  errors: tokenCatalogErrorDefinitions,
  operationKinds: tokenCatalogOperationKinds,
  operationStates: tokenCatalogOperationStates,
  digestVersions: tokenCatalogDigestVersions,
});

export const tokenCatalogContractProjectionDigest = `0x${canonicalSha256(
  tokenCatalogContractProjection as unknown as CanonicalJson,
)}`;
