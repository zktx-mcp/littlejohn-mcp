import { type ApplicationFailure, type EvmAccountIdentity } from "../core/index.js";
import { captureConnectedWalletSession } from "./active-wallet.js";
import {
  tokenCatalogApplicationContracts,
  type AnyTokenCatalogApplicationContract,
  type TokenRegistration,
} from "./contracts.js";
import { TokenCatalogOperationError, normalizeTokenCatalogError } from "./operation-error.js";
import type {
  TokenCatalogApplicationDependencies,
  TokenCatalogApplicationPort,
  TokenCatalogOperationCoordinatorPort,
} from "./ports.js";
import type { TokenCatalogInteractionInterface } from "./state.js";

const invalidInput = (): ApplicationFailure => new TokenCatalogOperationError("invalid_input").failure;
const internalFailure = (): ApplicationFailure => new TokenCatalogOperationError("internal_error").failure;

const normalizedFailure = (
  contract: AnyTokenCatalogApplicationContract,
  value: unknown,
): ApplicationFailure => {
  try { return contract.parseFailure(value); }
  catch {
    try { return contract.parseFailure(normalizeTokenCatalogError(value).failure); }
    catch { /* An inherited but undeclared failure cannot cross this contract. */ }
    return contract.parseFailure(internalFailure());
  }
};

const requireAccountAsset = (
  dependencies: TokenCatalogApplicationDependencies,
  asset: TokenRegistration["asset"],
): EvmAccountIdentity => {
  const { account } = captureConnectedWalletSession(dependencies.activeWallet);
  if (account.chainId !== asset.chainId) throw new TokenCatalogOperationError("invalid_input");
  return account;
};

const sameAccount = (left: EvmAccountIdentity, right: EvmAccountIdentity): boolean =>
  left.chainId === right.chainId && left.address === right.address;

const requireInteractionInterface = <Result extends Readonly<{
  operation: Readonly<{ interactionInterface: TokenCatalogInteractionInterface }>;
}>>(interactionInterface: TokenCatalogInteractionInterface, result: Result): Result => {
  if (result.operation.interactionInterface !== interactionInterface) {
    throw new TokenCatalogOperationError("internal_error");
  }
  return result;
};

export const createTokenCatalogApplication = (input: Readonly<{
  dependencies: TokenCatalogApplicationDependencies;
  operations: TokenCatalogOperationCoordinatorPort;
}>): TokenCatalogApplicationPort => {
  const application: TokenCatalogApplicationPort = {
    getRegistration(inputValue) {
      const contract = tokenCatalogApplicationContracts.registration;
      let request;
      try { request = contract.parseInput(inputValue); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        const account = requireAccountAsset(input.dependencies, request.asset);
        const registration = input.dependencies.store.getRegistration(account, request.asset);
        if (registration === undefined) throw new TokenCatalogOperationError("token_registration_not_found");
        const result = contract.parseSuccess(request, registration);
        if (!sameAccount(account, result.registration.account)) {
          throw new TokenCatalogOperationError("internal_error");
        }
        return result;
      } catch (error) {
        return normalizedFailure(contract, error);
      }
    },

    listRegistrations(inputValue) {
      const contract = tokenCatalogApplicationContracts.registrations;
      let request;
      try { request = contract.parseInput(inputValue); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        const { account } = captureConnectedWalletSession(input.dependencies.activeWallet);
        const page = input.dependencies.store.listRegistrations({ account, ...request });
        const result = contract.parseSuccess(request, page);
        if (result.registrations.some((entry) => !sameAccount(account, entry.account))) {
          throw new TokenCatalogOperationError("internal_error");
        }
        return result;
      } catch (error) {
        return normalizedFailure(contract, error);
      }
    },

    async startRegistration(inputValue, interactionInterface: TokenCatalogInteractionInterface) {
      const contract = tokenCatalogApplicationContracts.startRegistration;
      let request;
      try { request = contract.parseInput(inputValue); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        const result = await input.operations.startRegistration(request, interactionInterface);
        if ("ok" in result && result.ok === false) return normalizedFailure(contract, result);
        return requireInteractionInterface(
          interactionInterface,
          contract.parseSuccess(request, result),
        );
      } catch (error) { return normalizedFailure(contract, error); }
    },

    async startRegistrationUpdate(inputValue, interactionInterface: TokenCatalogInteractionInterface) {
      const contract = tokenCatalogApplicationContracts.startRegistrationUpdate;
      let request;
      try { request = contract.parseInput(inputValue); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        const result = await input.operations.startRegistrationUpdate(request, interactionInterface);
        if ("ok" in result && result.ok === false) return normalizedFailure(contract, result);
        return requireInteractionInterface(
          interactionInterface,
          contract.parseSuccess(request, result),
        );
      } catch (error) { return normalizedFailure(contract, error); }
    },

    async startUnregistration(inputValue, interactionInterface: TokenCatalogInteractionInterface) {
      const contract = tokenCatalogApplicationContracts.startUnregistration;
      let request;
      try { request = contract.parseInput(inputValue); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        const result = await input.operations.startUnregistration(request, interactionInterface);
        if ("ok" in result && result.ok === false) return normalizedFailure(contract, result);
        return requireInteractionInterface(
          interactionInterface,
          contract.parseSuccess(request, result),
        );
      } catch (error) { return normalizedFailure(contract, error); }
    },

    getOperation(inputValue) {
      const contract = tokenCatalogApplicationContracts.operation;
      let request;
      try { request = contract.parseInput(inputValue); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        return contract.parseSuccess(request, {
          operation: input.operations.getOperation(request.operationId),
        });
      } catch (error) { return normalizedFailure(contract, error); }
    },

    async cancelOperation(inputValue) {
      const contract = tokenCatalogApplicationContracts.cancelOperation;
      let request;
      try { request = contract.parseInput(inputValue); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        return contract.parseSuccess(request, {
          operation: await input.operations.cancel(request.operationId),
        });
      } catch (error) { return normalizedFailure(contract, error); }
    },
  };
  return Object.freeze(application);
};
