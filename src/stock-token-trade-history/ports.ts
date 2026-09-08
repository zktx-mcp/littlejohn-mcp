import type {
  CapabilityBinding,
  CapabilityInvocationAuthority,
  InvocationBoundaryPorts,
  ObservationAuthority,
} from "../core/index.js";
import type { ChainInvocationPort, CurrentBlockReadPort, OfficialAssetChainReadPort, PinnedEvmReadPort } from
  "../chain/index.js";
import type { OfficialAssetSynchronizationPort } from "../registry/index.js";
import type { ApplicationAdmission } from "../runtime/application-lifecycle.js";
import type { StockTokenTradeHistorySourcePort } from "./source-contract.js";
import type { stockTokenTradeHistoryCapability } from "./contracts.js";

export interface StockTokenTradeHistoryReadCapabilityPort {
  readonly binding: CapabilityBinding<typeof stockTokenTradeHistoryCapability>;
}

export interface StockTokenTradeHistoryApplicationPort
  extends StockTokenTradeHistoryReadCapabilityPort {
  close(): Promise<void>;
}

export interface StockTokenTradeHistoryApplicationDependencies {
  readonly admission: ApplicationAdmission;
  readonly chainInvocations: ChainInvocationPort;
  readonly currentBlockReads: CurrentBlockReadPort;
  readonly officialAssets: OfficialAssetSynchronizationPort;
  readonly officialAssetReads: OfficialAssetChainReadPort;
  readonly protocolReads: PinnedEvmReadPort;
  readonly source: StockTokenTradeHistorySourcePort;
  readonly invocationAuthority: CapabilityInvocationAuthority;
  readonly invocationPorts: InvocationBoundaryPorts;
  readonly officialAssetObservationAuthority: ObservationAuthority;
  readonly archiveObservationAuthority: ObservationAuthority;
}
