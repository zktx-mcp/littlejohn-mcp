import { deriveCaip10Account, type EvmAccountIdentity, type EvmChainId } from "../core/index.js";

type WalletIdentityEvent =
  | Readonly<{ kind: "identity_invalid" }>
  | Readonly<{ kind: "chain_changed"; chainId: EvmChainId }>
  | Readonly<{ kind: "accounts_changed"; chainId: EvmChainId; accounts: readonly string[] }>;

// Callers correlate the session before comparing its normalized identity.
export const walletIdentityEventContradictsAccount = (
  event: WalletIdentityEvent,
  account: EvmAccountIdentity,
): boolean => event.kind === "identity_invalid" || event.chainId !== account.chainId ||
  (event.kind === "accounts_changed" &&
    (event.accounts.length !== 1 || event.accounts[0] !== deriveCaip10Account(account)));
