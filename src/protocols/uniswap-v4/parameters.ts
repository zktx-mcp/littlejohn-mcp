import { uniswapV4RouterVersion } from "./deployment.js";
import { deepFreezeValue } from "../../core/client.js";
import { exchangeActionContracts } from "../../review/action-contracts.js";

export const uniswapV4SwapFields = deepFreezeValue({
  sent: { amount: "amountIn", limit: "amountOutMinimum" },
  received: { amount: "amountOut", limit: "amountInMaximum" },
});
const sharedParameters = [
  ["chainId", "chainId", "CAIP-2 / EIP-155", "product chain", "Required exact productChainId; encoded as a JSON-RPC quantity."],
  ["account", "from / payerIsUser", "canonical EVM address", "selected account plus current session", "Required exact admitted account; no conversion."],
  ["fees", "maxFeePerGas / maxPriorityFeePerGas", "uint256 wei per gas", "user-selected", "Both required; priority cap cannot exceed fee cap; exact integer encoding."],
  ["gasLimit", "gas", "positive uint256 gas", "user-selected or labelled RPC estimate proposal", "Required; current simulation must fit it; fees-only replacement preserves the original gas."],
  ["nonce", "nonce", "uint256 account nonce", "current confirmed and pending RPC observations", "Ordinary request requires clear dependencies; replacement preserves the observed next confirmed nonce."],
  ["value / type / accessList", "value / type / accessList", "wei / EIP-2718 type / access list", "protocol-required", "Zero native value, type 2, empty access list; no implicit Wallet defaults."],
] as const;
const swapParameters = [
  ["poolId", "PoolKey", "canonical currencies, uint24 fee, int24 tickSpacing, hooks address", "user-selected admitted catalog entry and current chain", "Complete PoolKey and derived ID must agree; only the zero-hook profile is admitted."],
  ["input / output", "amountIn / amountOut / amountInMaximum / amountOutMinimum", "raw token integers", "user-selected token units with verified decimals", "Core parses exactly without rounding; the quoted quantity fits the native signed range; native amount admission owns uint128 bounds."],
  ["inputRelation", "SETTLE / SETTLE_ALL", "input equality or maximum", "user-selected", "Fixed settlement and zero final delta enforce equality; full debt settlement enforces the selected cap."],
  ["outputRelation", "TAKE / TAKE_ALL", "output equality or minimum", "user-selected", "Fixed collection and zero final delta enforce equality; full collection enforces the selected minimum."],
  ["recipient", "TAKE recipient / caller sentinel", "canonical EVM address", "explicitly confirmed account", "Exact selected account; router sentinel is independently decoded back to the sender."],
  ["deadline", "execute.deadline", "uint256 Unix seconds", "user-selected", "Required whole-second UTC instant; conversion is exact; it does not define SDK request expiry."],
  ["minHopPriceX36 / hookData", "minHopPriceX36 / hookData", "uint256 / bytes", "protocol-required", "Zero hop-price floor and empty hook data; the independent final output condition remains mandatory."],
] as const;
const approvalParameters = [
  ["token / spender", "approve spender or token+spender", "canonical EVM address", "selected input asset / registered Permit2 or router", "Only the exact native approval target and spender are admitted."],
  ["allowance", "approve.amount", "raw token integer", "reviewed maximum input need", "ERC-20 uint256 or Permit2 uint160; no rounding or implicit unlimited allowance."],
  ["expiration", "Permit2 approve.expiration", "uint48 Unix seconds", "reviewed user deadline", "Required for Permit2, exact conversion; ERC-20 approval has no native expiry."],
] as const;
export const uniswapV4ActionProfiles = Object.freeze([
  { contract: exchangeActionContracts.sent, nativeOperation: "SWAP_EXACT_IN_SINGLE", nativeVersion: uniswapV4RouterVersion, parameters: deepFreezeValue([...sharedParameters, ...swapParameters]) },
  { contract: exchangeActionContracts.received, nativeOperation: "SWAP_EXACT_OUT_SINGLE", nativeVersion: uniswapV4RouterVersion, parameters: deepFreezeValue([...sharedParameters, ...swapParameters]) },
  { contract: exchangeActionContracts.erc20, nativeOperation: "IERC20.approve", nativeVersion: "ERC-20", parameters: deepFreezeValue([...sharedParameters, ...approvalParameters]) },
  { contract: exchangeActionContracts.permit2, nativeOperation: "IAllowanceTransfer.approve", nativeVersion: "Permit2", parameters: deepFreezeValue([...sharedParameters, ...approvalParameters]) },
].map((profile) => Object.freeze(profile)));
