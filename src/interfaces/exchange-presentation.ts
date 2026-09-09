import { nativeAssetUnitDefinition } from "../registry/native-asset.js";
import { formatAmount, productUsdgAsset, type CanonicalAmount } from "../core/client.js";
import type { ExchangeReview, ReadyExchangeReview } from "../review/contracts.js";
import type { ExchangeWalletOutcome } from "../review/response-contract.js";
import type { TransactionLedgerRecord } from "../receipt-activity/contracts.js";

export interface TransactionPresentationSection { readonly title: string; readonly lines: readonly string[] }
const tokenName = (address: string): string => address === productUsdgAsset.address ? "USDG" : `Token ${address}`;
const relation = { equal: "exactly", at_most: "at most", at_least: "at least" } as const;
const reviewAmount = (review: ReadyExchangeReview, address: string, raw: string): string => {
  const data = review.observation.data;
  const decimals = "replacement" in data ? data.tokenUnits.find((unit) => unit.asset.address === address)?.decimals :
    address === data.intent.input.token ? data.intent.input.decimals : address === data.intent.output.token ? data.intent.output.decimals : undefined;
  return decimals === undefined ? `${raw} raw units of ${address}` : `${formatAmount(raw, decimals)} ${tokenName(address)} token units`;
};
export const exchangeReviewSections = (review: ExchangeReview): readonly TransactionPresentationSection[] => {
  if (review.state !== "ready_for_wallet_review") return [{ title: review.state === "blocked" ? "Cannot request this transaction" : "A new decision is required", lines: [review.failure.error.message] }];
  const data = review.observation.data;
  const effect = review.expectedEffect;
  const replacement = "replacement" in data ? data.replacement : data.predecessor;
  const meaning = effect.kind === "swap" ? [
    `Send ${relation[effect.input.relation]} ${reviewAmount(review, effect.tokenIn, effect.input.amount)}.`,
    `Receive ${relation[effect.output.relation]} ${reviewAmount(review, effect.tokenOut, effect.output.amount)}.`,
    `Quantity basis: ${effect.basis}. Recipient: ${effect.recipient}.`,
    `Pool: ${effect.poolId}. Onchain deadline: ${effect.deadline}.`,
    ...("replacement" in data ? [] : [`Pool fee: ${formatAmount(String(data.pool.fee), "4")}%.`]),
  ] : [
    `Authorize ${effect.spender} to use ${reviewAmount(review, effect.token, effect.allowance)}.`,
    `Current allowance: ${reviewAmount(review, effect.token, effect.kind === "erc20_approval" ? data.state.erc20Allowance : data.state.permit2.amount)}.`,
    effect.expiration === "none" ? "This token allowance has no automatic expiry. Closing this decision does not revoke it." : `Router allowance expiry: ${effect.expiration}.`,
    "This approval does not perform the swap. A later user command requires a new decision and Wallet approval.",
  ];
  return [
    { title: effect.kind === "swap" ? "Exchange conditions" : "Allowance decision", lines: meaning },
    { title: "Account and cost", lines: [
      `Account: ${data.intent.account.address}. Chain: ${data.intent.account.chainId}.`,
      `Nonce: ${data.state.confirmedNonce}. Gas limit: ${data.gasLimit}${"replacement" in data ? " (preserved from the pending request)" : data.gasLimitSource === "estimate" ? " (network estimate proposal)" : " (selected)"}.`,
      `Maximum gas charge: ${formatAmount((BigInt(data.gasLimit) * BigInt(data.intent.fees.maxFeePerGas)).toString(10), nativeAssetUnitDefinition.decimals)} ETH.`,
      `Maximum fee: ${data.intent.fees.maxFeePerGas} wei/gas. Priority fee cap: ${data.intent.fees.maxPriorityFeePerGas} wei/gas.`,
      "A reverted transaction still consumes gas. Wallet approval and inclusion are separate outcomes.",
      ...(replacement === undefined ? [] : [`Replaces candidate ${replacement.transactionHash} at the same nonce. Replacement acceptance and inclusion are not guaranteed.`, `Original fee caps: ${replacement.fees.maxFeePerGas} wei/gas maximum, ${replacement.fees.maxPriorityFeePerGas} wei/gas priority.`]),
    ] },
    { title: "Evidence and limits", lines: [
      `Simulation returned at block ${data.block.blockNumber}. This is not an actual execution or asset movement.`,
      `Decision expires: ${data.actionExpiresAt}. Wallet waiting stops at this deadline; it cannot cancel a delivered Wallet request.`,
      data.official === null ? "This approval concerns the configured USDG token." : `Official membership and StockFactory identity were observed for ${data.official.member.contractAddress}. They do not establish safety or ownership of underlying shares.`,
      ...data.contracts.flatMap(({ role, facts }) => {
        const subject = role.replaceAll("_", " ");
        return [
          ...(facts.proxy.status === "resolved" ? [`${subject}: a proxy implementation was resolved; code and control facts can change.`] : []),
          ...(facts.controls.owner.status === "observed" ? [`${subject} owner: ${facts.controls.owner.value}.`] : facts.controls.owner.status === "unavailable" ? [`${subject}: owner could not be established.`] : []),
          ...(facts.controls.paused.status === "observed" ? [`${subject}: pause state ${facts.controls.paused.value ? "paused" : "not paused"} was observed.`] : facts.controls.paused.status === "unavailable" ? [`${subject}: pause state is unavailable.`] : []),
          ...(facts.controls.defaultAdmins.status === "observed" ? facts.controls.defaultAdmins.members.map((member) => `${subject} administrator: ${member}.`) : facts.controls.defaultAdmins.status === "not_declared" ? [] : [`${subject}: administrator coverage is ${facts.controls.defaultAdmins.status.replaceAll("_", " ")}.`]),
        ];
      }),
      "Only the declared contract controls and simulation coverage are established; future state and wallet-private requests are not known.",
    ] },
  ];
};
export const walletOutcomeText = (value: ExchangeWalletOutcome): string => {
  switch (value.status) {
    case "not_sent": return "No Wallet request was sent. Start a new decision for another attempt.";
    case "wallet_rejected": return "The Wallet rejected this request. No retry was started.";
    case "delivery_unknown": return "Waiting ended. Signing and broadcast are unknown; this did not cancel the Wallet request. An observed late hash is recorded without a new lookup. Use an explicit result query or a later transaction command to recheck known results.";
    case "hash_returned": return `Wallet returned transaction ${value.transactionHash}. This is not proof of execution. Ledger: ${value.recording}. Initial lookup: ${value.lookup}. Open the recorded transaction for execution, fees and verification; query explicitly if details remain unavailable.`;
  }
};
const amountText = (amount: CanonicalAmount): string => `${amount.decimals.status === "available" ? formatAmount(amount.raw, amount.decimals.value) : `${amount.raw} raw units (decimals unavailable)`} ${amount.asset.kind === "native" ? "ETH" : tokenName(amount.asset.address)}`;
export const transactionRecordSections = (record: TransactionLedgerRecord | null): readonly TransactionPresentationSection[] => {
  if (record === null) return [{ title: "No local record", lines: ["No transaction is recorded for this account and hash. This does not prove that no transaction was sent."] }];
  const data = record.inspection?.data;
  const result: TransactionPresentationSection[] = [{ title: "Transaction", lines: [record.transactionHash, `Account: ${record.account.address}.`,
    data === undefined ? "Hash recorded; chain result has not been observed." : data.status === "included" ? `Execution: ${data.execution}.` : `Chain lookup: ${data.status.replaceAll("_", " ")}.`,
    "This view reads stored observations only. An explicit result query updates them.",
  ] }];
  if (data?.status === "pending") result.push({ title: "Pending", lines: [`Observed nonce: ${data.nonce}. Request comparison: ${data.requestComparison}.`, "Pending is the selected endpoint's observation; Wallet-only state and a global pending queue are not known."] });
  if (data?.status === "included") result.push(
    { title: "Verification", lines: [`Reviewed request: ${data.requestComparison}. Reviewed effects: ${data.effectComparison.replaceAll("_", " ")}.`,
      `Block: ${data.block.blockNumber}. Finality: ${data.finality.status}.`,
      ...(data.metadataComplete ? [] : ["Token units or post-transaction details are incomplete; known execution and fees remain recorded."]),
      ...(data.additionalTokenEffects ? ["Additional token effects were observed outside the declared action."] : []),
    ] },
    { title: "Actual movements and fees", lines: [
      ...data.movements.map((entry) => `${entry.direction === "sent" ? "Sent" : "Received"}: ${amountText(entry.amount)}.`),
      `Gas charged: ${amountText(data.fees.amount)} (${data.fees.gasUsed} gas at ${data.fees.effectiveGasPrice} wei/gas).`,
      ...data.events.flatMap((event) => event.kind === "swap" ? [] : [`Approved ${amountText(event.amount)} for ${event.spender}${event.kind === "permit2_approval" ? `; expiry Unix seconds ${event.expiration}` : "; no native expiry"}.`]),
    ] },
    { title: "End-of-block state", lines: ["These balances and allowances corroborate the result; they are not transaction-attributable deltas.",
      ...data.postState.flatMap((entry) => entry.status === "unavailable" ? [`Token ${entry.token}: state unavailable.`] : [
        `Balance: ${amountText(entry.balance)}.`, `Token allowance to Permit2: ${amountText(entry.erc20Allowance)}.`,
        `Router allowance: ${amountText(entry.permit2Allowance)}; expiry Unix seconds ${entry.permit2Expiration}.`,
      ]),
    ] },
  );
  return result;
};
export const transactionSectionsText = (sections: readonly TransactionPresentationSection[]): string =>
  sections.map((section) => `${section.title}\n${section.lines.join("\n")}`).join("\n\n");
