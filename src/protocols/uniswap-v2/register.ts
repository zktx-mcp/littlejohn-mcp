import { uniswapProtocolFamily } from "../uniswap.js";
import { readUniswapV2PoolPrice } from "./pool-price.js";
import {
  uniswapV2PackageDescriptor,
} from "./deployment.js";
import {
  uniswapV2QuoteCapability,
} from "./contracts.js";
import {
  createUniswapV2QuoteApplication,
} from "./application.js";

export const uniswapV2PackageRegistration = Object.freeze({
  family: uniswapProtocolFamily,
  package: uniswapV2PackageDescriptor,
  capability: uniswapV2QuoteCapability,
  createApplication: createUniswapV2QuoteApplication,
  readPoolPrice: readUniswapV2PoolPrice,
});
