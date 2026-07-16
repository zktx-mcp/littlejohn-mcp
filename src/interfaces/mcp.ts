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
import { capabilityCatalogSchema, fixedOrigin } from "../runtime/index.js";
import {
  parseWalletOperationResponse,
  walletOperationIdSchema,
} from "../wallet/contracts.js";
import {
  browserOperationPagePath,
} from "./browser-contract.js";
import {
  createInterfaceFailure,
  dispatchCanonical,
  type InterfaceInvocationResult,
  type RuntimeDispatchPort,
} from "./http-client.js";
import {
  capabilityCatalogInterface,
  declaredMcpToolNames,
  readInterfaceIdentities,
  walletToolInterfaces,
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
  readonly annotations: ToolAnnotations;
  readonly parseInput: (value: unknown) => unknown;
  readonly invoke: (input: unknown, signal: AbortSignal) => Promise<InterfaceInvocationResult>;
}

const canonicalSchema = (value: unknown): Tool["inputSchema"] => {
  const captured = captureCanonicalJson(JSON.parse(JSON.stringify(value)));
  if (typeof captured !== "object" || captured === null || Array.isArray(captured) ||
    (captured["type"] !== undefined && captured["type"] !== "object")) {
    throw new TypeError("MCP input schema must describe an object.");
  }
  return captureCanonicalJson({ ...captured, type: "object" }) as Tool["inputSchema"];
};

const emptyInputSchema = z.object({}).strict();
const operationInputSchema = z.object({ operationId: walletOperationIdSchema }).strict();

const projectedInputs = new Map<CapabilityId, Tool["inputSchema"]>(
  projectCapabilities(readCapabilityRegistry).map((projection) => [
    projection.capabilityId,
    projection.input.schema as Tool["inputSchema"],
  ]),
);

const capabilityInputSchema = (capabilityId: CapabilityId): Tool["inputSchema"] => {
  const schema = projectedInputs.get(capabilityId);
  if (schema === undefined) throw new TypeError("Capability input schema is unavailable.");
  return canonicalSchema(schema);
};

const emptyMcpInputSchema = canonicalSchema(z.toJSONSchema(emptyInputSchema, {
  target: "draft-2020-12",
  io: "input",
  unrepresentable: "throw",
}));

const operationMcpInputSchema = canonicalSchema(z.toJSONSchema(operationInputSchema, {
  target: "draft-2020-12",
  io: "input",
  unrepresentable: "throw",
}));

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
): McpToolDefinition => Object.freeze({
  name: parseMcpToolName(identity.mcp.name),
  description: identity.mcp.description,
  inputSchema: capabilityInputSchema(identity.capabilityId),
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

const parseEmptyInput = (value: unknown): z.infer<typeof emptyInputSchema> =>
  emptyInputSchema.parse(captureCanonicalJson(value));
const parseOperationInput = (value: unknown): z.infer<typeof operationInputSchema> =>
  operationInputSchema.parse(captureCanonicalJson(value));

const fixedWalletPath = (identity: typeof walletToolInterfaces.startConnection): string => {
  if (typeof identity.http.path !== "string") throw new TypeError("Wallet start route identity is invalid.");
  return identity.http.path;
};

const walletStartKind = (
  identity: typeof walletToolInterfaces.startConnection | typeof walletToolInterfaces.startDisconnection,
): "connect" | "disconnect" => {
  if (identity.operationKind === undefined) throw new TypeError("Wallet start operation identity is invalid.");
  return identity.operationKind;
};

const operationWalletPath = (
  identity: typeof walletToolInterfaces.getOperation | typeof walletToolInterfaces.cancelOperation,
  operationId: string,
): string => {
  if (typeof identity.http.path !== "function") throw new TypeError("Wallet operation route identity is invalid.");
  return identity.http.path(operationId);
};

const operationValue = (result: InterfaceInvocationResult): InterfaceInvocationResult => {
  if (!result.ok) return result;
  try {
    const response = parseWalletOperationResponse(result.value);
    if (response.qr !== undefined) throw new TypeError("MCP cannot receive QR material.");
    return success(response.operation);
  } catch { return failure(); }
};

const startOperationValue = (result: InterfaceInvocationResult): InterfaceInvocationResult => {
  if (!result.ok) return result;
  try {
    const response = parseWalletOperationResponse(result.value);
    if (response.qr !== undefined) throw new TypeError("MCP cannot receive QR material.");
    return success({
      operation: response.operation,
      managementUrl: `${fixedOrigin}${browserOperationPagePath(response.operation.operationId)}`,
    });
  } catch { return failure(); }
};

const createToolDefinitions = (runtime: RuntimeDispatchPort): readonly McpToolDefinition[] => Object.freeze([
  ...readInterfaceIdentities.map((identity) => readTool(runtime, identity)),
  Object.freeze({
    name: parseMcpToolName(capabilityCatalogInterface.mcp.name),
    description: capabilityCatalogInterface.mcp.description,
    inputSchema: emptyMcpInputSchema,
    annotations: annotations(capabilityCatalogInterface.mcp.annotations),
    parseInput: parseEmptyInput,
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
  Object.freeze({
    name: parseMcpToolName(walletToolInterfaces.startConnection.name),
    description: walletToolInterfaces.startConnection.description,
    inputSchema: emptyMcpInputSchema,
    annotations: annotations(walletToolInterfaces.startConnection.annotations),
    parseInput: parseEmptyInput,
    invoke: async (_value: unknown, signal: AbortSignal): Promise<InterfaceInvocationResult> =>
      startOperationValue(await localControl(
        runtime,
        walletToolInterfaces.startConnection.http.method,
        fixedWalletPath(walletToolInterfaces.startConnection),
        201,
        signal,
        {
        kind: walletStartKind(walletToolInterfaces.startConnection),
        interactionInterface: "web",
        },
      )),
  }),
  Object.freeze({
    name: parseMcpToolName(walletToolInterfaces.startDisconnection.name),
    description: walletToolInterfaces.startDisconnection.description,
    inputSchema: emptyMcpInputSchema,
    annotations: annotations(walletToolInterfaces.startDisconnection.annotations),
    parseInput: parseEmptyInput,
    invoke: async (_value: unknown, signal: AbortSignal): Promise<InterfaceInvocationResult> =>
      startOperationValue(await localControl(
        runtime,
        walletToolInterfaces.startDisconnection.http.method,
        fixedWalletPath(walletToolInterfaces.startDisconnection),
        201,
        signal,
        {
        kind: walletStartKind(walletToolInterfaces.startDisconnection),
        interactionInterface: "web",
        },
      )),
  }),
  Object.freeze({
    name: parseMcpToolName(walletToolInterfaces.getOperation.name),
    description: walletToolInterfaces.getOperation.description,
    inputSchema: operationMcpInputSchema,
    annotations: annotations(walletToolInterfaces.getOperation.annotations),
    parseInput: parseOperationInput,
    invoke: async (value: unknown, signal: AbortSignal): Promise<InterfaceInvocationResult> => {
      const { operationId } = value as z.infer<typeof operationInputSchema>;
      return operationValue(await localControl(
        runtime,
        walletToolInterfaces.getOperation.http.method,
        operationWalletPath(walletToolInterfaces.getOperation, operationId),
        200,
        signal,
      ));
    },
  }),
  Object.freeze({
    name: parseMcpToolName(walletToolInterfaces.cancelOperation.name),
    description: walletToolInterfaces.cancelOperation.description,
    inputSchema: operationMcpInputSchema,
    annotations: annotations(walletToolInterfaces.cancelOperation.annotations),
    parseInput: parseOperationInput,
    invoke: async (value: unknown, signal: AbortSignal): Promise<InterfaceInvocationResult> => {
      const { operationId } = value as z.infer<typeof operationInputSchema>;
      return operationValue(await localControl(
        runtime,
        walletToolInterfaces.cancelOperation.http.method,
        operationWalletPath(walletToolInterfaces.cancelOperation, operationId),
        200,
        signal,
      ));
    },
  }),
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
      annotations: definition.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let definition: McpToolDefinition;
    let input: unknown;
    try {
      definition = registry.get(request.params.name);
      input = definition.parseInput(request.params.arguments ?? {});
    } catch {
      return toolResult({ ok: false, failure: createInterfaceFailure("invalid_input") });
    }
    if (extra.signal.aborted) {
      return toolResult({ ok: false, failure: createInterfaceFailure("request_aborted") });
    }
    try { return toolResult(await definition.invoke(input, extra.signal)); }
    catch { return toolResult({ ok: false, failure: createInterfaceFailure("internal_error") }); }
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
