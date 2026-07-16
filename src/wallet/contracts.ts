import {
  type WalletInteractionInterface,
  type WalletOperationKind,
} from "./operation-state.js";
import type {
  WalletManagementOperation,
  WalletOperationConfirmation,
  WalletOperationCreate,
  WalletOperationResponse,
  WalletOperationPresentation,
} from "./operation-contract.js";

export * from "./operation-contract.js";
export const walletManagementCapabilityIds = Object.freeze({
  cancelOperation: "wallet.cancel_operation",
  connect: "wallet.connect",
  disconnect: "wallet.disconnect",
  operation: "wallet.operation",
} as const);
export const walletManagementCapabilityIdList = Object.freeze(
  Object.values(walletManagementCapabilityIds),
);

export interface WalletLocalControlOperationPort {
  start(input: WalletOperationCreate): Promise<WalletOperationResponse>;
  get(operationId: string): Promise<WalletOperationResponse>;
  cancel(operationId: string): Promise<WalletOperationResponse>;
}

export interface WalletWebOperationPort {
  start(kind: WalletOperationKind): Promise<WalletManagementOperation>;
  get(operationId: string): Promise<WalletManagementOperation>;
  cancel(operationId: string): Promise<WalletManagementOperation>;
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

export interface WalletInterfaceOperations {
  readonly operation: WalletWebOperationPort;
  readonly confirmation: WalletOperationConfirmationPort<"web">;
  readonly presentation: WalletOperationPresentationPort;
}
