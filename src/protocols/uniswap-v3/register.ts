import {deepFreezeValue, fixedIdentifierSchema, snakeCaseCodeSchema} from "../../core/index.js";
import {productChainId} from "../../registry/client.js";
import { admitProtocolPackageDescriptor, protocolPackageContractVersionSchema } from "../contracts.js";
import { uniswapProtocolFamily } from "../uniswap.js";
import { uniswapV3DeploymentSource, uniswapV3FactoryAddress, uniswapV3ProtocolId } from "./deployment.js";
import { readUniswapV3PoolPrice } from "./pool-price.js";

const source = uniswapV3DeploymentSource;
export const uniswapV3PackageRegistration = deepFreezeValue({
  family: uniswapProtocolFamily,
  package: admitProtocolPackageDescriptor({
    protocolId: uniswapV3ProtocolId, familyId: uniswapProtocolFamily.familyId,
    versionDisplayName: "V3", packageContractVersion: protocolPackageContractVersionSchema.parse("1"), supportLevel: "L0_discovered",
    sdkDependencies: [],
    identityEvidence: {
      sourceOwner: source.owner, sourceClass: "official_document",
      reference: { kind: "public", sourceId: fixedIdentifierSchema.parse("uniswap-v3-deployment"), uri: source.uri },
      sourceRevision: source.revision, coverage: "robinhood_chain_uniswap_v3_factory_at_source_revision",
      supportedConclusions: ["factory_address_at_source_revision"],
      unsupportedConclusions: ["current_runtime_code", "liquidity", "execution", "safety"],
      exclusions: ["current_runtime_code_and_state", "liquidity", "execution", "safety"],
    },
    deployments: [{ protocolId: uniswapV3ProtocolId, chainId: productChainId, contractRole: snakeCaseCodeSchema.parse("factory"), address: uniswapV3FactoryAddress }],
    // The market capability consumes this native reader; no standalone V3 tool
    // or transaction capability is registered by this package.
    capabilities: [],
  }),
  readPoolPrice: readUniswapV3PoolPrice,
});
