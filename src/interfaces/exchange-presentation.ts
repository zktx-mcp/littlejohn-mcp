import { nativeAssetUnitDefinition, productUsdgAsset } from "../registry/client.js";
import { formatAmount, type CanonicalAmount } from "../evm/amounts.js";
import type { ExchangeReview, ReadyExchangeReview } from "../review/contracts.js";
import type { ExchangeWalletOutcome } from "../review/response-contract.js";
import type { TransactionLedgerRecord } from "../receipt-activity/contracts.js";
import { presentationCopy as copy, statusCopy, failureCopy, failureDetailsFields, networkText, amountRelationText, approvalText, approvalExpiryText, type PresentationRole } from "./presentation-copy.js";

// Shared human facts. App controls their layout; text consumers use the same
// values. Neither consumer reconstructs a Review from these sections.
export interface TransactionPresentationSection {
  readonly title: string;
  readonly lines: readonly string[];
  readonly details?: boolean;
  readonly pendingQuery?: boolean;
  readonly fields?: readonly (readonly [string, string])[];
  readonly role?: PresentationRole;
}
const tokenName = (address: string): string => address === productUsdgAsset.address ? "USDG" : `${copy.label.token} ${address}`;
const reviewAmount = (review: ReadyExchangeReview, address: string, raw: string): string => {
  const data = review.observation.data;
  const decimals = "replacement" in data ? data.tokenUnits.find(unit => unit.asset.address === address)?.decimals
    : address === data.intent.input.token ? data.intent.input.decimals : address === data.intent.output.token ? data.intent.output.decimals : undefined;
  return decimals === undefined ? `${copy.label.amountUnavailable} (${copy.label.rawAmount}: ${raw}; ${address})`
    : `${formatAmount(raw, decimals)} ${tokenName(address)}`;
};
export const exchangeReviewSections = (review: ExchangeReview): readonly TransactionPresentationSection[] => {
  if (review.state !== "ready_for_wallet_review") {
    const failure = failureCopy(review.failure.error);
    return [{ title: failure.label, lines: [failure.message] }, {title: copy.label.errorDetails, details: true,
      lines: [], fields: failureDetailsFields(review.failure.error)}];
  }
  const data = review.observation.data;
  const effect = review.expectedEffect;
  const replacement = "replacement" in data ? data.replacement : data.predecessor;
  const meaning = effect.kind === "swap" ? [
    `${amountRelationText("send", effect.input.relation)} ${reviewAmount(review, effect.tokenIn, effect.input.amount)}.`,
    `${amountRelationText("receive", effect.output.relation)} ${reviewAmount(review, effect.tokenOut, effect.output.amount)}.`,
    `${copy.label.recipient}: ${effect.recipient}.`,
    ...("replacement" in data ? [] : [`${copy.label.poolFee}: ${formatAmount(String(data.pool.fee), "4")}%.`]),
  ] : [
    approvalText(effect.spender, reviewAmount(review, effect.token, effect.allowance), ""),
    effect.expiration === "none" ? copy.scope.approvalNoExpiry : approvalExpiryText(effect.expiration),
    `Current allowance: ${reviewAmount(review, effect.token, effect.kind === "erc20_approval" ? data.state.erc20Allowance : data.state.permit2.amount)}.`,
  ];
  return [
    { title: effect.kind === "swap" ? copy.label.exchangeAmounts : copy.label.approvalDetails, lines: meaning },
    { title: copy.label.accountAndFees, lines: [
      `${copy.label.account}: ${data.intent.account.address}. ${copy.label.network}: ${networkText(data.intent.account.chainId)}.`,
      `${copy.label.maximumNetworkFee}: ${formatAmount((BigInt(data.gasLimit) * BigInt(data.intent.fees.maxFeePerGas)).toString(10), nativeAssetUnitDefinition.decimals)} ETH.`,
      ...(replacement === undefined ? [] : [`${copy.label.replacesTransaction}: ${replacement.transactionHash}.`, copy.scope.replacement]),
    ] },
    { title: copy.label.warnings, lines: [
      copy.scope.walletApproval, copy.scope.revertFee,
      `Simulation returned at block ${data.block.blockNumber}. This is not an actual execution or asset movement.`,
      `${copy.label.availableUntil}: ${data.actionExpiresAt}. Wallet waiting stops at this deadline; it cannot cancel a delivered wallet request.`,
      ...(data.official === null ? [] : [copy.scope.officialClassification]),
      ...data.contracts.flatMap(({ role, facts }) => {
        const subject = role.replaceAll("_", " ");
        return [
          ...(facts.proxy.status === "resolved" ? [`${subject}: a proxy implementation was resolved; code and control facts can change.`] : []),
          ...(facts.controls.owner.status === "observed" ? [`${subject} ${copy.label.owner}: ${facts.controls.owner.value}.`] : facts.controls.owner.status === "unavailable" ? [`${subject}: owner could not be established.`] : []),
          ...(facts.controls.paused.status === "observed" ? [`${subject}: pause state ${facts.controls.paused.value ? "paused" : "not paused"} was observed.`] : facts.controls.paused.status === "unavailable" ? [`${subject}: pause state is unavailable.`] : []),
          ...(facts.controls.defaultAdmins.status === "observed" ? facts.controls.defaultAdmins.members.map(member => `${subject} ${copy.label.administrator}: ${member}.`) : facts.controls.defaultAdmins.status === "not_declared" ? [] : [`${subject}: administrator coverage is ${facts.controls.defaultAdmins.status.replaceAll("_", " ")}.`]),
        ];
      }),
      "Only the declared contract controls and simulation coverage are established; future state and wallet-private requests are not known.",
    ] },
    { title: copy.label.transactionDetails, details: true, lines: [
      `${copy.label.nonce}: ${data.state.confirmedNonce}. ${copy.label.gasLimit}: ${data.gasLimit}${"replacement" in data ? " (preserved from the pending request)" : data.gasLimitSource === "estimate" ? " (network estimate proposal)" : " (selected)"}.`,
      `${copy.label.maximumFeePerGas}: ${data.intent.fees.maxFeePerGas} wei/gas. ${copy.label.priorityFeeLimit}: ${data.intent.fees.maxPriorityFeePerGas} wei/gas.`,
      ...(effect.kind === "swap" ? [`Quantity basis: ${effect.basis}. Pool: ${effect.poolId}. Onchain deadline: ${effect.deadline}.`] : []),
      ...(replacement === undefined ? [] : [`Original fee caps: ${replacement.fees.maxFeePerGas} wei/gas maximum, ${replacement.fees.maxPriorityFeePerGas} wei/gas priority.`]),
    ] },
  ];
};
export const walletOutcomeText = (value: ExchangeWalletOutcome): string =>
  (value.status === "wallet_rejected" ? statusCopy.rejected : statusCopy[value.status]).message;
const amountText = (amount: CanonicalAmount): string => amount.decimals.status === "available"
  ? `${formatAmount(amount.raw, amount.decimals.value)} ${amount.asset.kind === "native" ? "ETH" : tokenName(amount.asset.address)}`
  : `${copy.label.amountUnavailable} (${copy.label.rawAmount}: ${amount.raw}; ${amount.asset.kind === "native" ? "ETH" : amount.asset.address})`;
export const transactionRecordSections = (record: TransactionLedgerRecord | null): readonly TransactionPresentationSection[] => {
  if (record === null) return [{ title: statusCopy.not_found.label, lines: [statusCopy.not_found.message, copy.scope.history] }];
  const data = record.inspection?.data;
  const state = data === undefined ? statusCopy.hash_returned : data.status === "included" ? statusCopy[data.execution] : statusCopy[data.status];
  const result: TransactionPresentationSection[] = [{title: state.label, role: state.role, lines: [state.message],
    fields: [[copy.label.account, record.account.address], [copy.label.transactionHash, record.transactionHash]],
    ...(data?.status === "pending" ? {pendingQuery: true} : {})}];
  if (data?.status === "pending") result.push({title: copy.label.transactionDetails, details: true,
    lines: [`${copy.label.nonce}: ${data.nonce}. ${copy.label.requestCheck}: ${copy.comparison[data.requestComparison]}.`]});
  if (data?.status === "included") result.push(
    {title: copy.label.accountAndFees, lines: [
      ...data.movements.map(entry => `${entry.direction === "sent" ? copy.label.sent : copy.label.received}: ${amountText(entry.amount)}.`),
      `${copy.label.networkFee}: ${amountText(data.fees.amount)}.`,
      ...data.events.flatMap(event => event.kind === "swap" ? [] : [
        `${copy.label.approvedAmount}: ${amountText(event.amount)}. ${copy.label.spender}: ${event.spender}.`,
        event.kind === "permit2_approval" ? approvalExpiryText(event.expiration) : copy.scope.approvalNoExpiry,
      ]),
    ]},
    {title: copy.label.dataLimits, lines: [
      `${copy.label.requestCheck}: ${copy.comparison[data.requestComparison]}. ${copy.label.effectCheck}: ${copy.comparison[data.effectComparison]}.`,
      `${copy.label.networkConfirmation}: ${copy.finality[data.finality.status]}.`,
      ...(data.finality.status === "safe" ? [copy.scope.safeBlock] : []),
      ...(data.metadataComplete ? [] : ["Token units or post-transaction details are incomplete; known execution and fees remain recorded."]),
      ...(data.additionalTokenEffects ? ["Additional token effects were observed outside the declared action."] : []),
    ]},
    {title: copy.label.transactionDetails, details: true, lines: [
      `${copy.label.block}: ${data.block.blockNumber}.`,
      `Gas charged: ${data.fees.gasUsed} at ${data.fees.effectiveGasPrice} wei/gas.`,
      "These balances and allowances corroborate the result; they are not transaction-attributable deltas.",
      ...data.postState.flatMap(entry => entry.status === "unavailable" ? [`${copy.label.token} ${entry.token}: ${copy.label.unavailable}.`] : [
        `${copy.label.balance}: ${amountText(entry.balance)}.`, `Token allowance to Permit2: ${amountText(entry.erc20Allowance)}.`,
        `Router allowance: ${amountText(entry.permit2Allowance)}; expiry Unix seconds ${entry.permit2Expiration}.`,
      ]),
    ]},
  );
  return result;
};
export const transactionSectionsText = (sections: readonly TransactionPresentationSection[]): string =>
  sections.map(section => `${section.title}\n${[...section.lines, ...(section.fields ?? []).map(([label, value]) => `${label}: ${value}`)].join("\n")}`).join("\n\n");
