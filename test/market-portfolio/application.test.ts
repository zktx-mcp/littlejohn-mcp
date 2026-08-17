import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { extendAccountAssetSupportManifest } from "../../src/account-assets/support.js";
import {
  extendChainSupportManifest,
  createReferenceMarketCallEncoder,
  createReferenceMarketChainReadPort,
  createChainInvocationLifecycle,
  resolveConfiguredCanonicalBlock,
  type ReferenceMarketChainReadPort,
} from "../../src/chain/index.js";
import { ChainOperationError } from "../../src/chain/errors.js";
import type {
  ChainRpcMethod,
  ChainRpcRequestMap,
  RpcRequester,
} from "../../src/chain/rpc.js";
import {
  chainAnchorSchema,
  assertDirectApplicationErrorRegistryExtension,
  createCanonicalClock,
  createExactRational,
  createObservationAuthority,
  evmAccountIdentitySchema,
  parseCapabilityDataAt,
  parseUtcTimestamp,
  referenceMarketManifest,
  referencePriceWarnings,
  referenceRoundObservationSchema,
  referenceWatchlistRevisionSchema,
  sourceReferenceSchema,
  walletConnectionCapability,
  type ApplicationFailure,
  type CanonicalClock,
  type ChainAnchor,
  type ReferenceFeedId,
  type ReferenceHistoryTraversalReport,
  type ReferenceRoundObservation,
  type ReferenceWatchlistSuccess,
} from "../../src/core/index.js";
import { ReferenceMarketApplication } from "../../src/market-portfolio/application.js";
import { createReferenceMarketApplicationFactory } from "../../src/market-portfolio/application-factory.js";
import { unavailableExecutionIndex } from "./execution-index-fixture.js";
import { createReferenceHistory } from "../../src/market-portfolio/candles.js";
import {
  createReferenceWatchlistReviewProjection,
  parseReferenceWatchlistOperation,
  referenceMarketApplicationContracts,
  referenceMarketErrorRegistry,
  type ReferenceWatchlistOperation,
} from "../../src/market-portfolio/contracts.js";
import { ReferenceMarketOperationError } from "../../src/market-portfolio/errors.js";
import type { ReferenceMarketApplicationDependencies } from "../../src/market-portfolio/ports.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import type { RuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import type {
  ReferenceFeedCacheCommit,
  ReferenceFeedCacheSnapshot,
  ReferenceMarketStore,
} from "../../src/runtime/reference-market-storage.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import { parseRuntimeRevision } from "../../src/runtime/runtime-identity.js";
import { createInitialRuntimeSupportManifest } from "../../src/runtime/support-manifest.js";
import { tokenCatalogErrorRegistry } from "../../src/token-catalog/error-registry.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";

const block = chainAnchorSchema.parse({
  chainId: "eip155:4663",
  blockNumber: "16520666",
  blockHash: `0x${"39".repeat(32)}`,
  blockTimestamp: "2026-07-22T00:07:00.000Z",
});
const account = evmAccountIdentitySchema.parse({
  chainId: "eip155:4663",
  address: `0x${"12".repeat(20)}`,
});
const connectionRevision = parseRuntimeRevision("1");
const rpcConfigurationDigest = "A".repeat(43);
const abiWord = (value: bigint): string => value.toString(16).padStart(64, "0");
const encodedText = (value: string): string => {
  const bytes = Buffer.from(value, "utf8");
  const padding = (32 - bytes.length % 32) % 32;
  return `0x${abiWord(32n)}${abiWord(BigInt(bytes.length))}${bytes.toString("hex")}${"0".repeat(padding * 2)}`;
};
const walletConnection = parseCapabilityDataAt(walletConnectionCapability, {
  status: "connected",
  ...account,
  approvedMethods: ["eth_sendTransaction"],
  approvedEvents: ["accountsChanged", "chainChanged"],
  expiresAt: "2026-07-23T00:07:00.000Z",
}, parseUtcTimestamp("2026-07-22T00:07:00.000Z"));

describe("reference market contract authority", () => {
  it("uses one token-catalog-parented registry and one contract graph", () => {
    expect(() => assertDirectApplicationErrorRegistryExtension(
      tokenCatalogErrorRegistry,
      referenceMarketErrorRegistry,
    )).not.toThrow();
    for (const contract of Object.values(referenceMarketApplicationContracts)) {
      expect(contract.applicationContract.errorRegistry).toBe(referenceMarketErrorRegistry);
      expect(contract.contractVersion).toBe(contract.applicationContract.contractVersion);
      expect(contract.contractVersion).toBe("1");
    }
  });
});

const observation = (input: Readonly<{
  feedId: ReferenceFeedId;
  roundId: string;
  answer: string;
  updatedAt: string;
  readBlock?: ChainAnchor;
}>): ReferenceRoundObservation => {
  const feed = referenceMarketManifest.feeds.find((entry) => entry.feedId === input.feedId)!;
  const seconds = Math.floor(Date.parse(input.updatedAt) / 1_000).toString(10);
  return referenceRoundObservationSchema.parse({
    fact: {
      manifestVersion: 1,
      feedId: input.feedId,
      proxyAddress: feed.standardProxy,
      decimals: 8,
      roundId: input.roundId,
      answeredInRound: input.roundId,
      answer: input.answer,
      startedAtUnixSeconds: seconds,
      updatedAtUnixSeconds: seconds,
      value: createExactRational(BigInt(input.answer), 100_000_000n),
    },
    readEvidence: {
      observedAt: "2026-07-22T00:07:00.000Z",
      sourceOwner: "user_configured",
      sourceClass: "chain_rpc",
      sourceReference: {
        kind: "configured_rpc",
        sourceId: `rpc:${rpcConfigurationDigest}`,
        publicOrigin: "https://rpc.example",
        configurationDigest: rpcConfigurationDigest,
      },
      block: input.readBlock ?? block,
    },
  });
};

const latestEth = observation({
  feedId: "eth_usd",
  roundId: "18446744073709552818",
  answer: "193384405462",
  updatedAt: "2026-07-22T00:02:00.000Z",
});
const latestUsdg = observation({
  feedId: "usdg_usd",
  roundId: "18446744073709551663",
  answer: "100008000",
  updatedAt: "2026-07-21T23:55:00.000Z",
});
const encodedLatestEthRound = (): string => `0x${[
  latestEth.fact.roundId,
  latestEth.fact.answer,
  latestEth.fact.startedAtUnixSeconds,
  latestEth.fact.updatedAtUnixSeconds,
  latestEth.fact.answeredInRound,
].map((value) => abiWord(BigInt(value))).join("")}`;

type FixtureChainFactory = (input: Readonly<{
  lifecycle: ReturnType<typeof createChainInvocationLifecycle>;
  clock: CanonicalClock;
}>) => ReferenceMarketChainReadPort;

const createBackwardsClockChain: FixtureChainFactory = ({ lifecycle, clock }) => {
  const feed = referenceMarketManifest.feeds[0]!;
  const encoder = createReferenceMarketCallEncoder();
  clock.now();
  const rpc: RpcRequester = {
    async request<Method extends ChainRpcMethod>(
      method: Method,
      params: ChainRpcRequestMap[Method],
    ): Promise<unknown> {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getBlockByNumber") {
        return {
          number: `0x${BigInt(block.blockNumber).toString(16)}`,
          hash: block.blockHash,
          timestamp: `0x${BigInt(Math.floor(Date.parse(block.blockTimestamp) / 1_000)).toString(16)}`,
        };
      }
      if (method === "eth_getCode") return "0x6000";
      if (method !== "eth_call") throw new Error(`Unexpected fixture RPC method: ${method}`);
      const call = params[0] as { readonly to: string; readonly data: string };
      if (call.to !== feed.standardProxy) throw new Error(`Unexpected reference feed: ${call.to}`);
      if (call.data === encoder.description()) return encodedText(feed.expectedDescription);
      if (call.data === encoder.decimals()) return `0x${abiWord(BigInt(feed.decimals))}`;
      if (call.data === encoder.latestRoundData()) return encodedLatestEthRound();
      throw new Error(`Unexpected reference feed call: ${call.data}`);
    },
  };
  return createReferenceMarketChainReadPort({
    rpc,
    encoder,
    chainId: account.chainId,
    lifecycle,
    clock,
    observationAuthority: createObservationAuthority({
      clock,
      sourceClass: "chain_rpc",
      owner: "user_configured",
      reference: sourceReferenceSchema.parse({
        kind: "configured_rpc",
        sourceId: `rpc:${rpcConfigurationDigest}`,
        publicOrigin: "https://rpc.example",
        configurationDigest: rpcConfigurationDigest,
      }),
    }),
  });
};

const success = <Value>(value: Value | ApplicationFailure): Value => {
  if (typeof value === "object" && value !== null && "ok" in value && value.ok === false) {
    throw new Error(`Unexpected failure: ${value.error.code}`);
  }
  return value as Value;
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const pendingUntilAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    const abort = (): void => reject(new DOMException("Aborted.", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

const traversalReport = (
  overrides: Partial<ReferenceHistoryTraversalReport> = {},
): ReferenceHistoryTraversalReport => Object.freeze({
  remainingContinuation: false,
  remainingGap: false,
  phaseBoundaryObserved: false,
  malformedRoundObserved: false,
  ...overrides,
});

const traversalReportsFor = (
  feedIds: readonly ReferenceFeedId[],
  overrides: Partial<Record<ReferenceFeedId, Partial<ReferenceHistoryTraversalReport>>> = {},
): ReadonlyMap<ReferenceFeedId, ReferenceHistoryTraversalReport> =>
  new Map(feedIds.map((feedId) => [feedId, traversalReport(overrides[feedId])]));

const cancellationScenarios = Object.freeze([
  {
    name: "caller abort followed by close",
    order: "caller_then_close",
    expectedCode: "request_aborted",
  },
  {
    name: "close followed by caller abort before projection",
    order: "close_then_caller",
    expectedCode: "request_aborted",
  },
  {
    name: "close without caller abort",
    order: "close_only",
    expectedCode: "runtime_state_unavailable",
  },
] as const);

const readSettlementStructureViolations = (sourceText: string): readonly string[] => {
  const source = ts.createSourceFile(
    "application.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const compact = (node: ts.Node): string => node.getText(source).replace(/\s+/gu, "");
  const application = source.statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === "ReferenceMarketApplication");
  const runRead = application?.members.find((member): member is ts.MethodDeclaration =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === "#runRead");
  if (runRead?.body === undefined) return ["run_read"];

  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(runRead.body);
  const declarations = nodes.filter((node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) &&
    node.type !== undefined &&
    compact(node.type) === "ReadSettlement<Success>");
  if (
    declarations.length !== 1 ||
    !ts.isIdentifier(declarations[0]!.name) ||
    declarations[0]!.initializer !== undefined ||
    declarations[0]!.exclamationToken !== undefined
  ) return ["settlement_declaration"];
  const settlementName = declarations[0]!.name.text;
  const assignments = nodes.filter((node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(node.left) &&
    node.left.text === settlementName);
  const stateLiteral = (assignment: ts.BinaryExpression): ts.ObjectLiteralExpression | undefined => {
    const expression = assignment.right;
    if (ts.isObjectLiteralExpression(expression)) return expression;
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.expression.getText(source) === "Object" &&
      expression.expression.name.text === "freeze" &&
      expression.arguments.length === 1 &&
      ts.isObjectLiteralExpression(expression.arguments[0]!)
    ) return expression.arguments[0];
    return undefined;
  };
  const propertyValue = (
    literal: ts.ObjectLiteralExpression,
    name: string,
  ): ts.Expression | undefined => {
    const property = literal.properties.find((candidate) => candidate.name?.getText(source) === name);
    if (property === undefined) return undefined;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    return ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
  };
  const states = assignments.map((assignment) => ({
    assignment,
    literal: stateLiteral(assignment),
  }));
  const fulfilled = states.find(({ literal }) => {
    const status = literal === undefined ? undefined : propertyValue(literal, "status");
    return status !== undefined && ts.isStringLiteral(status) && status.text === "fulfilled";
  });
  const rejected = states.find(({ literal }) => {
    const status = literal === undefined ? undefined : propertyValue(literal, "status");
    return status !== undefined && ts.isStringLiteral(status) && status.text === "rejected";
  });
  if (
    assignments.length !== 2 ||
    fulfilled?.literal === undefined ||
    rejected?.literal === undefined ||
    fulfilled.literal.properties.length !== 2 ||
    rejected.literal.properties.length !== 2
  ) return ["settlement_creation"];
  const fulfilledValue = propertyValue(fulfilled.literal, "value");
  const rejectedReason = propertyValue(rejected.literal, "reason");
  const fulfilledTry = nodes.find((node): node is ts.TryStatement =>
    ts.isTryStatement(node) && node.tryBlock.pos <= fulfilled.assignment.pos &&
    fulfilled.assignment.end <= node.tryBlock.end);
  const rejectedCatch = nodes.find((node): node is ts.CatchClause =>
    ts.isCatchClause(node) && node.block.pos <= rejected.assignment.pos &&
    rejected.assignment.end <= node.block.end);
  if (
    fulfilledTry?.catchClause !== rejectedCatch ||
    !ts.isAwaitExpression(fulfilledValue!) ||
    !ts.isCallExpression(fulfilledValue.expression) ||
    !ts.isIdentifier(fulfilledValue.expression.expression) ||
    fulfilledValue.expression.expression.text !== "operation" ||
    rejectedCatch?.variableDeclaration === undefined ||
    !ts.isIdentifier(rejectedCatch.variableDeclaration.name) ||
    !ts.isIdentifier(rejectedReason!) ||
    rejectedReason.text !== rejectedCatch.variableDeclaration.name.text
  ) return ["settlement_origin"];
  const properties = nodes.filter((node): node is ts.PropertyAccessExpression =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === settlementName);
  const statusUses = properties.filter((property) => property.name.text === "status");
  const valueUses = properties.filter((property) => property.name.text === "value");
  const reasonUses = properties.filter((property) => property.name.text === "reason");
  const valueCall = valueUses[0]?.parent;
  const reasonCall = reasonUses[0]?.parent;
  const valueIsDirectSuccess =
    valueUses.length === 1 &&
    valueCall !== undefined &&
    ts.isCallExpression(valueCall) &&
    valueCall.arguments[1] === valueUses[0] &&
    ts.isPropertyAccessExpression(valueCall.expression) &&
    valueCall.expression.name.text === "parsePublicSuccess";
  const reasonIsDirectFailure =
    reasonUses.length === 1 &&
    reasonCall !== undefined &&
    ts.isCallExpression(reasonCall) &&
    reasonCall.arguments[1] === reasonUses[0] &&
    ts.isIdentifier(reasonCall.expression) &&
    reasonCall.expression.text === "parseFailure";
  return statusUses.length > 0 &&
    valueIsDirectSuccess &&
    reasonIsDirectFailure
    ? []
    : ["settlement_projection"];
};
const fixture = (createChain?: FixtureChainFactory) => {
  const chainOwner = new AbortController();
  const lifecycle = createChainInvocationLifecycle(chainOwner.signal);
  let currentTime = "2026-07-22T00:07:00.000Z";
  const clock = createCanonicalClock(() => currentTime);
  const rpc: RpcRequester = {
    async request<Method extends ChainRpcMethod>(
      method: Method,
      _params: ChainRpcRequestMap[Method],
    ): Promise<unknown> {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_getBlockByNumber") {
        return {
          number: `0x${BigInt(block.blockNumber).toString(16)}`,
          hash: block.blockHash,
          timestamp: `0x${BigInt(Math.floor(Date.parse(block.blockTimestamp) / 1_000)).toString(16)}`,
        };
      }
      throw new Error(`Unexpected fixture RPC method: ${method}`);
    },
  };
  let watchlist: ReferenceWatchlistSuccess = {
    account,
    revision: referenceWatchlistRevisionSchema.parse("AAAAAAAAAAAAAAAAAAAAAA"),
    entries: [],
  };
  const watchlistRevisions = [
    "AgICAgICAgICAgICAgICAg",
    "AwMDAwMDAwMDAwMDAwMDAw",
    "BAQEBAQEBAQEBAQEBAQEBA",
    "BQUFBQUFBQUFBQUFBQUFBQ",
  ] as const;
  let watchlistMutationIndex = 0;
  let watchlistMutationCalls = 0;
  const operations = new Map<string, ReferenceWatchlistOperation>();
  let feedReadCalls = 0;
  let feedCommitCalls = 0;
  const store: ReferenceMarketStore = {
    readFeed: (feedId) => {
      feedReadCalls += 1;
      return {
        feedId,
        revision: null,
        observations: [],
        backfillPhaseId: null,
        backfillNextRoundId: null,
        retentionCutoffRoundId: null,
        integrityStatus: null,
        backfillStatus: null,
      };
    },
    commitFeed: (input: ReferenceFeedCacheCommit) => {
      feedCommitCalls += 1;
      return {
        feedId: input.feedId,
        revision: "AQEBAQEBAQEBAQEBAQEBAQ",
        observations: input.observations,
        backfillPhaseId: input.backfillPhaseId,
        backfillNextRoundId: input.backfillNextRoundId,
        retentionCutoffRoundId: null,
        integrityStatus: null,
        backfillStatus: input.backfillStatus,
      };
    },
    readWatchlist: () => watchlist,
    readWatchlistOperation: (operationId) => operations.get(operationId) ?? null,
    applyWatchlistChange: ({ action, completedAt }) => {
      const existing = operations.get(action.review.operationId);
      if (existing !== undefined) return existing;
      watchlistMutationCalls += 1;
      const projection = action.review.kind === "reorder"
        ? createReferenceWatchlistReviewProjection({
            kind: action.review.kind,
            currentEntries: watchlist.entries,
            pairIds: action.review.target.entries.map((entry) => entry.pairId),
          })
        : createReferenceWatchlistReviewProjection({
            kind: action.review.kind,
            currentEntries: watchlist.entries,
            pairId: action.review.target.pair.pairId,
          });
      if (projection.status !== "success") throw new Error(projection.reason);
      watchlist = {
        account,
        revision: referenceWatchlistRevisionSchema.parse(
          watchlistRevisions[watchlistMutationIndex++]!,
        ),
        entries: [...projection.projection.nextEntries],
      };
      const operation = parseReferenceWatchlistOperation({
        contractVersion: "1",
        domain: "reference_watchlist",
        operationId: action.review.operationId,
        kind: action.review.kind,
        initiatedBy: action.initiatedBy,
        review: action.review,
        state: "completed",
        completedAt,
        result: {
          outcome: action.review.kind === "add"
            ? "watchlist_pair_added"
            : action.review.kind === "remove"
              ? "watchlist_pair_removed"
              : "watchlist_pairs_reordered",
          watchlist,
        },
      });
      operations.set(operation.operationId, operation);
      return operation;
    },
  };
  let latest = [latestEth, latestUsdg] as readonly ReferenceRoundObservation[];
  let latestRead = async (feedIds: readonly ReferenceFeedId[], _signal: AbortSignal) =>
    feedIds.map((feedId) => latest.find((entry) => entry.fact.feedId === feedId)!);
  let historyRead: ReferenceMarketChainReadPort["readHistoryAtBlock"] = async () => ({
    observations: [],
    backfillPhaseId: "1",
    backfillNextRoundId: null,
    backfillStatus: "phase_boundary",
    phaseBoundaryObserved: true,
    malformedRoundObserved: false,
    failure: undefined,
  });
  let stockTokenRead: ReferenceMarketChainReadPort["readStockTokenAtBlock"] = async () => {
    throw new Error("Stock Token reads are not expected in this fixture.");
  };
  let historyReadCalls = 0;
  const chain: ReferenceMarketChainReadPort = createChain?.({ lifecycle, clock }) ?? {
    resolveCurrentBlock: (context) => resolveConfiguredCanonicalBlock({
      rpc,
      chainId: account.chainId,
      selector: { kind: "latest" },
      context,
    }),
    readLatestAtBlock: (feedIds, _block, context) => latestRead(feedIds, context.signal),
    readHistoryAtBlock: (input, context) => {
      historyReadCalls += 1;
      return historyRead(input, context);
    },
    readStockTokenAtBlock: (input, context) => stockTokenRead(input, context),
  };
  const topicDigest = "A".repeat(43);
  const sessionSourceId = `wallet-session:${topicDigest}`;
  const sessionSource = Object.freeze({
    sourceId: sessionSourceId,
    candidateId: sessionSourceId,
    topicDigest,
    observationAuthority: createObservationAuthority({
      clock,
      sourceClass: "wallet_session",
      owner: "WalletConnect session",
      reference: sourceReferenceSchema.parse({
        kind: "wallet_session",
        sourceId: sessionSourceId,
        topicDigest,
      }),
    }),
  });
  const dependencies = Object.freeze({
    chain,
    chainInvocations: lifecycle,
    store,
    activeWallet: {
      capture: () => ({
        connection: walletConnection,
        connectionRevision,
        sessionSource,
      }),
    },
    officialAssets: Object.freeze({
      synchronize: async () => { throw new Error("Official asset reads are not expected."); },
      readStored: () => undefined,
      close: async () => undefined,
    }),
    stockTokenExecutionIndex: unavailableExecutionIndex,
    clock,
  }) satisfies ReferenceMarketApplicationDependencies;
  const application = new ReferenceMarketApplication(dependencies);
  return {
    application,
    dependencies,
    async close() {
      await application.close();
      await lifecycle.close();
    },
    setLatest(value: readonly ReferenceRoundObservation[]) { latest = value; },
    setLatestRead(value: typeof latestRead) { latestRead = value; },
    setHistoryRead(value: typeof historyRead) { historyRead = value; },
    setNow(value: string) { currentTime = value; },
    currentWatchlist: () => watchlist,
    readOperation: (operationId: string) => operations.get(operationId) ?? null,
    watchlistMutationCalls: () => watchlistMutationCalls,
    counts: () => Object.freeze({
      feedReadCalls,
      feedCommitCalls,
      historyReadCalls,
    }),
  };
};

const accountAssetSupportManifest = extendAccountAssetSupportManifest(
  extendTokenCatalogSupportManifest(
    extendChainSupportManifest(
      extendWalletSupportManifest(
        createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain),
      ),
    ),
  ),
);

const startupOwnerFixture = () => {
  const scope = createResourceOwnershipScope();
  let registrations = 0;
  let registeredResource: Parameters<typeof scope.resources.register>[0] | undefined;
  return {
    scope,
    resources: Object.freeze({
      register(resource: Parameters<typeof scope.resources.register>[0]) {
        registrations += 1;
        registeredResource = resource;
        return scope.resources.register(resource);
      },
    }),
    get registrations() { return registrations; },
    get registeredResource() { return registeredResource; },
  };
};

describe("reference-market application", () => {
  it("keeps the read reducer discriminated before public success parsing", async () => {
    const source = await readFile(
      resolve(import.meta.dirname, "../../src/market-portfolio/application.ts"),
      "utf8",
    );
    expect(readSettlementStructureViolations(source)).toEqual([]);

    const previousReducer = String.raw`
      type ReadSettlement<Value> =
        | Readonly<{ readonly status: "fulfilled"; readonly value: Value }>
        | Readonly<{ readonly status: "rejected"; readonly reason: unknown }>;
      class ReferenceMarketApplication {
        async #runRead<Success>(
          contract: { parsePublicSuccess(request: unknown, value: Success): unknown },
          operation: () => Promise<Success>,
        ) {
          const request = undefined;
          let success: Success | undefined;
          let failure: unknown;
          try { success = await operation(); }
          catch (error) { failure = error; }
          if (failure !== undefined) return parseFailure(contract, failure);
          return contract.parsePublicSuccess(request, success as Success);
        }
      }
    `;
    expect(readSettlementStructureViolations(previousReducer)).toContain(
      "settlement_declaration",
    );
  });

  it("does not recover a provider failure from a local error cause", async () => {
    const context = fixture();
    const cause = new ChainOperationError("source_unavailable");
    const localFailure = Object.freeze(new Error("Local observation capture failed.", { cause }));
    context.setLatestRead(async () => { throw localFailure; });

    await expect(context.application.price({
      pairId: referenceMarketManifest.pairs[0]!.pairId,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    await context.close();
  });

  it("maps the chain read owner's capture failure to the canonical internal result", async () => {
    const context = fixture(createBackwardsClockChain);
    context.setNow("2026-07-22T00:06:59.000Z");

    await expect(context.application.price({
      pairId: referenceMarketManifest.pairs[0]!.pairId,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    await context.close();
  });

  it("keeps an incomplete latest-port result local", async () => {
    const context = fixture();
    context.setLatest([]);

    await expect(context.application.history({
      pairId: referenceMarketManifest.pairs[0]!.pairId,
      window: "1d",
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    await context.close();
  });

  it("keeps undefined history failures observed through the public result", async () => {
    const cases = [{
      name: "direct rejection",
      read: (async () => { throw undefined; }) as ReferenceMarketChainReadPort["readHistoryAtBlock"],
    }, {
      name: "traversal failure record",
      read: (async () => Object.freeze({
        observations: Object.freeze([]),
        backfillPhaseId: "1",
        backfillNextRoundId: null,
        backfillStatus: "phase_boundary" as const,
        phaseBoundaryObserved: true,
        malformedRoundObserved: false,
        failure: Object.freeze({ reason: undefined }),
      })) as ReferenceMarketChainReadPort["readHistoryAtBlock"],
    }] as const;

    for (const scenario of cases) {
      const context = fixture();
      context.setHistoryRead(scenario.read);
      await expect(context.application.history({
        pairId: referenceMarketManifest.pairs[0]!.pairId,
        window: "1d",
      }), scenario.name).resolves.toMatchObject({
        ok: false,
        error: { code: "internal_error" },
      });
      expect(context.counts(), scenario.name).toEqual({
        feedReadCalls: 1,
        feedCommitCalls: 1,
        historyReadCalls: 1,
      });
      await context.close();
    }
  });

  it("returns a current derived price only while both latest sources are fresh", async () => {
    const context = fixture();
    const pairId = referenceMarketManifest.pairs[2]!.pairId;
    const current = success(await context.application.price({ pairId }));
    expect(current).toMatchObject({ status: "current", warnings: referencePriceWarnings });

    context.setLatest([latestEth, observation({
      feedId: "usdg_usd",
      roundId: "18446744073709551662",
      answer: "100008000",
      updatedAt: "2026-07-20T23:55:00.000Z",
    })]);
    const unavailable = success(await context.application.price({ pairId }));
    expect(unavailable).toMatchObject({
      status: "unavailable",
      reason: "derived_sources_not_fresh",
    });
    expect(unavailable).not.toHaveProperty("lastObserved");
    await context.close();
  });

  it("keeps Review creation pure and fixes one exact terminal operation at the mutation", async () => {
    const context = fixture();
    const pairId = referenceMarketManifest.pairs[0]!.pairId;
    const initial = success(await context.application.watchlist({}));
    const reviewed = success(await context.application.reviewWatchlistChange({
      kind: "add",
      pairId,
      expectedRevision: initial.revision,
    })).review;
    expect(context.currentWatchlist()).toEqual(initial);
    expect(context.readOperation(reviewed.operationId)).toBeNull();
    expect(context.watchlistMutationCalls()).toBe(0);

    const operation = success(await context.application.decideWatchlistChange({
      review: reviewed,
      initiatedBy: "mcp_app",
    }));
    expect(operation).toMatchObject({
      operationId: reviewed.operationId,
      review: reviewed,
      state: "completed",
      result: { outcome: "watchlist_pair_added" },
    });
    expect(operation.result.watchlist.entries.map((entry) => entry.pairId)).toEqual([pairId]);
    expect(success(await context.application.getWatchlistOperation({
      operationId: reviewed.operationId,
    }))).toEqual(operation);
    expect(context.watchlistMutationCalls()).toBe(1);

    expect(success(await context.application.decideWatchlistChange({
      review: reviewed,
      initiatedBy: "mcp_app",
    }))).toEqual(operation);
    expect(context.watchlistMutationCalls()).toBe(1);

    await context.application.close();
    const afterClose = await context.application.watchlist({});
    expect(afterClose).toMatchObject({ ok: false, error: { code: "runtime_state_unavailable" } });
    await context.close();
  });

  it("rejects stale and expired direct actions before creating an operation", async () => {
    const stale = fixture();
    const [firstPair, secondPair] = referenceMarketManifest.pairs;
    const initial = success(await stale.application.watchlist({}));
    const firstReview = success(await stale.application.reviewWatchlistChange({
      kind: "add",
      pairId: firstPair!.pairId,
      expectedRevision: initial.revision,
    })).review;
    const secondReview = success(await stale.application.reviewWatchlistChange({
      kind: "add",
      pairId: secondPair!.pairId,
      expectedRevision: initial.revision,
    })).review;
    success(await stale.application.decideWatchlistChange({
      review: secondReview,
      initiatedBy: "cli",
    }));
    await expect(stale.application.decideWatchlistChange({
      review: firstReview,
      initiatedBy: "mcp_app",
    })).resolves.toMatchObject({ ok: false, error: { code: "state_conflict" } });
    expect(stale.readOperation(firstReview.operationId)).toBeNull();
    await stale.close();

    const expired = fixture();
    const expiresFrom = success(await expired.application.watchlist({}));
    const expiredReview = success(await expired.application.reviewWatchlistChange({
      kind: "add",
      pairId: firstPair!.pairId,
      expectedRevision: expiresFrom.revision,
    })).review;
    expired.setNow(expiredReview.actionExpiresAt);
    await expect(expired.application.decideWatchlistChange({
      review: expiredReview,
      initiatedBy: "cli",
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "watchlist_review_expired" },
    });
    expect(expired.currentWatchlist()).toEqual(expiresFrom);
    expect(expired.readOperation(expiredReview.operationId)).toBeNull();
    await expired.close();
  });

  it("publishes a read and close before synchronous dependency reentry", async () => {
    const releaseEffect = deferred();
    let blockReads = 0;
    let effectClose: Promise<void> | undefined;
    let abortClose: Promise<void> | undefined;
    let context!: ReturnType<typeof fixture>;
    context = fixture(() => ({
      resolveCurrentBlock: async (invocation) => {
        blockReads += 1;
        invocation.signal.addEventListener("abort", () => {
          abortClose = context.application.close();
        }, { once: true });
        effectClose = context.application.close();
        await releaseEffect.promise;
        return Object.freeze({ anchor: block });
      },
      readLatestAtBlock: async (feedIds) => feedIds.map((feedId) =>
        [latestEth, latestUsdg].find((entry) => entry.fact.feedId === feedId)!),
      readHistoryAtBlock: async () => { throw new Error("History reads are not expected."); },
      readStockTokenAtBlock: async () => { throw new Error("Stock Token reads are not expected."); },
    }));
    const active = context.application.price({ pairId: referenceMarketManifest.pairs[0]!.pairId });
    if (effectClose === undefined) throw new TypeError("Reference close was not started by the read.");
    expect(abortClose).toBe(effectClose);
    expect(context.application.close()).toBe(effectClose);

    let closeSettled = false;
    void effectClose.then(
      () => { closeSettled = true; },
      () => { closeSettled = true; },
    );
    await new Promise<void>((resolveTurn) => { setImmediate(resolveTurn); });
    expect(closeSettled).toBe(false);
    await expect(context.application.price({
      pairId: referenceMarketManifest.pairs[0]!.pairId,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    expect(blockReads).toBe(1);

    releaseEffect.resolve();
    await expect(active).resolves.toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    await effectClose;
    expect(closeSettled).toBe(true);
    await context.close();
  });

  for (const scenario of cancellationScenarios) {
    it(`fixes active history cancellation precedence for ${scenario.name} and drains settlement`, async () => {
      const context = fixture();
      const caller = new AbortController();
      const readStarted = deferred();
      const readAborted = deferred();
      const releaseCleanup = deferred();
      context.setHistoryRead(async (_input, invocation) => {
        readStarted.resolve();
        await new Promise<void>((resolve) => {
          const abort = (): void => {
            readAborted.resolve();
            resolve();
          };
          if (invocation.signal.aborted) abort();
          else invocation.signal.addEventListener("abort", abort, { once: true });
        });
        await releaseCleanup.promise;
        throw new DOMException("Aborted.", "AbortError");
      });
      const active = context.application.history({
        pairId: referenceMarketManifest.pairs[0]!.pairId,
        window: "1d",
      }, caller.signal);
      await readStarted.promise;

      let closing: Promise<void>;
      if (scenario.order === "caller_then_close") {
        caller.abort();
        closing = context.application.close();
      } else {
        closing = context.application.close();
        if (scenario.order === "close_then_caller") caller.abort();
      }
      await readAborted.promise;
      let closeSettled = false;
      void closing.then(() => { closeSettled = true; });
      await Promise.resolve();
      expect(closeSettled).toBe(false);

      releaseCleanup.resolve();
      await expect(active).resolves.toMatchObject({
        ok: false,
        error: { code: scenario.expectedCode },
      });
      await closing;
      expect(closeSettled).toBe(true);
      expect(context.counts()).toEqual({
        feedReadCalls: 1,
        feedCommitCalls: 1,
        historyReadCalls: 1,
      });
      await context.close();
    });
  }

  for (const scenario of cancellationScenarios) {
    it(`removes a same-feed queued history synchronization for ${scenario.name} without starting it`, async () => {
      const context = fixture();
      const activeReadStarted = deferred();
      const activeReadAborted = deferred();
      const releaseActiveCleanup = deferred();
      const secondLatestRead = deferred();
      let latestReadCalls = 0;
      context.setLatestRead(async (feedIds) => {
        latestReadCalls += 1;
        if (latestReadCalls === 2) secondLatestRead.resolve();
        return feedIds.map((feedId) =>
          [latestEth, latestUsdg].find((entry) => entry.fact.feedId === feedId)!);
      });
      context.setHistoryRead(async (_input, invocation) => {
        activeReadStarted.resolve();
        await new Promise<void>((resolve) => {
          const abort = (): void => {
            activeReadAborted.resolve();
            resolve();
          };
          if (invocation.signal.aborted) abort();
          else invocation.signal.addEventListener("abort", abort, { once: true });
        });
        await releaseActiveCleanup.promise;
        throw new DOMException("Aborted.", "AbortError");
      });

      const pairId = referenceMarketManifest.pairs[0]!.pairId;
      const active = context.application.history({ pairId, window: "1d" });
      await activeReadStarted.promise;
      const caller = new AbortController();
      const queued = context.application.history({ pairId, window: "1d" }, caller.signal);
      await secondLatestRead.promise;
      await Promise.resolve();
      await Promise.resolve();

      let closing: Promise<void>;
      if (scenario.order === "caller_then_close") {
        caller.abort();
        closing = context.application.close();
      } else {
        closing = context.application.close();
        if (scenario.order === "close_then_caller") caller.abort();
      }
      await activeReadAborted.promise;
      await expect(queued).resolves.toMatchObject({
        ok: false,
        error: { code: scenario.expectedCode },
      });
      expect(context.counts()).toEqual({
        feedReadCalls: 1,
        feedCommitCalls: 0,
        historyReadCalls: 1,
      });

      let closeSettled = false;
      void closing.then(() => { closeSettled = true; });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      releaseActiveCleanup.resolve();
      await expect(active).resolves.toMatchObject({
        ok: false,
        error: { code: "runtime_state_unavailable" },
      });
      await closing;
      expect(closeSettled).toBe(true);
      expect(context.counts()).toEqual({
        feedReadCalls: 1,
        feedCommitCalls: 1,
        historyReadCalls: 1,
      });
      await context.close();
    });
  }

  it("keeps one remaining chain deadline across reference price and history reads", async () => {
    vi.useFakeTimers();
    const context = fixture();
    const priceStarted = deferred();
    context.setLatestRead(async (_feedIds, signal) => {
      priceStarted.resolve();
      return await pendingUntilAbort(signal);
    });
    const pendingPrice = context.application.price({
      pairId: referenceMarketManifest.pairs[2]!.pairId,
    });
    await priceStarted.promise;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(pendingPrice).resolves.toMatchObject({
      ok: false,
      error: { code: "chain_response_unavailable" },
    });
    expect(vi.getTimerCount()).toBe(0);

    const latestGate = deferred();
    const latestStarted = deferred();
    let latestSignal: AbortSignal | undefined;
    context.setLatestRead(async (feedIds, signal) => {
      latestSignal = signal;
      latestStarted.resolve();
      await latestGate.promise;
      return feedIds.map((feedId) =>
        [latestEth, latestUsdg].find((entry) => entry.fact.feedId === feedId)!);
    });
    const historyGate = deferred();
    const historyStarted = deferred();
    let historySignal: AbortSignal | undefined;
    context.setHistoryRead(async (_input, invocation) => {
      historySignal = invocation.signal;
      historyStarted.resolve();
      await historyGate.promise;
      return await pendingUntilAbort(invocation.signal);
    });
    const pendingHistory = context.application.history({
      pairId: referenceMarketManifest.pairs[2]!.pairId,
      window: "1d",
    });
    await latestStarted.promise;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(1);
    latestGate.resolve();
    await historyStarted.promise;
    expect(vi.getTimerCount()).toBe(1);
    historyGate.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pendingHistory).resolves.toMatchObject({
      ok: false,
      error: { code: "chain_response_unavailable" },
    });
    expect(historySignal).toBe(latestSignal);
    expect(latestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await context.close();
  });

  it("derives a UTC candle from mutually fresh legs while preserving the older counterpart and skew", () => {
    const ethBefore = observation({
      feedId: "eth_usd",
      roundId: "18446744073709552817",
      answer: "193300000000",
      updatedAt: "2026-07-21T23:50:00.000Z",
    });
    const snapshots = new Map<ReferenceFeedId, ReferenceFeedCacheSnapshot>([
      ["eth_usd", {
        feedId: "eth_usd",
        revision: null,
        observations: [ethBefore, latestEth],
        backfillPhaseId: "1",
        backfillNextRoundId: null,
        retentionCutoffRoundId: null,
        integrityStatus: null,
        backfillStatus: "phase_boundary",
      }],
      ["usdg_usd", {
        feedId: "usdg_usd",
        revision: null,
        observations: [latestUsdg],
        backfillPhaseId: "1",
        backfillNextRoundId: null,
        retentionCutoffRoundId: ((1n << 64n) | 1n).toString(10),
        integrityStatus: null,
        backfillStatus: "phase_boundary",
      }],
    ]);
    const history = createReferenceHistory({
      pair: referenceMarketManifest.pairs[2]!,
      window: "1d",
      block,
      snapshots,
      reports: traversalReportsFor(["eth_usd", "usdg_usd"], {
        eth_usd: { remainingContinuation: true },
        usdg_usd: {
          phaseBoundaryObserved: true,
          malformedRoundObserved: true,
        },
      }),
    });
    expect(history).toMatchObject({
      status: "partial",
      coverage: {
        basis: "observed_rounds",
        requestedStart: "2026-07-21T00:07:00.000Z",
        requestedEnd: block.blockTimestamp,
        limitations: [
          "source_history_not_exhaustive",
          "traversal_incomplete",
          "phase_boundary",
          "malformed_round",
          "retention_limited",
        ],
      },
    });
    expect(history.coverage.emptyBucketStarts).toHaveLength(94);
    expect(history.coverage.emptyBucketStarts[0]).toBe("2026-07-21T00:15:00.000Z");
    expect(history.coverage.emptyBucketStarts).not.toContain(history.coverage.requestedStart);
    expect(history.warnings).toContain("partial_history");
    const final = history.candles.at(-1)!;
    expect(final.openedAt).toBe("2026-07-22T00:00:00.000Z");
    expect(final.closeSourceSkewSeconds).toBe("420");
    const byIdentity = new Map(history.sourceObservations.map((entry) => [
      `${entry.fact.feedId}:${entry.fact.roundId}`,
      entry,
    ]));
    expect(final.closeSourcePointers.map((pointer) =>
      byIdentity.get(`${pointer.feedId}:${pointer.roundId}`)?.fact.updatedAtUnixSeconds)).toEqual([
      String(Date.parse("2026-07-22T00:02:00.000Z") / 1_000),
      String(Date.parse("2026-07-21T23:55:00.000Z") / 1_000),
    ]);
  });

  it("orders a candle by source time when composite round identities are nonmonotonic", () => {
    const boundaryBlock = chainAnchorSchema.parse({
      ...block,
      blockTimestamp: "2026-07-22T00:15:00.000Z",
    });
    const observations = [
      ["5", "150000000", "2026-07-22T00:01:00.000Z"],
      ["2", "250000000", "2026-07-22T00:02:00.000Z"],
      ["4", "50000000", "2026-07-22T00:03:00.000Z"],
      ["3", "200000000", "2026-07-22T00:04:00.000Z"],
    ].map(([round, answer, updatedAt]) => observation({
      feedId: "eth_usd",
      roundId: ((1n << 64n) | BigInt(round!)).toString(10),
      answer: answer!,
      updatedAt: updatedAt!,
      readBlock: boundaryBlock,
    }));
    const history = createReferenceHistory({
      pair: referenceMarketManifest.pairs[0]!,
      window: "1d",
      block: boundaryBlock,
      snapshots: new Map<ReferenceFeedId, ReferenceFeedCacheSnapshot>([["eth_usd", {
        feedId: "eth_usd",
        revision: null,
        observations,
        backfillPhaseId: "1",
        backfillNextRoundId: null,
        retentionCutoffRoundId: null,
        integrityStatus: null,
        backfillStatus: "phase_boundary",
      }]]),
      reports: traversalReportsFor(["eth_usd"], {
        eth_usd: { phaseBoundaryObserved: true },
      }),
    });
    expect(history.status).toBe("partial");
    expect(history.coverage.limitations[0]).toBe("source_history_not_exhaustive");
    expect(history.candles.at(-1)).toMatchObject({
      open: { numerator: "3", denominator: "2" },
      high: { numerator: "5", denominator: "2" },
      low: { numerator: "1", denominator: "2" },
      close: { numerator: "2", denominator: "1" },
      openSourcePointers: [{ feedId: "eth_usd", roundId: observations[0]!.fact.roundId }],
      highSourcePointers: [{ feedId: "eth_usd", roundId: observations[1]!.fact.roundId }],
      lowSourcePointers: [{ feedId: "eth_usd", roundId: observations[2]!.fact.roundId }],
      closeSourcePointers: [{ feedId: "eth_usd", roundId: observations[3]!.fact.roundId }],
    });
  });

  it("admits a cross-feed source exactly at its heartbeat and rejects one second beyond it", () => {
    const newerTime = "2026-07-22T00:06:00.000Z";
    const newer = observation({
      feedId: "usdg_usd",
      roundId: ((1n << 64n) | 3n).toString(10),
      answer: "100000000",
      updatedAt: newerTime,
    });
    const historyFor = (olderTime: string) => {
      const older = observation({
        feedId: "eth_usd",
        roundId: ((1n << 64n) | 2n).toString(10),
        answer: "300000000000",
        updatedAt: olderTime,
      });
      const snapshot = (
        feedId: ReferenceFeedId,
        observations: readonly ReferenceRoundObservation[],
      ): ReferenceFeedCacheSnapshot => ({
        feedId,
        revision: null,
        observations,
        backfillPhaseId: "1",
        backfillNextRoundId: null,
        retentionCutoffRoundId: null,
        integrityStatus: null,
        backfillStatus: "phase_boundary",
      });
      return createReferenceHistory({
        pair: referenceMarketManifest.pairs[2]!,
        window: "1d",
        block,
        snapshots: new Map<ReferenceFeedId, ReferenceFeedCacheSnapshot>([
          ["eth_usd", snapshot("eth_usd", [older])],
          ["usdg_usd", snapshot("usdg_usd", [newer])],
        ]),
        reports: traversalReportsFor(["eth_usd", "usdg_usd"], {
          eth_usd: { phaseBoundaryObserved: true },
          usdg_usd: { phaseBoundaryObserved: true },
        }),
      });
    };

    const boundary = historyFor("2026-07-21T00:06:00.000Z");
    expect(boundary.status).toBe("partial");
    expect(boundary.candles.at(-1)).toMatchObject({
      close: { numerator: "3000", denominator: "1" },
      closeSourcePointers: [
        { feedId: "eth_usd" },
        { feedId: "usdg_usd" },
      ],
      closeSourceSkewSeconds: "86400",
    });

    const stale = historyFor("2026-07-21T00:05:59.000Z");
    expect(stale).toMatchObject({
      status: "unavailable",
      reason: "no_valid_observation",
      candles: [],
      sourceObservations: [],
    });
  });

  it("reports no-valid-observation without fabricating source evidence", () => {
    const snapshots = new Map<ReferenceFeedId, ReferenceFeedCacheSnapshot>([
      ["eth_usd", {
        feedId: "eth_usd",
        revision: null,
        observations: [],
        backfillPhaseId: null,
        backfillNextRoundId: null,
        retentionCutoffRoundId: null,
        integrityStatus: null,
        backfillStatus: null,
      }],
    ]);
    const history = createReferenceHistory({
      pair: referenceMarketManifest.pairs[0]!,
      window: "1d",
      block,
      snapshots,
      reports: traversalReportsFor(["eth_usd"]),
    });
    expect(history).toMatchObject({
      status: "unavailable",
      reason: "no_valid_observation",
      coverage: {
        basis: "observed_rounds",
        requestedStart: "2026-07-21T00:07:00.000Z",
        requestedEnd: block.blockTimestamp,
        limitations: ["source_history_not_exhaustive"],
      },
      candles: [],
      sourceObservations: [],
    });
    expect(history.coverage.emptyBucketStarts).toHaveLength(96);
    expect(history.warnings).not.toContain("partial_history");
  });

  it("keeps observed buckets while exposing a local retention limitation", () => {
    const boundaryBlock = chainAnchorSchema.parse({
      ...block,
      blockTimestamp: "2026-07-22T00:00:00.000Z",
    });
    const requestedStart = Date.parse(boundaryBlock.blockTimestamp) - 24 * 60 * 60 * 1_000;
    const pointTimes = Array.from({ length: 96 }, (_, index) =>
      new Date(requestedStart + index * 15 * 60 * 1_000 + 60_000).toISOString());
    const observationsFor = (feedId: ReferenceFeedId, answer: string) =>
      pointTimes.map((updatedAt, index) => observation({
        feedId,
        roundId: ((1n << 64n) | BigInt(index + 2)).toString(10),
        answer,
        updatedAt,
        readBlock: boundaryBlock,
      }));
    const snapshot = (
      feedId: ReferenceFeedId,
      observations: readonly ReferenceRoundObservation[],
    ): ReferenceFeedCacheSnapshot => ({
      feedId,
      revision: null,
      observations,
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      retentionCutoffRoundId: ((1n << 64n) | 1n).toString(10),
      integrityStatus: null,
      backfillStatus: "retention_boundary",
    });
    const eth = snapshot("eth_usd", observationsFor("eth_usd", "300000000000"));
    const usdg = snapshot("usdg_usd", observationsFor("usdg_usd", "100000000"));

    for (const [pairIndex, snapshots] of [
      [0, new Map<ReferenceFeedId, ReferenceFeedCacheSnapshot>([["eth_usd", eth]])],
      [2, new Map<ReferenceFeedId, ReferenceFeedCacheSnapshot>([
        ["eth_usd", eth],
        ["usdg_usd", usdg],
      ])],
    ] as const) {
      const history = createReferenceHistory({
        pair: referenceMarketManifest.pairs[pairIndex]!,
        window: "1d",
        block: boundaryBlock,
        snapshots,
        reports: traversalReportsFor(referenceMarketManifest.pairs[pairIndex]!.contract.sourceIds),
      });
      expect(history.status).toBe("partial");
      expect(history.coverage).toMatchObject({
        basis: "observed_rounds",
        emptyBucketStarts: [],
        limitations: ["source_history_not_exhaustive", "retention_limited"],
      });
      expect(history.candles).toHaveLength(96);
    }
  });

  it("closes an exact UTC-boundary bucket and opens only a truncated final bucket", () => {
    const exactBoundary = chainAnchorSchema.parse({
      ...block,
      blockTimestamp: "2026-07-22T00:15:00.000Z",
    });
    const closedPoints = [
      observation({
        feedId: "eth_usd",
        roundId: ((1n << 64n) | 2n).toString(10),
        answer: "300000000000",
        updatedAt: "2026-07-22T00:10:00.000Z",
        readBlock: exactBoundary,
      }),
      observation({
        feedId: "eth_usd",
        roundId: ((1n << 64n) | 3n).toString(10),
        answer: "310000000000",
        updatedAt: exactBoundary.blockTimestamp,
        readBlock: exactBoundary,
      }),
    ];
    const snapshotFor = (
      observations: readonly ReferenceRoundObservation[],
    ): ReferenceFeedCacheSnapshot => ({
      feedId: "eth_usd",
      revision: null,
      observations,
      backfillPhaseId: "1",
      backfillNextRoundId: null,
      retentionCutoffRoundId: null,
      integrityStatus: null,
      backfillStatus: "phase_boundary",
    });
    const closed = createReferenceHistory({
      pair: referenceMarketManifest.pairs[0]!,
      window: "1d",
      block: exactBoundary,
      snapshots: new Map([["eth_usd", snapshotFor(closedPoints)]]),
      reports: traversalReportsFor(["eth_usd"], {
        eth_usd: { phaseBoundaryObserved: true },
      }),
    }).candles.at(-1)!;
    expect(closed).toMatchObject({
      openedAt: "2026-07-22T00:00:00.000Z",
      closedAt: exactBoundary.blockTimestamp,
      openBucket: false,
      closeSourcePointers: [{ feedId: "eth_usd", roundId: closedPoints[0]!.fact.roundId }],
    });

    const truncatedPoint = observation({
      feedId: "eth_usd",
      roundId: ((1n << 64n) | 4n).toString(10),
      answer: "320000000000",
      updatedAt: block.blockTimestamp,
      readBlock: block,
    });
    const open = createReferenceHistory({
      pair: referenceMarketManifest.pairs[0]!,
      window: "1d",
      block,
      snapshots: new Map([["eth_usd", snapshotFor([truncatedPoint])]]),
      reports: traversalReportsFor(["eth_usd"], {
        eth_usd: { phaseBoundaryObserved: true },
      }),
    }).candles.at(-1)!;
    expect(open).toMatchObject({
      openedAt: "2026-07-22T00:00:00.000Z",
      closedAt: block.blockTimestamp,
      openBucket: true,
      closeSourcePointers: [{ feedId: "eth_usd", roundId: truncatedPoint.fact.roundId }],
    });
  });
});

describe("reference-market application factory", () => {
  it("shares its in-flight close and releases successful startup ownership", async () => {
    const context = fixture();
    const startup = startupOwnerFixture();
    const routes = Object.freeze({}) as RuntimeRouteRegistry;
    const application = await createReferenceMarketApplicationFactory({
      ...context.dependencies,
      routes,
      supportManifest: accountAssetSupportManifest,
      startupResources: startup.resources,
    });
    expect(startup.registrations).toBe(1);
    expect(startup.scope.empty).toBe(true);
    expect(application.routes).toBe(routes);

    const closing = application.close();
    expect(application.close()).toBe(closing);
    let admissionFailure: unknown;
    try {
      application.price({ pairId: referenceMarketManifest.pairs[0]!.pairId });
    } catch (error) {
      admissionFailure = error;
    }
    expect(admissionFailure).toBeInstanceOf(ReferenceMarketOperationError);
    expect((admissionFailure as ReferenceMarketOperationError).failure.error.code)
      .toBe("runtime_state_unavailable");
    await closing;
    await context.close();
  });

  it("releases startup ownership after successful rollback", async () => {
    const context = fixture();
    const startup = startupOwnerFixture();
    const startupFailure = createReferenceMarketApplicationFactory({
      ...context.dependencies,
      routes: Object.freeze({}) as RuntimeRouteRegistry,
      supportManifest: Object.freeze({}) as never,
      startupResources: startup.resources,
    });
    expect(startup.registrations).toBe(1);
    expect(startup.registeredResource).toMatchObject({ sealed: true, size: 1 });
    await expect(startupFailure).rejects.toThrow();
    expect(startup.scope.empty).toBe(true);
    await context.close();
  });
});
