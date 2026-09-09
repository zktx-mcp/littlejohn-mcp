import {
  CapabilityBindingRegistry, CapabilityRegistry, bindCapability, canonicalAmountSchema,
  captureCanonicalJson, dynamicFeeRequestCommitment, parseUnsignedDecimal,
  type CanonicalAmount, type EvmAddress, type ObservationAuthority, type ObservationWriter,
  type CanonicalClock, type CapabilityInvocationAuthority, type InvocationBoundaryPorts,
} from "../core/index.js";
import { createErc20CallEncoder, decodeAbiUint256Result, normalizePinnedEvmReadFailure } from "../chain/index.js";
import { dynamicFeeRequestFromTransaction } from "../chain/transaction-reads.js";
import type { NormalizedIncludedTransaction } from "../chain/normalization.js";
import type { ChainInvocationContext } from "../chain/invocation-lifecycle.js";
import type { ChainInvocationPort, PinnedEvmReadPort } from "../chain/index.js";
import type { TransactionChainReadPort } from "../chain/transaction-reads.js";
import type { UniswapV4Evm } from "../protocols/uniswap-v4/evm.js";
import { receiptActivityErrorRegistry, ReceiptActivityError } from "./errors.js";
import { uniswapV4ContractAddresses } from "../protocols/uniswap-v4/client.js";
import { createUniswapV4EventDecoder } from "../protocols/uniswap-v4/events.js";
import type { UniswapV4ExpectedEffect } from "../protocols/uniswap-v4/effects.js";
import { nativeAssetUnitDefinition } from "../registry/native-asset.js";
import { receiptInspectionCapability, receiptInspectionEvidence, admitReceiptInspection, type ReceiptInspectionSuccess } from "./contracts.js";
import { receiptInspectionDataSchema, receiptQuantityClaim, receiptUnitsClaim, type RawReceiptFacts, type ReceiptInspectionInput, type ReceiptUnitValue } from "./data.js";
import type { EvmAbiCodec } from "../chain/index.js";
import { evaluateReceiptEffects } from "./verification.js";

export interface ReceiptInspectionDependencies {
  readonly chain: {
    readonly clock: CanonicalClock;
    readonly invocationAuthority: CapabilityInvocationAuthority;
    readonly invocationPorts: InvocationBoundaryPorts;
    readonly chainInvocations: ChainInvocationPort;
    readonly reads: PinnedEvmReadPort;
    readonly transactions: TransactionChainReadPort;
    readonly evm: UniswapV4Evm;
  };
  readonly nativeUnitAuthority: ObservationAuthority;
  readonly codec: EvmAbiCodec;
}
type Detail = { readonly raw: RawReceiptFacts; readonly units: ReadonlyMap<EvmAddress, ReceiptUnitValue["decimals"]> };

const factsFromReceipt = (dependencies: ReceiptInspectionDependencies, input: ReceiptInspectionInput, value: NormalizedIncludedTransaction): Detail => {
  const { transaction, receipt, block } = value;
  let actualRequestCommitment: RawReceiptFacts["actualRequestCommitment"] = null;
  let conditions: UniswapV4ExpectedEffect | null = null;
  try {
    const request = dynamicFeeRequestFromTransaction(transaction);
    actualRequestCommitment = dynamicFeeRequestCommitment(request);
    conditions = dependencies.chain.evm.decodeCall(request, transaction.from);
  } catch { /* Unsupported envelopes or calls retain execution without verification. */ }
  const requestComparison = input.reference === null ? "unavailable" : actualRequestCommitment === input.reference.walletRequestCommitment ? "matched" : "mismatched";
  const deltas = new Map<EvmAddress, bigint>();
  if (receipt.status === "success") for (const log of receipt.logs) {
    const event = log.decodedEvent;
    if (event.kind !== "erc20_transfer") continue;
    const difference = (event.to === transaction.from ? BigInt(event.amountRaw) : 0n) -
      (event.from === transaction.from ? BigInt(event.amountRaw) : 0n);
    if (difference !== 0n) deltas.set(event.token, (deltas.get(event.token) ?? 0n) + difference);
  }
  const allowed = conditions?.kind === "swap" ? [conditions.tokenIn, conditions.tokenOut] : [];
  const movements = [...deltas].filter(([, delta]) => delta !== 0n).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([token, delta]) => ({ direction: delta < 0n ? "sent" as const : "received" as const,
      amount: { asset: { kind: "erc20" as const, chainId: transaction.chainScope, address: token }, raw: parseUnsignedDecimal((delta < 0n ? -delta : delta).toString()) } }));
  const decoder = createUniswapV4EventDecoder(dependencies.codec);
  const events: RawReceiptFacts["events"][number][] = [];
  let eventCoverage: "complete" | "unavailable" = "complete";
  for (const log of receipt.logs) {
    const event = log.decodedEvent;
    if (event.kind === "erc20_approval" && event.owner === transaction.from) events.push({
      kind: "erc20_approval", owner: event.owner, spender: event.spender,
      amount: { asset: { kind: "erc20", chainId: transaction.chainScope, address: event.token }, raw: event.amountRaw },
    });
    try {
      const swap = decoder.swap(log);
      if (swap !== null) events.push({ kind: "swap", ...swap });
      const approval = decoder.approval(log);
      if (approval !== null && approval.owner === transaction.from) events.push({
        kind: "permit2_approval", owner: approval.owner, spender: approval.spender, expiration: approval.expiration,
        amount: { asset: { kind: "erc20", chainId: transaction.chainScope, address: approval.token }, raw: parseUnsignedDecimal(approval.amount) },
      });
    } catch { eventCoverage = "unavailable"; }
  }
  return { units: new Map(), raw: {
    account: input.account, transactionHash: input.transactionHash, status: "included", actualSender: transaction.from,
    nonce: transaction.nonce, block, execution: receipt.status, requestComparison, actualRequestCommitment,
    conditions, movements, events, eventCoverage,
    additionalTokenEffects: movements.some((movement) => !allowed.includes(movement.amount.asset.address)), metadataComplete: false,
    fees: { payer: transaction.from, amount: { asset: { kind: "native", chainId: transaction.chainScope },
      raw: parseUnsignedDecimal((BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString()) },
      gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice },
    postState: [], finality: { status: "unavailable" },
  } };
};

const readDetails = async (dependencies: ReceiptInspectionDependencies, value: NormalizedIncludedTransaction, initial: Detail, context: ChainInvocationContext): Promise<Detail> => {
  const { chain } = dependencies;
  const block = await chain.reads.resolveBlock(context, { kind: "number", blockNumber: value.block.blockNumber });
  if (block.anchor.blockHash !== value.block.blockHash) throw new TypeError("Receipt inclusion is no longer canonical.");
  const conditions = initial.raw.conditions;
  const affected = conditions === null ? [] : conditions.kind === "swap" ? [conditions.tokenIn, conditions.tokenOut] : [conditions.token];
  const tokens = [...new Set([...affected, ...initial.raw.movements.flatMap((entry) => entry.amount.asset.kind === "erc20" ? [entry.amount.asset.address] : []),
    ...initial.raw.events.flatMap((entry) => entry.kind !== "swap" && entry.amount.asset.kind === "erc20" ? [entry.amount.asset.address] : [])])];
  const units = new Map<EvmAddress, ReceiptUnitValue["decimals"]>();
  for (const token of tokens) {
    const result = await chain.reads.readTokenDecimals(context, block, token);
    units.set(token, result.status === "observed" ? { status: "available", value: result.value } : { status: "unavailable", reason: "missing" });
  }
  const encoder = await createErc20CallEncoder();
  const postState: RawReceiptFacts["postState"][number][] = [];
  for (const token of affected) {
    const call = async (to: EvmAddress, data: ReturnType<typeof encoder.balanceOf>) => {
      const result = await chain.reads.call(context, block, { to, data });
      if (result.status !== "observed") throw new TypeError("Receipt post-state is unavailable.");
      return result.value;
    };
    try {
      const balance = decodeAbiUint256Result(await call(token, encoder.balanceOf(value.transaction.from)));
      const allowance = decodeAbiUint256Result(await call(token, chain.evm.erc20Allowance(value.transaction.from)));
      const permit = chain.evm.decodePermitAllowance(await call(uniswapV4ContractAddresses.permit2, chain.evm.permitAllowance(value.transaction.from, token)));
      const amount = (raw: string) => ({ asset: { kind: "erc20" as const, chainId: value.block.chainId, address: token }, raw: parseUnsignedDecimal(raw) });
      postState.push({ status: "observed", token, balance: amount(balance), erc20Allowance: amount(allowance),
        permit2Allowance: amount(permit.amount), permit2Expiration: permit.expiration });
    } catch (error) {
      if (context.signal.aborted) throw error;
      postState.push({ status: "unavailable", token });
    }
  }
  let finality: RawReceiptFacts["finality"];
  try { finality = await chain.transactions.finality(context, value.block); }
  catch (error) { if (context.signal.aborted) throw error; finality = { status: "unavailable" }; }
  const raw: RawReceiptFacts = { ...initial.raw, metadataComplete: true, postState, finality };
  return { raw, units };
};

const publishFacts = (dependencies: ReceiptInspectionDependencies, detail: Detail, observations: ObservationWriter) => {
  const { raw, units } = detail;
  const evidence = receiptInspectionEvidence;
  const record = (target: typeof evidence.quantity, source: ObservationAuthority, value: ReturnType<typeof captureCanonicalJson>, anchored: boolean) => {
    const bound = observations.bind(target.declaration);
    return observations.record(bound.slot, { source, claims: [{ role: bound.roles.value, value, ...(anchored ? { chainAnchor: raw.block } : {}) }] });
  };
  const quantityId = record(evidence.quantity, dependencies.chain.transactions.observationAuthority, receiptQuantityClaim(raw), true);
  const nativeId = record(evidence.native, dependencies.nativeUnitAuthority, captureCanonicalJson(nativeAssetUnitDefinition), false);
  const usedTokens = new Set([...raw.movements.flatMap((entry) => entry.amount.asset.kind === "erc20" ? [entry.amount.asset.address] : []),
    ...raw.postState.flatMap((entry) => entry.status === "observed" ? [entry.token] : []),
    ...raw.events.flatMap((entry) => entry.kind !== "swap" && entry.amount.asset.kind === "erc20" ? [entry.amount.asset.address] : [])]);
  const unitEntries = [...units].filter(([token]) => usedTokens.has(token)).map(([token, decimals]) => ({ asset: { kind: "erc20" as const, chainId: raw.block.chainId, address: token }, decimals }));
  const unitId = unitEntries.length === 0 ? null : record(evidence.units, dependencies.chain.reads.observationAuthority, receiptUnitsClaim(unitEntries), true);
  const amount = (value: Pick<CanonicalAmount, "asset" | "raw">): CanonicalAmount => {
    const unit = value.asset.kind === "native" ? { status: "available" as const, value: nativeAssetUnitDefinition.decimals } : units.get(value.asset.address);
    const id = value.asset.kind === "native" ? nativeId : unitId;
    return canonicalAmountSchema.parse({ ...value, quantityObservationId: quantityId,
      decimals: unit?.status === "available" ? { ...unit, observationId: id } : unit?.status === "unavailable"
        ? { ...unit, observationIds: [id] } : { status: "not_observed", scopeExclusionId: "receipt_token_units_not_observed" } });
  };
  const complete = { ...raw,
    quantityObservationId: quantityId, unitsObservationId: unitId, nativeUnitsObservationId: nativeId,
    movements: raw.movements.map((entry) => ({ ...entry, amount: amount(entry.amount) })),
    events: raw.events.map((entry) => entry.kind === "swap" ? entry : entry.kind === "erc20_approval" ? { ...entry, amount: amount(entry.amount) } : { ...entry, expiration: parseUnsignedDecimal(entry.expiration), amount: amount(entry.amount) }),
    fees: { ...raw.fees, amount: amount(raw.fees.amount) },
    postState: raw.postState.map((entry) => entry.status === "unavailable" ? entry : { ...entry,
      balance: amount(entry.balance), erc20Allowance: amount(entry.erc20Allowance), permit2Allowance: amount(entry.permit2Allowance), permit2Expiration: parseUnsignedDecimal(entry.permit2Expiration) }),
    effectComparison: "unavailable" as const,
  };
  const verification = evaluateReceiptEffects(complete);
  return receiptInspectionDataSchema.parse({ ...complete, effectComparison: verification.comparison, additionalTokenEffects: verification.additionalTokenEffects });
};

export const createReceiptInspector = (dependencies: ReceiptInspectionDependencies) => {
  const produce = async (input: ReceiptInspectionInput, signal: AbortSignal, detail: Detail | Exclude<ReturnType<typeof receiptInspectionDataSchema.parse>, { status: "included" }>): Promise<ReceiptInspectionSuccess> => {
    const binding = bindCapability({ definition: receiptInspectionCapability, errorRegistry: receiptActivityErrorRegistry,
      invocationAuthority: dependencies.chain.invocationAuthority,
      createInvocationPorts: () => dependencies.chain.invocationPorts,
      handler: async (_input, _context, observations) => {
        if ("raw" in detail) return { status: "success", data: publishFacts(dependencies, detail, observations) };
        const target = observations.bind(receiptInspectionEvidence.quantity.declaration);
        observations.record(target.slot, { source: dependencies.chain.transactions.observationAuthority,
          claims: [{ role: target.roles.value, value: receiptQuantityClaim(detail) }] });
        return { status: "success", data: detail };
      },
    });
    const result = await new CapabilityBindingRegistry(new CapabilityRegistry([receiptInspectionCapability]), [binding]).invoke(receiptInspectionCapability, input, { signal });
    if (!result.ok) throw new ReceiptActivityError(result.error.code);
    return admitReceiptInspection(input, result);
  };
  return Object.freeze({
    async inspect(input: ReceiptInspectionInput, context: ChainInvocationContext, publish: (value: ReceiptInspectionSuccess) => void): Promise<ReceiptInspectionSuccess> {
      const observed = await dependencies.chain.transactions.readTransaction(context, input.transactionHash);
      if (observed.status !== "included") {
        let detail;
        if (observed.status === "not_found") detail = { account: input.account, transactionHash: input.transactionHash, status: "not_found" as const };
        else if (observed.status === "reorged") detail = { account: input.account, transactionHash: input.transactionHash,
          status: "reorged" as const, nonce: observed.transaction.nonce, canonicalBlock: observed.canonicalBlock };
        else {
          let actualRequestCommitment = null;
          try { actualRequestCommitment = dynamicFeeRequestCommitment(dynamicFeeRequestFromTransaction(observed.transaction)); } catch { /* Unsupported envelope. */ }
          detail = { account: input.account, transactionHash: input.transactionHash, status: "pending" as const,
            nonce: observed.transaction.nonce, actualSender: observed.transaction.from, actualRequestCommitment,
            requestComparison: input.reference === null ? "unavailable" as const : input.reference.walletRequestCommitment === actualRequestCommitment ? "matched" as const : "mismatched" as const };
        }
        const result = await produce(input, context.signal, receiptInspectionDataSchema.parse(detail) as Exclude<ReturnType<typeof receiptInspectionDataSchema.parse>, { status: "included" }>);
        publish(result); return result;
      }
      const initial = factsFromReceipt(dependencies, input, observed.value);
      const preliminary = await produce(input, context.signal, initial);
      publish(preliminary);
      const detail = await readDetails(dependencies, observed.value, initial, context);
      const result = await produce(input, context.signal, detail);
      publish(result); return result;
    },
  });
};
