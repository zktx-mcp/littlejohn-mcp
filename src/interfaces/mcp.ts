import { readFileSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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
  readCapabilityRegistry,
  type CanonicalJson,
  type CapabilityId,
} from "../core/index.js";
import { chainErrorRegistry } from "../chain/errors.js";
import { capabilityCatalogSchema, fixedOrigin } from "../runtime/index.js";
import {
  parseWalletOperationResponse,
  parseWalletOperationStartResponse,
  type AnyWalletManagementContract,
} from "../wallet/contracts.js";
import { browserPagePaths } from "./browser-contract.js";
import {
  createInterfaceFailure,
  constrainInterfaceFailure,
  dispatchCanonical,
  type InterfaceInvocationResult,
  type RuntimeDispatchPort,
} from "./http-client.js";
import {
  capabilityCatalogInterface,
  declaredMcpToolNames,
  readInterfaceIdentities,
  walletInterfaceBindingList,
  type WalletInterfaceBinding,
  type InterfaceToolAnnotations,
  type ReadInterfaceIdentity,
} from "./identities.js";

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
  readonly parseInput: (value: unknown) => unknown;
  readonly invoke: (input: unknown, signal: AbortSignal) => Promise<InterfaceInvocationResult>;
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
  projectCapabilities(readCapabilityRegistry).map((projection) => [
    projection.capabilityId,
    projection,
  ]),
);

const capabilityInputSchema = (capabilityId: CapabilityId): Tool["inputSchema"] => {
  const projection = projectedCapabilities.get(capabilityId);
  if (projection === undefined) throw new TypeError("Capability input schema is unavailable.");
  return canonicalSchema<Tool["inputSchema"]>(projection.input.schema);
};

const successOrFailureSchema = (
  successSchema: unknown,
  failureCodes: readonly string[],
): NonNullable<Tool["outputSchema"]> => {
  const success = rebaseSchema(successSchema, "success");
  const failure = rebaseSchema(
    zodSchema(applicationFailureSchemaFor(chainErrorRegistry, failureCodes), "output"),
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

const capabilityOutputSchema = (
  capabilityId: CapabilityId,
): NonNullable<Tool["outputSchema"]> => {
  const projection = projectedCapabilities.get(capabilityId);
  if (projection === undefined) throw new TypeError("Capability output schema is unavailable.");
  return successOrFailureSchema(projection.success.schema, projection.failureCodes);
};

const contractInputSchema = (
  contract: AnyWalletManagementContract,
): Tool["inputSchema"] =>
  canonicalSchema<Tool["inputSchema"]>(zodSchema(contract.inputSchema, "input"));

const contractOutputSchema = (
  contract: AnyWalletManagementContract,
): NonNullable<Tool["outputSchema"]> =>
  successOrFailureSchema(zodSchema(contract.successSchema, "output"), contract.failureCodes);

const walletDisplayUrl = `${fixedOrigin}${browserPagePaths.root}`;

const startOutputSchema = (
  contract: AnyWalletManagementContract,
): NonNullable<Tool["outputSchema"]> =>
  successOrFailureSchema(zodSchema(z.object({
    result: contract.successSchema,
    displayUrl: z.literal(walletDisplayUrl),
  }).strict(), "output"), contract.failureCodes);

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
  method: "GET" | "POST",
  path: string,
  signal: AbortSignal,
  body?: CanonicalJson,
): Promise<InterfaceInvocationResult> => dispatchCanonical(runtime, {
  requestClass: "public_read",
  method,
  path,
  signal,
  ...(body === undefined ? {} : { body }),
}, 200);

const localControl = (
  runtime: RuntimeDispatchPort,
  method: "GET" | "POST" | "DELETE",
  path: string,
  expectedStatus: 200 | 201,
  signal: AbortSignal,
  body?: CanonicalJson,
): Promise<InterfaceInvocationResult> => dispatchCanonical(runtime, {
  requestClass: "local_control",
  method,
  path,
  signal,
  ...(body === undefined ? {} : { body }),
}, expectedStatus);

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
    outputSchema: capabilityOutputSchema(identity.capabilityId),
    failureCodes: projection.failureCodes,
    annotations: annotations(identity.mcp.annotations),
    parseInput: (value: unknown) => parseCapabilityInput(identity.definition, value),
    invoke: async (value: unknown, signal: AbortSignal) => {
      const result = await publicRead(
        runtime,
        identity.http.method,
        identity.http.path,
        signal,
        identity.http.method === "POST" ? captureCanonicalJson(value) : undefined,
      );
      if (!result.ok) return result;
      try { return success(parseCapabilitySuccess(identity.definition, result.value)); }
      catch { return failure(); }
    },
  });
};

const fixedWalletPath = (binding: WalletInterfaceBinding): string => {
  if (binding.control === undefined || typeof binding.control.path !== "string") {
    throw new TypeError("Wallet start route identity is invalid.");
  }
  return binding.control.path;
};

const operationWalletPath = (
  binding: WalletInterfaceBinding,
  operationId: string,
): string => {
  if (binding.control === undefined || typeof binding.control.path !== "function") {
    throw new TypeError("Wallet operation route identity is invalid.");
  }
  return binding.control.path(operationId);
};

const operationValue = (
  contract: AnyWalletManagementContract,
  input: unknown,
  result: InterfaceInvocationResult,
): InterfaceInvocationResult => {
  if (!result.ok) return result;
  try {
    const response = parseWalletOperationResponse(result.value);
    if (response.qr !== undefined) throw new TypeError("MCP cannot receive QR material.");
    return success(contract.parseSuccess(input, response.operation));
  } catch { return failure(); }
};

const startOperationValue = (
  contract: AnyWalletManagementContract,
  input: unknown,
  result: InterfaceInvocationResult,
): InterfaceInvocationResult => {
  if (!result.ok) return result;
  try {
    const response = parseWalletOperationStartResponse(result.value);
    if (response.qr !== undefined) throw new TypeError("MCP cannot receive QR material.");
    return success({
      result: contract.parseSuccess(input, response.result),
      displayUrl: walletDisplayUrl,
    });
  } catch { return failure(); }
};

const parsedOperationId = (value: unknown): string => {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof (value as Readonly<Record<string, unknown>>)["operationId"] !== "string") {
    throw new TypeError("Wallet operation identifier is unavailable.");
  }
  return (value as Readonly<Record<string, string>>)["operationId"] as string;
};

const walletTool = (
  runtime: RuntimeDispatchPort,
  binding: WalletInterfaceBinding,
): McpToolDefinition => {
  if (binding.mcp === undefined) throw new TypeError("Wallet MCP binding is unavailable.");
  const common = {
    name: parseMcpToolName(binding.mcp.name),
    description: binding.mcp.description,
    inputSchema: contractInputSchema(binding.contract),
    failureCodes: binding.contract.failureCodes,
    annotations: annotations(binding.mcp.annotations),
    parseInput: (value: unknown): unknown => binding.contract.parseInput(value),
  } as const;
  if (binding.action === "start") {
    if (binding.operationKind === undefined || binding.control?.method !== "POST") {
      throw new TypeError("Wallet start binding is incomplete.");
    }
    const operationKind = binding.operationKind;
    return Object.freeze({
      ...common,
      outputSchema: startOutputSchema(binding.contract),
      invoke: async (value: unknown, signal: AbortSignal): Promise<InterfaceInvocationResult> =>
        startOperationValue(binding.contract, value, await localControl(
          runtime,
          "POST",
          fixedWalletPath(binding),
          200,
          signal,
          {
            kind: operationKind,
            interactionInterface: "web" as const,
            connectionRevision: null,
          },
        )),
    });
  }
  if (binding.action === "get_operation" || binding.action === "cancel_operation") {
    const method = binding.action === "get_operation" ? "GET" : "DELETE";
    if (binding.control?.method !== method) throw new TypeError("Wallet operation binding is incomplete.");
    return Object.freeze({
      ...common,
      outputSchema: contractOutputSchema(binding.contract),
      invoke: async (value: unknown, signal: AbortSignal): Promise<InterfaceInvocationResult> =>
        operationValue(binding.contract, value, await localControl(
          runtime,
          method,
          operationWalletPath(binding, parsedOperationId(value)),
          200,
          signal,
        )),
    });
  }
  throw new TypeError("Wallet MCP binding action is unsupported.");
};

const createToolDefinitions = (runtime: RuntimeDispatchPort): readonly McpToolDefinition[] => Object.freeze([
  ...readInterfaceIdentities.map((identity) => readTool(runtime, identity)),
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
        capabilityCatalogInterface.http.method,
        capabilityCatalogInterface.http.path,
        signal,
      );
      if (!result.ok) return result;
      try { return success(capabilityCatalogSchema.parse(result.value)); }
      catch { return failure(); }
    },
  }),
  ...walletInterfaceBindingList
    .filter((binding) => binding.mcp !== undefined)
    .map((binding) => walletTool(runtime, binding)),
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

const toolResult = (result: InterfaceInvocationResult): CallToolResult => {
  const value = result.ok ? result.value : result.failure as unknown as CanonicalJson;
  return {
    ...(result.ok ? {} : { isError: true }),
    structuredContent: value as Record<string, unknown>,
    content: [{ type: "text", text: canonicalJsonStringify(value) }],
  };
};

const constrainedToolResult = (
  definition: McpToolDefinition,
  result: InterfaceInvocationResult,
): CallToolResult => toolResult(constrainInterfaceFailure(result, definition.failureCodes));

export const createMcpServer = (runtime: RuntimeDispatchPort): Server => {
  const registry = new McpToolRegistry(createToolDefinitions(runtime));
  const server = new Server(mcpServerIdentity, {
    capabilities: { tools: {} },
    instructions: "Read Robinhood Chain data and manage local Robinhood Wallet connection operations without signing or transaction authority.",
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.values().map((definition): Tool => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      annotations: definition.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let definition: McpToolDefinition;
    try { definition = registry.get(request.params.name); }
    catch {
      return toolResult({ ok: false, failure: createInterfaceFailure("invalid_input") });
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
    try { return constrainedToolResult(definition, await definition.invoke(input, extra.signal)); }
    catch {
      return constrainedToolResult(definition, {
        ok: false,
        failure: createInterfaceFailure("internal_error"),
      });
    }
  });
  return server;
};

export interface StdioMcpHandle {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export const startStdioMcp = async (runtime: RuntimeDispatchPort): Promise<StdioMcpHandle> => {
  const server = createMcpServer(runtime);
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  server.onclose = resolveClosed;
  await server.connect(new StdioServerTransport());
  return Object.freeze({
    closed,
    close: async (): Promise<void> => {
      await server.close();
      resolveClosed();
    },
  });
};
