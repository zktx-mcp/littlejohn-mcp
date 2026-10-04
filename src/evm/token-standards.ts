import {z} from "zod";

import {erc20AssetIdentitySchema, scaledUiAmountSchema, uint256DecimalSchema} from "./amounts.js";
import {deepFreezeValue} from "../core/client.js";
import {guardJsonSchema, jsonObject} from "../core/client.js";
import {evmAccountIdentitySchema} from "./identities.js";
import {chainAnchorSchema} from "./primitives.js";

export const tokenStandardObservationStatuses = deepFreezeValue({
  observed: "observed",
  supported: "supported",
  notSupported: "not_supported",
  inconsistent: "inconsistent",
  unknown: "unknown",
} as const);

export type TokenStandardObservationStatus =
  (typeof tokenStandardObservationStatuses)[keyof typeof tokenStandardObservationStatuses];

export const tokenStandardDefinitions = deepFreezeValue({
  erc20_read_surface: {
    displayName: "ERC-20",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-20",
    explanation: "The ERC-20 reads used by Little John succeeded. ERC-20 has no ERC-165 interface ID, so this observation does not certify all transfer, allowance, event, or failure behavior.",
    statuses: [
      tokenStandardObservationStatuses.observed,
      tokenStandardObservationStatuses.unknown,
    ],
  },
  erc165: {
    displayName: "ERC-165",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-165",
    explanation: "The contract passed the ERC-165 self-interface and invalid-interface calls with the required 30,000 gas bound. This establishes standard interface detection, not support for any particular token interface.",
    statuses: [
      tokenStandardObservationStatuses.supported,
      tokenStandardObservationStatuses.notSupported,
      tokenStandardObservationStatuses.inconsistent,
      tokenStandardObservationStatuses.unknown,
    ],
  },
  erc8056: {
    displayName: "ERC-8056",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-8056",
    explanation: "The contract declared the ERC-8056 core and required pending-multiplier interfaces and returned valid values. ERC-8056 is a draft display-scaling extension; raw ERC-20 accounting does not change.",
    statuses: [
      tokenStandardObservationStatuses.supported,
      tokenStandardObservationStatuses.notSupported,
      tokenStandardObservationStatuses.inconsistent,
      tokenStandardObservationStatuses.unknown,
    ],
  },
  erc8056_pending_multiplier: {
    displayName: "ERC-8056 pending multiplier",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-8056",
    explanation: "The required pending-multiplier interface returned the scheduled multiplier and effective timestamp used to explain a future display change.",
    statuses: [
      tokenStandardObservationStatuses.supported,
      tokenStandardObservationStatuses.notSupported,
      tokenStandardObservationStatuses.inconsistent,
      tokenStandardObservationStatuses.unknown,
    ],
  },
  erc8056_conversion: {
    displayName: "ERC-8056 conversion",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-8056",
    explanation: "The optional conversion interface exposes onchain raw-to-UI and UI-to-raw helpers. Little John still preserves raw values and uses its canonical integer calculation for display evidence.",
    statuses: [
      tokenStandardObservationStatuses.supported,
      tokenStandardObservationStatuses.notSupported,
      tokenStandardObservationStatuses.inconsistent,
      tokenStandardObservationStatuses.unknown,
    ],
  },
  erc8056_balances: {
    displayName: "ERC-8056 balances",
    specificationUri: "https://eips.ethereum.org/EIPS/eip-8056",
    explanation: "The optional balances interface exposes UI-adjusted balance and total-supply reads. For an account result, balanceOfUI must agree with the value calculated from the same-block raw balance and multiplier.",
    statuses: [
      tokenStandardObservationStatuses.supported,
      tokenStandardObservationStatuses.notSupported,
      tokenStandardObservationStatuses.inconsistent,
      tokenStandardObservationStatuses.unknown,
    ],
  },
} as const);

export type TokenStandardId = keyof typeof tokenStandardDefinitions;
export const tokenStandardDefinitionFor = (standardId: TokenStandardId) =>
  tokenStandardDefinitions[standardId];

export const tokenStandardOrder = Object.freeze(Object.keys(tokenStandardDefinitions)) as readonly [
  TokenStandardId,
  ...TokenStandardId[],
];

const tokenStandardObservationStatusValues = Object.freeze(
  Object.values(tokenStandardObservationStatuses),
) as readonly [TokenStandardObservationStatus, ...TokenStandardObservationStatus[]];

export const tokenStandardIdSchema = z.enum(tokenStandardOrder);
export const tokenStandardObservationStatusSchema =
  z.enum(tokenStandardObservationStatusValues);

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

export const tokenStandardObservationResultSchema = guardJsonSchema(jsonObject({
  asset: erc20AssetIdentitySchema,
  account: evmAccountIdentitySchema.optional(),
  block: chainAnchorSchema,
  standards: z.array(tokenStandardObservationSchema).length(tokenStandardOrder.length),
  requiredErc8056: supportedErc8056ValuesSchema.optional(),
  balanceOfUi: uint256DecimalSchema.optional(),
  calculatedBalance: scaledUiAmountSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.asset.chainId !== value.block.chainId ||
    (value.account !== undefined && value.account.chainId !== value.block.chainId)) {
    context.addIssue({ code: "custom", message: "The standard result identities and block differ." });
  }
  if (value.standards.some((entry, index) => entry.standardId !== tokenStandardOrder[index])) {
    context.addIssue({ code: "custom", message: "The standard observations are not in canonical order." });
  }
  const standards: Partial<Record<TokenStandardId, TokenStandardObservation>> = {};
  for (const entry of value.standards) standards[entry.standardId] = entry;
  if (standards.erc20_read_surface?.status !== tokenStandardObservationStatuses.observed) {
    context.addIssue({ code: "custom", message: "The ERC-20 read surface was not observed." });
  }
  const requiredSupported =
    standards.erc165?.status === tokenStandardObservationStatuses.supported &&
    standards.erc8056?.status === tokenStandardObservationStatuses.supported &&
    standards.erc8056_pending_multiplier?.status ===
      tokenStandardObservationStatuses.supported;
  if ((value.requiredErc8056 !== undefined) !== requiredSupported) {
    context.addIssue({ code: "custom", message: "The complete ERC-8056 values and statuses differ." });
  }
  const erc165Status = standards.erc165?.status;
  const erc8056Status = standards.erc8056?.status;
  const pendingStatus = standards.erc8056_pending_multiplier?.status;
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
    standards.erc8056_conversion?.status !== tokenStandardObservationStatuses.unknown ||
    standards.erc8056_balances?.status !== tokenStandardObservationStatuses.unknown
  )) {
    context.addIssue({ code: "custom", message: "The result claims standards without valid ERC-165." });
  }
  if (!requiredSupported && (
    standards.erc8056_conversion?.status === tokenStandardObservationStatuses.supported ||
    standards.erc8056_balances?.status === tokenStandardObservationStatuses.supported
  )) {
    context.addIssue({ code: "custom", message: "An optional ERC-8056 extension lacks required support." });
  }
  const requiresCalculatedBalance =
    value.account !== undefined && value.requiredErc8056 !== undefined;
  if ((value.calculatedBalance !== undefined) !== requiresCalculatedBalance) {
    context.addIssue({ code: "custom", message: "The account result omits its scaled-balance conclusion." });
  } else if (value.calculatedBalance !== undefined) {
    if (value.account === undefined || value.requiredErc8056 === undefined ||
      value.calculatedBalance.multiplier !== value.requiredErc8056.currentMultiplier) {
      context.addIssue({ code: "custom", message: "The scaled balance is not bound to its account evidence." });
    }
  }
  if (value.balanceOfUi !== undefined) {
    const balanceStatus = standards.erc8056_balances?.status;
    const calculation = value.calculatedBalance;
    const comparisonAvailable = calculation?.status === "available";
    const agrees = comparisonAvailable && value.balanceOfUi === calculation.adjustedRaw;
    const relationValid = balanceStatus === tokenStandardObservationStatuses.unknown
      ? calculation?.status === "unavailable"
      : balanceStatus === tokenStandardObservationStatuses.supported
        ? agrees
        : balanceStatus === tokenStandardObservationStatuses.inconsistent
          ? comparisonAvailable && !agrees
          : false;
    if (!relationValid) {
      context.addIssue({ code: "custom", message: "The onchain UI balance is not cross-checked." });
    }
  }
  if (
    value.account !== undefined &&
    standards.erc8056_balances?.status === tokenStandardObservationStatuses.supported &&
    value.balanceOfUi === undefined
  ) {
    context.addIssue({ code: "custom", message: "The declared balances extension lacks its account cross-check." });
  }
}));
export type TokenStandardObservationResult = z.infer<typeof tokenStandardObservationResultSchema>;
