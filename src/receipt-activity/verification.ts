import type { IncludedReceiptData } from "./data.js";

export const evaluateReceiptEffects = (value: IncludedReceiptData) => {
  const expected = value.conditions;
  const allowed = expected?.kind === "swap" ? [expected.tokenIn, expected.tokenOut] : [];
  const additionalTokenEffects = value.movements.some((entry) => entry.amount.asset.kind !== "erc20" || !allowed.includes(entry.amount.asset.address));
  const result = (comparison: "matched" | "mismatched" | "unavailable" | "not_executed") => ({ comparison, additionalTokenEffects });
  if (value.execution === "reverted") return result("not_executed");
  if (value.requestComparison !== "matched" || expected === null || !value.metadataComplete || value.eventCoverage !== "complete" ||
      value.postState.some((entry) => entry.status !== "observed") ||
      [...value.movements.map((entry) => entry.amount), ...value.events.flatMap((entry) => entry.kind === "swap" ? [] : [entry.amount])]
        .some((amount) => amount.decimals.status !== "available")) return result("unavailable");
  if (additionalTokenEffects || value.actualSender !== value.account.address) return result("mismatched");
  if (expected.kind === "swap") {
    const swaps = value.events.filter((entry) => entry.kind === "swap");
    if (swaps.length !== 1 || swaps[0]!.poolId !== expected.poolId || swaps[0]!.sender !== expected.router) return result("mismatched");
    const delta = (token: string, direction: "sent" | "received") => value.movements.reduce((sum, entry) =>
      entry.amount.asset.kind === "erc20" && entry.amount.asset.address === token
        ? sum + (entry.direction === direction ? BigInt(entry.amount.raw) : -BigInt(entry.amount.raw)) : sum, 0n);
    const paid = delta(expected.tokenIn, "sent");
    const received = delta(expected.tokenOut, "received");
    return result((expected.input.relation === "equal" ? paid === BigInt(expected.input.amount) : paid >= 0n && paid <= BigInt(expected.input.amount)) &&
      (expected.output.relation === "equal" ? received === BigInt(expected.output.amount) : received >= BigInt(expected.output.amount)) ? "matched" : "mismatched");
  }
  const approvals = value.events.filter((entry) => entry.kind !== "swap");
  if (value.events.some((entry) => entry.kind === "swap") || approvals.length !== 1) return result("mismatched");
  const approval = approvals[0]!;
  return result(approval.kind === expected.kind && approval.owner === value.actualSender && approval.spender === expected.spender &&
    approval.amount.asset.kind === "erc20" && approval.amount.asset.address === expected.token && approval.amount.raw === expected.allowance &&
    (approval.kind === "erc20_approval" || expected.kind === "permit2_approval" &&
      BigInt(approval.expiration) * 1_000n === BigInt(Date.parse(expected.expiration))) ? "matched" : "mismatched");
};
