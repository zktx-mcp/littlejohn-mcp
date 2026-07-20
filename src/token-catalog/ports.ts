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
  TokenRegistration,
  TokenRegistrationWithInspection,
  TokenUnregistrationStartInput,
  tokenInspectCapability,
} from "./contracts.js";
import type { TokenCatalogInteractionInterface } from "./state.js";

export interface TokenRegistrationPage {
  readonly registrations: readonly TokenRegistration[];
  readonly nextCursor: TokenRegistration["asset"]["address"] | null;
}

export interface TokenRegistrationInspectionPage {
  readonly entries: readonly TokenRegistrationWithInspection[];
  readonly nextCursor: TokenRegistration["asset"]["address"] | null;
}

export interface AccountTokenRegistrationReadPort {
  getForAccount(input: Readonly<{
    account: EvmAccountIdentity;
    asset: TokenRegistration["asset"];
  }>): TokenRegistrationWithInspection | undefined;
  listForAccount(input: Readonly<{
    account: EvmAccountIdentity;
    limit: number;
    cursor: TokenRegistration["asset"]["address"] | null;
  }>): TokenRegistrationInspectionPage;
}

type ApplyingOperation<Kind extends TokenCatalogOperation["kind"]> = Extract<
  TokenCatalogOperation,
  { readonly kind: Kind; readonly state: "applying" }
>;

export type TokenCatalogConfirmationCommand =
  | Readonly<{
      kind: "register";
      operation: ApplyingOperation<"register">;
      expectedConnectionRevision: UnsignedDecimal;
      registrationRevision: TokenRegistration["revision"];
      now: UtcTimestamp;
    }>
  | Readonly<{
      kind: "unregister";
      operation: ApplyingOperation<"unregister">;
      expectedConnectionRevision: UnsignedDecimal;
    }>;

export interface TokenCatalogStore {
  getRegistration(
    account: EvmAccountIdentity,
    asset: TokenRegistration["asset"],
  ): TokenRegistrationWithInspection | undefined;
  listRegistrations(input: Readonly<{
    account: EvmAccountIdentity;
  } & TokenRegistrationListRequest>): TokenRegistrationPage;
  applyConfirmation(input: TokenCatalogConfirmationCommand): TokenCatalogConfirmedOperation;
}

export type TokenCatalogQueryStore = Pick<
  TokenCatalogStore,
  "getRegistration" | "listRegistrations"
>;

export type TokenCatalogInspectionPort = CapabilityBinding<typeof tokenInspectCapability>;

export interface TokenCatalogOperationControl {
  readonly operationId: OperationId;
  readonly interactionInterface: TokenCatalogInteractionInterface;
}

export interface TokenCatalogOperationCoordinatorPort {
  startRegistration(
    input: TokenRegistrationStartRequest,
    control: TokenCatalogOperationControl,
  ): Promise<TokenCatalogOperationStartResult<"register"> | ApplicationFailure>;
  startUnregistration(
    input: TokenUnregistrationStartInput,
    control: TokenCatalogOperationControl,
  ): Promise<TokenCatalogOperationStartResult<"unregister"> | ApplicationFailure>;
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
  getRegistration(input: TokenRegistrationInput): TokenRegistrationWithInspection | ApplicationFailure;
  listRegistrations(input: TokenRegistrationListInput): TokenRegistrationListResult | ApplicationFailure;
  startRegistration(
    input: TokenRegistrationStartInput,
    control: TokenCatalogOperationControl,
  ): Promise<TokenCatalogOperationStartResult<"register"> | ApplicationFailure>;
  startUnregistration(
    input: TokenUnregistrationStartInput,
    control: TokenCatalogOperationControl,
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
    operationId: OperationId,
  ): Promise<TokenCatalogOperationStartResult<"register"> | ApplicationFailure>;
  startUnregistration(
    input: TokenUnregistrationStartInput,
    operationId: OperationId,
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

export interface TokenCatalogConsumerPorts {
  readonly accountTokenRegistrationRead: AccountTokenRegistrationReadPort;
  readonly tokenCatalogQueries: TokenCatalogQueryApplicationPort;
  readonly tokenCatalogWebStart: TokenCatalogWebStartPort;
  readonly tokenCatalogBrowserOperations: TokenCatalogBrowserOperationPort;
  readonly tokenCatalogInteractiveCli: TokenCatalogInteractiveCliPort;
  readonly tokenCatalogNonInteractiveOperations: TokenCatalogNonInteractiveOperationPort;
}

export const tokenCatalogConsumerPortContract = Object.freeze({
  accountTokenRegistrationRead: Object.freeze({
    methods: Object.freeze(["getForAccount", "listForAccount"] as const),
  }),
  tokenCatalogQueries: Object.freeze({
    methods: Object.freeze(["getRegistration", "listRegistrations"] as const),
  }),
  tokenCatalogWebStart: Object.freeze({
    interactionInterface: "web" as const,
    methods: Object.freeze([
      "startRegistration",
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
