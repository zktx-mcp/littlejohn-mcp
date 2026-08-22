import {
  canonicalJsonStringify,
  findReferencePair,
  marketTimeWindowDefinitions,
  parseUtcTimestamp,
  type ApplicationFailure,
  type CanonicalJson,
  type EvmAccountIdentity,
  type ReferenceFeedId,
  type ReferenceHistoryTraversalReport,
  type ReferenceHistoryInput,
  type ReferenceHistorySuccess,
  type ReferencePriceInput,
  type ReferencePriceSuccess,
  type ReferenceWatchlistSuccess,
  type UtcTimestamp,
} from "../core/index.js";
import type { ReferenceFeedCacheSnapshot } from "../runtime/reference-market-storage.js";
import { createOperationId } from "../runtime/operation-id.js";
import type { RuntimeRevision } from "../runtime/runtime-identity.js";
import {
  captureConnectedWalletSession,
  type ConnectedWalletSession,
} from "../token-catalog/active-wallet.js";
import {
  createReferenceHistory,
} from "./candles.js";
import {
  createReferenceWatchlistReviewProjection,
  parseReferenceWatchlistReview,
  marketPortfolioApplicationContracts,
  referenceWatchlistDirectActionSchema,
  referenceWatchlistOperationLimits,
  referenceWatchlistReviewDigest,
  type MarketPortfolioApplicationContract,
  type MarketPortfolioCapabilityId,
  type ReferenceWatchlistDirectAction,
  type ReferenceWatchlistOperation,
  type ReferenceWatchlistOperationInput,
  type ReferenceWatchlistReview,
  type ReferenceWatchlistReviewRequest,
  type ReferenceWatchlistReviewResult,
} from "./contracts.js";
import {
  MarketPortfolioOperationError,
  normalizeMarketPortfolioError,
} from "./errors.js";
import { readReferencePrice } from "./latest.js";
import type {
  MarketPortfolioApplicationDependencies,
  MarketPortfolioApplicationPort,
} from "./ports.js";
import {
  createAvailableStockTokenMarketResult,
  createStockTokenMarketUnavailableAfterStockFactoryRead,
  resolveStockTokenOfficialAsset,
  stockTokenMarketInterval,
  type StockTokenMarketInput,
  type StockTokenMarketResult,
} from "./stock-token-market.js";
import { readStockTokenReference } from "./stock-token-reference.js";
import {
  findStockTokenExecutionIndexAsset,
  unavailableStockTokenExecutionSeries,
} from "./stock-token-execution-index.js";
import { ReferenceFeedSynchronizationOwner } from "./synchronization.js";

type CapturedWallet = Readonly<{
  account: EvmAccountIdentity;
  connectionRevision: RuntimeRevision;
  sessionSourceId: string;
}>;

type ReadSettlement<Value> =
  | Readonly<{ readonly status: "fulfilled"; readonly value: Value }>
  | Readonly<{ readonly status: "rejected"; readonly reason: unknown }>;

const sameAccount = (left: EvmAccountIdentity, right: EvmAccountIdentity): boolean =>
  left.chainId === right.chainId && left.address === right.address;

const sameWatchlist = (
  left: ReferenceWatchlistSuccess,
  right: ReferenceWatchlistSuccess,
): boolean => canonicalJsonStringify(left as unknown as CanonicalJson) ===
  canonicalJsonStringify(right as unknown as CanonicalJson);

const sameReview = (
  left: ReferenceWatchlistReview,
  right: ReferenceWatchlistReview,
): boolean => canonicalJsonStringify(left as unknown as CanonicalJson) ===
  canonicalJsonStringify(right as unknown as CanonicalJson);

const captureWallet = (dependencies: MarketPortfolioApplicationDependencies): CapturedWallet => {
  const captured: ConnectedWalletSession = captureConnectedWalletSession(dependencies.activeWallet);
  return Object.freeze({
    account: captured.account,
    connectionRevision: captured.connectionRevision,
    sessionSourceId: captured.sessionSource.sourceId,
  });
};

const assertWalletContinuity = (initial: CapturedWallet, final: CapturedWallet): void => {
  if (
    !sameAccount(initial.account, final.account) ||
    initial.connectionRevision !== final.connectionRevision ||
    initial.sessionSourceId !== final.sessionSourceId
  ) throw new MarketPortfolioOperationError("state_conflict");
};

const parseFailure = <Input, Success, CapabilityId extends MarketPortfolioCapabilityId, Context>(
  contract: MarketPortfolioApplicationContract<Input, Success, CapabilityId, Context>,
  error: unknown,
): ApplicationFailure => {
  try {
    return contract.parseFailure(normalizeMarketPortfolioError(error).failure);
  } catch {
    return contract.normalizeFailure(undefined);
  }
};

const terminalCancellation = (
  callerSignal: AbortSignal | undefined,
  ownerSignal: AbortSignal,
): MarketPortfolioOperationError | undefined =>
  callerSignal?.aborted === true
    ? new MarketPortfolioOperationError("request_aborted")
    : ownerSignal.aborted
      ? new MarketPortfolioOperationError("runtime_state_unavailable")
      : undefined;

const addMilliseconds = (value: UtcTimestamp, milliseconds: number): UtcTimestamp =>
  parseUtcTimestamp(new Date(Date.parse(value) + milliseconds).toISOString());

export class MarketPortfolioApplication implements MarketPortfolioApplicationPort {
  readonly #dependencies: MarketPortfolioApplicationDependencies;
  readonly #synchronization: ReferenceFeedSynchronizationOwner;
  readonly #owner = new AbortController();
  readonly #active = new Set<Promise<void>>();
  #state: "open" | "closing" | "closed" = "open";
  #closePromise: Promise<void> | undefined;

  constructor(dependencies: MarketPortfolioApplicationDependencies) {
    this.#dependencies = dependencies;
    this.#synchronization = new ReferenceFeedSynchronizationOwner({
      chain: dependencies.chain,
      store: dependencies.store,
      clock: dependencies.clock,
    });
  }

  price(input: ReferencePriceInput, signal?: AbortSignal): Promise<ReferencePriceSuccess | ApplicationFailure> {
    return this.#runRead(marketPortfolioApplicationContracts.price, input, signal, async (request, activeSignal) =>
      this.#dependencies.chainInvocations.run(activeSignal, (context) =>
        readReferencePrice(this.#dependencies.chain, request.pairId, context)));
  }

  history(input: ReferenceHistoryInput, signal?: AbortSignal): Promise<ReferenceHistorySuccess | ApplicationFailure> {
    return this.#runRead(marketPortfolioApplicationContracts.history, input, signal, async (request, activeSignal) => {
      return this.#dependencies.chainInvocations.run(activeSignal, async (context) => {
        const pair = findReferencePair(request.pairId);
        const block = await this.#dependencies.chain.resolveCurrentBlock(context);
        const latest = await this.#dependencies.chain.readLatestAtBlock(
          pair.contract.sourceIds,
          block,
          context,
        );
        const requestedStartUnixSeconds = BigInt(Math.floor(
          (Date.parse(block.anchor.blockTimestamp) -
            marketTimeWindowDefinitions[request.window].durationMilliseconds) / 1_000,
        ));
        const snapshots = new Map<ReferenceFeedId, ReferenceFeedCacheSnapshot>();
        const reports = new Map<ReferenceFeedId, ReferenceHistoryTraversalReport>();
        for (const feedId of pair.contract.sourceIds) {
          const source = latest.find((observation) => observation.fact.feedId === feedId);
          if (source === undefined) throw new TypeError("Reference market latest read is incomplete.");
          const synchronized = await this.#synchronization.synchronize({
            feedId,
            block,
            requestedStartUnixSeconds,
            latest: source,
            context,
          });
          snapshots.set(feedId, synchronized.snapshot);
          reports.set(feedId, synchronized.report);
        }
        return createReferenceHistory({
          pair,
          window: request.window,
          block: block.anchor,
          snapshots,
          reports,
        });
      });
    });
  }

  stockTokenMarket(
    input: StockTokenMarketInput,
    signal?: AbortSignal,
  ): Promise<StockTokenMarketResult | ApplicationFailure> {
    return this.#runRead(
      marketPortfolioApplicationContracts.stockTokenMarket,
      input,
      signal,
      async (request, activeSignal) => {
        const official = await this.#dependencies.officialAssets.synchronize(activeSignal);
        if (official.status === "unavailable") {
          throw new MarketPortfolioOperationError(official.reason);
        }
        const resolution = resolveStockTokenOfficialAsset(request, official.snapshot);
        if (resolution.status !== "resolved") return resolution;
        return await this.#dependencies.chainInvocations.run(activeSignal, async (context) => {
          const block = await this.#dependencies.chain.resolveCurrentBlock(context);
          const stockFactory = await this.#dependencies.officialAssetReads.verifyAtBlock(
            resolution.officialAsset.member,
            block,
            context,
          );
          if (stockFactory.status === "unavailable") {
            return createStockTokenMarketUnavailableAfterStockFactoryRead({
              request,
              resolution,
              block: block.anchor,
              stockFactory,
            });
          }
          const interval = stockTokenMarketInterval(request.window, block.anchor.blockTimestamp);
          const referenceWork = readStockTokenReference({
            officialAsset: resolution.officialAsset,
            window: request.window,
            interval,
            block,
            context,
            chain: this.#dependencies.chain,
            synchronization: this.#synchronization,
          });
          const executionAsset = findStockTokenExecutionIndexAsset(
            resolution.officialAsset.member.contractAddress,
          );
          const executionWork = (async () => executionAsset === undefined
            ? unavailableStockTokenExecutionSeries(interval, "asset_not_indexed")
            : await this.#dependencies.stockTokenExecutionIndex.read({
                pairId: executionAsset.poolId,
                requestedStart: interval.requestedStart,
                requestedEnd: interval.requestedEnd,
              }, context.signal))();
          const [reference, execution] = await Promise.allSettled([referenceWork, executionWork]);
          if (reference.status === "rejected") throw reference.reason;
          if (execution.status === "rejected") throw execution.reason;
          return createAvailableStockTokenMarketResult({
            request,
            resolution,
            block: block.anchor,
            stockFactory: stockFactory.verification,
            reference: reference.value,
            execution: execution.value,
          });
        });
      },
    );
  }

  watchlist(
    input: Record<string, never>,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistSuccess | ApplicationFailure> {
    return this.#runRead(marketPortfolioApplicationContracts.watchlist, input, signal, async (_request, activeSignal) => {
      if (activeSignal.aborted) throw new MarketPortfolioOperationError("request_aborted");
      const wallet = captureWallet(this.#dependencies);
      const watchlist = this.#dependencies.store.readWatchlist(wallet.account);
      assertWalletContinuity(wallet, captureWallet(this.#dependencies));
      return watchlist;
    });
  }

  reviewWatchlistChange(
    input: ReferenceWatchlistReviewRequest,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistReviewResult | ApplicationFailure> {
    const contract = marketPortfolioApplicationContracts.watchlistChangeReview;
    return this.#runSynchronous(contract, input, signal, (request) => {
      const operationId = createOperationId();
      if (this.#dependencies.store.readWatchlistOperation(operationId) !== null) {
        throw new MarketPortfolioOperationError("state_conflict");
      }
      const wallet = captureWallet(this.#dependencies);
      const watchlist = this.#dependencies.store.readWatchlist(wallet.account);
      if (watchlist.revision !== request.expectedRevision) {
        throw new MarketPortfolioOperationError("state_conflict");
      }
      const projection = createReferenceWatchlistReviewProjection({
        kind: request.kind,
        currentEntries: watchlist.entries,
        ...(request.kind === "reorder"
          ? { pairIds: request.pairIds }
          : { pairId: request.pairId }),
      });
      if (projection.status === "rejected") {
        throw new MarketPortfolioOperationError(projection.reason);
      }
      const finalWallet = captureWallet(this.#dependencies);
      const finalWatchlist = this.#dependencies.store.readWatchlist(wallet.account);
      assertWalletContinuity(wallet, finalWallet);
      if (!sameWatchlist(watchlist, finalWatchlist)) {
        throw new MarketPortfolioOperationError("state_conflict");
      }
      const createdAt = this.#dependencies.clock.now();
      const withoutDigest = {
        contractVersion: "1" as const,
        domain: "reference_watchlist" as const,
        operationId,
        kind: request.kind,
        createdAt,
        actionExpiresAt: addMilliseconds(
          createdAt,
          referenceWatchlistOperationLimits.reviewActionMilliseconds,
        ),
        target: projection.projection.target,
        decision: projection.projection.decision,
        precondition: {
          account: wallet.account,
          connectionRevision: wallet.connectionRevision,
          watchlistRevision: watchlist.revision,
          currentEntries: watchlist.entries,
        },
        fixedEvidence: projection.projection.fixedEvidence,
      };
      const review = parseReferenceWatchlistReview({
        ...withoutDigest,
        reviewDigest: referenceWatchlistReviewDigest(withoutDigest),
      });
      return contract.parsePublicSuccess(request, { review });
    });
  }

  decideWatchlistChange(
    input: ReferenceWatchlistDirectAction,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistOperation | ApplicationFailure> {
    let action: ReferenceWatchlistDirectAction;
    try { action = referenceWatchlistDirectActionSchema.parse(input); }
    catch {
      return Promise.resolve(parseFailure(
        marketPortfolioApplicationContracts.add,
        new MarketPortfolioOperationError("invalid_input"),
      ));
    }
    const contract = action.review.kind === "add"
      ? marketPortfolioApplicationContracts.add
      : action.review.kind === "remove"
        ? marketPortfolioApplicationContracts.remove
        : marketPortfolioApplicationContracts.reorder;
    return this.#runSynchronous(contract as never, action as never, signal, () => {
      const admitted = contract.parseInput(action as never) as ReferenceWatchlistDirectAction;
      const existing = this.#dependencies.store.readWatchlistOperation(admitted.review.operationId);
      if (existing !== null) {
        if (!sameReview(existing.review, admitted.review) || existing.kind !== admitted.review.kind) {
          throw new MarketPortfolioOperationError("state_conflict");
        }
        return contract.parsePublicSuccess(admitted as never, existing as never) as ReferenceWatchlistOperation;
      }
      if (Date.parse(admitted.review.actionExpiresAt) <= Date.parse(this.#dependencies.clock.now())) {
        throw new MarketPortfolioOperationError("watchlist_review_expired");
      }
      this.#assertReviewPrecondition(admitted.review);
      const projection = createReferenceWatchlistReviewProjection({
        kind: admitted.review.kind,
        currentEntries: admitted.review.precondition.currentEntries,
        ...(admitted.review.kind === "reorder"
          ? { pairIds: admitted.review.target.entries.map((entry) => entry.pairId) }
          : { pairId: admitted.review.target.pair.pairId }),
      });
      if (
        projection.status !== "success" ||
        canonicalJsonStringify({
          target: admitted.review.target,
          decision: admitted.review.decision,
          fixedEvidence: admitted.review.fixedEvidence,
        } as unknown as CanonicalJson) !== canonicalJsonStringify({
          target: projection.status === "success" ? projection.projection.target : null,
          decision: projection.status === "success" ? projection.projection.decision : null,
          fixedEvidence: projection.status === "success" ? projection.projection.fixedEvidence : null,
        } as unknown as CanonicalJson)
      ) throw new MarketPortfolioOperationError("state_conflict");
      this.#assertReviewPrecondition(admitted.review);
      const operation = this.#dependencies.store.applyWatchlistChange({
        action: admitted,
        completedAt: this.#dependencies.clock.now(),
      });
      return contract.parsePublicSuccess(admitted as never, operation as never) as ReferenceWatchlistOperation;
    }) as Promise<ReferenceWatchlistOperation | ApplicationFailure>;
  }

  getWatchlistOperation(
    input: ReferenceWatchlistOperationInput,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistOperation | ApplicationFailure> {
    const contract = marketPortfolioApplicationContracts.operation;
    return this.#runSynchronous(contract, input, signal, (request) => {
      const operation = this.#dependencies.store.readWatchlistOperation(request.operationId);
      if (operation === null) throw new MarketPortfolioOperationError("watchlist_operation_not_found");
      return contract.parsePublicSuccess(request, operation);
    });
  }

  #assertReviewPrecondition(review: ReferenceWatchlistReview): void {
    const initialWallet = captureWallet(this.#dependencies);
    if (
      !sameAccount(initialWallet.account, review.precondition.account) ||
      initialWallet.connectionRevision !== review.precondition.connectionRevision
    ) throw new MarketPortfolioOperationError("state_conflict");
    const current = this.#dependencies.store.readWatchlist(review.precondition.account);
    if (
      current.revision !== review.precondition.watchlistRevision ||
      canonicalJsonStringify(current.entries as unknown as CanonicalJson) !==
        canonicalJsonStringify(review.precondition.currentEntries as unknown as CanonicalJson)
    ) throw new MarketPortfolioOperationError("state_conflict");
    const finalWallet = captureWallet(this.#dependencies);
    const final = this.#dependencies.store.readWatchlist(review.precondition.account);
    assertWalletContinuity(initialWallet, finalWallet);
    if (!sameWatchlist(current, final)) throw new MarketPortfolioOperationError("state_conflict");
  }

  #runRead<Input, Success, CapabilityId extends MarketPortfolioCapabilityId, Context>(
    contract: MarketPortfolioApplicationContract<Input, Success, CapabilityId, Context>,
    input: unknown,
    callerSignal: AbortSignal | undefined,
    operation: (request: Input, signal: AbortSignal) => Promise<Success>,
  ): Promise<Success | ApplicationFailure> {
    if (this.#state !== "open") {
      return Promise.resolve(parseFailure(
        contract,
        new MarketPortfolioOperationError("runtime_state_unavailable"),
      ));
    }
    let resolveExecution!: (
      result: Success | ApplicationFailure | PromiseLike<Success | ApplicationFailure>
    ) => void;
    let rejectExecution!: (reason: unknown) => void;
    const execution = new Promise<Success | ApplicationFailure>((resolve, reject) => {
      resolveExecution = resolve;
      rejectExecution = reject;
    });
    let settlement!: Promise<void>;
    settlement = execution.then(() => undefined, () => undefined)
      .finally(() => this.#active.delete(settlement));
    this.#active.add(settlement);
    void (async (): Promise<Success | ApplicationFailure> => {
      let request: Input;
      try { request = contract.parseInput(input); }
      catch {
        const cancellation = terminalCancellation(callerSignal, this.#owner.signal);
        return parseFailure(
          contract,
          cancellation ?? new MarketPortfolioOperationError("invalid_input"),
        );
      }
      const interruptSignal = callerSignal === undefined
        ? this.#owner.signal
        : AbortSignal.any([callerSignal, this.#owner.signal]);
      const initialCancellation = terminalCancellation(callerSignal, this.#owner.signal);
      if (initialCancellation !== undefined) return parseFailure(contract, initialCancellation);
      let readSettlement: ReadSettlement<Success>;
      try {
        readSettlement = Object.freeze({
          status: "fulfilled",
          value: await operation(request, interruptSignal),
        });
      } catch (reason) {
        readSettlement = Object.freeze({ status: "rejected", reason });
      }
      const cancellation = terminalCancellation(callerSignal, this.#owner.signal);
      if (cancellation !== undefined) return parseFailure(contract, cancellation);
      if (readSettlement.status === "rejected") {
        return parseFailure(contract, readSettlement.reason);
      }
      try { return contract.parsePublicSuccess(request, readSettlement.value); }
      catch (error) { return parseFailure(contract, error); }
    })().then(resolveExecution, rejectExecution);
    return execution;
  }

  #runSynchronous<Input, Success, CapabilityId extends MarketPortfolioCapabilityId, Context>(
    contract: MarketPortfolioApplicationContract<Input, Success, CapabilityId, Context>,
    input: unknown,
    callerSignal: AbortSignal | undefined,
    operation: (request: Input) => Success,
  ): Promise<Success | ApplicationFailure> {
    if (this.#state !== "open") {
      return Promise.resolve(parseFailure(
        contract,
        new MarketPortfolioOperationError("runtime_state_unavailable"),
      ));
    }
    let request: Input;
    try { request = contract.parseInput(input); }
    catch {
      const cancellation = terminalCancellation(callerSignal, this.#owner.signal);
      return Promise.resolve(parseFailure(
        contract,
        cancellation ?? new MarketPortfolioOperationError("invalid_input"),
      ));
    }
    const cancellation = terminalCancellation(callerSignal, this.#owner.signal);
    if (cancellation !== undefined) return Promise.resolve(parseFailure(contract, cancellation));
    try {
      // A synchronous store commit fixes the durable outcome. A later caller
      // cancellation may affect delivery but cannot reclassify that commit.
      return Promise.resolve(operation(request));
    } catch (error) {
      return Promise.resolve(parseFailure(contract, error));
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    let resolveClose!: () => void;
    let rejectClose!: (reason: unknown) => void;
    const publishedClose = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.#closePromise = publishedClose;
    this.#state = "closing";
    const admitted = [...this.#active];
    void (async () => {
      this.#owner.abort();
      await this.#synchronization.close();
      await Promise.allSettled(admitted);
      this.#state = "closed";
    })().then(resolveClose, rejectClose);
    return publishedClose;
  }
}
