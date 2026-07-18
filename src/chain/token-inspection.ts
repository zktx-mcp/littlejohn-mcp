import {
  bindCapability,
  deriveEip155Reference,
  type CapabilityBinding,
  type CanonicalAmount,
  type CanonicalJson,
  type ChainAnchor,
  type HandlerInvocationContext,
  type InvocationBoundaryPorts,
  type ObservationAuthority,
  type ObservationWriter,
  type UnsignedDecimal,
} from "../core/index.js";
import type { ChainOwnerApplicationContext } from "../runtime/index.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import {
  tokenCatalogContractLimits,
  tokenDisplayTextSchema,
  tokenInspectCapability,
  type TokenInspectionData,
  type TokenInspectionInput,
} from "../token-catalog/contracts.js";
import {
  decodeErc20DecimalsResult,
  decodeErc20TextResult,
  decodeErc20TotalSupplyResult,
  type Erc20CallEncoder,
} from "./evm-standard.js";
import {
  blockSelectorToRpcTag,
  normalizeRpcBlockAnchor,
  normalizeRpcBytes,
  normalizeRpcRuntimeCode,
  unsignedDecimalToRpcQuantity,
} from "./normalization.js";
import {
  canonicalBlockReference,
  ChainRpcError,
  getChainRpcErrorCode,
  isRpcExecutionRevertedError,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "./rpc.js";
import {
  ChainOperationError,
  getChainOperationFailure,
} from "./errors.js";
import { tokenCatalogErrorRegistry } from "../token-catalog/errors.js";

const tokenInspectionDeadlineMs = 90_000;
const requiredTotalSupplyRevertedErrors = new WeakSet<object>();

const createRequiredTotalSupplyRevertedError = (): Error => {
  const error = new Error("token_total_supply_reverted");
  error.name = "RequiredTotalSupplyRevertedError";
  requiredTotalSupplyRevertedErrors.add(error);
  Object.freeze(error);
  return error;
};

const isRequiredTotalSupplyRevertedError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && requiredTotalSupplyRevertedErrors.has(error);

interface TokenInspectionDependencies {
  readonly rpc: RpcRequester;
  readonly encoder: Erc20CallEncoder;
  readonly rpcSource: ObservationAuthority;
  readonly chainId: TokenInspectionInput["asset"]["chainId"];
}

const asFailure = (code: string) => ({ status: "failure" as const, code, issues: Object.freeze([]) });

const normalizeSource = <Value>(operation: () => Value): Value => {
  try { return operation(); }
  catch { throw new ChainOperationError("source_inconsistent"); }
};

const runInspection = async (
  callerSignal: AbortSignal,
  applicationSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> => {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), tokenInspectionDeadlineMs);
  timer.unref();
  const signal = AbortSignal.any([callerSignal, applicationSignal, deadline.signal]);
  try {
    if (signal.aborted) throw new ChainRpcError("request_aborted");
    return await operation(signal);
  } catch (error) {
    if (isRequiredTotalSupplyRevertedError(error)) {
      return asFailure("token_total_supply_reverted");
    }
    const operationFailure = getChainOperationFailure(error);
    if (operationFailure !== undefined) return asFailure(operationFailure.error.code);
    const rpcCode = getChainRpcErrorCode(error);
    if (rpcCode !== undefined) {
      if (rpcCode === "request_aborted" && !callerSignal.aborted) return asFailure("source_unavailable");
      return asFailure(rpcCode);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const resolveBlock = async (
  dependencies: TokenInspectionDependencies,
  input: TokenInspectionInput,
  signal: AbortSignal,
): Promise<Readonly<{ anchor: ChainAnchor; reference: RpcCanonicalBlockReference }>> => {
  const raw = await dependencies.rpc.request(
    "eth_getBlockByNumber",
    [blockSelectorToRpcTag(input.block), false],
    signal,
  );
  if (raw === null) throw new ChainOperationError("source_inconsistent");
  const anchor = normalizeSource(() => normalizeRpcBlockAnchor(raw, dependencies.chainId));
  if (input.block.kind === "number" && anchor.blockNumber !== input.block.blockNumber) {
    throw new ChainOperationError("source_inconsistent");
  }
  return Object.freeze({ anchor, reference: canonicalBlockReference(anchor.blockHash) });
};

const recordChainId = async (
  dependencies: TokenInspectionDependencies,
  signal: AbortSignal,
  observations: ObservationWriter,
  anchor: ChainAnchor,
): Promise<void> => {
  const raw = await dependencies.rpc.request("eth_chainId", [], signal);
  if (raw !== unsignedDecimalToRpcQuantity(deriveEip155Reference(dependencies.chainId))) {
    throw new ChainOperationError("source_inconsistent");
  }
  observations.record("rpc_chain_id", {
    source: dependencies.rpcSource,
    claims: [{ role: "chain_id", value: dependencies.chainId, chainAnchor: anchor }],
  });
};

type OptionalText = TokenInspectionData["metadata"]["name"];
type OptionalTextBeforeEvidence =
  | Readonly<{ status: "available"; value: string }>
  | Readonly<{ status: "unavailable"; reason: "call_failed" | "malformed" | "unsafe_text" }>;

const readOptionalText = async (
  dependencies: TokenInspectionDependencies,
  address: TokenInspectionInput["asset"]["address"],
  reference: RpcCanonicalBlockReference,
  signal: AbortSignal,
  functionName: "name" | "symbol",
): Promise<OptionalTextBeforeEvidence> => {
  let raw: unknown;
  try {
    raw = await dependencies.rpc.request("eth_call", [{
      to: address,
      data: dependencies.encoder[functionName](),
    }, reference], signal);
  } catch (error) {
    if (isRpcExecutionRevertedError(error)) {
      return Object.freeze({ status: "unavailable", reason: "call_failed" });
    }
    throw error;
  }
  let decoded: ReturnType<typeof decodeErc20TextResult>;
  try {
    decoded = decodeErc20TextResult(
      normalizeRpcBytes(raw),
      functionName,
      tokenCatalogContractLimits.displayTextUtf8Bytes,
    );
  } catch {
    return Object.freeze({ status: "unavailable", reason: "malformed" });
  }
  if (decoded.status === "byte_limit_exceeded") {
    return Object.freeze({ status: "unavailable", reason: "unsafe_text" });
  }
  const parsed = tokenDisplayTextSchema.safeParse(decoded.value);
  return parsed.success
    ? Object.freeze({ status: "available", value: parsed.data })
    : Object.freeze({ status: "unavailable", reason: "unsafe_text" });
};

const readOptionalDecimals = async (
  dependencies: TokenInspectionDependencies,
  address: TokenInspectionInput["asset"]["address"],
  reference: RpcCanonicalBlockReference,
  signal: AbortSignal,
): Promise<UnsignedDecimal | null> => {
  let raw: unknown;
  try {
    raw = await dependencies.rpc.request("eth_call", [{
      to: address,
      data: dependencies.encoder.decimals(),
    }, reference], signal);
  } catch (error) {
    if (isRpcExecutionRevertedError(error)) return null;
    throw error;
  }
  try { return decodeErc20DecimalsResult(normalizeRpcBytes(raw)); }
  catch { return null; }
};

const readRequiredTotalSupply = async (
  dependencies: TokenInspectionDependencies,
  address: TokenInspectionInput["asset"]["address"],
  reference: RpcCanonicalBlockReference,
  signal: AbortSignal,
): Promise<unknown> => {
  try {
    return await dependencies.rpc.request("eth_call", [{
      to: address,
      data: dependencies.encoder.totalSupply(),
    }, reference], signal);
  } catch (error) {
    if (isRpcExecutionRevertedError(error)) throw createRequiredTotalSupplyRevertedError();
    throw error;
  }
};

const inspectionHandler = async (
  dependencies: TokenInspectionDependencies,
  request: TokenInspectionInput,
  signal: AbortSignal,
  observations: ObservationWriter,
): Promise<Readonly<{ status: "success"; data: TokenInspectionData }>> => {
  if (request.asset.chainId !== dependencies.chainId) throw new ChainOperationError("invalid_input");
  const block = await resolveBlock(dependencies, request, signal);
  await recordChainId(dependencies, signal, observations, block.anchor);

  const rawCode = await dependencies.rpc.request(
    "eth_getCode",
    [request.asset.address, block.reference],
    signal,
  );
  const runtimeCode = normalizeSource(() => normalizeRpcRuntimeCode(rawCode));
  if (runtimeCode.status === "empty") throw new ChainOperationError("not_found");

  const stop = new AbortController();
  const callSignal = AbortSignal.any([signal, stop.signal]);
  const calls = [
    readRequiredTotalSupply(dependencies, request.asset.address, block.reference, callSignal),
    readOptionalText(dependencies, request.asset.address, block.reference, callSignal, "name"),
    readOptionalText(dependencies, request.asset.address, block.reference, callSignal, "symbol"),
    readOptionalDecimals(dependencies, request.asset.address, block.reference, callSignal),
  ] as const;
  let callResults: [unknown, OptionalTextBeforeEvidence, OptionalTextBeforeEvidence, UnsignedDecimal | null];
  try {
    callResults = await Promise.all(calls);
  } catch (error) {
    stop.abort();
    await Promise.allSettled(calls);
    throw error;
  }
  const [rawTotalSupply, name, symbol, decimals] = callResults;
  const totalSupplyRaw = normalizeSource(() =>
    decodeErc20TotalSupplyResult(normalizeRpcBytes(rawTotalSupply)));

  const blockObservationId = observations.record("block", {
    source: dependencies.rpcSource,
    claims: [{ role: "token_inspection_block", value: block.anchor as unknown as CanonicalJson, chainAnchor: block.anchor }],
  });
  const runtimeCodeValue = Object.freeze({
    byteLength: runtimeCode.byteLength,
    codeHash: runtimeCode.codeHash,
  });
  observations.record("runtime_code", {
    source: dependencies.rpcSource,
    claims: [{
      role: "token_runtime_code",
      value: runtimeCodeValue as unknown as CanonicalJson,
      asset: request.asset,
      chainAnchor: block.anchor,
    }],
  });
  const supplyObservationId = observations.record("total_supply", {
    source: dependencies.rpcSource,
    claims: [{
      role: "token_total_supply",
      value: totalSupplyRaw,
      asset: request.asset,
      chainAnchor: block.anchor,
    }],
  });
  const decimalsObservationId = observations.record("decimals", {
    source: dependencies.rpcSource,
    claims: [{
      role: "token_decimals",
      value: decimals ?? { status: "unavailable", reason: "missing" },
      asset: request.asset,
      chainAnchor: block.anchor,
    }],
  });
  const nameObservationId = observations.record("name", {
    source: dependencies.rpcSource,
    claims: [{
      role: "token_name",
      value: name.status === "available"
        ? name.value
        : { status: "unavailable", reason: name.reason },
      asset: request.asset,
      chainAnchor: block.anchor,
    }],
  });
  const symbolObservationId = observations.record("symbol", {
    source: dependencies.rpcSource,
    claims: [{
      role: "token_symbol",
      value: symbol.status === "available"
        ? symbol.value
        : { status: "unavailable", reason: symbol.reason },
      asset: request.asset,
      chainAnchor: block.anchor,
    }],
  });
  void blockObservationId;

  const totalSupply: CanonicalAmount = Object.freeze({
    asset: request.asset,
    raw: totalSupplyRaw,
    decimals: decimals === null
      ? Object.freeze({ status: "unavailable" as const, reason: "missing" as const, observationIds: [decimalsObservationId] })
      : Object.freeze({ status: "available" as const, value: decimals, observationId: decimalsObservationId }),
    quantityObservationId: supplyObservationId,
  });
  const data: TokenInspectionData = Object.freeze({
    asset: request.asset,
    block: block.anchor,
    runtimeCode: runtimeCodeValue,
    totalSupply,
    metadata: Object.freeze({
      name: Object.freeze({ ...name, observationId: nameObservationId }) as OptionalText,
      symbol: Object.freeze({ ...symbol, observationId: symbolObservationId }) as OptionalText,
    }),
  });
  return Object.freeze({ status: "success", data });
};

export interface TokenInspectionService {
  readonly binding: CapabilityBinding<typeof tokenInspectCapability>;
  close(): Promise<void>;
}

export const createTokenInspectionService = (input: {
  readonly context: ChainOwnerApplicationContext<ActiveWalletReadPort>;
  readonly rpc: RpcRequester;
  readonly encoder: Erc20CallEncoder;
}): TokenInspectionService => {
  const applicationAbort = new AbortController();
  const activeInvocations = new Set<Promise<unknown>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const abortForOwner = (): void => applicationAbort.abort();
  if (input.context.signal.aborted) applicationAbort.abort();
  else input.context.signal.addEventListener("abort", abortForOwner, { once: true });

  const dependencies: TokenInspectionDependencies = Object.freeze({
    rpc: input.rpc,
    encoder: input.encoder,
    rpcSource: input.context.chain.sourceAuthority.observationAuthority,
    chainId: input.context.chain.configuration.chain.chainId,
  });
  const basePorts = input.context.chain.capabilityAuthority.invocationPorts;
  const execute = (
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> => {
    if (closed || applicationAbort.signal.aborted) return Promise.resolve(asFailure("source_unavailable"));
    const invocation = runInspection(callerSignal, applicationAbort.signal, operation);
    activeInvocations.add(invocation);
    void invocation.then(
      () => activeInvocations.delete(invocation),
      () => activeInvocations.delete(invocation),
    );
    return invocation;
  };
  const binding = bindCapability({
    definition: tokenInspectCapability,
    errorRegistry: tokenCatalogErrorRegistry,
    invocationAuthority: input.context.chain.capabilityAuthority.invocationAuthority,
    createInvocationPorts: (): InvocationBoundaryPorts => Object.freeze({
      observations: basePorts.observations,
    }),
    handler: async (request, context: HandlerInvocationContext<InvocationBoundaryPorts>, observations) =>
      execute(context.signal, (signal) =>
        inspectionHandler(dependencies, request, signal, observations)),
  });

  return Object.freeze({
    binding,
    async close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      applicationAbort.abort();
      closePromise = (async () => {
        await Promise.allSettled([...activeInvocations]);
        input.context.signal.removeEventListener("abort", abortForOwner);
      })();
      return closePromise;
    },
  });
};
