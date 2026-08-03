import {
  type WalletInteractionInterface,
  type WalletOperationKind,
} from "./operation-state.js";
import type {
  WalletManagementOperation,
  WalletCurrentOperationProjection,
  WalletOperationCancellation,
  WalletOperationConfirmation,
  WalletOperationCreate,
  WalletOperationStartResult,
  WalletOperationPresentation,
  WalletWebOperationCreate,
} from "./operation-contract.js";

export * from "./operation-contract.js";
export {
  walletManagementCapabilityIdList,
  walletManagementContractList,
  walletManagementContracts,
  walletOperationConfirmationContract,
} from "./management-contracts.js";
export type {
  AnyWalletManagementContract,
  WalletManagementContractDefinition,
} from "./management-contracts.js";

export interface WalletLocalControlOperationPort {
  start(input: WalletOperationCreate): Promise<WalletOperationStartResult>;
  get(operationId: string): Promise<WalletManagementOperation>;
  cancel(input: WalletOperationCancellation): Promise<WalletManagementOperation>;
}

export interface WalletWebOperationPort {
  start(input: WalletWebOperationCreate, operationId: string): Promise<WalletOperationStartResult>;
  cancel(
    operationId: string,
    input: WalletOperationConfirmation,
  ): Promise<WalletManagementOperation>;
}

export interface WalletOperationConfirmationPort<
  InteractionInterface extends WalletInteractionInterface,
> {
  readonly interactionInterface: InteractionInterface;
  confirm(
    operationId: string,
    input: WalletOperationConfirmation,
  ): Promise<WalletManagementOperation>;
}

export interface WalletOperationPresentationPort {
  get(
    operationId: string,
    interactionInterface: WalletInteractionInterface,
  ): Promise<WalletOperationPresentation>;
}

export interface WalletCurrentOperationProjectionPort {
  get(): Promise<WalletCurrentOperationProjection>;
}

export interface WalletInterfaceOperations {
  readonly operation: WalletWebOperationPort;
  readonly confirmation: WalletOperationConfirmationPort<"web">;
  readonly presentation: WalletOperationPresentationPort;
  readonly currentProjection: WalletCurrentOperationProjectionPort;
}
