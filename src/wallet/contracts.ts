import {
  type WalletInteractionInterface,
  type WalletOperationKind,
} from "./operation-state.js";
import type {
  WalletManagementOperation,
  WalletCurrentOperationProjection,
  WalletOperationConfirmation,
  WalletOperationCreate,
  WalletOperationStartResponse,
  WalletOperationStartResult,
  WalletOperationResponse,
  WalletOperationPresentation,
  WalletWebOperationCreate,
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

export interface WalletLocalControlOperationPort {
  start(input: WalletOperationCreate): Promise<WalletOperationStartResponse>;
  get(operationId: string): Promise<WalletOperationResponse>;
  cancel(operationId: string): Promise<WalletOperationResponse>;
}

export interface WalletWebOperationPort {
  start(input: WalletWebOperationCreate): Promise<WalletOperationStartResult>;
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
  ): Promise<InteractionInterface extends "cli" ? WalletOperationResponse : WalletManagementOperation>;
}

export interface WalletOperationPresentationPort {
  get(operationId: string): Promise<WalletOperationPresentation>;
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
