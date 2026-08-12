import { tokenInspectCapability } from "../../src/token-catalog/contracts.js";
import { tokenCatalogErrorRegistry } from "../../src/token-catalog/errors.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import type {
  AccountTokenSelectionReadPort,
  TokenCatalogInspectionPort,
  TokenCatalogManagementApplicationPort,
  TokenCatalogQueryApplicationPort,
} from "../../src/token-catalog/ports.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";

const failure = (code: string) => new TokenCatalogOperationError(code).failure;

export interface TokenCatalogInterfaceHarnessPorts {
  readonly accountTokenSelectionRead: AccountTokenSelectionReadPort;
  readonly tokenInspection: TokenCatalogInspectionPort;
  readonly tokenCatalogQueries: TokenCatalogQueryApplicationPort;
  readonly tokenCatalogManagement: TokenCatalogManagementApplicationPort;
}

export const tokenCatalogInterfaceHarnessPorts = (): TokenCatalogInterfaceHarnessPorts => {
  const tokenInspection = bindForHarness(
    tokenInspectCapability,
    createCapabilityHarness(),
    async () => ({ status: "failure", code: "internal_error", issues: [] }),
    tokenCatalogErrorRegistry,
  );
  return Object.freeze({
    tokenInspection,
    accountTokenSelectionRead: Object.freeze({
      getState: () => undefined,
      getForAccount: () => undefined,
      listIncludedForAccount: () => Object.freeze({ selections: [], nextCursor: null }),
    }),
    tokenCatalogQueries: Object.freeze({
      getSelection: () => failure("token_selection_not_found"),
      listSelections: () => Object.freeze({ selections: [], nextCursor: null }),
    }),
    tokenCatalogManagement: Object.freeze({
      review: async () => failure("internal_error"),
      decide: async () => failure("internal_error"),
      getOperation: () => failure("token_operation_not_found"),
    }),
  });
};
