import { tokenInspectCapability } from "../../src/token-catalog/contracts.js";
import { tokenCatalogErrorRegistry } from "../../src/token-catalog/errors.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import type {
  TokenCatalogBrowserOperationPort,
  TokenCatalogInspectionPort,
  TokenCatalogInteractiveCliPort,
  TokenCatalogNonInteractiveOperationPort,
  TokenCatalogQueryApplicationPort,
  TokenCatalogWebStartPort,
} from "../../src/token-catalog/ports.js";
import { bindForHarness, createCapabilityHarness } from "../core/capability-harness.js";

const failure = (code: string) => new TokenCatalogOperationError(code).failure;

export interface TokenCatalogInterfaceHarnessPorts {
  readonly tokenInspection: TokenCatalogInspectionPort;
  readonly tokenCatalogQueries: TokenCatalogQueryApplicationPort;
  readonly tokenCatalogWebStart: TokenCatalogWebStartPort;
  readonly tokenCatalogBrowserOperations: TokenCatalogBrowserOperationPort;
  readonly tokenCatalogInteractiveCli: TokenCatalogInteractiveCliPort;
  readonly tokenCatalogNonInteractiveOperations: TokenCatalogNonInteractiveOperationPort;
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
    tokenCatalogQueries: Object.freeze({
      getRegistration: () => failure("token_registration_not_found"),
      listRegistrations: () => Object.freeze({ registrations: [], nextCursor: null }),
    }),
    tokenCatalogWebStart: Object.freeze({
      interactionInterface: "web",
      startRegistration: async () => failure("internal_error"),
      startRegistrationUpdate: async () => failure("internal_error"),
      startUnregistration: async () => failure("internal_error"),
    }),
    tokenCatalogBrowserOperations: Object.freeze({
      interactionInterface: "web",
      getOperation: () => failure("token_operation_not_found"),
      getCurrentOperation: () => null,
      confirm: async () => { throw new TokenCatalogOperationError("token_operation_not_found"); },
      cancel: async () => { throw new TokenCatalogOperationError("token_operation_not_found"); },
    }),
    tokenCatalogInteractiveCli: Object.freeze({
      interactionInterface: "cli",
      startRegistration: async () => failure("internal_error"),
      startRegistrationUpdate: async () => failure("internal_error"),
      startUnregistration: async () => failure("internal_error"),
      confirm: async () => { throw new TokenCatalogOperationError("token_operation_not_found"); },
    }),
    tokenCatalogNonInteractiveOperations: Object.freeze({
      getOperation: () => failure("token_operation_not_found"),
      cancelOperation: async () => failure("token_operation_not_found"),
    }),
  });
};
