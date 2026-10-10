import type { PresentationSnapshotReadPort } from "../runtime/presentation-snapshot.js";
import type { PresentationTurnContext } from "./mcp-app/publication-context.js";
import {walletAccountBindings} from "./wallet-account-bindings.js";
import type {PresentationPublicationKeyOwner} from "../runtime/presentation-publication-key.js";
import {operationDeliveryUnknownSchema} from "./operation-delivery.js";
import { CardDomainError } from "./mcp-app/card-sources.js";
import { normalizeCodexTurnContext } from "./mcp-app/publication-context.js";
import { cardActionEnvelopeSchema, cardErrorDefinitions, cardErrorRegistry, presentationCardMetadataKey,
  cardIdFromPresentationUri, presentationCardUriPrefix, cardPresentationDeliverySchema, cardPresentationMetadataKey,
  admitCardActionDelivery, admitCardActionPresentation, serializeCardActionPresentation, cardCreationResultSchema, type CardActionDelivery } from "./mcp-app/card-contract.js";
import { liveReviewPresentationIdentity } from "./review-presentation-binding.js";
import { signingBindings } from "./signing-bindings.js";
import { signingReviewText } from "./signing-presentation.js";
import { signingSignatureMetadataKey } from "./signing-result.js";
import { admitSigningCompletion, createSigningCompletion, signingDirectDecisionSchema, signingResponseContext } from "../review/signing-contracts.js";
import { uniswapV4PoolsInterface, uniswapV4PoolsLocalIdentity, stockTokenTradeHistoryInterface } from "./identities.js";
import { exchangeReviewSections, transactionSectionsText } from "./exchange-presentation.js";
import { exchangeReviewSchema } from "../review/contracts.js";
import { exchangeBindings, activityBindings } from "./exchange-bindings.js";
import { receiptActivityErrorRegistry } from "../receipt-activity/errors.js";
import { receiptActivityInterfaceErrorMappings } from "../receipt-activity/error-mappings.js";
import { runtimePackageIdentity } from "../runtime/package-identity.js";
import type { Readable, Writable } from "node:stream";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type AnyAccountAssetApplicationContract,
} from "../account-assets/client.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {applicationFailureSchemaFor, canonicalJsonStringify, captureCanonicalJson, compareCodePointSequences, fieldIssuesFromInputError, fixedIdentifierSchema, parseCapabilityInput, getCapabilityDefinitionSnapshot, parseCapabilitySuccess, projectZodJsonSchema, projectCapabilities, type CanonicalJson, type CapabilityId, type ApplicationErrorRegistry} from "../core/index.js";
import {readBoundaryFailureCodes} from "../core/index.js";
import type { RuntimeOwnerSessionPort } from "../runtime/owner-session.js";
import type { PresentationSnapshotStore } from "../runtime/presentation-snapshot.js";
import {
  tokenCatalogErrorRegistry,
} from "../token-catalog/errors.js";
import {
  type AnyTokenCatalogApplicationContract,
} from "../token-catalog/client.js";
import type {
  AnyWalletManagementContract,
} from "../wallet/management-contracts.js";
import {
  createInterfaceFailure,
  constrainInterfaceFailure,
  dispatchCanonical,
  type InterfaceInvocationResult,
  type RuntimeDispatchPort,
} from "./http-client.js";
import {
  capabilityCatalogInterface,
  accountAssetInterfaceBindingList,
  accountAssetLocalOperationIdentities,
  declaredMcpToolNames,
  interfaceReadCapabilityRegistry,
  readInterfaceIdentities,
  tokenCatalogInterfaceBindings,
  tokenLocalReadIdentities,
  type TokenCatalogInterfaceBinding,
  type AccountAssetInterfaceBinding,
  type InterfaceToolAnnotations,
  type ReadInterfaceIdentity,
} from "./identities.js";
import { LocalOperationClient } from "./operation-client.js";
import {
  deliveryUnknownSchema,
  selectorDeliveryUnknownSchema,
  isDeliveryUnknown,
  type DeliveryUnknown,
} from "./operation-delivery.js";
import { interfaceCapabilityCatalogSchema } from "./support.js";
import {
  resolveLocalOperationIdentity,
} from "./local-operation.js";
import {
  operationInterfaceBindingList,
  operationInterfaceBindings,
  walletOperationPresentationIdentity,
  type OperationInterfaceBinding,
  type OperationToolVisibility,
} from "./operation-bindings.js";
import {
  createOperationToolResultDescriptor,
  createOperationToolResultDescriptorFromEvidence,
  operationToolInputEvidence,
  createWalletOperationQrMetadata,
  operationToolResultMetadataKey,
  presentationMcpTools,
  presentationSnapshotChunkSchema,
  presentationSnapshotIdSchema,
  presentationSnapshotReferenceSchema,
  presentationSnapshotUriSchema,
  presentationUnavailableSchema,
  walletOperationQrMetadataKey,
} from "./mcp-app/contracts.js";
import { projectMcpInputSchema } from "./mcp-input-schema.js";
import {
  admitMcpToolResultForDelivery,
  type McpToolResultDelivery,
} from "./mcp-result.js";
import { presentationContractRegistry } from "./mcp-app/registry.js";
import { cardBindings, cardReadStartBinding, cardDecisionStartBinding, createCardDecisionIdentity } from "./mcp-app/card-bindings.js";
import {
  appToolMetadata, withCardReference, chartAppResourceUri, chartAppResourceTemplate, chartCardIdFromAppResourceUri,
  createMcpAppPresentationService,
  type McpAppPresentationService,
  type McpAppResource,
} from "./mcp-app/server.js";

export const mcpServerIdentity = runtimePackageIdentity;

declare const mcpToolNameBrand: unique symbol;
export type McpToolName = string & { readonly [mcpToolNameBrand]: true };
export const mcpToolNames = declaredMcpToolNames;

const mcpToolNamePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}$/;
const expectedToolNames = new Set<string>(mcpToolNames);

export const parseMcpToolName = (value: unknown): McpToolName => {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !mcpToolNamePattern.test(value) ||
    !expectedToolNames.has(value)
  ) throw new TypeError("MCP tool name is invalid or undeclared.");
  return value as McpToolName;
};

interface McpToolDefinitionBase {
  readonly name: McpToolName;
  readonly description: string;
  readonly inputSchema: Tool["inputSchema"];
  readonly outputSchema: NonNullable<Tool["outputSchema"]>;
  readonly failureCodes: readonly string[];
  readonly annotations: ToolAnnotations;
  readonly visibility: OperationToolVisibility;
  readonly createsView: boolean;
  readonly walletRequest?: "transaction" | "signing";
  readonly resultDescriptor?: true;
  readonly deliveryRecovery?: McpDeliveryRecoveryDescriptor;
  readonly presentationTool?: "get_snapshot" | "get_snapshot_chunk" | "start_read" | "start_decision";
  readonly cardDecision?: true;
  readonly operationBinding?: OperationInterfaceBinding;
  readonly projectSuccessText?: (success: CanonicalJson) => string;
  readonly parseInput: (value: unknown) => unknown;
}
interface McpInvocationToolDefinition extends McpToolDefinitionBase {
  readonly invoke: (input: unknown, signal: AbortSignal, publicationKey?: string | null) => Promise<McpInvocationResult>;
  readonly deliver?: never;
}
interface McpResultToolDefinition extends McpToolDefinitionBase {
  readonly deliver: (input: unknown, signal: AbortSignal) => Promise<McpToolResultDelivery>;
  readonly invoke?: never;
}
type McpToolDefinition = McpInvocationToolDefinition | McpResultToolDefinition;

type McpInvocationResult =
  | InterfaceInvocationResult
  | Readonly<{
      readonly ok: true;
      readonly value: CanonicalJson;
      readonly privateMetadata: Readonly<Record<string, unknown>>;
    }>
  | DeliveryUnknown;

interface McpDeliveryRecoveryDescriptor {
  readonly schema: z.ZodType;
  project(delivery: DeliveryUnknown): CanonicalJson;
}

export interface McpRuntimePort extends RuntimeDispatchPort, RuntimeOwnerSessionPort {}

export interface McpServerRuntimePort extends McpRuntimePort {
  presentationSnapshotStore(): PresentationSnapshotReadPort;
  presentationPublicationKeys(): { derive(context: PresentationTurnContext): string | Promise<string> };
}

type McpObjectSchema = Tool["inputSchema"] | NonNullable<Tool["outputSchema"]>;

const canonicalSchema = <Schema extends McpObjectSchema>(value: unknown): Schema => {
  const captured = captureCanonicalJson(JSON.parse(JSON.stringify(value)));
  if (typeof captured !== "object" || captured === null || Array.isArray(captured) ||
    (captured["type"] !== undefined && captured["type"] !== "object")) {
    throw new TypeError("MCP schema must describe an object.");
  }
  return captureCanonicalJson({ ...captured, type: "object" }) as Schema;
};

const zodSchema = (
  schema: z.ZodType,
  io: "input" | "output",
): Readonly<Record<string, unknown>> => projectZodJsonSchema(schema, io);

interface RebasedSchema {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly definitions: Readonly<Record<string, unknown>>;
}

const rebaseSchema = (value: unknown, prefix: string): RebasedSchema => {
  const root = JSON.parse(JSON.stringify(value)) as unknown;
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new TypeError("MCP schema branch must be an object.");
  }
  const record = root as Record<string, unknown>;
  const definitionsValue = record["$defs"];
  if (
    definitionsValue !== undefined &&
    (typeof definitionsValue !== "object" || definitionsValue === null || Array.isArray(definitionsValue))
  ) throw new TypeError("MCP schema definitions are invalid.");
  const sourceDefinitions = definitionsValue as Record<string, unknown> | undefined;
  const definitionNames = new Map(
    Object.keys(sourceDefinitions ?? {}).map((name) => [name, `${prefix}_${name}`]),
  );
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (typeof input !== "object" || input === null) return input;
    const source = input as Readonly<Record<string, unknown>>;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      if (key === "$defs" || key === "$schema" || key === "$id") continue;
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/$defs/")) {
        const sourceName = child.slice("#/$defs/".length);
        const targetName = definitionNames.get(sourceName);
        if (targetName === undefined) throw new TypeError("MCP schema reference is unresolved.");
        output[key] = `#/$defs/${targetName}`;
      } else {
        output[key] = visit(child);
      }
    }
    return output;
  };
  const definitions = Object.fromEntries(
    Object.entries(sourceDefinitions ?? {}).map(([name, definition]) => {
      const targetName = definitionNames.get(name);
      if (targetName === undefined) throw new TypeError("MCP schema definition is unresolved.");
      return [targetName, visit(definition)];
    }),
  );
  return Object.freeze({
    schema: visit(record) as Readonly<Record<string, unknown>>,
    definitions: Object.freeze(definitions),
  });
};

const projectedCapabilities = new Map(
  projectCapabilities(interfaceReadCapabilityRegistry).map((projection) => [
    projection.capabilityId,
    projection,
  ]),
);

const capabilityCatalogSchema = interfaceCapabilityCatalogSchema;

const capabilityInputSchema = (capabilityId: CapabilityId): Tool["inputSchema"] => {
  const projection = projectedCapabilities.get(capabilityId);
  if (projection === undefined) throw new TypeError("Capability input schema is unavailable.");
  return projectMcpInputSchema(projection.input.schema);
};

const successOrFailureSchema = (
  successSchema: unknown,
  failureCodes: readonly string[],
  errorRegistry: ApplicationErrorRegistry = tokenCatalogErrorRegistry,
): NonNullable<Tool["outputSchema"]> => {
  const success = rebaseSchema(successSchema, "success");
  const failure = rebaseSchema(
    zodSchema(applicationFailureSchemaFor(errorRegistry, failureCodes), "output"),
    "failure",
  );
  return canonicalSchema<NonNullable<Tool["outputSchema"]>>({
    type: "object",
    $defs: {
      ...success.definitions,
      ...failure.definitions,
    },
    anyOf: [
      success.schema,
      failure.schema,
    ],
  });
};

const successFailureOrDeliverySchema = (
  successSchema: unknown,
  failureCodes: readonly string[],
  errorRegistry: ApplicationErrorRegistry = tokenCatalogErrorRegistry,
  deliverySchema: z.ZodType = deliveryUnknownSchema,
): NonNullable<Tool["outputSchema"]> => {
  const success = rebaseSchema(successSchema, "success");
  const failure = rebaseSchema(
    zodSchema(applicationFailureSchemaFor(errorRegistry, failureCodes), "output"),
    "failure",
  );
  const delivery = rebaseSchema(zodSchema(deliverySchema, "output"), "delivery");
  return canonicalSchema<NonNullable<Tool["outputSchema"]>>({
    type: "object",
    $defs: {
      ...success.definitions,
      ...failure.definitions,
      ...delivery.definitions,
    },
    anyOf: [success.schema, failure.schema, delivery.schema],
  });
};

const capabilityOutputSchema = (
  capabilityId: CapabilityId,
  errorRegistry: ApplicationErrorRegistry,
): NonNullable<Tool["outputSchema"]> => {
  const projection = projectedCapabilities.get(capabilityId);
  if (projection === undefined) throw new TypeError("Capability output schema is unavailable.");
  return successOrFailureSchema(
    projection.success.schema,
    projection.failureCodes,
    errorRegistry,
  );
};

type InterfaceApplicationContract =
  | AnyAccountAssetApplicationContract
  | AnyWalletManagementContract
  | typeof walletAccountBindings[keyof typeof walletAccountBindings]["contract"]
  | AnyTokenCatalogApplicationContract
  | import("../review/application-contracts.js").AnyExchangeApplicationContract
  | typeof signingBindings[keyof typeof signingBindings]["contract"]
  | typeof cardBindings[keyof typeof cardBindings]["contract"]
  | typeof cardReadStartBinding.contract
  | typeof cardDecisionStartBinding.contract
  | typeof activityBindings[keyof typeof activityBindings]["contract"];

const contractInputSchema = (
  contract: InterfaceApplicationContract,
): Tool["inputSchema"] =>
  projectMcpInputSchema(zodSchema(contract.inputSchema, "input"));

const contractOutputSchema = (
  contract: InterfaceApplicationContract,
  errorRegistry: ApplicationErrorRegistry = tokenCatalogErrorRegistry,
): NonNullable<Tool["outputSchema"]> =>
  successOrFailureSchema(zodSchema(contract.successSchema, "output"), contract.failureCodes, errorRegistry);

const recoveryOperationId = (value: unknown): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)["operationId"]
    : undefined;

const createMcpDeliveryRecoveryDescriptor = (
  source: OperationInterfaceBinding,
): McpDeliveryRecoveryDescriptor | undefined => {
  const target = source.recoveryOperation;
  if (target === undefined) return undefined;
  if (target.action !== "get_operation") {
    throw new TypeError("MCP delivery recovery target is invalid.");
  }
  const sourceBinding = resolveLocalOperationIdentity(source.identity);
  if (sourceBinding.action !== "decide" && sourceBinding.action !== "cancel") {
    throw new TypeError("MCP delivery action is invalid.");
  }
  const expectedAction = sourceBinding.action;
  const targetTool = parseMcpToolName(target.mcp.name);
  const schema = z.object({
    delivery: operationDeliveryUnknownSchema.extend({ action: z.literal(expectedAction) }),
    recovery: z.object({
      tool: z.literal(targetTool),
      arguments: target.contract.inputSchema,
    }).strict(),
  }).strict().superRefine((value, context) => {
    if (recoveryOperationId(value.recovery["arguments"]) !== value.delivery.operationId) {
      context.addIssue({
        code: "custom",
        path: ["recovery", "arguments", "operationId"],
        message: "Recovery operation ID does not match delivery.",
      });
    }
  });
  return Object.freeze({
    schema,
    project(delivery: DeliveryUnknown): CanonicalJson {
      if (delivery.action === "select_account" || delivery.action !== expectedAction) {
        throw new TypeError("MCP delivery action does not match its source identity.");
      }
      const targetInput = target.contract.parseInput({ operationId: delivery.operationId });
      return captureCanonicalJson(schema.parse({
        delivery,
        recovery: {
          tool: targetTool,
          arguments: targetInput,
        },
      }));
    },
  });
};

const annotations = (value: InterfaceToolAnnotations): ToolAnnotations => Object.freeze({ ...value });
const success = (
  value: unknown,
  privateMetadata?: Readonly<Record<string, unknown>>,
): McpInvocationResult => Object.freeze({
  ok: true,
  value: captureCanonicalJson(value),
  ...(privateMetadata === undefined ? {} : { privateMetadata }),
});
const cardSuccess = (delivery: CardActionDelivery, value: unknown = delivery.result,
  privateMetadata: Readonly<Record<string, unknown>> = {}): McpInvocationResult => success(value, {
    [cardPresentationMetadataKey]: serializeCardActionPresentation(delivery.presentation),
    ...(delivery.qr === undefined ? {} : { [walletOperationQrMetadataKey]: delivery.qr }),
    ...privateMetadata,
  });
const failure = (): InterfaceInvocationResult => ({
  ok: false,
  failure: createInterfaceFailure("internal_error"),
});

const publicRead = (
  runtime: RuntimeDispatchPort,
  identity: Pick<ReadInterfaceIdentity, "http" | "responseAuthority">,
  signal: AbortSignal,
  body?: CanonicalJson,
): Promise<InterfaceInvocationResult> => {
  if (identity.http.method === "POST") {
    if (body === undefined) throw new TypeError("POST public reads require a canonical JSON body.");
    return dispatchCanonical(runtime, {
      requestClass: "public_read",
      method: "POST",
      path: identity.http.path,
      body,
      signal,
    }, 200, identity.responseAuthority);
  }
  if (body !== undefined) throw new TypeError("GET public reads cannot contain a body.");
  return dispatchCanonical(runtime, {
    requestClass: "public_read",
    method: "GET",
    path: identity.http.path,
    signal,
  }, 200, identity.responseAuthority);
};

const withCardFailures = (definition: McpToolDefinition): McpToolDefinition => Object.freeze({
  ...definition,
  failureCodes: Object.freeze([...new Set([...definition.failureCodes, ...cardErrorDefinitions.map((entry) => entry.code)])]),
  outputSchema: successOrFailureSchema(definition.outputSchema, cardErrorDefinitions.map((entry) => entry.code), cardErrorRegistry),
});

const cardDecisionInput = (contract: InterfaceApplicationContract, value: unknown): unknown => {
  const envelope = cardActionEnvelopeSchema.parse(captureCanonicalJson(value));
  return { ...envelope, decision: validateLocalToolInput(contract.parseInput, envelope.decision) };
};
const cardDecisionInputSchema = (contract: InterfaceApplicationContract): Tool["inputSchema"] =>
  projectMcpInputSchema(zodSchema(cardActionEnvelopeSchema.extend({ decision: contract.inputSchema }), "input"));

const readTool = (
  runtime: RuntimeDispatchPort,
  identity: ReadInterfaceIdentity,
  client: LocalOperationClient,
): McpToolDefinition => {
  const projection = projectedCapabilities.get(identity.capabilityId);
  if (projection === undefined) throw new TypeError("Capability projection is unavailable.");
  return Object.freeze({
    name: parseMcpToolName(identity.mcp.name),
    description: identity.mcp.description,
    inputSchema: capabilityInputSchema(identity.capabilityId),
    outputSchema: capabilityOutputSchema(
      identity.capabilityId,
      identity.responseAuthority.applicationErrors,
    ),
    failureCodes: projection.failureCodes,
    annotations: annotations(identity.mcp.annotations),
    visibility: ["model"] as const,
    createsView: false,
    ...(identity.projectSuccessText === undefined
      ? {}
      : {
          projectSuccessText: (success: CanonicalJson) =>
            identity.projectSuccessText!(success as never),
        }),
    parseInput: (value: unknown) => parseCapabilityInput(identity.definition, value),
    invoke: async (value: unknown, signal: AbortSignal) => {
      const result = identity.localReadIdentity === undefined ? await publicRead(
        runtime,
        identity,
        signal,
        identity.http.method === "POST" ? captureCanonicalJson(value) : undefined,
      ) : await client.invoke(identity.localReadIdentity, value, signal);
      if (isDeliveryUnknown(result)) return result;
      if (!result.ok) return result;
      try { return success(parseCapabilitySuccess(identity.definition, value, result.value)); }
      catch { return failure(); }
    },
  });
};

const validateLocalToolInput = (
  parseInput: (value: unknown) => unknown,
  value: unknown,
): CanonicalJson => {
  parseInput(value);
  return captureCanonicalJson(value);
};

const operationTool = (
  client: LocalOperationClient,
  binding: OperationInterfaceBinding,
): McpToolDefinition => {
  const decision = binding.action === "decide";
  const identity = decision ? binding.cardIdentity : binding.identity;
  if (identity === undefined) throw new TypeError("A direct operation requires its card transport binding.");
  const deliveryRecovery = createMcpDeliveryRecoveryDescriptor(binding);
  const errorRegistry = resolveLocalOperationIdentity(binding.identity).contract.errorRegistry;
  const common = {
    name: parseMcpToolName(binding.mcp.name),
    description: binding.mcp.description,
    inputSchema: decision ? cardDecisionInputSchema(binding.contract) : contractInputSchema(binding.contract),
    failureCodes: binding.contract.failureCodes,
    annotations: annotations(binding.mcp.annotations),
    visibility: binding.mcp.visibility,
    createsView: false,
    operationBinding: binding,
    parseInput: (value: unknown): unknown => decision ? cardDecisionInput(binding.contract, value) : validateLocalToolInput(binding.contract.parseInput, value),
  } as const;
  const definition: McpToolDefinition = Object.freeze({
    ...common,
    ...(deliveryRecovery === undefined ? {} : { deliveryRecovery }),
    outputSchema: deliveryRecovery === undefined
      ? contractOutputSchema(binding.contract, errorRegistry)
      : successFailureOrDeliverySchema(
        zodSchema(binding.contract.successSchema, "output"),
        binding.contract.failureCodes,
        errorRegistry,
        deliveryRecovery.schema,
      ),
    invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
      if (binding === operationInterfaceBindings.walletOperation) {
        const result = await client.invoke(walletOperationPresentationIdentity, value, signal);
        if ("status" in result || !result.ok) return result;
        return success(
          result.value.operation,
          result.value.qr === undefined
            ? undefined
            : {
                [walletOperationQrMetadataKey]: createWalletOperationQrMetadata(
                  result.value.operation,
                  result.value.qr,
                ),
              },
        );
      }
      const result = await client.invoke(identity, value, signal);
      return "status" in result || !result.ok ? result : decision ? cardSuccess(admitCardActionDelivery(result.value)) : success(result.value);
    },
  });
  return decision ? withCardFailures(definition) : definition;
};

const tokenCatalogReadTool = (
  client: LocalOperationClient,
  binding: TokenCatalogInterfaceBinding,
): McpToolDefinition => {
  const common = {
    name: parseMcpToolName(binding.mcp.name),
    description: binding.mcp.description,
    inputSchema: contractInputSchema(binding.contract),
    failureCodes: binding.contract.failureCodes,
    annotations: annotations(binding.mcp.annotations),
    visibility: ["model"] as const,
    createsView: false,
    parseInput: (value: unknown): unknown => validateLocalToolInput(binding.contract.parseInput, value),
  } as const;
  if (binding.action === "get") {
    return Object.freeze({
      ...common,
      outputSchema: contractOutputSchema(binding.contract),
      invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
        const result = await client.invoke(
          tokenLocalReadIdentities.selection,
          value,
          signal,
        );
        return "status" in result || !result.ok ? result : success(result.value);
      },
    });
  }
  if (binding.action === "list") {
    return Object.freeze({
      ...common,
      outputSchema: contractOutputSchema(binding.contract),
      invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
        const result = await client.invoke(
          tokenLocalReadIdentities.selections,
          value,
          signal,
        );
        return "status" in result || !result.ok ? result : success(result.value);
      },
    });
  }
  throw new TypeError("Token catalog read MCP binding action is unsupported.");
};

const accountAssetTool = (
  client: LocalOperationClient,
  binding: AccountAssetInterfaceBinding,
): McpToolDefinition => Object.freeze({
  name: parseMcpToolName(binding.mcp!.name),
  description: binding.mcp!.description,
  inputSchema: contractInputSchema(binding.contract),
  outputSchema: contractOutputSchema(binding.contract),
  failureCodes: binding.contract.failureCodes,
  annotations: annotations(binding.mcp!.annotations),
  visibility: ["model"] as const,
  createsView: false,
  parseInput: (value: unknown): unknown => validateLocalToolInput(binding.contract.parseInput, value),
  invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
    const result = await client.invoke(accountAssetLocalOperationIdentities.collection, value, signal);
    return "status" in result || !result.ok ? result : success(result.value);
  },
});

const presentationSnapshotInputSchema = z.object({
  snapshotUri: presentationSnapshotUriSchema,
}).strict();
const presentationSnapshotChunkInputSchema = z.object({
  snapshotUri: presentationSnapshotUriSchema,
  index: z.number().int().min(0),
}).strict();

const presentationToolDefinitions = (
  presentation: McpAppPresentationService | undefined,
): readonly McpToolDefinition[] => Object.freeze([
  Object.freeze({
    name: parseMcpToolName(presentationMcpTools.getSnapshot),
    description: "Read one exact retained presentation descriptor and immutable data without creating a card or action controls.",
    inputSchema: projectMcpInputSchema(zodSchema(presentationSnapshotInputSchema, "input")),
    outputSchema: successOrFailureSchema(zodSchema(z.union([
      presentationSnapshotReferenceSchema,
      presentationUnavailableSchema,
    ]), "output"), readBoundaryFailureCodes),
    failureCodes: readBoundaryFailureCodes,
    annotations: annotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    visibility: ["model"] as const,
    createsView: false,
    presentationTool: "get_snapshot" as const,
    parseInput: (value: unknown) => presentationSnapshotInputSchema.parse(
      captureCanonicalJson(value),
    ),
    deliver: async (value: unknown): Promise<McpToolResultDelivery> => completeMcpToolResult(
      presentation === undefined
        ? canonicalToolResult(captureCanonicalJson({ kind: "presentation_unavailable", status: "unavailable", reason: "runtime_unavailable" }), false)
        : await presentation.getSnapshotResult(presentationSnapshotInputSchema.parse(value).snapshotUri),
    ),
  }),
  Object.freeze({
    name: parseMcpToolName(presentationMcpTools.getSnapshotChunk),
    description: "Read one exact raw-byte slice from a retained presentation result.",
    inputSchema: projectMcpInputSchema(zodSchema(presentationSnapshotChunkInputSchema, "input")),
    outputSchema: successOrFailureSchema(zodSchema(z.union([
      presentationSnapshotChunkSchema,
      presentationUnavailableSchema,
    ]), "output"), readBoundaryFailureCodes),
    failureCodes: readBoundaryFailureCodes,
    annotations: annotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    visibility: ["app"] as const,
    createsView: false,
    presentationTool: "get_snapshot_chunk" as const,
    parseInput: (value: unknown) => presentationSnapshotChunkInputSchema.parse(
      captureCanonicalJson(value),
    ),
    invoke: async (value: unknown): Promise<McpInvocationResult> => {
      const input = presentationSnapshotChunkInputSchema.parse(value);
      return success(presentation === undefined
        ? { kind: "presentation_unavailable", status: "unavailable", reason: "runtime_unavailable" }
        : await presentation.getResultChunk(input.snapshotUri, input.index));
    },
  }),
]);

const exchangeToolDefinitions = (runtime: RuntimeDispatchPort, client: LocalOperationClient): readonly McpToolDefinition[] => [
  ...Object.values(exchangeBindings).map((binding): McpToolDefinition => {
    const decision = binding === exchangeBindings.request;
    const identity = "cardIdentity" in binding ? binding.cardIdentity : binding.identity;
    const definition: McpToolDefinition = Object.freeze({
    name: parseMcpToolName(binding.mcp.name), description: binding.mcp.description,
    inputSchema: decision ? cardDecisionInputSchema(binding.contract) : contractInputSchema(binding.contract), outputSchema: contractOutputSchema(binding.contract, binding.contract.errorRegistry),
    failureCodes: binding.contract.failureCodes, annotations: annotations(binding.mcp.annotations), visibility: binding.mcp.visibility,
    createsView: false,
    ...(binding === exchangeBindings.start ? { projectSuccessText: (value: CanonicalJson) => transactionSectionsText(exchangeReviewSections(exchangeReviewSchema.parse(value))) } : { resultDescriptor: true as const }),
    ...(binding === exchangeBindings.request ? { walletRequest: "transaction" as const } : {}),
    parseInput: (value: unknown) => decision ? cardDecisionInput(binding.contract, value) : validateLocalToolInput(binding.contract.parseInput, value),
    invoke: (value: unknown, signal: AbortSignal) => client.invoke(identity as import("./local-operation.js").LocalOperationIdentity<unknown, unknown>, value, signal)
      .then((result): McpInvocationResult => "status" in result ? binding === exchangeBindings.request
        ? success({ kind: "wallet_result", outcome: { status: "delivery_unknown" } })
        : { ok: false, failure: createInterfaceFailure("runtime_state_unavailable") }
        : !result.ok ? result : decision ? cardSuccess(admitCardActionDelivery(result.value)) : success(result.value)),
  });
    return decision ? withCardFailures(definition) : definition;
  }),
  ...Object.values(activityBindings).map((binding): McpToolDefinition => Object.freeze({
    name: parseMcpToolName(binding.mcp.name), description: binding.mcp.description,
    inputSchema: contractInputSchema(binding.contract), outputSchema: contractOutputSchema(binding.contract, binding.contract.errorRegistry),
    failureCodes: binding.contract.failureCodes, annotations: annotations(binding.mcp.annotations), visibility: binding.mcp.visibility,
    createsView: false,
    resultDescriptor: true,
    parseInput: (value: unknown) => validateLocalToolInput(binding.contract.parseInput, value),
    invoke: async (value: unknown, signal: AbortSignal) => {
      const result = "identity" in binding ? await client.invoke(binding.identity, value, signal) : await dispatchCanonical(runtime,
        { requestClass: "public_read", method: "POST", path: binding.path, body: captureCanonicalJson(value), signal }, 200,
        { applicationErrors: receiptActivityErrorRegistry, interfaceMappings: receiptActivityInterfaceErrorMappings });
      if ("status" in result || !result.ok) return result;
      return success(binding.contract.parsePublicSuccess(value, result.value));
    },
  })),
];

const signingToolDefinitions = (client: LocalOperationClient): readonly McpToolDefinition[] => Object.values(signingBindings).map((binding) => {
  const decision = binding === signingBindings.request;
  const identity = "cardIdentity" in binding ? binding.cardIdentity : binding.identity;
  const definition: McpToolDefinition = Object.freeze({
  name: parseMcpToolName(binding.mcp.name), description: binding.mcp.description,
  inputSchema: decision ? cardDecisionInputSchema(binding.contract) : contractInputSchema(binding.contract), outputSchema: contractOutputSchema(binding.contract, binding.contract.errorRegistry),
  failureCodes: binding.contract.failureCodes, annotations: annotations(binding.mcp.annotations), visibility: binding.mcp.visibility,
  createsView: false,
  ...(binding === signingBindings.start ? { projectSuccessText: signingReviewText } : { resultDescriptor: true as const }),
  ...(binding === signingBindings.request ? { walletRequest: "signing" as const } : {}),
  parseInput: (value: unknown) => decision ? cardDecisionInput(binding.contract, value) : validateLocalToolInput(binding.contract.parseInput, value),
  invoke: (value: unknown, signal: AbortSignal) => {
    const correlation = binding === signingBindings.request ? signingResponseContext(signingDirectDecisionSchema.parse(cardActionEnvelopeSchema.parse(value).decision).review) : undefined;
    const pending = client.invoke(identity as import("./local-operation.js").LocalOperationIdentity<unknown, unknown>, value, signal);
    value = undefined;
    return pending.then((result): McpInvocationResult => {
      if ("status" in result) return correlation === undefined ? { ok: false, failure: createInterfaceFailure("runtime_state_unavailable") }
        : success(createSigningCompletion(correlation, "delivery_unknown").outcome);
      if (!result.ok) return result;
      if (correlation === undefined) return success(result.value);
      const delivery = admitCardActionDelivery(result.value);
      const completion = admitSigningCompletion(correlation, delivery.result);
      return cardSuccess(delivery, completion.outcome, "signature" in completion ? { [signingSignatureMetadataKey]: completion.signature } : {});
    });
  },
});
  return decision ? withCardFailures(definition) : definition;
});

const cardToolDefinitions = (client: LocalOperationClient): readonly McpToolDefinition[] =>
  Object.values(cardBindings).map((binding) => Object.freeze({
    name: parseMcpToolName(binding.mcp.name),
    description: binding.mcp.description,
    inputSchema: contractInputSchema(binding.contract),
    outputSchema: contractOutputSchema(binding.contract, binding.contract.errorRegistry),
    failureCodes: binding.contract.failureCodes,
    annotations: annotations(binding.mcp.annotations),
    visibility: binding.mcp.visibility,
    createsView: false,
    resultDescriptor: true as const,
    parseInput: (value: unknown) => validateLocalToolInput(binding.contract.parseInput, value),
    invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
      const result = await client.invoke(
        binding.identity as import("./local-operation.js").LocalOperationIdentity<unknown, unknown>, value, signal,
      );
      if ("status" in result) return { ok: false, failure: createInterfaceFailure("runtime_state_unavailable") };
      if (!result.ok) return result;
      const delivery = cardPresentationDeliverySchema.parse(result.value);
      return success(delivery.presentation, delivery.qr === undefined ? undefined : { [walletOperationQrMetadataKey]: delivery.qr });
    },
  }));

const cardReadMcpInputSchema = (): Tool["inputSchema"] => {
  const definitions: Record<string, unknown> = {};
  const branches = presentationContractRegistry.values().filter((entry) => entry.presentationKind === "immutable_result")
    .map((entry, index) => {
      const rebased = rebaseSchema(entry.inputJsonSchema, `presentation_read_${index}`);
      Object.assign(definitions, rebased.definitions);
      return {type: "object", properties: {capabilityId: {const: entry.contractId}, input: rebased.schema},
        required: ["capabilityId", "input"], additionalProperties: false};
    });
  return projectMcpInputSchema({oneOf: branches, ...(Object.keys(definitions).length === 0 ? {} : {$defs: definitions})});
};

const cardCreationToolDefinition = (client: LocalOperationClient,
  binding: typeof cardReadStartBinding | typeof cardDecisionStartBinding,
  presentationTool: "start_read" | "start_decision", inputSchema: Tool["inputSchema"]): McpToolDefinition => Object.freeze({
  name: parseMcpToolName(binding.mcp.name), description: binding.mcp.description,
  inputSchema,
  outputSchema: contractOutputSchema(binding.contract, binding.contract.errorRegistry),
  failureCodes: binding.contract.failureCodes,
  visibility: binding.mcp.visibility, annotations: annotations(binding.mcp.annotations),
  createsView: true, presentationTool, resultDescriptor: true,
  parseInput: (value: unknown) => binding.contract.parseInput(value),
  invoke: async (value: unknown, signal: AbortSignal, publicationKey: string | null = null): Promise<McpInvocationResult> => {
    const result = await client.invoke(binding.identity as import("./local-operation.js").LocalOperationIdentity<unknown, unknown>, {input: value, publicationKey}, signal);
    if ("status" in result) return failure();
    if (!result.ok) return result;
    const created = cardCreationResultSchema.parse(result.value);
    return success(created, { [presentationCardMetadataKey]: {kind: "card", cardId: created.cardId} });
  },
});

const walletAccountToolDefinitions = (client: LocalOperationClient): readonly McpToolDefinition[] => Object.values(walletAccountBindings).map((binding): McpToolDefinition => {
  const decision = binding === walletAccountBindings.select;
  const identity = decision ? createCardDecisionIdentity(resolveLocalOperationIdentity(walletAccountBindings.select.identity)) : binding.identity;
  const definition: McpToolDefinition = Object.freeze({
    name: parseMcpToolName(binding.mcp.name), description: binding.mcp.description,
    inputSchema: decision ? cardDecisionInputSchema(binding.contract) : contractInputSchema(binding.contract),
    outputSchema: decision ? successFailureOrDeliverySchema(zodSchema(binding.contract.successSchema, "output"), binding.contract.failureCodes,
      binding.contract.errorRegistry, selectorDeliveryUnknownSchema) : contractOutputSchema(binding.contract, binding.contract.errorRegistry),
    failureCodes: binding.contract.failureCodes, annotations: annotations(binding.mcp.annotations), visibility: binding.mcp.visibility,
    createsView: false, resultDescriptor: true as const,
    ...(decision ? {cardDecision: true as const, deliveryRecovery: {schema: selectorDeliveryUnknownSchema,
      project: (delivery: DeliveryUnknown) => captureCanonicalJson(selectorDeliveryUnknownSchema.parse(delivery))}} : {}),
    parseInput: (input: unknown) => decision ? cardDecisionInput(binding.contract, input) : binding.contract.parseInput(input),
    invoke: async (input: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
      const value = await client.invoke(identity as import("./local-operation.js").LocalOperationIdentity<unknown, unknown>, input, signal);
      return "status" in value || !value.ok ? value : decision ? cardSuccess(admitCardActionDelivery(value.value)) : success(value.value);
    },
  });
  return decision ? withCardFailures(definition) : definition;
});

const createToolDefinitions = (
  runtime: RuntimeDispatchPort,
  client: LocalOperationClient,
  presentation: McpAppPresentationService | undefined,
): readonly McpToolDefinition[] => Object.freeze([
  ...readInterfaceIdentities.map((identity) => readTool(runtime, identity, client)),
  cardCreationToolDefinition(client, cardReadStartBinding, "start_read", cardReadMcpInputSchema()),
  cardCreationToolDefinition(client, cardDecisionStartBinding, "start_decision", contractInputSchema(cardDecisionStartBinding.contract)),
  Object.freeze({ name: parseMcpToolName(uniswapV4PoolsInterface.mcp.name), description: uniswapV4PoolsInterface.mcp.description,
    inputSchema: capabilityInputSchema(uniswapV4PoolsInterface.capabilityId),
    outputSchema: capabilityOutputSchema(uniswapV4PoolsInterface.capabilityId, uniswapV4PoolsInterface.responseAuthority.applicationErrors),
    failureCodes: getCapabilityDefinitionSnapshot(uniswapV4PoolsInterface.definition).failureCodes,
    annotations: annotations(uniswapV4PoolsInterface.mcp.annotations), visibility: ["model"] as const, createsView: false,
    parseInput: (value: unknown) => parseCapabilityInput(uniswapV4PoolsInterface.definition, value),
    invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
      const result = await client.invoke(uniswapV4PoolsLocalIdentity, value, signal);
      return "status" in result || !result.ok ? result : success(result.value);
    },
  }),
  ...accountAssetInterfaceBindingList
    .filter((binding) => binding.mcp !== undefined)
    .map((binding) => accountAssetTool(client, binding)),
  Object.freeze({
    name: parseMcpToolName(capabilityCatalogInterface.mcp.name),
    description: capabilityCatalogInterface.mcp.description,
    projectSuccessText: (value: CanonicalJson) => capabilityCatalogInterface.projectSuccessText(
      value as unknown as z.infer<typeof capabilityCatalogSchema>,
    ),
    inputSchema: projectMcpInputSchema(zodSchema(z.object({}).strict(), "input")),
    outputSchema: successOrFailureSchema(
      zodSchema(capabilityCatalogSchema, "output"),
      capabilityCatalogInterface.failureCodes,
    ),
    failureCodes: capabilityCatalogInterface.failureCodes,
    annotations: annotations(capabilityCatalogInterface.mcp.annotations),
    visibility: ["model"] as const,
    createsView: false,
    parseInput: (value: unknown) => z.object({}).strict().parse(captureCanonicalJson(value)),
    invoke: async (_value: unknown, signal: AbortSignal) => {
      const result = await publicRead(
        runtime,
        capabilityCatalogInterface,
        signal,
      );
      if (!result.ok) return result;
      try { return success(capabilityCatalogSchema.parse(result.value)); }
      catch { return failure(); }
    },
  }),
  tokenCatalogReadTool(client, tokenCatalogInterfaceBindings.selection),
  tokenCatalogReadTool(client, tokenCatalogInterfaceBindings.selections),
  ...walletAccountToolDefinitions(client),
  ...operationInterfaceBindingList.map((binding) => operationTool(client, binding)),
  ...exchangeToolDefinitions(runtime, client),
  ...signingToolDefinitions(client),
  ...cardToolDefinitions(client),
  ...presentationToolDefinitions(presentation),
]);

export class McpToolRegistry {
  readonly #definitions: ReadonlyMap<McpToolName, McpToolDefinition>;

  constructor(definitionsInput: readonly McpToolDefinition[]) {
    if (!Array.isArray(definitionsInput)) throw new TypeError("MCP tool definitions are invalid.");
    const definitions = new Map<McpToolName, McpToolDefinition>();
    for (const definition of definitionsInput) {
      const name = parseMcpToolName(definition.name);
      if (definitions.has(name)) throw new TypeError("MCP tool name is duplicated.");
      definitions.set(name, definition);
    }
    const names = [...definitions.keys()].sort(compareCodePointSequences);
    if (names.join("\0") !== [...mcpToolNames].sort(compareCodePointSequences).join("\0")) {
      throw new TypeError("MCP tool registry coverage is incomplete.");
    }
    this.#definitions = definitions;
    Object.freeze(this);
  }

  get(name: unknown): McpToolDefinition {
    const definition = this.#definitions.get(parseMcpToolName(name));
    if (definition === undefined) throw new TypeError("MCP tool is undeclared.");
    return definition;
  }

  values(): readonly McpToolDefinition[] {
    return Object.freeze([...this.#definitions.values()]
      .sort((left, right) => compareCodePointSequences(left.name, right.name)));
  }
}

export const createMcpToolRegistry = (
  runtime: McpRuntimePort,
  client: LocalOperationClient,
  presentation?: McpAppPresentationService,
): McpToolRegistry => new McpToolRegistry(
  createToolDefinitions(runtime, client, presentation),
);

const canonicalToolResult = (
  value: CanonicalJson,
  isError: boolean,
  successText?: string,
): CallToolResult => ({
  ...(isError ? { isError: true } : {}),
  structuredContent: value as Record<string, unknown>,
  content: [{ type: "text", text: successText ?? canonicalJsonStringify(value) }],
});

const toolResult = (
  result: McpInvocationResult,
  projectSuccessText?: (success: CanonicalJson) => string,
): CallToolResult => {
  const deliveryUnknown = "status" in result;
  const value = deliveryUnknown
    ? result as unknown as CanonicalJson
    : result.ok
      ? result.value
      : result.failure as unknown as CanonicalJson;
  return canonicalToolResult(
    value,
    deliveryUnknown || !result.ok,
    !deliveryUnknown && result.ok && projectSuccessText !== undefined
      ? projectSuccessText(value)
      : undefined,
  );
};

const internalToolResult = (definition: McpToolDefinition): CallToolResult => toolResult(
  constrainInterfaceFailure({
    ok: false,
    failure: createInterfaceFailure("internal_error"),
  }, definition.failureCodes),
);

const constrainedToolResult = (
  definition: McpToolDefinition,
  result: McpInvocationResult,
): CallToolResult => {
  if (isDeliveryUnknown(result)) {
    try {
      const descriptor = definition.deliveryRecovery;
      if (descriptor === undefined) throw new TypeError("MCP delivery recovery is unavailable.");
      return canonicalToolResult(descriptor.project(result), true);
    } catch {
      return internalToolResult(definition);
    }
  }
  return toolResult(
    constrainInterfaceFailure(result, definition.failureCodes),
    definition.projectSuccessText,
  );
};

const attachPrivateMetadata = (
  result: CallToolResult,
  invoked: McpInvocationResult,
): CallToolResult => !isDeliveryUnknown(invoked) && invoked.ok && "privateMetadata" in invoked
  ? Object.freeze({
      ...result,
      _meta: Object.freeze({ ...result._meta, ...invoked.privateMetadata }),
    })
  : result;

const disposeCancelledPrivateMetadata = (result: CallToolResult, signal: AbortSignal): CallToolResult => {
  if (!signal.aborted || result._meta === undefined) return result;
  const metadata = { ...result._meta };
  delete metadata[signingSignatureMetadataKey];
  delete metadata[walletOperationQrMetadataKey];
  return { ...result, _meta: metadata };
};

const attachOperationToolResultDescriptor = (
  definition: McpToolDefinition,
  normalizedInput: unknown,
  result: CallToolResult,
): CallToolResult => {
  if (
    definition.resultDescriptor !== true && (definition.operationBinding === undefined ||
    definition.operationBinding.action === "review")
  ) return result;
  if (result._meta?.[operationToolResultMetadataKey] !== undefined) {
    throw new TypeError("Operation tool result descriptor metadata is duplicated.");
  }
  const descriptor = createOperationToolResultDescriptor({
    toolName: definition.name,
    normalizedInput,
    result: result.structuredContent,
    isError: result.isError === true,
  });
  return Object.freeze({
    ...result,
    _meta: Object.freeze({
      ...result._meta,
      [operationToolResultMetadataKey]: descriptor,
    }),
  });
};

const requestAbortedToolResult = (
  definition: McpToolDefinition,
  normalizedInput: unknown,
): CallToolResult => attachOperationToolResultDescriptor(
  definition,
  normalizedInput,
  constrainedToolResult(definition, {
    ok: false,
    failure: createInterfaceFailure("request_aborted"),
  }),
);

const completeMcpToolResult = (result: CallToolResult): McpToolResultDelivery =>
  admitMcpToolResultForDelivery(result);

const invokeCardActionTool = (definition: McpInvocationToolDefinition, input: unknown, signal: AbortSignal): Promise<McpToolResultDelivery> => {
  const inputEvidence = operationToolInputEvidence(input);
  let envelope: ReturnType<typeof cardActionEnvelopeSchema.parse> | undefined = cardActionEnvelopeSchema.parse(input);
  const reference = { kind: "card" as const, cardId: envelope.cardId, cardOpenRequestId: envelope.cardOpenRequestId };
  const unknownResult = definition.walletRequest === "signing"
    ? createSigningCompletion(signingResponseContext(signingDirectDecisionSchema.parse(envelope.decision).review), "delivery_unknown").outcome
    : { kind: "wallet_result", outcome: { status: "delivery_unknown" } };
  const finish = (invoked: McpInvocationResult): McpToolResultDelivery => {
    try {
      const result = disposeCancelledPrivateMetadata(attachPrivateMetadata(constrainedToolResult(definition, invoked), invoked), signal);
      const encoded = result._meta?.[cardPresentationMetadataKey] ?? serializeCardActionPresentation({ status: "unavailable", cardId: reference.cardId });
      const presentation = admitCardActionPresentation(encoded);
      const cardId = "status" in presentation ? presentation.cardId : presentation.state.reference.kind === "card" ? presentation.state.reference.cardId : undefined;
      if (cardId !== reference.cardId) throw new TypeError("Direct response belongs to another card.");
      return completeMcpToolResult({ ...result, _meta: { ...result._meta,
        [cardPresentationMetadataKey]: encoded,
        [operationToolResultMetadataKey]: createOperationToolResultDescriptorFromEvidence({ toolName: definition.name, inputEvidence,
          result: result.structuredContent, isError: result.isError === true }) } });
    } catch { return completeMcpToolResult(internalToolResult(definition)); }
  };
  let pending: Promise<McpInvocationResult>;
  try { pending = definition.invoke(input, signal); }
  catch { envelope = undefined; input = undefined; return Promise.resolve(finish(definition.walletRequest === undefined ? failure() : success(unknownResult))); }
  envelope = undefined; input = undefined;
  return pending.then(finish, () => finish(definition.walletRequest === undefined ? failure() : success(unknownResult)));
};

export const createMcpServer = (
  runtime: McpServerRuntimePort,
  client: LocalOperationClient,
  appResource: McpAppResource,
): Server => {
  const snapshotStore = runtime.presentationSnapshotStore();
  const server = new Server(mcpServerIdentity, {
    capabilities: {
      tools: {},
      resources: {},
    },
    instructions: "Read Robinhood Chain data and inspect token contracts, including scoped official-asset membership and deployment identity when established by their evidence. This does not establish token safety. Confirmation-dependent account token selection and Robinhood Wallet management changes require a direct App or interactive CLI decision. Models cannot sign or authorize transactions. A direct App or interactive CLI decision is required before requesting a transaction in the external Wallet.",
  });
  const app = createMcpAppPresentationService(server, snapshotStore, appResource, {
    async read(operationId) {
      const result = await client.invoke(liveReviewPresentationIdentity, { operationId });
      return "status" in result || !result.ok ? { status: "unavailable", reason: "runtime_unavailable" } : result.value;
    },
  });
  const registry = createMcpToolRegistry(runtime, client, app.service);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.values().flatMap((definition): Tool[] => {
      const connection = app.connection();
      if (
        connection.status === "ordinary" &&
        (definition.createsView || !definition.visibility.some((value) => value === "model"))
      ) {
        return [];
      }
      const metadata = appToolMetadata(
        connection,
        app.service.resource,
        definition.visibility,
        definition.createsView,
      );
      return [{
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        annotations: definition.annotations,
        ...(metadata === undefined ? {} : { _meta: metadata }),
      }];
    }),
  }));

  const presentationService = app.service;
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: app.connection().status === "ordinary" ? [] : [{
      uri: presentationService.resource.uri,
      name: "Little John presentation",
      title: "Little John",
      description: "Self-contained result, Review, and operation presentation.",
      mimeType: "text/html;profile=mcp-app",
      size: presentationService.resource.utf8Bytes,
      _meta: {
        ui: {
          prefersBorder: true,
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
        },
      },
    }],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: app.connection().status === "ordinary" ? [] : [{
      uriTemplate: chartAppResourceTemplate(presentationService.resource),
      name: "Little John chart", title: "Little John chart",
      description: "The packaged presentation for one exact saved Stock Token trade-history card.",
      mimeType: "text/html;profile=mcp-app",
    }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (app.connection().status === "ordinary") {
      throw new TypeError("MCP App resources are unavailable on this connection.");
    }
    if (request.params.uri.startsWith(presentationCardUriPrefix)) {
      const state = await client.invoke(cardBindings.read.identity,
        { kind: "card", cardId: cardIdFromPresentationUri(request.params.uri) });
      if ("status" in state || !state.ok) throw new TypeError("Card state is unavailable.");
      return { contents: [{ uri: request.params.uri, mimeType: "application/json",
        text: canonicalJsonStringify(captureCanonicalJson(state.value.presentation)) }] };
    }
    const chartCardId = chartCardIdFromAppResourceUri(presentationService.resource, request.params.uri);
    if (chartCardId !== undefined) {
      const state = await client.invoke(cardBindings.read.identity, {kind: "card", cardId: chartCardId});
      if ("status" in state || !state.ok) throw new TypeError("Chart card is unavailable.");
      const record = state.value.presentation.state.record;
      if (record?.kind !== "read" || record.cardId !== chartCardId || record.contractId !== stockTokenTradeHistoryInterface.capabilityId) {
        throw new TypeError("App resource does not belong to a chart card.");
      }
    }
    return { contents: [await presentationService.readResource(request.params.uri)] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const delivery = await (async (): Promise<McpToolResultDelivery> => {
    let definition: McpToolDefinition;
    try { definition = registry.get(request.params.name); }
    catch {
      return completeMcpToolResult(
        toolResult({ ok: false, failure: createInterfaceFailure("invalid_input") }),
      );
    }
    const connection = app.connection();
    if (
      connection.status === "ordinary" &&
      (definition.createsView || !definition.visibility.some((value) => value === "model"))
    ) {
      return completeMcpToolResult(constrainedToolResult(definition, {
        ok: false,
        failure: createInterfaceFailure("invalid_input"),
      }));
    }
    let input: unknown;
    try { input = definition.parseInput(request.params.arguments ?? {}); }
    catch (error) {
      return completeMcpToolResult(constrainedToolResult(definition, {
        ok: false,
        failure: createInterfaceFailure("invalid_input", [...fieldIssuesFromInputError(error)]),
      }));
    }
    if (extra.signal.aborted) {
      return completeMcpToolResult(requestAbortedToolResult(definition, input));
    }
    try {
      if (definition.deliver !== undefined) {
        const result = await definition.deliver(input, extra.signal);
        return result;
      }
      if (definition.walletRequest !== undefined || definition.operationBinding?.action === "decide" || definition.cardDecision === true) {
        const pending = invokeCardActionTool(definition, input, extra.signal);
        input = undefined;
        delete request.params.arguments;
        return pending;
      }
      const creation = definition.presentationTool === "start_read" || definition.presentationTool === "start_decision";
      const chart = definition.presentationTool === "start_read" && cardReadStartBinding.contract.parseNormalizedInput(input).capabilityId === stockTokenTradeHistoryInterface.capabilityId;
      let publicationKey: string | null = null;
      if (creation && !chart && connection.status === "app" && connection.serverAdapter === "codex_result_association") {
        try { publicationKey = await runtime.presentationPublicationKeys().derive(normalizeCodexTurnContext(request.params._meta)); }
        catch { return completeMcpToolResult(constrainedToolResult(definition, {ok: false, failure: createInterfaceFailure("invalid_input")})); }
      }
      const invoked = await definition.invoke(input, extra.signal, publicationKey);
      let canonicalResult = attachOperationToolResultDescriptor(
        definition,
        input,
        disposeCancelledPrivateMetadata(attachPrivateMetadata(
          constrainedToolResult(definition, invoked),
          invoked,
        ), extra.signal),
      );
      if (connection.status === "ordinary" && canonicalResult._meta?.[walletOperationQrMetadataKey] !== undefined) {
        const metadata = { ...canonicalResult._meta };
        delete metadata[walletOperationQrMetadataKey];
        canonicalResult = { ...canonicalResult, _meta: metadata };
      }
      if (creation) {
        if (!isDeliveryUnknown(invoked) && invoked.ok && connection.status === "app" &&
            connection.serverAdapter === "codex_result_association") {
          const admitted = cardCreationResultSchema.parse(invoked.value);
          if (admitted.disposition === "created" || (!chart && admitted.disposition === "existing")) {
            canonicalResult = {...canonicalResult, _meta: {...canonicalResult._meta,
              ui: {resourceUri: chart ? chartAppResourceUri(presentationService.resource, admitted.cardId) : presentationService.resource.uri}}};
          }
        }
        return completeMcpToolResult(withCardReference(canonicalResult));
      }
      return completeMcpToolResult(canonicalResult);
    }
    catch (error) {
      return completeMcpToolResult(attachOperationToolResultDescriptor(
        definition,
        input,
        constrainedToolResult(definition, {
          ok: false,
          failure: error instanceof CardDomainError ? error.failure : createInterfaceFailure("internal_error"),
        }),
      ));
    }
    })();
    return delivery.result;
  });
  return server;
};

export interface StdioMcpOwner {
  readonly closed: Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

type PromiseSettlement<Value> =
  | Readonly<{ readonly status: "fulfilled"; readonly value: Value }>
  | Readonly<{ readonly status: "rejected"; readonly reason: unknown }>;

const observePromise = <Value>(promise: Promise<Value>): Promise<PromiseSettlement<Value>> =>
  promise.then(
    (value) => Object.freeze({ status: "fulfilled" as const, value }),
    (reason: unknown) => Object.freeze({ status: "rejected" as const, reason }),
  );

const observeOperation = async <Value>(
  operation: () => Value | Promise<Value>,
): Promise<PromiseSettlement<Value>> => {
  try { return await observePromise(Promise.resolve(operation())); }
  catch (reason) { return Object.freeze({ status: "rejected", reason }); }
};

type McpTerminal =
  | Readonly<{ readonly status: "clean" }>
  | Readonly<{ readonly status: "failed"; readonly reason: unknown }>;

type CleanupResult =
  | Readonly<{ readonly status: "fulfilled" }>
  | Readonly<{ readonly status: "rejected"; readonly reasons: readonly unknown[] }>;

interface CleanupAttempt {
  readonly result: Promise<CleanupResult>;
  readonly publicResult: Promise<void>;
}

const rejectOrdered = (reasons: readonly unknown[], message: string): never => {
  if (reasons.length === 1) throw reasons[0];
  throw new AggregateError(reasons, message);
};

class StdioMcpLifecycle implements StdioMcpOwner {
  readonly closed: Promise<void>;

  readonly #input: Readable;
  readonly #output: Writable;
  readonly #server: Server;
  readonly #client: LocalOperationClient;
  readonly #resolveClosed: () => void;
  readonly #rejectClosed: (reason?: unknown) => void;
  readonly #closedStartError = new Error("The MCP stdio owner is already closed.");

  #terminal: McpTerminal | undefined;
  #closedSettled = false;
  #startPromise: Promise<void> | undefined;
  #activeCleanup: CleanupAttempt | undefined;
  #firstCleanup: CleanupAttempt | undefined;
  #released: Promise<void> | undefined;
  #serverOwned = true;
  #clientOwned = true;
  #inputErrorOwned = false;
  #inputEndOwned = false;
  #inputCloseOwned = false;
  #pendingServerError: Readonly<{ readonly reason: unknown }> | undefined;

  readonly #onInputError = (reason: unknown): void => {
    this.#selectTerminal(Object.freeze({ status: "failed", reason }));
  };

  readonly #onInputEnd = (): void => {
    this.#selectTerminal(Object.freeze({ status: "clean" }));
  };

  readonly #onInputClose = (): void => {
    this.#selectTerminal(Object.freeze({ status: "clean" }));
  };

  readonly #onServerError = (reason: unknown): void => {
    const pending = Object.freeze({ reason });
    this.#pendingServerError = pending;
    queueMicrotask(() => {
      if (this.#pendingServerError === pending) this.#pendingServerError = undefined;
    });
  };

  readonly #onServerClose = (): void => {
    const pending = this.#pendingServerError;
    this.#pendingServerError = undefined;
    this.#selectTerminal(pending === undefined
      ? Object.freeze({ status: "clean" })
      : Object.freeze({ status: "failed", reason: pending.reason }));
  };

  constructor(
    input: Readable,
    output: Writable,
    server: Server,
    client: LocalOperationClient,
  ) {
    this.#input = input;
    this.#output = output;
    this.#server = server;
    this.#client = client;
    let resolveClosed!: () => void;
    let rejectClosed!: (reason?: unknown) => void;
    this.closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    this.#resolveClosed = resolveClosed;
    this.#rejectClosed = rejectClosed;
    void this.closed.catch(() => undefined);
  }

  start(): Promise<void> {
    if (this.#startPromise !== undefined) return this.#startPromise;
    let resolveStart!: () => void;
    let rejectStart!: (reason?: unknown) => void;
    const starting = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    this.#startPromise = starting;
    void starting.catch(() => undefined);
    queueMicrotask(() => {
      void this.#performStart().then(resolveStart, rejectStart);
    });
    return starting;
  }

  close(): Promise<void> {
    if (this.#released !== undefined) return this.#released;
    if (this.#terminal === undefined) {
      this.#selectTerminal(Object.freeze({ status: "clean" }));
    }
    return (this.#activeCleanup ?? this.#requestCleanup()).publicResult;
  }

  async #performStart(): Promise<void> {
    if (this.#terminal !== undefined) {
      await observePromise(this.closed);
      throw this.#closedStartError;
    }
    try {
      this.#server.onerror = this.#onServerError;
      this.#server.onclose = this.#onServerClose;

      this.#inputErrorOwned = true;
      this.#input.on("error", this.#onInputError);
      if (this.#selectExistingInputTerminal()) return await this.#followSelectedTerminal();

      this.#inputEndOwned = true;
      this.#input.on("end", this.#onInputEnd);
      if (this.#selectExistingInputTerminal()) return await this.#followSelectedTerminal();

      this.#inputCloseOwned = true;
      this.#input.on("close", this.#onInputClose);
      if (this.#selectExistingInputTerminal()) return await this.#followSelectedTerminal();

      const transport = new StdioServerTransport(this.#input, this.#output);
      const connected = await observePromise(this.#server.connect(transport));
      if (this.#terminal !== undefined) return await this.#followSelectedTerminal();
      if (connected.status === "rejected") {
        this.#selectTerminal(Object.freeze({ status: "failed", reason: connected.reason }));
        return await this.#followSelectedTerminal();
      }
    } catch (reason) {
      if (this.#terminal === undefined) {
        this.#selectTerminal(Object.freeze({ status: "failed", reason }));
      }
      return await this.#followSelectedTerminal();
    }
  }

  async #followSelectedTerminal(): Promise<void> {
    const terminal = this.#terminal;
    if (terminal === undefined) throw new Error("MCP terminal state is unavailable.");
    await this.closed;
  }

  #selectExistingInputTerminal(): boolean {
    const inputError = this.#input.errored;
    if (inputError !== null) {
      this.#selectTerminal(Object.freeze({ status: "failed", reason: inputError }));
      return true;
    }
    if (this.#input.readableEnded || this.#input.closed || this.#input.destroyed) {
      this.#selectTerminal(Object.freeze({ status: "clean" }));
      return true;
    }
    return this.#terminal !== undefined;
  }

  #selectTerminal(terminal: McpTerminal): void {
    if (this.#terminal !== undefined) return;
    this.#terminal = terminal;
    const attempt = this.#requestCleanup();
    this.#firstCleanup = attempt;
  }

  #requestCleanup(): CleanupAttempt {
    if (this.#released !== undefined) {
      return Object.freeze({
        result: Promise.resolve(Object.freeze({ status: "fulfilled" as const })),
        publicResult: this.#released,
      });
    }
    if (this.#activeCleanup !== undefined) return this.#activeCleanup;

    let resolveResult!: (result: CleanupResult) => void;
    const result = new Promise<CleanupResult>((resolve) => { resolveResult = resolve; });
    const publicResult = result.then((settled) => {
      if (settled.status === "rejected") {
        rejectOrdered(settled.reasons, "MCP stdio cleanup failed.");
      }
    });
    void publicResult.catch(() => undefined);
    const attempt = Object.freeze({ result, publicResult });
    this.#activeCleanup = attempt;
    queueMicrotask(() => {
      const finish = (settled: CleanupResult): void => {
        resolveResult(settled);
        if (this.#firstCleanup === attempt) this.#settleClosed(settled);
        if (settled.status === "fulfilled") this.#released = publicResult;
        if (this.#activeCleanup === attempt) this.#activeCleanup = undefined;
      };
      void this.#performCleanup().then(
        finish,
        (reason: unknown) => finish(Object.freeze({
          status: "rejected",
          reasons: Object.freeze([reason]),
        })),
      );
    });
    return attempt;
  }

  async #performCleanup(): Promise<CleanupResult> {
    const reasons: unknown[] = [];
    this.#removeInputObserver("error", this.#onInputError, "error", reasons);
    this.#removeInputObserver("end", this.#onInputEnd, "end", reasons);
    this.#removeInputObserver("close", this.#onInputClose, "close", reasons);

    this.#pendingServerError = undefined;
    delete this.#server.onerror;
    delete this.#server.onclose;
    if (this.#serverOwned) {
      const server = await observeOperation(() => this.#server.close());
      if (server.status === "fulfilled") this.#serverOwned = false;
      else reasons.push(server.reason);
    }
    if (!this.#serverOwned && this.#clientOwned) {
      const client = await observeOperation(() => this.#client.close());
      if (client.status === "fulfilled") this.#clientOwned = false;
      else reasons.push(client.reason);
    }
    return reasons.length === 0
      ? Object.freeze({ status: "fulfilled" })
      : Object.freeze({ status: "rejected", reasons: Object.freeze(reasons) });
  }

  #removeInputObserver(
    event: "error" | "end" | "close",
    listener: Parameters<Readable["off"]>[1],
    kind: "error" | "end" | "close",
    reasons: unknown[],
  ): void {
    const owned = kind === "error"
      ? this.#inputErrorOwned
      : kind === "end"
        ? this.#inputEndOwned
        : this.#inputCloseOwned;
    if (!owned) return;
    try {
      this.#input.off(event, listener);
      if (kind === "error") this.#inputErrorOwned = false;
      else if (kind === "end") this.#inputEndOwned = false;
      else this.#inputCloseOwned = false;
    } catch (reason) {
      reasons.push(reason);
    }
  }

  #settleClosed(cleanup: CleanupResult): void {
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    const terminal = this.#terminal;
    const reasons = [
      ...(terminal?.status === "failed" ? [terminal.reason] : []),
      ...(cleanup.status === "rejected" ? cleanup.reasons : []),
    ];
    if (reasons.length === 0) this.#resolveClosed();
    else if (reasons.length === 1) this.#rejectClosed(reasons[0]);
    else this.#rejectClosed(new AggregateError(reasons, "MCP stdio lifecycle failed."));
  }
}

export const createStdioMcp = (
  runtime: McpServerRuntimePort,
  input: Readable,
  output: Writable,
  appResource: McpAppResource,
): StdioMcpOwner => {
  const client = new LocalOperationClient({ ownerSessions: runtime });
  const server = createMcpServer(runtime, client, appResource);
  return Object.freeze(new StdioMcpLifecycle(input, output, server, client));
};
