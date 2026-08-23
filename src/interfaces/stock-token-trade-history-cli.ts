import {
  canonicalJsonStringify,
  type CanonicalJson,
} from "../core/index.js";
import {
  stockTokenTradeHistoryInterfaceErrorMappings,
  stockTokenTradeHistoryApplicationContract,
  type StockTokenTradeHistoryInput,
  type StockTokenTradeHistoryResult,
} from "../stock-token-trade-history/index.js";
import { deliveryUnknownCliExitCode } from "./delivery-exit.js";
import type { RuntimeDispatchPort } from "./http-client.js";
import { stockTokenTradeHistoryInterfaceBinding } from "./identities.js";
import { dispatchStockTokenTradeHistoryRead } from "./stock-token-trade-history-http.js";
import {
  stockTokenTradeHistoryChartIntervalLabel,
  stockTokenTradeCoverageLimitationLabel,
  stockTokenTradeHistoryLabel,
  stockTokenTradeHistoryNoTradeLabel,
  stockTokenTradeHistoryUnavailableReasonLabel,
  stockTokenTradeHistoryWindowLabel,
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

export const parseStockTokenTradeHistoryCliCommand = (
  argumentsInput: readonly string[],
): StockTokenTradeHistoryCliCommand => {
  const [domain, command, ...tokens] = argumentsInput;
  if (
    domain !== stockTokenTradeHistoryInterfaceBinding.cli.domain ||
    command !== stockTokenTradeHistoryInterfaceBinding.cli.command
  ) return invalidInput();
  let json = false;
  let window: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--json") {
      if (json) return invalidInput();
      json = true;
      continue;
    }
    if (token === "--window") {
      const value = tokens[index + 1];
      if (window !== undefined || value === undefined || value.startsWith("--")) return invalidInput();
      window = value;
      index += 1;
      continue;
    }
    if (token === undefined || token.startsWith("--")) return invalidInput();
    positionals.push(token);
  }
  if (positionals.length !== 1) return invalidInput();
  try {
    return Object.freeze({
      kind: "stock_token_trade_history",
      json,
      input: stockTokenTradeHistoryApplicationContract.parseInput({
        symbol: positionals[0],
        ...(window === undefined ? {} : { window }),
      }),
    });
  } catch {
    return invalidInput();
  }
};

const humanResult = (result: StockTokenTradeHistoryResult): string => {
  const lines = [
    "Stock Token trade history",
    `Token: ${stockTokenTradeHistoryLabel(result)}`,
    `Requested period: ${stockTokenTradeHistoryWindowLabel(result.window)}`,
  ];
  if (result.status === "unavailable") {
    lines.push(
      "Status: Unavailable",
      `Reason: ${stockTokenTradeHistoryUnavailableReasonLabel(result.reason)}`,
    );
    return lines.join("\n");
  }
  if (result.freshness === "stale") lines.push("Freshness: Stale");
  if (result.coverage.status === "partial") lines.push("Coverage: Partial");
  lines.push(...result.coverage.limitations.map((limitation) =>
    `Limitation: ${stockTokenTradeCoverageLimitationLabel(limitation)}`));
  const latestPosition = result.chart.positions.findLast((position) => position.candle !== null);
  const latest = latestPosition?.candle;
  if (latest === undefined || latest === null || latestPosition === undefined) {
    const noTrade = stockTokenTradeHistoryNoTradeLabel(result);
    if (noTrade === undefined) {
      throw new TypeError("Trade-history result has no identifiable latest chart candle.");
    }
    lines.push(noTrade);
  } else {
    const interval = stockTokenTradeHistoryChartIntervalLabel(result.window);
    lines.push(
      `Latest ${interval} chart close: ${latest.close.numerator} / ${latest.close.denominator} USDG`,
      `Trades observed: ${latest.observedStart} to ${latest.observedEnd}`,
    );
  }
  return lines.join("\n");
};

export const runStockTokenTradeHistoryCliCommand = async (
  runtime: RuntimeDispatchPort,
  command: StockTokenTradeHistoryCliCommand,
  output: StockTokenTradeHistoryCliOutputPort,
  signal?: AbortSignal,
): Promise<number> => {
  const result = await dispatchStockTokenTradeHistoryRead(
    runtime,
    stockTokenTradeHistoryInterfaceBinding,
    command.input,
    signal,
  );
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
  const value = stockTokenTradeHistoryApplicationContract.parsePublicSuccess(command.input, result.value);
  output.writeOutput(command.json
    ? `${canonicalJsonStringify(value as unknown as CanonicalJson)}\n`
    : `${humanResult(value)}\n`);
  return 0;
};
