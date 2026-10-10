import {type CanonicalClock} from "../core/index.js";
import {productChainId} from "../registry/client.js";
import {type AddressTarget} from "../evm/address-target.js";
import type {ActiveWalletReadPort} from "../wallet/coordinator.js";
import type {WalletBoundAccountReference} from "../wallet/bound-account-contract.js";
import {walletSessionRequirements} from "../wallet/session-requirements.js";
import {ExchangeError} from "./errors.js";

export const captureTransactionSession = async (
  dependencies: Readonly<{activeWallet: ActiveWalletReadPort; clock: CanonicalClock}>,
  account: AddressTarget, expiresAt: string, signal: AbortSignal,
  bound?: WalletBoundAccountReference,
) => {
  const initial = bound === undefined
    ? await dependencies.activeWallet.resolveAccount({chainId: productChainId, requiredMethods: walletSessionRequirements.requiredMethods}, signal)
    : await dependencies.activeWallet.validateBoundAccount(bound, signal);
  const connection = initial.connection;
  const session = initial.sessionSource;
  if (account.kind === "address" && account.address !== initial.account.address) throw new ExchangeError("wallet_session_unusable");
  const assertLive = async (): Promise<void> => {
    if (signal.aborted) throw new ExchangeError("request_aborted");
    if (dependencies.clock.now() >= expiresAt || dependencies.clock.now() >= connection.expiresAt) throw new ExchangeError("review_expired");
    await dependencies.activeWallet.validateBoundAccount(initial.permission, signal);
    if (signal.aborted) throw new ExchangeError("request_aborted");
    if (dependencies.clock.now() >= expiresAt || dependencies.clock.now() >= connection.expiresAt) throw new ExchangeError("review_expired");
  };
  await assertLive();
  return Object.freeze({initial, connection, session, assertLive});
};
