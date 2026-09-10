import {
  canonicalJsonStringify, captureCanonicalJson, productChainId, walletConnectionDataSchema,
  type AddressTarget, type CanonicalClock,
} from "../core/index.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import { walletSessionRequirements } from "../wallet/session-requirements.js";
import { ExchangeError } from "./errors.js";

export const captureTransactionSession = (
  dependencies: Readonly<{ activeWallet: ActiveWalletReadPort; clock: CanonicalClock }>,
  account: AddressTarget,
  expiresAt: string,
  signal: AbortSignal,
) => {
  const initial = dependencies.activeWallet.capture();
  const connection = walletConnectionDataSchema.parse(initial.connection);
  const session = initial.sessionSource;
  if (connection.status !== "connected" || session === undefined) throw new ExchangeError("wallet_not_connected");
  if (connection.chainId !== productChainId ||
      !walletSessionRequirements.requiredMethods.every((method) => connection.approvedMethods.some((approved) => approved === method)) ||
      (account.kind === "address" && account.address !== connection.address)) throw new ExchangeError("wallet_session_unusable");
  const assertLive = (): void => {
    if (signal.aborted) throw new ExchangeError("request_aborted");
    const now = dependencies.clock.now();
    if (now >= expiresAt || now >= connection.expiresAt) throw new ExchangeError("review_expired");
    const current = dependencies.activeWallet.capture();
    if (current.connectionRevision !== initial.connectionRevision || current.sessionSource?.sourceId !== session.sourceId ||
        canonicalJsonStringify(captureCanonicalJson(current.connection)) !== canonicalJsonStringify(captureCanonicalJson(connection))) {
      throw new ExchangeError("wallet_session_unusable");
    }
  };
  assertLive();
  return Object.freeze({ initial, connection, session, assertLive });
};
