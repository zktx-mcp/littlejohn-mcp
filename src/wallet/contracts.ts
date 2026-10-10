import type {
  WalletDirectAction,
  WalletManagementOperation,
  WalletNonterminalManagementOperation,
  WalletOperationCancellation,
  WalletOperationPresentation,
  WalletReviewRequest,
  WalletReviewResult,
  WalletReview,
  WalletDisconnectTarget,
} from "./operation-contract.js";
import type {WalletAccountSelectionPort} from "./account-selection-contract.js";
import type {CardDecisionAdmission} from "../interfaces/mcp-app/card-contract.js";

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

export interface WalletOperationTransitionCommand {
  readonly operationId: WalletManagementOperation["operationId"];
  readonly reviewDigest: WalletManagementOperation["review"]["reviewDigest"];
  readonly expectedState: WalletNonterminalManagementOperation["state"];
  readonly connectionRevision: WalletManagementOperation["review"]["precondition"]["connectionRevision"];
  readonly operation: WalletManagementOperation;
}

export interface WalletOperationStore {
  read(operationId: WalletManagementOperation["operationId"]): WalletManagementOperation | null;
  readActive(): WalletNonterminalManagementOperation | null;
  create(operation: WalletNonterminalManagementOperation, cardAdmission?: CardDecisionAdmission): WalletNonterminalManagementOperation;
  transition(command: WalletOperationTransitionCommand): WalletManagementOperation;
}

export interface WalletPreparedReview { readonly review: WalletReview; readonly input: WalletReviewRequest }

export interface WalletReviewStore {
  prepare(input: WalletReviewRequest, review: WalletReview): WalletPreparedReview;
  commit(prepared: WalletPreparedReview): WalletReview;
  discard(prepared: WalletPreparedReview): void;
  read(review: WalletReview): WalletReview;
  get(operationId: string): Readonly<{input: WalletReviewRequest; review: WalletReview}>;
  readTargets(review: Extract<WalletReview, {kind: "disconnect"}>): readonly WalletDisconnectTarget[];
}

export type WalletPreparedReviewResult =
  | Readonly<{status: "review"; prepared: WalletPreparedReview}>
  | Exclude<WalletReviewResult, {status: "review"}>;

export interface WalletManagementPort extends WalletAccountSelectionPort {
  prepareReview(input: WalletReviewRequest): Promise<WalletPreparedReviewResult>;
  getReviewSource(operationId: string): Readonly<{input: WalletReviewRequest; result: Extract<WalletReviewResult, {status: "review"}>}>;
  discardPreparedReview(prepared: WalletPreparedReview): void;
  review(input: WalletReviewRequest): Promise<WalletReviewResult>;
  decide(input: WalletDirectAction, cardAdmission?: CardDecisionAdmission): Promise<WalletManagementOperation>;
  get(operationId: WalletManagementOperation["operationId"]): Promise<WalletManagementOperation>;
  cancel(input: WalletOperationCancellation): Promise<WalletManagementOperation>;
  getPresentation(
    operationId: WalletManagementOperation["operationId"],
  ): Promise<WalletOperationPresentation>;
}
