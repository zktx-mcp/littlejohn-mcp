import type {
  ApplicationFailure,
  CapabilityBinding,
  accountBalanceCapability,
} from "../core/index.js";
import type { AccountTokenRegistrationReadPort } from "../token-catalog/index.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import type {
  AccountAssetCollectionInput,
  AccountAssetCollectionSuccess,
  AccountAssetExactInput,
  AccountAssetExactSuccess,
} from "./contracts.js";

export interface AccountAssetApplicationPort {
  list(
    input: AccountAssetCollectionInput,
    signal?: AbortSignal,
  ): Promise<AccountAssetCollectionSuccess | ApplicationFailure>;
  get(
    input: AccountAssetExactInput,
    signal?: AbortSignal,
  ): Promise<AccountAssetExactSuccess | ApplicationFailure>;
}

export interface AccountAssetReadProcessDependencies {
  readonly activeWallet: ActiveWalletReadPort;
  readonly registrations: AccountTokenRegistrationReadPort;
  readonly accountBalance: CapabilityBinding<typeof accountBalanceCapability>;
  readonly signal: AbortSignal;
}

export const accountAssetConsumerPortContract = Object.freeze({
  methods: Object.freeze(["get", "list"] as const),
});
