import { z } from "zod";

import {
  erc20AssetIdentitySchema,
  scaledUiAmountSchema,
  uint256DecimalSchema,
} from "./amounts.js";
import { deepFreezeValue } from "./immutability.js";
import { guardJsonSchema, jsonObject } from "./json-object.js";
import { evmAccountIdentitySchema } from "./identities.js";
import { chainAnchorSchema } from "./primitives.js";

export const tokenStandardDefinitions = deepFreezeValue({
  erc20_read_surface: {
    displayName: "ERC-20",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-20",
    explanation: "The ERC-20 reads used by Little John succeeded. ERC-20 has no ERC-165 interface ID, so this observation does not certify all transfer, allowance, event, or failure behavior.",
    statuses: ["observed", "unknown"],
  },
  erc165: {
    displayName: "ERC-165",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-165",
    explanation: "The contract passed the ERC-165 self-interface and invalid-interface calls with the required 30,000 gas bound. This establishes standard interface detection, not support for any particular token interface.",
    statuses: ["supported", "not_supported", "inconsistent", "unknown"],
  },
  erc8056: {
    displayName: "ERC-8056",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-8056",
    explanation: "The contract declared the ERC-8056 core and required pending-multiplier interfaces and returned valid values. ERC-8056 is a draft display-scaling extension; raw ERC-20 accounting does not change.",
    statuses: ["supported", "not_supported", "inconsistent", "unknown"],
  },
  erc8056_pending_multiplier: {
    displayName: "ERC-8056 pending multiplier",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-8056",
    explanation: "The required pending-multiplier interface returned the scheduled multiplier and effective timestamp used to explain a future display change.",
    statuses: ["supported", "not_supported", "inconsistent", "unknown"],
  },
  erc8056_conversion: {
    displayName: "ERC-8056 conversion",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-8056",
    explanation: "The optional conversion interface exposes onchain raw-to-UI and UI-to-raw helpers. Little John still preserves raw values and uses its canonical integer calculation for display evidence.",
    statuses: ["supported", "not_supported", "inconsistent", "unknown"],
  },
  erc8056_balances: {
    displayName: "ERC-8056 balances",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-8056",
    explanation: "The optional balances interface exposes UI-adjusted balance and total-supply reads. For an account result, balanceOfUI must agree with the value calculated from the same-block raw balance and multiplier.",
    statuses: ["supported", "not_supported", "inconsistent", "unknown"],
  },
} as const);

export type TokenStandardId = keyof typeof tokenStandardDefinitions;
export type TokenStandardObservationStatus =
  | "observed"
  | "supported"
  | "not_supported"
  | "inconsistent"
  | "unknown";

const tokenStandardIds = Object.freeze(Object.keys(tokenStandardDefinitions)) as readonly [
  TokenStandardId,
  ...TokenStandardId[],
];

export const tokenStandardIdSchema = z.enum(tokenStandardIds);
export const tokenStandardObservationStatusSchema = z.enum([
  "observed",
  "supported",
  "not_supported",
  "inconsistent",
  "unknown",
]);

export const tokenStandardObservationSchema = guardJsonSchema(jsonObject({
  standardId: tokenStandardIdSchema,
  status: tokenStandardObservationStatusSchema,
}).strict().superRefine((value, context) => {
  if (!(tokenStandardDefinitions[value.standardId].statuses as readonly string[]).includes(value.status)) {
    context.addIssue({ code: "custom", message: "The standard does not permit this observation status." });
  }
}));
export type TokenStandardObservation = z.infer<typeof tokenStandardObservationSchema>;

export const supportedErc8056ValuesSchema = guardJsonSchema(jsonObject({
  currentMultiplier: uint256DecimalSchema,
  pendingMultiplier: uint256DecimalSchema,
  pendingEffectiveAt: uint256DecimalSchema,
}).strict());
export type SupportedErc8056Values = z.infer<typeof supportedErc8056ValuesSchema>;

const validRequiredStatusPairs = new Set<string>([
  "not_supported:not_supported",
  "not_supported:unknown",
  "unknown:not_supported",
  "unknown:unknown",
  "inconsistent:not_supported",
  "inconsistent:inconsistent",
  "supported:supported",
]);
const validRequiredStatusPair = (
  erc8056: TokenStandardObservationStatus,
  pending: TokenStandardObservationStatus,
): boolean => validRequiredStatusPairs.has(`${erc8056}:${pending}`);

export const requiredErc8056ObservationSchema = guardJsonSchema(jsonObject({
  asset: erc20AssetIdentitySchema,
  block: chainAnchorSchema,
  erc165: tokenStandardObservationSchema,
  erc8056: tokenStandardObservationSchema,
  pendingMultiplier: tokenStandardObservationSchema,
  values: supportedErc8056ValuesSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.asset.chainId !== value.block.chainId) {
    context.addIssue({ code: "custom", message: "The standard observation asset and block differ." });
  }
  if (
    value.erc165.standardId !== "erc165" ||
    value.erc8056.standardId !== "erc8056" ||
    value.pendingMultiplier.standardId !== "erc8056_pending_multiplier"
  ) {
    context.addIssue({ code: "custom", message: "The required standard observations are misplaced." });
  }
  const complete = value.erc165.status === "supported" &&
    value.erc8056.status === "supported" &&
    value.pendingMultiplier.status === "supported";
  if ((value.values !== undefined) !== complete) {
    context.addIssue({ code: "custom", message: "The required ERC-8056 values and statuses differ." });
  }
  if (value.erc165.status !== "supported" && (
    value.erc8056.status !== "unknown" ||
    value.pendingMultiplier.status !== "unknown"
  )) {
    context.addIssue({ code: "custom", message: "ERC-8056 cannot be observed without valid ERC-165." });
  } else if (value.erc165.status === "supported" &&
    !validRequiredStatusPair(value.erc8056.status, value.pendingMultiplier.status)) {
    context.addIssue({ code: "custom", message: "The required ERC-8056 statuses are contradictory." });
  }
}));
export type RequiredErc8056Observation = z.infer<typeof requiredErc8056ObservationSchema>;

const completeStandardOrder = [
  "erc20_read_surface",
  "erc165",
  "erc8056",
  "erc8056_pending_multiplier",
  "erc8056_conversion",
  "erc8056_balances",
] as const;

export const tokenStandardObservationResultSchema = guardJsonSchema(jsonObject({
  asset: erc20AssetIdentitySchema,
  account: evmAccountIdentitySchema.optional(),
  block: chainAnchorSchema,
  standards: z.array(tokenStandardObservationSchema).length(completeStandardOrder.length),
  requiredErc8056: supportedErc8056ValuesSchema.optional(),
  balanceOfUi: uint256DecimalSchema.optional(),
  calculatedBalance: scaledUiAmountSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.asset.chainId !== value.block.chainId ||
    (value.account !== undefined && value.account.chainId !== value.block.chainId)) {
    context.addIssue({ code: "custom", message: "The standard result identities and block differ." });
  }
  if (value.standards.some((entry, index) => entry.standardId !== completeStandardOrder[index])) {
    context.addIssue({ code: "custom", message: "The standard observations are not in canonical order." });
  }
  if (value.standards[0]?.status !== "observed") {
    context.addIssue({ code: "custom", message: "The ERC-20 read surface was not observed." });
  }
  const requiredSupported = value.standards[1]?.status === "supported" &&
    value.standards[2]?.status === "supported" &&
    value.standards[3]?.status === "supported";
  if ((value.requiredErc8056 !== undefined) !== requiredSupported) {
    context.addIssue({ code: "custom", message: "The complete ERC-8056 values and statuses differ." });
  }
  const erc165Status = value.standards[1]?.status;
  const erc8056Status = value.standards[2]?.status;
  const pendingStatus = value.standards[3]?.status;
  if (
    erc165Status === "supported" &&
    erc8056Status !== undefined &&
    pendingStatus !== undefined &&
    !validRequiredStatusPair(erc8056Status, pendingStatus)
  ) {
    context.addIssue({ code: "custom", message: "The complete required statuses are contradictory." });
  }
  if (erc165Status !== "supported" && (
    erc8056Status !== "unknown" ||
    pendingStatus !== "unknown" ||
    value.standards[4]?.status !== "unknown" ||
    value.standards[5]?.status !== "unknown"
  )) {
    context.addIssue({ code: "custom", message: "The result claims standards without valid ERC-165." });
  }
  if (!requiredSupported && (
    value.standards[4]?.status === "supported" ||
    value.standards[5]?.status === "supported"
  )) {
    context.addIssue({ code: "custom", message: "An optional ERC-8056 extension lacks required support." });
  }
  if (value.calculatedBalance !== undefined) {
    if (value.account === undefined || value.requiredErc8056 === undefined ||
      value.calculatedBalance.multiplier !== value.requiredErc8056.currentMultiplier) {
      context.addIssue({ code: "custom", message: "The scaled balance is not bound to its account evidence." });
    }
  } else if (
    value.account !== undefined &&
    value.requiredErc8056 !== undefined &&
    value.standards[5]?.status !== "unknown" &&
    value.standards[5]?.status !== "inconsistent"
  ) {
    context.addIssue({ code: "custom", message: "The account result omits its scaled-balance conclusion." });
  }
  if (value.balanceOfUi !== undefined && (
    value.calculatedBalance?.status !== "available" ||
    value.balanceOfUi !== value.calculatedBalance.adjustedRaw ||
    value.standards[5]?.status !== "supported"
  )) {
    context.addIssue({ code: "custom", message: "The onchain UI balance is not cross-checked." });
  }
  if (
    value.account !== undefined &&
    value.standards[5]?.status === "supported" &&
    value.balanceOfUi === undefined
  ) {
    context.addIssue({ code: "custom", message: "The declared balances extension lacks its account cross-check." });
  }
}));
export type TokenStandardObservationResult = z.infer<typeof tokenStandardObservationResultSchema>;
