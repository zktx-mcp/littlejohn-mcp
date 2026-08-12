export const walletOperationKinds = Object.freeze(["connect", "disconnect"] as const);

export const walletOperationStateDefinitions = Object.freeze({
  starting_connection: Object.freeze({
    terminal: false,
    cancellable: true,
    kinds: Object.freeze(["connect"] as const),
  }),
  awaiting_wallet_approval: Object.freeze({
    terminal: false,
    cancellable: true,
    kinds: Object.freeze(["connect"] as const),
  }),
  validating_session: Object.freeze({
    terminal: false,
    cancellable: false,
    kinds: Object.freeze(["connect"] as const),
  }),
  cancelling: Object.freeze({
    terminal: false,
    cancellable: false,
    kinds: Object.freeze(["connect"] as const),
  }),
  disconnecting: Object.freeze({
    terminal: false,
    cancellable: false,
    kinds: Object.freeze(["disconnect"] as const),
  }),
  completed: Object.freeze({
    terminal: true,
    cancellable: false,
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
  cancelled: Object.freeze({
    terminal: true,
    cancellable: false,
    kinds: Object.freeze(["connect"] as const),
  }),
  rejected: Object.freeze({
    terminal: true,
    cancellable: false,
    kinds: Object.freeze(["connect"] as const),
  }),
  expired: Object.freeze({
    terminal: true,
    cancellable: false,
    kinds: Object.freeze(["connect"] as const),
  }),
  failed: Object.freeze({
    terminal: true,
    cancellable: false,
    kinds: Object.freeze(["connect", "disconnect"] as const),
  }),
} as const);

export const walletInitiators = Object.freeze(["cli", "mcp_app"] as const);

export type WalletOperationKind = typeof walletOperationKinds[number];
export type WalletOperationState = keyof typeof walletOperationStateDefinitions;
export type WalletInitiator = typeof walletInitiators[number];
export type WalletNonterminalOperationState = {
  [State in WalletOperationState]:
    typeof walletOperationStateDefinitions[State]["terminal"] extends false ? State : never;
}[WalletOperationState];
export type WalletOperationStateForKind<Kind extends WalletOperationKind> = {
  [State in WalletOperationState]: Kind extends
  typeof walletOperationStateDefinitions[State]["kinds"][number] ? State : never;
}[WalletOperationState];

export const walletOperationStates = Object.freeze(
  Object.keys(walletOperationStateDefinitions) as WalletOperationState[],
);

export const walletNonterminalOperationStates = Object.freeze(
  walletOperationStates.filter((state): state is WalletNonterminalOperationState =>
    !walletOperationStateDefinitions[state].terminal),
);

export const isWalletOperationTerminalState = (state: WalletOperationState): boolean =>
  walletOperationStateDefinitions[state].terminal;

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
