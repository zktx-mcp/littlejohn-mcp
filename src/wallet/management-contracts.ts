import { z, type ZodType } from "zod";

import {
  capabilityIdSchema,
  captureCanonicalJson,
  compareCodePointSequences,
  coreErrorDefinitions,
  coreContractVersion,
  deepFreezeValue,
  type CapabilityId,
} from "../core/index.js";
import { runtimeErrorDefinitions } from "../runtime/error-definitions.js";
import { walletErrorDefinitions } from "./error-definitions.js";
import {
  walletCurrentOperationProjectionSchema,
  walletCurrentConnectionStartResultSchema,
  walletManagementOperationSchema,
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
  parseInput(value: unknown): Input;
  parseSuccess(input: unknown, value: unknown): Success;
}

const defineWalletManagementContract = <Input, Success>(input: {
  readonly capabilityId: string;
  readonly inputSchema: ZodType<Input>;
  readonly successSchema: ZodType<Success>;
  readonly validateSuccess?: (input: Input, success: Success) => void;
}): WalletManagementContractDefinition<Input, Success> => {
  const capabilityId = capabilityIdSchema.parse(input.capabilityId);
  return Object.freeze({
    capabilityId,
    contractVersion: coreContractVersion,
    inputSchema: input.inputSchema,
    successSchema: input.successSchema,
    failureCodes: walletManagementFailureCodes,
    parseInput: (value: unknown): Input =>
      deepFreezeValue(input.inputSchema.parse(captureCanonicalJson(value))),
    parseSuccess: (inputValue: unknown, value: unknown): Success => {
      const parsedInput = input.inputSchema.parse(captureCanonicalJson(inputValue));
      const success = input.successSchema.parse(captureCanonicalJson(value));
      input.validateSuccess?.(parsedInput, success);
      return deepFreezeValue(success);
    },
  });
};

const emptyInputSchema = z.object({}).strict();
const operationInputSchema = z.object({
  operationId: walletOperationIdSchema,
}).strict();

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
    validateSuccess: validateOperationIdentity,
  }),
  connect: defineWalletManagementContract({
    capabilityId: "wallet.connect",
    inputSchema: emptyInputSchema,
    successSchema: startResultSchemaFor("connect", true),
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
  }),
  operation: defineWalletManagementContract({
    capabilityId: "wallet.operation",
    inputSchema: operationInputSchema,
    successSchema: walletManagementOperationSchema,
    validateSuccess: validateOperationIdentity,
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
