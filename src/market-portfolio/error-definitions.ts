export const referenceMarketErrorDefinitions = Object.freeze([
  {
    code: "watchlist_pair_already_saved",
    category: "state",
    message: "The reference pair is already saved in this watchlist.",
    retryable: false,
  },
  {
    code: "watchlist_full",
    category: "state",
    message: "The reference-pair watchlist is full.",
    retryable: false,
  },
  {
    code: "watchlist_pair_not_found",
    category: "state",
    message: "The reference pair is not saved in this watchlist.",
    retryable: false,
  },
  {
    code: "watchlist_order_conflict",
    category: "state",
    message: "The requested watchlist order does not match the saved pairs.",
    retryable: false,
  },
  {
    code: "watchlist_operation_not_found",
    category: "state",
    message: "The reference-watchlist operation does not exist.",
    retryable: false,
  },
  {
    code: "watchlist_review_expired",
    category: "state",
    message: "The reference-watchlist Review expired before a decision.",
    retryable: false,
  },
] as const);

export const referenceMarketInterfaceErrorMappingDefinitions = Object.freeze([
  { code: "watchlist_pair_already_saved", httpStatus: 409, problemTitle: "Pair already saved", cliExitCode: 5 },
  { code: "watchlist_full", httpStatus: 409, problemTitle: "Watchlist full", cliExitCode: 5 },
  { code: "watchlist_pair_not_found", httpStatus: 409, problemTitle: "Pair not saved", cliExitCode: 5 },
  { code: "watchlist_order_conflict", httpStatus: 409, problemTitle: "Watchlist order conflict", cliExitCode: 5 },
  { code: "watchlist_operation_not_found", httpStatus: 404, problemTitle: "Watchlist operation not found", cliExitCode: 3 },
  { code: "watchlist_review_expired", httpStatus: 409, problemTitle: "Watchlist Review expired", cliExitCode: 5 },
] as const);
