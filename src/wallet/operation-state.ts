export const walletOperationKinds = Object.freeze(["connect", "disconnect"] as const);

export const walletOperationStateDefinitions = Object.freeze({
  starting_connection: Object.freeze({
    terminal: false,
    confirmable: false,
    cancellable: true,
    payload: "none",
    kinds: Object.freeze(["connect"] as const),
  }),
  awaiting_confirmation: Object.freeze({
    terminal: false,
    confirmable: true,
    cancellable: true,
    payload: "none",
    kinds: Object.freeze(["disconnect"] as const),
  }),
  awaiting_wallet_approval: Object.freeze({
    terminal: false,
    confirmable: false,
    cancellable: true,
    payload: "none",
    kinds: Object.freeze(["connect"] as const),
  }),
  disconnecting: Object.freeze({
    terminal: false,
    confirmable: false,
    cancellable: false,
    payload: "none",
    kinds: Object.freeze(["disconnect"] as const),
  }),
  cancelling: Object.freeze({
    terminal: false,
    confirmable: false,
    cancellable: false,
    payload: "none",
    kinds: Object.freeze(["connect"] as const),
  }),
  validating_session: Object.freeze({
    terminal: false,
    confirmable: false,
    cancellable: false,
    payload: "none",
    kinds: Object.freeze(["connect"] as const),
  }),
  completed: Object.freeze({
    terminal: true,
    confirmable: false,
    cancellable: false,
    payload: "result",
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
  cancelled: Object.freeze({
    terminal: true,
    confirmable: false,
    cancellable: false,
    payload: "none",
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
  rejected: Object.freeze({
    terminal: true,
    confirmable: false,
    cancellable: false,
    payload: "peer_refusal",
    kinds: Object.freeze(["connect"] as const),
  }),
  failed: Object.freeze({
    terminal: true,
    confirmable: false,
    cancellable: false,
    payload: "failure",
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
  expired: Object.freeze({
    terminal: true,
    confirmable: false,
    cancellable: false,
    payload: "none",
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
} as const);

export const walletInteractionInterfaces = Object.freeze(["cli", "web"] as const);

export type WalletOperationKind = typeof walletOperationKinds[number];
export type WalletOperationState = keyof typeof walletOperationStateDefinitions;
export type WalletNonterminalOperationState = {
  [State in WalletOperationState]:
    typeof walletOperationStateDefinitions[State]["terminal"] extends false ? State : never;
}[WalletOperationState];
export type WalletOperationStateForKind<Kind extends WalletOperationKind> = {
  [State in WalletOperationState]: Kind extends
  typeof walletOperationStateDefinitions[State]["kinds"][number] ? State : never;
}[WalletOperationState];
export type WalletInteractionInterface = typeof walletInteractionInterfaces[number];

export const walletOperationStates = Object.freeze(
  Object.keys(walletOperationStateDefinitions) as WalletOperationState[],
);

export const isWalletOperationTerminalState = (state: WalletOperationState): boolean =>
  walletOperationStateDefinitions[state].terminal;

export const isWalletOperationConfirmableState = (state: WalletOperationState): boolean =>
  walletOperationStateDefinitions[state].confirmable;

export const isWalletOperationCancellableState = (state: WalletOperationState): boolean =>
  walletOperationStateDefinitions[state].cancellable;

export const walletOperationStatesForKind = <Kind extends WalletOperationKind>(
  kind: Kind,
): readonly [WalletOperationStateForKind<Kind>, ...WalletOperationStateForKind<Kind>[]] => {
  const states = walletOperationStates.filter((state) =>
    (walletOperationStateDefinitions[state].kinds as readonly WalletOperationKind[]).includes(kind));
  if (states.length === 0) throw new TypeError("A wallet operation kind must own at least one state.");
  return states as [WalletOperationStateForKind<Kind>, ...WalletOperationStateForKind<Kind>[]];
};
