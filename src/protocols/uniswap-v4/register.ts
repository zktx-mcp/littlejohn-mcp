import { uniswapV4ActionProfiles } from "./parameters.js";
import { readUniswapV4PoolPrice } from "./pool-price.js";
import { compareCodePointSequences, capabilityIdSchema, productChainId, fixedIdentifierSchema, snakeCaseCodeSchema } from "../../core/index.js";
import { admitProtocolPackageDescriptor, protocolPackageContractVersionSchema } from "../contracts.js";
import { uniswapProtocolFamily } from "../uniswap.js";
import { createUniswapV4PoolsApplication } from "./application.js";
import { uniswapV4PoolsCapability } from "./pools.js";
import { createUniswapV4Evm } from "./evm.js";
import { uniswapV4ContractAddresses, uniswapV4DeploymentSource, uniswapV4ProtocolId } from "./deployment.js";

export const uniswapV4PackageDescriptor = admitProtocolPackageDescriptor({
  protocolId: uniswapV4ProtocolId, familyId: uniswapProtocolFamily.familyId,
  versionDisplayName: "V4", packageContractVersion: protocolPackageContractVersionSchema.parse("1"),
  supportLevel: "L0_discovered", sdkDependencies: [],
  identityEvidence: {
    sourceOwner: uniswapV4DeploymentSource.owner, sourceClass: "official_document",
    reference: { kind: "public", sourceId: fixedIdentifierSchema.parse("uniswap-v4-deployment"), uri: uniswapV4DeploymentSource.uri },
    sourceRevision: uniswapV4DeploymentSource.revision,
    coverage: "robinhood_chain_uniswap_v4_contract_addresses_at_source_revision",
    supportedConclusions: ["contract_addresses_at_source_revision"],
    unsupportedConclusions: ["current_runtime_code", "current_liquidity", "execution", "safety"],
    exclusions: ["current_runtime_code_and_state", "liquidity", "execution", "safety"],
  },
  deployments: ([
    ["permit2", uniswapV4ContractAddresses.permit2], ["pool_manager", uniswapV4ContractAddresses.poolManager],
    ["position_manager", uniswapV4ContractAddresses.positionManager],
    ["quoter", uniswapV4ContractAddresses.quoter], ["router", uniswapV4ContractAddresses.router],
    ["state_view", uniswapV4ContractAddresses.stateView],
  ] as const).map(([contractRole, address]) => ({ protocolId: uniswapV4ProtocolId, chainId: productChainId, contractRole: snakeCaseCodeSchema.parse(contractRole), address })),
  capabilities: [{ capabilityId: capabilityIdSchema.parse("uniswap_v4.list_pools") }],
});

// Read admission is installed before this native implementation is supplied to
// Review. Registration supplies no grant and makes no Wallet qualification claim.
export const uniswapV4PackageRegistration = Object.freeze({
  family: uniswapProtocolFamily, package: uniswapV4PackageDescriptor,
  capability: uniswapV4PoolsCapability, createApplication: createUniswapV4PoolsApplication,
  createNativeOperations: createUniswapV4Evm,
  readPoolPrice: readUniswapV4PoolPrice,
  actions: uniswapV4ActionProfiles,
});

export const uniswapV4ActionSupport = Object.freeze(uniswapV4ActionProfiles.map((entry) => Object.freeze({
  actionId: entry.contract.actionId, contractVersion: entry.contract.contractVersion,
  protocolId: uniswapV4ProtocolId, supportLevel: "L2_reviewed" as const,
})).sort((a, b) => compareCodePointSequences(a.actionId, b.actionId)));
