import type {
  ApplicationFailure,
  CanonicalClock,
} from "../core/index.js";
import type {
  AccountAssetChainReadPort,
  AddressTargetResolverPort,
  ChainInvocationPort,
  CurrentBlockReadPort,
  OfficialAssetChainReadPort,
} from "../chain/index.js";
import type { OfficialAssetReadPort } from "../registry/index.js";
import type { AccountTokenSelectionStore } from "../token-catalog/index.js";
import type {
  AccountAssetCollectionInput,
  AccountAssetCollectionSuccess,
} from "./contracts.js";

export interface AccountAssetApplicationPort {
  list(
    input: AccountAssetCollectionInput,
    signal?: AbortSignal,
  ): Promise<AccountAssetCollectionSuccess | ApplicationFailure>;
}

export interface AccountAssetReadProcessDependencies {
  readonly addressTargets: AddressTargetResolverPort;
  readonly selections: AccountTokenSelectionStore;
  readonly officialAssets: OfficialAssetReadPort;
  readonly chainInvocations: ChainInvocationPort;
  readonly officialAssetReads: OfficialAssetChainReadPort;
  readonly currentBlockReads: CurrentBlockReadPort;
  readonly chainReads: AccountAssetChainReadPort;
  readonly clock: CanonicalClock;
  readonly signal: AbortSignal;
}

export const accountAssetConsumerPortContract = Object.freeze({
  methods: Object.freeze(["list"] as const),
});
