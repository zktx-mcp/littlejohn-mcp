import { keccak256FromUtf8 } from "../../core/client.js";

export const uniswapV4SwapTopic = keccak256FromUtf8("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
