import { z, type ZodType } from "zod";

import {
  capabilityIdSchema,
  compareCodePointSequences,
  coreErrorDefinitions,
  coreErrorRegistry,
  coreContractVersion,
  defineApplicationContract,
  operationIdSchema,
  type ApplicationContract,
  type CapabilityId,
} from "../core/browser.js";
import { runtimeErrorDefinitions } from "../runtime/error-definitions.js";
import { walletErrorDefinitions } from "./error-definitions.js";
import {
  walletCurrentOperationProjectionSchema,
  walletCurrentConnectionStartResultSchema,
  walletInteractionInterfaceSchema,
  walletManagementOperationSchema,
  walletOperationConfirmationSchema,
  walletOperationIdSchema,
  walletOperationStartedResultSchemaForKind,
  type WalletManagementOperation,
  type WalletOperationStartResult,
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
) {
  throw new TypeError("Wallet management failure-code authority is incomplete.");
}

export interface WalletManagementContractDefinition<Input, Success> {
  readonly capabilityId: CapabilityId;
  readonly contractVersion: typeof coreContractVersion;
  readonly inputSchema: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly failureCodes: readonly string[];
  readonly applicationContract: ApplicationContract<Input, WalletManagementInternalContext, Success>;
  parseInput(value: unknown): Input;
  parsePublicSuccess(input: unknown, value: unknown): Success;
  parseBoundSuccess(input: unknown, context: unknown, value: unknown): Success;
  parseFailure(value: unknown): import("../core/browser.js").ApplicationFailure;
  normalizeFailure(value: unknown): import("../core/browser.js").ApplicationFailure;
}

const walletManagementErrorRegistry = coreErrorRegistry
  .extend(runtimeErrorDefinitions)
  .extend(walletErrorDefinitions);

export const walletManagementInternalContextSchema = z.object({
  operationId: operationIdSchema.optional(),
  interactionInterface: walletInteractionInterfaceSchema.optional(),
}).strict();
export type WalletManagementInternalContext = z.infer<typeof walletManagementInternalContextSchema>;

const defineWalletManagementContract = <Input, Success>(input: {
  readonly capabilityId: string;
  readonly inputSchema: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly validatePublicSuccess?: (input: Input, success: Success) => void;
  readonly validateBoundSuccess?: (
    input: Input,
    context: WalletManagementInternalContext,
    success: Success,
  ) => void;
}): WalletManagementContractDefinition<Input, Success> => {
  const capabilityId = capabilityIdSchema.parse(input.capabilityId);
  const applicationContract = defineApplicationContract({
    inputSchema: input.inputSchema,
    successSchema: input.successSchema,
    internalContextSchema: walletManagementInternalContextSchema,
    errorRegistry: walletManagementErrorRegistry,
    failureCodes: walletManagementFailureCodes,
    ...(input.validatePublicSuccess === undefined ? {} : {
      validatePublicSuccess: input.validatePublicSuccess,
    }),
    ...(input.validateBoundSuccess === undefined ? {} : {
      validateBoundSuccess: input.validateBoundSuccess,
    }),
  });
  return Object.freeze({
    capabilityId,
    contractVersion: coreContractVersion,
    inputSchema: input.inputSchema,
    successSchema: input.successSchema,
    failureCodes: walletManagementFailureCodes,
    applicationContract,
    parseInput: applicationContract.parseInput,
    parsePublicSuccess: applicationContract.parsePublicSuccess,
    parseBoundSuccess: applicationContract.parseBoundSuccess,
    parseFailure: applicationContract.parseFailure,
    normalizeFailure: applicationContract.normalizeFailure,
  });
};

const emptyInputSchema = z.object({}).strict();
const operationInputSchema = z.object({
  operationId: walletOperationIdSchema,
}).strict();
const confirmationInputSchema = z.object({
  operationId: walletOperationIdSchema,
  connectionRevision: walletOperationConfirmationSchema.shape.connectionRevision,
}).strict();

const walletConfirmedOperationSchema = walletManagementOperationSchema.superRefine(
  (operation, context) => {
    if (
      operation.kind !== "disconnect" ||
      !(["disconnecting", "completed", "failed"] as const).includes(
        operation.state as "disconnecting" | "completed" | "failed",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Wallet confirmation did not enter a confirmed disconnection state.",
      });
    }
  },
);

const startResultSchemaFor = (
  kind: WalletOperationKind,
  allowCurrentConnection: boolean,
): ZodType<WalletOperationStartResult> => {
  const started = walletOperationStartedResultSchemaForKind(kind);
  return (allowCurrentConnection
    ? z.discriminatedUnion("status", [walletCurrentConnectionStartResultSchema, started])
    : started) as ZodType<WalletOperationStartResult>;
};

const validateOperationIdentity = (
  input: Readonly<{ operationId: string }>,
  success: WalletManagementOperation,
): void => {
  if (input.operationId !== success.operationId) {
    throw new TypeError("Wallet operation result does not match the requested operation.");
  }
};

export const walletManagementContracts = Object.freeze({
  cancelOperation: defineWalletManagementContract({
    capabilityId: "wallet.cancel_operation",
    inputSchema: operationInputSchema,
    successSchema: walletManagementOperationSchema,
    validatePublicSuccess: validateOperationIdentity,
  }),
  connect: defineWalletManagementContract({
    capabilityId: "wallet.connect",
    inputSchema: emptyInputSchema,
    successSchema: startResultSchemaFor("connect", true),
    validateBoundSuccess: (_input, context, success) => {
      if (success.status === "operation_started" && (
        context.operationId !== success.operation.operationId ||
        context.interactionInterface === undefined
      )) throw new TypeError("Wallet start result does not match its internal context.");
    },
  }),
  currentOperation: defineWalletManagementContract({
    capabilityId: "wallet.current_operation",
    inputSchema: emptyInputSchema,
    successSchema: walletCurrentOperationProjectionSchema,
  }),
  disconnect: defineWalletManagementContract({
    capabilityId: "wallet.disconnect",
    inputSchema: emptyInputSchema,
    successSchema: startResultSchemaFor("disconnect", false),
    validateBoundSuccess: (_input, context, success) => {
      if (
        success.status !== "operation_started" ||
        context.operationId !== success.operation.operationId ||
        context.interactionInterface === undefined
      ) throw new TypeError("Wallet start result does not match its internal context.");
    },
  }),
  operation: defineWalletManagementContract({
    capabilityId: "wallet.operation",
    inputSchema: operationInputSchema,
    successSchema: walletManagementOperationSchema,
    validatePublicSuccess: validateOperationIdentity,
  }),
});

export const walletOperationConfirmationContract = defineApplicationContract({
  inputSchema: confirmationInputSchema,
  successSchema: walletConfirmedOperationSchema,
  internalContextSchema: walletManagementInternalContextSchema,
  errorRegistry: walletManagementErrorRegistry,
  failureCodes: walletManagementFailureCodes,
  validatePublicSuccess: (input, operation) => {
    if (
      operation.operationId !== input.operationId ||
      operation.connectionRevision !== input.connectionRevision
    ) throw new TypeError("Wallet confirmation result does not match its input.");
  },
  validateBoundSuccess: (_input, context, operation) => {
    if (
      context.operationId !== operation.operationId ||
      context.interactionInterface === undefined
    ) throw new TypeError("Wallet confirmation result does not match its internal context.");
  },
});

export type AnyWalletManagementContract =
  typeof walletManagementContracts[keyof typeof walletManagementContracts];

export const walletManagementContractList = Object.freeze(
  Object.values(walletManagementContracts),
);

export const walletManagementCapabilityIdList = Object.freeze(
  walletManagementContractList.map((contract) => contract.capabilityId),
);
