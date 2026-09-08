export const tokenCatalogErrorDefinitions = Object.freeze([
  {
    code: "token_selection_already_included",
    category: "state",
    message: "The token is already included for the current account.",
    retryable: false,
  },
  {
    code: "token_selection_not_found",
    category: "state",
    message: "The token has no account selection.",
    retryable: false,
  },
  {
    code: "token_selection_not_included",
    category: "state",
    message: "The token is not included for the current account.",
    retryable: false,
  },
  {
    code: "token_selection_revision_changed",
    category: "state",
    message: "The token selection changed before the request completed.",
    retryable: false,
  },
  {
    code: "token_total_supply_reverted",
    category: "domain",
    message: "The token contract reverted the required totalSupply call.",
    retryable: false,
  },
  {
    code: "token_operation_not_found",
    category: "state",
    message: "The account token operation is not available.",
    retryable: false,
  },
  {
    code: "token_review_expired",
    category: "state",
    message: "The token selection Review expired before a decision was admitted.",
    retryable: false,
  },
] as const);

export const tokenCatalogInterfaceErrorMappingDefinitions = Object.freeze([
  { code: "token_selection_already_included", httpStatus: 409, problemTitle: "Token already included", cliExitCode: 5 },
  { code: "token_selection_not_found", httpStatus: 404, problemTitle: "Token selection not found", cliExitCode: 3 },
  { code: "token_selection_not_included", httpStatus: 409, problemTitle: "Token not included", cliExitCode: 5 },
  { code: "token_selection_revision_changed", httpStatus: 409, problemTitle: "Token selection changed", cliExitCode: 5 },
  { code: "token_total_supply_reverted", httpStatus: 422, problemTitle: "Token total supply reverted", cliExitCode: 3 },
  { code: "token_operation_not_found", httpStatus: 404, problemTitle: "Token operation not found", cliExitCode: 3 },
  { code: "token_review_expired", httpStatus: 409, problemTitle: "Token Review expired", cliExitCode: 5 },
] as const);
