const invalidInputErrorDefinition = Object.freeze({
  code: "invalid_input",
  category: "input",
  message: "The request input is invalid.",
  retryable: false,
} as const);

export const internalErrorDefinition = Object.freeze({
  code: "internal_error",
  category: "internal",
  message: "The request could not be completed.",
  retryable: false,
} as const);

export const coreErrorDefinitions = Object.freeze([
  invalidInputErrorDefinition,
  internalErrorDefinition,
] as const);
