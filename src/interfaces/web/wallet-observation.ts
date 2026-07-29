import {
  parseWalletOperationId,
  type WalletCurrentOperationProjection,
  type WalletManagementOperation,
  type WalletOperationPresentation,
} from "../../wallet/operation-contract.js";
import {
  isWalletOperationTerminalState,
} from "../../wallet/operation-state.js";

interface WalletObservationStorage {
  read(): string | null;
  write(value: string | undefined): void;
}

export interface WalletObservationState {
  readonly trackedOperationId?: string;
  readonly pendingTerminal?: WalletManagementOperation;
  readonly notifiedTerminalOperationId?: string;
}

interface WalletObservationStore {
  load(): WalletObservationState;
  save(state: WalletObservationState): void;
}

export const walletObservationStorageKey = "littlejohn.wallet-operation-observation";

export const createWalletObservationState = (
  trackedOperationId?: string,
  notifiedTerminalOperationId?: string,
): WalletObservationState => Object.freeze(
  {
    ...(trackedOperationId === undefined
      ? {}
      : { trackedOperationId: parseWalletOperationId(trackedOperationId) }),
    ...(notifiedTerminalOperationId === undefined
      ? {}
      : {
          notifiedTerminalOperationId: parseWalletOperationId(
            notifiedTerminalOperationId,
          ),
        }),
  },
);

const storedWalletObservationKeys = Object.freeze([
  "trackedOperationId",
  "notifiedTerminalOperationId",
]);

const parseStoredWalletObservation = (
  value: string,
): WalletObservationState => {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((key) =>
      !storedWalletObservationKeys.includes(key))
  ) {
    throw new TypeError("Wallet observation state is invalid.");
  }
  const record = parsed as Readonly<{
    trackedOperationId?: unknown;
    notifiedTerminalOperationId?: unknown;
  }>;
  return createWalletObservationState(
    record.trackedOperationId as string | undefined,
    record.notifiedTerminalOperationId as string | undefined,
  );
};

const serializeWalletObservation = (
  state: WalletObservationState,
): string | undefined => {
  const admitted = createWalletObservationState(
    state.trackedOperationId,
    state.notifiedTerminalOperationId,
  );
  return Object.keys(admitted).length === 0
    ? undefined
    : JSON.stringify(admitted);
};

export const createWalletObservationStore = (
  storage: WalletObservationStorage | undefined,
): WalletObservationStore => Object.freeze({
  load: (): WalletObservationState => {
    if (storage === undefined) return createWalletObservationState();
    try {
      const value = storage.read();
      if (value === null) return createWalletObservationState();
      return parseStoredWalletObservation(value);
    } catch {
      try { storage.write(undefined); } catch { /* unavailable storage */ }
      return createWalletObservationState();
    }
  },
  save: (state: WalletObservationState): void => {
    if (storage === undefined) return;
    try {
      storage.write(serializeWalletObservation(state));
    } catch {
      try { storage.write(undefined); } catch { /* unavailable storage */ }
    }
  },
});

export interface AcceptedWalletObservation {
  readonly kind: "accepted";
  readonly state: WalletObservationState;
  readonly wallet: WalletCurrentOperationProjection;
  readonly terminal?: WalletManagementOperation;
}

export interface ExactWalletObservation {
  readonly kind: "read_exact";
  readonly state: WalletObservationState;
  readonly operationId: string;
  readonly wallet: WalletCurrentOperationProjection;
}

export type WalletObservation = AcceptedWalletObservation | ExactWalletObservation;

const currentOperationId = (
  wallet: WalletCurrentOperationProjection,
): string | undefined => wallet.status === "present"
  ? wallet.presentation.operation.operationId
  : undefined;

const adoptCurrent = (
  state: WalletObservationState,
  wallet: WalletCurrentOperationProjection,
  terminal?: WalletManagementOperation,
): AcceptedWalletObservation => {
  const nextOperationId = currentOperationId(wallet);
  const next = Object.freeze({
    ...(nextOperationId === undefined ? {} : { trackedOperationId: nextOperationId }),
    ...(terminal === undefined
      ? state.notifiedTerminalOperationId === undefined
        ? {}
        : { notifiedTerminalOperationId: state.notifiedTerminalOperationId }
      : { notifiedTerminalOperationId: terminal.operationId }),
  });
  return Object.freeze({
    kind: "accepted" as const,
    state: next,
    wallet,
    ...(terminal === undefined || terminal.operationId === state.notifiedTerminalOperationId
      ? {}
      : { terminal }),
  });
};

export const trackWalletOperationResult = (
  state: WalletObservationState,
  operation: WalletManagementOperation,
): WalletObservationState => isWalletOperationTerminalState(operation.state)
  ? Object.freeze({
      trackedOperationId: operation.operationId,
      pendingTerminal: operation,
      ...(state.notifiedTerminalOperationId === undefined
        ? {}
        : { notifiedTerminalOperationId: state.notifiedTerminalOperationId }),
    })
  : Object.freeze({
      trackedOperationId: operation.operationId,
      ...(state.notifiedTerminalOperationId === undefined
        ? {}
        : { notifiedTerminalOperationId: state.notifiedTerminalOperationId }),
    });

export const observeWalletCurrent = (
  state: WalletObservationState,
  wallet: WalletCurrentOperationProjection,
): WalletObservation => {
  if (state.pendingTerminal !== undefined) {
    return adoptCurrent(state, wallet, state.pendingTerminal);
  }
  const operationId = currentOperationId(wallet);
  if (
    state.trackedOperationId !== undefined &&
    state.trackedOperationId !== operationId
  ) {
    return Object.freeze({
      kind: "read_exact" as const,
      state,
      operationId: state.trackedOperationId,
      wallet,
    });
  }
  return adoptCurrent(state, wallet);
};

export const observeExactWalletOperation = (
  observation: ExactWalletObservation,
  presentation: WalletOperationPresentation,
): AcceptedWalletObservation | { readonly kind: "retry" } => {
  const { operation } = presentation;
  if (operation.operationId !== observation.operationId) {
    return Object.freeze({ kind: "retry" as const });
  }
  if (!isWalletOperationTerminalState(operation.state)) {
    return Object.freeze({ kind: "retry" as const });
  }
  return adoptCurrent(observation.state, observation.wallet, operation);
};

export const observeExpiredWalletOperation = (
  observation: ExactWalletObservation,
): AcceptedWalletObservation => adoptCurrent(
  Object.freeze({
    ...(observation.state.notifiedTerminalOperationId === undefined
      ? {}
      : { notifiedTerminalOperationId: observation.state.notifiedTerminalOperationId }),
  }),
  observation.wallet,
);
