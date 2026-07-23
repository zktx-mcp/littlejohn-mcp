import type {
  ApplicationFailure,
  CapabilityBinding,
  EvmAccountIdentity,
  OperationId,
  UnsignedDecimal,
  UtcTimestamp,
} from "../core/index.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import type {
  OfficialAssetSnapshotRevision,
  OfficialAssetSourceMember,
  OfficialAssetSynchronizationPort,
  StockFactoryVerification,
} from "../registry/index.js";
import type {
  TokenCatalogOperation,
  TokenCatalogOperationConfirmationInput,
  TokenCatalogCancellationResult,
  TokenCatalogConfirmedOperation,
  TokenCatalogOperationInput,
  TokenCatalogOperationResult,
  TokenCatalogOperationStartResult,
  TokenCatalogTerminalOperation,
  TokenInspectionSuccess,
  TokenSelectionInput,
  TokenSelectionListInput,
  TokenSelectionListRequest,
  TokenSelectionListResult,
  TokenAdditionStartInput,
  TokenAdditionStartRequest,
  TokenSelection,
  TokenSelectionDetail,
  TokenSelectionState,
  TokenSelectionSetRevision,
  TokenRemovalStartInput,
  tokenInspectCapability,
} from "./contracts.js";
import type { TokenCatalogInteractionInterface } from "./state.js";

export interface TokenSelectionPage {
  readonly selections: readonly TokenSelection[];
  readonly nextCursor: TokenSelection["asset"]["address"] | null;
}

export interface AccountTokenSelectionReadPort {
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
    expectedConnectionRevision: UnsignedDecimal;
    snapshotRevision: OfficialAssetSnapshotRevision;
    verifiedDefaults: readonly DefaultTokenSelectionVerification[];
    now: UtcTimestamp;
  }>): Readonly<{
    state: TokenSelectionState;
    selections: readonly TokenSelection[];
  }>;
}

type ApplyingOperation<Kind extends TokenCatalogOperation["kind"]> = Extract<
  TokenCatalogOperation,
  { readonly kind: Kind; readonly state: "applying" }
>;

export type TokenCatalogConfirmationCommand =
  | Readonly<{
      kind: "add";
      operation: ApplyingOperation<"add">;
      expectedConnectionRevision: UnsignedDecimal;
      selectionRevision: TokenSelection["revision"];
      selectionSetRevision: TokenSelectionSetRevision;
      officialVerification: StockFactoryVerification | null;
      now: UtcTimestamp;
    }>
  | Readonly<{
      kind: "remove";
      operation: ApplyingOperation<"remove">;
      expectedConnectionRevision: UnsignedDecimal;
      selectionRevision: TokenSelection["revision"];
      selectionSetRevision: TokenSelectionSetRevision;
      now: UtcTimestamp;
    }>;

export interface TokenCatalogStore {
  getSelection(
    account: EvmAccountIdentity,
    asset: TokenSelection["asset"],
  ): TokenSelectionDetail | undefined;
  getSelectionState(account: EvmAccountIdentity): TokenSelectionState | undefined;
  listSelections(input: Readonly<{
    account: EvmAccountIdentity;
  } & TokenSelectionListRequest>): TokenSelectionPage;
  applyConfirmation(input: TokenCatalogConfirmationCommand): TokenCatalogConfirmedOperation;
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

export interface TokenCatalogOperationControl {
  readonly operationId: OperationId;
  readonly interactionInterface: TokenCatalogInteractionInterface;
}

export interface TokenCatalogOperationCoordinatorPort {
  startAddition(
    input: TokenAdditionStartRequest,
    control: TokenCatalogOperationControl,
  ): Promise<TokenCatalogOperationStartResult<"add"> | ApplicationFailure>;
  startRemoval(
    input: TokenRemovalStartInput,
    control: TokenCatalogOperationControl,
  ): Promise<TokenCatalogOperationStartResult<"remove"> | ApplicationFailure>;
  getOperation(operationId: TokenCatalogOperation["operationId"]): TokenCatalogOperation;
  getCurrentOperation(): TokenCatalogOperation | null;
  confirm(
    control: TokenCatalogOperationControl,
    input: TokenCatalogOperationConfirmationInput,
  ): Promise<TokenCatalogConfirmedOperation>;
  cancel(
    operationId: TokenCatalogOperation["operationId"],
    interactionInterface?: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogTerminalOperation>;
}

export interface TokenCatalogApplicationPort {
  getSelection(input: TokenSelectionInput): TokenSelectionDetail | ApplicationFailure;
  listSelections(input: TokenSelectionListInput): TokenSelectionListResult | ApplicationFailure;
  startAddition(
    input: TokenAdditionStartInput,
    control: TokenCatalogOperationControl,
  ): Promise<TokenCatalogOperationStartResult<"add"> | ApplicationFailure>;
  startRemoval(
    input: TokenRemovalStartInput,
    control: TokenCatalogOperationControl,
  ): Promise<TokenCatalogOperationStartResult<"remove"> | ApplicationFailure>;
  getOperation(input: TokenCatalogOperationInput): TokenCatalogOperationResult | ApplicationFailure;
  cancelOperation(input: TokenCatalogOperationInput): Promise<TokenCatalogCancellationResult | ApplicationFailure>;
}

export type TokenCatalogQueryApplicationPort = Pick<
  TokenCatalogApplicationPort,
  "getSelection" | "listSelections"
>;

export type TokenCatalogNonInteractiveOperationPort = Pick<
  TokenCatalogApplicationPort,
  "getOperation" | "cancelOperation"
>;

export interface TokenCatalogStartApplicationPort<
  InteractionInterface extends TokenCatalogInteractionInterface,
> {
  readonly interactionInterface: InteractionInterface;
  startAddition(
    input: TokenAdditionStartInput,
    operationId: OperationId,
  ): Promise<TokenCatalogOperationStartResult<"add"> | ApplicationFailure>;
  startRemoval(
    input: TokenRemovalStartInput,
    operationId: OperationId,
  ): Promise<TokenCatalogOperationStartResult<"remove"> | ApplicationFailure>;
}

export type TokenCatalogWebStartPort = TokenCatalogStartApplicationPort<"web">;

export interface TokenCatalogBrowserOperationPort {
  readonly interactionInterface: "web";
  getOperation: TokenCatalogApplicationPort["getOperation"];
  getCurrentOperation(): TokenCatalogOperation | null;
  confirm(input: TokenCatalogOperationConfirmationInput): Promise<TokenCatalogConfirmedOperation>;
  cancel(operationId: TokenCatalogOperation["operationId"]): Promise<TokenCatalogTerminalOperation>;
}

export interface TokenCatalogInteractiveCliPort extends TokenCatalogStartApplicationPort<"cli"> {
  confirm(input: TokenCatalogOperationConfirmationInput): Promise<TokenCatalogConfirmedOperation>;
}

export interface TokenCatalogConsumerPorts {
  readonly accountTokenSelectionStore: AccountTokenSelectionStore;
  readonly tokenCatalogQueries: TokenCatalogQueryApplicationPort;
  readonly tokenCatalogWebStart: TokenCatalogWebStartPort;
  readonly tokenCatalogBrowserOperations: TokenCatalogBrowserOperationPort;
  readonly tokenCatalogInteractiveCli: TokenCatalogInteractiveCliPort;
  readonly tokenCatalogNonInteractiveOperations: TokenCatalogNonInteractiveOperationPort;
}

export const tokenCatalogConsumerPortContract = Object.freeze({
  accountTokenSelectionStore: Object.freeze({
    methods: Object.freeze([
      "getState",
      "getForAccount",
      "listIncludedForAccount",
      "initializeDefaults",
    ] as const),
  }),
  tokenCatalogQueries: Object.freeze({
    methods: Object.freeze(["getSelection", "listSelections"] as const),
  }),
  tokenCatalogWebStart: Object.freeze({
    interactionInterface: "web" as const,
    methods: Object.freeze([
      "startAddition",
      "startRemoval",
    ] as const),
  }),
  tokenCatalogBrowserOperations: Object.freeze({
    interactionInterface: "web" as const,
    methods: Object.freeze(["getOperation", "getCurrentOperation", "confirm", "cancel"] as const),
  }),
  tokenCatalogInteractiveCli: Object.freeze({
    interactionInterface: "cli" as const,
    methods: Object.freeze([
      "startAddition",
      "startRemoval",
      "confirm",
    ] as const),
  }),
  tokenCatalogNonInteractiveOperations: Object.freeze({
    methods: Object.freeze(["getOperation", "cancelOperation"] as const),
  }),
});

export interface TokenCatalogCoordinatorDependencies {
  readonly activeWallet: ActiveWalletReadPort;
  readonly additionChainReads: TokenAdditionChainReadPort;
  readonly officialAssets: OfficialAssetSynchronizationPort;
  readonly store: TokenCatalogStore;
}

export interface TokenCatalogApplicationDependencies {
  readonly activeWallet: ActiveWalletReadPort;
  readonly store: TokenCatalogQueryStore;
}
