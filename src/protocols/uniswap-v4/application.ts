import { bindCapability, captureCanonicalJson, type CapabilityInvocationAuthority, type InvocationBoundaryPorts, type ObservationAuthority } from "../../core/index.js";
import { findOfficialAssetMember, projectOfficialAssetSnapshotEvidence, type OfficialAssetSynchronizationPort } from "../../registry/index.js";
import { officialAssetErrorRegistry } from "../../registry/error-registry.js";
import { uniswapV4PoolCatalog } from "./catalog.js";
import { uniswapV4PoolsCapability, uniswapV4PoolsDataSchema, uniswapV4PoolsEvidence } from "./pools.js";

export const createUniswapV4PoolsApplication = (input: Readonly<{
  officialAssets: OfficialAssetSynchronizationPort;
  officialAssetObservationAuthority: ObservationAuthority;
  invocationAuthority: CapabilityInvocationAuthority;
  invocationPorts: InvocationBoundaryPorts;
}>) => bindCapability({
  definition: uniswapV4PoolsCapability, errorRegistry: officialAssetErrorRegistry,
  invocationAuthority: input.invocationAuthority, createInvocationPorts: () => input.invocationPorts,
  handler: async (request, context, observations) => {
    const result = await input.officialAssets.synchronize(context.signal);
    if (result.status === "unavailable") return { status: "failure" as const, code: result.reason, issues: [] };
    const officialMember = findOfficialAssetMember(result.snapshot, request.stockTokenAddress) !== undefined;
    const data = uniswapV4PoolsDataSchema.parse({ stockTokenAddress: request.stockTokenAddress,
      snapshot: projectOfficialAssetSnapshotEvidence(result.snapshot), officialMember,
      candidates: officialMember ? uniswapV4PoolCatalog.filter((pool) => pool.stockTokenAddress === request.stockTokenAddress) : [],
    });
    const target = observations.bind(uniswapV4PoolsEvidence.target);
    observations.record(target.slot, { source: input.officialAssetObservationAuthority, claims: [{ role: target.roles.value,
      value: captureCanonicalJson({ stockTokenAddress: data.stockTokenAddress, snapshot: data.snapshot, officialMember }) }] });
    return { status: "success" as const, data };
  },
});
