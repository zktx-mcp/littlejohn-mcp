import {captureCanonicalJson} from "../core/index.js";
import {walletAccountToolContracts} from "./wallet-account-tool-contracts.js";
import {walletAccountSelectionContracts} from "../wallet/account-selection-contract.js";
import {walletInterfaceErrorMappings} from "../wallet/errors.js";
import {createLocalOperationIdentity, type LocalSelectorBinding} from "./local-operation.js";

export const walletAccountResources = Object.freeze({
  selection: "/api/v1/internal/control/wallet/account-selections",
  decisions: "/api/v1/internal/control/wallet/account-selections/decisions",
});
const read = walletAccountSelectionContracts.get;
const select = walletAccountSelectionContracts.select;
export const walletAccountSelectionIdentity = createLocalOperationIdentity({
  action: "read", contract: read, errorMappings: walletInterfaceErrorMappings,
  operationId: () => undefined,
  actionRequest: (input: ReturnType<typeof read.parseInput>) => ({method: "POST", path: walletAccountResources.selection, body: captureCanonicalJson(input)}),
  parseActionResponse: (input, _id, value) => read.parsePublicSuccess(input, value),
});
const selectionBinding: LocalSelectorBinding<ReturnType<typeof select.parseInput>, ReturnType<typeof select.parsePublicSuccess>> = {
  action: "select_account", contract: select, errorMappings: walletInterfaceErrorMappings,
  operationId: () => undefined,
  actionRequest: (input) => ({method: "POST", path: walletAccountResources.decisions, body: captureCanonicalJson(input)}),
  parseActionResponse: (input, _id, value) => select.parsePublicSuccess(input, value),
  selector: (input) => ({selector: input, cardId: null}),
};
export const walletSelectAccountIdentity = createLocalOperationIdentity(selectionBinding);

export const walletAccountBindings = Object.freeze({
  get: Object.freeze({...walletAccountToolContracts.get, identity: walletAccountSelectionIdentity}),
  select: Object.freeze({...walletAccountToolContracts.select, identity: walletSelectAccountIdentity}),
});
