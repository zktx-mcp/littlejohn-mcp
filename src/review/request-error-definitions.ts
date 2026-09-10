export const requestReviewErrorDefinitions = Object.freeze([
  { code: "review_expired", category: "domain", message: "The decision expired. A new request is required.", retryable: true },
  { code: "review_unavailable", category: "domain", message: "The exact live decision is unavailable.", retryable: true },
  { code: "review_capacity_exceeded", category: "domain", message: "The request exceeds the available Review capacity.", retryable: false },
] as const);

export const requestReviewErrorMappingDefinitions = Object.freeze(requestReviewErrorDefinitions.map((entry) => ({
  code: entry.code, httpStatus: 409 as const, problemTitle: entry.message, cliExitCode: 2 as const,
})));
