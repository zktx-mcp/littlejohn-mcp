import {
  accountBalanceCapability,
  canonicalJsonStringify,
  captureCanonicalJson,
  contractInspectCapability,
  getCapabilityDefinitionSnapshot,
  parseCapabilityInput,
  parseCapabilitySuccess,
  productChainId,
  scaleRawUnitPriceToTokenUnits,
  transactionInspectCapability,
  chainStatusCapability,
  type AccountBalanceData,
  type AccountBalanceInput,
  type CanonicalAmount,
  type CapabilitySuccess,
  type CanonicalJson,
  type ChainStatusData,
  type ContractInspectData,
  type ExactRational,
  type TransactionInspectData,
} from "../core/index.js";
import {
  accountAssetApplicationContracts,
  accountAssetCollectionRequestBody,
  accountAssetInterfaceErrorMappings,
  projectAccountAssetCollectionView,
  type AccountAssetQuantityView,
  type AccountAssetCollectionInput,
  type AccountAssetCollectionSuccess,
} from "../account-assets/index.js";
import type { RuntimeDispatchRequest } from "../runtime/http-owner.js";
import {
  createInterfaceFailure,
  constrainInterfaceFailure,
  dispatchCanonical,
  type RuntimeDispatchPort,
} from "./http-client.js";
import {
  accountBalanceInterface,
  accountAssetInterfaceBindings,
  accountAssetLocalOperationIdentities,
  chainStatusInterface,
  contractInspectInterface,
  transactionInspectInterface,
  type ReadInterfaceIdentity,
  uniswapV2QuoteInterface,
} from "./identities.js";
import { LocalOperationClient } from "./operation-client.js";
import { deliveryUnknownCliExitCode } from "./delivery-exit.js";
import { contractAnalysisHumanLines } from "./cli-contract-analysis.js";
import {
  uniswapV2QuoteCapability,
  type UniswapV2QuoteData,
  type UniswapV2QuoteInput,
} from "../protocols/uniswap-v2/index.js";

type ReadCommandBase = { readonly json: boolean };
export type ReadCliCommand =
  | (ReadCommandBase & {
      readonly kind: "assets";
      readonly input: AccountAssetCollectionInput;
    })
  | (ReadCommandBase & { readonly kind: "chain_status" })
  | (ReadCommandBase & { readonly kind: "contract"; readonly input: ReturnType<typeof contractInput> })
  | (ReadCommandBase & { readonly kind: "transaction"; readonly input: ReturnType<typeof transactionInput> })
  | (ReadCommandBase & { readonly kind: "balance"; readonly input: AccountBalanceInput })
  | (ReadCommandBase & { readonly kind: "uniswap_v2_quote"; readonly input: UniswapV2QuoteInput });

export interface ReadCliOutputPort {
  writeOutput(value: string): void;
  writeError(value: string): void;
}

const invalidInput = (): never => { throw new TypeError("CLI read input is invalid."); };

const tokenUnitPriceText = (
  rawUnitPrice: ExactRational,
  inputDecimals: string,
  outputDecimals: string,
): string => {
  const price = scaleRawUnitPriceToTokenUnits(
    rawUnitPrice,
    inputDecimals,
    outputDecimals,
  );
  return `${price.numerator}/${price.denominator}`;
};

const parseBlockSelector = (value: string | undefined) => {
  if (value === "latest") return Object.freeze({ kind: "latest" });
  if (value === undefined) return invalidInput();
  return Object.freeze({ kind: "number", blockNumber: value });
};

interface ParsedTokens {
  readonly json: boolean;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

const parseTokens = (
  tokens: readonly string[],
  repeatable: ReadonlySet<string> = new Set(),
  booleanFlags: ReadonlySet<string> = new Set(),
): ParsedTokens => {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let json = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--json") {
      if (json) return invalidInput();
      json = true;
      continue;
    }
    if (token?.startsWith("--")) {
      if (booleanFlags.has(token)) {
        if (flags.has(token)) return invalidInput();
        flags.set(token, ["true"]);
        continue;
      }
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) return invalidInput();
      const values = flags.get(token) ?? [];
      if (values.length !== 0 && !repeatable.has(token)) return invalidInput();
      values.push(value);
      flags.set(token, values);
      index += 1;
      continue;
    }
    if (token === undefined) return invalidInput();
    positionals.push(token);
  }
  return Object.freeze({
    json,
    positionals: Object.freeze(positionals),
    flags: new Map([...flags].map(([key, values]) => [key, Object.freeze(values)])),
  });
};

const exactFlag = (parsed: ParsedTokens, name: string): string | undefined => {
  const values = parsed.flags.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) return invalidInput();
  return values[0];
};

const assertAllowedFlags = (parsed: ParsedTokens, allowed: ReadonlySet<string>): void => {
  if ([...parsed.flags.keys()].some((name) => !allowed.has(name))) invalidInput();
};

const contractInput = (address: string, block: ReturnType<typeof parseBlockSelector>) =>
  parseCapabilityInput(contractInspectCapability, { address, block });

const transactionInput = (transactionHash: string) =>
  parseCapabilityInput(transactionInspectCapability, { transactionHash });

const parseContract = (tokens: readonly string[]): ReadCliCommand => {
  const parsed = parseTokens(tokens);
  assertAllowedFlags(parsed, new Set(["--block"]));
  if (parsed.positionals.length !== 1) return invalidInput();
  return Object.freeze({
    kind: "contract",
    json: parsed.json,
    input: contractInput(parsed.positionals[0] as string, parseBlockSelector(exactFlag(parsed, "--block"))),
  });
};

const parseTransaction = (tokens: readonly string[]): ReadCliCommand => {
  const parsed = parseTokens(tokens);
  assertAllowedFlags(parsed, new Set());
  if (parsed.positionals.length !== 1) return invalidInput();
  return Object.freeze({
    kind: "transaction",
    json: parsed.json,
    input: transactionInput(parsed.positionals[0] as string),
  });
};

const parseBalance = (tokens: readonly string[]): ReadCliCommand => {
  const parsed = parseTokens(tokens, new Set(["--token"]), new Set(["--active"]));
  assertAllowedFlags(parsed, new Set(["--active", "--address", "--native", "--token", "--block"]));
  if (parsed.positionals.length !== 0) return invalidInput();
  const active = parsed.flags.get("--active");
  const address = exactFlag(parsed, "--address");
  if ((active === undefined) === (address === undefined)) return invalidInput();
  if (active !== undefined && (active.length !== 1 || active[0] !== "true")) return invalidInput();
  const native = exactFlag(parsed, "--native");
  if (native !== "true" && native !== "false") return invalidInput();
  const input = {
    account: active === undefined
      ? { kind: "address" as const, address }
      : { kind: "active_wallet" as const },
    includeNative: native === "true",
    tokens: parsed.flags.get("--token") ?? [],
    block: parseBlockSelector(exactFlag(parsed, "--block")),
  };
  try {
    return Object.freeze({
      kind: "balance",
      json: parsed.json,
      input: parseCapabilityInput(accountBalanceCapability, input),
    });
  } catch { return invalidInput(); }
};

const parseAssets = (tokens: readonly string[]): ReadCliCommand => {
  const parsed = parseTokens(tokens);
  assertAllowedFlags(parsed, new Set(["--limit", "--cursor"]));
  if (parsed.positionals.length !== 0) return invalidInput();
  const limit = exactFlag(parsed, "--limit");
  const cursor = exactFlag(parsed, "--cursor");
  try {
    const decodedCursor: unknown = cursor === undefined ? undefined : JSON.parse(cursor);
    const input = accountAssetApplicationContracts.collection.parseInput({
      ...(limit === undefined ? {} : { limit: Number(limit) }),
      ...(cursor === undefined ? {} : { cursor: decodedCursor }),
    });
    return Object.freeze({
      kind: "assets",
      json: parsed.json,
      input: accountAssetCollectionRequestBody(input),
    });
  } catch { return invalidInput(); }
};

const parseUniswapV2Quote = (tokens: readonly string[]): ReadCliCommand => {
  const parsed = parseTokens(tokens);
  assertAllowedFlags(
    parsed,
    new Set(["--factory", "--token-in", "--token-out", "--amount-in", "--block"]),
  );
  if (parsed.positionals.length !== 0) return invalidInput();
  try {
    return Object.freeze({
      kind: "uniswap_v2_quote",
      json: parsed.json,
      input: parseCapabilityInput(uniswapV2QuoteCapability, {
        tokenIn: {
          kind: "erc20",
          chainId: productChainId,
          address: exactFlag(parsed, "--token-in"),
        },
        tokenOut: {
          kind: "erc20",
          chainId: productChainId,
          address: exactFlag(parsed, "--token-out"),
        },
        factory: exactFlag(parsed, "--factory"),
        amountIn: exactFlag(parsed, "--amount-in"),
        block: parseBlockSelector(exactFlag(parsed, "--block")),
      }),
    });
  } catch {
    return invalidInput();
  }
};

export const parseReadCliCommand = (argumentsInput: readonly string[]): ReadCliCommand => {
  const [domain, command, ...tokens] = argumentsInput;
  if (command === undefined) return invalidInput();
  if (domain === accountAssetInterfaceBindings.collection.cli.domain &&
    command === accountAssetInterfaceBindings.collection.cli.command) return parseAssets(tokens);
  if (domain === chainStatusInterface.cli.domain && command === chainStatusInterface.cli.command) {
    const parsed = parseTokens(tokens);
    assertAllowedFlags(parsed, new Set());
    if (parsed.positionals.length !== 0) return invalidInput();
    return Object.freeze({ kind: "chain_status", json: parsed.json });
  }
  if (domain === contractInspectInterface.cli.domain && command === contractInspectInterface.cli.command) {
    return parseContract(tokens);
  }
  if (domain === transactionInspectInterface.cli.domain && command === transactionInspectInterface.cli.command) {
    return parseTransaction(tokens);
  }
  if (domain === accountBalanceInterface.cli.domain && command === accountBalanceInterface.cli.command) {
    return parseBalance(tokens);
  }
  if (
    domain === uniswapV2QuoteInterface.cli.domain &&
    command === uniswapV2QuoteInterface.cli.command
  ) {
    return parseUniswapV2Quote(tokens);
  }
  return invalidInput();
};

const amountSummary = (amount: CanonicalAmount): string => {
  const asset = amount.asset.kind === "native"
    ? `native:${amount.asset.chainId}`
    : `erc20:${amount.asset.chainId}:${amount.asset.address}`;
  const decimals = amount.decimals.status === "available"
    ? amount.decimals.value
    : amount.decimals.status;
  return `${asset} raw=${amount.raw} decimals=${decimals}`;
};

const chainStatusHuman = (data: ChainStatusData): string => [
  `Chain: ${data.chainId}`,
  `Latest block: ${data.latestBlock.blockNumber}`,
  `Block hash: ${data.latestBlock.blockHash}`,
  `Block timestamp: ${data.latestBlock.blockTimestamp}`,
].join("\n");

const contractHuman = (data: ContractInspectData): string => [
  `Contract: ${data.analysis.target}`,
  `Block: ${data.analysis.block.blockNumber}`,
  ...contractAnalysisHumanLines(data.analysis),
].join("\n");

const transactionHuman = (data: TransactionInspectData): string => [
  `Transaction: ${data.transactionHash}`,
  `From: ${data.from}`,
  data.recipient.kind === "call"
    ? `To: ${data.recipient.address}`
    : "To: contract creation",
  `Value: ${amountSummary(data.value)}`,
  `Nonce: ${data.nonce}`,
  `Gas limit: ${data.gasLimit.raw}`,
  `Type: ${data.type}`,
  `Inclusion: ${data.inclusion.status}`,
  ...(data.inclusion.status === "included"
    ? [
        `Block: ${data.inclusion.block.blockNumber}`,
        `Receipt status: ${data.inclusion.receipt.status}`,
        `Gas used: ${data.inclusion.receipt.gasUsed.raw}`,
      ]
    : []),
].join("\n");

const balanceHuman = (data: AccountBalanceData): string => [
  `Account: ${data.account}`,
  `Block: ${data.block.blockNumber}`,
  data.native.status === "available"
    ? `Native balance: ${amountSummary(data.native.amount)}`
    : "Native balance: not requested",
  ...data.tokens.map((token) => token.result.status === "available"
    ? `Token ${token.asset.address}: ${amountSummary(token.result.amount)}`
    : `Token ${token.asset.address}: unavailable (${token.result.errorCode})`),
].join("\n");

const assetsHuman = (result: AccountAssetCollectionSuccess): string => {
  const view = projectAccountAssetCollectionView(result);
  const quantity = (value: AccountAssetQuantityView): string => [
    `raw=${value.raw}`,
    ...(value.formattedRaw === null ? [] : [`formatted=${value.formattedRaw}`]),
    ...(value.adjustedRaw === null ? [] : [`UI-adjusted raw=${value.adjustedRaw}`]),
    ...(value.formattedAdjusted === null ? [] : [`UI-adjusted=${value.formattedAdjusted}`]),
  ].join(" ");
  return [
    `Account: ${view.account.address}`,
    view.block === null ? "Block: unavailable" : `Block: ${view.block.blockNumber}`,
    `Native: ${quantity(view.native)}`,
    ...view.assets.map((entry) => [
      `Token: ${entry.identity.label}`,
      `  Address: ${entry.identity.address}`,
      `  Classification: ${entry.classification.label}`,
      ...(entry.classification.limitation === null
        ? []
        : [`  Limitation: ${entry.classification.limitation}`]),
      `  Balance: ${quantity(entry.quantity)}`,
    ].join("\n")),
    ...(view.nextCursor === null ? [] : [
      `Next cursor JSON: ${canonicalJsonStringify(view.nextCursor as unknown as CanonicalJson)}`,
      "Pass this JSON as one --cursor argument; quote or escape it for your shell.",
      "POSIX shells: enclose the JSON in single quotes.",
    ]),
  ].join("\n");
};

type UniswapV2QuoteSuccess = CapabilitySuccess<UniswapV2QuoteData>;

const uniswapV2SourceReference = (
  source: UniswapV2QuoteSuccess["evidence"]["sources"][number],
): string => {
  switch (source.reference.kind) {
    case "public": return source.reference.uri;
    case "configured_rpc": return source.reference.publicOrigin;
    case "wallet_session": return source.reference.sourceId;
    case "wallet_sdk": return source.reference.sourceId;
    case "validated_input": return source.reference.sourceId;
  }
};

const uniswapV2QuoteHuman = (success: UniswapV2QuoteSuccess): string => {
  const data = success.data;
  return [
    `Protocol: ${data.protocol.protocolId}`,
    `Factory: ${data.deployment.factory}`,
    `Factory code: ${data.deployment.runtimeCode.byteLength} bytes ${data.deployment.runtimeCode.codeHash}`,
    `Pair init-code hash: ${data.deployment.pairInitCodeHash}`,
    `Block: ${data.block.blockNumber} ${data.block.blockHash}`,
    `Block timestamp: ${data.block.blockTimestamp}`,
    `Evaluated at: ${success.meta.evaluatedAt}`,
    `Input: ${data.input.amountIn} raw ${data.input.tokenIn.address}`,
    `Input decimals: ${data.input.tokenInDecimals}`,
    `Output token: ${data.input.tokenOut.address}`,
    `Output decimals: ${data.input.tokenOutDecimals}`,
    `Coverage: ${data.coverage.basis}`,
    `Route assets: ${data.coverage.routeAssets.join(", ")}`,
    `Deployment source owner: ${data.deployment.source.sourceOwner}`,
    `Deployment source class: ${data.deployment.source.sourceClass}`,
    `Deployment source URI: ${data.deployment.source.sourceUri}`,
    `Deployment source revision: ${data.deployment.source.sourceRevision}`,
    `Deployment source coverage: ${data.deployment.source.coverage}`,
    `Deployment source exclusions: ${data.deployment.source.exclusions.join(", ")}`,
    `Deployment source supported conclusions: ${data.deployment.source.supportedConclusions.join(", ")}`,
    `Deployment source unsupported conclusions: ${data.deployment.source.unsupportedConclusions.join(", ")}`,
    `Route-asset source owner: ${data.coverage.source.sourceOwner}`,
    `Route-asset source class: ${data.coverage.source.sourceClass}`,
    `Route-asset source URI: ${data.coverage.source.sourceUri}`,
    `Route-asset source observed at: ${data.coverage.source.sourceObservedAt}`,
    `Route-asset source freshness: ${data.coverage.source.freshnessStatus} (${data.coverage.source.freshnessRule})`,
    `Route-asset source coverage: ${data.coverage.source.coverage}`,
    `Route-asset source exclusions: ${data.coverage.source.exclusions.join(", ")}`,
    `Route-asset source supported conclusions: ${data.coverage.source.supportedConclusions.join(", ")}`,
    `Route-asset source unsupported conclusions: ${data.coverage.source.unsupportedConclusions.join(", ")}`,
    ...data.candidates.map((candidate, index) => [
    `Candidate ${index + 1}: ${candidate.path.map((asset) => asset.address).join(" -> ")}`,
    `  Status: ${candidate.status}`,
    ...candidate.evaluatedHops.flatMap((hop, hopIndex) => [
      `  Hop ${hopIndex + 1}: ${hop.tokenIn.asset.address} -> ${hop.tokenOut.asset.address}`,
      `    Status: ${hop.status}`,
      `    Raw input: ${hop.amountIn}`,
      `    Factory result: ${hop.factoryResult}`,
      `    Input decimals: ${hop.tokenIn.decimals.status === "observed"
        ? hop.tokenIn.decimals.value
        : hop.tokenIn.decimals.status}`,
      `    Output decimals: ${hop.tokenOut.decimals.status === "observed"
        ? hop.tokenOut.decimals.value
        : hop.tokenOut.decimals.status}`,
      ...(hop.status === "pair_absent"
        ? []
        : [
            `    Pair: ${hop.pair.pairAddress}`,
            `    Pair code: ${hop.pair.runtimeCode.byteLength} bytes ${hop.pair.runtimeCode.codeHash}`,
            `    Reported factory: ${hop.pair.factory}`,
            `    Token 0: ${hop.pair.token0}`,
            `    Token 1: ${hop.pair.token1}`,
            `    Reserve 0: ${hop.pair.reserve0}`,
            `    Reserve 1: ${hop.pair.reserve1}`,
            `    Fee rate: ${hop.feeRate.numerator}/${hop.feeRate.denominator}`,
          ]),
      ...(hop.status === "completed" || hop.status === "amount_too_small"
        ? [`    Raw output: ${hop.amountOut}`]
        : []),
    ]),
    ...(candidate.status === "quoted"
      ? [
          `  Output: ${candidate.amountOut}`,
          `  Mid price (raw output units per raw input unit): ${candidate.midPrice.numerator}/${candidate.midPrice.denominator}`,
          `  Mid price (output tokens per input token): ${tokenUnitPriceText(
            candidate.midPrice,
            data.input.tokenInDecimals,
            data.input.tokenOutDecimals,
          )}`,
          `  Execution price (raw output units per raw input unit): ${candidate.executionPrice.numerator}/${candidate.executionPrice.denominator}`,
          `  Execution price (output tokens per input token): ${tokenUnitPriceText(
            candidate.executionPrice,
            data.input.tokenInDecimals,
            data.input.tokenOutDecimals,
          )}`,
          `  Price impact: ${candidate.priceImpact.numerator}/${candidate.priceImpact.denominator}`,
          `  SDK check: ${candidate.sdkCheck.status}${
            candidate.sdkCheck.status === "not_available"
              ? ` (${candidate.sdkCheck.reason})`
              : ""
          }`,
        ]
      : []),
    ].join("\n")),
    ...success.evidence.sources.map((source) => [
      `Evidence source: ${source.observationId}`,
      `  Purpose: ${source.purpose}`,
      `  Owner and class: ${source.owner} / ${source.sourceClass}`,
      `  Reference: ${uniswapV2SourceReference(source)}`,
      `  Observed at: ${source.observedAt}`,
      `  Record digest: ${source.recordDigest}`,
      ...(source.chainAnchor === undefined
        ? []
        : [`  Chain anchor: ${source.chainAnchor.blockNumber} ${source.chainAnchor.blockHash}`]),
    ].join("\n")),
    ...success.evidence.conclusions.map((conclusion) =>
      `Evidence conclusion: ${conclusion.id} ${conclusion.status} ${conclusion.reason}`),
    `Evidence coverage: ${success.evidence.coverage.status}`,
    `Established facts: ${success.evidence.coverage.established.join(", ") || "none"}`,
    `Unavailable facts: ${success.evidence.coverage.unavailable.join(", ") || "none"}`,
    `Not applicable facts: ${success.evidence.coverage.notApplicable.join(", ") || "none"}`,
    ...success.warnings.map((warning) =>
      `Warning: ${warning.code} ${warning.message}`),
    ...getCapabilityDefinitionSnapshot(uniswapV2QuoteCapability).staticScopeExclusions
      .map((exclusion) => `Limitation: ${exclusion.message}`),
  ].join("\n");
};

type DirectReadCliCommand = Exclude<ReadCliCommand, { readonly kind: "assets" }>;

const interfaceForCommand = (command: DirectReadCliCommand): ReadInterfaceIdentity => {
  switch (command.kind) {
    case "chain_status": return chainStatusInterface;
    case "contract": return contractInspectInterface;
    case "transaction": return transactionInspectInterface;
    case "balance": return accountBalanceInterface;
    case "uniswap_v2_quote": return uniswapV2QuoteInterface;
  }
};

const requestForCommand = (
  command: DirectReadCliCommand,
  identity: ReadInterfaceIdentity,
): RuntimeDispatchRequest => {
  if (identity.http.method === "GET") return {
      requestClass: "public_read",
      method: "GET",
      path: identity.http.path,
    };
  if (command.kind === "chain_status") {
    throw new TypeError("Chain status must use its declared GET binding.");
  }
  return {
      requestClass: "public_read",
      method: "POST",
      path: identity.http.path,
      body: captureCanonicalJson(command.input),
    };
};

const parseSuccess = (
  identity: ReadInterfaceIdentity,
  command: DirectReadCliCommand,
  value: unknown,
): CapabilitySuccess<unknown> =>
  parseCapabilitySuccess(
    identity.definition,
    command.kind === "chain_status" ? {} : command.input,
    value,
  );

const humanSuccess = (command: DirectReadCliCommand, success: CapabilitySuccess<unknown>): string => {
  switch (command.kind) {
    case "chain_status": return chainStatusHuman(success.data as ChainStatusData);
    case "contract": return contractHuman(success.data as ContractInspectData);
    case "transaction": return transactionHuman(success.data as TransactionInspectData);
    case "balance": return balanceHuman(success.data as AccountBalanceData);
    case "uniswap_v2_quote": return uniswapV2QuoteHuman(
      success as CapabilitySuccess<UniswapV2QuoteData>,
    );
  }
};

export const runReadCliCommand = async (
  runtime: RuntimeDispatchPort,
  client: LocalOperationClient,
  command: ReadCliCommand,
  output: ReadCliOutputPort,
  signal?: AbortSignal,
): Promise<number> => {
  if (command.kind === "assets") {
    const result = await client.invoke(accountAssetLocalOperationIdentities.collection, command.input, signal);
    if ("status" in result) {
      if (command.json) output.writeOutput(`${canonicalJsonStringify(result as unknown as CanonicalJson)}\n`);
      else output.writeError("delivery_unknown: The account asset response is unavailable after sending began.\n");
      return deliveryUnknownCliExitCode;
    }
    if (!result.ok) {
      if (command.json) output.writeOutput(`${canonicalJsonStringify(result.failure as unknown as CanonicalJson)}\n`);
      else output.writeError(`${result.failure.error.code}: ${result.failure.error.message}\n`);
      return accountAssetInterfaceErrorMappings.get(result.failure.error.code).cliExitCode;
    }
    output.writeOutput(command.json
      ? `${canonicalJsonStringify(result.value as unknown as CanonicalJson)}\n`
      : `${assetsHuman(result.value)}\n`);
    return 0;
  }
  const identity = interfaceForCommand(command);
  const request = requestForCommand(command, identity);
  const result = constrainInterfaceFailure(await dispatchCanonical(runtime, {
    ...request,
    ...(signal === undefined ? {} : { signal }),
  }, 200, identity.responseAuthority), getCapabilityDefinitionSnapshot(identity.definition).failureCodes);
  if (!result.ok) {
    if (command.json) {
      output.writeOutput(`${canonicalJsonStringify(result.failure as unknown as CanonicalJson)}\n`);
    }
    else output.writeError(`${result.failure.error.code}: ${result.failure.error.message}\n`);
    return identity.responseAuthority.interfaceMappings
      .get(result.failure.error.code).cliExitCode;
  }
  try {
    const parsed = parseSuccess(identity, command, result.value);
    output.writeOutput(command.json
      ? `${canonicalJsonStringify(parsed as unknown as CanonicalJson)}\n`
      : `${humanSuccess(command, parsed)}\n`);
    return 0;
  } catch {
    const failure = createInterfaceFailure("internal_error");
    if (command.json) output.writeOutput(`${canonicalJsonStringify(failure as unknown as CanonicalJson)}\n`);
    else output.writeError(`${failure.error.code}: ${failure.error.message}\n`);
    return identity.responseAuthority.interfaceMappings.get("internal_error").cliExitCode;
  }
};
