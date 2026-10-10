import {parseUnsignedDecimal, type UnsignedDecimal} from "../../src/core/index.js";
import {evmAccountIdentitySchema, parseEvmChainId, sameEvmAccountIdentity, type EvmAccountIdentity} from "../../src/evm/identities.js";
import {walletAccountPermissions} from "../../src/wallet/account-admission.js";
import {WalletOperationError} from "../../src/wallet/operation-error.js";
import type {ActiveWalletReadPort, ActiveWalletReadSnapshot, ResolvedWalletAccount} from "../../src/wallet/coordinator.js";
import {walletBoundAccountReferenceSchema, type WalletBoundAccountReference} from "../../src/wallet/bound-account-contract.js";

// A domain-port fixture. Callers provide current facts and, when they vary it,
// the separate permission revision. WalletCoordinator tests own production
// permission continuity, account selection and source admission.
export const activeWalletFixturePort = (
  read: () => ActiveWalletReadSnapshot,
  readPermissionRevision: (account: EvmAccountIdentity) => UnsignedDecimal = () => parseUnsignedDecimal("1"),
): ActiveWalletReadPort => {
  const resolved = (chainId: string, methods: readonly string[]): ResolvedWalletAccount => {
    const snapshot = read();
    if (snapshot.connection.status !== "connected") throw new WalletOperationError(snapshot.connection.status === "disconnected" ? "wallet_not_connected" : snapshot.connection.status === "unresolved" ? "wallet_session_unusable" : "runtime_state_unavailable");
    if (snapshot.sessionSource === undefined) throw new WalletOperationError("runtime_state_unavailable");
    const eligible = walletAccountPermissions(snapshot.connection.namespaces, parseEvmChainId(chainId))
      .filter((entry) => methods.every((method) => entry.methods.includes(method)));
    if (eligible.length !== 1) throw new WalletOperationError(eligible.length === 0 ? "wallet_account_unavailable" : "wallet_account_selection_required");
    const account = evmAccountIdentitySchema.parse(eligible[0]!.account);
    const permission = walletBoundAccountReferenceSchema.parse({connectionId: snapshot.connection.connectionId, account,
      requiredMethods: [...methods].sort(), permissionRevision: readPermissionRevision(account)});
    return {...snapshot, connection: snapshot.connection, sessionSource: snapshot.sessionSource, account,
      selectionRevision: parseUnsignedDecimal("0"), permission};
  };
  const validate = (referenceInput: WalletBoundAccountReference): ResolvedWalletAccount => {
    const reference = walletBoundAccountReferenceSchema.parse(referenceInput);
    const snapshot = read();
    if (snapshot.connection.status === "unknown" || snapshot.connection.status === "connected" && snapshot.sessionSource === undefined) {
      throw new WalletOperationError("runtime_state_unavailable");
    }
    if (snapshot.connection.status !== "connected" || snapshot.sessionSource === undefined ||
        snapshot.connection.connectionId !== reference.connectionId || snapshot.sessionSource.sourceId !== reference.connectionId) {
      throw new WalletOperationError("wallet_session_unusable");
    }
    const permission = walletAccountPermissions(snapshot.connection.namespaces, reference.account.chainId)
      .find(value => sameEvmAccountIdentity(value.account, reference.account));
    if (permission === undefined || reference.permissionRevision !== readPermissionRevision(reference.account) ||
        !reference.requiredMethods.every(method => permission.methods.includes(method))) throw new WalletOperationError("wallet_session_unusable");
    return {...snapshot, connection: snapshot.connection, sessionSource: snapshot.sessionSource, account: reference.account,
      selectionRevision: parseUnsignedDecimal("0"), permission: reference};
  };
  return {capture: async () => read(), resolveAccount: async (input) => resolved(input.chainId, input.requiredMethods),
    validateBoundAccount: async (reference) => validate(reference), assertBoundAccountCurrent: (reference) => {validate(reference);}};
};
