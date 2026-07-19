export const chainErrorDefinitions = Object.freeze([
  {
    code: "not_found",
    category: "domain",
    message: "The requested data was not found.",
    retryable: false,
  },
  {
    code: "source_unavailable",
    category: "source",
    message: "A required data source is unavailable.",
    retryable: true,
  },
  {
    code: "source_inconsistent",
    category: "source",
    message: "Required source evidence is inconsistent.",
    retryable: false,
  },
  {
    code: "rate_limited",
    category: "source",
    message: "A required data source rate-limited the request.",
    retryable: true,
  },
] as const);

export const chainInterfaceErrorMappingDefinitions = Object.freeze([
  { code: "not_found", httpStatus: 404, problemTitle: "Data not found", cliExitCode: 3 },
  {
    code: "source_unavailable",
    httpStatus: 503,
    problemTitle: "Source unavailable",
    cliExitCode: 4,
  },
  {
    code: "source_inconsistent",
    httpStatus: 502,
    problemTitle: "Source inconsistent",
    cliExitCode: 4,
  },
  { code: "rate_limited", httpStatus: 429, problemTitle: "Rate limited", cliExitCode: 4 },
] as const);
