import {
  ObservationAuthorityRegistry,
  accountBalanceEvidence,
  accountBalanceCapability,
  accountNativeDecimalsExclusion,
  accountTokenEvidenceIdentity,
  bindCapability,
  captureCanonicalJson,
  chainStatusEvidence,
  chainStatusCapability,
  contractInspectEvidence,
  contractInspectCapability,
  receiptLogAmountRole,
  transactionEventDecimalsExclusion,
  transactionInspectEvidence,
  transactionInspectCapability,
  transactionNativeDecimalsExclusion,
  type AccountBalanceData,
  type AccountBalanceInput,
  type BoundEvidenceObservationTarget,
  type CanonicalAmount,
  type CanonicalJson,
  type ChainAnchor,
  type ChainStatusData,
  type ChainStatusInput,
  type ContractInspectData,
  type ContractInspectInput,
  type EvmAddress,
  type EvmChainId,
  type HandlerInvocationContext,
  type InvocationBoundaryPorts,
  type NativeGasRate,
  type ObservationWriter,
  type ObservationAuthority,
  type ObservationClaim,
  type StaticScopeExclusion,
  type TransactionInspectData,
  type TransactionInspectInput,
  type UnsignedDecimal,
} from "../core/index.js";
import type {
  ChainOwnerApplicationContext,
  ChainReadCapabilityPort,
} from "../runtime/application-context.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import {
  chainErrorRegistry,
  ChainOperationError,
  getChainOperationFailure,
} from "./errors.js";
import type { Erc20CallEncoder } from "./evm-standard.js";
import {
  normalizeAbiDecimals,
  normalizeAbiUint256,
  normalizeIncludedTransaction,
  normalizeRpcBlockAnchor,
  normalizeRpcRuntimeCode,
  normalizeRpcTransaction,
  rpcQuantityToUnsignedDecimal,
  type NormalizedAccessList,
  type NormalizedRpcReceipt,
  type NormalizedRpcTransaction,
} from "./normalization.js";
import {
  getChainRpcErrorCode,
  isRpcExecutionRevertedError,
  rpcConcurrencyLimit,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";
import {
  readConfiguredCanonicalBlock,
  resolveConfiguredCanonicalBlock,
} from "./canonical-block.js";
import {
  recordConfiguredChainProof,
  validateConfiguredChain,
} from "./configured-chain.js";
import {
  getChainInvocationStopReason,
  type ChainInvocationContext,
  type ChainInvocationLifecycle,
} from "./invocation-lifecycle.js";

interface ChainInvocationPorts extends InvocationBoundaryPorts {
  readonly account:
    | { readonly status: "not_required" }
    | { readonly status: "available"; readonly address: EvmAddress; readonly active: boolean }
    | { readonly status: "unavailable" };
}

interface HandlerDependencies {
  readonly rpc: RpcRequester;
  readonly encoder: Erc20CallEncoder;
  readonly rpcSource: ObservationAuthority;
  readonly chainId: EvmChainId;
  readonly nativeAsset: Readonly<{ readonly kind: "native"; readonly chainId: EvmChainId }>;
}

const asFailure = (code: string) => ({ status: "failure" as const, code, issues: Object.freeze([]) });

const normalizeSourceValue = <Value>(operation: () => Value): Value => {
  try { return operation(); }
  catch { throw new ChainOperationError("source_inconsistent"); }
};

const asCanonicalJson = (value: unknown): CanonicalJson => captureCanonicalJson(value);

const accessListData = (accessList: NormalizedAccessList): TransactionInspectData["accessList"] =>
  accessList.kind === "none"
    ? { kind: "none" }
    : {
        kind: "entries",
        entries: accessList.entries.map((entry) => ({
          address: entry.address,
          storageKeys: [...entry.storageKeys],
        })),
      };

const runHandler = async (
  lifecycle: ChainInvocationLifecycle,
  callerSignal: AbortSignal,
  operation: (context: ChainInvocationContext) => Promise<unknown>,
): Promise<unknown> => {
  try {
    return await lifecycle.run(callerSignal, operation);
  } catch (error) {
    const stopReason = getChainInvocationStopReason(error);
    if (stopReason !== undefined) {
      return asFailure(stopReason === "caller_aborted" ? "request_aborted" : "source_unavailable");
    }
    const operationFailure = getChainOperationFailure(error);
    if (operationFailure !== undefined) return asFailure(operationFailure.error.code);
    const rpcCode = getChainRpcErrorCode(error);
    if (rpcCode !== undefined) {
      if (rpcCode === "request_aborted" && !callerSignal.aborted) return asFailure("source_unavailable");
      return asFailure(rpcCode);
    }
    throw error;
  }
};

export interface ChainReadService {
  readonly chainReads: ChainReadCapabilityPort;
}

const recordChainId = async (
  dependencies: HandlerDependencies,
  signal: AbortSignal,
  observations: ObservationWriter,
  target: BoundEvidenceObservationTarget<
    typeof chainStatusEvidence.configuredChain.target
  >,
): Promise<void> => {
  await validateConfiguredChain({
    rpc: dependencies.rpc,
    chainId: dependencies.chainId,
    rpcSource: dependencies.rpcSource,
    signal,
    observations,
    target,
  });
};

const resolveBlock = async (
  dependencies: HandlerDependencies,
  selector: ContractInspectInput["block"] | AccountBalanceInput["block"],
  context: ChainInvocationContext,
  observations: ObservationWriter,
  configuredChainTarget: BoundEvidenceObservationTarget<
    typeof contractInspectEvidence.configuredChain.target
  >,
): Promise<{
  readonly anchor: ChainAnchor;
  readonly stateReference: RpcCanonicalBlockReference;
}> => {
  const block = await resolveConfiguredCanonicalBlock({
    rpc: dependencies.rpc,
    chainId: dependencies.chainId,
    selector,
    context,
  });
  const state = readConfiguredCanonicalBlock({
    context,
    block,
    chainId: dependencies.chainId,
  });
  recordConfiguredChainProof({
    proof: state.configuredChainProof,
    rpcSource: dependencies.rpcSource,
    observations,
    target: configuredChainTarget,
  });
  return state;
};

const nativeAmount = (
  raw: UnsignedDecimal,
  observationId: CanonicalAmount["quantityObservationId"],
  exclusion: StaticScopeExclusion,
  chainId: EvmChainId,
): CanonicalAmount => Object.freeze({
  asset: Object.freeze({ kind: "native" as const, chainId }),
  raw,
  decimals: Object.freeze({ status: "not_observed", scopeExclusionId: exclusion.id }),
  quantityObservationId: observationId,
});

const gasRate = (
  raw: UnsignedDecimal,
  observationId: CanonicalAmount["quantityObservationId"],
  chainId: EvmChainId,
): NativeGasRate => Object.freeze({
  numerator: nativeAmount(raw, observationId, transactionNativeDecimalsExclusion, chainId),
  denominator: Object.freeze({ unit: "gas", raw: "1" }),
  observationId,
});

const amountSourceValue = (raw: UnsignedDecimal, exclusion: StaticScopeExclusion, chainId: EvmChainId) => ({
  asset: { kind: "native" as const, chainId },
  raw,
  decimals: { status: "not_observed" as const, scopeExclusionId: exclusion.id },
});

const gasRateSourceValue = (raw: UnsignedDecimal, chainId: EvmChainId) => ({
  numerator: amountSourceValue(raw, transactionNativeDecimalsExclusion, chainId),
  denominator: { unit: "gas" as const, raw: "1" as const },
});

const transactionFeeSourceValue = (transaction: NormalizedRpcTransaction, chainId: EvmChainId) => {
  if (transaction.fee.kind === "legacy") {
    return { kind: "legacy" as const, gasPrice: gasRateSourceValue(transaction.fee.gasPrice, chainId) };
  }
  if (transaction.fee.kind === "dynamic") {
    return {
      kind: "dynamic" as const,
      maxFeePerGas: gasRateSourceValue(transaction.fee.maxFeePerGas, chainId),
      maxPriorityFeePerGas: gasRateSourceValue(transaction.fee.maxPriorityFeePerGas, chainId),
    };
  }
  return { kind: "unsupported" as const, type: transaction.fee.type };
};

const transactionClaims = (
  transaction: NormalizedRpcTransaction,
  chainId: EvmChainId,
  target: BoundEvidenceObservationTarget<
    typeof transactionInspectEvidence.targets.transaction
  >,
  anchor?: ChainAnchor,
): readonly ObservationClaim[] => {
  const anchorFields = anchor === undefined ? {} : { chainAnchor: anchor };
  const claims: ObservationClaim[] = [{
    role: target.roles.transaction,
    value: asCanonicalJson({
      transactionHash: transaction.transactionHash,
      chainId: transaction.chainScope,
      from: transaction.from,
      recipient: transaction.recipient,
      value: amountSourceValue(
        transaction.value,
        transactionNativeDecimalsExclusion,
        chainId,
      ),
      input: transaction.input,
      nonce: transaction.nonce,
      gasLimit: { raw: transaction.gasLimit },
      type: transaction.type,
      accessList: accessListData(transaction.accessList),
      fee: transactionFeeSourceValue(transaction, chainId),
      inclusion: transaction.position.status === "pending"
        ? { status: "pending" as const }
        : {
            status: "included" as const,
            blockNumber: transaction.position.blockNumber,
            blockHash: transaction.position.blockHash,
            transactionIndex: transaction.position.transactionIndex,
          },
    }),
    ...anchorFields,
  }, {
    role: target.roles.value,
    value: transaction.value,
    asset: { kind: "native", chainId },
    ...anchorFields,
  }, {
    role: target.roles.gasLimit,
    value: transaction.gasLimit,
    ...anchorFields,
  }];
  if (transaction.fee.kind === "legacy") {
    claims.push({
      role: target.roles.gasPrice,
      value: transaction.fee.gasPrice,
      asset: { kind: "native", chainId },
      ...anchorFields,
    });
  } else if (transaction.fee.kind === "dynamic") {
    claims.push({
      role: target.roles.maxFeePerGas,
      value: transaction.fee.maxFeePerGas,
      asset: { kind: "native", chainId },
      ...anchorFields,
    }, {
      role: target.roles.maxPriorityFeePerGas,
      value: transaction.fee.maxPriorityFeePerGas,
      asset: { kind: "native", chainId },
      ...anchorFields,
    });
  }
  return Object.freeze(claims);
};

const transactionData = (
  transaction: NormalizedRpcTransaction,
  observationId: CanonicalAmount["quantityObservationId"],
  inclusion: TransactionInspectData["inclusion"],
  chainId: EvmChainId,
): TransactionInspectData => ({
  transactionHash: transaction.transactionHash,
  chainId: transaction.chainScope,
  from: transaction.from,
  recipient: transaction.recipient,
  value: nativeAmount(
    transaction.value,
    observationId,
    transactionNativeDecimalsExclusion,
    chainId,
  ),
  input: transaction.input,
  nonce: transaction.nonce,
  gasLimit: Object.freeze({ raw: transaction.gasLimit, observationId }),
  type: transaction.type,
  accessList: accessListData(transaction.accessList),
  fee: transaction.fee.kind === "legacy"
    ? { kind: "legacy", gasPrice: gasRate(transaction.fee.gasPrice, observationId, chainId) }
    : transaction.fee.kind === "dynamic"
      ? {
          kind: "dynamic",
          maxFeePerGas: gasRate(transaction.fee.maxFeePerGas, observationId, chainId),
          maxPriorityFeePerGas: gasRate(transaction.fee.maxPriorityFeePerGas, observationId, chainId),
        }
      : { kind: "unsupported", type: transaction.fee.type },
  inclusion,
});

const decodedEventSourceValue = (
  log: NormalizedRpcReceipt["logs"][number],
  chainId: EvmChainId,
): CanonicalJson => {
  const event = log.decodedEvent;
  if (event.kind === "not_decoded") return { kind: "not_decoded" };
  const amount = {
    asset: { kind: "erc20" as const, chainId, address: log.address },
    raw: event.amountRaw,
    decimals: {
      status: "not_observed" as const,
      scopeExclusionId: transactionEventDecimalsExclusion.id,
    },
  };
  return event.kind === "erc20_transfer"
    ? asCanonicalJson({ kind: event.kind, token: event.token, from: event.from, to: event.to, amount })
    : asCanonicalJson({
        kind: event.kind,
        token: event.token,
        owner: event.owner,
        spender: event.spender,
        amount,
      });
};

const receiptSourceValue = (
  receipt: NormalizedRpcReceipt,
  chainId: EvmChainId,
): CanonicalJson => asCanonicalJson({
  status: receipt.status,
  cumulativeGasUsed: { raw: receipt.cumulativeGasUsed },
  gasUsed: { raw: receipt.gasUsed },
  effectiveGasPrice: gasRateSourceValue(receipt.effectiveGasPrice, chainId),
  createdContract: receipt.createdContract,
  logs: receipt.logs.map((log) => ({
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    logIndex: log.logIndex,
    transactionIndex: log.transactionIndex,
    decodedEvent: decodedEventSourceValue(log, chainId),
  })),
});

const receiptClaims = (
  receipt: NormalizedRpcReceipt,
  block: ChainAnchor,
  chainId: EvmChainId,
  observations: ObservationWriter,
  target: BoundEvidenceObservationTarget<
    typeof transactionInspectEvidence.targets.receipt
  >,
): readonly ObservationClaim[] => {
  const claims: ObservationClaim[] = [{
    role: target.roles.receipt,
    value: receiptSourceValue(receipt, chainId),
    chainAnchor: block,
  }, {
    role: target.roles.cumulativeGasUsed,
    value: receipt.cumulativeGasUsed,
    chainAnchor: block,
  }, {
    role: target.roles.gasUsed,
    value: receipt.gasUsed,
    chainAnchor: block,
  }, {
    role: target.roles.effectiveGasPrice,
    value: receipt.effectiveGasPrice,
    asset: { kind: "native", chainId },
    chainAnchor: block,
  }];
  receipt.logs.forEach((log, index) => {
    if (log.decodedEvent.kind !== "not_decoded") {
      claims.push({
        role: observations.bindRole(receiptLogAmountRole(index)),
        value: log.decodedEvent.amountRaw,
        asset: { kind: "erc20", chainId, address: log.address },
        chainAnchor: block,
      });
    }
  });
  return Object.freeze(claims);
};

const receiptData = (
  receipt: NormalizedRpcReceipt,
  observationId: CanonicalAmount["quantityObservationId"],
  chainId: EvmChainId,
): Extract<TransactionInspectData["inclusion"], { status: "included" }>["receipt"] => ({
  status: receipt.status,
  cumulativeGasUsed: { raw: receipt.cumulativeGasUsed, observationId },
  gasUsed: { raw: receipt.gasUsed, observationId },
  effectiveGasPrice: gasRate(receipt.effectiveGasPrice, observationId, chainId),
  createdContract: receipt.createdContract,
  logs: receipt.logs.map((log) => ({
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    logIndex: log.logIndex,
    transactionIndex: log.transactionIndex,
    decodedEvent: log.decodedEvent.kind === "not_decoded"
      ? { kind: "not_decoded" }
      : log.decodedEvent.kind === "erc20_transfer"
        ? {
            kind: log.decodedEvent.kind,
            token: log.decodedEvent.token,
            from: log.decodedEvent.from,
            to: log.decodedEvent.to,
            amount: {
              asset: { kind: "erc20", chainId, address: log.address },
              raw: log.decodedEvent.amountRaw,
              decimals: {
                status: "not_observed",
                scopeExclusionId: transactionEventDecimalsExclusion.id,
              },
              quantityObservationId: observationId,
            },
          }
        : {
            kind: log.decodedEvent.kind,
            token: log.decodedEvent.token,
            owner: log.decodedEvent.owner,
            spender: log.decodedEvent.spender,
            amount: {
              asset: { kind: "erc20", chainId, address: log.address },
              raw: log.decodedEvent.amountRaw,
              decimals: {
                status: "not_observed",
                scopeExclusionId: transactionEventDecimalsExclusion.id,
              },
              quantityObservationId: observationId,
            },
          },
  })),
});

interface TokenReadResult {
  readonly asset: {
    readonly kind: "erc20";
    readonly chainId: EvmChainId;
    readonly address: EvmAddress;
  };
  readonly balance:
    | { readonly status: "available"; readonly raw: UnsignedDecimal }
    | { readonly status: "unavailable"; readonly errorCode: "source_unavailable" | "source_inconsistent" };
  readonly decimals:
    | { readonly status: "available"; readonly value: UnsignedDecimal }
    | { readonly status: "unavailable" };
}

const partialTokenError = (error: unknown): "source_unavailable" | "source_inconsistent" | undefined => {
  if (isRpcExecutionRevertedError(error)) return "source_unavailable";
  const rpcCode = getChainRpcErrorCode(error);
  if (rpcCode !== undefined) {
    return rpcCode === "source_unavailable" || rpcCode === "source_inconsistent"
      ? rpcCode
      : undefined;
  }
  const operationFailure = getChainOperationFailure(error);
  if (operationFailure !== undefined) {
    const code = operationFailure.error.code;
    if (code === "source_unavailable") return "source_unavailable";
    if (code === "source_inconsistent") return "source_inconsistent";
  }
  return undefined;
};

const readToken = async (
  dependencies: HandlerDependencies,
  token: EvmAddress,
  account: EvmAddress,
  block: RpcCanonicalBlockReference,
  signal: AbortSignal,
): Promise<TokenReadResult> => {
  const asset = Object.freeze({ kind: "erc20" as const, chainId: dependencies.chainId, address: token });
  let raw: UnsignedDecimal;
  try {
    const result = await dependencies.rpc.request("eth_call", [{
      to: token,
      data: dependencies.encoder.balanceOf(account),
    }, block], signal);
    raw = normalizeSourceValue(() => normalizeAbiUint256(result));
  } catch (error) {
    const errorCode = partialTokenError(error);
    if (errorCode === undefined) throw error;
    return Object.freeze({
      asset,
      balance: Object.freeze({ status: "unavailable" as const, errorCode }),
      decimals: Object.freeze({ status: "unavailable" as const }),
    });
  }

  try {
    const result = await dependencies.rpc.request("eth_call", [{
      to: token,
      data: dependencies.encoder.decimals(),
    }, block], signal);
    return Object.freeze({
      asset,
      balance: Object.freeze({ status: "available" as const, raw }),
      decimals: Object.freeze({ status: "available" as const, value: normalizeSourceValue(() => normalizeAbiDecimals(result)) }),
    });
  } catch (error) {
    const errorCode = partialTokenError(error);
    if (errorCode === undefined) throw error;
    return Object.freeze({
      asset,
      balance: Object.freeze({ status: "available" as const, raw }),
      decimals: Object.freeze({ status: "unavailable" as const }),
    });
  }
};

const readTokensBounded = async (
  dependencies: HandlerDependencies,
  tokens: readonly EvmAddress[],
  account: EvmAddress,
  block: RpcCanonicalBlockReference,
  signal: AbortSignal,
): Promise<readonly TokenReadResult[]> => {
  const output: Array<TokenReadResult | undefined> = new Array(tokens.length);
  let next = 0;
  let fatal: unknown;
  const stop = new AbortController();
  const workerSignal = AbortSignal.any([signal, stop.signal]);
  const worker = async (): Promise<void> => {
    while (fatal === undefined) {
      const index = next;
      next += 1;
      const token = tokens[index];
      if (token === undefined) return;
      try { output[index] = await readToken(dependencies, token, account, block, workerSignal); }
      catch (error) {
        fatal ??= error;
        stop.abort();
      }
    }
  };
  const workers = Array.from({ length: Math.min(tokens.length, rpcConcurrencyLimit) }, () => worker());
  await Promise.allSettled(workers);
  if (fatal !== undefined) throw fatal;
  if (output.some((entry) => entry === undefined)) throw new TypeError("Token read scheduling is incomplete.");
  return Object.freeze(output as TokenReadResult[]);
};

export const createChainReadService = (input: {
  readonly context: ChainOwnerApplicationContext<ActiveWalletReadPort>;
  readonly rpc: RpcRequester;
  readonly encoder: Erc20CallEncoder;
  readonly lifecycle: ChainInvocationLifecycle;
}): ChainReadService => {
  const rpcSource = input.context.chain.sourceAuthority.observationAuthority;
  const chainId = input.context.chain.configuration.chain.chainId;
  const nativeAsset = Object.freeze({ kind: "native" as const, chainId });
  const dependencies: HandlerDependencies = Object.freeze({
    rpc: input.rpc,
    encoder: input.encoder,
    rpcSource,
    chainId,
    nativeAsset,
  });
  const basePorts = input.context.chain.capabilityAuthority.invocationPorts;
  const execute = (
    callerSignal: AbortSignal,
    operation: (context: ChainInvocationContext) => Promise<unknown>,
  ): Promise<unknown> => runHandler(input.lifecycle, callerSignal, operation);
  const notRequiredPorts = (): ChainInvocationPorts => Object.freeze({
    observations: basePorts.observations,
    account: Object.freeze({ status: "not_required" as const }),
  });

  const accountPorts = (request: AccountBalanceInput): ChainInvocationPorts => {
    if (request.account.kind === "address") {
      return Object.freeze({
        observations: basePorts.observations,
        account: Object.freeze({ status: "available" as const, address: request.account.address, active: false }),
      });
    }
    const snapshot = input.context.activeWallet.capture();
    if (snapshot.connection.status !== "connected") {
      return Object.freeze({
        observations: basePorts.observations,
        account: Object.freeze({ status: "unavailable" as const }),
      });
    }
    if (snapshot.connection.chainId !== chainId) {
      throw new TypeError("Active wallet chain does not match the configured chain.");
    }
    if (snapshot.sessionSource === undefined) throw new TypeError("Connected wallet source is unavailable.");
    return Object.freeze({
      observations: new ObservationAuthorityRegistry(
        input.context.chain.capabilityAuthority.clock,
        [rpcSource, snapshot.sessionSource.observationAuthority],
      ),
      account: Object.freeze({
        status: "available" as const,
        address: snapshot.connection.address,
        active: true,
      }),
    });
  };

  const chainStatus = bindCapability({
    definition: chainStatusCapability,
    errorRegistry: chainErrorRegistry,
    invocationAuthority: input.context.chain.capabilityAuthority.invocationAuthority,
    createInvocationPorts: (_request: ChainStatusInput) => notRequiredPorts(),
    handler: async (_request, context: HandlerInvocationContext<ChainInvocationPorts>, observations) =>
      execute(context.signal, async (chainInvocation) => {
        const signal = chainInvocation.signal;
        const configuredChain = observations.bind(
          chainStatusEvidence.configuredChain.target,
        );
        const latestBlockTarget = observations.bind(
          chainStatusEvidence.targets.latestBlock,
        );
        await recordChainId(dependencies, signal, observations, configuredChain);
        const rawBlock = await dependencies.rpc.request("eth_getBlockByNumber", ["latest", false], signal);
        if (rawBlock === null) throw new ChainOperationError("source_inconsistent");
        const latestBlock = normalizeSourceValue(() => normalizeRpcBlockAnchor(rawBlock, chainId));
        observations.record(latestBlockTarget.slot, {
          source: rpcSource,
          claims: [{
            role: latestBlockTarget.roles.block,
            value: latestBlock,
            chainAnchor: latestBlock,
          }],
        });
        const data: ChainStatusData = {
          chainId,
          latestBlock,
        };
        return { status: "success", data };
      }),
  });

  const contractInspect = bindCapability({
    definition: contractInspectCapability,
    errorRegistry: chainErrorRegistry,
    invocationAuthority: input.context.chain.capabilityAuthority.invocationAuthority,
    createInvocationPorts: (_request: ContractInspectInput) => notRequiredPorts(),
    handler: async (request, context: HandlerInvocationContext<ChainInvocationPorts>, observations) =>
      execute(context.signal, async (chainInvocation) => {
        const signal = chainInvocation.signal;
        const configuredChain = observations.bind(
          contractInspectEvidence.configuredChain.target,
        );
        const blockTarget = observations.bind(contractInspectEvidence.targets.block);
        const runtimeCodeTarget = observations.bind(
          contractInspectEvidence.targets.runtimeCode,
        );
        const block = await resolveBlock(
          dependencies,
          request.block,
          chainInvocation,
          observations,
          configuredChain,
        );
        const rawCode = await dependencies.rpc.request(
          "eth_getCode",
          [request.address, block.stateReference],
          signal,
        );
        const runtimeCode = normalizeSourceValue(() => normalizeRpcRuntimeCode(rawCode));
        const data: ContractInspectData = { address: request.address, block: block.anchor, runtimeCode };
        observations.record(blockTarget.slot, {
          source: rpcSource,
          claims: [{
            role: blockTarget.roles.block,
            value: { address: data.address, block: data.block },
            chainAnchor: data.block,
          }],
        });
        observations.record(runtimeCodeTarget.slot, {
          source: rpcSource,
          claims: [{
            role: runtimeCodeTarget.roles.runtimeCode,
            value: { address: data.address, runtimeCode: data.runtimeCode },
            chainAnchor: data.block,
          }],
        });
        return { status: "success", data };
      }),
  });

  const transactionInspect = bindCapability({
    definition: transactionInspectCapability,
    errorRegistry: chainErrorRegistry,
    invocationAuthority: input.context.chain.capabilityAuthority.invocationAuthority,
    createInvocationPorts: (_request: TransactionInspectInput) => notRequiredPorts(),
    handler: async (request, context: HandlerInvocationContext<ChainInvocationPorts>, observations) =>
      execute(context.signal, async (chainInvocation) => {
        const signal = chainInvocation.signal;
        const configuredChain = observations.bind(
          transactionInspectEvidence.configuredChain.target,
        );
        const transactionTarget = observations.bind(
          transactionInspectEvidence.targets.transaction,
        );
        const receiptTarget = observations.bind(
          transactionInspectEvidence.targets.receipt,
        );
        const blockTarget = observations.bind(transactionInspectEvidence.targets.block);
        await recordChainId(dependencies, signal, observations, configuredChain);
        const transactionRaw = await dependencies.rpc.request(
          "eth_getTransactionByHash",
          [request.transactionHash],
          signal,
        );
        if (transactionRaw === null) throw new ChainOperationError("not_found");
        const normalized = normalizeSourceValue(() => normalizeRpcTransaction(transactionRaw, chainId));
        if (normalized.transactionHash !== request.transactionHash) {
          throw new ChainOperationError("source_inconsistent");
        }
        if (normalized.position.status === "pending") {
          const transactionObservationId = observations.record(transactionTarget.slot, {
            source: rpcSource,
            claims: transactionClaims(normalized, chainId, transactionTarget),
          });
          const data = transactionData(normalized, transactionObservationId, { status: "pending" }, chainId);
          return { status: "success", data };
        }
        const receiptRaw = await dependencies.rpc.request(
          "eth_getTransactionReceipt",
          [request.transactionHash],
          signal,
        );
        if (receiptRaw === null) throw new ChainOperationError("source_inconsistent");
        const blockRaw = await dependencies.rpc.request(
          "eth_getBlockByHash",
          [normalized.position.blockHash, false],
          signal,
        );
        if (blockRaw === null) throw new ChainOperationError("source_inconsistent");
        const included = normalizeSourceValue(() => normalizeIncludedTransaction(
          transactionRaw,
          receiptRaw,
          blockRaw,
          chainId,
        ));
        const transactionObservationId = observations.record(transactionTarget.slot, {
          source: rpcSource,
          claims: transactionClaims(
            included.transaction,
            chainId,
            transactionTarget,
            included.block,
          ),
        });
        const receiptObservationId = observations.record(receiptTarget.slot, {
          source: rpcSource,
          claims: receiptClaims(
            included.receipt,
            included.block,
            chainId,
            observations,
            receiptTarget,
          ),
        });
        observations.record(blockTarget.slot, {
          source: rpcSource,
          claims: [{
            role: blockTarget.roles.block,
            value: included.block,
            chainAnchor: included.block,
          }],
        });
        const receipt = receiptData(included.receipt, receiptObservationId, chainId);
        const inclusion = {
          status: "included" as const,
          block: included.block,
          transactionIndex: included.transaction.position.transactionIndex,
          receipt,
        };
        const data = transactionData(included.transaction, transactionObservationId, inclusion, chainId);
        return { status: "success", data };
      }),
  });

  const accountBalance = bindCapability({
    definition: accountBalanceCapability,
    errorRegistry: chainErrorRegistry,
    invocationAuthority: input.context.chain.capabilityAuthority.invocationAuthority,
    createInvocationPorts: accountPorts,
    handler: async (request, context: HandlerInvocationContext<ChainInvocationPorts>, observations) =>
      execute(context.signal, async (chainInvocation) => {
        const signal = chainInvocation.signal;
        const accountPort = context.ports.account;
        if (accountPort.status !== "available") throw new ChainOperationError("wallet_not_connected");
        const configuredChain = observations.bind(
          accountBalanceEvidence.configuredChain.target,
        );
        const blockTarget = observations.bind(accountBalanceEvidence.targets.block);
        const walletTarget = request.account.kind === "active_wallet"
          ? observations.bind(accountBalanceEvidence.targets.walletAccount)
          : undefined;
        const block = await resolveBlock(
          dependencies,
          request.block,
          chainInvocation,
          observations,
          configuredChain,
        );
        if (accountPort.active) {
          if (walletTarget === undefined) {
            throw new TypeError("Active account evidence target is unavailable.");
          }
          observations.record(walletTarget.slot, {
            source: context.ports.observations.get("wallet_session"),
            claims: [{
              role: walletTarget.roles.account,
              value: accountPort.address,
            }],
          });
        }
        observations.record(blockTarget.slot, {
          source: rpcSource,
          claims: [{
            role: blockTarget.roles.block,
            value: block.anchor,
            chainAnchor: block.anchor,
          }],
        });

        let native: AccountBalanceData["native"] = { status: "not_requested" };
        if (request.includeNative) {
          const nativeBalanceTarget = observations.bind(
            accountBalanceEvidence.targets.nativeBalance,
          );
          const rawBalance = await dependencies.rpc.request(
            "eth_getBalance",
            [accountPort.address, block.stateReference],
            signal,
          );
          const raw = normalizeSourceValue(() => rpcQuantityToUnsignedDecimal(rawBalance));
          const observationId = observations.record(nativeBalanceTarget.slot, {
            source: rpcSource,
            claims: [{
              role: nativeBalanceTarget.roles.balance,
              value: raw,
              asset: dependencies.nativeAsset,
              chainAnchor: block.anchor,
            }],
          });
          native = {
            status: "available",
            amount: nativeAmount(raw, observationId, accountNativeDecimalsExclusion, chainId),
          };
        }

        const tokenReads = await readTokensBounded(
          dependencies,
          request.tokens,
          accountPort.address,
          block.stateReference,
          signal,
        );
        const tokens: AccountBalanceData["tokens"] = tokenReads.map((token) => {
          const identity = accountTokenEvidenceIdentity(request, token.asset.address);
          const balanceTarget = observations.bind(identity.balanceTarget);
          const decimalsTarget = observations.bind(identity.decimalsTarget);
          if (token.balance.status === "unavailable") {
            const unavailable = { status: "unavailable" as const, errorCode: token.balance.errorCode };
            observations.record(balanceTarget.slot, {
              source: rpcSource,
              claims: [{
                role: balanceTarget.roles.balance,
                value: asCanonicalJson(unavailable),
                asset: token.asset,
                chainAnchor: block.anchor,
              }],
            });
            return { asset: token.asset, result: unavailable };
          }
          const balanceObservationId = observations.record(balanceTarget.slot, {
            source: rpcSource,
            claims: [{
              role: balanceTarget.roles.balance,
              value: token.balance.raw,
              asset: token.asset,
              chainAnchor: block.anchor,
            }],
          });
          const decimalsObservationId = observations.record(decimalsTarget.slot, {
            source: rpcSource,
            claims: [{
              role: decimalsTarget.roles.decimals,
              value: token.decimals.status === "available" ? token.decimals.value : null,
              asset: token.asset,
              chainAnchor: block.anchor,
            }],
          });
          const amount: CanonicalAmount = {
            asset: token.asset,
            raw: token.balance.raw,
            decimals: token.decimals.status === "available"
              ? { status: "available", value: token.decimals.value, observationId: decimalsObservationId }
              : { status: "unavailable", reason: "missing", observationIds: [decimalsObservationId] },
            quantityObservationId: balanceObservationId,
          };
          return { asset: token.asset, result: { status: "available", amount } };
        });
        const data: AccountBalanceData = {
          account: accountPort.address,
          block: block.anchor,
          native,
          tokens,
        };
        return { status: "success", data };
      }),
  });

  const chainReads = Object.freeze({ accountBalance, chainStatus, contractInspect, transactionInspect });
  return Object.freeze({ chainReads });
};
