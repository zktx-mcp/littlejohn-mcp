import {
  deepFreezeValue,
  evmAddressSchema,
  productChainId,
} from "../../core/client.js";
import { protocolIdSchema } from "../contracts.js";

export const uniswapV4ProtocolId = protocolIdSchema.parse("uniswap_v4");
export const uniswapV4RouterVersion = "2.1.1" as const;
export const uniswapV4DeploymentSource = deepFreezeValue({
  owner: "Uniswap",
  revision: "502014cae668d512d76d2fe0df838f6990f4db53",
  uri: "https://github.com/Uniswap/contracts/blob/502014cae668d512d76d2fe0df838f6990f4db53/deployments/json/4663.json",
  chainId: productChainId,
});

export const uniswapV4ContractAddresses = deepFreezeValue({
  poolManager: evmAddressSchema.parse("0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  stateView: evmAddressSchema.parse("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"),
  quoter: evmAddressSchema.parse("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
  permit2: evmAddressSchema.parse("0x000000000022d473030f116ddee9f6b43ac78ba3"),
  router: evmAddressSchema.parse("0x06afba43fd06227fa663b0daecf536f6eaa6bf99"),
});
