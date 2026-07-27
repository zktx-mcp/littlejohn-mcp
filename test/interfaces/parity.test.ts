import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import { extendChainSupportManifest } from "../../src/chain/application.js";
import { extendAccountAssetSupportManifest } from "../../src/account-assets/support.js";
import { extendReferenceMarketSupportManifest } from "../../src/market-portfolio/support.js";
import { referenceMarketInterfaceErrorMappings } from "../../src/market-portfolio/errors.js";
import {
  accountBalanceCapability,
  canonicalJsonStringify,
  captureCanonicalJson,
  chainStatusCapability,
  contractInspectCapability,
  keccak256FromHex,
  projectCapabilities,
  transactionInspectCapability,
  walletConnectionCapability,
  walletConnectionEvidence,
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
import type { BrowserFetch } from "../../src/interfaces/web/browser-client.js";
import { quoteUniswapV2ExactInput } from "../../src/interfaces/web/uniswap-v2-client.js";
import { inspectTokenContract } from "../../src/interfaces/web/token-catalog-client.js";
import { extendPublicInterfaceRoutes } from "../../src/interfaces/http-routes.js";
import { dispatchCanonical, type RuntimeDispatchPort } from "../../src/interfaces/http-client.js";
import {
  accountBalanceInterface,
  capabilityCatalogInterface,
  chainStatusInterface,
  contractInspectInterface,
  interfaceReadCapabilityRegistry,
  tokenCatalogInterfaceBindings,
  tokenInspectInterface,
  transactionInspectInterface,
  uniswapV2QuoteInterface,
  walletConnectionInterface,
  type ReadInterfaceIdentity,
} from "../../src/interfaces/identities.js";
import { createMcpServer } from "../../src/interfaces/mcp.js";
import { LocalOperationClient } from "../../src/interfaces/operation-client.js";
import {
  composeInterfaceCapabilityCatalog,
  extendInterfaceSupportManifest,
} from "../../src/interfaces/support.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import { parseReadCliCommand, runReadCliCommand } from "../../src/interfaces/cli-read.js";
import { parseTokenCliCommand, runTokenCliCommand } from "../../src/interfaces/cli-token.js";
import { openTestOwnerSession } from "./owner-session-harness.js";
import { accountAssetInterfaceHarnessPort } from "../account-assets/interface-harness.js";
import { referenceMarketInterfaceHarnessPort } from "../market-portfolio/interface-harness.js";
import {
  createUniswapV2DirectQuoteSuccess,
  extendUniswapV2ProtocolHarnessManifest,
  uniswapV2QuoteHarnessBinding,
} from "../protocols/interface-harness.js";
import {
  uniswapV2FactoryAddress,
  uniswapV2QuoteInputSchema,
} from "../../src/protocols/uniswap-v2/index.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  createRuntimeRouteRegistry,
  type NormalizedRouteResult,
  type RouteMethod,
  type RuntimeRouteRegistry,
} from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import type {
  RuntimeDispatchRequest,
  RuntimeDispatchResponse,
  WalletConnectionReadCapabilityPort,
} from "../../src/runtime/index.js";
import {
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
  toProblemDetails,
} from "../../src/runtime/index.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";
import {
  extendTokenCatalogControlRouteRegistry,
  tokenCatalogApplicationContracts,
  tokenCatalogBrowserRoutes,
  tokenCatalogControlRoutes,
  tokenCatalogOperationConfirmationContract,
  type TokenCatalogBrowserOperationPort,
  type TokenCatalogInteractiveCliPort,
  type TokenCatalogNonInteractiveOperationPort,
  type TokenCatalogOperation,
  type TokenCatalogQueryApplicationPort,
  type TokenCatalogWebStartPort,
} from "../../src/token-catalog/index.js";
import {
  parseWalletCurrentOperationProjection,
  parseWalletManagementOperation,
  parseWalletOperationStartResult,
  type WalletInterfaceOperations,
  type WalletManagementOperation,
} from "../../src/wallet/contracts.js";
import { createWalletFailure } from "../../src/wallet/errors.js";
import { walletControlRoutes } from "../../src/wallet/routes.js";
import {
  bindForHarness,
  createCapabilityHarness,
  invokeBinding,
} from "../core/capability-harness.js";
import {
  chainId as tokenChainId,
  createInspectionBinding,
  createInspectionSuccess,
  createTokenOperation,
  createTokenSelectionDetail,
  tokenAddress,
  walletAddress,
} from "../token-catalog/harness.js";
import { tokenCatalogInterfaceHarnessPorts } from "../token-catalog/interface-harness.js";
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

  openOwnerSession(signal?: AbortSignal) { return openTestOwnerSession(this, signal); }

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

class RouteRegistryRuntime implements RuntimeDispatchPort, CliRuntimePort {
  readonly ownerState = "deferred" as const;

  constructor(readonly routes: RuntimeRouteRegistry) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  openOwnerSession(signal?: AbortSignal) { return openTestOwnerSession(this, signal); }

  async dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    const match = this.routes.match(request.method, request.path);
    if (match.status !== "matched") {
      throw new Error("The token parity runtime received an unmatched request.");
    }
    if (match.route.requestClass !== request.requestClass) {
      throw new Error("The token parity runtime received the wrong request class.");
    }
    const result = this.routes.normalizeResult(match.route, await match.route.handler({
      params: match.params,
      body: request.body ?? {},
      signal: request.signal ?? new AbortController().signal,
    }));
    if (!result.ok) {
      return Object.freeze({ status: result.problem.status, body: result.problem as unknown as CanonicalJson });
    }
    if (result.response !== "canonical_json") {
      throw new Error("The token parity runtime returned browser content to a native interface.");
    }
    return Object.freeze({ status: match.route.successStatus, body: result.body });
  }
}

const invokeRoute = async (
  routes: RuntimeRouteRegistry,
  method: RouteMethod,
  path: string,
  body: unknown = {},
): Promise<NormalizedRouteResult> => {
  const match = routes.match(method, path);
  expect(match.status).toBe("matched");
  if (match.status !== "matched") throw new Error("The token parity route is unavailable.");
  return routes.normalizeResult(match.route, await match.route.handler({
    params: match.params,
    body,
    signal: new AbortController().signal,
  }));
};

const withoutInvocationCorrelation = (input: unknown, parentKey?: string): CanonicalJson => {
  if (Array.isArray(input)) {
    const values = input.map((value) => withoutInvocationCorrelation(value));
    if (parentKey === "sources") {
      values.sort((left, right) => {
        const leftJson = canonicalJsonStringify(left);
        const rightJson = canonicalJsonStringify(right);
        return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
      });
    }
    return values;
  }
  if (typeof input !== "object" || input === null) return input as CanonicalJson;
  const omitted = new Set([
    "invocationId",
    "observationId",
    "observationIds",
    "quantityObservationId",
    "recordDigest",
  ]);
  return Object.fromEntries(Object.entries(input)
    .filter(([key]) => !omitted.has(key))
    .map(([key, value]) => [key, withoutInvocationCorrelation(value, key)])) as CanonicalJson;
};

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
  readLine: async () => { throw new Error("The operation read cannot read terminal input."); },
  dispose: () => {},
});

const connectMcp = async (
  runtime: Parameters<typeof createMcpServer>[0],
  createOperationId: () => string = () => operationId,
) => {
  const server = createMcpServer(runtime, new LocalOperationClient({
    ownerSessions: runtime,
    createOperationId,
  }));
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

const tokenOperationClient = (runtime: RouteRegistryRuntime) => new LocalOperationClient({
  ownerSessions: runtime,
  createOperationId: () => tokenOperationId,
});

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

const createWalletConnectionBinding = () => {
  const harness = createCapabilityHarness();
  return bindForHarness(
    walletConnectionCapability,
    harness,
    async (_input, context, observations: ObservationWriter) => {
      const data = { status: "disconnected" as const, reason: "no_session" as const };
      const sdk = observations.bind(walletConnectionEvidence.targets.sdk);
      observations.record(sdk.slot, {
        source: context.ports.observations.get("wallet_sdk"),
        claims: [{ role: sdk.roles.state, value: data }],
      });
      return { status: "success" as const, data };
    },
  );
};

const directWalletConnection = async (): Promise<CanonicalJson> => {
  const binding = createWalletConnectionBinding();
  const result = await invokeBinding(walletConnectionCapability, binding, {});
  if (!result.ok) throw new Error("The direct wallet connection parity read did not succeed.");
  return captureCanonicalJson(result);
};

const walletConnectionPort = (): WalletConnectionReadCapabilityPort => Object.freeze({
  connection: createWalletConnectionBinding(),
});

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
    rpcValue("eth_getStorageAt", `0x${"0".repeat(64)}`),
    rpcValue("eth_getStorageAt", `0x${"0".repeat(64)}`),
    rpcValue("eth_getStorageAt", `0x${"0".repeat(64)}`),
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
        "Runtime code bytes: 5",
        `Runtime code hash: ${keccak256FromHex(bytecode)}`,
        "Proxy: no_supported_proxy_observed",
        `Source target: no_record_observed (${account})`,
        "Declared functions: unavailable (exact_abi_unavailable)",
        "Owner: unavailable",
        "Paused: unavailable",
        "Default administrators: unavailable",
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

const tokenOperationId = Buffer.alloc(32, 62).toString("base64url");
const createTokenParityValues = async () => {
  const inspection = await createInspectionSuccess();
  const asset = inspection.data.asset;
  const selectionDetail = createTokenSelectionDetail(inspection, { revisionByte: 9 });
  const startInput = { asset };
  const webAwaiting = tokenCatalogApplicationContracts.startAddition.parsePublicSuccess(
    startInput,
    { operation: await createTokenOperation({
      kind: "add", state: "awaiting_confirmation", interactionInterface: "web", operationId: tokenOperationId,
    }) },
  ).operation;
  const cliAwaiting = tokenCatalogApplicationContracts.startAddition.parsePublicSuccess(
    startInput,
    { operation: await createTokenOperation({
      kind: "add", state: "awaiting_confirmation", interactionInterface: "cli", operationId: tokenOperationId,
    }) },
  ).operation;
  const webCancelled = tokenCatalogApplicationContracts.cancelOperation.parsePublicSuccess(
    { operationId: tokenOperationId },
    { operation: await createTokenOperation({
      kind: "add", state: "cancelled", interactionInterface: "web", operationId: tokenOperationId,
    }) },
  ).operation;
  const cliCompleted = tokenCatalogOperationConfirmationContract.parsePublicSuccess(
    { operationId: tokenOperationId, reviewDigest: cliAwaiting.review.reviewDigest },
    await createTokenOperation({
      kind: "add", state: "completed", interactionInterface: "cli", operationId: tokenOperationId,
    }),
  );
  return Object.freeze({
    asset,
    inspection,
    selectionDetail,
    selectionList: Object.freeze({
      selections: [selectionDetail.selection],
      nextCursor: null,
    }),
    webAwaiting,
    cliAwaiting,
    webCancelled,
    cliCompleted,
  });
};

type TokenParityValues = Awaited<ReturnType<typeof createTokenParityValues>>;

const createTokenParityPorts = (values: TokenParityValues): Readonly<{
  inspection: ReturnType<typeof createInspectionBinding>;
  queries: TokenCatalogQueryApplicationPort;
  webStart: TokenCatalogWebStartPort;
  interactiveCli: TokenCatalogInteractiveCliPort;
  operations: TokenCatalogNonInteractiveOperationPort;
  browserOperations: TokenCatalogBrowserOperationPort;
}> => {
  const unavailable = async (): Promise<never> => {
    throw new Error("The token parity test invoked an undeclared operation kind.");
  };
  return Object.freeze({
    inspection: createInspectionBinding(),
    queries: Object.freeze({
      getSelection: () => values.selectionDetail,
      listSelections: () => values.selectionList,
    }),
    webStart: Object.freeze({
      interactionInterface: "web" as const,
      startAddition: async () => Object.freeze({ operation: values.webAwaiting }),
      startRemoval: unavailable,
    }),
    interactiveCli: Object.freeze({
      interactionInterface: "cli" as const,
      startAddition: async () => Object.freeze({ operation: values.cliAwaiting }),
      startRemoval: unavailable,
      confirm: async () => values.cliCompleted,
    }),
    operations: Object.freeze({
      getOperation: () => Object.freeze({ operation: values.webAwaiting }),
      cancelOperation: async () => Object.freeze({ operation: values.webCancelled }),
    }),
    browserOperations: Object.freeze({
      interactionInterface: "web" as const,
      getOperation: () => Object.freeze({ operation: values.webAwaiting }),
      getCurrentOperation: () => values.webAwaiting,
      confirm: async () => { throw new Error("Token parity does not confirm through the browser."); },
      cancel: async () => values.webCancelled,
    }),
  });
};

const createTokenParityContext = async () => {
  const values = await createTokenParityValues();
  const ports = createTokenParityPorts(values);
  const root = await mkdtemp(resolve(tmpdir(), "littlejohn-token-parity-"));
  roots.push(root);
  const paths = runtimePaths(root);
  const authority = await loadOrCreateControlCredential(root, paths.controlCredential);
  const chain = createChainHandlerHarness({
    rpc: new ScriptedRpc(Array.from({ length: 3 }).flatMap(() => [
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", providerBlock()),
    ])),
    encoder: erc20Encoder,
    wallet: disconnectedWallet(),
  });
  const chainSupport = extendChainSupportManifest(
    extendWalletSupportManifest(
      createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain),
    ),
  );
  const tokenSupport = extendTokenCatalogSupportManifest(chainSupport);
  const accountSupport = extendAccountAssetSupportManifest(tokenSupport);
  const referenceSupport = extendReferenceMarketSupportManifest(accountSupport);
  const protocolSupport = extendUniswapV2ProtocolHarnessManifest(referenceSupport);
  const manifest = extendInterfaceSupportManifest(protocolSupport);
  let routes = extendPublicInterfaceRoutes({
    routes: createRuntimeRouteRegistry({
      controlVerifier: createControlCredentialVerifier(authority),
    }),
    chainReads: chain.service.chainReads,
    walletConnection: walletConnectionPort(),
    tokenInspection: ports.inspection,
    uniswapV2Quote: uniswapV2QuoteHarnessBinding(),
    supportManifest: manifest,
  });
  routes = extendTokenCatalogControlRouteRegistry({
    routes,
    inspection: ports.inspection,
    queries: ports.queries,
    webStart: ports.webStart,
    interactiveCli: ports.interactiveCli,
    nonInteractiveOperations: ports.operations,
  });
  const credentials = createBrowserRequestCredentialAuthority({
    now: () => Date.parse("2026-07-18T00:00:00.000Z"),
    randomBytes: (size) => Buffer.alloc(size, 63),
  });
  routes = extendBrowserInterfaceRoutes({
    routes,
    credentials,
    assets: browserAssets,
    walletOperations: browserOperations(operation()),
    accountAssets: accountAssetInterfaceHarnessPort(),
    referenceMarkets: referenceMarketInterfaceHarnessPort(),
    tokenCatalogWebStart: ports.webStart,
    tokenCatalogBrowserOperations: ports.browserOperations,
  });
  return Object.freeze({
    values,
    ports,
    routes,
    runtime: new RouteRegistryRuntime(routes),
    close: async () => {
      credentials.close();
      await chain.close();
    },
  });
};

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
        const http = await dispatchCanonical(runtime, request, 200, entry.identity.responseAuthority);
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
          new LocalOperationClient({ ownerSessions: runtime, createOperationId: () => operationId }),
          parseReadCliCommand([...entry.cliArguments, "--json"]),
          json.port,
        )).toBe(0);
        expect(json.error).toEqual([]);
        expect(JSON.parse(json.output.join(""))).toEqual(entry.direct);

        const human = outputPort();
        expect(await runReadCliCommand(
          runtime,
          new LocalOperationClient({ ownerSessions: runtime, createOperationId: () => operationId }),
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

  it("preserves one V2 quote through HTTP, MCP, CLI JSON, and browser replay", async () => {
    const input = uniswapV2QuoteInputSchema.parse({
      tokenIn: {
        kind: "erc20",
        chainId: "eip155:4663",
        address: `0x${"28".repeat(20)}`,
      },
      tokenOut: {
        kind: "erc20",
        chainId: "eip155:4663",
        address: "0x2700f8aaecf0c1e1e0d8d9f8a2bb5a6eb4fc2f42",
      },
      factory: uniswapV2FactoryAddress,
      amountIn: "1000000000000000000",
      block: { kind: "latest" },
    });
    const direct = captureCanonicalJson(
      await createUniswapV2DirectQuoteSuccess(input),
    );
    const runtime = new CanonicalRuntime([{
      method: uniswapV2QuoteInterface.http.method,
      path: uniswapV2QuoteInterface.http.path,
      body: captureCanonicalJson(input),
      response: Object.freeze({ status: 200, body: direct }),
    }], operation());
    const mcp = await connectMcp(runtime);
    try {
      const request = {
        requestClass: "public_read" as const,
        method: uniswapV2QuoteInterface.http.method,
        path: uniswapV2QuoteInterface.http.path,
        body: captureCanonicalJson(input),
      };
      const http = await dispatchCanonical(
        runtime,
        request,
        200,
        uniswapV2QuoteInterface.responseAuthority,
      );
      expect(http).toEqual({ ok: true, value: direct });

      const mcpResult = await mcp.client.callTool({
        name: uniswapV2QuoteInterface.mcp.name,
        arguments: input,
      });
      expect(mcpResult.isError).not.toBe(true);
      expect(mcpResult.structuredContent).toEqual(direct);
      expect(JSON.parse(mcpText(mcpResult))).toEqual(direct);

      const cli = outputPort();
      expect(await runReadCliCommand(
        runtime,
        new LocalOperationClient({
          ownerSessions: runtime,
          createOperationId: () => operationId,
        }),
        parseReadCliCommand([
          "uniswap-v2",
          "quote-exact-input",
          "--factory",
          input.factory,
          "--token-in",
          input.tokenIn.address,
          "--token-out",
          input.tokenOut.address,
          "--amount-in",
          input.amountIn,
          "--block",
          "latest",
          "--json",
        ]),
        cli.port,
      )).toBe(0);
      expect(cli.error).toEqual([]);
      expect(JSON.parse(cli.output.join(""))).toEqual(direct);

      const browserRequest: BrowserFetch = async (path, init) => {
        expect(path).toBe(uniswapV2QuoteInterface.http.path);
        const response = await runtime.dispatchRuntimeRequest({
          requestClass: "public_read",
          method: init.method,
          path,
          ...(init.body === undefined
            ? {}
            : { body: JSON.parse(init.body) as CanonicalJson }),
          ...(init.signal === undefined ? {} : { signal: init.signal }),
        });
        return {
          ok: response.status === 200,
          status: response.status,
          json: async () => response.body,
        };
      };
      await expect(quoteUniswapV2ExactInput(input, { request: browserRequest }))
        .resolves.toEqual(direct);
    } finally {
      await mcp.close();
    }
  });

  it("preserves token inspection through direct, public HTTP, MCP, CLI, and browser execution", async () => {
    const context = await createTokenParityContext();
    const input = captureCanonicalJson({ asset: context.values.asset, block: { kind: "latest" } });
    const mcp = await connectMcp(context.runtime, () => tokenOperationId);
    try {
      const direct = await invokeBinding(tokenInspectInterface.definition, context.ports.inspection, input);
      expect(direct.ok).toBe(true);
      if (!direct.ok) throw new Error("The direct token inspection failed.");
      expect(withoutInvocationCorrelation(direct)).toEqual(
        withoutInvocationCorrelation(context.values.inspection),
      );

      const http = await invokeRoute(
        context.routes,
        tokenInspectInterface.http.method,
        tokenInspectInterface.http.path,
        input,
      );
      expect(http.ok).toBe(true);
      if (!http.ok || http.response !== "canonical_json") {
        throw new Error("The public token inspection did not return canonical JSON.");
      }
      expect(withoutInvocationCorrelation(http.body)).toEqual(
        withoutInvocationCorrelation(context.values.inspection),
      );

      const mcpResult = await mcp.client.callTool({
        name: tokenInspectInterface.mcp.name,
        arguments: input as Readonly<Record<string, unknown>>,
      });
      expect(mcpResult.isError).not.toBe(true);
      expect(withoutInvocationCorrelation(mcpResult.structuredContent)).toEqual(
        withoutInvocationCorrelation(context.values.inspection),
      );
      expect(withoutInvocationCorrelation(JSON.parse(mcpText(mcpResult)))).toEqual(
        withoutInvocationCorrelation(context.values.inspection),
      );

      const cliOutput: string[] = [];
      const cliError: string[] = [];
      expect(await runTokenCliCommand(
        context.runtime,
        tokenOperationClient(context.runtime),
        parseTokenCliCommand(["token", "inspect", tokenAddress, "--block", "latest", "--json"]),
        terminalPort(cliOutput, cliError),
      )).toBe(0);
      expect(cliError).toEqual([]);
      expect(withoutInvocationCorrelation(JSON.parse(cliOutput.join("")))).toEqual(
        withoutInvocationCorrelation(context.values.inspection),
      );

      const browserRequest: BrowserFetch = async (path, init) => {
        expect(path).toBe(tokenInspectInterface.http.path);
        expect(init).toMatchObject({
          method: "POST",
          credentials: "omit",
          cache: "no-store",
        });
        const response = await invokeRoute(
          context.routes,
          init.method,
          path,
          init.body === undefined ? {} : JSON.parse(init.body),
        );
        if (!response.ok || response.response !== "canonical_json") {
          throw new Error("The public token inspection route did not return canonical JSON.");
        }
        const responseBody = response.body;
        return {
          ok: true,
          status: 200,
          json: async () => responseBody,
        };
      };
      const browser = await inspectTokenContract(input, { request: browserRequest });
      expect(withoutInvocationCorrelation(browser)).toEqual(
        withoutInvocationCorrelation(context.values.inspection),
      );
    } finally {
      await mcp.close();
      await context.close();
    }
  });

  it("preserves token selection reads through direct, local HTTP, MCP, and CLI execution", async () => {
    const context = await createTokenParityContext();
    const selectionInput = tokenCatalogApplicationContracts.selection.parseInput({
      asset: context.values.asset,
    });
    const listInput = tokenCatalogApplicationContracts.selections.parseInput({});
    const nativeSelection = tokenCatalogApplicationContracts.selection.parsePublicSuccess(
      selectionInput,
      context.ports.queries.getSelection(selectionInput),
    );
    const nativeList = tokenCatalogApplicationContracts.selections.parsePublicSuccess(
      listInput,
      context.ports.queries.listSelections({}),
    );
    const mcp = await connectMcp(context.runtime);
    try {
      const selectionPath = tokenCatalogControlRoutes.selection(tokenChainId, tokenAddress);
      expect(await invokeRoute(context.routes, "GET", selectionPath)).toEqual({
        ok: true,
        response: "canonical_json",
        body: nativeSelection,
      });
      expect(await invokeRoute(
        context.routes,
        "POST",
        tokenCatalogControlRoutes.selectionQueries,
        {},
      )).toEqual({ ok: true, response: "canonical_json", body: nativeList });

      const mcpSelection = await mcp.client.callTool({
        name: tokenCatalogInterfaceBindings.selection.mcp.name,
        arguments: selectionInput as Readonly<Record<string, unknown>>,
      });
      const mcpList = await mcp.client.callTool({
        name: tokenCatalogInterfaceBindings.selections.mcp.name,
        arguments: {},
      });
      expect(mcpSelection.structuredContent).toEqual(nativeSelection);
      expect(mcpList.structuredContent).toEqual(nativeList);

      const getOutput: string[] = [];
      const getError: string[] = [];
      expect(await runTokenCliCommand(
        context.runtime,
        tokenOperationClient(context.runtime),
        parseTokenCliCommand(["token", "get", tokenAddress, "--json"]),
        terminalPort(getOutput, getError),
      )).toBe(0);
      expect(getError).toEqual([]);
      expect(JSON.parse(getOutput.join(""))).toEqual(nativeSelection);

      const listOutput: string[] = [];
      const listError: string[] = [];
      expect(await runTokenCliCommand(
        context.runtime,
        tokenOperationClient(context.runtime),
        parseTokenCliCommand(["token", "list", "--json"]),
        terminalPort(listOutput, listError),
      )).toBe(0);
      expect(listError).toEqual([]);
      expect(JSON.parse(listOutput.join(""))).toEqual(nativeList);

    } finally {
      await mcp.close();
      await context.close();
    }
  });

  it("preserves token start, exact operation reads, and cancellation through every owning interface", async () => {
    const context = await createTokenParityContext();
    const startContract = tokenCatalogApplicationContracts.startAddition;
    const startInput = startContract.parseInput({
      asset: context.values.asset,
    });
    const nativeStart = startContract.parsePublicSuccess(
      startInput,
      await context.ports.webStart.startAddition(startInput, tokenOperationId),
    );
    const operationInput = tokenCatalogApplicationContracts.operation.parseInput({
      operationId: tokenOperationId,
    });
    const nativeOperation = tokenCatalogApplicationContracts.operation.parsePublicSuccess(
      operationInput,
      context.ports.operations.getOperation(operationInput),
    );
    const nativeCancellation = tokenCatalogApplicationContracts.cancelOperation.parsePublicSuccess(
      operationInput,
      await context.ports.operations.cancelOperation(operationInput),
    );
    const mcp = await connectMcp(context.runtime, () => tokenOperationId);
    try {
      const httpStart = await invokeRoute(
        context.routes,
        "POST",
        tokenCatalogControlRoutes.operations,
        {
          control: { operationId: tokenOperationId, interactionInterface: "web" },
          request: { kind: "add", ...startInput },
        },
      );
      expect(httpStart).toEqual({ ok: true, response: "canonical_json", body: nativeStart });

      const mcpStart = await mcp.client.callTool({
        name: tokenCatalogInterfaceBindings.startAddition.mcp.name,
        arguments: startInput as Readonly<Record<string, unknown>>,
      });
      expect(mcpStart.isError).not.toBe(true);
      expect(mcpStart.structuredContent).toEqual({
        result: nativeStart,
        displayUrl: "http://127.0.0.1:46630/",
      });

      expect(await invokeRoute(
        context.routes,
        "POST",
        tokenCatalogBrowserRoutes.operations,
        {
          control: { operationId: tokenOperationId, interactionInterface: "web" },
          request: { kind: "add", ...startInput },
        },
      )).toEqual({ ok: true, response: "canonical_json", body: nativeStart });

      const cliOutput: string[] = [];
      const cliError: string[] = [];
      const cliTerminal = Object.freeze({
        ...terminalPort(cliOutput, cliError),
        readLine: async () => "y",
      });
      expect(await runTokenCliCommand(
        context.runtime,
        tokenOperationClient(context.runtime),
        parseTokenCliCommand(["token", "add", tokenAddress]),
        cliTerminal,
      )).toBe(0);
      expect(cliError).toEqual([]);
      expect(cliOutput.join("\n")).toContain("Token added.");

      const operationPath = tokenCatalogControlRoutes.operation(tokenOperationId);
      expect(await invokeRoute(context.routes, "GET", operationPath)).toEqual({
        ok: true,
        response: "canonical_json",
        body: nativeOperation,
      });
      const mcpOperation = await mcp.client.callTool({
        name: tokenCatalogInterfaceBindings.operation.mcp.name,
        arguments: operationInput as Readonly<Record<string, unknown>>,
      });
      expect(mcpOperation.structuredContent).toEqual(nativeOperation);
      const operationOutput: string[] = [];
      const operationError: string[] = [];
      expect(await runTokenCliCommand(
        context.runtime,
        tokenOperationClient(context.runtime),
        parseTokenCliCommand(["token", "operation", tokenOperationId, "--json"]),
        terminalPort(operationOutput, operationError),
      )).toBe(0);
      expect(operationError).toEqual([]);
      expect(JSON.parse(operationOutput.join(""))).toEqual(nativeOperation);
      expect(await invokeRoute(
        context.routes,
        "GET",
        tokenCatalogBrowserRoutes.operation(tokenOperationId),
      )).toEqual({ ok: true, response: "canonical_json", body: nativeOperation });

      expect(await invokeRoute(context.routes, "DELETE", operationPath)).toEqual({
        ok: true,
        response: "canonical_json",
        body: nativeCancellation,
      });
      const mcpCancellation = await mcp.client.callTool({
        name: tokenCatalogInterfaceBindings.cancelOperation.mcp.name,
        arguments: operationInput as Readonly<Record<string, unknown>>,
      });
      expect(mcpCancellation.structuredContent).toEqual(nativeCancellation);
      const cancellationOutput: string[] = [];
      const cancellationError: string[] = [];
      expect(await runTokenCliCommand(
        context.runtime,
        tokenOperationClient(context.runtime),
        parseTokenCliCommand(["token", "cancel", tokenOperationId, "--json"]),
        terminalPort(cancellationOutput, cancellationError),
      )).toBe(0);
      expect(cancellationError).toEqual([]);
      expect(JSON.parse(cancellationOutput.join(""))).toEqual(nativeCancellation);
      expect(await invokeRoute(
        context.routes,
        "POST",
        tokenCatalogBrowserRoutes.cancellation(tokenOperationId),
        {},
      )).toEqual({ ok: true, response: "canonical_json", body: nativeCancellation });
    } finally {
      await mcp.close();
      await context.close();
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
    }, 200, walletConnectionInterface.responseAuthority)).toEqual({ ok: true, value: direct });

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
      createOperationId: () => operationId,
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
      createOperationId: () => operationId,
      createRuntime: async () => runtime,
      terminal: terminalPort(humanOutput, humanError),
      waitForPoll: async () => {},
      terminateProcess: () => { throw new Error("The connection parity CLI cannot terminate the process."); },
    }))).toBe(0);
    expect(humanError).toEqual([]);
    expect(humanOutput.join("")).toBe("Disconnected (no_session).\n");
  });

  it("projects one canonical capability catalog through HTTP and MCP without changing core scope or support", async () => {
    const chainSupport = extendChainSupportManifest(
      extendWalletSupportManifest(
        createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain),
      ),
    );
    const tokenSupport = extendTokenCatalogSupportManifest(chainSupport);
    const accountSupport = extendAccountAssetSupportManifest(tokenSupport);
    const referenceSupport = extendReferenceMarketSupportManifest(accountSupport);
    const protocolSupport = extendUniswapV2ProtocolHarnessManifest(referenceSupport);
    const manifest = extendInterfaceSupportManifest(protocolSupport);
    const catalog = composeInterfaceCapabilityCatalog(manifest);
    const runtime = new CanonicalRuntime([Object.freeze({
      method: capabilityCatalogInterface.http.method,
      path: capabilityCatalogInterface.http.path,
      response: Object.freeze({ status: 200, body: catalog as unknown as CanonicalJson }),
    })], operation());

    expect(await dispatchCanonical(runtime, {
      requestClass: "public_read",
      method: capabilityCatalogInterface.http.method,
      path: capabilityCatalogInterface.http.path,
    }, 200, capabilityCatalogInterface.responseAuthority)).toEqual({ ok: true, value: catalog });

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

    const projections = new Map(projectCapabilities(interfaceReadCapabilityRegistry).map((projection) => [
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
    }, 200, chainStatusInterface.responseAuthority);
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
        new LocalOperationClient({ ownerSessions: runtime, createOperationId: () => operationId }),
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
      }, 200, walletConnectionInterface.responseAuthority);
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
        createOperationId: () => operationId,
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
        ...tokenCatalogInterfaceHarnessPorts(),
        accountAssets: accountAssetInterfaceHarnessPort(),
        referenceMarkets: referenceMarketInterfaceHarnessPort(),
        routes: createRuntimeRouteRegistry({
          controlVerifier: createControlCredentialVerifier(authority),
          errorMappings: referenceMarketInterfaceErrorMappings,
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
