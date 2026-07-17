import { z } from "zod";

import { canonicalJsonStringify, canonicalSha256, type CanonicalJson } from "./canonical-json.js";
import { coreContractVersion } from "./contract.js";
import { createSha256HexSchema } from "./digests.js";
import {
  CapabilityRegistry,
  capabilityIdPatternSource,
  createCapabilityIdSchema,
  getCapabilityDefinitionSnapshot,
  type AnyReadCapabilityDefinition,
} from "./capability.js";
import { createEvidenceSchemaSet } from "./evidence.js";
import { deepFreezeValue } from "./immutability.js";
import { guardJsonSchema, jsonObject } from "./json-object.js";
import { compareCodePointSequences, createPrimitiveSchemaSet } from "./primitives.js";

const createCapabilityProjectionSchemaSet = () => {
  const primitive = createPrimitiveSchemaSet();
  const evidence = createEvidenceSchemaSet();
  const schemaDigest = createSha256HexSchema();
  const schemaVersion = `v${coreContractVersion}`;
  const schemaId = z.string().regex(new RegExp(
    "^urn:littlejohn:capability:" + capabilityIdPatternSource + ":(?:input|data|success):" + schemaVersion + "$",
  ));
  const projectedSchema = jsonObject({
      schemaId,
      digest: schemaDigest,
      schema: z.json(),
    })
    .strict();
  const capabilitySchemaProjection = jsonObject({
      capabilityId: createCapabilityIdSchema(),
      contractVersion: z.literal(coreContractVersion),
      input: projectedSchema,
      data: projectedSchema,
      success: projectedSchema,
      failureCodes: z.array(primitive.snakeCaseCode),
      conclusionIds: z.array(primitive.fixedIdentifier),
      warningCodes: z.array(evidence.warningCode),
      staticScopeExclusions: z.array(evidence.staticScopeExclusion),
    })
    .strict();
  return Object.freeze({ schemaDigest, schemaId, projectedSchema, capabilitySchemaProjection });
};

const publicSchemas = createCapabilityProjectionSchemaSet();
const authoritySchemas = createCapabilityProjectionSchemaSet();

export const capabilitySchemaProjectionSchema = guardJsonSchema(publicSchemas.capabilitySchemaProjection);
export type CapabilitySchemaProjection = z.infer<typeof capabilitySchemaProjectionSchema>;

export const extendCapabilitySchemaProjection = <const Shape extends z.ZodRawShape>(shape: Shape) =>
  guardJsonSchema(publicSchemas.capabilitySchemaProjection.extend(shape).strict());

const projectSchema = (schema: CanonicalJson, schemaId: string) => {
  const withId = { ...(schema as Record<string, CanonicalJson>), $id: schemaId } as unknown as CanonicalJson;
  const canonical = JSON.parse(canonicalJsonStringify(withId)) as CanonicalJson;
  return { schemaId, digest: canonicalSha256(canonical), schema: canonical };
};

const projectCapability = (definition: AnyReadCapabilityDefinition): CapabilitySchemaProjection => {
  const snapshot = getCapabilityDefinitionSnapshot(definition);
  const base = "urn:littlejohn:capability:" + snapshot.capabilityId;
  const schemaVersion = `v${coreContractVersion}`;
  return authoritySchemas.capabilitySchemaProjection.parse({
    capabilityId: snapshot.capabilityId,
    contractVersion: coreContractVersion,
    input: projectSchema(snapshot.inputSchema, `${base}:input:${schemaVersion}`),
    data: projectSchema(snapshot.dataSchema, `${base}:data:${schemaVersion}`),
    success: projectSchema(snapshot.successSchema, `${base}:success:${schemaVersion}`),
    failureCodes: snapshot.failureCodes,
    conclusionIds: snapshot.conclusionIds,
    warningCodes: snapshot.warningCodes,
    staticScopeExclusions: snapshot.staticScopeExclusions,
  });
};

export const projectCapabilities = (registry: CapabilityRegistry): readonly CapabilitySchemaProjection[] =>
  Object.freeze(
    registry.values()
      .map((definition) => deepFreezeValue(projectCapability(definition)))
      .sort((left, right) => compareCodePointSequences(left.capabilityId, right.capabilityId)),
  );
