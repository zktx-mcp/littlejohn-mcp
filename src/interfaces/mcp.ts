import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type AnyAccountAssetApplicationContract,
} from "../account-assets/client.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  applicationFailureSchemaFor,
  canonicalJsonStringify,
  captureCanonicalJson,
  compareCodePointSequences,
  fieldIssuesFromInputError,
  fixedIdentifierSchema,
  parseCapabilityInput,
  parseCapabilitySuccess,
  projectZodJsonSchema,
  projectCapabilities,
  readBoundaryFailureCodes,
  type CanonicalJson,
  type CapabilityId,
  type ApplicationErrorRegistry,
} from "../core/index.js";
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
import {
  appToolMetadata,
  createMcpAppPresentationService,
  type McpAppPresentationService,
  type McpAppResource,
} from "./mcp-app/server.js";

const readMcpServerIdentity = (): Readonly<{ name: string; version: string }> => {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as unknown;
  } catch {
    throw new TypeError("The package identity is unavailable.");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new TypeError("The package identity is invalid.");
  }
  const record = manifest as Readonly<Record<string, unknown>>;
  try {
    return Object.freeze({
      name: fixedIdentifierSchema.parse(record["name"]),
      version: fixedIdentifierSchema.parse(record["version"]),
    });
  } catch {
    throw new TypeError("The package identity is invalid.");
  }
};

export const mcpServerIdentity = readMcpServerIdentity();

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

interface McpToolDefinition {
  readonly name: McpToolName;
  readonly description: string;
  readonly inputSchema: Tool["inputSchema"];
  readonly outputSchema: NonNullable<Tool["outputSchema"]>;
  readonly failureCodes: readonly string[];
  readonly annotations: ToolAnnotations;
  readonly visibility: OperationToolVisibility;
  readonly createsView: boolean;
  readonly deliveryRecovery?: McpDeliveryRecoveryDescriptor;
  readonly presentationContract?: object;
  readonly presentationTool?: "get_snapshot" | "get_snapshot_chunk";
  readonly operationBinding?: OperationInterfaceBinding;
  readonly projectSuccessText?: (success: CanonicalJson) => string;
  readonly parseInput: (value: unknown) => unknown;
  readonly invoke: (input: unknown, signal: AbortSignal) => Promise<McpInvocationResult>;
}

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
  presentationSnapshotStore(): PresentationSnapshotStore;
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
  | AnyTokenCatalogApplicationContract;

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
    delivery: deliveryUnknownSchema.extend({ action: z.literal(expectedAction) }),
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
      if (delivery.action !== expectedAction) {
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

const definePresentedTool = (
  definition: Omit<McpToolDefinition, "presentationContract">,
  contract: object | undefined,
): McpToolDefinition => contract === undefined
  ? Object.freeze(definition)
  : Object.freeze({ ...definition, presentationContract: contract });

const readTool = (
  runtime: RuntimeDispatchPort,
  identity: ReadInterfaceIdentity,
): McpToolDefinition => {
  const projection = projectedCapabilities.get(identity.capabilityId);
  if (projection === undefined) throw new TypeError("Capability projection is unavailable.");
  const presented = presentationContractRegistry.forContract(identity.definition) !== undefined;
  return definePresentedTool({
    name: parseMcpToolName(identity.mcp.name),
    description: identity.mcp.description,
    inputSchema: capabilityInputSchema(identity.capabilityId),
    outputSchema: capabilityOutputSchema(
      identity.capabilityId,
      identity.responseAuthority.applicationErrors,
    ),
    failureCodes: projection.failureCodes,
    annotations: annotations(identity.mcp.annotations),
    visibility: ["model"],
    createsView: presented,
    ...(identity.projectSuccessText === undefined
      ? {}
      : {
          projectSuccessText: (success: CanonicalJson) =>
            identity.projectSuccessText!(success as never),
        }),
    parseInput: (value: unknown) => parseCapabilityInput(identity.definition, value),
    invoke: async (value: unknown, signal: AbortSignal) => {
      const result = await publicRead(
        runtime,
        identity,
        signal,
        identity.http.method === "POST" ? captureCanonicalJson(value) : undefined,
      );
      if (!result.ok) return result;
      try { return success(parseCapabilitySuccess(identity.definition, value, result.value)); }
      catch { return failure(); }
    },
  }, presented ? identity.definition : undefined);
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
  const deliveryRecovery = createMcpDeliveryRecoveryDescriptor(binding);
  const errorRegistry = resolveLocalOperationIdentity(binding.identity).contract.errorRegistry;
  const common = {
    name: parseMcpToolName(binding.mcp.name),
    description: binding.mcp.description,
    inputSchema: contractInputSchema(binding.contract),
    failureCodes: binding.contract.failureCodes,
    annotations: annotations(binding.mcp.annotations),
    visibility: binding.mcp.visibility,
    createsView: binding.mcp.createsView,
    operationBinding: binding,
    ...(binding.action === "review" ? { presentationContract: binding.contract } : {}),
    parseInput: (value: unknown): unknown => validateLocalToolInput(binding.contract.parseInput, value),
  } as const;
  return Object.freeze({
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
      const result = await client.invoke(binding.identity, value, signal);
      return "status" in result || !result.ok ? result : success(result.value);
    },
  });
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
    createsView: true,
    parseInput: (value: unknown): unknown => validateLocalToolInput(binding.contract.parseInput, value),
    presentationContract: binding.contract,
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
): McpToolDefinition => definePresentedTool({
  name: parseMcpToolName(binding.mcp!.name),
  description: binding.mcp!.description,
  inputSchema: contractInputSchema(binding.contract),
  outputSchema: contractOutputSchema(binding.contract),
  failureCodes: binding.contract.failureCodes,
  annotations: annotations(binding.mcp!.annotations),
  visibility: ["model"],
  createsView: presentationContractRegistry.forContract(binding.contract) !== undefined,
  parseInput: (value: unknown): unknown => validateLocalToolInput(binding.contract.parseInput, value),
  invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
    const result = await client.invoke(accountAssetLocalOperationIdentities.collection, value, signal);
    return "status" in result || !result.ok ? result : success(result.value);
  },
}, presentationContractRegistry.forContract(binding.contract) === undefined
  ? undefined : binding.contract);

const presentationSnapshotInputSchema = z.object({
  snapshotUri: presentationSnapshotUriSchema,
}).strict();
const presentationSnapshotChunkInputSchema = z.object({
  snapshotId: presentationSnapshotIdSchema,
  index: z.number().int().min(0),
}).strict();

const presentationToolDefinitions = (
  presentation: McpAppPresentationService | undefined,
): readonly McpToolDefinition[] => Object.freeze([
  Object.freeze({
    name: parseMcpToolName(presentationMcpTools.getSnapshot),
    description: "Display one exact retained presentation snapshot.",
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
    createsView: true,
    presentationTool: "get_snapshot" as const,
    parseInput: (value: unknown) => presentationSnapshotInputSchema.parse(
      captureCanonicalJson(value),
    ),
    invoke: async (value: unknown): Promise<McpInvocationResult> => success(
      presentation === undefined
        ? { kind: "presentation_unavailable", status: "unavailable", reason: "runtime_unavailable" }
        : presentation.getSnapshot(
            presentationSnapshotInputSchema.parse(value).snapshotUri,
          ),
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
        : presentation.getResultChunk(input.snapshotId, input.index));
    },
  }),
]);

const createToolDefinitions = (
  runtime: RuntimeDispatchPort,
  client: LocalOperationClient,
  presentation: McpAppPresentationService | undefined,
): readonly McpToolDefinition[] => Object.freeze([
  ...readInterfaceIdentities.map((identity) => readTool(runtime, identity)),
  ...accountAssetInterfaceBindingList
    .filter((binding) => binding.mcp !== undefined)
    .map((binding) => accountAssetTool(client, binding)),
  Object.freeze({
    name: parseMcpToolName(capabilityCatalogInterface.mcp.name),
    description: capabilityCatalogInterface.mcp.description,
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
  ...operationInterfaceBindingList.map((binding) => operationTool(client, binding)),
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

const attachOperationToolResultDescriptor = (
  definition: McpToolDefinition,
  normalizedInput: unknown,
  result: CallToolResult,
): CallToolResult => {
  if (
    definition.operationBinding === undefined ||
    definition.operationBinding.action === "review"
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
    instructions: "Read Robinhood Chain data and inspect token contracts, including scoped official-asset membership and deployment identity when established by their evidence. This does not establish token safety. Confirmation-dependent account token selection and Robinhood Wallet management changes require a direct App or interactive CLI decision. This server provides no signing or transaction authority.",
  });
  const app = createMcpAppPresentationService(server, snapshotStore, appResource);
  const registry = createMcpToolRegistry(runtime, client, app.service);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.values().flatMap((definition): Tool[] => {
      const connection = app.connection();
      if (
        connection.status === "ordinary" &&
        (definition.presentationTool !== undefined || definition.operationBinding !== undefined)
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
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (app.connection().status === "ordinary") {
      throw new TypeError("MCP App resources are unavailable on this connection.");
    }
    return { contents: [presentationService.readResource(request.params.uri)] };
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
      (definition.presentationTool !== undefined || definition.operationBinding !== undefined)
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
      const invoked = await definition.invoke(input, extra.signal);
      if (extra.signal.aborted) {
        return completeMcpToolResult(requestAbortedToolResult(definition, input));
      }
      if (
        definition.presentationTool === "get_snapshot" &&
        !isDeliveryUnknown(invoked) && invoked.ok
      ) {
        return completeMcpToolResult(presentationService.getSnapshotResult(
          presentationSnapshotInputSchema.parse(input).snapshotUri,
        ));
      }
      const canonicalResult = attachOperationToolResultDescriptor(
        definition,
        input,
        attachPrivateMetadata(
          constrainedToolResult(definition, invoked),
          invoked,
        ),
      );
      if (
        connection.status === "app" &&
        definition.presentationContract !== undefined &&
        !isDeliveryUnknown(invoked) && invoked.ok
      ) {
        const handoff = presentationService.present(
          definition.presentationContract,
          input,
          canonicalResult,
        );
        if (handoff.status === "available" || handoff.status === "delivery_error") {
          return handoff.delivery;
        }
        return completeMcpToolResult(attachOperationToolResultDescriptor(
          definition,
          input,
          constrainedToolResult(definition, {
            ok: false,
            failure: createInterfaceFailure("internal_error"),
          }),
        ));
      }
      return completeMcpToolResult(canonicalResult);
    }
    catch {
      return completeMcpToolResult(attachOperationToolResultDescriptor(
        definition,
        input,
        constrainedToolResult(definition, {
          ok: false,
          failure: createInterfaceFailure("internal_error"),
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
