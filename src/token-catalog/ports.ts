import type {WalletBoundAccountReference} from "../wallet/bound-account-contract.js";
import type {CardDecisionAdmission} from "../interfaces/mcp-app/card-contract.js";
import type {PreparedTokenSelectionReview, TokenSelectionReviewSource} from "./review-source.js";
import type {ApplicationFailure, CapabilityBinding, OperationId, UtcTimestamp} from "../core/index.js";
import type {ChainAnchor} from "../evm/primitives.js";
import type {EvmAccountIdentity} from "../evm/identities.js";
import type { AddressTargetResolverPort } from "../chain/address-target.js";
import type {
  CommittedOfficialAssetSnapshot,
  OfficialAssetSnapshotRevision,
  OfficialAssetSourceMember,
  StockFactoryVerification,
} from "../registry/index.js";
import type {
  TokenCatalogOperation,
  TokenCatalogOperationInput,
  TokenInspectionSuccess,
  TokenSelectionDirectAction,
  TokenSelectionInput,
  TokenSelectionListInput,
  TokenSelectionListRequest,
  TokenSelectionListResult,
  TokenSelection,
  TokenSelectionDetail,
  TokenSelectionState,
  TokenSelectionSetRevision,
  TokenSelectionReviewRequest,
  TokenSelectionReviewResult,
  tokenInspectCapability,
} from "./contracts.js";

export interface TokenSelectionPage {
  readonly selections: readonly TokenSelection[];
  readonly nextCursor: TokenSelection["asset"]["address"] | null;
}

export interface AccountTokenSelectionReadPort {
  isAccountRetained(account: EvmAccountIdentity): boolean;
  getState(account: EvmAccountIdentity): TokenSelectionState | undefined;
  getForAccount(input: Readonly<{
    account: EvmAccountIdentity;
    asset: TokenSelection["asset"];
  }>): TokenSelectionDetail | undefined;
  listIncludedForAccount(input: Readonly<{
    account: EvmAccountIdentity;
    limit: number;
    cursor: TokenSelection["asset"]["address"] | null;
    excludedAddresses: readonly TokenSelection["asset"]["address"][];
  }>): TokenSelectionPage;
}

export interface DefaultTokenSelectionVerification {
  readonly asset: TokenSelection["asset"];
  readonly verification: StockFactoryVerification;
}

export interface AccountTokenSelectionStore extends AccountTokenSelectionReadPort {
  initializeDefaults(input: Readonly<{
    account: EvmAccountIdentity;
    snapshotRevision: OfficialAssetSnapshotRevision;
    verifiedDefaults: readonly DefaultTokenSelectionVerification[];
    now: UtcTimestamp;
  }>): Readonly<{
    state: TokenSelectionState;
    selections: readonly TokenSelection[];
  }>;
}

export type TokenSelectionActionCommand = Readonly<{
  action: TokenSelectionDirectAction;
  walletAdmission: Readonly<{permission: WalletBoundAccountReference; connectionRevision: string}> | null;
  cardAdmission?: CardDecisionAdmission;
  selectionRevision: TokenSelection["revision"];
  selectionSetRevision: TokenSelectionSetRevision;
  inspection: TokenInspectionSuccess | null;
  officialVerification: StockFactoryVerification | null;
  completedAt: UtcTimestamp;
}>;

export interface TokenCatalogStore {
  prepareReviewSource(input: TokenSelectionReviewRequest, result: TokenSelectionReviewResult): PreparedTokenSelectionReview;
  commitReviewSource(prepared: PreparedTokenSelectionReview): TokenSelectionReviewResult;
  discardReviewSource(prepared: PreparedTokenSelectionReview): void;
  readReviewSource(operationId: string): TokenSelectionReviewSource;
  getSelection(
    account: EvmAccountIdentity,
    asset: TokenSelection["asset"],
  ): TokenSelectionDetail | undefined;
  getSelectionState(account: EvmAccountIdentity): TokenSelectionState | undefined;
  listSelections(input: Readonly<{
    account: EvmAccountIdentity;
  } & Omit<TokenSelectionListRequest, "account">>): TokenSelectionPage;
  readOperation(operationId: TokenCatalogOperation["operationId"]): TokenCatalogOperation | null;
  applySelectionChange(input: TokenSelectionActionCommand): TokenCatalogOperation;
}

export type TokenCatalogQueryStore = Pick<
  TokenCatalogStore,
  "getSelection" | "getSelectionState" | "listSelections"
>;

export type TokenCatalogInspectionPort = CapabilityBinding<typeof tokenInspectCapability>;

export interface TokenAdditionChainReadPort {
  inspectAndVerifyOfficial(
    input: Readonly<{
      asset: TokenSelection["asset"];
      officialMember: OfficialAssetSourceMember | null;
      block: ChainAnchor | null;
    }>,
    signal: AbortSignal,
  ): Promise<
    | ApplicationFailure
    | Readonly<{
        inspection: TokenInspectionSuccess;
        officialVerification: StockFactoryVerification | null;
      }>
  >;
}

export interface OfficialAssetSnapshotReadPort {
  readStored(): CommittedOfficialAssetSnapshot | undefined;
}

export interface TokenCatalogOperationCoordinatorPort {
  prepareReview(input: TokenSelectionReviewRequest): Promise<PreparedTokenSelectionReview>;
  getReviewSource(operationId: string): TokenSelectionReviewSource;
  discardPreparedReview(prepared: PreparedTokenSelectionReview): void;
  review(input: TokenSelectionReviewRequest): Promise<TokenSelectionReviewResult>;
  decide(input: TokenSelectionDirectAction, cardAdmission?: CardDecisionAdmission): Promise<TokenCatalogOperation>;
  getOperation(operationId: TokenCatalogOperation["operationId"]): TokenCatalogOperation;
}

export interface TokenCatalogApplicationPort {
  prepareReview(input: TokenSelectionReviewRequest): Promise<PreparedTokenSelectionReview>;
  getReviewSource(operationId: string): TokenSelectionReviewSource;
  discardPreparedReview(prepared: PreparedTokenSelectionReview): void;
  getSelection(input: TokenSelectionInput, signal?: AbortSignal): Promise<TokenSelectionDetail | ApplicationFailure>;
  listSelections(input: TokenSelectionListInput, signal?: AbortSignal): Promise<TokenSelectionListResult | ApplicationFailure>;
  review(
    input: TokenSelectionReviewRequest,
  ): Promise<TokenSelectionReviewResult | ApplicationFailure>;
  decide(input: TokenSelectionDirectAction, cardAdmission?: CardDecisionAdmission): Promise<TokenCatalogOperation | ApplicationFailure>;
  getOperation(input: TokenCatalogOperationInput): TokenCatalogOperation | ApplicationFailure;
}

export type TokenCatalogQueryApplicationPort = Pick<
  TokenCatalogApplicationPort,
  "getSelection" | "listSelections"
>;

export type TokenCatalogManagementApplicationPort = Pick<
  TokenCatalogApplicationPort,
  "review" | "decide" | "getOperation" | "prepareReview" | "getReviewSource" | "discardPreparedReview"
>;

export interface TokenCatalogConsumerPorts {
  readonly accountTokenSelectionStore: AccountTokenSelectionStore;
  readonly tokenCatalogQueries: TokenCatalogQueryApplicationPort;
  readonly tokenCatalogManagement: TokenCatalogManagementApplicationPort;
}

export const tokenCatalogConsumerPortContract = Object.freeze({
  accountTokenSelectionStore: Object.freeze({
    methods: Object.freeze([
      "isAccountRetained",
      "getState",
      "getForAccount",
      "listIncludedForAccount",
      "initializeDefaults",
    ] as const),
  }),
  tokenCatalogQueries: Object.freeze({
    methods: Object.freeze(["getSelection", "listSelections"] as const),
  }),
  tokenCatalogManagement: Object.freeze({
    methods: Object.freeze(["review", "decide", "getOperation", "prepareReview", "getReviewSource", "discardPreparedReview"] as const),
  }),
});

export interface TokenCatalogCoordinatorDependencies {
  readonly addressTargets: AddressTargetResolverPort;
  readonly additionChainReads: TokenAdditionChainReadPort;
  readonly officialAssets: OfficialAssetSnapshotReadPort;
  readonly store: TokenCatalogStore;
}

export interface TokenCatalogApplicationDependencies {
  readonly addressTargets: AddressTargetResolverPort;
  readonly store: TokenCatalogQueryStore;
}
