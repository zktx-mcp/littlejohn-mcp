import type {
  ApplicationErrorRegistry,
  ApplicationFailure,
  OperationId,
} from "../core/index.js";
import type { RuntimeHttpRequest } from "../runtime/http-boundary.js";
import type { InterfaceErrorMappingRegistry } from "../runtime/errors.js";
import type { OperationDeliveryAction } from "./operation-delivery.js";

declare const localOperationIdentityType: unique symbol;

export interface LocalOperationIdentity<Input = unknown, Success = unknown> {
  readonly [localOperationIdentityType]: readonly [Input, Success];
}

interface LocalOperationContract<Input> {
  readonly errorRegistry: ApplicationErrorRegistry;
  parseInput(value: unknown): Input;
  normalizeFailure(value: unknown): ApplicationFailure;
}

export interface LocalOperationRecoveryObservation<Input = unknown, Success = unknown> {
  readonly target: LocalOperationIdentity<Readonly<{ operationId: OperationId }>, unknown>;
  admitObservedResult(input: Input, operationId: OperationId, value: unknown): Success;
}

export interface LocalOperationBinding<Input = unknown, Success = unknown> {
  readonly action: "read" | OperationDeliveryAction;
  readonly contract: LocalOperationContract<Input>;
  readonly errorMappings: InterfaceErrorMappingRegistry;
  operationId(input: Input): OperationId | undefined;
  actionRequest(input: Input, operationId: OperationId | undefined): RuntimeHttpRequest;
  parseActionResponse(input: Input, operationId: OperationId | undefined, value: unknown): Success;
  readonly recoveryObservation?: LocalOperationRecoveryObservation<Input, Success>;
}

const bindings = new WeakMap<object, object>();

export const createLocalOperationIdentity = <Input, Success>(
  binding: LocalOperationBinding<Input, Success>,
): LocalOperationIdentity<Input, Success> => {
  const identity = Object.freeze({}) as LocalOperationIdentity<Input, Success>;
  bindings.set(identity, Object.freeze(binding));
  return identity;
};

export const createLocalOperationRecoveryObservation = <Input, Success, Observed>(
  target: LocalOperationIdentity<Readonly<{ operationId: OperationId }>, Observed>,
  admitObservedResult: (input: Input, operationId: OperationId, value: Observed) => Success,
): LocalOperationRecoveryObservation<Input, Success> => Object.freeze({
  target: target as LocalOperationIdentity<Readonly<{ operationId: OperationId }>, unknown>,
  admitObservedResult: (input: Input, operationId: OperationId, value: unknown) =>
    admitObservedResult(input, operationId, value as Observed),
});

export const resolveLocalOperationIdentity = <Input, Success>(
  identity: LocalOperationIdentity<Input, Success>,
): LocalOperationBinding<Input, Success> => {
  const binding = bindings.get(identity as object);
  if (binding === undefined) throw new TypeError("Local operation identity is invalid.");
  return binding as LocalOperationBinding<Input, Success>;
};
