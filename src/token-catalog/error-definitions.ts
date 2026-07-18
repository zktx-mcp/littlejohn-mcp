export const tokenCatalogErrorDefinitions = Object.freeze([
  {
    code: "token_registration_already_exists",
    category: "state",
    message: "The token is already registered for the current account.",
    retryable: false,
  },
  {
    code: "token_registration_not_found",
    category: "state",
    message: "The token is not registered for the current account.",
    retryable: false,
  },
  {
    code: "token_registration_revision_changed",
    category: "state",
    message: "The token registration changed before the request completed.",
    retryable: false,
  },
  {
    code: "token_total_supply_reverted",
    category: "domain",
    message: "The token contract reverted the required totalSupply call.",
    retryable: false,
  },
  {
    code: "token_operation_conflict",
    category: "state",
    message: "Another token catalog operation is active.",
    retryable: false,
  },
  {
    code: "token_operation_not_found",
    category: "state",
    message: "The token catalog operation is not available.",
    retryable: false,
  },
  {
    code: "token_operation_expired",
    category: "state",
    message: "The token catalog operation expired before confirmation.",
    retryable: false,
  },
] as const);

export const tokenCatalogInterfaceErrorMappingDefinitions = Object.freeze([
  { code: "token_registration_already_exists", httpStatus: 409, problemTitle: "Token already registered", cliExitCode: 5 },
  { code: "token_registration_not_found", httpStatus: 404, problemTitle: "Token registration not found", cliExitCode: 3 },
  { code: "token_registration_revision_changed", httpStatus: 409, problemTitle: "Token registration changed", cliExitCode: 5 },
  { code: "token_total_supply_reverted", httpStatus: 422, problemTitle: "Token total supply reverted", cliExitCode: 3 },
  { code: "token_operation_conflict", httpStatus: 409, problemTitle: "Token operation conflict", cliExitCode: 5 },
  { code: "token_operation_not_found", httpStatus: 404, problemTitle: "Token operation not found", cliExitCode: 3 },
  { code: "token_operation_expired", httpStatus: 409, problemTitle: "Token operation expired", cliExitCode: 5 },
] as const);
