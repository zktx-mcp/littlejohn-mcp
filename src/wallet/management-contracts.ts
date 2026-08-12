import { z, type ZodType } from "zod";

import {
  capabilityIdSchema,
  compareCodePointSequences,
  coreErrorDefinitions,
  defineApplicationContract,
  type ApplicationContract,
  type CapabilityId,
} from "../core/client.js";
import { runtimeErrorDefinitions } from "../runtime/error-definitions.js";
import { walletErrorDefinitions } from "./error-definitions.js";
import { walletErrorRegistry } from "./error-registry.js";
import {
  walletDirectActionSchema,
  walletManagementOperationSchema,
  walletOperationCancellationSchema,
  walletOperationInputSchema,
  walletReviewRequestSchema,
  walletReviewResultSchema,
  type WalletDirectAction,
  type WalletManagementOperation,
  type WalletOperationCancellation,
  type WalletOperationInput,
  type WalletReviewRequest,
  type WalletReviewResult,
} from "./operation-contract.js";
import type { WalletOperationKind } from "./operation-state.js";

const selectedFailureCodes = new Set([
  "internal_error",
  "invalid_input",
  "port_conflict",
  "request_aborted",
  "runtime_busy",
  "runtime_state_unavailable",
  "state_conflict",
  "wallet_operation_expired",
  "wallet_operation_not_found",
  "wallet_session_unusable",
  "wallet_timeout",
]);

const walletManagementFailureCodes = Object.freeze([
  ...coreErrorDefinitions,
  ...runtimeErrorDefinitions,
  ...walletErrorDefinitions,
]
  .filter((definition) => selectedFailureCodes.has(definition.code))
  .map((definition) => definition.code)
  .sort(compareCodePointSequences));

if (
  walletManagementFailureCodes.length !== selectedFailureCodes.size ||
  new Set(walletManagementFailureCodes).size !== walletManagementFailureCodes.length
) throw new TypeError("Wallet management failure-code authority is incomplete.");

export interface WalletManagementContractDefinition<Input, Success> {
  readonly capabilityId: CapabilityId;
  readonly contractVersion: "1";
  readonly inputSchema: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly failureCodes: readonly string[];
  readonly applicationContract: ApplicationContract<Input, Record<string, never>, Success>;
  parseInput(value: unknown): Input;
  parsePublicSuccess(input: unknown, value: unknown): Success;
  parseBoundSuccess(input: unknown, context: unknown, value: unknown): Success;
  parseFailure(value: unknown): import("../core/client.js").ApplicationFailure;
  normalizeFailure(value: unknown): import("../core/client.js").ApplicationFailure;
}

const internalContextSchema = z.object({}).strict();

const defineWalletManagementContract = <Input, Success>(input: {
  readonly capabilityId: string;
  readonly inputSchema: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly validatePublicSuccess?: (input: Input, success: Success) => void;
}): WalletManagementContractDefinition<Input, Success> => {
  const capabilityId = capabilityIdSchema.parse(input.capabilityId);
  const applicationContract = defineApplicationContract({
    contractVersion: "1",
    inputSchema: input.inputSchema,
    successSchema: input.successSchema,
    internalContextSchema,
    errorRegistry: walletErrorRegistry,
    failureCodes: walletManagementFailureCodes,
    ...(input.validatePublicSuccess === undefined ? {} : {
      validatePublicSuccess: input.validatePublicSuccess,
    }),
  });
  return Object.freeze({
    capabilityId,
    contractVersion: applicationContract.contractVersion,
    inputSchema: input.inputSchema,
    successSchema: input.successSchema,
    failureCodes: applicationContract.failureCodes,
    applicationContract,
    parseInput: applicationContract.parseInput,
    parsePublicSuccess: applicationContract.parsePublicSuccess,
    parseBoundSuccess: applicationContract.parseBoundSuccess,
    parseFailure: applicationContract.parseFailure,
    normalizeFailure: applicationContract.normalizeFailure,
  });
};

type WalletActionForKind<Kind extends WalletOperationKind> = WalletDirectAction & {
  readonly review: Extract<WalletDirectAction["review"], { readonly kind: Kind }>;
};
type WalletOperationForKind<Kind extends WalletOperationKind> = Extract<
  WalletManagementOperation,
  { readonly kind: Kind }
>;

const actionSchemaFor = <Kind extends WalletOperationKind>(kind: Kind) =>
  walletDirectActionSchema.refine(
    (action): action is WalletActionForKind<Kind> => action.review.kind === kind,
    `Wallet action must carry a ${kind} Review.`,
  ) as ZodType<WalletActionForKind<Kind>>;

const operationSchemaFor = <Kind extends WalletOperationKind>(kind: Kind) =>
  walletManagementOperationSchema.refine(
    (operation): operation is WalletOperationForKind<Kind> => operation.kind === kind,
    `Wallet operation must be ${kind}.`,
  ) as ZodType<WalletOperationForKind<Kind>>;

const validateActionOperation = <Kind extends WalletOperationKind>(
  input: WalletActionForKind<Kind>,
  operation: WalletOperationForKind<Kind>,
): void => {
  if (
    operation.operationId !== input.review.operationId ||
    operation.review.reviewDigest !== input.review.reviewDigest
  ) throw new TypeError("Wallet operation does not match its direct action.");
};

export const walletManagementContracts = Object.freeze({
  review: defineWalletManagementContract<WalletReviewRequest, WalletReviewResult>({
    capabilityId: "wallet.connection_change_review",
    inputSchema: walletReviewRequestSchema,
    successSchema: walletReviewResultSchema,
    validatePublicSuccess: (input, success) => {
      if (success.status === "review" && success.review.kind !== input.kind) {
        throw new TypeError("Wallet Review does not match its request.");
      }
      if (
        input.kind === "connect" && success.status === "already_disconnected" ||
        input.kind === "disconnect" && success.status === "current_connection"
      ) throw new TypeError("Wallet Review no-op result does not match its request.");
    },
  }),
  connect: defineWalletManagementContract({
    capabilityId: "wallet.connect",
    inputSchema: actionSchemaFor("connect"),
    successSchema: operationSchemaFor("connect"),
    validatePublicSuccess: validateActionOperation,
  }),
  disconnect: defineWalletManagementContract({
    capabilityId: "wallet.disconnect",
    inputSchema: actionSchemaFor("disconnect"),
    successSchema: operationSchemaFor("disconnect"),
    validatePublicSuccess: validateActionOperation,
  }),
  operation: defineWalletManagementContract<WalletOperationInput, WalletManagementOperation>({
    capabilityId: "wallet.operation",
    inputSchema: walletOperationInputSchema,
    successSchema: walletManagementOperationSchema,
    validatePublicSuccess: (input, success) => {
      if (success.operationId !== input.operationId) {
        throw new TypeError("Wallet operation does not match its request.");
      }
    },
  }),
  cancelOperation: defineWalletManagementContract<WalletOperationCancellation, WalletManagementOperation>({
    capabilityId: "wallet.cancel_operation",
    inputSchema: walletOperationCancellationSchema,
    successSchema: walletManagementOperationSchema,
    validatePublicSuccess: (input, success) => {
      if (
        success.operationId !== input.operationId ||
        success.review.reviewDigest !== input.reviewDigest ||
        success.review.precondition.connectionRevision !== input.connectionRevision
      ) throw new TypeError("Wallet cancellation result does not match its request.");
    },
  }),
});

export type AnyWalletManagementContract =
  typeof walletManagementContracts[keyof typeof walletManagementContracts];

export const walletManagementContractList = Object.freeze(
  Object.values(walletManagementContracts),
);

export const walletManagementCapabilityIdList = Object.freeze(
  walletManagementContractList.map((contract) => contract.capabilityId),
);
