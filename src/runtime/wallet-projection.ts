import type { WalletAccountPreference, WalletSelectAccountInput, WalletSelectAccountSuccess } from "../wallet/account-selection-contract.js";
import type { EvmChainId } from "../evm/identities.js";
import type {CardDecisionAdmission} from "../interfaces/mcp-app/card-contract.js";
import type {UtcTimestamp} from "../core/index.js";
import type {WalletConnectionData} from "../wallet/connection-contract.js";
import type {WalletCleanupRecovery, WalletProductRecovery} from "../wallet/authority-recovery.js";
import type {WalletOperationTransitionCommand} from "../wallet/contracts.js";
import type {
  RuntimeRevision,
} from "./runtime-identity.js";

export interface WalletConnectionRecord {
  readonly revision: RuntimeRevision;
  readonly connection: WalletConnectionData;
  readonly productRecovery: WalletProductRecovery | null;
  readonly cleanupRecovery: WalletCleanupRecovery | null;
  readonly updatedAt: UtcTimestamp;
  readonly revalidationSourceIds: readonly string[];
}

export interface WalletProjectionStore {
  read(): WalletConnectionRecord;
  replace(
    expectedRevision: string,
    connection: WalletConnectionData,
    productRecovery: WalletProductRecovery | null,
    cleanupRecovery: WalletCleanupRecovery | null,
    updatedAt: UtcTimestamp,
    revalidationSourceIds: readonly string[],
    observedSourceIds: readonly string[] | null,
    recoveryTransition?: WalletOperationTransitionCommand,
  ): WalletConnectionRecord;
  readPreference(chainId: EvmChainId): WalletAccountPreference;
  selectAccount(input: WalletSelectAccountInput, cardAdmission?: CardDecisionAdmission): WalletSelectAccountSuccess;
}
