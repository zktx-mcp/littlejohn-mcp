import { z } from "zod";
import {canonicalAmountSchema, uint256DecimalSchema, type CanonicalAmount} from "../evm/amounts.js";
import {chainAnchorSchema} from "../evm/primitives.js";
import {evmAccountIdentitySchema, evmAddressSchema, sameEvmAccountIdentity} from "../evm/identities.js";
import { hash32Schema, jsonObject, observationIdSchema, utcTimestampSchema, canonicalJsonStringify, captureCanonicalJson, isStrictlyOrderedUnique } from "../core/client.js";
import { readCapabilityLimits } from "../evm/read-limits.js";
import { uniswapV4ExpectedEffectSchema } from "../protocols/uniswap-v4/effects.js";
import { nativeAssetUnitDefinition } from "../registry/native-asset.js";
import { reviewedRequestReferenceSchema } from "../review/request-reference.js";
import { evaluateReceiptEffects } from "./verification.js";

const subject = { account: evmAccountIdentitySchema, transactionHash: hash32Schema };
const comparison = z.enum(["matched", "mismatched", "unavailable"]);
const movement = jsonObject({ direction: z.enum(["sent", "received"]), amount: canonicalAmountSchema }).strict();
const receiptEventSchema = z.discriminatedUnion("kind", [
  jsonObject({ kind: z.literal("swap"), poolId: hash32Schema, sender: evmAddressSchema }).strict(),
  jsonObject({ kind: z.literal("erc20_approval"), owner: evmAddressSchema, spender: evmAddressSchema, amount: canonicalAmountSchema }).strict(),
  jsonObject({ kind: z.literal("permit2_approval"), owner: evmAddressSchema, spender: evmAddressSchema, amount: canonicalAmountSchema, expiration: uint256DecimalSchema }).strict(),
]);
const finality = z.union([
  jsonObject({ status: z.enum(["included", "safe", "finalized"]), head: chainAnchorSchema }).strict(),
  jsonObject({ status: z.literal("unavailable") }).strict(),
]);

const inclusion = jsonObject({
  ...subject, status: z.literal("included"), actualSender: evmAddressSchema,
  nonce: uint256DecimalSchema, block: chainAnchorSchema, execution: z.enum(["success", "reverted"]),
  requestComparison: comparison, effectComparison: z.enum(["matched", "mismatched", "unavailable", "not_executed"]),
  actualRequestCommitment: hash32Schema.nullable(),
  conditions: uniswapV4ExpectedEffectSchema.nullable(),
  events: z.array(receiptEventSchema).max(readCapabilityLimits.transactionReceiptLogs),
  eventCoverage: z.enum(["complete", "unavailable"]),
  movements: z.array(movement).max(readCapabilityLimits.transactionReceiptLogs),
  additionalTokenEffects: z.boolean(),
  metadataComplete: z.boolean(),
  fees: jsonObject({ payer: evmAddressSchema, amount: canonicalAmountSchema,
    gasUsed: uint256DecimalSchema, effectiveGasPrice: uint256DecimalSchema }).strict(),
  postState: z.array(z.discriminatedUnion("status", [jsonObject({ status: z.literal("observed"), token: evmAddressSchema,
    balance: canonicalAmountSchema, erc20Allowance: canonicalAmountSchema,
    permit2Allowance: canonicalAmountSchema, permit2Expiration: uint256DecimalSchema,
  }).strict(), jsonObject({ status: z.literal("unavailable"), token: evmAddressSchema }).strict()])).max(2),
  finality,
  quantityObservationId: observationIdSchema,
  unitsObservationId: observationIdSchema.nullable(),
  nativeUnitsObservationId: observationIdSchema,
}).strict();
export type IncludedReceiptData = z.infer<typeof inclusion>;
export const receiptInspectionDataSchema = z.discriminatedUnion("status", [
  jsonObject({ ...subject, status: z.literal("not_found") }).strict(),
  jsonObject({ ...subject, status: z.literal("pending"), nonce: uint256DecimalSchema,
    actualSender: evmAddressSchema, actualRequestCommitment: hash32Schema.nullable(), requestComparison: comparison }).strict(),
  jsonObject({ ...subject, status: z.literal("reorged"), nonce: uint256DecimalSchema,
    canonicalBlock: chainAnchorSchema }).strict(),
  inclusion,
]).superRefine((value, context) => {
  if (value.status !== "included") return;
  const invalid = () => context.addIssue({ code: "custom", message: "Receipt accounting or its source binding is inconsistent." });
  if (value.block.chainId !== value.account.chainId || value.fees.payer !== value.actualSender ||
      value.fees.amount.asset.kind !== "native" || value.fees.amount.asset.chainId !== value.account.chainId ||
      value.fees.amount.quantityObservationId !== value.quantityObservationId ||
      value.fees.amount.decimals.status !== "available" ||
      value.fees.amount.decimals.value !== nativeAssetUnitDefinition.decimals ||
      value.fees.amount.decimals.observationId !== value.nativeUnitsObservationId ||
      !uint256DecimalSchema.safeParse(value.fees.amount.raw).success ||
      BigInt(value.fees.amount.raw) !== BigInt(value.fees.gasUsed) * BigInt(value.fees.effectiveGasPrice)) invalid();
  const tokens = value.conditions === null ? [] : value.conditions.kind === "swap"
    ? [value.conditions.tokenIn, value.conditions.tokenOut] : [value.conditions.token];
  for (const amount of [...value.movements.map((entry) => entry.amount),
    ...value.events.flatMap((entry) => entry.kind === "swap" ? [] : [entry.amount]),
    ...value.postState.flatMap((entry) => entry.status === "observed" ? [entry.balance, entry.erc20Allowance, entry.permit2Allowance] : [])]) {
    if (amount.asset.kind !== "erc20" || amount.asset.chainId !== value.account.chainId ||
        !uint256DecimalSchema.safeParse(amount.raw).success ||
        amount.quantityObservationId !== value.quantityObservationId ||
        (amount.decimals.status === "available" && amount.decimals.observationId !== value.unitsObservationId)) invalid();
    if (amount.decimals.status === "not_observed" && (value.metadataComplete || amount.decimals.scopeExclusionId !== "receipt_token_units_not_observed")) invalid();
    if (amount.decimals.status === "unavailable" && (amount.decimals.reason !== "missing" || amount.decimals.observationIds.length !== 1 || amount.decimals.observationIds[0] !== value.unitsObservationId)) invalid();
  }
  if (!isStrictlyOrderedUnique(value.movements.map((entry) => canonicalJsonStringify(captureCanonicalJson(entry.amount.asset)))) ||
      value.movements.some((entry) => entry.amount.raw === "0")) invalid();
  if (value.metadataComplete && (value.postState.length !== tokens.length || value.postState.some((entry, index) => entry.token !== tokens[index]))) invalid();
  for (const entry of value.postState) if (entry.status === "observed") {
    if ([entry.balance, entry.erc20Allowance, entry.permit2Allowance].some((amount) => amount.asset.kind !== "erc20" || amount.asset.address !== entry.token)) invalid();
  }
  const verification = evaluateReceiptEffects(value);
  if (value.effectComparison !== verification.comparison || value.additionalTokenEffects !== verification.additionalTokenEffects) invalid();
  if (value.execution === "reverted" ? value.effectComparison !== "not_executed" || value.movements.length !== 0 :
    value.effectComparison === "not_executed") invalid();
  if (value.effectComparison === "matched" && (value.requestComparison !== "matched" || value.conditions === null ||
      value.actualSender !== value.account.address || value.additionalTokenEffects || value.fees.amount.decimals.status !== "available")) invalid();
  if (value.effectComparison === "matched" && (!value.metadataComplete || value.postState.some((entry) => entry.status !== "observed") ||
      value.movements.some((entry) => entry.amount.decimals.status !== "available"))) invalid();
  if (value.finality.status !== "unavailable" && value.finality.head.chainId !== value.account.chainId) invalid();
  if (value.conditions?.kind === "swap" && value.conditions.payer !== value.actualSender) invalid();
});
export type ReceiptInspectionData = z.infer<typeof receiptInspectionDataSchema>;

export const receiptInspectionInputSchema = jsonObject({
  ...subject,
  reference: reviewedRequestReferenceSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.reference !== null && !sameEvmAccountIdentity(value.account, value.reference.account)) {
    context.addIssue({ code: "custom", message: "Receipt lookup account differs from its original request." });
  }
});
export type ReceiptInspectionInput = z.infer<typeof receiptInspectionInputSchema>;

type Included = Extract<ReceiptInspectionData, { status: "included" }>;
type RawAmount = Pick<CanonicalAmount, "asset" | "raw">;
export type RawReceiptFacts = Omit<Included, "effectComparison" | "quantityObservationId" | "unitsObservationId" | "nativeUnitsObservationId" | "movements" | "fees" | "postState" | "events"> & {
  readonly movements: readonly { direction: "sent" | "received"; amount: RawAmount }[];
  readonly fees: Omit<Included["fees"], "amount"> & { readonly amount: RawAmount };
  readonly events: readonly ({ kind: "swap"; poolId: Included["transactionHash"]; sender: Included["actualSender"] } |
    { kind: "erc20_approval"; owner: Included["actualSender"]; spender: Included["actualSender"]; amount: RawAmount } |
    { kind: "permit2_approval"; owner: Included["actualSender"]; spender: Included["actualSender"]; amount: RawAmount; expiration: string })[];
  readonly postState: readonly ({ status: "observed"; token: Included["postState"][number]["token"]; balance: RawAmount; erc20Allowance: RawAmount; permit2Allowance: RawAmount; permit2Expiration: string } | { status: "unavailable"; token: Included["postState"][number]["token"] })[];
};

export const receiptQuantityClaim = (data: ReceiptInspectionData | RawReceiptFacts) => {
  if (data.status === "pending") { const { requestComparison: _comparison, ...facts } = data; return captureCanonicalJson(facts); }
  if (data.status !== "included") return captureCanonicalJson(data);
  const amount = (value: RawAmount) => ({ asset: value.asset, raw: value.raw });
  return captureCanonicalJson({
    account: data.account, transactionHash: data.transactionHash, actualSender: data.actualSender,
    nonce: data.nonce, block: data.block, execution: data.execution,
    actualRequestCommitment: data.actualRequestCommitment,
    conditions: data.conditions, eventCoverage: data.eventCoverage,
    events: data.events.map((entry) => entry.kind === "swap" ? entry : { ...entry, amount: amount(entry.amount) }),
    metadataComplete: data.metadataComplete,
    movements: data.movements.map((entry) => ({ direction: entry.direction, amount: amount(entry.amount) })),
    fees: { payer: data.fees.payer, amount: amount(data.fees.amount), gasUsed: data.fees.gasUsed, effectiveGasPrice: data.fees.effectiveGasPrice },
    postState: data.postState.map((entry) => entry.status === "unavailable" ? entry : ({ status: entry.status, token: entry.token, balance: amount(entry.balance),
      erc20Allowance: amount(entry.erc20Allowance), permit2Allowance: amount(entry.permit2Allowance), permit2Expiration: entry.permit2Expiration })),
    finality: data.finality,
  });
};
export type ReceiptUnitValue = { readonly asset: CanonicalAmount["asset"]; readonly decimals:
  { readonly status: "available"; readonly value: string } | { readonly status: "unavailable"; readonly reason: "missing" | "conflicting" } |
  { readonly status: "not_observed"; readonly scopeExclusionId: string } };
export const receiptUnitsClaim = (amounts: readonly ReceiptUnitValue[]) => {
  const units = new Map<string, unknown>();
  for (const amount of amounts) {
    const decimals = amount.decimals;
    const value = { asset: amount.asset, decimals: decimals.status === "available" ? { status: "available", value: decimals.value }
      : decimals.status === "unavailable" ? { status: "unavailable", reason: decimals.reason } : decimals };
    const key = canonicalJsonStringify(captureCanonicalJson(amount.asset));
    const old = units.get(key);
    if (old !== undefined && canonicalJsonStringify(captureCanonicalJson(old)) !== canonicalJsonStringify(captureCanonicalJson(value))) {
      throw new TypeError("One receipt has conflicting token-unit projections.");
    }
    units.set(key, value);
  }
  return captureCanonicalJson([...units].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value));
};
export const receiptUnitClaim = (data: Extract<ReceiptInspectionData, { status: "included" }>) => receiptUnitsClaim([
  ...data.movements.map((entry) => entry.amount), ...data.postState.flatMap((entry) => entry.status === "observed" ? [entry.balance] : []),
  ...data.events.flatMap((entry) => entry.kind === "swap" ? [] : [entry.amount]),
]);
