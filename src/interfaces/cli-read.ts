import {
  accountBalanceCapability,
  canonicalJsonStringify,
  contractInspectCapability,
  getCapabilityDefinitionSnapshot,
  parseCapabilityInput,
  parseCapabilitySuccess,
  transactionInspectCapability,
  chainStatusCapability,
  type AccountBalanceData,
  type AccountBalanceInput,
  type CanonicalAmount,
  type CapabilitySuccess,
  type CanonicalJson,
  type ChainStatusData,
  type ContractInspectData,
  type TransactionInspectData,
} from "../core/index.js";
import { chainInterfaceErrorMappings } from "../chain/errors.js";
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
} from "./identities.js";
import { LocalOperationClient } from "./operation-client.js";
import { deliveryUnknownCliExitCode } from "./operation-delivery.js";

type ReadCommandBase = { readonly json: boolean };
export type ReadCliCommand =
  | (ReadCommandBase & {
      readonly kind: "assets";
      readonly input: AccountAssetCollectionInput;
    })
  | (ReadCommandBase & { readonly kind: "chain_status" })
  | (ReadCommandBase & { readonly kind: "contract"; readonly input: ReturnType<typeof contractInput> })
  | (ReadCommandBase & { readonly kind: "transaction"; readonly input: ReturnType<typeof transactionInput> })
  | (ReadCommandBase & { readonly kind: "balance"; readonly input: AccountBalanceInput });

export interface ReadCliOutputPort {
  writeOutput(value: string): void;
  writeError(value: string): void;
}

const invalidInput = (): never => { throw new TypeError("CLI read input is invalid."); };

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
    const input = accountAssetApplicationContracts.collection.parseInput({
      ...(limit === undefined ? {} : { limit: Number(limit) }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    return Object.freeze({
      kind: "assets",
      json: parsed.json,
      input: accountAssetCollectionRequestBody(input),
    });
  } catch { return invalidInput(); }
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
  `Contract: ${data.address}`,
  `Block: ${data.block.blockNumber}`,
  `Runtime code: ${data.runtimeCode.status}`,
  ...(data.runtimeCode.status === "present"
    ? [`Byte length: ${data.runtimeCode.byteLength}`, `Code hash: ${data.runtimeCode.codeHash}`]
    : []),
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
      `Token: ${entry.symbol ?? entry.name ?? entry.selection.asset.address}`,
      `  Address: ${entry.selection.asset.address}`,
      `  Classification: ${entry.classification.kind}`,
      `  Balance: ${quantity(entry.quantity)}`,
    ].join("\n")),
    ...(view.nextCursor === null ? [] : [
      `Next cursor: ${canonicalJsonStringify(view.nextCursor as unknown as CanonicalJson)}`,
    ]),
  ].join("\n");
};

type DirectReadCliCommand = Exclude<ReadCliCommand, { readonly kind: "assets" }>;

const interfaceForCommand = (command: DirectReadCliCommand): ReadInterfaceIdentity => {
  switch (command.kind) {
    case "chain_status": return chainStatusInterface;
    case "contract": return contractInspectInterface;
    case "transaction": return transactionInspectInterface;
    case "balance": return accountBalanceInterface;
  }
};

const requestForCommand = (
  command: DirectReadCliCommand,
  identity: ReadInterfaceIdentity,
): RuntimeDispatchRequest => ({
  requestClass: "public_read",
  method: identity.http.method,
  path: identity.http.path,
  ...(command.kind === "chain_status" ? {} : { body: command.input }),
});

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
    return chainInterfaceErrorMappings.get(result.failure.error.code).cliExitCode;
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
    return chainInterfaceErrorMappings.get("internal_error").cliExitCode;
  }
};
