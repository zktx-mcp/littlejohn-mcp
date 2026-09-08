import { z } from "zod";

import {
  canonicalAmountSchema,
  erc20AssetIdentitySchema,
  type CanonicalAmount,
} from "./amounts.js";
import {
  assertCapabilitySuccessChainScope,
  readCapabilityLimits,
  type CapabilitySuccess,
} from "./capability-contract.js";
import { accountNativeDecimalsExclusion } from "./capability-evidence.js";
import { addressTargetSchema } from "./address-target.js";
import { evmAddressInputSchema } from "./evm-address-input.js";
import { jsonObject } from "./json-object.js";
import {
  blockSelectorSchema,
  chainAnchorSchema,
  isStrictlyOrderedUnique,
  evmAddressSchema,
} from "./primitives.js";

const canonicalTokenInputSchema = (minimum: 0 | 1) => z.array(evmAddressInputSchema)
  .min(minimum)
  .max(readCapabilityLimits.accountTokenAddresses)
  .meta({ uniqueItems: true });

export const accountBalanceInputSchema = z.discriminatedUnion("includeNative", [
  jsonObject({
    account: addressTargetSchema,
    includeNative: z.literal(true),
    tokens: canonicalTokenInputSchema(0),
    block: blockSelectorSchema,
  }).strict(),
  jsonObject({
    account: addressTargetSchema,
    includeNative: z.literal(false),
    tokens: canonicalTokenInputSchema(1),
    block: blockSelectorSchema,
  }).strict(),
]);

const tokenBalanceResultSchema = jsonObject({
  asset: erc20AssetIdentitySchema,
  result: z.discriminatedUnion("status", [
    jsonObject({ status: z.literal("available"), amount: canonicalAmountSchema }).strict(),
    jsonObject({
      status: z.literal("unavailable"),
      errorCode: z.enum([
        "chain_response_unavailable",
        "source_unavailable",
        "source_inconsistent",
      ]),
    }).strict(),
  ]),
}).strict();

export const accountBalanceDataSchema = jsonObject({
  account: evmAddressSchema,
  block: chainAnchorSchema,
  native: z.discriminatedUnion("status", [
    jsonObject({ status: z.literal("not_requested") }).strict(),
    jsonObject({ status: z.literal("available"), amount: canonicalAmountSchema }).strict(),
  ]),
  tokens: z.array(tokenBalanceResultSchema).max(readCapabilityLimits.accountTokenAddresses),
}).strict();

export type AccountBalanceInput = z.infer<typeof accountBalanceInputSchema>;
export type AccountBalanceData = z.infer<typeof accountBalanceDataSchema>;

export const maximumEvmBalanceRaw =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

const assertEvmBalanceRaw = (raw: string): void => {
  if (
    raw.length > maximumEvmBalanceRaw.length ||
    (raw.length === maximumEvmBalanceRaw.length && raw > maximumEvmBalanceRaw)
  ) throw new TypeError("Account balance exceeds the EVM uint256 range.");
};

const assertOrderedUnique = (values: readonly string[]): void => {
  if (!isStrictlyOrderedUnique(values)) {
    throw new TypeError("Token result addresses must be unique and canonically ordered.");
  }
};

const assertAmountChain = (amount: CanonicalAmount, chainId: string): void => {
  if (amount.asset.chainId !== chainId) throw new TypeError("Amount chain scope mismatch.");
};

export const assertAccountBalanceDataSemantics = (data: AccountBalanceData): void => {
  assertOrderedUnique(data.tokens.map((entry) => entry.asset.address));
  if (data.native.status === "available" && (
    data.native.amount.asset.kind !== "native" ||
    data.native.amount.decimals.status !== "not_observed" ||
    data.native.amount.decimals.scopeExclusionId !== accountNativeDecimalsExclusion.id
  )) throw new TypeError("Native amount meaning is inconsistent.");
  if (data.native.status === "available") assertEvmBalanceRaw(data.native.amount.raw);
  for (const token of data.tokens) {
    if (token.result.status === "available" && (
      token.result.amount.asset.kind !== "erc20" ||
      token.result.amount.asset.address !== token.asset.address ||
      token.result.amount.decimals.status === "not_observed"
    )) throw new TypeError("Token result amount identity is inconsistent.");
    if (token.result.status === "available") assertEvmBalanceRaw(token.result.amount.raw);
  }
};

export const assertAccountBalanceChainSemantics = (
  data: AccountBalanceData,
  chainId: string,
): void => {
  if (data.block.chainId !== chainId) throw new TypeError("Account chain scope mismatch.");
  if (data.native.status === "available") assertAmountChain(data.native.amount, chainId);
  for (const token of data.tokens) {
    if (token.asset.chainId !== chainId) throw new TypeError("Token chain scope mismatch.");
    if (token.result.status === "available") assertAmountChain(token.result.amount, chainId);
  }
};

export const assertAccountBalanceRequestSemantics = (
  input: AccountBalanceInput,
  data: AccountBalanceData,
): void => {
  if (input.account.kind === "address" && input.account.address !== data.account) {
    throw new TypeError("Account target mismatch.");
  }
  if (input.block.kind === "number" && input.block.blockNumber !== data.block.blockNumber) {
    throw new TypeError("Account block selector mismatch.");
  }
  if (input.includeNative !== (data.native.status === "available")) {
    throw new TypeError("Native result selection mismatch.");
  }
  const resultAddresses = data.tokens.map((entry) => entry.asset.address);
  if (resultAddresses.join("\0") !== input.tokens.join("\0")) {
    throw new TypeError("Token result selection mismatch.");
  }
};

export const assertAccountBalancePublicSuccess = (
  input: AccountBalanceInput,
  success: CapabilitySuccess<AccountBalanceData>,
): void => {
  assertAccountBalanceDataSemantics(success.data);
  assertAccountBalanceChainSemantics(success.data, success.meta.chainId);
  assertAccountBalanceRequestSemantics(input, success.data);
  assertCapabilitySuccessChainScope(success);
};
