import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import {createMcpToolResult, withOperationToolResultDescriptor, projectMcpSuccessSchema} from "./mcp-result.js";
import {z} from "zod";
import {canonicalJsonStringify, captureCanonicalJson, defineApplicationContract, getCapabilityDefinitionSnapshot, projectZodJsonSchema, type CanonicalJson} from "../core/index.js";
import {runtimeErrorRegistry} from "../runtime/error-registry.js";
import {runtimeInterfaceErrorMappings} from "../runtime/errors.js";
import {readInterfaceIdentities, uniswapV4PoolsInterface, accountAssetInterfaceBindings, tokenCatalogInterfaceBindings} from "./identities.js";
import {activityToolContracts} from "./exchange-tool-contracts.js";
import {receiptActivityInterfaceErrorMappings} from "../receipt-activity/error-mappings.js";
import {tokenCatalogInterfaceErrorMappings} from "../token-catalog/errors.js";
import {createLocalOperationIdentity} from "./local-operation.js";
import {publicReadResponseLimitBytes} from "../runtime/http-limits.js";
import {PresentationContractRegistry, capabilityEntry, presentationContractRegistry} from "./mcp-app/registry.js";
import {admitPresentationSnapshotResource, presentationSnapshotResourceSchema} from "./mcp-app/contracts.js";

// Data admission is independent of the View catalog. Reuse the exact existing
// canonical entries; extra data contracts do not acquire a renderer or card.
const entries = new Map(presentationContractRegistry.values()
  .filter(entry => entry.presentationKind === "immutable_result")
  .map(entry => [entry.contractId, entry]));
for (const identity of [...readInterfaceIdentities, uniswapV4PoolsInterface]) {
  if (!entries.has(identity.capabilityId)) entries.set(identity.capabilityId,
    capabilityEntry(identity.definition, identity.mcp.description, identity.responseAuthority.applicationErrors));
}
export const immutableReadContractRegistry = new PresentationContractRegistry([...entries.values()]);
export const storedPresentationContractRegistry = new PresentationContractRegistry([
  ...entries.values(), ...presentationContractRegistry.values().filter(entry => entry.presentationKind !== "immutable_result"),
]);

export const immutableReadMcpBindings = Object.freeze([
  ...[...readInterfaceIdentities, uniswapV4PoolsInterface].map(identity => ({
    contractId: identity.capabilityId, mcp: identity.mcp, resultDescriptor: false,
    inlineSchema: getCapabilityDefinitionSnapshot(identity.definition).successSchema,
    projectSuccessText: identity.projectSuccessText as ((value: CanonicalJson) => string) | undefined,
  })),
  ...[accountAssetInterfaceBindings.collection, tokenCatalogInterfaceBindings.selection, tokenCatalogInterfaceBindings.selections]
    .map(binding => ({contractId: binding.contract.capabilityId, mcp: binding.mcp!, resultDescriptor: false, projectSuccessText: undefined,
      inlineSchema: projectZodJsonSchema(projectMcpSuccessSchema(binding.contract.successSchema), "output")})),
  ...[activityToolContracts.get, activityToolContracts.list].map(binding => ({
    contractId: binding.contract.capabilityId, mcp: binding.mcp,
    resultDescriptor: binding === activityToolContracts.get, projectSuccessText: undefined,
    inlineSchema: projectZodJsonSchema(projectMcpSuccessSchema(binding.contract.successSchema), "output"),
  })),
]);
if (new Set(immutableReadMcpBindings.map(binding => binding.contractId)).size !== entries.size ||
  immutableReadMcpBindings.some(binding => !entries.has(binding.contractId))) throw new TypeError("Immutable read bindings are incomplete.");

// One native route transports the selected owner's unchanged failure. Its
// registry and HTTP mappings are generated unions, never new domain meanings.
const inheritedErrors = new Set(runtimeErrorRegistry.values().map(value => value.code));
const errorDefinitions = new Map([...entries.values()].flatMap(entry => entry.errorRegistry.values())
  .filter(value => !inheritedErrors.has(value.code)).map(value => [value.code, value]));
export const immutableReadErrorDefinitions = Object.freeze([...errorDefinitions.values()]);
export const immutableReadErrorRegistry = runtimeErrorRegistry.extend(immutableReadErrorDefinitions);
const mappings = new Map([
  ...[...readInterfaceIdentities, uniswapV4PoolsInterface].map(identity => identity.responseAuthority.interfaceMappings),
  accountAssetInterfaceBindings.collection.responseAuthority.interfaceMappings,
  tokenCatalogInterfaceErrorMappings,
  receiptActivityInterfaceErrorMappings,
].flatMap(registry => registry.values()).map(value => [value.code, value]));
export const immutableReadInterfaceErrorMappings = runtimeInterfaceErrorMappings.extend(immutableReadErrorRegistry,
  immutableReadErrorDefinitions.map(value => {
    const mapping = mappings.get(value.code);
    if (mapping === undefined) throw new TypeError("An immutable read failure has no canonical interface mapping.");
    return mapping;
  }));

const inputSchema = z.object({contractId: z.enum([...entries.keys()]), input: z.unknown()}).strict()
  .transform(value => ({contractId: value.contractId,
    input: immutableReadContractRegistry.requireIdentity(value.contractId, "1").parseNormalizedInput(value.input)}));
const resourceSchema = presentationSnapshotResourceSchema.transform(admitPresentationSnapshotResource);
export const immutableReadTransportSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("inline"), result: z.unknown().transform(captureCanonicalJson)}).strict(),
  z.object({kind: z.literal("reference"), resource: resourceSchema}).strict(),
]);
export type ImmutableReadTransport = z.infer<typeof immutableReadTransportSchema>;
export const immutableReadResultContract = defineApplicationContract({
  contractVersion: "1", inputSchema, successSchema: immutableReadTransportSchema,
  internalContextSchema: z.object({}).strict(), errorRegistry: immutableReadErrorRegistry,
  failureCodes: immutableReadErrorRegistry.values().map(value => value.code),
  validatePublicSuccess(input, transport) {
    const entry = immutableReadContractRegistry.requireIdentity(input.contractId, "1");
    if (transport.kind === "inline") entry.parseResult(input.input, transport.result);
    else if (transport.resource.descriptor.source.kind !== "sqlite" || transport.resource.descriptor.contractId !== entry.contractId ||
      transport.resource.descriptor.contractVersion !== entry.contractVersion ||
      canonicalJsonStringify(transport.resource.normalizedInput) !== canonicalJsonStringify(input.input)) {
      throw new TypeError("Immutable read transport changed its source.");
    }
  },
});
export const immutableReadResultIdentity = Object.freeze({contractId: "presentation.get_result", path: "/api/v1/internal/control/presentation/results"});
export type ImmutableReadInput = Readonly<{contractId: string; input: CanonicalJson}>;

export const immutableReadLocalIdentity = createLocalOperationIdentity({
  action: "read", contract: immutableReadResultContract, errorMappings: immutableReadInterfaceErrorMappings,
  maximumResponseBytes: publicReadResponseLimitBytes, operationId: () => undefined,
  actionRequest: input => ({method: "POST", path: immutableReadResultIdentity.path, body: captureCanonicalJson(input)}),
  parseActionResponse: (input, _id, value) => immutableReadResultContract.parsePublicSuccess(input, value),
});

export const formatImmutableReadResult = (contractId: string, input: CanonicalJson, result: CanonicalJson): CallToolResult => {
  const binding = immutableReadMcpBindings.find(value => value.contractId === contractId);
  if (binding === undefined) throw new TypeError("An immutable read has no MCP binding.");
  const formatted = createMcpToolResult(binding.mcp.name, result, false, binding.projectSuccessText?.(result));
  return binding.resultDescriptor ? withOperationToolResultDescriptor(binding.mcp.name, input, formatted) : formatted;
};
