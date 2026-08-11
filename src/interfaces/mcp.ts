import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type AnyAccountAssetApplicationContract,
} from "../account-assets/index.js";
import {
  referenceMarketApplicationContracts,
  referenceMarketErrorRegistry,
  type AnyReferenceMarketApplicationContract,
} from "../market-portfolio/index.js";
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
  fixedIdentifierSchema,
  parseCapabilityInput,
  parseCapabilitySuccess,
  projectCapabilities,
  readBoundaryFailureCodes,
  type CanonicalJson,
  type CapabilityId,
  type ApplicationErrorRegistry,
} from "../core/index.js";
import { fixedOrigin } from "../runtime/http-boundary.js";
import { createOperationId } from "../runtime/operation-id.js";
import type { RuntimeOwnerSessionPort } from "../runtime/owner-session.js";
import type { PresentationSnapshotStore } from "../runtime/presentation-snapshot.js";
import {
  tokenCatalogErrorRegistry,
  type AnyTokenCatalogApplicationContract,
} from "../token-catalog/index.js";
import type {
  AnyWalletManagementContract,
} from "../wallet/contracts.js";
import {
  browserLocationHref,
  browserLocations,
} from "./browser-contract.js";
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
  referenceMarketInterfaceBindingList,
  tokenMcpLocalOperationCatalog,
  tokenCatalogInterfaceBindings,
  tokenLocalOperationIdentities,
  walletMcpLocalOperationCatalog,
  readLocalOperationDeliveryAction,
  type TokenCatalogInterfaceBinding,
  type AccountAssetInterfaceBinding,
  type LocalOperationInterfaceCatalogEntry,
  type WalletInterfaceBinding,
  type InterfaceToolAnnotations,
  type ReadInterfaceIdentity,
  type ReferenceMarketInterfaceBinding,
} from "./identities.js";
import { LocalOperationClient } from "./operation-client.js";
import {
  deliveryUnknownSchema,
  isDeliveryUnknown,
  type DeliveryUnknown,
} from "./operation-delivery.js";
import { interfaceCapabilityCatalogSchema } from "./support.js";
import { LocalMutationClient } from "./reference-market-local-client.js";
import { dispatchReferenceMarketRead } from "./reference-market-http.js";
import {
  referenceMarketDeliveryUnknownSchema,
  type ReferenceMarketDeliveryUnknown,
} from "./reference-market-delivery.js";
import {
  presentationMcpTools,
  presentationSnapshotChunkSchema,
  presentationSnapshotIdSchema,
  presentationSnapshotReferenceSchema,
  presentationSnapshotUriSchema,
  presentationUnavailableSchema,
} from "./mcp-app/contracts.js";
import { presentationContractRegistry } from "./mcp-app/registry.js";
import {
  appToolMetadata,
  createMcpAppPresentationService,
  loadMcpAppResource,
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
  readonly deliveryRecovery?: McpDeliveryRecoveryDescriptor;
  readonly presentationContract?: object;
  readonly presentationTool?: "get_snapshot" | "get_snapshot_chunk";
  readonly parseInput: (value: unknown) => unknown;
  readonly invoke: (input: unknown, signal: AbortSignal) => Promise<McpInvocationResult>;
}

type McpInvocationResult = InterfaceInvocationResult | DeliveryUnknown | ReferenceMarketDeliveryUnknown;

interface McpDeliveryRecoveryDescriptor {
  readonly schema: z.ZodType;
  project(delivery: DeliveryUnknown): CanonicalJson;
}

export interface McpRuntimePort extends RuntimeDispatchPort, RuntimeOwnerSessionPort {
  presentationSnapshotStore?(): PresentationSnapshotStore;
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
): Readonly<Record<string, unknown>> => z.toJSONSchema(schema, {
  target: "draft-2020-12",
  io,
  unrepresentable: "throw",
}) as Readonly<Record<string, unknown>>;

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
  return canonicalSchema<Tool["inputSchema"]>(projection.input.schema);
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
  | AnyReferenceMarketApplicationContract
  | AnyWalletManagementContract
  | AnyTokenCatalogApplicationContract;

const contractInputSchema = (
  contract: InterfaceApplicationContract,
): Tool["inputSchema"] =>
  canonicalSchema<Tool["inputSchema"]>(zodSchema(contract.inputSchema, "input"));

const contractOutputSchema = (
  contract: InterfaceApplicationContract,
  errorRegistry: ApplicationErrorRegistry = tokenCatalogErrorRegistry,
): NonNullable<Tool["outputSchema"]> =>
  successOrFailureSchema(zodSchema(contract.successSchema, "output"), contract.failureCodes, errorRegistry);

const assetsDisplayUrl = `${fixedOrigin}${
  browserLocationHref(browserLocations.assets())
}`;
const walletDisplayUrl = assetsDisplayUrl;
const tokenCatalogDisplayUrl = assetsDisplayUrl;

const startOutputSchema = (
  contract: InterfaceApplicationContract,
  displayUrl: string,
  deliverySchema: z.ZodType = deliveryUnknownSchema,
): NonNullable<Tool["outputSchema"]> =>
  successFailureOrDeliverySchema(zodSchema(z.object({
    result: contract.successSchema,
    displayUrl: z.literal(displayUrl),
  }).strict(), "output"), contract.failureCodes, tokenCatalogErrorRegistry, deliverySchema);

const deliveryActionFor = (
  source: LocalOperationInterfaceCatalogEntry,
): DeliveryUnknown["action"] => readLocalOperationDeliveryAction(source.identity);

const recoveryOperationId = (value: unknown): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)["operationId"]
    : undefined;

const createMcpDeliveryRecoveryDescriptor = <Binding extends
  WalletInterfaceBinding | TokenCatalogInterfaceBinding>(
  source: LocalOperationInterfaceCatalogEntry<Binding>,
): McpDeliveryRecoveryDescriptor | undefined => {
  const relation = source.deliveryRecovery;
  if (relation === undefined) return undefined;
  const target = relation.target;
  if (target.binding.action !== "get_operation" || target.binding.mcp === undefined) {
    throw new TypeError("MCP delivery recovery target is invalid.");
  }
  const expectedAction = deliveryActionFor(source);
  const targetTool = parseMcpToolName(target.binding.mcp.name);
  const schema = z.object({
    delivery: deliveryUnknownSchema.extend({ action: z.literal(expectedAction) }),
    recovery: z.object({
      tool: z.literal(targetTool),
      arguments: target.binding.contract.inputSchema,
    }).strict(),
  }).strict().superRefine((value, context) => {
    if (recoveryOperationId(value.recovery.arguments) !== value.delivery.operationId) {
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
      if (delivery.action !== deliveryActionFor(source)) {
        throw new TypeError("MCP delivery action does not match its source identity.");
      }
      const targetInput = target.binding.contract.parseInput({ operationId: delivery.operationId });
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
const success = (value: unknown): InterfaceInvocationResult => ({
  ok: true,
  value: captureCanonicalJson(value),
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

const readTool = (
  runtime: RuntimeDispatchPort,
  identity: ReadInterfaceIdentity,
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
    ...(presentationContractRegistry.forContract(identity.definition) === undefined
      ? {}
      : { presentationContract: identity.definition }),
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
  });
};

const validateLocalToolInput = (
  parseInput: (value: unknown) => unknown,
  value: unknown,
): CanonicalJson => {
  parseInput(value);
  return captureCanonicalJson(value);
};

const walletTool = (
  client: LocalOperationClient,
  entry: LocalOperationInterfaceCatalogEntry<WalletInterfaceBinding>,
): McpToolDefinition => {
  const binding = entry.binding;
  if (binding.mcp === undefined) throw new TypeError("Wallet MCP binding is unavailable.");
  const deliveryRecovery = createMcpDeliveryRecoveryDescriptor(entry);
  const common = {
    name: parseMcpToolName(binding.mcp.name),
    description: binding.mcp.description,
    inputSchema: contractInputSchema(binding.contract),
    failureCodes: binding.contract.failureCodes,
    annotations: annotations(binding.mcp.annotations),
    parseInput: (value: unknown): unknown => validateLocalToolInput(binding.contract.parseInput, value),
  } as const;
  if (binding.action === "start") {
    if (deliveryRecovery === undefined) throw new TypeError("Wallet start recovery is unavailable.");
    return Object.freeze({
      ...common,
      deliveryRecovery,
      outputSchema: startOutputSchema(binding.contract, walletDisplayUrl, deliveryRecovery.schema),
      invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
        const result = await client.invoke(entry.identity, value, signal);
        if ("status" in result || !result.ok) return result;
        return success({
          result: result.value,
          displayUrl: walletDisplayUrl,
        });
      },
    });
  }
  if (binding.action === "get_operation" || binding.action === "cancel_operation") {
    if (binding.action === "cancel_operation" && deliveryRecovery === undefined) {
      throw new TypeError("Wallet cancellation recovery is unavailable.");
    }
    return Object.freeze({
      ...common,
      ...(deliveryRecovery === undefined ? {} : { deliveryRecovery }),
      outputSchema: binding.action === "cancel_operation"
        ? successFailureOrDeliverySchema(
          zodSchema(binding.contract.successSchema, "output"),
          binding.contract.failureCodes,
          tokenCatalogErrorRegistry,
          deliveryRecovery!.schema,
        )
        : contractOutputSchema(binding.contract),
      invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
        const result = await client.invoke(entry.identity, value, signal);
        if ("status" in result || !result.ok) return result;
        return success(result.value);
      },
    });
  }
  throw new TypeError("Wallet MCP binding action is unsupported.");
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
    parseInput: (value: unknown): unknown => validateLocalToolInput(binding.contract.parseInput, value),
    presentationContract: binding.contract,
  } as const;
  if (binding.action === "get") {
    return Object.freeze({
      ...common,
      outputSchema: contractOutputSchema(binding.contract),
      invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
        const result = await client.invoke(
          tokenLocalOperationIdentities.shared.selection,
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
          tokenLocalOperationIdentities.shared.selections,
          value,
          signal,
        );
        return "status" in result || !result.ok ? result : success(result.value);
      },
    });
  }
  throw new TypeError("Token catalog read MCP binding action is unsupported.");
};

const tokenCatalogOperationTool = (
  client: LocalOperationClient,
  entry: LocalOperationInterfaceCatalogEntry<TokenCatalogInterfaceBinding>,
): McpToolDefinition => {
  const binding = entry.binding;
  const deliveryRecovery = createMcpDeliveryRecoveryDescriptor(entry);
  const common = {
    name: parseMcpToolName(binding.mcp.name),
    description: binding.mcp.description,
    inputSchema: contractInputSchema(binding.contract),
    failureCodes: binding.contract.failureCodes,
    annotations: annotations(binding.mcp.annotations),
    parseInput: (value: unknown): unknown => validateLocalToolInput(binding.contract.parseInput, value),
  } as const;
  if (binding.action === "start") {
    if (deliveryRecovery === undefined) throw new TypeError("Token start recovery is unavailable.");
    return Object.freeze({
      ...common,
      deliveryRecovery,
      outputSchema: startOutputSchema(
        binding.contract,
        tokenCatalogDisplayUrl,
        deliveryRecovery.schema,
      ),
      invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
        const result = await client.invoke(entry.identity, value, signal);
        if ("status" in result || !result.ok) return result;
        return success({
          result: result.value,
          displayUrl: tokenCatalogDisplayUrl,
        });
      },
    });
  }
  if (binding.action === "get_operation" || binding.action === "cancel_operation") {
    if (binding.action === "cancel_operation" && deliveryRecovery === undefined) {
      throw new TypeError("Token cancellation recovery is unavailable.");
    }
    return Object.freeze({
      ...common,
      ...(deliveryRecovery === undefined ? {} : { deliveryRecovery }),
      outputSchema: binding.action === "cancel_operation"
        ? successFailureOrDeliverySchema(
          zodSchema(binding.contract.successSchema, "output"),
          binding.contract.failureCodes,
          tokenCatalogErrorRegistry,
          deliveryRecovery!.schema,
        )
        : contractOutputSchema(binding.contract),
      invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
        const result = await client.invoke(entry.identity, value, signal);
        return "status" in result || !result.ok ? result : success(result.value);
      },
    });
  }
  throw new TypeError("Token catalog operation MCP binding action is unsupported.");
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
  ...(presentationContractRegistry.forContract(binding.contract) === undefined
    ? {}
    : { presentationContract: binding.contract }),
  parseInput: (value: unknown): unknown => validateLocalToolInput(binding.contract.parseInput, value),
  invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
    const result = await client.invoke(accountAssetLocalOperationIdentities.collection, value, signal);
    return "status" in result || !result.ok ? result : success(result.value);
  },
});

const referenceMarketTool = (
  runtime: RuntimeDispatchPort,
  mutationClient: LocalMutationClient,
  binding: ReferenceMarketInterfaceBinding,
): McpToolDefinition => {
  const mutation = binding.action === "add" || binding.action === "remove" || binding.action === "reorder";
  return Object.freeze({
    name: parseMcpToolName(binding.mcp.name),
    description: binding.mcp.description,
    inputSchema: contractInputSchema(binding.contract),
    outputSchema: mutation
      ? successFailureOrDeliverySchema(
        zodSchema(binding.contract.successSchema, "output"),
        binding.contract.failureCodes,
        referenceMarketErrorRegistry,
        referenceMarketDeliveryUnknownSchema,
      )
      : contractOutputSchema(binding.contract, referenceMarketErrorRegistry),
    failureCodes: binding.contract.failureCodes,
    annotations: annotations(binding.mcp.annotations),
    ...(presentationContractRegistry.forContract(binding.contract) === undefined
      ? {}
      : { presentationContract: binding.contract }),
    parseInput: (value: unknown): unknown => validateLocalToolInput(binding.contract.parseInput, value),
    invoke: async (value: unknown, signal: AbortSignal): Promise<McpInvocationResult> => {
      const result = binding.action === "price"
        ? await dispatchReferenceMarketRead(runtime, binding, value, signal)
        : binding.action === "history"
          ? await dispatchReferenceMarketRead(runtime, binding, value, signal)
          : binding.action === "watchlist"
            ? await dispatchReferenceMarketRead(runtime, binding, value, signal)
            : binding.action === "add"
              ? await mutationClient.add(referenceMarketApplicationContracts.add.parseInput(value), signal)
              : binding.action === "remove"
                ? await mutationClient.remove(referenceMarketApplicationContracts.remove.parseInput(value), signal)
                : await mutationClient.reorder(referenceMarketApplicationContracts.reorder.parseInput(value), signal);
      return "status" in result || !result.ok ? result : success(result.value);
    },
  });
};

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
    inputSchema: canonicalSchema<Tool["inputSchema"]>(
      zodSchema(presentationSnapshotInputSchema, "input"),
    ),
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
    inputSchema: canonicalSchema<Tool["inputSchema"]>(
      zodSchema(presentationSnapshotChunkInputSchema, "input"),
    ),
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
  mutationClient: LocalMutationClient,
  presentation: McpAppPresentationService | undefined,
): readonly McpToolDefinition[] => Object.freeze([
  ...readInterfaceIdentities.map((identity) => readTool(runtime, identity)),
  ...accountAssetInterfaceBindingList
    .filter((binding) => binding.mcp !== undefined)
    .map((binding) => accountAssetTool(client, binding)),
  ...referenceMarketInterfaceBindingList.map((binding) =>
    referenceMarketTool(runtime, mutationClient, binding)),
  Object.freeze({
    name: parseMcpToolName(capabilityCatalogInterface.mcp.name),
    description: capabilityCatalogInterface.mcp.description,
    inputSchema: canonicalSchema<Tool["inputSchema"]>(zodSchema(z.object({}).strict(), "input")),
    outputSchema: successOrFailureSchema(
      zodSchema(capabilityCatalogSchema, "output"),
      capabilityCatalogInterface.failureCodes,
    ),
    failureCodes: capabilityCatalogInterface.failureCodes,
    annotations: annotations(capabilityCatalogInterface.mcp.annotations),
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
  ...Object.values(walletMcpLocalOperationCatalog).map((entry) => walletTool(client, entry)),
  tokenCatalogReadTool(client, tokenCatalogInterfaceBindings.selection),
  tokenCatalogReadTool(client, tokenCatalogInterfaceBindings.selections),
  ...Object.values(tokenMcpLocalOperationCatalog)
    .map((entry) => tokenCatalogOperationTool(client, entry)),
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
  mutationClient = new LocalMutationClient(runtime),
  presentation?: McpAppPresentationService,
): McpToolRegistry => new McpToolRegistry(
  createToolDefinitions(runtime, client, mutationClient, presentation),
);

const canonicalToolResult = (value: CanonicalJson, isError: boolean): CallToolResult => ({
  ...(isError ? { isError: true } : {}),
  structuredContent: value as Record<string, unknown>,
  content: [{ type: "text", text: canonicalJsonStringify(value) }],
});

const toolResult = (result: McpInvocationResult): CallToolResult => {
  const deliveryUnknown = "status" in result;
  const value = deliveryUnknown
    ? result as unknown as CanonicalJson
    : result.ok
      ? result.value
      : result.failure as unknown as CanonicalJson;
  return canonicalToolResult(value, deliveryUnknown || !result.ok);
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
  if ("status" in result) {
    if (!referenceMarketDeliveryUnknownSchema.safeParse(result).success) {
      return internalToolResult(definition);
    }
    return toolResult(result);
  }
  return toolResult(constrainInterfaceFailure(result, definition.failureCodes));
};

export const createMcpServer = (
  runtime: McpRuntimePort,
  client = new LocalOperationClient({ ownerSessions: runtime, createOperationId }),
  mutationClient = new LocalMutationClient(runtime),
  appResource?: McpAppResource,
): Server => {
  const snapshotStore = appResource === undefined
    ? undefined
    : runtime.presentationSnapshotStore?.();
  const server = new Server(mcpServerIdentity, {
    capabilities: {
      tools: {},
      ...(snapshotStore === undefined ? {} : { resources: {} }),
    },
    instructions: "Read Robinhood Chain data, inspect token contracts, and manage account token selections and Robinhood Wallet operations without establishing token safety or official status and without signing or transaction authority.",
  });
  const app = createMcpAppPresentationService(server, snapshotStore, appResource);
  const registry = createMcpToolRegistry(runtime, client, mutationClient, app.service);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.values().flatMap((definition): Tool[] => {
      const connection = app.connection();
      if (definition.presentationTool !== undefined && connection.status === "ordinary") {
        return [];
      }
      const createsView = definition.presentationContract !== undefined ||
        definition.presentationTool === "get_snapshot";
      const visibility = definition.presentationTool === "get_snapshot_chunk"
        ? ["app"] as const
        : ["model"] as const;
      const metadata = (createsView || definition.presentationTool !== undefined) &&
        app.service !== undefined
        ? appToolMetadata(connection, app.service.resource, visibility, createsView)
        : undefined;
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
  if (presentationService !== undefined) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: app.connection().status === "ordinary" ? [] : [{
        uri: presentationService.resource.uri,
        name: "Little John immutable read view",
        title: "Little John",
        description: "Self-contained immutable read presentation.",
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
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let definition: McpToolDefinition;
    try { definition = registry.get(request.params.name); }
    catch {
      return toolResult({ ok: false, failure: createInterfaceFailure("invalid_input") });
    }
    const connection = app.connection();
    if (definition.presentationTool !== undefined && connection.status === "ordinary") {
      return constrainedToolResult(definition, {
        ok: false,
        failure: createInterfaceFailure("invalid_input"),
      });
    }
    let input: unknown;
    try { input = definition.parseInput(request.params.arguments ?? {}); }
    catch {
      return constrainedToolResult(definition, {
        ok: false,
        failure: createInterfaceFailure("invalid_input"),
      });
    }
    if (extra.signal.aborted) {
      return constrainedToolResult(definition, {
        ok: false,
        failure: createInterfaceFailure("request_aborted"),
      });
    }
    try {
      const invoked = await definition.invoke(input, extra.signal);
      if (
        definition.presentationTool === "get_snapshot" && presentationService !== undefined &&
        !("status" in invoked) && invoked.ok
      ) {
        return presentationService.getSnapshotResult(
          presentationSnapshotInputSchema.parse(input).snapshotUri,
        );
      }
      const ordinaryResult = constrainedToolResult(definition, invoked);
      if (
        connection.status === "app" && presentationService !== undefined &&
        definition.presentationContract !== undefined &&
        !("status" in invoked) && invoked.ok
      ) {
        try {
          return presentationService.present(
            definition.presentationContract,
            input,
            invoked.value,
            ordinaryResult,
          );
        } catch { return ordinaryResult; }
      }
      return ordinaryResult;
    }
    catch {
      return constrainedToolResult(definition, {
        ok: false,
        failure: createInterfaceFailure("internal_error"),
      });
    }
  });
  server.onclose = () => { void Promise.allSettled([client.close(), mutationClient.close()]); };
  return server;
};

export interface StdioMcpHandle {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export const startStdioMcp = async (
  runtime: McpRuntimePort,
  input: Readable,
  output: Writable,
): Promise<StdioMcpHandle> => {
  const client = new LocalOperationClient({ ownerSessions: runtime, createOperationId });
  const mutationClient = new LocalMutationClient(runtime);
  const server = createMcpServer(runtime, client, mutationClient, loadMcpAppResource());
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  server.onclose = () => { void Promise.allSettled([client.close(), mutationClient.close()]).finally(resolveClosed); };
  await server.connect(new StdioServerTransport(input, output));
  return Object.freeze({
    closed,
    close: async (): Promise<void> => {
      const results = await Promise.allSettled([server.close(), client.close(), mutationClient.close()]);
      resolveClosed();
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "MCP server and operation client cleanup failed.");
    },
  });
};
