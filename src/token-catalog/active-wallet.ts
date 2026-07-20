import { type EvmAccountIdentity } from "../core/index.js";
import type { UnsignedDecimal } from "../core/index.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import { TokenCatalogOperationError } from "./operation-error.js";

type WalletSessionSource = NonNullable<
  ReturnType<ActiveWalletReadPort["capture"]>["sessionSource"]
>;

export interface ConnectedWalletSession {
  readonly account: EvmAccountIdentity;
  readonly connectionRevision: UnsignedDecimal;
  readonly sessionSource: WalletSessionSource;
}

export const captureConnectedWalletSession = (
  activeWallet: ActiveWalletReadPort,
): ConnectedWalletSession => {
  const snapshot = activeWallet.capture();
  switch (snapshot.connection.status) {
    case "unknown":
    case "unresolved":
      throw new TokenCatalogOperationError("wallet_session_unusable");
    case "disconnected":
      throw new TokenCatalogOperationError(
        snapshot.connection.reason === "unusable_store"
          ? "wallet_session_unusable"
          : "wallet_not_connected",
      );
    case "connected": {
      if (snapshot.sessionSource === undefined) {
        throw new TokenCatalogOperationError("wallet_session_unusable");
      }
      const account = Object.freeze({
        chainId: snapshot.connection.chainId,
        address: snapshot.connection.address,
      });
      return Object.freeze({
        account,
        connectionRevision: snapshot.connectionRevision,
        sessionSource: snapshot.sessionSource,
      });
    }
  }
};
