import {contractRuntimeCodeIdentitySchema} from "../../intelligence/analysis-contract.js";
import {deepFreezeValue} from "../../core/client.js";
import {evmAddressSchema} from "../../evm/identities.js";
import {productChainId} from "../../registry/client.js";
import { protocolIdSchema } from "../contracts.js";

export const uniswapV3ProtocolId = protocolIdSchema.parse("uniswap_v3");
export const uniswapV3DeploymentSource = deepFreezeValue({
  owner: "Uniswap", revision: "37936185dee7decf681360ec799c124e0e034672",
  uri: "https://github.com/Uniswap/contracts/blob/37936185dee7decf681360ec799c124e0e034672/deployments/json/4663.json",
  chainId: productChainId,
});
export const uniswapV3FactoryAddress = evmAddressSchema.parse("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
export const uniswapV3FactoryRuntimeCodeIdentity = deepFreezeValue(contractRuntimeCodeIdentitySchema.parse({
  byteLength: "24535", codeHash: "0xec72b1abd1f2faee020cfea9c646bd8994f9fb389054f6e574f103a895091739",
}));
