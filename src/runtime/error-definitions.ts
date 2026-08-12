import { productDisplayName } from "../core/client.js";

export const runtimeStateUnavailableErrorDefinition = Object.freeze({
  code: "runtime_state_unavailable",
  category: "runtime",
  message: "Local runtime state is unavailable.",
  retryable: false,
} as const);

export const stateConflictErrorDefinition = Object.freeze({
  code: "state_conflict",
  category: "state",
  message: "Local state changed before the request completed.",
  retryable: false,
} as const);

export const runtimeErrorDefinitions = Object.freeze([
  { code: "invalid_json", category: "transport", message: "The request body is not valid JSON.", retryable: false },
  { code: "query_not_supported", category: "transport", message: "Query parameters are not supported.", retryable: false },
  { code: "payload_too_large", category: "transport", message: "The request body exceeds the allowed size.", retryable: false },
  { code: "content_type_unsupported", category: "transport", message: "The request content type is not supported.", retryable: false },
  { code: "invalid_host", category: "security", message: "The request host is not allowed.", retryable: false },
  { code: "invalid_origin", category: "security", message: "The request origin is not allowed.", retryable: false },
  { code: "unauthorized", category: "security", message: "The request is not authorized.", retryable: false },
  { code: "route_not_found", category: "transport", message: "The requested route does not exist.", retryable: false },
  { code: "method_not_allowed", category: "transport", message: "The HTTP method is not allowed for this route.", retryable: false },
  stateConflictErrorDefinition,
  { code: "port_conflict", category: "runtime", message: `The fixed ${productDisplayName} port is owned by an incompatible process.`, retryable: false },
  { code: "runtime_busy", category: "runtime", message: "The local runtime is busy.", retryable: true },
  runtimeStateUnavailableErrorDefinition,
  { code: "request_aborted", category: "transport", message: "The request ended before completion.", retryable: true },
] as const);

export const runtimeInterfaceErrorMappingDefinitions = Object.freeze([
  { code: "invalid_input", httpStatus: 400, problemTitle: "Invalid request", cliExitCode: 2 },
  { code: "internal_error", httpStatus: 500, problemTitle: "Internal error", cliExitCode: 1 },
  { code: "invalid_json", httpStatus: 400, problemTitle: "Invalid JSON", cliExitCode: 2 },
  { code: "query_not_supported", httpStatus: 400, problemTitle: "Query not supported", cliExitCode: 2 },
  { code: "payload_too_large", httpStatus: 413, problemTitle: "Payload too large", cliExitCode: 2 },
  { code: "content_type_unsupported", httpStatus: 415, problemTitle: "Unsupported content type", cliExitCode: 2 },
  { code: "invalid_host", httpStatus: 400, problemTitle: "Invalid host", cliExitCode: 6 },
  { code: "invalid_origin", httpStatus: 403, problemTitle: "Invalid origin", cliExitCode: 6 },
  { code: "unauthorized", httpStatus: 401, problemTitle: "Unauthorized", cliExitCode: 6 },
  { code: "route_not_found", httpStatus: 404, problemTitle: "Route not found", cliExitCode: 3 },
  { code: "method_not_allowed", httpStatus: 405, problemTitle: "Method not allowed", cliExitCode: 2 },
  { code: "state_conflict", httpStatus: 409, problemTitle: "State conflict", cliExitCode: 5 },
  { code: "port_conflict", httpStatus: 409, problemTitle: "Port conflict", cliExitCode: 7 },
  { code: "runtime_busy", httpStatus: 503, problemTitle: "Runtime busy", cliExitCode: 4 },
  { code: "runtime_state_unavailable", httpStatus: 500, problemTitle: "Runtime state unavailable", cliExitCode: 7 },
  { code: "request_aborted", httpStatus: 408, problemTitle: "Request aborted", cliExitCode: 4 },
  { code: "result_too_large", httpStatus: 422, problemTitle: "Result too large", cliExitCode: 3 },
] as const);
