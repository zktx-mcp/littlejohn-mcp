import {
  canonicalJsonStringify,
  findReferencePair,
  parseUtcTimestamp,
  referenceHistoryWindowDefinitions,
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
  createDirectReferenceCandleSeries,
  createReferenceHistory,
} from "./candles.js";
import {
  createReferenceWatchlistReviewProjection,
  parseReferenceWatchlistReview,
  referenceMarketApplicationContracts,
  referenceWatchlistDirectActionSchema,
  referenceWatchlistOperationLimits,
  referenceWatchlistReviewDigest,
  type ReferenceMarketApplicationContract,
  type ReferenceMarketCapabilityId,
  type ReferenceWatchlistDirectAction,
  type ReferenceWatchlistOperation,
  type ReferenceWatchlistOperationInput,
  type ReferenceWatchlistReview,
  type ReferenceWatchlistReviewRequest,
  type ReferenceWatchlistReviewResult,
} from "./contracts.js";
import {
  ReferenceMarketOperationError,
  normalizeReferenceMarketError,
} from "./errors.js";
import { readReferencePrice } from "./latest.js";
import type {
  ReferenceMarketApplicationDependencies,
  ReferenceMarketApplicationPort,
} from "./ports.js";
import {
  createAvailableStockTokenMarketResult,
  createStockTokenMarketUnavailableAfterChainRead,
  resolveStockTokenMarketAsset,
  stockTokenHistoryInterval,
  type StockTokenMarketInput,
  type StockTokenMarketResult,
} from "./stock-token-market.js";
import { ReferenceFeedSynchronizationOwner } from "./synchronization.js";

type CapturedWallet = Readonly<{
  account: EvmAccountIdentity;
  connectionRevision: RuntimeRevision;
  sessionSourceId: string;
}>;

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

const captureWallet = (dependencies: ReferenceMarketApplicationDependencies): CapturedWallet => {
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
  ) throw new ReferenceMarketOperationError("state_conflict");
};

const parseFailure = <Input, Success, CapabilityId extends ReferenceMarketCapabilityId, Context>(
  contract: ReferenceMarketApplicationContract<Input, Success, CapabilityId, Context>,
  error: unknown,
): ApplicationFailure => {
  try {
    return contract.parseFailure(normalizeReferenceMarketError(error).failure);
  } catch {
    return contract.normalizeFailure(undefined);
  }
};

const terminalCancellation = (
  callerSignal: AbortSignal | undefined,
  ownerSignal: AbortSignal,
): ReferenceMarketOperationError | undefined =>
  callerSignal?.aborted === true
    ? new ReferenceMarketOperationError("request_aborted")
    : ownerSignal.aborted
      ? new ReferenceMarketOperationError("runtime_state_unavailable")
      : undefined;

const addMilliseconds = (value: UtcTimestamp, milliseconds: number): UtcTimestamp =>
  parseUtcTimestamp(new Date(Date.parse(value) + milliseconds).toISOString());

export class ReferenceMarketApplication implements ReferenceMarketApplicationPort {
  readonly #dependencies: ReferenceMarketApplicationDependencies;
  readonly #synchronization: ReferenceFeedSynchronizationOwner;
  readonly #owner = new AbortController();
  readonly #active = new Set<Promise<void>>();
  #state: "open" | "closing" | "closed" = "open";
  #closePromise: Promise<void> | undefined;

  constructor(dependencies: ReferenceMarketApplicationDependencies) {
    this.#dependencies = dependencies;
    this.#synchronization = new ReferenceFeedSynchronizationOwner({
      chain: dependencies.chain,
      store: dependencies.store,
      clock: dependencies.clock,
    });
  }

  price(input: ReferencePriceInput, signal?: AbortSignal): Promise<ReferencePriceSuccess | ApplicationFailure> {
    return this.#runRead(referenceMarketApplicationContracts.price, input, signal, async (request, activeSignal) =>
      this.#dependencies.chainInvocations.run(activeSignal, (context) =>
        readReferencePrice(this.#dependencies.chain, request.pairId, context)));
  }

  history(input: ReferenceHistoryInput, signal?: AbortSignal): Promise<ReferenceHistorySuccess | ApplicationFailure> {
    return this.#runRead(referenceMarketApplicationContracts.history, input, signal, async (request, activeSignal) => {
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
            referenceHistoryWindowDefinitions[request.window].windowMilliseconds) / 1_000,
        ));
        const snapshots = new Map<ReferenceFeedId, ReferenceFeedCacheSnapshot>();
        const reports = new Map<ReferenceFeedId, ReferenceHistoryTraversalReport>();
        for (const feedId of pair.contract.sourceIds) {
          const source = latest.find((observation) => observation.fact.feedId === feedId);
          if (source === undefined) throw new ReferenceMarketOperationError("source_inconsistent");
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
      referenceMarketApplicationContracts.stockTokenMarket,
      input,
      signal,
      async (request, activeSignal) => {
        const official = await this.#dependencies.officialAssets.synchronize(activeSignal);
        if (official.status === "unavailable") {
          throw new ReferenceMarketOperationError(official.reason);
        }
        const resolution = resolveStockTokenMarketAsset(request, official.snapshot);
        if (resolution.status !== "mapped") return resolution;
        const reference = await this.#dependencies.chainInvocations.run(activeSignal, async (context) => {
          const block = await this.#dependencies.chain.resolveCurrentBlock(context);
          const feedId = resolution.mapping.disposition.mapping.feed.feedId;
          const read = await this.#dependencies.chain.readStockTokenAtBlock({
            member: resolution.officialAsset.member,
            feedId,
            block,
          }, context);
          if (read.status !== "observed") {
            return Object.freeze({
              status: "unavailable" as const,
              result: createStockTokenMarketUnavailableAfterChainRead({
                request,
                resolution,
                block: block.anchor,
                read,
              }),
            });
          }
          const requestedStartUnixSeconds = BigInt(Math.floor(
            (Date.parse(block.anchor.blockTimestamp) -
              referenceHistoryWindowDefinitions[request.window].windowMilliseconds) / 1_000,
          ));
          const synchronized = await this.#synchronization.synchronize({
            feedId,
            block,
            requestedStartUnixSeconds,
            latest: read.latest,
            context,
          });
          const series = createDirectReferenceCandleSeries({
            feedId,
            window: request.window,
            block: block.anchor,
            snapshot: synchronized.snapshot,
          });
          return Object.freeze({
            status: "available" as const,
            block: block.anchor,
            read,
            series,
            snapshot: synchronized.snapshot,
            report: synchronized.report,
          });
        });
        if (reference.status === "unavailable") return reference.result;
        const interval = stockTokenHistoryInterval(request.window, reference.block.blockTimestamp);
        const execution = await this.#dependencies.stockTokenExecutionIndex.read({
          token: resolution.officialAsset.member.contractAddress,
          requestedStart: interval.requestedStart,
          requestedEnd: interval.requestedEnd,
        }, activeSignal);
        return createAvailableStockTokenMarketResult({
          request,
          resolution,
          block: reference.block,
          read: reference.read,
          series: reference.series,
          snapshot: reference.snapshot,
          report: reference.report,
          execution,
        });
      },
    );
  }

  watchlist(
    input: Record<string, never>,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistSuccess | ApplicationFailure> {
    return this.#runRead(referenceMarketApplicationContracts.watchlist, input, signal, async (_request, activeSignal) => {
      if (activeSignal.aborted) throw new ReferenceMarketOperationError("request_aborted");
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
    const contract = referenceMarketApplicationContracts.watchlistChangeReview;
    return this.#runSynchronous(contract, input, signal, (request) => {
      const operationId = createOperationId();
      if (this.#dependencies.store.readWatchlistOperation(operationId) !== null) {
        throw new ReferenceMarketOperationError("state_conflict");
      }
      const wallet = captureWallet(this.#dependencies);
      const watchlist = this.#dependencies.store.readWatchlist(wallet.account);
      if (watchlist.revision !== request.expectedRevision) {
        throw new ReferenceMarketOperationError("state_conflict");
      }
      const projection = createReferenceWatchlistReviewProjection({
        kind: request.kind,
        currentEntries: watchlist.entries,
        ...(request.kind === "reorder"
          ? { pairIds: request.pairIds }
          : { pairId: request.pairId }),
      });
      if (projection.status === "rejected") {
        throw new ReferenceMarketOperationError(projection.reason);
      }
      const finalWallet = captureWallet(this.#dependencies);
      const finalWatchlist = this.#dependencies.store.readWatchlist(wallet.account);
      assertWalletContinuity(wallet, finalWallet);
      if (!sameWatchlist(watchlist, finalWatchlist)) {
        throw new ReferenceMarketOperationError("state_conflict");
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
        referenceMarketApplicationContracts.add,
        new ReferenceMarketOperationError("invalid_input"),
      ));
    }
    const contract = action.review.kind === "add"
      ? referenceMarketApplicationContracts.add
      : action.review.kind === "remove"
        ? referenceMarketApplicationContracts.remove
        : referenceMarketApplicationContracts.reorder;
    return this.#runSynchronous(contract as never, action as never, signal, () => {
      const admitted = contract.parseInput(action as never) as ReferenceWatchlistDirectAction;
      const existing = this.#dependencies.store.readWatchlistOperation(admitted.review.operationId);
      if (existing !== null) {
        if (!sameReview(existing.review, admitted.review) || existing.kind !== admitted.review.kind) {
          throw new ReferenceMarketOperationError("state_conflict");
        }
        return contract.parsePublicSuccess(admitted as never, existing as never) as ReferenceWatchlistOperation;
      }
      if (Date.parse(admitted.review.actionExpiresAt) <= Date.parse(this.#dependencies.clock.now())) {
        throw new ReferenceMarketOperationError("watchlist_review_expired");
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
      ) throw new ReferenceMarketOperationError("state_conflict");
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
    const contract = referenceMarketApplicationContracts.operation;
    return this.#runSynchronous(contract, input, signal, (request) => {
      const operation = this.#dependencies.store.readWatchlistOperation(request.operationId);
      if (operation === null) throw new ReferenceMarketOperationError("watchlist_operation_not_found");
      return contract.parsePublicSuccess(request, operation);
    });
  }

  #assertReviewPrecondition(review: ReferenceWatchlistReview): void {
    const initialWallet = captureWallet(this.#dependencies);
    if (
      !sameAccount(initialWallet.account, review.precondition.account) ||
      initialWallet.connectionRevision !== review.precondition.connectionRevision
    ) throw new ReferenceMarketOperationError("state_conflict");
    const current = this.#dependencies.store.readWatchlist(review.precondition.account);
    if (
      current.revision !== review.precondition.watchlistRevision ||
      canonicalJsonStringify(current.entries as unknown as CanonicalJson) !==
        canonicalJsonStringify(review.precondition.currentEntries as unknown as CanonicalJson)
    ) throw new ReferenceMarketOperationError("state_conflict");
    const finalWallet = captureWallet(this.#dependencies);
    const final = this.#dependencies.store.readWatchlist(review.precondition.account);
    assertWalletContinuity(initialWallet, finalWallet);
    if (!sameWatchlist(current, final)) throw new ReferenceMarketOperationError("state_conflict");
  }

  #runRead<Input, Success, CapabilityId extends ReferenceMarketCapabilityId, Context>(
    contract: ReferenceMarketApplicationContract<Input, Success, CapabilityId, Context>,
    input: unknown,
    callerSignal: AbortSignal | undefined,
    operation: (request: Input, signal: AbortSignal) => Promise<Success>,
  ): Promise<Success | ApplicationFailure> {
    if (this.#state !== "open") {
      return Promise.resolve(parseFailure(
        contract,
        new ReferenceMarketOperationError("runtime_state_unavailable"),
      ));
    }
    const execution = (async (): Promise<Success | ApplicationFailure> => {
      let request: Input;
      try { request = contract.parseInput(input); }
      catch {
        const cancellation = terminalCancellation(callerSignal, this.#owner.signal);
        return parseFailure(
          contract,
          cancellation ?? new ReferenceMarketOperationError("invalid_input"),
        );
      }
      const interruptSignal = callerSignal === undefined
        ? this.#owner.signal
        : AbortSignal.any([callerSignal, this.#owner.signal]);
      const initialCancellation = terminalCancellation(callerSignal, this.#owner.signal);
      if (initialCancellation !== undefined) return parseFailure(contract, initialCancellation);
      let success: Success | undefined;
      let failure: unknown;
      try { success = await operation(request, interruptSignal); }
      catch (error) { failure = error; }
      const cancellation = terminalCancellation(callerSignal, this.#owner.signal);
      if (cancellation !== undefined) return parseFailure(contract, cancellation);
      if (failure !== undefined) return parseFailure(contract, failure);
      try { return contract.parsePublicSuccess(request, success as Success); }
      catch (error) { return parseFailure(contract, error); }
    })();
    let settlement!: Promise<void>;
    settlement = execution.then(() => undefined, () => undefined)
      .finally(() => this.#active.delete(settlement));
    this.#active.add(settlement);
    return execution;
  }

  #runSynchronous<Input, Success, CapabilityId extends ReferenceMarketCapabilityId, Context>(
    contract: ReferenceMarketApplicationContract<Input, Success, CapabilityId, Context>,
    input: unknown,
    callerSignal: AbortSignal | undefined,
    operation: (request: Input) => Success,
  ): Promise<Success | ApplicationFailure> {
    if (this.#state !== "open") {
      return Promise.resolve(parseFailure(
        contract,
        new ReferenceMarketOperationError("runtime_state_unavailable"),
      ));
    }
    let request: Input;
    try { request = contract.parseInput(input); }
    catch {
      const cancellation = terminalCancellation(callerSignal, this.#owner.signal);
      return Promise.resolve(parseFailure(
        contract,
        cancellation ?? new ReferenceMarketOperationError("invalid_input"),
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
    this.#state = "closing";
    this.#owner.abort();
    this.#closePromise = this.#synchronization.close()
      .then(() => Promise.allSettled([...this.#active]))
      .then(() => { this.#state = "closed"; });
    return this.#closePromise;
  }
}
