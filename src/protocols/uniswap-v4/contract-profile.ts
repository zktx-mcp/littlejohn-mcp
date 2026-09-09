import { deepFreezeValue } from "../../core/client.js";
import { uniswapV4ContractAddresses } from "./deployment.js";
import type { UniswapV4ExpectedEffect } from "./effects.js";

// Functions exercised by the selected native call profile. Source admission
// checks these signatures on each contract's effective verified interface.
export const uniswapV4RequiredContractFunctions = deepFreezeValue({
  input_token: ["allowance(address,address)", "approve(address,uint256)", "balanceOf(address)", "decimals()", "transferFrom(address,address,uint256)"],
  output_token: ["balanceOf(address)", "decimals()", "transfer(address,uint256)"],
  permit2: ["allowance(address,address,address)", "approve(address,address,uint160,uint48)", "transferFrom(address,address,uint160,address)"],
  pool_manager: ["settle()", "swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)", "sync(address)", "take(address,address,uint256)", "unlock(bytes)"],
  quoter: ["quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))", "quoteExactOutputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))"],
  router: ["execute(bytes,bytes[],uint256)", "unlockCallback(bytes)"],
  state_view: ["getSlot0(bytes32)"],
} as const);

export const uniswapV4ContractRoles = Object.freeze(
  Object.keys(uniswapV4RequiredContractFunctions) as (keyof typeof uniswapV4RequiredContractFunctions)[],
);

export const uniswapV4ConditionContracts = (effect: UniswapV4ExpectedEffect) => {
  const entries = effect.kind === "swap" ? {
    input_token: effect.tokenIn, output_token: effect.tokenOut,
    permit2: uniswapV4ContractAddresses.permit2, pool_manager: uniswapV4ContractAddresses.poolManager,
    quoter: uniswapV4ContractAddresses.quoter, router: uniswapV4ContractAddresses.router,
    state_view: uniswapV4ContractAddresses.stateView,
  } : effect.kind === "permit2_approval" ? {
    input_token: effect.token, permit2: uniswapV4ContractAddresses.permit2, router: uniswapV4ContractAddresses.router,
  } : { input_token: effect.token, permit2: uniswapV4ContractAddresses.permit2 };
  return uniswapV4ContractRoles.flatMap((role) => {
    const target = entries[role as keyof typeof entries];
    return target === undefined ? [] : [{ role, target }];
  });
};
