import { requestReviewLimits } from "../review/request-limits.js";
import {canonicalJsonStringify, captureCanonicalJson, createApplicationFailure, parseCapabilityInput, parseCapabilitySuccess} from "../core/index.js";
import {evmAccountIdentitySchema} from "../evm/identities.js";
import {parseEvmAddressInput} from "../evm/address-input.js";
import {productChainId} from "../registry/client.js";
import { exchangeApplicationContracts } from "../review/application-contracts.js";
import { exchangeCommandSchema, type ExchangeCommand } from "../review/exchange.js";
import type { ExchangeReview, ReadyExchangeReview } from "../review/contracts.js";
import { receiptApplicationContracts } from "../receipt-activity/application-contracts.js";
import { receiptActivityErrorRegistry } from "../receipt-activity/errors.js";
import { receiptActivityInterfaceErrorMappings } from "../receipt-activity/error-mappings.js";
import { exchangeErrorRegistry } from "../review/errors.js";
import { exchangeInterfaceErrorMappings } from "../review/error-mappings.js";
import { uniswapV4PoolsCapability, uniswapV4PoolsEvidence } from "../protocols/uniswap-v4/pools.js";
import { uniswapV4PoolsInterface, uniswapV4PoolsLocalIdentity } from "./identities.js";
import { exchangeBindings, activityBindings } from "./exchange-bindings.js";
import { dispatchCanonical, type RuntimeDispatchPort } from "./http-client.js";
import { LocalOperationClient } from "./operation-client.js";
import { readCliDecision, type CliDecisionPort } from "./cli-operation.js";
import { deliveryUnknownCliExitCode } from "./delivery-exit.js";
import { exchangeReviewSections, transactionRecordSections, transactionSectionsText, walletOutcomeText } from "./exchange-presentation.js";

export type ExchangeCliCommand =
  | { kind: "start"; input: ExchangeCommand; json: false }
  | { kind: "get_review"; operationId: string; json: boolean }
  | { kind: "cancel_review"; operationId: string; json: boolean }
  | { kind: "pools"; stockTokenAddress: string; json: boolean }
  | { kind: "get" | "inspect"; input: ReturnType<typeof receiptApplicationContracts.get.parseInput>; json: boolean }
  | { kind: "list"; input: ReturnType<typeof receiptApplicationContracts.list.parseInput>; json: boolean };
const invalid = (): never => { throw new TypeError("Exchange command input is invalid."); };
export const parseExchangeCliCommand = (args: readonly string[]): ExchangeCliCommand => {
  const [domain, command, ...tokens] = args;
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  let json = false;
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i]!;
    if (value === "--json") { if (json) invalid(); json = true; }
    else if (value.startsWith("--")) {
      if (flags.has(value)) invalid();
      if (value === "--active") flags.set(value, "true");
      else { const next = tokens[++i]; if (next === undefined || next.startsWith("--")) invalid(); flags.set(value, next ?? invalid()); }
    } else positionals.push(value);
  }
  const take = (name: string): string | undefined => { const value = flags.get(name); flags.delete(name); return value; };
  let result: ExchangeCliCommand;
  if (domain === "uniswap-v4" && command === "list-pools") {
    const address = positionals.shift();
    result = { kind: "pools", stockTokenAddress: parseEvmAddressInput(address), json };
  } else if (domain === "exchange" && (command === "get-review" || command === "cancel-review")) {
    const input = exchangeApplicationContracts.get.parseInput({ operationId: positionals.shift() });
    result = { kind: command === "get-review" ? "get_review" : "cancel_review", ...input, json };
  } else if (domain === "exchange" && (command === "start" || command === "replace-fees")) {
    if (json) invalid();
    const address = take("--address"), active = take("--active");
    if ((address === undefined) === (active === undefined)) invalid();
    const account = address === undefined ? { kind: "active_wallet" } : { kind: "address", address };
    const fees = { maxFeePerGas: take("--max-fee"), maxPriorityFeePerGas: take("--priority-fee") };
    const input = command === "replace-fees" ? { kind: "replace_fees", account, fees, transactionHash: positionals.shift() } : {
      account, stockTokenAddress: take("--stock-token"), direction: take("--direction"), poolId: take("--pool"),
      conditions: { basis: take("--basis"), inputRelation: take("--input-relation"), inputAmount: take("--input"), outputRelation: take("--output-relation"), outputAmount: take("--output") },
      fees, deadline: take("--deadline"), ...(() => { const gasLimit = take("--gas-limit"), replaces = take("--replaces");
        return { ...(gasLimit === undefined ? {} : { gasLimit }), ...(replaces === undefined ? {} : { replaces }) }; })(),
    };
    result = { kind: "start", input: exchangeCommandSchema.parse(input), json: false };
  } else if (domain === "activity" && (command === "get" || command === "inspect" || command === "list")) {
    const account = evmAccountIdentitySchema.parse({ chainId: productChainId, address: parseEvmAddressInput(take("--address")) });
    if (command === "list") {
      const after = take("--after");
      result = { kind: "list", input: receiptApplicationContracts.list.parseInput({ account, cursor: after === undefined ? null : { account, after } }), json };
    } else result = { kind: command, input: receiptApplicationContracts.get.parseInput({ account, transactionHash: positionals.shift() }), json };
  } else return invalid();
  if (flags.size > 0 || positionals.length > 0) invalid();
  return result;
};

export const runExchangeCliCommand = async (runtime: RuntimeDispatchPort, client: LocalOperationClient, command: ExchangeCliCommand,
  output: CliDecisionPort & { writeError(value: string): void }): Promise<number> => {
  const print = (value: unknown, human: string) => output.writeOutput(`${command.json ? canonicalJsonStringify(captureCanonicalJson(value)) : human}\n`);
  const showFailure = (failure: import("../core/index.js").ApplicationFailure): number => {
    if (command.json) output.writeError(`${canonicalJsonStringify(captureCanonicalJson(failure))}\n`);
    else output.writeError(`${failure.error.code}: ${failure.error.message}\n`);
    return exchangeInterfaceErrorMappings.get(failure.error.code).cliExitCode;
  };
  const showStoredResult = async (account: ReturnType<typeof receiptApplicationContracts.get.parseInput>["account"], transactionHash: string): Promise<void> => {
    const input = receiptApplicationContracts.get.parseInput({ account, transactionHash });
    const stored = await dispatchCanonical(runtime, { requestClass: "public_read", method: "POST", path: activityBindings.get.path,
      body: captureCanonicalJson(input), signal: output.interruptSignal }, 200,
      { applicationErrors: receiptActivityErrorRegistry, interfaceMappings: receiptActivityInterfaceErrorMappings });
    if (!stored.ok) { output.writeError(`Stored result unavailable: ${stored.failure.error.message}\n`); return; }
    output.writeOutput(`${transactionSectionsText(transactionRecordSections(receiptApplicationContracts.get.parsePublicSuccess(input, stored.value)))}\n`);
  };
  if (command.kind === "start") {
    if (!output.inputIsTTY || !output.outputIsTTY) return showFailure(createApplicationFailure(exchangeErrorRegistry, "interactive_terminal_required"));
    let result: import("./operation-client.js").LocalOperationResult<ExchangeReview> | undefined = await client.invoke(exchangeBindings.start.identity, command.input, output.interruptSignal);
    if ("status" in result) return deliveryUnknownCliExitCode;
    if (!result.ok) return showFailure(result.failure);
    output.writeOutput(`${transactionSectionsText(exchangeReviewSections(result.value))}\n`);
    if (result.value.state !== "ready_for_wallet_review") return 2;
    let review: ReadyExchangeReview | undefined = result.value;
    // The terminal presentation is not an execution cache. Drop the complete
    // result and the direct input as soon as their next owner consumes them.
    result = undefined;
    const operationId = review.observation.data.operationId;
    const account = review.observation.data.intent.account;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.min(requestReviewLimits.reviewLifetimeMilliseconds,
      Math.max(0, Date.parse(review.observation.data.actionExpiresAt) - Date.now())));
    timer.unref();
    try {
      const answer = await readCliDecision({ ...output, interruptSignal: AbortSignal.any([output.interruptSignal, deadline.signal]) }, "Request this transaction in the Wallet? [y/N] ");
      clearTimeout(timer);
      if (answer !== "accepted" || output.interruptSignal.aborted) {
        review = undefined;
        const cancelled = await client.invoke(exchangeBindings.cancel.identity, { operationId });
        output.writeOutput(deadline.signal.aborted ? "Decision expired. This CLI decision sent no Wallet request.\n" :
          "status" in cancelled || !cancelled.ok ? "This CLI decision sent no Wallet request. Server discard was not confirmed; the decision retains its original expiry.\n" :
            cancelled.value.status === "discarded" ? "Decision discarded. This CLI decision sent no Wallet request.\n" :
              "The decision is already unavailable. This CLI decision sent no Wallet request; another control's outcome is not established here.\n");
        return 0;
      }
      const pending = client.invoke(exchangeBindings.request.identity, { review, initiatedBy: "cli" }, output.interruptSignal);
      review = undefined;
      const decided = await pending;
      if ("status" in decided) { output.writeError(`${walletOutcomeText({ status: "delivery_unknown" })}\n`); return deliveryUnknownCliExitCode; }
      if (!decided.ok) return showFailure(decided.failure);
      output.writeOutput(`${decided.value.kind === "wallet_result" ? walletOutcomeText(decided.value.outcome) : transactionSectionsText(exchangeReviewSections(decided.value.review))}\n`);
      if (decided.value.kind === "wallet_result" && decided.value.outcome.status === "hash_returned" && decided.value.outcome.recording === "recorded") {
        await showStoredResult(account, decided.value.outcome.transactionHash);
      }
      return decided.value.kind === "review" ? 2 : decided.value.outcome.status === "delivery_unknown" ? deliveryUnknownCliExitCode : 0;
    } finally { clearTimeout(timer); review = undefined; }
  }
  if (command.kind === "get_review" || command.kind === "cancel_review") {
    const binding = command.kind === "get_review" ? exchangeBindings.get : exchangeBindings.cancel;
    const value = await client.invoke(binding.identity as import("./local-operation.js").LocalOperationIdentity<unknown, unknown>, { operationId: command.operationId }, output.interruptSignal);
    if ("status" in value) return deliveryUnknownCliExitCode;
    if (!value.ok) return showFailure(value.failure);
    print(value.value, command.kind === "get_review" ? value.value === null ? "The decision is unavailable." : transactionSectionsText(exchangeReviewSections(exchangeApplicationContracts.get.parsePublicSuccess({ operationId: command.operationId }, value.value)!)) : "The temporary decision is discarded or already unavailable.");
    return 0;
  }
  if (command.kind === "pools") {
    const input = parseCapabilityInput(uniswapV4PoolsCapability, { stockTokenAddress: command.stockTokenAddress });
    const result = await client.invoke(uniswapV4PoolsLocalIdentity, input, output.interruptSignal);
    if ("status" in result) return deliveryUnknownCliExitCode;
    if (!result.ok) return showFailure(result.failure);
    const value = parseCapabilitySuccess(uniswapV4PoolsCapability, input, result.value);
    print(value, ["Pool candidates (current liquidity and execution not established)", ...value.data.candidates.map((pool) => `${pool.poolId}: fee ${pool.poolKey.fee} millionths; token ${pool.stockTokenAddress}`), ...uniswapV4PoolsEvidence.staticScopeExclusions.map((item) => item.message)].join("\n"));
    return 0;
  }
  if (command.kind === "inspect") {
    const result = await client.invoke(activityBindings.inspect.identity, command.input, output.interruptSignal);
    if ("status" in result) return deliveryUnknownCliExitCode;
    if (!result.ok) return showFailure(result.failure);
    print(result.value, `Result query: ${result.value.status}; observed ${result.value.observation ?? "no result"}. Ledger ${result.value.recorded ? "recorded" : "not recorded"}. Use activity get to read the complete record.`);
    if (!command.json && result.value.recorded) await showStoredResult(command.input.account, command.input.transactionHash);
    return result.value.status === "unavailable" ? 4 : 0;
  }
  const binding = command.kind === "list" ? activityBindings.list : activityBindings.get;
  const result = await dispatchCanonical(runtime, { requestClass: "public_read", method: "POST", path: binding.path, body: captureCanonicalJson(command.input), signal: output.interruptSignal }, 200,
    { applicationErrors: receiptActivityErrorRegistry, interfaceMappings: receiptActivityInterfaceErrorMappings });
  if (!result.ok) return showFailure(result.failure);
  if (command.kind === "list") {
    const value = receiptApplicationContracts.list.parsePublicSuccess(command.input, result.value);
    print(value, value.records.length === 0 ? "No recorded transactions for this account." : value.records.map((entry) => transactionSectionsText(transactionRecordSections(entry))).join("\n\n") + (value.nextCursor === null ? "" : `\nContinue with --after ${value.nextCursor.after}.`));
  } else print(result.value, transactionSectionsText(transactionRecordSections(receiptApplicationContracts.get.parsePublicSuccess(command.input, result.value))));
  return 0;
};
