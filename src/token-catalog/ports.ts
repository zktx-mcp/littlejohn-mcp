import type {
  ApplicationFailure,
  CapabilityBinding,
  EvmAccountIdentity,
  UnsignedDecimal,
  UtcTimestamp,
} from "../core/index.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
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
  TokenRegistrationInput,
  TokenRegistrationListInput,
  TokenRegistrationListRequest,
  TokenRegistrationListResult,
  TokenRegistrationStartInput,
  TokenRegistrationStartRequest,
  TokenRegistrationUpdateStartInput,
  TokenRegistration,
  TokenRegistrationSettings,
  TokenRegistrationWithInspection,
  TokenUnregistrationStartInput,
  tokenInspectCapability,
} from "./contracts.js";
import type { TokenCatalogInteractionInterface } from "./state.js";

export interface TokenRegistrationPage {
  readonly registrations: readonly TokenRegistration[];
  readonly nextCursor: TokenRegistration["asset"]["address"] | null;
}

export interface TokenCatalogStore {
  getRegistration(
    account: EvmAccountIdentity,
    asset: TokenRegistration["asset"],
  ): TokenRegistrationWithInspection | undefined;
  listRegistrations(input: Readonly<{
    account: EvmAccountIdentity;
  } & TokenRegistrationListRequest>): TokenRegistrationPage;
  register(input: Readonly<{
    account: EvmAccountIdentity;
    expectedConnectionRevision: UnsignedDecimal;
    inspection: TokenInspectionSuccess;
    settings: TokenRegistrationSettings;
    revision: TokenRegistration["revision"];
    now: UtcTimestamp;
  }>): TokenRegistrationWithInspection;
  update(input: Readonly<{
    account: EvmAccountIdentity;
    asset: TokenRegistration["asset"];
    expectedConnectionRevision: UnsignedDecimal;
    expectedRegistrationRevision: TokenRegistration["revision"];
    settings: TokenRegistrationSettings;
    revision: TokenRegistration["revision"];
    now: UtcTimestamp;
  }>): TokenRegistrationWithInspection;
  unregister(input: Readonly<{
    account: EvmAccountIdentity;
    asset: TokenRegistration["asset"];
    expectedConnectionRevision: UnsignedDecimal;
    expectedRegistrationRevision: TokenRegistration["revision"];
  }>): Readonly<{
    asset: TokenRegistration["asset"];
    removedRevision: TokenRegistration["revision"];
  }>;
}

export type TokenCatalogQueryStore = Pick<
  TokenCatalogStore,
  "getRegistration" | "listRegistrations"
>;

export type TokenCatalogInspectionPort = CapabilityBinding<typeof tokenInspectCapability>;

export interface TokenCatalogOperationCoordinatorPort {
  startRegistration(
    input: TokenRegistrationStartRequest,
    interactionInterface: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogOperationStartResult<"register"> | ApplicationFailure>;
  startRegistrationUpdate(
    input: TokenRegistrationUpdateStartInput,
    interactionInterface: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogOperationStartResult<"update_registration"> | ApplicationFailure>;
  startUnregistration(
    input: TokenUnregistrationStartInput,
    interactionInterface: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogOperationStartResult<"unregister"> | ApplicationFailure>;
  getOperation(operationId: TokenCatalogOperation["operationId"]): TokenCatalogOperation;
  getCurrentOperation(): TokenCatalogOperation | null;
  confirm(
    interactionInterface: TokenCatalogInteractionInterface,
    input: TokenCatalogOperationConfirmationInput,
  ): Promise<TokenCatalogConfirmedOperation>;
  cancel(
    operationId: TokenCatalogOperation["operationId"],
    interactionInterface?: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogTerminalOperation>;
}

export interface TokenCatalogApplicationPort {
  getRegistration(input: TokenRegistrationInput): TokenRegistrationWithInspection | ApplicationFailure;
  listRegistrations(input: TokenRegistrationListInput): TokenRegistrationListResult | ApplicationFailure;
  startRegistration(
    input: TokenRegistrationStartInput,
    interactionInterface: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogOperationStartResult<"register"> | ApplicationFailure>;
  startRegistrationUpdate(
    input: TokenRegistrationUpdateStartInput,
    interactionInterface: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogOperationStartResult<"update_registration"> | ApplicationFailure>;
  startUnregistration(
    input: TokenUnregistrationStartInput,
    interactionInterface: TokenCatalogInteractionInterface,
  ): Promise<TokenCatalogOperationStartResult<"unregister"> | ApplicationFailure>;
  getOperation(input: TokenCatalogOperationInput): TokenCatalogOperationResult | ApplicationFailure;
  cancelOperation(input: TokenCatalogOperationInput): Promise<TokenCatalogCancellationResult | ApplicationFailure>;
}

export type TokenCatalogQueryApplicationPort = Pick<
  TokenCatalogApplicationPort,
  "getRegistration" | "listRegistrations"
>;

export type TokenCatalogNonInteractiveOperationPort = Pick<
  TokenCatalogApplicationPort,
  "getOperation" | "cancelOperation"
>;

export interface TokenCatalogStartApplicationPort<
  InteractionInterface extends TokenCatalogInteractionInterface,
> {
  readonly interactionInterface: InteractionInterface;
  startRegistration(
    input: TokenRegistrationStartInput,
  ): Promise<TokenCatalogOperationStartResult<"register"> | ApplicationFailure>;
  startRegistrationUpdate(
    input: TokenRegistrationUpdateStartInput,
  ): Promise<TokenCatalogOperationStartResult<"update_registration"> | ApplicationFailure>;
  startUnregistration(
    input: TokenUnregistrationStartInput,
  ): Promise<TokenCatalogOperationStartResult<"unregister"> | ApplicationFailure>;
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

export const tokenCatalogConsumerPortContract = Object.freeze({
  tokenCatalogQueries: Object.freeze({
    methods: Object.freeze(["getRegistration", "listRegistrations"] as const),
  }),
  tokenCatalogWebStart: Object.freeze({
    interactionInterface: "web" as const,
    methods: Object.freeze([
      "startRegistration",
      "startRegistrationUpdate",
      "startUnregistration",
    ] as const),
  }),
  tokenCatalogBrowserOperations: Object.freeze({
    interactionInterface: "web" as const,
    methods: Object.freeze(["getOperation", "getCurrentOperation", "confirm", "cancel"] as const),
  }),
  tokenCatalogInteractiveCli: Object.freeze({
    interactionInterface: "cli" as const,
    methods: Object.freeze([
      "startRegistration",
      "startRegistrationUpdate",
      "startUnregistration",
      "confirm",
    ] as const),
  }),
  tokenCatalogNonInteractiveOperations: Object.freeze({
    methods: Object.freeze(["getOperation", "cancelOperation"] as const),
  }),
});

export interface TokenCatalogCoordinatorDependencies {
  readonly activeWallet: ActiveWalletReadPort;
  readonly inspection: TokenCatalogInspectionPort;
  readonly store: TokenCatalogStore;
}

export interface TokenCatalogApplicationDependencies {
  readonly activeWallet: ActiveWalletReadPort;
  readonly store: TokenCatalogQueryStore;
}
