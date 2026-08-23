import type { ApplicationFailure } from "../core/index.js";
import { stockTokenTradeHistoryApplicationContract } from "./contracts.js";
import {
  StockTokenTradeHistoryOperationError,
  normalizeStockTokenTradeHistoryError,
} from "./errors.js";
import type {
  StockTokenTradeHistoryApplicationDependencies,
  StockTokenTradeHistoryApplicationPort,
} from "./ports.js";
import {
  createStockTokenTradeHistoryResult,
  createStockTokenTradeHistoryUnavailableAfterStockFactoryRead,
  resolveStockTokenTradeHistoryOfficialAsset,
  stockTokenTradeHistoryInterval,
  type StockTokenTradeHistoryInput,
  type StockTokenTradeHistoryResult,
} from "./stock-token-trade-history.js";
import {
  findStockTokenTradeHistoryAsset,
  unavailableStockTokenTradeHistoryData,
} from "./stock-token-trade-history-data.js";

type ReadSettlement<Value> =
  | Readonly<{ readonly status: "fulfilled"; readonly value: Value }>
  | Readonly<{ readonly status: "rejected"; readonly reason: unknown }>;

const parseFailure = (error: unknown): ApplicationFailure => {
  try {
    return stockTokenTradeHistoryApplicationContract.parseFailure(
      normalizeStockTokenTradeHistoryError(error).failure,
    );
  } catch {
    return stockTokenTradeHistoryApplicationContract.normalizeFailure(undefined);
  }
};

const terminalCancellation = (
  callerSignal: AbortSignal | undefined,
  ownerSignal: AbortSignal,
): StockTokenTradeHistoryOperationError | undefined => callerSignal?.aborted === true
  ? new StockTokenTradeHistoryOperationError("request_aborted")
  : ownerSignal.aborted
    ? new StockTokenTradeHistoryOperationError("runtime_state_unavailable")
    : undefined;

export class StockTokenTradeHistoryApplication implements StockTokenTradeHistoryApplicationPort {
  readonly #dependencies: StockTokenTradeHistoryApplicationDependencies;
  readonly #owner = new AbortController();
  readonly #active = new Set<Promise<void>>();
  #state: "open" | "closing" | "closed" = "open";
  #closePromise: Promise<void> | undefined;

  constructor(dependencies: StockTokenTradeHistoryApplicationDependencies) {
    this.#dependencies = dependencies;
  }

  get(
    input: StockTokenTradeHistoryInput,
    signal?: AbortSignal,
  ): Promise<StockTokenTradeHistoryResult | ApplicationFailure> {
    if (this.#state !== "open") {
      return Promise.resolve(parseFailure(
        new StockTokenTradeHistoryOperationError("runtime_state_unavailable"),
      ));
    }
    let resolveResult!: (
      result: StockTokenTradeHistoryResult | ApplicationFailure |
        PromiseLike<StockTokenTradeHistoryResult | ApplicationFailure>,
    ) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<StockTokenTradeHistoryResult | ApplicationFailure>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let settlement!: Promise<void>;
    settlement = result.then(() => undefined, () => undefined)
      .finally(() => this.#active.delete(settlement));
    this.#active.add(settlement);
    void this.#read(input, signal).then(resolveResult, rejectResult);
    return result;
  }

  async #read(
    input: unknown,
    callerSignal: AbortSignal | undefined,
  ): Promise<StockTokenTradeHistoryResult | ApplicationFailure> {
    let request: StockTokenTradeHistoryInput;
    try { request = stockTokenTradeHistoryApplicationContract.parseInput(input); }
    catch {
      const cancellation = terminalCancellation(callerSignal, this.#owner.signal);
      return parseFailure(
        cancellation ?? new StockTokenTradeHistoryOperationError("invalid_input"),
      );
    }
    const interruptSignal = callerSignal === undefined
      ? this.#owner.signal
      : AbortSignal.any([callerSignal, this.#owner.signal]);
    const initialCancellation = terminalCancellation(callerSignal, this.#owner.signal);
    if (initialCancellation !== undefined) return parseFailure(initialCancellation);
    let readSettlement: ReadSettlement<StockTokenTradeHistoryResult>;
    try {
      const official = await this.#dependencies.officialAssets.synchronize(interruptSignal);
      if (official.status === "unavailable") {
        throw new StockTokenTradeHistoryOperationError(official.reason);
      }
      const resolution = resolveStockTokenTradeHistoryOfficialAsset(request, official.snapshot);
      if (resolution.status !== "resolved") {
        readSettlement = Object.freeze({ status: "fulfilled", value: resolution });
      } else {
        const value = await this.#dependencies.chainInvocations.run(interruptSignal, async (context) => {
          const block = await this.#dependencies.currentBlockReads.resolveCurrentBlock(context);
          const stockFactory = await this.#dependencies.officialAssetReads.verifyAtBlock(
            resolution.officialAsset.member,
            block,
            context,
          );
          if (stockFactory.status === "unavailable") {
            return createStockTokenTradeHistoryUnavailableAfterStockFactoryRead({
              request,
              resolution,
              block: block.anchor,
              stockFactory,
            });
          }
          const interval = stockTokenTradeHistoryInterval(request.window, block.anchor.blockTimestamp);
          const asset = findStockTokenTradeHistoryAsset(
            resolution.officialAsset.member.contractAddress,
          );
          const data = asset === undefined
            ? unavailableStockTokenTradeHistoryData(interval, "asset_not_supported")
            : await this.#dependencies.tradeHistoryReads.read({
                pairId: asset.poolId,
                window: request.window,
                requestedStart: interval.requestedStart,
                requestedEnd: interval.requestedEnd,
              }, context.signal);
          return createStockTokenTradeHistoryResult({
            request,
            resolution,
            block: block.anchor,
            stockFactory: stockFactory.verification,
            data,
          });
        });
        readSettlement = Object.freeze({ status: "fulfilled", value });
      }
    } catch (reason) {
      readSettlement = Object.freeze({ status: "rejected", reason });
    }
    const cancellation = terminalCancellation(callerSignal, this.#owner.signal);
    if (cancellation !== undefined) return parseFailure(cancellation);
    if (readSettlement.status === "rejected") return parseFailure(readSettlement.reason);
    try {
      return stockTokenTradeHistoryApplicationContract.parsePublicSuccess(
        request,
        readSettlement.value,
      );
    } catch (error) {
      return parseFailure(error);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = "closing";
    this.#owner.abort();
    const admitted = [...this.#active];
    this.#closePromise = Promise.allSettled(admitted).then(() => {
      this.#state = "closed";
    });
    return this.#closePromise;
  }
}
