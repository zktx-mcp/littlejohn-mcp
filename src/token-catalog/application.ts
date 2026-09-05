import { type ApplicationFailure, type EvmAccountIdentity } from "../core/index.js";
import { requireAvailableAddressTarget } from "../chain/address-target.js";
import {
  tokenCatalogApplicationContracts,
  type AnyTokenCatalogApplicationContract,
  type TokenSelection,
} from "./contracts.js";
import { TokenCatalogOperationError, normalizeTokenCatalogError } from "./operation-error.js";
import type {
  TokenCatalogApplicationDependencies,
  TokenCatalogApplicationPort,
  TokenCatalogOperationCoordinatorPort,
} from "./ports.js";

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
  target: Parameters<TokenCatalogApplicationDependencies["addressTargets"]["resolve"]>[0],
  asset: TokenSelection["asset"],
): EvmAccountIdentity => {
  const { account } = requireAvailableAddressTarget(
    dependencies.addressTargets.resolve(target),
  );
  if (account.chainId !== asset.chainId) throw new TokenCatalogOperationError("invalid_input");
  return account;
};

const sameAccount = (left: EvmAccountIdentity, right: EvmAccountIdentity): boolean =>
  left.chainId === right.chainId && left.address === right.address;

export const createTokenCatalogApplication = (input: Readonly<{
  dependencies: TokenCatalogApplicationDependencies;
  operations: TokenCatalogOperationCoordinatorPort;
}>): TokenCatalogApplicationPort => {
  const application: TokenCatalogApplicationPort = {
    getSelection(inputValue) {
      const contract = tokenCatalogApplicationContracts.selection;
      let request;
      try { request = contract.parseInput(inputValue); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        const account = requireAccountAsset(input.dependencies, request.account, request.asset);
        const selection = input.dependencies.store.getSelection(account, request.asset);
        if (selection === undefined) throw new TokenCatalogOperationError("token_selection_not_found");
        const result = contract.parsePublicSuccess(request, selection);
        if (!sameAccount(account, result.selection.account)) {
          throw new TokenCatalogOperationError("internal_error");
        }
        return result;
      } catch (error) {
        return normalizedFailure(contract, error);
      }
    },

    listSelections(inputValue) {
      const contract = tokenCatalogApplicationContracts.selections;
      let request;
      try { request = contract.parseInput(inputValue); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        const { account } = requireAvailableAddressTarget(
          input.dependencies.addressTargets.resolve(request.account),
        );
        const page = input.dependencies.store.listSelections({
          account,
          limit: request.limit,
          cursor: request.cursor,
        });
        const result = contract.parsePublicSuccess(request, { account, ...page });
        if (result.selections.some((entry) => !sameAccount(account, entry.account))) {
          throw new TokenCatalogOperationError("internal_error");
        }
        return result;
      } catch (error) {
        return normalizedFailure(contract, error);
      }
    },

    async review(inputValue) {
      const contract = tokenCatalogApplicationContracts.selectionChangeReview;
      let request;
      try { request = contract.parseInput(inputValue); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        const reviewed = await input.operations.review(request);
        return contract.parsePublicSuccess(request, reviewed);
      } catch (error) { return normalizedFailure(contract, error); }
    },

    async decide(inputValue) {
      const contract = inputValue.review.kind === "add"
        ? tokenCatalogApplicationContracts.addSelection
        : tokenCatalogApplicationContracts.removeSelection;
      let request;
      try { request = contract.parseInput(inputValue as never); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        return contract.parsePublicSuccess(
          request as never,
          await input.operations.decide(request) as never,
        );
      } catch (error) { return normalizedFailure(contract, error); }
    },

    getOperation(inputValue) {
      const contract = tokenCatalogApplicationContracts.operation;
      let request;
      try { request = contract.parseInput(inputValue); }
      catch { return contract.parseFailure(invalidInput()); }
      try {
        return contract.parsePublicSuccess(
          request,
          input.operations.getOperation(request.operationId),
        );
      } catch (error) { return normalizedFailure(contract, error); }
    },
  };
  return Object.freeze(application);
};
