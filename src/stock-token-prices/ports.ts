import type {CapabilityBinding, CapabilityInvocationAuthority, InvocationBoundaryPorts, ObservationAuthority, ObservationAuthorityRegistration} from "../core/index.js";
import type {EvmAddress} from "../evm/identities.js";
import type {
  ChainInvocationPort, CurrentBlockReadPort, OfficialAssetChainReadPort, PinnedEvmReadPort,
} from "../chain/index.js";
import type { OfficialAssetReadPort } from "../registry/index.js";
import type { ApplicationAdmission } from "../runtime/application-lifecycle.js";
import type { stockTokenPricesCapability, stockTokensCapability } from "./contracts.js";
import type { PoolCandidateSourceResult } from "./source-contract.js";
import type { PoolPriceReadPort } from "../protocols/pool-price-port.js";

export interface PoolCandidateSourcePort {
  readonly observationAuthorityRegistration: ObservationAuthorityRegistration;
  read(stockTokenAddress: EvmAddress, signal: AbortSignal): Promise<PoolCandidateSourceObservation>;
  close(): Promise<void>;
}
export interface PoolCandidateSourceObservation {
  readonly result: PoolCandidateSourceResult;
  readonly observationAuthority: ObservationAuthority;
}

export interface StockTokenPriceReadPort {
  readonly prices: CapabilityBinding<typeof stockTokenPricesCapability>;
  readonly tokens: CapabilityBinding<typeof stockTokensCapability>;
}
export interface StockTokenPriceApplicationPort extends StockTokenPriceReadPort { close(): Promise<void>; }
export interface StockTokenPriceDependencies {
  readonly admission: ApplicationAdmission;
  readonly ownerSignal: AbortSignal;
  readonly chainInvocations: ChainInvocationPort;
  readonly currentBlockReads: CurrentBlockReadPort;
  readonly officialAssetReads: OfficialAssetChainReadPort;
  readonly protocolReads: PinnedEvmReadPort;
  readonly officialAssets: OfficialAssetReadPort;
  readonly poolReads: PoolPriceReadPort;
  readonly source: PoolCandidateSourcePort;
  readonly officialAssetObservationAuthority: ObservationAuthority;
  readonly invocationAuthority: CapabilityInvocationAuthority;
  readonly invocationPorts: InvocationBoundaryPorts;
}
