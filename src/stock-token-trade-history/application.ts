import {
  bindCapability,
  type ApplicationFailure,
  type CapabilityExecutionOwnerPort,
  type HandlerInvocationContext,
  type InvocationBoundaryPorts,
  type ObservationWriter,
} from "../core/index.js";
import { normalizePinnedEvmReadFailure } from "../chain/index.js";
import type { StockFactoryVerificationResult } from "../registry/index.js";
import type { ApplicationAdmission } from "../runtime/application-lifecycle.js";
import {
  projectStockTokenTradeHistoryEvidenceStages,
} from "./capability-evidence.js";
import {
  stockTokenTradeHistoryCapability,
  stockTokenTradeHistoryErrorRegistry,
  stockTokenTradeHistoryEvidence,
  stockTokenTradeHistoryFailureCodes,
} from "./contracts.js";
import {
  createStockTokenTradeHistoryFailure,
} from "./errors.js";
import type { StockTokenTradeHistoryInput } from "./period-contract.js";
import type {
  StockTokenTradeHistoryApplicationDependencies,
  StockTokenTradeHistoryApplicationPort,
} from "./ports.js";
import {
  createStockTokenTradeHistoryArchiveResult,
  createStockTokenTradeHistoryDecimalsUnavailable,
  createStockTokenTradeHistoryStockFactoryUnavailable,
  resolveStockTokenTradeHistoryOfficialAsset,
} from "./result-builder.js";
import {
  stockTokenTradeHistoryRequestAtBlock,
  type StockTokenTradeHistoryData,
} from "./result.js";
import {
  isStockTokenTradeHistorySourceRateLimitError,
} from "./source-contract.js";

type StockTokenTradeHistoryFailureCode = (typeof stockTokenTradeHistoryFailureCodes)[number];

const failure = (code: StockTokenTradeHistoryFailureCode) => Object.freeze({
  status: "failure" as const,
  code,
  issues: Object.freeze([]),
});

class StockTokenTradeHistoryExecutionOwner implements CapabilityExecutionOwnerPort {
  readonly #admission: ApplicationAdmission;
  readonly #owner = new AbortController();
  readonly #active = new Set<Promise<void>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(admission: ApplicationAdmission) {
    this.#admission = admission;
  }

  execute<Result extends ApplicationFailure | Readonly<{ readonly ok: true }>>(
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (this.#closed || !this.#admission.isOpen) {
      return Promise.resolve(createStockTokenTradeHistoryFailure(
        "runtime_state_unavailable",
      ) as Result);
    }
    let resolveResult!: (value: Result | PromiseLike<Result>) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<Result>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    let settlement!: Promise<void>;
    settlement = result.then(() => undefined, () => undefined)
      .finally(() => this.#active.delete(settlement));
    this.#active.add(settlement);
    void this.#run(callerSignal, operation).then(resolveResult, rejectResult);
    return result;
  }

  async #run<Result extends ApplicationFailure | Readonly<{ readonly ok: true }>>(
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (callerSignal.aborted) {
      return createStockTokenTradeHistoryFailure("request_aborted") as Result;
    }
    if (this.#owner.signal.aborted) {
      return createStockTokenTradeHistoryFailure("runtime_state_unavailable") as Result;
    }
    const signal = AbortSignal.any([callerSignal, this.#owner.signal]);
    let result: Result;
    try {
      result = await operation(signal);
    } catch {
      if (callerSignal.aborted) {
        return createStockTokenTradeHistoryFailure("request_aborted") as Result;
      }
      if (this.#owner.signal.aborted) {
        return createStockTokenTradeHistoryFailure("runtime_state_unavailable") as Result;
      }
      return createStockTokenTradeHistoryFailure("internal_error") as Result;
    }
    if (callerSignal.aborted) {
      return createStockTokenTradeHistoryFailure("request_aborted") as Result;
    }
    if (this.#owner.signal.aborted) {
      return createStockTokenTradeHistoryFailure("runtime_state_unavailable") as Result;
    }
    return result;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const active = [...this.#active];
    let resolveClose!: () => void;
    const close = new Promise<void>((resolve) => { resolveClose = resolve; });
    this.#closePromise = close;
    this.#owner.abort();
    void Promise.allSettled(active).then(() => resolveClose());
    return close;
  }
}

const recordEvidence = (
  data: StockTokenTradeHistoryData,
  observations: ObservationWriter,
  dependencies: StockTokenTradeHistoryApplicationDependencies,
): void => {
  const stages = projectStockTokenTradeHistoryEvidenceStages(data);
  const official = observations.bind(stockTokenTradeHistoryEvidence.targets.official);
  observations.record(official.slot, {
    source: dependencies.officialAssetObservationAuthority,
    claims: [{
      role: official.roles.value,
      value: stages.official.claim!,
    }],
  });
  if (!stages.stockFactory.reached || stages.stockFactory.claim === undefined) return;
  const stockFactory = observations.bind(stockTokenTradeHistoryEvidence.targets.stockFactory);
  observations.record(stockFactory.slot, {
    source: dependencies.protocolReads.observationAuthority,
    claims: [{
      role: stockFactory.roles.value,
      value: stages.stockFactory.claim,
      chainAnchor: stages.stockFactory.chainAnchor!,
    }],
  });
  if (!stages.decimals.reached || stages.decimals.claim === undefined) return;
  const decimals = observations.bind(stockTokenTradeHistoryEvidence.targets.decimals);
  observations.record(decimals.slot, {
    source: dependencies.protocolReads.observationAuthority,
    claims: [{
      role: decimals.roles.value,
      value: stages.decimals.claim,
      chainAnchor: stages.decimals.chainAnchor!,
    }],
  });
  if (!stages.archive.reached || stages.archive.claim === undefined) return;
  const archive = observations.bind(stockTokenTradeHistoryEvidence.targets.archive);
  observations.record(archive.slot, {
    source: dependencies.archiveObservationAuthority,
    claims: [{
      role: archive.roles.value,
      value: stages.archive.claim,
    }],
  });
};

const executeRead = async (
  request: StockTokenTradeHistoryInput,
  context: HandlerInvocationContext<InvocationBoundaryPorts>,
  observations: ObservationWriter,
  dependencies: StockTokenTradeHistoryApplicationDependencies,
) => {
  try {
    const official = await dependencies.officialAssets.synchronize(context.signal);
    if (official.status === "unavailable") return failure(official.reason);
    const selected = resolveStockTokenTradeHistoryOfficialAsset(request, official.snapshot);
    let data: StockTokenTradeHistoryData;
    if (selected.status === "unavailable") {
      data = selected.data;
    } else {
      data = await dependencies.chainInvocations.run(context.signal, async (chainContext) => {
        const block = await dependencies.currentBlockReads.resolveCurrentBlock(chainContext);
        const stockFactory: StockFactoryVerificationResult =
          await dependencies.officialAssetReads.verifyAtBlock(
            selected.officialAsset.member,
            block,
            chainContext,
          );
        if (stockFactory.status === "unavailable") {
          return createStockTokenTradeHistoryStockFactoryUnavailable({
            request,
            officialAsset: selected.officialAsset,
            block: block.anchor,
            stockFactory,
          });
        }
        const decimals = await dependencies.protocolReads.readTokenDecimals(
          chainContext,
          block,
          selected.officialAsset.member.contractAddress,
        );
        if (decimals.status === "reverted") {
          return createStockTokenTradeHistoryDecimalsUnavailable({
            request,
            officialAsset: selected.officialAsset,
            block: block.anchor,
            stockFactory: stockFactory.verification,
          });
        }
        const tokenDecimals = Number(decimals.value);
        const requestAtBlock = stockTokenTradeHistoryRequestAtBlock(request, block.anchor);
        const source = await dependencies.source.read({
          baseCurrencyAddress: selected.officialAsset.member.contractAddress,
          baseCurrencyDecimals: tokenDecimals,
          requestedStart: requestAtBlock.requestedStart,
          requestedEnd: requestAtBlock.requestedEnd,
          canonicalBlock: block.anchor,
          resolution: requestAtBlock.resolution.label,
        }, chainContext.signal);
        return createStockTokenTradeHistoryArchiveResult({
          request,
          officialAsset: selected.officialAsset,
          block: block.anchor,
          stockFactory: stockFactory.verification,
          tokenDecimals,
          source,
        });
      });
    }
    recordEvidence(data, observations, dependencies);
    return Object.freeze({ status: "success" as const, data });
  } catch (error) {
    if (isStockTokenTradeHistorySourceRateLimitError(error)) return failure("rate_limited");
    const code = normalizePinnedEvmReadFailure(error, context.signal);
    if (code === "not_found") throw error;
    if (code !== undefined) return failure(code);
    throw error;
  }
};

export const createStockTokenTradeHistoryApplication = (
  dependencies: StockTokenTradeHistoryApplicationDependencies,
): StockTokenTradeHistoryApplicationPort => {
  const owner = new StockTokenTradeHistoryExecutionOwner(dependencies.admission);
  const binding = bindCapability({
    definition: stockTokenTradeHistoryCapability,
    errorRegistry: stockTokenTradeHistoryErrorRegistry,
    invocationAuthority: dependencies.invocationAuthority,
    executionOwner: owner,
    createInvocationPorts: () => dependencies.invocationPorts,
    handler: (request, context, observations) =>
      executeRead(request, context, observations, dependencies),
  });
  return Object.freeze({ binding, close: () => owner.close() });
};
