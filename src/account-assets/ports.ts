import type {
  ApplicationFailure,
  CanonicalClock,
} from "../core/index.js";
import type {
  AccountAssetChainReadPort,
  ChainInvocationPort,
  OfficialAssetChainReadPort,
} from "../chain/index.js";
import type { OfficialAssetSynchronizationPort } from "../registry/index.js";
import type { AccountTokenSelectionStore } from "../token-catalog/index.js";
import type { ActiveWalletReadPort } from "../wallet/coordinator.js";
import type {
  AccountAssetCollectionInput,
  AccountAssetCollectionSuccess,
  AccountAssetExactInput,
  AccountAssetExactSuccess,
  AccountAssetOverviewInput,
  AccountAssetOverviewSuccess,
} from "./contracts.js";

export interface AccountAssetApplicationPort {
  list(
    input: AccountAssetCollectionInput,
    signal?: AbortSignal,
  ): Promise<AccountAssetCollectionSuccess | ApplicationFailure>;
  getOverview(
    input: AccountAssetOverviewInput,
    signal?: AbortSignal,
  ): Promise<AccountAssetOverviewSuccess | ApplicationFailure>;
  get(
    input: AccountAssetExactInput,
    signal?: AbortSignal,
  ): Promise<AccountAssetExactSuccess | ApplicationFailure>;
}

export interface AccountAssetReadProcessDependencies {
  readonly activeWallet: ActiveWalletReadPort;
  readonly selections: AccountTokenSelectionStore;
  readonly officialAssets: OfficialAssetSynchronizationPort;
  readonly chainInvocations: ChainInvocationPort;
  readonly officialAssetReads: OfficialAssetChainReadPort;
  readonly chainReads: AccountAssetChainReadPort;
  readonly clock: CanonicalClock;
  readonly signal: AbortSignal;
}

export const accountAssetConsumerPortContract = Object.freeze({
  methods: Object.freeze(["get", "getOverview", "list"] as const),
});
