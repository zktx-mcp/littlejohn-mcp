import type { EvmAddress } from "../core/index.js";
import type { PinnedEvmReadPort } from "../chain/index.js";
import type { ChainInvocationContext } from "../chain/invocation-lifecycle.js";
import type { CanonicalBlock } from "../chain/canonical-block.js";
import { selectTransactionContractFacts } from "../intelligence/transaction-facts.js";
import { uniswapV4RequiredContractFunctions, uniswapV4ContractRoles } from "../protocols/uniswap-v4/contract-profile.js";
import { ExchangeError } from "./errors.js";

export const readTransactionContractFacts = async (
  reads: PinnedEvmReadPort,
  context: ChainInvocationContext,
  block: CanonicalBlock,
  targets: readonly Readonly<{ role: typeof uniswapV4ContractRoles[number]; target: EvmAddress }>[],
) => {
  const selected = [];
  let previous = -1;
  for (const { role, target } of targets) {
    const ordinal = uniswapV4ContractRoles.indexOf(role);
    if (ordinal <= previous) throw new TypeError("Transaction contract roles are not canonical.");
    previous = ordinal;
    const execution = await reads.inspectContractExecution(context, block, target);
    const value = selectTransactionContractFacts(execution, uniswapV4RequiredContractFunctions[role]);
    if (value.facts.functionStatus !== "declared" ||
        (value.facts.controls.paused.status === "observed" && value.facts.controls.paused.value)) {
      throw new ExchangeError("exchange_contract_unavailable");
    }
    selected.push({ role, ...value });
  }
  return selected;
};
