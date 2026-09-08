import type { StockTokenTradeHistoryData } from "../stock-token-trade-history/result.js";
import type { StockTokenTradeHistoryInput } from "../stock-token-trade-history/period-contract.js";
import {
  canonicalJsonStringify,
  captureCanonicalJson,
  getCapabilityDefinitionSnapshot,
  parseCapabilityInput,
  parseCapabilitySuccess,
  type CanonicalJson,
  type CapabilitySuccess,
} from "../core/index.js";
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
import { stockTokenTradeHistoryInterface } from "./identities.js";
import {
  stockTokenTradeHistoryHumanSummary,
} from "./stock-token-trade-history-presentation.js";

export type StockTokenTradeHistoryCliCommand = Readonly<{
  kind: "stock_token_trade_history";
  json: boolean;
  input: StockTokenTradeHistoryInput;
}>;

export interface StockTokenTradeHistoryCliOutputPort {
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

export const parseStockTokenTradeHistoryCliCommand = (
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

const humanResult = (success: CapabilitySuccess<StockTokenTradeHistoryData>): string =>
  stockTokenTradeHistoryHumanSummary(success.data);

export const runStockTokenTradeHistoryCliCommand = async (
  runtime: RuntimeDispatchPort,
  command: StockTokenTradeHistoryCliCommand,
  output: StockTokenTradeHistoryCliOutputPort,
  signal?: AbortSignal,
): Promise<number> => {
  const result = constrainInterfaceFailure(await dispatchCanonical(runtime, {
    requestClass: "public_read",
    method: "POST",
    path: stockTokenTradeHistoryInterface.http.path,
    body: captureCanonicalJson(command.input),
    ...(signal === undefined ? {} : { signal }),
  }, 200, stockTokenTradeHistoryInterface.responseAuthority),
  getCapabilityDefinitionSnapshot(stockTokenTradeHistoryCapability).failureCodes);
  if ("status" in result) {
    if (command.json) output.writeOutput(`${canonicalJsonStringify(result as unknown as CanonicalJson)}\n`);
    else output.writeError("delivery_unknown: The trade-history result may be unavailable after sending began.\n");
    return deliveryUnknownCliExitCode;
  }
  if (!result.ok) {
    if (command.json) output.writeOutput(`${canonicalJsonStringify(result.failure as unknown as CanonicalJson)}\n`);
    else output.writeError(`${result.failure.error.code}: ${result.failure.error.message}\n`);
    return stockTokenTradeHistoryInterfaceErrorMappings.get(result.failure.error.code).cliExitCode;
  }
  let value: CapabilitySuccess<StockTokenTradeHistoryData>;
  try {
    value = parseCapabilitySuccess(stockTokenTradeHistoryCapability, command.input, result.value);
  } catch {
    const failure = createInterfaceFailure("internal_error");
    if (command.json) {
      output.writeOutput(`${canonicalJsonStringify(failure as unknown as CanonicalJson)}\n`);
    } else output.writeError(`${failure.error.code}: ${failure.error.message}\n`);
    return stockTokenTradeHistoryInterfaceErrorMappings.get("internal_error").cliExitCode;
  }
  output.writeOutput(command.json
    ? `${canonicalJsonStringify(value as unknown as CanonicalJson)}\n`
    : `${humanResult(value)}\n`);
  return 0;
};
