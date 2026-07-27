import {
  chainErrorRegistry,
  chainInterfaceErrorMappings,
} from "../../chain/index.js";

export const uniswapV2ErrorDefinitions = Object.freeze([{
  code: "token_decimals_unavailable",
  category: "source",
  message: "A required endpoint token decimals call reverted.",
  retryable: false,
}] as const);

export const uniswapV2ErrorRegistry =
  chainErrorRegistry.extend(uniswapV2ErrorDefinitions);

export const uniswapV2InterfaceErrorMappings =
  chainInterfaceErrorMappings.extend(uniswapV2ErrorRegistry, [{
    code: "token_decimals_unavailable",
    httpStatus: 502,
    problemTitle: "Token decimals unavailable",
    cliExitCode: 4,
  }]);
