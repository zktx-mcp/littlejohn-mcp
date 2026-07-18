import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import { extendChainSupportManifest } from "../../src/chain/application.js";
import {
  accountBalanceCapability,
  canonicalJsonStringify,
  captureCanonicalJson,
  chainStatusCapability,
  contractInspectCapability,
  keccak256FromHex,
  projectCapabilities,
  readCapabilityRegistry,
  transactionInspectCapability,
  walletConnectionCapability,
  type AnyReadCapabilityDefinition,
  type CanonicalJson,
  type ObservationWriter,
} from "../../src/core/index.js";
import {
  chainInterfaceErrorMappings,
  createChainFailure,
} from "../../src/chain/errors.js";
import {
  runCli,
  type CliDependencies,
  type CliRuntimePort,
  type CliTerminalPort,
} from "../../src/cli.js";
import type { BrowserAssetBundle } from "../../src/interfaces/browser-assets.js";
import { createBrowserRequestCredentialAuthority } from "../../src/interfaces/browser-credentials.js";
import { extendBrowserInterfaceRoutes } from "../../src/interfaces/browser-routes.js";
import { dispatchCanonical, type RuntimeDispatchPort } from "../../src/interfaces/http-client.js";
import {
  accountBalanceInterface,
  capabilityCatalogInterface,
  chainStatusInterface,
  contractInspectInterface,
  transactionInspectInterface,
  walletConnectionInterface,
  type ReadInterfaceIdentity,
} from "../../src/interfaces/identities.js";
import { createMcpServer } from "../../src/interfaces/mcp.js";
import { extendInterfaceSupportManifest } from "../../src/interfaces/support.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import { parseReadCliCommand, runReadCliCommand } from "../../src/interfaces/cli-read.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import { createRuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import type {
  RuntimeDispatchRequest,
  RuntimeDispatchResponse,
} from "../../src/runtime/index.js";
import {
  composeCapabilityCatalog,
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  toProblemDetails,
} from "../../src/runtime/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationStartResult,
  type WalletInterfaceOperations,
  type WalletManagementOperation,
} from "../../src/wallet/contracts.js";
import { walletInterfaceErrorMappings } from "../../src/wallet/errors.js";
import { createWalletFailure } from "../../src/wallet/errors.js";
import { walletControlRoutes } from "../../src/wallet/routes.js";
import {
  bindForHarness,
  createCapabilityHarness,
  invokeBinding,
} from "../core/capability-harness.js";
import {
  ScriptedRpc,
  createChainHandlerHarness,
  disconnectedWallet,
  rpcValue,
  type RpcStep,
} from "../chain/handler-harness.js";

const roots: string[] = [];
const operationId = Buffer.alloc(32, 51).toString("base64url");
const account = `0x${"11".repeat(20)}`;
const recipient = `0x${"22".repeat(20)}`;
const token = `0x${"33".repeat(20)}`;
const transactionHash = `0x${"44".repeat(32)}`;
const blockHash = `0x${"55".repeat(32)}`;
const blockNumber = "9007199254740993";
const blockQuantity = "0x20000000000001";
const blockTimestamp = "0x65a00000";
const canonicalBlockTimestamp = new Date(Number(BigInt(blockTimestamp) * 1_000n)).toISOString();
const bytecode = "0x6001600055";
const abiWord = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const providerAccessList = () => [
  { address: recipient, storageKeys: [blockHash, transactionHash] },
  { address: account, storageKeys: [] },
  { address: recipient, storageKeys: [blockHash] },
];
let erc20Encoder: Erc20CallEncoder;

beforeAll(async () => { erc20Encoder = await createErc20CallEncoder(); });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

interface CanonicalRoute {
  readonly method: RuntimeDispatchRequest["method"];
  readonly path: string;
  readonly body?: CanonicalJson;
  readonly response: RuntimeDispatchResponse;
}

class CanonicalRuntime implements RuntimeDispatchPort, CliRuntimePort {
  readonly ownerState = "deferred" as const;
  readonly requests: RuntimeDispatchRequest[] = [];

  constructor(
    readonly routes: readonly CanonicalRoute[],
    readonly walletOperation: WalletManagementOperation,
  ) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    this.requests.push(request);
    if (request.method === "GET" && request.path === walletControlRoutes.operation(operationId)) {
      return Object.freeze({
        status: 200,
        body: { operation: this.walletOperation } as unknown as CanonicalJson,
      });
    }
    const route = this.routes.find((candidate) =>
      candidate.method === request.method && candidate.path === request.path);
    if (route !== undefined) {
      if (route.body === undefined) {
        if (request.body !== undefined) throw new Error("The parity route received an undeclared body.");
      } else if (request.body === undefined ||
        canonicalJsonStringify(route.body) !== canonicalJsonStringify(request.body)) {
        throw new Error("The parity route received a noncanonical body.");
      }
      return route.response;
    }
    throw new Error("The parity runtime received an undeclared request.");
  }
}

const outputPort = () => {
  const output: string[] = [];
  const error: string[] = [];
  return Object.freeze({
    output,
    error,
    port: Object.freeze({
      writeOutput: (value: string) => { output.push(value); },
      writeError: (value: string) => { error.push(value); },
    }),
  });
};

const terminalPort = (output: string[], error: string[]): CliTerminalPort => Object.freeze({
  inputIsTTY: true,
  outputIsTTY: true,
  columns: 120,
  rows: 40,
  interruptSignal: new AbortController().signal,
  writeOutput: (value: string) => { output.push(value); },
  writeError: (value: string) => { error.push(value); },
  showQr: () => { throw new Error("The operation read cannot display a QR code."); },
  hideQr: () => {},
  readConfirmation: async () => { throw new Error("The operation read cannot request confirmation."); },
  dispose: () => {},
});

const connectMcp = async (runtime: RuntimeDispatchPort) => {
  const server = createMcpServer(runtime);
  const client = new Client({ name: "parity-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return Object.freeze({
    client,
    close: async (): Promise<void> => {
      await Promise.allSettled([client.close(), server.close()]);
    },
  });
};

const mcpText = (result: unknown): string => {
  if (typeof result !== "object" || result === null ||
    !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("The MCP parity result has no content.");
  }
  const content = result.content[0];
  if (typeof content !== "object" || content === null ||
    !("type" in content) || content.type !== "text" ||
    !("text" in content) || typeof content.text !== "string") {
    throw new Error("The MCP parity result has no canonical text content.");
  }
  return content.text;
};

const providerBlock = () => Object.freeze({
  number: blockQuantity,
  hash: blockHash,
  timestamp: blockTimestamp,
  transactions: [],
});

const pendingTransaction = () => Object.freeze({
  hash: transactionHash,
  from: account,
  to: recipient,
  value: blockQuantity,
  input: "0x1234",
  nonce: blockQuantity,
  gas: blockQuantity,
  type: "0x2",
  chainId: "0x1237",
  accessList: providerAccessList(),
  maxFeePerGas: blockQuantity,
  maxPriorityFeePerGas: "0x1",
  blockNumber: null,
  blockHash: null,
  transactionIndex: null,
});

const invokeChainRead = async (
  definition: AnyReadCapabilityDefinition,
  input: unknown,
  steps: readonly RpcStep[],
): Promise<CanonicalJson> => {
  const harness = createChainHandlerHarness({
    rpc: new ScriptedRpc(steps),
    encoder: erc20Encoder,
    wallet: disconnectedWallet(),
  });
  try {
    const result = await harness.invoke(definition, input);
    if (!result.ok) throw new Error("A direct chain parity read did not succeed.");
    if (harness.rpc.remainingSteps !== 0) throw new Error("A direct parity read left RPC steps unused.");
    return captureCanonicalJson(result);
  } finally {
    await harness.close();
  }
};

const directWalletConnection = async (): Promise<CanonicalJson> => {
  const harness = createCapabilityHarness();
  const binding = bindForHarness(
    walletConnectionCapability,
    harness,
    async (_input, context, observations: ObservationWriter) => {
      const data = { status: "disconnected" as const, reason: "no_session" as const };
      observations.record("wallet_sdk", {
        source: context.ports.observations.get("wallet_sdk"),
        claims: [{ role: "wallet_sdk_state", value: data }],
      });
      return { status: "success" as const, data };
    },
  );
  const result = await invokeBinding(walletConnectionCapability, binding, {});
  if (!result.ok) throw new Error("The direct wallet connection parity read did not succeed.");
  return captureCanonicalJson(result);
};

interface ReadParityCase {
  readonly identity: ReadInterfaceIdentity;
  readonly input: CanonicalJson;
  readonly cliArguments: readonly string[];
  readonly direct: CanonicalJson;
  readonly humanOutput: string;
}

const createReadParityCases = async (): Promise<readonly ReadParityCase[]> => {
  const latestBlock = Object.freeze({ kind: "latest" as const });
  const chainStatus = await invokeChainRead(chainStatusCapability, {}, [
    rpcValue("eth_chainId", "0x1237"),
    rpcValue("eth_getBlockByNumber", providerBlock()),
  ]);
  const contractInput = captureCanonicalJson({ address: account, block: latestBlock });
  const contract = await invokeChainRead(contractInspectCapability, contractInput, [
    rpcValue("eth_chainId", "0x1237"),
    rpcValue("eth_getBlockByNumber", providerBlock()),
    rpcValue("eth_getCode", bytecode),
  ]);
  const transactionInput = captureCanonicalJson({ transactionHash });
  const transaction = await invokeChainRead(transactionInspectCapability, transactionInput, [
    rpcValue("eth_chainId", "0x1237"),
    rpcValue("eth_getTransactionByHash", pendingTransaction()),
  ]);
  expect(transaction).toMatchObject({
    data: {
      accessList: {
        kind: "entries",
        entries: providerAccessList(),
      },
    },
  });
  const balanceInput = captureCanonicalJson({
    account: { kind: "address", address: account },
    includeNative: true,
    tokens: [token],
    block: latestBlock,
  });
  const balance = await invokeChainRead(accountBalanceCapability, balanceInput, [
    rpcValue("eth_chainId", "0x1237"),
    rpcValue("eth_getBlockByNumber", providerBlock()),
    rpcValue("eth_getBalance", blockQuantity),
    rpcValue("eth_call", abiWord(BigInt(blockNumber))),
    rpcValue("eth_call", abiWord(6n)),
  ]);

  return Object.freeze([
    Object.freeze({
      identity: chainStatusInterface,
      input: captureCanonicalJson({}),
      cliArguments: ["read", "chain-status"],
      direct: chainStatus,
      humanOutput: [
        "Chain: eip155:4663",
        `Latest block: ${blockNumber}`,
        `Block hash: ${blockHash}`,
        `Block timestamp: ${canonicalBlockTimestamp}`,
        "",
      ].join("\n"),
    }),
    Object.freeze({
      identity: contractInspectInterface,
      input: contractInput,
      cliArguments: ["read", "contract", account, "--block", "latest"],
      direct: contract,
      humanOutput: [
        `Contract: ${account}`,
        `Block: ${blockNumber}`,
        "Runtime code: present",
        "Byte length: 5",
        `Code hash: ${keccak256FromHex(bytecode)}`,
        "",
      ].join("\n"),
    }),
    Object.freeze({
      identity: transactionInspectInterface,
      input: transactionInput,
      cliArguments: ["read", "transaction", transactionHash],
      direct: transaction,
      humanOutput: [
        `Transaction: ${transactionHash}`,
        `From: ${account}`,
        `To: ${recipient}`,
        `Value: native:eip155:4663 raw=${blockNumber} decimals=not_observed`,
        `Nonce: ${blockNumber}`,
        `Gas limit: ${blockNumber}`,
        "Type: 2",
        "Inclusion: pending",
        "",
      ].join("\n"),
    }),
    Object.freeze({
      identity: accountBalanceInterface,
      input: balanceInput,
      cliArguments: [
        "read", "balance", "--address", account, "--native", "true", "--token", token,
        "--block", "latest",
      ],
      direct: balance,
      humanOutput: [
        `Account: ${account}`,
        `Block: ${blockNumber}`,
        `Native balance: native:eip155:4663 raw=${blockNumber} decimals=not_observed`,
        `Token ${token}: erc20:eip155:4663:${token} raw=${blockNumber} decimals=6`,
        "",
      ].join("\n"),
    }),
  ]);
};

const operation = (): WalletManagementOperation => parseWalletManagementOperation({
  operationId,
  kind: "disconnect",
  state: "awaiting_confirmation",
  connectionRevision: "17",
  expiresAt: "2026-07-16T00:00:00.000Z",
  result: null,
  failure: null,
});

const browserAssets: BrowserAssetBundle = Object.freeze({
  renderShell: (token: string) => `<meta content="${token}">`,
  get: () => undefined,
  paths: () => Object.freeze([]),
});

const browserOperations = (value: WalletManagementOperation): WalletInterfaceOperations => Object.freeze({
  operation: Object.freeze({
    start: async () => parseWalletOperationStartResult({
      status: "operation_started",
      operation: value,
    }),
    cancel: async () => value,
  }),
  confirmation: Object.freeze({
    interactionInterface: "web" as const,
    confirm: async () => value,
  }),
  presentation: Object.freeze({
    get: async () => Object.freeze({ operation: value, access: "interactive" as const }),
  }),
  currentProjection: Object.freeze({
    get: async () => parseWalletCurrentOperationProjection({
      status: "present",
      connectionRevision: value.connectionRevision,
      connection: { status: "disconnected", reason: "no_session" },
      presentation: { operation: value, access: "interactive" },
    }),
  }),
});

describe("interface parity", () => {
  it("preserves every canonical chain read through HTTP, MCP, CLI JSON, and human CLI output", async () => {
    const cases = await createReadParityCases();
    const runtime = new CanonicalRuntime(cases.map((entry) => Object.freeze({
      method: entry.identity.http.method,
      path: entry.identity.http.path,
      ...(entry.identity.http.method === "POST" ? { body: entry.input } : {}),
      response: Object.freeze({ status: 200, body: entry.direct }),
    })), operation());
    const mcp = await connectMcp(runtime);
    try {
      for (const entry of cases) {
        const request = {
          requestClass: "public_read" as const,
          method: entry.identity.http.method,
          path: entry.identity.http.path,
          ...(entry.identity.http.method === "POST" ? { body: entry.input } : {}),
        };
        const http = await dispatchCanonical(runtime, request, 200);
        expect(http).toEqual({ ok: true, value: entry.direct });

        const mcpResult = await mcp.client.callTool({
          name: entry.identity.mcp.name,
          arguments: entry.input as Readonly<Record<string, unknown>>,
        });
        expect(mcpResult.isError).not.toBe(true);
        expect(mcpResult.structuredContent).toEqual(entry.direct);
        expect(mcpText(mcpResult)).toBe(canonicalJsonStringify(entry.direct));

        const json = outputPort();
        expect(await runReadCliCommand(
          runtime,
          parseReadCliCommand([...entry.cliArguments, "--json"]),
          json.port,
        )).toBe(0);
        expect(json.error).toEqual([]);
        expect(JSON.parse(json.output.join(""))).toEqual(entry.direct);

        const human = outputPort();
        expect(await runReadCliCommand(
          runtime,
          parseReadCliCommand(entry.cliArguments),
          human.port,
        )).toBe(0);
        expect(human.error).toEqual([]);
        expect(human.output.join("")).toBe(entry.humanOutput);
        expect(human.output.join("")).not.toContain("9,007,199");
      }
    } finally {
      await mcp.close();
    }
  });

  it("preserves the canonical wallet connection through HTTP, MCP, CLI JSON, and human CLI output", async () => {
    const direct = await directWalletConnection();
    const response = Object.freeze({ status: 200 as const, body: direct });
    const runtime = new CanonicalRuntime([
      Object.freeze({
        method: walletConnectionInterface.http.method,
        path: walletConnectionInterface.http.path,
        response,
      }),
      Object.freeze({
        method: "GET" as const,
        path: walletControlRoutes.connection,
        response,
      }),
    ], operation());

    expect(await dispatchCanonical(runtime, {
      requestClass: "public_read",
      method: walletConnectionInterface.http.method,
      path: walletConnectionInterface.http.path,
    }, 200)).toEqual({ ok: true, value: direct });

    const mcp = await connectMcp(runtime);
    try {
      const result = await mcp.client.callTool({
        name: walletConnectionInterface.mcp.name,
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(direct);
      expect(mcpText(result)).toBe(canonicalJsonStringify(direct));
    } finally {
      await mcp.close();
    }

    const jsonOutput: string[] = [];
    const jsonError: string[] = [];
    expect(await runCli(["wallet", "status", "--json"], Object.freeze({
      createRuntime: async () => runtime,
      terminal: terminalPort(jsonOutput, jsonError),
      waitForPoll: async () => {},
      terminateProcess: () => { throw new Error("The connection parity CLI cannot terminate the process."); },
    }))).toBe(0);
    expect(jsonError).toEqual([]);
    expect(JSON.parse(jsonOutput.join(""))).toEqual(direct);

    const humanOutput: string[] = [];
    const humanError: string[] = [];
    expect(await runCli(["wallet", "status"], Object.freeze({
      createRuntime: async () => runtime,
      terminal: terminalPort(humanOutput, humanError),
      waitForPoll: async () => {},
      terminateProcess: () => { throw new Error("The connection parity CLI cannot terminate the process."); },
    }))).toBe(0);
    expect(humanError).toEqual([]);
    expect(humanOutput.join("")).toBe("Disconnected (no_session).\n");
  });

  it("projects one canonical capability catalog through HTTP and MCP without changing core scope or support", async () => {
    const manifest = extendInterfaceSupportManifest(extendTokenCatalogSupportManifest(extendChainSupportManifest(
      extendWalletSupportManifest(
        createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain),
      ),
    )));
    const catalog = composeCapabilityCatalog(manifest);
    const runtime = new CanonicalRuntime([Object.freeze({
      method: capabilityCatalogInterface.http.method,
      path: capabilityCatalogInterface.http.path,
      response: Object.freeze({ status: 200, body: catalog as unknown as CanonicalJson }),
    })], operation());

    expect(await dispatchCanonical(runtime, {
      requestClass: "public_read",
      method: capabilityCatalogInterface.http.method,
      path: capabilityCatalogInterface.http.path,
    }, 200)).toEqual({ ok: true, value: catalog });

    const mcp = await connectMcp(runtime);
    try {
      const result = await mcp.client.callTool({
        name: capabilityCatalogInterface.mcp.name,
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(catalog);
      expect(mcpText(result)).toBe(canonicalJsonStringify(catalog as unknown as CanonicalJson));
    } finally {
      await mcp.close();
    }

    const projections = new Map(projectCapabilities(readCapabilityRegistry).map((projection) => [
      projection.capabilityId,
      captureCanonicalJson(projection),
    ]));
    const availability = new Map(readRuntimeSupportManifest(manifest).capabilities.map((entry) => [
      entry.capabilityId,
      captureCanonicalJson(entry.availability),
    ]));
    for (const entry of catalog.capabilities) {
      const { availability: exposedAvailability, ...contract } = entry;
      expect(captureCanonicalJson(contract)).toEqual(projections.get(entry.capabilityId));
      expect(captureCanonicalJson(exposedAvailability)).toEqual(availability.get(entry.capabilityId));
    }
  });

  it("preserves one canonical read failure through HTTP dispatch, MCP structured content, and CLI JSON", async () => {
    const failure = createChainFailure("source_unavailable");
    const problem = toProblemDetails(failure, chainInterfaceErrorMappings);
    const runtime = new CanonicalRuntime([Object.freeze({
      method: chainStatusInterface.http.method,
      path: chainStatusInterface.http.path,
      response: Object.freeze({
        status: problem.status,
        body: problem as unknown as CanonicalJson,
      }),
    })], operation());

    const http = await dispatchCanonical(runtime, {
      requestClass: "public_read",
      method: "GET",
      path: "/api/v1/chain-status",
    }, 200);
    expect(http).toEqual({ ok: false, failure });

    const mcp = await connectMcp(runtime);
    try {
      const result = await mcp.client.callTool({ name: "read_get_chain_status", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(failure);
      expect(mcpText(result)).toBe(canonicalJsonStringify(failure as unknown as CanonicalJson));

      const cli = outputPort();
      const exitCode = await runReadCliCommand(
        runtime,
        parseReadCliCommand(["read", "chain-status", "--json"]),
        cli.port,
      );
      expect(exitCode).toBe(chainInterfaceErrorMappings.get("source_unavailable").cliExitCode);
      expect(cli.error).toEqual([]);
      expect(JSON.parse(cli.output.join(""))).toEqual(failure);
    } finally {
      await mcp.close();
    }
  });

  it("preserves retained operations through native interfaces and the current operation through web", async () => {
    const cases = [
      operation(),
      parseWalletManagementOperation({
        operationId,
        kind: "connect",
        state: "completed",
        connectionRevision: "18",
        expiresAt: "2026-07-16T00:00:00.000Z",
        result: {
          outcome: "connected",
          connection: {
            status: "connected",
            address: account,
            chainId: "eip155:4663",
            approvedMethods: ["eth_sendTransaction"],
            approvedEvents: ["accountsChanged", "chainChanged"],
            expiresAt: "2026-07-22T00:00:00.000Z",
          },
        },
        failure: null,
      }),
      parseWalletManagementOperation({
        operationId,
        kind: "disconnect",
        state: "failed",
        connectionRevision: "19",
        expiresAt: "2026-07-16T00:00:00.000Z",
        result: null,
        failure: createWalletFailure("wallet_timeout"),
      }),
    ];

    for (const direct of cases) {
      const runtime = new CanonicalRuntime([], direct);
      const internalHttp = await dispatchCanonical(runtime, {
        requestClass: "local_control",
        method: "GET",
        path: walletControlRoutes.operation(operationId),
      }, 200);
      expect(internalHttp).toEqual({ ok: true, value: { operation: direct } });

      const mcp = await connectMcp(runtime);
      try {
        const result = await mcp.client.callTool({
          name: "wallet_get_operation",
          arguments: { operationId },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(direct);
        expect(mcpText(result)).toBe(canonicalJsonStringify(direct as unknown as CanonicalJson));
      } finally {
        await mcp.close();
      }

      const cliOutput: string[] = [];
      const cliError: string[] = [];
      const dependencies: CliDependencies = Object.freeze({
        createRuntime: async () => runtime,
        terminal: terminalPort(cliOutput, cliError),
        waitForPoll: async () => {},
        terminateProcess: () => { throw new Error("The parity CLI cannot terminate the process."); },
      });
      expect(await runCli(["wallet", "operation", operationId, "--json"], dependencies)).toBe(0);
      expect(cliError).toEqual([]);
      expect(JSON.parse(cliOutput.join(""))).toEqual(direct);

      if (direct.state !== "awaiting_confirmation") continue;

      const root = await mkdtemp(resolve(tmpdir(), "littlejohn-parity-"));
      roots.push(root);
      const paths = runtimePaths(root);
      const authority = await loadOrCreateControlCredential(root, paths.controlCredential);
      const credentials = createBrowserRequestCredentialAuthority({
        now: () => Date.parse("2026-07-15T00:00:00.000Z"),
        randomBytes: (size) => Buffer.alloc(size, 52),
      });
      const routes = extendBrowserInterfaceRoutes({
        routes: createRuntimeRouteRegistry({
          controlVerifier: createControlCredentialVerifier(authority),
          errorMappings: walletInterfaceErrorMappings,
        }),
        credentials,
        assets: browserAssets,
        walletOperations: browserOperations(direct),
      });
      try {
        const match = routes.match("GET", "/api/v1/wallet/current-operation");
        expect(match.status).toBe("matched");
        if (match.status !== "matched") throw new Error("The web operation route is unavailable.");
        const response = routes.normalizeResult(match.route, await match.route.handler({
          params: match.params,
          body: {},
          signal: new AbortController().signal,
        }));
        expect(response).toEqual({
          ok: true,
          response: "canonical_json",
          body: {
            status: "present",
            connectionRevision: direct.connectionRevision,
            connection: { status: "disconnected", reason: "no_session" },
            presentation: { operation: direct, access: "interactive" },
          },
        });
        if (!response.ok || response.response !== "canonical_json") {
          throw new Error("The web operation parity response is unavailable.");
        }
        expect(parseWalletCurrentOperationProjection(response.body)).toEqual({
          status: "present",
          connectionRevision: direct.connectionRevision,
          connection: { status: "disconnected", reason: "no_session" },
          presentation: { operation: direct, access: "interactive" },
        });
        const exactMatch = routes.match(
          "GET",
          `/api/v1/wallet/operations/${operationId}`,
        );
        expect(exactMatch.status).toBe("matched");
        if (exactMatch.status !== "matched") {
          throw new Error("The exact web operation route is unavailable.");
        }
        const exactResponse = routes.normalizeResult(
          exactMatch.route,
          await exactMatch.route.handler({
            params: exactMatch.params,
            body: {},
            signal: new AbortController().signal,
          }),
        );
        expect(exactResponse).toEqual({
          ok: true,
          response: "canonical_json",
          body: { operation: direct, access: "interactive" },
        });
      } finally {
        credentials.close();
      }
    }
  });
});
