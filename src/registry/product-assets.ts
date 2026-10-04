import {erc20AssetIdentitySchema} from "../evm/amounts.js";
import {deepFreezeValue} from "../core/client.js";
import {productChainId} from "./product-identity.js";

export const productUsdgAsset = deepFreezeValue(erc20AssetIdentitySchema.parse({
  kind: "erc20",
  chainId: productChainId,
  address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
}));
