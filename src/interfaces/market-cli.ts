import type { StockTokenTradeHistoryInput } from "../stock-token-trade-history/period-contract.js";
import {canonicalJsonStringify, captureCanonicalJson, getCapabilityDefinitionSnapshot, parseCapabilityInput, parseCapabilitySuccess, type CanonicalJson} from "../core/index.js";
import {parseEvmAddressInput} from "../evm/address-input.js";
import {
  stockTokenTradeHistoryCapability,
} from "../stock-token-trade-history/contracts.js";
import {
  stockTokenTradeHistoryInterfaceErrorMappings,
} from "../stock-token-trade-history/errors.js";
import { deliveryUnknownCliExitCode } from "./delivery-exit.js";
import {
  constrainInterfaceFailure,
  createInterfaceFailure,
  dispatchCanonical,
  type RuntimeDispatchPort,
} from "./http-client.js";
import { stockTokenTradeHistoryInterface, stockTokenPricesInterface, stockTokensInterface, type ReadInterfaceIdentity } from "./identities.js";
import { stockTokenPricesCapability, stockTokensCapability } from "../stock-token-prices/contracts.js";
import type { StockTokenPricesInput } from "../stock-token-prices/result.js";

type StockTokenTradeHistoryCliCommand = Readonly<{
  kind: "stock_token_trade_history";
  json: boolean;
  input: StockTokenTradeHistoryInput;
}>;

export interface MarketCliOutputPort {
  writeOutput(value: string): void;
  writeError(value: string): void;
}

const invalidInput = (): never => {
  throw new TypeError("Stock Token trade-history CLI input is invalid.");
};

const parseCount = (value: string | undefined): number => {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return invalidInput();
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : invalidInput();
};

const parseTradeHistory = (
  argumentsInput: readonly string[],
): StockTokenTradeHistoryCliCommand => {
  const [domain, command, ...tokens] = argumentsInput;
  if (
    domain !== stockTokenTradeHistoryInterface.cli.domain ||
    command !== stockTokenTradeHistoryInterface.cli.command
  ) return invalidInput();
  let json = false;
  let period: string | undefined;
  let unit: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--json") {
      if (json) return invalidInput();
      json = true;
      continue;
    }
    if (token === "--period" || token === "--unit") {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) return invalidInput();
      if (token === "--period") {
        if (period !== undefined) return invalidInput();
        period = value;
      } else {
        if (unit !== undefined) return invalidInput();
        unit = value;
      }
      index += 1;
      continue;
    }
    if (token === undefined || token.startsWith("--")) return invalidInput();
    positionals.push(token);
  }
  if (positionals.length !== 1 || (period === undefined) !== (unit === undefined)) {
    return invalidInput();
  }
  try {
    return Object.freeze({
      kind: "stock_token_trade_history",
      json,
      input: parseCapabilityInput(stockTokenTradeHistoryCapability, {
        symbol: positionals[0],
        ...(period === undefined ? {} : { period: { count: parseCount(period), unit } }),
      }),
    });
  } catch {
    return invalidInput();
  }
};

export type MarketCliCommand = StockTokenTradeHistoryCliCommand
  | Readonly<{ kind: "stock_token_prices"; json: boolean; input: StockTokenPricesInput }>
  | Readonly<{ kind: "stock_tokens"; json: boolean; input: Record<string, never> }>;

export const parseMarketCliCommand = (args: readonly string[]): MarketCliCommand => {
  if (args[0] !== "market") return invalidInput();
  if (args[1] === stockTokenTradeHistoryInterface.cli.command) return parseTradeHistory(args);
  if (args[1] !== stockTokenPricesInterface.cli.command && args[1] !== stockTokensInterface.cli.command) return invalidInput();
  const tokens = [...args.slice(2)];
  const flags = tokens.filter((token) => token === "--json");
  if (flags.length > 1) return invalidInput();
  const remaining = tokens.filter((token) => token !== "--json");
  if (args[1] === stockTokensInterface.cli.command) {
    if (remaining.length !== 0) return invalidInput();
    return { kind: "stock_tokens", json: flags.length === 1, input: {} };
  }
  const request = remaining.length === 2 && remaining[0] === "--token" ? { tokenAddress: parseEvmAddressInput(remaining[1]) }
    : remaining.length === 1 && !remaining[0]!.startsWith("--") ? { symbol: remaining[0] } : undefined;
  if (request === undefined) return invalidInput();
  return { kind: "stock_token_prices", json: flags.length === 1, input: parseCapabilityInput(stockTokenPricesCapability, request) };
};

export const runMarketCliCommand = async (
  runtime: RuntimeDispatchPort, command: MarketCliCommand,
  output: MarketCliOutputPort, signal?: AbortSignal,
): Promise<number> => {
  const identity: ReadInterfaceIdentity = command.kind === "stock_token_trade_history" ? stockTokenTradeHistoryInterface
    : command.kind === "stock_token_prices" ? stockTokenPricesInterface : stockTokensInterface;
  const result = constrainInterfaceFailure(await dispatchCanonical(runtime, {
    requestClass: "public_read", path: identity.http.path,
    ...(identity.http.method === "GET" ? { method: "GET" as const } : { method: "POST" as const, body: captureCanonicalJson(command.input) }),
    ...(signal === undefined ? {} : { signal }),
  }, 200, identity.responseAuthority), getCapabilityDefinitionSnapshot(identity.definition).failureCodes);
  if ("status" in result) {
    if (command.json) output.writeOutput(`${canonicalJsonStringify(result as unknown as CanonicalJson)}\n`);
    else output.writeError("delivery_unknown: The read response could not be confirmed.\n");
    return deliveryUnknownCliExitCode;
  }
  if (!result.ok) {
    if (command.json) output.writeOutput(`${canonicalJsonStringify(result.failure as unknown as CanonicalJson)}\n`);
    else output.writeError(`${result.failure.error.code}: ${result.failure.error.message}\n`);
    return identity.responseAuthority.interfaceMappings.get(result.failure.error.code).cliExitCode;
  }
  try {
    const value = parseCapabilitySuccess(identity.definition, command.input, result.value);
    output.writeOutput(command.json ? `${canonicalJsonStringify(captureCanonicalJson(value))}\n`
      : `${identity.projectSuccessText!(value)}\n`);
    return 0;
  } catch {
    const failure = createInterfaceFailure("internal_error");
    if (command.json) output.writeOutput(`${canonicalJsonStringify(captureCanonicalJson(failure))}\n`);
    else output.writeError(`${failure.error.code}: ${failure.error.message}\n`);
    return identity.responseAuthority.interfaceMappings.get("internal_error").cliExitCode;
  }
};
