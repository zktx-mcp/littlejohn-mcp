export const tokenCatalogOperationKinds = Object.freeze([
  "add",
  "remove",
] as const);

export type TokenCatalogOperationKind = typeof tokenCatalogOperationKinds[number];

export const tokenCatalogOperationStates = Object.freeze([
  "completed",
] as const);

export type TokenCatalogOperationState = typeof tokenCatalogOperationStates[number];

export const tokenCatalogInitiators = Object.freeze(["cli", "mcp_app"] as const);
export type TokenCatalogInitiator = typeof tokenCatalogInitiators[number];

export const isTokenCatalogOperationTerminal = (state: TokenCatalogOperationState): boolean =>
  state === "completed";
