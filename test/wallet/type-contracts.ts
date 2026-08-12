import type {
  WalletManagementOperation,
  WalletOperationFailure,
  WalletOperationResult,
  WalletOperationPresentation,
} from "../../src/wallet/contracts.js";
import type {
  WalletInitiator,
  WalletNonterminalOperationState,
} from "../../src/wallet/operation-state.js";

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
type _ConnectNeverDisconnects = Assert<Equal<
  Extract<WalletManagementOperation, { readonly kind: "connect"; readonly state: "disconnecting" }>,
  never
>>;
type _DisconnectNeverCancelsAttempt = Assert<Equal<
  Extract<WalletManagementOperation, { readonly kind: "disconnect"; readonly state: "cancelling" }>,
  never
>>;
type _Initiator = Assert<Equal<WalletInitiator, "cli" | "mcp_app">>;
type ActivePresentation = Extract<
  WalletOperationPresentation["operation"],
  { readonly state: WalletNonterminalOperationState }
>;
type _PresentationKeepsAllActiveStates = Assert<Equal<
  ActivePresentation,
  Extract<WalletManagementOperation, { readonly state: WalletNonterminalOperationState }>
>>;
type _PresentationKeepsTerminalStates = Assert<Equal<
  Extract<WalletOperationPresentation["operation"], {
    readonly state: "completed" | "cancelled" | "rejected" | "failed" | "expired";
  }>,
  Extract<WalletManagementOperation, {
    readonly state: "completed" | "cancelled" | "rejected" | "failed" | "expired";
  }>
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
  | _DisconnectRejected
  | _ConnectNeverDisconnects
  | _DisconnectNeverCancelsAttempt
  | _Initiator
  | _PresentationKeepsAllActiveStates
  | _PresentationKeepsTerminalStates;

export { consumeNarrowedOperation };
