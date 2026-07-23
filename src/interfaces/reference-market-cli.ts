import {
  canonicalJsonStringify,
  type CanonicalJson,
  type ChainAnchor,
  type ReferenceHistorySuccess,
  type ReferenceMarketMappingEvidence,
  type ReferencePriceSuccess,
  type ReferenceRoundObservation,
  type ReferenceWatchlistSuccess,
  type SourceReference,
} from "../core/index.js";
import { referenceMarketApplicationContracts, referenceMarketInterfaceErrorMappings } from "../market-portfolio/index.js";
import {
  referenceMarketInterfaceBindings,
} from "./identities.js";
import { deliveryUnknownCliExitCode } from "./delivery-exit.js";
import { LocalMutationClient } from "./reference-market-local-client.js";
import { dispatchReferenceMarketRead } from "./reference-market-http.js";
import type { RuntimeDispatchPort } from "./http-client.js";

type ReferenceMarketCliBase = { readonly json: boolean };
export type ReferenceMarketCliCommand =
  | (ReferenceMarketCliBase & { readonly kind: "price"; readonly input: ReturnType<typeof referenceMarketApplicationContracts.price.parseInput> })
  | (ReferenceMarketCliBase & { readonly kind: "history"; readonly input: ReturnType<typeof referenceMarketApplicationContracts.history.parseInput> })
  | (ReferenceMarketCliBase & { readonly kind: "watchlist"; readonly input: Record<string, never> })
  | (ReferenceMarketCliBase & { readonly kind: "add"; readonly input: ReturnType<typeof referenceMarketApplicationContracts.add.parseInput> })
  | (ReferenceMarketCliBase & { readonly kind: "remove"; readonly input: ReturnType<typeof referenceMarketApplicationContracts.remove.parseInput> })
  | (ReferenceMarketCliBase & { readonly kind: "reorder"; readonly input: ReturnType<typeof referenceMarketApplicationContracts.reorder.parseInput> });

export interface ReferenceMarketCliOutputPort {
  writeOutput(value: string): void;
  writeError(value: string): void;
}

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
    if (command === referenceMarketInterfaceBindings.watchlist.cli.command &&
      parsed.positionals.length === 0 && parsed.window === undefined && parsed.revision === undefined) {
      return Object.freeze({ kind: "watchlist", json: parsed.json, input: Object.freeze({}) });
    }
    if ((command === referenceMarketInterfaceBindings.add.cli.command ||
      command === referenceMarketInterfaceBindings.remove.cli.command) &&
      parsed.positionals.length === 1 && parsed.revision !== undefined && parsed.window === undefined) {
      const contract = command === referenceMarketInterfaceBindings.add.cli.command
        ? referenceMarketApplicationContracts.add
        : referenceMarketApplicationContracts.remove;
      return Object.freeze({
        kind: command === referenceMarketInterfaceBindings.add.cli.command ? "add" : "remove",
        json: parsed.json,
        input: contract.parseInput({ pairId: parsed.positionals[0], expectedRevision: parsed.revision }),
      }) as ReferenceMarketCliCommand;
    }
    if (command === referenceMarketInterfaceBindings.reorder.cli.command &&
      parsed.revision !== undefined && parsed.window === undefined) {
      return Object.freeze({
        kind: "reorder", json: parsed.json,
        input: referenceMarketApplicationContracts.reorder.parseInput({
          pairIds: parsed.positionals, expectedRevision: parsed.revision,
        }),
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

const watchlistHuman = (result: ReferenceWatchlistSuccess): string => [
  `Account: ${result.account.address}`,
  `Revision: ${result.revision}`,
  ...(result.entries.length === 0
    ? ["Pairs: none"]
    : result.entries.map((entry, index) => `${index + 1}. ${entry.label} (${entry.pairId})`)),
].join("\n");

export const runReferenceMarketCliCommand = async (
  runtime: RuntimeDispatchPort,
  mutationClient: LocalMutationClient,
  command: ReferenceMarketCliCommand,
  output: ReferenceMarketCliOutputPort,
  signal?: AbortSignal,
): Promise<number> => {
  const result = command.kind === "price"
    ? await dispatchReferenceMarketRead(runtime, referenceMarketInterfaceBindings.price, command.input, signal)
    : command.kind === "history"
      ? await dispatchReferenceMarketRead(runtime, referenceMarketInterfaceBindings.history, command.input, signal)
      : command.kind === "watchlist"
        ? await dispatchReferenceMarketRead(runtime, referenceMarketInterfaceBindings.watchlist, command.input, signal)
        : command.kind === "add"
          ? await mutationClient.add(command.input, signal)
          : command.kind === "remove"
            ? await mutationClient.remove(command.input, signal)
            : await mutationClient.reorder(command.input, signal);
  if ("status" in result) {
    if (command.json) output.writeOutput(`${canonicalJsonStringify(result as unknown as CanonicalJson)}\n`);
    else output.writeError("delivery_unknown: The watchlist result is unavailable after sending began; read the watchlist before deciding whether to send again.\n");
    return deliveryUnknownCliExitCode;
  }
  if (!result.ok) {
    if (command.json) output.writeOutput(`${canonicalJsonStringify(result.failure as unknown as CanonicalJson)}\n`);
    else output.writeError(`${result.failure.error.code}: ${result.failure.error.message}\n`);
    return referenceMarketInterfaceErrorMappings.get(result.failure.error.code).cliExitCode;
  }
  const value = result.value;
  output.writeOutput(command.json
    ? `${canonicalJsonStringify(value as unknown as CanonicalJson)}\n`
    : `${command.kind === "price"
      ? formatReferencePriceForCli(value as ReferencePriceSuccess)
      : command.kind === "history"
        ? formatReferenceHistoryForCli(value as ReferenceHistorySuccess)
        : watchlistHuman(value as ReferenceWatchlistSuccess)}\n`);
  return 0;
};
