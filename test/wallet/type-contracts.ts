import type {
  WalletManagementOperation,
  WalletOperationFailure,
  WalletOperationResult,
} from "../../src/wallet/contracts.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;

type CompletedOperation = Extract<WalletManagementOperation, { readonly state: "completed" }>;
type FailedOperation = Extract<WalletManagementOperation, { readonly state: "failed" }>;
type OtherOperation = Exclude<WalletManagementOperation, CompletedOperation | FailedOperation>;

type _CompletedResult = Assert<Equal<CompletedOperation["result"], WalletOperationResult>>;
type _CompletedFailure = Assert<Equal<CompletedOperation["failure"], null>>;
type _FailedResult = Assert<Equal<FailedOperation["result"], null>>;
type _FailedFailure = Assert<Equal<FailedOperation["failure"], WalletOperationFailure>>;
type _OtherResult = Assert<Equal<OtherOperation["result"], null>>;
type _OtherFailure = Assert<Equal<OtherOperation["failure"], null>>;
type _DisconnectRejected = Assert<Equal<
  Extract<WalletManagementOperation, { readonly kind: "disconnect"; readonly state: "rejected" }>,
  never
>>;

const consumeNarrowedOperation = (operation: WalletManagementOperation): void => {
  if (operation.state === "completed") {
    const result: WalletOperationResult = operation.result;
    const failure: null = operation.failure;
    void result;
    void failure;
    return;
  }
  if (operation.state === "failed") {
    const result: null = operation.result;
    const failure: WalletOperationFailure = operation.failure;
    void result;
    void failure;
    return;
  }
  const result: null = operation.result;
  const failure: null = operation.failure;
  void result;
  void failure;
};

export type WalletOperationTypeContracts =
  | _CompletedResult
  | _CompletedFailure
  | _FailedResult
  | _FailedFailure
  | _OtherResult
  | _OtherFailure
  | _DisconnectRejected;

export { consumeNarrowedOperation };
