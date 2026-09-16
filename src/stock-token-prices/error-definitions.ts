export const stockTokenPricesErrorDefinitions = Object.freeze([
  {
    code: "pool_candidate_response_too_large",
    category: "domain",
    message: "The pool candidate response exceeds the supported size.",
    retryable: false,
  },
] as const);

export const stockTokenPricesInterfaceErrorMappingDefinitions = Object.freeze([
  {
    code: "pool_candidate_response_too_large",
    httpStatus: 502,
    problemTitle: "Pool candidate response too large",
    cliExitCode: 4,
  },
] as const);
