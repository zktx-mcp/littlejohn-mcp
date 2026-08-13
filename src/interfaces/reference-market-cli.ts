import {
  canonicalJsonStringify,
  referenceMarketWarningDefinitions,
  stockTokenMarketLimitationDefinitions,
  type CanonicalJson,
  type ChainAnchor,
  type OperationId,
  type ReferenceHistorySuccess,
  type ReferenceMarketMappingEvidence,
  type ReferencePriceSuccess,
  type ReferenceRoundObservation,
  type ReferenceWatchlistSuccess,
  type SourceReference,
} from "../core/index.js";
import {
  createReferenceMarketFailure,
  referenceMarketApplicationContracts,
  referenceMarketInterfaceErrorMappings,
  type ReferenceWatchlistOperation,
  type ReferenceWatchlistReview,
  type StockTokenMarketResult,
} from "../market-portfolio/index.js";
import {
  referenceMarketInterfaceBindings,
} from "./identities.js";
import { deliveryUnknownCliExitCode } from "./delivery-exit.js";
import { LocalOperationClient } from "./operation-client.js";
import { runAtomicCliDecision } from "./cli-operation.js";
import { operationInterfaceBindings } from "./operation-bindings.js";
import { dispatchReferenceMarketRead } from "./reference-market-http.js";
import type { RuntimeDispatchPort } from "./http-client.js";
import {
  stockTokenExecutionLimitationLabel,
  stockTokenExecutionUnavailableReasonLabel,
  stockTokenMarketUnavailableReasonLabel,
} from "./stock-token-market-presentation.js";

type ReferenceMarketCliBase = { readonly json: boolean };
export type ReferenceMarketCliCommand =
  | (ReferenceMarketCliBase & { readonly kind: "price"; readonly input: ReturnType<typeof referenceMarketApplicationContracts.price.parseInput> })
  | (ReferenceMarketCliBase & { readonly kind: "history"; readonly input: ReturnType<typeof referenceMarketApplicationContracts.history.parseInput> })
  | (ReferenceMarketCliBase & { readonly kind: "stockTokenMarket"; readonly input: ReturnType<typeof referenceMarketApplicationContracts.stockTokenMarket.parseInput> })
  | (ReferenceMarketCliBase & { readonly kind: "watchlist"; readonly input: Record<string, never> })
  | (ReferenceMarketCliBase & { readonly kind: "add"; readonly input: ReturnType<typeof referenceMarketApplicationContracts.watchlistChangeReview.parseInput> })
  | (ReferenceMarketCliBase & { readonly kind: "remove"; readonly input: ReturnType<typeof referenceMarketApplicationContracts.watchlistChangeReview.parseInput> })
  | (ReferenceMarketCliBase & { readonly kind: "reorder"; readonly input: ReturnType<typeof referenceMarketApplicationContracts.watchlistChangeReview.parseInput> })
  | (ReferenceMarketCliBase & { readonly kind: "operation"; readonly operationId: OperationId });

export interface ReferenceMarketCliOutputPort {
  readonly inputIsTTY: boolean;
  readonly outputIsTTY: boolean;
  readonly interruptSignal: AbortSignal;
  writeOutput(value: string): void;
  writeError(value: string): void;
  readLine(prompt: string): Promise<string>;
}

export const referenceMarketCliCommandRequiresInteractiveTerminal = (
  command: ReferenceMarketCliCommand,
): boolean => command.kind === "add" || command.kind === "remove" || command.kind === "reorder";

const invalidInput = (): never => { throw new TypeError("Reference market CLI input is invalid."); };

const parseArguments = (tokens: readonly string[]): Readonly<{
  json: boolean;
  positionals: readonly string[];
  revision?: string;
  window?: string;
}> => {
  let json = false;
  let revision: string | undefined;
  let window: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--json") {
      if (json) return invalidInput();
      json = true;
      continue;
    }
    if (token === "--revision" || token === "--window") {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) return invalidInput();
      if (token === "--revision") {
        if (revision !== undefined) return invalidInput();
        revision = value;
      } else {
        if (window !== undefined) return invalidInput();
        window = value;
      }
      index += 1;
      continue;
    }
    if (token?.startsWith("--") || token === undefined) return invalidInput();
    positionals.push(token);
  }
  return Object.freeze({
    json,
    positionals: Object.freeze(positionals),
    ...(revision === undefined ? {} : { revision }),
    ...(window === undefined ? {} : { window }),
  });
};

export const parseReferenceMarketCliCommand = (
  argumentsInput: readonly string[],
): ReferenceMarketCliCommand => {
  const [domain, command, ...tokens] = argumentsInput;
  if (domain !== "market" || command === undefined) return invalidInput();
  const parsed = parseArguments(tokens);
  try {
    if (command === referenceMarketInterfaceBindings.price.cli.command &&
      parsed.positionals.length === 1 && parsed.window === undefined && parsed.revision === undefined) {
      return Object.freeze({
        kind: "price", json: parsed.json,
        input: referenceMarketApplicationContracts.price.parseInput({ pairId: parsed.positionals[0] }),
      });
    }
    if (command === referenceMarketInterfaceBindings.history.cli.command &&
      parsed.positionals.length === 1 && parsed.window !== undefined && parsed.revision === undefined) {
      return Object.freeze({
        kind: "history", json: parsed.json,
        input: referenceMarketApplicationContracts.history.parseInput({
          pairId: parsed.positionals[0], window: parsed.window,
        }),
      });
    }
    if (command === referenceMarketInterfaceBindings.stockTokenMarket.cli.command &&
      parsed.positionals.length === 1 && parsed.revision === undefined) {
      return Object.freeze({
        kind: "stockTokenMarket", json: parsed.json,
        input: referenceMarketApplicationContracts.stockTokenMarket.parseInput({
          symbol: parsed.positionals[0],
          ...(parsed.window === undefined ? {} : { window: parsed.window }),
        }),
      });
    }
    if (command === referenceMarketInterfaceBindings.watchlist.cli.command &&
      parsed.positionals.length === 0 && parsed.window === undefined && parsed.revision === undefined) {
      return Object.freeze({ kind: "watchlist", json: parsed.json, input: Object.freeze({}) });
    }
    if ((command === operationInterfaceBindings.watchlistAdd.cli?.command ||
      command === operationInterfaceBindings.watchlistRemove.cli?.command) &&
      !parsed.json && parsed.positionals.length === 1 && parsed.revision !== undefined &&
      parsed.window === undefined) {
      const kind = command === operationInterfaceBindings.watchlistAdd.cli?.command
        ? "add" as const
        : "remove" as const;
      return Object.freeze({
        kind,
        json: false,
        input: referenceMarketApplicationContracts.watchlistChangeReview.parseInput({
          kind,
          pairId: parsed.positionals[0],
          expectedRevision: parsed.revision,
        }),
      }) as ReferenceMarketCliCommand;
    }
    if (command === operationInterfaceBindings.watchlistReorder.cli?.command &&
      !parsed.json && parsed.revision !== undefined && parsed.window === undefined) {
      return Object.freeze({
        kind: "reorder", json: false,
        input: referenceMarketApplicationContracts.watchlistChangeReview.parseInput({
          kind: "reorder", pairIds: parsed.positionals, expectedRevision: parsed.revision,
        }),
      });
    }
    if (command === operationInterfaceBindings.watchlistOperation.cli?.command &&
      parsed.positionals.length === 1 && parsed.revision === undefined && parsed.window === undefined) {
      const input = referenceMarketApplicationContracts.operation.parseInput({
        operationId: parsed.positionals[0],
      });
      return Object.freeze({
        kind: "operation",
        json: parsed.json,
        operationId: input.operationId,
      });
    }
  } catch { return invalidInput(); }
  return invalidInput();
};

const rational = (value: Readonly<{ numerator: string; denominator: string }>): string =>
  `${value.numerator}/${value.denominator}`;

const sourceReferenceHuman = (reference: SourceReference): string => {
  switch (reference.kind) {
    case "public":
      return `kind=${reference.kind} sourceId=${reference.sourceId} uri=${reference.uri}`;
    case "configured_rpc":
      return `kind=${reference.kind} sourceId=${reference.sourceId} publicOrigin=${reference.publicOrigin} ` +
        `configurationDigest=${reference.configurationDigest}`;
    case "wallet_session":
      return `kind=${reference.kind} sourceId=${reference.sourceId} topicDigest=${reference.topicDigest}`;
    case "wallet_sdk":
    case "validated_input":
      return `kind=${reference.kind} sourceId=${reference.sourceId}`;
  }
};

const blockHuman = (block: ChainAnchor, label = "Block"): readonly string[] => [
  `${label} chain: ${block.chainId}`,
  `${label} number: ${block.blockNumber}`,
  `${label} hash: ${block.blockHash}`,
  `${label} timestamp: ${block.blockTimestamp}`,
];

const mappingEvidenceHuman = (mapping: ReferenceMarketMappingEvidence): readonly string[] => [
  `Mapping source owner: ${mapping.sourceOwner}`,
  `Mapping source class: ${mapping.sourceClass}`,
  `Mapping source URI: ${mapping.sourceUri}`,
  `Mapping source observed at: ${mapping.sourceObservedAt}`,
  `Mapping freshness: ${mapping.freshnessStatus} (${mapping.freshnessRule})`,
  `Mapping coverage: ${mapping.coverage}`,
  `Mapping exclusions: ${mapping.exclusions.join(", ")}`,
  `Mapping supported conclusions: ${mapping.supportedConclusions.join(", ")}`,
  `Mapping unsupported conclusions: ${mapping.unsupportedConclusions.join(", ")}`,
];

const observationHuman = (
  source: ReferenceRoundObservation,
  index: number,
): readonly string[] => {
  const prefix = `Source ${index + 1}`;
  return [
    `${prefix} feed: ${source.fact.feedId}`,
    `${prefix} proxy: ${source.fact.proxyAddress}`,
    `${prefix} round: ${source.fact.roundId}`,
    `${prefix} answered in round: ${source.fact.answeredInRound}`,
    `${prefix} answer: ${source.fact.answer}`,
    `${prefix} decimals: ${source.fact.decimals}`,
    `${prefix} exact value: ${rational(source.fact.value)}`,
    `${prefix} started at Unix seconds: ${source.fact.startedAtUnixSeconds}`,
    `${prefix} updated at Unix seconds: ${source.fact.updatedAtUnixSeconds}`,
    `${prefix} observed at: ${source.readEvidence.observedAt}`,
    `${prefix} source owner: ${source.readEvidence.sourceOwner}`,
    `${prefix} source class: ${source.readEvidence.sourceClass}`,
    `${prefix} source reference: ${sourceReferenceHuman(source.readEvidence.sourceReference)}`,
    ...blockHuman(source.readEvidence.block, `${prefix} read block`),
  ];
};

const warningsHuman = (warnings: readonly string[]): readonly string[] =>
  warnings.map((warning) => `Warning: ${warning}`);

const referenceWarningMeanings = new Map(
  referenceMarketWarningDefinitions.map((definition) => [definition.code, definition.meaning]),
);
const stockTokenLimitationMeanings = new Map(
  stockTokenMarketLimitationDefinitions.map((definition) => [definition.code, definition.meaning]),
);

const requireMeaning = (meanings: ReadonlyMap<string, string>, code: string): string => {
  const meaning = meanings.get(code);
  if (meaning === undefined) throw new TypeError("Reference-market meaning is not registered.");
  return meaning;
};

export const formatReferencePriceForCli = (result: ReferencePriceSuccess): string => [
  `Pair: ${result.pair.label}`,
  `Status: ${result.status}`,
  ...(result.status === "current" ? [`Reference price: ${rational(result.currentPrice)}`] : []),
  ...(result.status === "stale" ? [`Last observed: ${rational(result.lastObserved)}`] : []),
  ...(result.status === "unavailable" ? [`Reason: ${result.reason}`] : []),
  ...blockHuman(result.block),
  ...mappingEvidenceHuman(result.mappingEvidence),
  ...result.sources.flatMap(observationHuman),
  ...warningsHuman(result.warnings),
].join("\n");

export const formatReferenceHistoryForCli = (result: ReferenceHistorySuccess): string => [
  `Pair: ${result.pair.label}`,
  `Window: ${result.window}`,
  `Status: ${result.status}`,
  ...(result.status === "unavailable" ? [`Reason: ${result.reason}`] : []),
  `Candles: ${result.candles.length}`,
  ...blockHuman(result.block),
  ...mappingEvidenceHuman(result.mappingEvidence),
  `Coverage basis: ${result.coverage.basis}`,
  `Requested: ${result.coverage.requestedStart} to ${result.coverage.requestedEnd}`,
  `Empty bucket starts: ${result.coverage.emptyBucketStarts.length === 0
    ? "none"
    : result.coverage.emptyBucketStarts.join(", ")}`,
  `Limitations: ${result.coverage.limitations.join(", ")}`,
  ...result.sourceObservations.flatMap(observationHuman),
  ...warningsHuman(result.warnings),
].join("\n");

export const formatStockTokenMarketForCli = (result: StockTokenMarketResult): string => {
  const common = [
    `Stock Token: ${result.symbol}`,
    `Window: ${result.window}`,
    `Status: ${result.status}`,
  ];
  if (result.status === "unavailable") {
    const officialAsset = "officialAsset" in result
      ? [
          `Name: ${result.officialAsset.member.sourceName ?? result.symbol}`,
          `Contract: ${result.officialAsset.member.contractAddress}`,
        ]
      : [];
    return [
      ...common,
      ...officialAsset,
      `Reason: ${stockTokenMarketUnavailableReasonLabel(result.reason)}`,
    ].join("\n");
  }
  const latestExecution = result.execution.status === "available"
    ? result.execution.candles.at(-1)
    : undefined;
  const execution = result.execution.status === "unavailable"
    ? [
        "Executed trades (USDG): unavailable",
        `Execution reason: ${stockTokenExecutionUnavailableReasonLabel(result.execution.reason)}`,
      ]
    : [
        `Executed trades (USDG): ${result.execution.freshness === "stale"
          ? "stale"
          : result.execution.coverage.status}`,
        `Execution one-minute candles: ${result.execution.candles.length}`,
        ...(latestExecution === undefined
          ? ["Latest execution close: no executed trade in the covered period"]
          : [
              `Latest execution close: ${rational(latestExecution.close)} USDG`,
              `Latest execution candle: ${latestExecution.intervalEnd}`,
            ]),
        ...result.execution.coverage.limitations.map((limitation) =>
          `Execution limitation: ${stockTokenExecutionLimitationLabel(limitation)}`),
      ];
  return [
    `Stock Token: ${result.officialAsset.member.sourceName ?? result.mapping.disposition.asset.name} · ${result.symbol}`,
    `Window: ${result.window}`,
    `Reference value (USD): ${rational(result.price.value)}`,
    `Reference status: ${result.price.status}`,
    `Reference observed at: ${result.price.source.readEvidence.observedAt}`,
    `Chainlink reference history: ${result.history.status}`,
    `Reference candles: ${result.history.candles.length}`,
    ...execution,
    ...(result.oraclePaused.value ? ["Oracle paused: yes"] : []),
    ...result.warnings.map((code) =>
      `Warning: ${requireMeaning(referenceWarningMeanings, code)}`),
    ...result.limitations.map((code) =>
      `Limitation: ${requireMeaning(stockTokenLimitationMeanings, code)}`),
    `Contract: ${result.officialAsset.member.contractAddress}`,
  ].join("\n");
};

const watchlistHuman = (result: ReferenceWatchlistSuccess): string => [
  `Account: ${result.account.address}`,
  `Revision: ${result.revision}`,
  ...(result.entries.length === 0
    ? ["Pairs: none"]
    : result.entries.map((entry, index) => `${index + 1}. ${entry.label} (${entry.pairId})`)),
].join("\n");

const pairHuman = (entry: ReferenceWatchlistReview["precondition"]["currentEntries"][number]): string =>
  `${entry.label} (${entry.pairId})`;

const watchlistReviewHuman = (review: ReferenceWatchlistReview): string => {
  const target = review.kind === "reorder"
    ? review.target.entries.map(pairHuman).join(", ") || "none"
    : pairHuman(review.target.pair);
  return [
    `Reference watchlist ${review.kind}`,
    `Account: ${review.precondition.account.address}`,
    `Chain: ${review.precondition.account.chainId}`,
    `Connection revision: ${review.precondition.connectionRevision}`,
    `Watchlist revision: ${review.precondition.watchlistRevision}`,
    `Current pairs: ${review.precondition.currentEntries.map(pairHuman).join(", ") || "none"}`,
    `Target: ${target}`,
    `Manifest version: ${review.fixedEvidence.manifestVersion}`,
    `Action deadline: ${review.actionExpiresAt}`,
    `Operation ID: ${review.operationId}`,
    `Review digest: ${review.reviewDigest}`,
  ].join("\n");
};

const watchlistOperationHuman = (operation: ReferenceWatchlistOperation): string => [
  `Reference watchlist operation ${operation.operationId}: completed`,
  `Outcome: ${operation.result.outcome}`,
  `Completed at: ${operation.completedAt}`,
  watchlistHuman(operation.result.watchlist),
].join("\n");

const reportReferenceMarketFailure = (
  output: ReferenceMarketCliOutputPort,
  failure: Readonly<{ error: { code: string; message: string } }>,
  json: boolean,
): number => {
  if (json) output.writeOutput(`${canonicalJsonStringify(failure as unknown as CanonicalJson)}\n`);
  else output.writeError(`${failure.error.code}: ${failure.error.message}\n`);
  return referenceMarketInterfaceErrorMappings.get(failure.error.code).cliExitCode;
};

export const runReferenceMarketCliCommand = async (
  runtime: RuntimeDispatchPort,
  operationClient: LocalOperationClient,
  command: ReferenceMarketCliCommand,
  output: ReferenceMarketCliOutputPort,
  signal?: AbortSignal,
): Promise<number> => {
  if (command.kind === "add" || command.kind === "remove" || command.kind === "reorder") {
    if (!output.inputIsTTY || !output.outputIsTTY) {
      return reportReferenceMarketFailure(
        output,
        createReferenceMarketFailure("interactive_terminal_required"),
        false,
      );
    }
    const actionBinding = command.kind === "add"
      ? operationInterfaceBindings.watchlistAdd
      : command.kind === "remove"
        ? operationInterfaceBindings.watchlistRemove
        : operationInterfaceBindings.watchlistReorder;
    const decided = await runAtomicCliDecision({
      client: operationClient,
      reviewIdentity: operationInterfaceBindings.watchlistReview.identity,
      reviewInput: command.input,
      selectReview: (result) => result.review,
      actionIdentity: actionBinding.identity,
      actionInput: (review) => actionBinding.contract.parseInput({ review, initiatedBy: "cli" }) as never,
      formatReview: watchlistReviewHuman,
      formatOperation: watchlistOperationHuman,
      prompt: "Apply this reference watchlist change? [y/N] ",
      output,
    });
    if (decided.status === "completed" || decided.status === "declined") return 0;
    if (decided.status === "delivery_unknown") {
      output.writeError([
        `delivery_unknown: Operation ${decided.delivery.operationId} may have completed.`,
        "Do not repeat the action. Read that exact operation.",
        "",
      ].join("\n"));
      return deliveryUnknownCliExitCode;
    }
    return reportReferenceMarketFailure(output, decided.failure, false);
  }

  if (command.kind === "operation") {
    const input = referenceMarketApplicationContracts.operation.parseInput({
      operationId: command.operationId,
    });
    const result = await operationClient.invoke(
      operationInterfaceBindings.watchlistOperation.identity,
      input,
      output.interruptSignal,
    );
    if (!("ok" in result) || !result.ok) {
      if ("status" in result) {
        output.writeError("delivery_unknown: Exact read did not complete.\n");
        return deliveryUnknownCliExitCode;
      }
      return reportReferenceMarketFailure(output, result.failure, command.json);
    }
    output.writeOutput(command.json
      ? `${canonicalJsonStringify(result.value as unknown as CanonicalJson)}\n`
      : `${watchlistOperationHuman(result.value)}\n`);
    return 0;
  }

  const readBinding = command.kind === "price"
    ? referenceMarketInterfaceBindings.price
    : command.kind === "history"
      ? referenceMarketInterfaceBindings.history
      : command.kind === "stockTokenMarket"
        ? referenceMarketInterfaceBindings.stockTokenMarket
        : referenceMarketInterfaceBindings.watchlist;
  const result = await dispatchReferenceMarketRead(runtime, readBinding, command.input, signal);
  if ("status" in result) {
    if (command.json) output.writeOutput(`${canonicalJsonStringify(result as unknown as CanonicalJson)}\n`);
    else output.writeError("delivery_unknown: The reference-market result is unavailable after sending began.\n");
    return deliveryUnknownCliExitCode;
  }
  if (!result.ok) {
    return reportReferenceMarketFailure(output, result.failure, command.json);
  }
  const value = result.value;
  output.writeOutput(command.json
    ? `${canonicalJsonStringify(value as unknown as CanonicalJson)}\n`
    : `${command.kind === "price"
      ? formatReferencePriceForCli(value as ReferencePriceSuccess)
      : command.kind === "history"
        ? formatReferenceHistoryForCli(value as ReferenceHistorySuccess)
        : command.kind === "stockTokenMarket"
          ? formatStockTokenMarketForCli(value as StockTokenMarketResult)
          : watchlistHuman(value as ReferenceWatchlistSuccess)}\n`);
  return 0;
};
