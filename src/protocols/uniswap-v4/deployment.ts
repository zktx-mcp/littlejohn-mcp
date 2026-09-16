import {
  contractRuntimeCodeIdentitySchema,
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
  positionManager: evmAddressSchema.parse("0x58daec3116aae6d93017baaea7749052e8a04fa7"),
  quoter: evmAddressSchema.parse("0x8dc178efb8111bb0973dd9d722ebeff267c98f94"),
  permit2: evmAddressSchema.parse("0x000000000022d473030f116ddee9f6b43ac78ba3"),
  router: evmAddressSchema.parse("0x06afba43fd06227fa663b0daecf536f6eaa6bf99"),
});

// Code observed at the official non-proxy deployment addresses. These identities
// admit the price-read path; they do not qualify a transaction or hook.
export const uniswapV4PriceReadCodeIdentities = deepFreezeValue({
  poolManager: contractRuntimeCodeIdentitySchema.parse({
    byteLength: "24009", codeHash: "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626",
  }),
  stateView: contractRuntimeCodeIdentitySchema.parse({
    byteLength: "3531", codeHash: "0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6",
  }),
  positionManager: contractRuntimeCodeIdentitySchema.parse({
    byteLength: "23877", codeHash: "0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2",
  }),
});
