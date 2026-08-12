import type {
  WalletDirectAction,
  WalletManagementOperation,
  WalletNonterminalManagementOperation,
  WalletOperationCancellation,
  WalletOperationPresentation,
  WalletReviewRequest,
  WalletReviewResult,
} from "./operation-contract.js";

export * from "./operation-contract.js";
export {
  walletManagementCapabilityIdList,
  walletManagementContractList,
  walletManagementContracts,
} from "./management-contracts.js";
export type {
  AnyWalletManagementContract,
  WalletManagementContractDefinition,
} from "./management-contracts.js";

export interface WalletOperationTransitionCommand {
  readonly operationId: WalletManagementOperation["operationId"];
  readonly reviewDigest: WalletManagementOperation["review"]["reviewDigest"];
  readonly expectedState: WalletNonterminalManagementOperation["state"];
  readonly connectionRevision: WalletManagementOperation["review"]["precondition"]["connectionRevision"];
  readonly operation: WalletManagementOperation;
}

export interface WalletOperationStore {
  read(operationId: WalletManagementOperation["operationId"]): WalletManagementOperation | null;
  readActive(): WalletNonterminalManagementOperation | null;
  create(operation: WalletNonterminalManagementOperation): WalletNonterminalManagementOperation;
  transition(command: WalletOperationTransitionCommand): WalletManagementOperation;
}

export interface WalletManagementPort {
  review(input: WalletReviewRequest): Promise<WalletReviewResult>;
  decide(input: WalletDirectAction): Promise<WalletManagementOperation>;
  get(operationId: WalletManagementOperation["operationId"]): Promise<WalletManagementOperation>;
  cancel(input: WalletOperationCancellation): Promise<WalletManagementOperation>;
  getPresentation(
    operationId: WalletManagementOperation["operationId"],
  ): Promise<WalletOperationPresentation>;
}
