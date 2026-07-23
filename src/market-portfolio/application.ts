import {
  findReferencePair,
  referenceHistoryWindowDefinitions,
  type ApplicationFailure,
  type EvmAccountIdentity,
  type ReferenceFeedId,
  type ReferenceHistoryTraversalReport,
  type ReferenceHistoryInput,
  type ReferenceHistorySuccess,
  type ReferencePriceInput,
  type ReferencePriceSuccess,
  type ReferenceWatchlistMutationInput,
  type ReferenceWatchlistReorderInput,
  type ReferenceWatchlistSuccess,
} from "../core/index.js";
import type { ReferenceFeedCacheSnapshot } from "../runtime/reference-market-storage.js";
import type { RuntimeRevision } from "../runtime/runtime-identity.js";
import {
  captureConnectedWalletSession,
  type ConnectedWalletSession,
} from "../token-catalog/active-wallet.js";
import { createReferenceHistory } from "./candles.js";
import {
  referenceMarketApplicationContracts,
} from "./application-contracts.js";
import type { ReferenceMarketApplicationContract } from "./contracts.js";
import {
  ReferenceMarketOperationError,
  normalizeReferenceMarketError,
} from "./errors.js";
import { readReferencePrice } from "./latest.js";
import type {
  ReferenceMarketApplicationDependencies,
  ReferenceMarketApplicationPort,
} from "./ports.js";
import { ReferenceFeedSynchronizationOwner } from "./synchronization.js";

type CapturedWallet = Readonly<{
  account: EvmAccountIdentity;
  connectionRevision: RuntimeRevision;
  sessionSourceId: string;
}>;

const sameAccount = (left: EvmAccountIdentity, right: EvmAccountIdentity): boolean =>
  left.chainId === right.chainId && left.address === right.address;

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

const parseFailure = <Input, Success>(
  contract: ReferenceMarketApplicationContract<Input, Success>,
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

  addPair(
    input: ReferenceWatchlistMutationInput,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistSuccess | ApplicationFailure> {
    return this.#mutate("add", referenceMarketApplicationContracts.add, input, signal);
  }

  removePair(
    input: ReferenceWatchlistMutationInput,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistSuccess | ApplicationFailure> {
    return this.#mutate("remove", referenceMarketApplicationContracts.remove, input, signal);
  }

  reorderPairs(
    input: ReferenceWatchlistReorderInput,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistSuccess | ApplicationFailure> {
    return this.#runMutation(referenceMarketApplicationContracts.reorder, input, signal, (request) => {
      const wallet = captureWallet(this.#dependencies);
      const result = this.#dependencies.store.mutateWatchlist({
        account: wallet.account,
        expectedConnectionRevision: wallet.connectionRevision,
        expectedRevision: request.expectedRevision,
        mutation: { kind: "reorder", pairIds: request.pairIds },
        now: this.#dependencies.clock.now(),
      });
      if (result.status === "rejected") throw new ReferenceMarketOperationError(result.reason);
      return result.watchlist;
    });
  }

  #mutate(
    kind: "add" | "remove",
    contract: typeof referenceMarketApplicationContracts.add | typeof referenceMarketApplicationContracts.remove,
    input: ReferenceWatchlistMutationInput,
    signal?: AbortSignal,
  ): Promise<ReferenceWatchlistSuccess | ApplicationFailure> {
    return this.#runMutation(contract, input, signal, (request) => {
      const wallet = captureWallet(this.#dependencies);
      const result = this.#dependencies.store.mutateWatchlist({
        account: wallet.account,
        expectedConnectionRevision: wallet.connectionRevision,
        expectedRevision: request.expectedRevision,
        mutation: { kind, pairId: request.pairId },
        now: this.#dependencies.clock.now(),
      });
      if (result.status === "rejected") throw new ReferenceMarketOperationError(result.reason);
      return result.watchlist;
    });
  }

  #runRead<Input, Success>(
    contract: ReferenceMarketApplicationContract<Input, Success>,
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
      if (initialCancellation !== undefined) {
        return parseFailure(contract, initialCancellation);
      }
      let success: Success | undefined;
      let failure: unknown;
      try {
        success = await operation(request, interruptSignal);
      } catch (error) {
        failure = error;
      }
      const cancellation = terminalCancellation(callerSignal, this.#owner.signal);
      if (cancellation !== undefined) return parseFailure(contract, cancellation);
      if (failure !== undefined) return parseFailure(contract, failure);
      try {
        return contract.parsePublicSuccess(request, success as Success);
      } catch (error) {
        return parseFailure(contract, error);
      }
    })();
    let settlement!: Promise<void>;
    settlement = execution.then(() => undefined, () => undefined).finally(() => this.#active.delete(settlement));
    this.#active.add(settlement);
    return execution;
  }

  #runMutation<Input, Success>(
    contract: ReferenceMarketApplicationContract<Input, Success>,
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
      // The synchronous store result fixes the durable outcome. Cancellation
      // observed after this call may affect delivery but cannot reclassify it.
      return Promise.resolve(contract.parsePublicSuccess(request, operation(request)));
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
