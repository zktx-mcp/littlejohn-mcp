import {
  captureCanonicalJson,
  operationIdSchema,
  type CanonicalJson,
  type OperationId,
} from "../core/index.js";
import {
  tokenCatalogApplicationContracts,
  type TokenCatalogOperation,
} from "../token-catalog/client.js";
import {
  tokenCatalogInterfaceErrorMappings,
} from "../token-catalog/errors.js";
import {
  walletManagementContracts,
} from "../wallet/management-contracts.js";
import {
  parseWalletManagementOperation,
  parseWalletOperationPresentation,
  type WalletManagementOperation,
  type WalletOperationPresentation,
} from "../wallet/contracts.js";
import { walletInterfaceErrorMappings } from "../wallet/errors.js";
import {
  createLocalOperationIdentity,
  createLocalOperationRecoveryObservation,
  type LocalOperationIdentity,
} from "./local-operation.js";
import {
  operationCliCommandIdentities,
  operationMcpToolNames,
  operationToolContracts,
  type OperationApplicationContract,
  type OperationCliIdentity,
  type OperationToolAnnotations,
  type OperationToolContract,
  type OperationToolVisibility,
} from "./operation-tool-contracts.js";

export type OperationInterfaceBinding = Readonly<
  Omit<OperationToolContract, "recoveryOperation"> & {
    readonly identity: LocalOperationIdentity;
    readonly recoveryOperation?: OperationInterfaceBinding;
  }
>;

type BoundOperationTool<
  Tool extends OperationToolContract,
  Input,
  Success,
> = Readonly<Omit<Tool, "recoveryOperation"> & {
  readonly identity: LocalOperationIdentity<Input, Success>;
  readonly recoveryOperation?: OperationInterfaceBinding;
}>;

const controlRoot = "/api/v1/internal/control" as const;

const exactOperationPath = (root: string, operationId: unknown): string =>
  `${root}/${operationIdSchema.parse(operationId)}`;

export const operationControlResources = Object.freeze({
  wallet: Object.freeze({
    reviews: `${controlRoot}/wallet/connection-change-reviews`,
    decisions: `${controlRoot}/wallet/connection-decisions`,
    operationPattern: `${controlRoot}/wallet/operations/{operationId}`,
    operation: (operationId: unknown) => exactOperationPath(`${controlRoot}/wallet/operations`, operationId),
    presentationPattern: `${controlRoot}/wallet/operations/{operationId}/presentation`,
    presentation: (operationId: unknown) =>
      `${exactOperationPath(`${controlRoot}/wallet/operations`, operationId)}/presentation`,
    cancellationPattern: `${controlRoot}/wallet/operations/{operationId}/cancellation`,
    cancellation: (operationId: unknown) =>
      `${exactOperationPath(`${controlRoot}/wallet/operations`, operationId)}/cancellation`,
  }),
  tokenSelection: Object.freeze({
    reviews: `${controlRoot}/token-selection/change-reviews`,
    decisions: `${controlRoot}/token-selection/decisions`,
    operationPattern: `${controlRoot}/token-selection/operations/{operationId}`,
    operation: (operationId: unknown) =>
      exactOperationPath(`${controlRoot}/token-selection/operations`, operationId),
  }),
});

const operationIdFromInput = (input: Readonly<{ operationId: OperationId }>): OperationId =>
  operationIdSchema.parse(input.operationId);

const operationIdFromReview = (input: Readonly<{
  review: Readonly<{ operationId: OperationId }>;
}>): OperationId => operationIdSchema.parse(input.review.operationId);

const walletOperationIdentity = createLocalOperationIdentity<
  ReturnType<typeof walletManagementContracts.operation.parseInput>,
  WalletManagementOperation
>({
  action: "read",
  contract: walletManagementContracts.operation.applicationContract,
  errorMappings: walletInterfaceErrorMappings,
  operationId: operationIdFromInput,
  actionRequest: (_input, operationId) => ({
    method: "GET",
    path: operationControlResources.wallet.operation(operationId),
  }),
  parseActionResponse: (input, _operationId, value) =>
    walletManagementContracts.operation.parsePublicSuccess(
      input,
      parseWalletManagementOperation(value),
    ),
});

export const walletOperationPresentationIdentity = createLocalOperationIdentity<
  ReturnType<typeof walletManagementContracts.operation.parseInput>,
  WalletOperationPresentation
>({
  action: "read",
  contract: walletManagementContracts.operation.applicationContract,
  errorMappings: walletInterfaceErrorMappings,
  operationId: operationIdFromInput,
  actionRequest: (_input, operationId) => ({
    method: "GET",
    path: operationControlResources.wallet.presentation(operationId),
  }),
  parseActionResponse: (input, _operationId, value) => {
    const presentation = parseWalletOperationPresentation(value);
    return Object.freeze({
      ...presentation,
      operation: walletManagementContracts.operation.parsePublicSuccess(
        input,
        presentation.operation,
      ),
    });
  },
});

const walletReviewIdentity = createLocalOperationIdentity<
  ReturnType<typeof walletManagementContracts.review.parseInput>,
  ReturnType<typeof walletManagementContracts.review.parsePublicSuccess>
>({
  action: "read",
  contract: walletManagementContracts.review.applicationContract,
  errorMappings: walletInterfaceErrorMappings,
  operationId: () => undefined,
  actionRequest: (input) => ({
    method: "POST",
    path: operationControlResources.wallet.reviews,
    body: captureCanonicalJson(input as unknown as CanonicalJson),
  }),
  parseActionResponse: (input, _operationId, value) =>
    walletManagementContracts.review.parsePublicSuccess(input, value),
});

const walletDecisionIdentity = <Kind extends "connect" | "disconnect">(
  kind: Kind,
) => {
  const contract = walletManagementContracts[kind];
  return createLocalOperationIdentity<
    ReturnType<typeof contract.parseInput>,
    ReturnType<typeof contract.parsePublicSuccess>
  >({
    action: "decide",
    contract: contract.applicationContract,
    errorMappings: walletInterfaceErrorMappings,
    operationId: operationIdFromReview,
    actionRequest: (input) => ({
      method: "POST",
      path: operationControlResources.wallet.decisions,
      body: captureCanonicalJson(input as unknown as CanonicalJson),
    }),
    parseActionResponse: (input, _operationId, value) =>
      contract.parsePublicSuccess(input as never, parseWalletManagementOperation(value) as never),
    recoveryObservation: createLocalOperationRecoveryObservation(
      walletOperationIdentity,
      (input, _operationId, operation) =>
        contract.parsePublicSuccess(input as never, operation as never),
    ),
  });
};

const walletCancellationIdentity = createLocalOperationIdentity<
  ReturnType<typeof walletManagementContracts.cancelOperation.parseInput>,
  WalletManagementOperation
>({
  action: "cancel",
  contract: walletManagementContracts.cancelOperation.applicationContract,
  errorMappings: walletInterfaceErrorMappings,
  operationId: operationIdFromInput,
  actionRequest: (input, operationId) => ({
    method: "POST",
    path: operationControlResources.wallet.cancellation(operationId),
    body: captureCanonicalJson(input as unknown as CanonicalJson),
  }),
  parseActionResponse: (input, _operationId, value) =>
    walletManagementContracts.cancelOperation.parsePublicSuccess(
      input,
      parseWalletManagementOperation(value),
    ),
  recoveryObservation: createLocalOperationRecoveryObservation(
    walletOperationIdentity,
    (input, _operationId, operation) =>
      walletManagementContracts.cancelOperation.parsePublicSuccess(input, operation),
  ),
});

const tokenOperationIdentity = createLocalOperationIdentity<
  ReturnType<typeof tokenCatalogApplicationContracts.operation.parseInput>,
  TokenCatalogOperation
>({
  action: "read",
  contract: tokenCatalogApplicationContracts.operation.applicationContract,
  errorMappings: tokenCatalogInterfaceErrorMappings,
  operationId: operationIdFromInput,
  actionRequest: (_input, operationId) => ({
    method: "GET",
    path: operationControlResources.tokenSelection.operation(operationId),
  }),
  parseActionResponse: (input, _operationId, value) =>
    tokenCatalogApplicationContracts.operation.parsePublicSuccess(input, value),
});

const tokenReviewIdentity = createLocalOperationIdentity<
  ReturnType<typeof tokenCatalogApplicationContracts.selectionChangeReview.parseInput>,
  ReturnType<typeof tokenCatalogApplicationContracts.selectionChangeReview.parsePublicSuccess>
>({
  action: "read",
  contract: tokenCatalogApplicationContracts.selectionChangeReview.applicationContract,
  errorMappings: tokenCatalogInterfaceErrorMappings,
  operationId: () => undefined,
  actionRequest: (input) => ({
    method: "POST",
    path: operationControlResources.tokenSelection.reviews,
    body: captureCanonicalJson(input as unknown as CanonicalJson),
  }),
  parseActionResponse: (input, _operationId, value) =>
    tokenCatalogApplicationContracts.selectionChangeReview.parsePublicSuccess(input, value),
});

const tokenDecisionIdentity = <Kind extends "add" | "remove">(kind: Kind) => {
  const contract = kind === "add"
    ? tokenCatalogApplicationContracts.addSelection
    : tokenCatalogApplicationContracts.removeSelection;
  return createLocalOperationIdentity<
    ReturnType<typeof contract.parseInput>,
    ReturnType<typeof contract.parsePublicSuccess>
  >({
    action: "decide",
    contract: contract.applicationContract,
    errorMappings: tokenCatalogInterfaceErrorMappings,
    operationId: operationIdFromReview,
    actionRequest: (input) => ({
      method: "POST",
      path: operationControlResources.tokenSelection.decisions,
      body: captureCanonicalJson(input as unknown as CanonicalJson),
    }),
    parseActionResponse: (input, _operationId, value) =>
      contract.parsePublicSuccess(input as never, value as never),
    recoveryObservation: createLocalOperationRecoveryObservation(
      tokenOperationIdentity,
      (input, _operationId, operation) =>
        contract.parsePublicSuccess(input as never, operation as never),
    ),
  });
};

const binding = <const Tool extends OperationToolContract, Input, Success>(
  tool: Tool,
  identity: LocalOperationIdentity<Input, Success>,
  recoveryOperation?: OperationInterfaceBinding,
): BoundOperationTool<Tool, Input, Success> => Object.freeze({
  action: tool.action,
  contract: tool.contract,
  mcp: tool.mcp,
  ...(tool.cli === undefined ? {} : { cli: tool.cli }),
  identity,
  ...(recoveryOperation === undefined ? {} : { recoveryOperation }),
}) as BoundOperationTool<Tool, Input, Success>;

const walletOperation = binding(
  operationToolContracts.walletOperation,
  walletOperationIdentity,
);
const tokenOperation = binding(
  operationToolContracts.tokenOperation,
  tokenOperationIdentity,
);

export const operationInterfaceBindings = Object.freeze({
  walletReview: binding(operationToolContracts.walletReview, walletReviewIdentity),
  walletConnect: binding(
    operationToolContracts.walletConnect,
    walletDecisionIdentity("connect"),
    walletOperation,
  ),
  walletDisconnect: binding(
    operationToolContracts.walletDisconnect,
    walletDecisionIdentity("disconnect"),
    walletOperation,
  ),
  walletOperation,
  walletCancel: binding(
    operationToolContracts.walletCancel,
    walletCancellationIdentity,
    walletOperation,
  ),
  tokenReview: binding(operationToolContracts.tokenReview, tokenReviewIdentity),
  tokenAdd: binding(
    operationToolContracts.tokenAdd,
    tokenDecisionIdentity("add"),
    tokenOperation,
  ),
  tokenRemove: binding(
    operationToolContracts.tokenRemove,
    tokenDecisionIdentity("remove"),
    tokenOperation,
  ),
  tokenOperation,
} satisfies Readonly<Record<string, OperationInterfaceBinding>>);

export const operationInterfaceBindingList: readonly OperationInterfaceBinding[] = Object.freeze(
  Object.values(operationInterfaceBindings),
);

export {
  operationCliCommandIdentities,
  operationMcpToolNames,
};
export type {
  OperationApplicationContract,
  OperationCliIdentity,
  OperationToolAnnotations,
  OperationToolVisibility,
};
