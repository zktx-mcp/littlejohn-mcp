export const tokenCatalogOperationKinds = Object.freeze([
  "register",
  "unregister",
] as const);

export type TokenCatalogOperationKind = typeof tokenCatalogOperationKinds[number];

export const tokenCatalogOperationStates = Object.freeze([
  "applying",
  "awaiting_confirmation",
  "cancelled",
  "completed",
  "expired",
  "failed",
] as const);

export type TokenCatalogOperationState = typeof tokenCatalogOperationStates[number];

export const tokenCatalogInteractionInterfaces = Object.freeze(["cli", "web"] as const);
export type TokenCatalogInteractionInterface = typeof tokenCatalogInteractionInterfaces[number];

export const isTokenCatalogOperationTerminal = (state: TokenCatalogOperationState): boolean =>
  state === "cancelled" || state === "completed" || state === "expired" || state === "failed";
