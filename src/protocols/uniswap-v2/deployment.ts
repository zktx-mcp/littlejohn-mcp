import { uniswapProtocolFamily } from "../uniswap.js";
import { z } from "zod";

import {
  capabilityIdSchema,
  contractRuntimeCodeIdentitySchema,
  deepFreezeValue,
  erc20AssetIdentitySchema,
  evmAddressSchema,
  fixedIdentifierSchema,
  hash32Schema,
  jsonObject,
  productChainId,
  productUsdgAsset,
} from "../../core/client.js";
import { officialAssetSourceDefinition } from "../../registry/client.js";
import {
  admitProtocolPackageDescriptor,
  protocolDeploymentIdentitySchema,
  protocolIdSchema,
  protocolPackageContractVersionSchema,
} from "../contracts.js";

const exactStringListSchema = <const Values extends readonly [string, ...string[]]>(
  values: Values,
) => z.array(z.enum(values)).length(values.length).superRefine((input, context) => {
  if (input.some((value, index) => value !== values[index])) {
    context.addIssue({
      code: "custom",
      message: "Expected the exact ordered source statement list.",
    });
  }
});

export const uniswapV2ProtocolId = protocolIdSchema.parse("uniswap_v2");
export const uniswapV2PackageContractVersion =
  protocolPackageContractVersionSchema.parse("1");
export const uniswapV2QuoteCapabilityId = capabilityIdSchema.parse(
  "uniswap_v2.quote_exact_input",
);
export const uniswapV2DeploymentSourceId = fixedIdentifierSchema.parse(
  "uniswap_v2_deployment",
);
export const uniswapV2SdkDependencies = deepFreezeValue({
  sdkCore: {
    packageName: "@uniswap/sdk-core",
    version: "7.19.0",
  },
  v2Sdk: {
    packageName: "@uniswap/v2-sdk",
    version: "4.21.1",
  },
} as const);

export const uniswapV2FactoryAddress = evmAddressSchema.parse(
  "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
);
export const uniswapV2PairInitCodeHash = hash32Schema.parse(
  "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f",
);
export const uniswapV2RouteCoverageBasis =
  "direct_and_one_intermediary" as const;
export const uniswapV2FactoryRuntimeCodeIdentity = deepFreezeValue(
  contractRuntimeCodeIdentitySchema.parse({
    byteLength: "13859",
    codeHash: "0xbab145d02e7005f0d84c6c1639d39b799b0ea16df99ebbdaf5a14d9da820b4e0",
  }),
);

const deploymentSourceDefinition = deepFreezeValue({
  sourceOwner: "Uniswap",
  sourceClass: "official_document",
  sourceUri:
    "https://github.com/Uniswap/contracts/blob/f56eb0c6016361101d103ffd2754498c9893d107/deployments/4663.md",
  sourceRevision: "f56eb0c6016361101d103ffd2754498c9893d107",
  coverage:
    "robinhood_chain_uniswap_v2_factory_and_pair_init_code_hash_at_source_revision",
  exclusions: [
    "all_other_deployments",
    "runtime_code_and_state",
    "pair_existence_and_liquidity",
    "quote_and_execution_quality",
    "safety",
  ],
  supportedConclusions: [
    "factory_address_at_source_revision",
    "pair_init_code_hash_at_source_revision",
  ],
  unsupportedConclusions: [
    "current_runtime_code",
    "current_protocol_availability",
    "pair_identity_or_liquidity",
    "quote_or_execution_result",
    "safety",
  ],
} as const);

export const uniswapV2DeploymentSourceSchema = jsonObject({
  sourceOwner: z.literal(deploymentSourceDefinition.sourceOwner),
  sourceClass: z.literal(deploymentSourceDefinition.sourceClass),
  sourceUri: z.literal(deploymentSourceDefinition.sourceUri),
  sourceRevision: z.literal(deploymentSourceDefinition.sourceRevision),
  coverage: z.literal(deploymentSourceDefinition.coverage),
  exclusions: exactStringListSchema(deploymentSourceDefinition.exclusions),
  supportedConclusions: exactStringListSchema(deploymentSourceDefinition.supportedConclusions),
  unsupportedConclusions: exactStringListSchema(
    deploymentSourceDefinition.unsupportedConclusions,
  ),
}).strict();

export const uniswapV2DeploymentSource = deepFreezeValue(
  uniswapV2DeploymentSourceSchema.parse(deploymentSourceDefinition),
);

const routeAssetSourceDefinition = deepFreezeValue({
  sourceOwner: "Robinhood",
  sourceClass: "official_document",
  sourceUri: officialAssetSourceDefinition.documentationSourceUri,
  sourceObservedAt: "2026-07-26T17:42:43.000Z",
  freshnessStatus: "unknown",
  freshnessRule: "not_revalidated_at_runtime",
  coverage: "two_named_robinhood_chain_route_asset_mappings_at_observation_time",
  exclusions: [
    "all_other_asset_mappings",
    "documentation_changes_after_observation",
    "runtime_code_and_state",
    "liquidity",
    "price",
    "safety",
  ],
  supportedConclusions: [
    "weth_address_at_observation_time",
    "usdg_address_at_observation_time",
  ],
  unsupportedConclusions: [
    "ongoing_document_membership",
    "current_runtime_code",
    "current_liquidity",
    "current_price",
    "safety",
  ],
} as const);

export const uniswapV2RouteAssetSourceSchema = jsonObject({
  sourceOwner: z.literal(routeAssetSourceDefinition.sourceOwner),
  sourceClass: z.literal(routeAssetSourceDefinition.sourceClass),
  sourceUri: z.literal(routeAssetSourceDefinition.sourceUri),
  sourceObservedAt: z.literal(routeAssetSourceDefinition.sourceObservedAt),
  freshnessStatus: z.literal(routeAssetSourceDefinition.freshnessStatus),
  freshnessRule: z.literal(routeAssetSourceDefinition.freshnessRule),
  coverage: z.literal(routeAssetSourceDefinition.coverage),
  exclusions: exactStringListSchema(routeAssetSourceDefinition.exclusions),
  supportedConclusions: exactStringListSchema(routeAssetSourceDefinition.supportedConclusions),
  unsupportedConclusions: exactStringListSchema(
    routeAssetSourceDefinition.unsupportedConclusions,
  ),
}).strict();

export const uniswapV2RouteAssetSource = deepFreezeValue(
  uniswapV2RouteAssetSourceSchema.parse(routeAssetSourceDefinition),
);

export const uniswapV2RouteAssets = deepFreezeValue([
  erc20AssetIdentitySchema.parse({
    kind: "erc20",
    chainId: productChainId,
    address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  }),
  erc20AssetIdentitySchema.parse({
    kind: "erc20",
    chainId: productChainId,
    address: productUsdgAsset.address,
  }),
]);

export const uniswapV2DeploymentIdentity = deepFreezeValue(
  protocolDeploymentIdentitySchema.parse({
    protocolId: uniswapV2ProtocolId,
    chainId: productChainId,
    contractRole: "factory",
    address: uniswapV2FactoryAddress,
  }),
);

export const uniswapV2PackageDescriptor = admitProtocolPackageDescriptor({
  protocolId: uniswapV2ProtocolId,
  familyId: uniswapProtocolFamily.familyId,
  versionDisplayName: "V2",
  packageContractVersion: uniswapV2PackageContractVersion,
  supportLevel: "L0_discovered",
  identityEvidence: {
    sourceOwner: uniswapV2DeploymentSource.sourceOwner,
    sourceClass: uniswapV2DeploymentSource.sourceClass,
    reference: {
      kind: "public",
      sourceId: uniswapV2DeploymentSourceId,
      uri: uniswapV2DeploymentSource.sourceUri,
    },
    sourceRevision: uniswapV2DeploymentSource.sourceRevision,
    coverage: uniswapV2DeploymentSource.coverage,
    exclusions: uniswapV2DeploymentSource.exclusions,
    supportedConclusions: uniswapV2DeploymentSource.supportedConclusions,
    unsupportedConclusions: uniswapV2DeploymentSource.unsupportedConclusions,
  },
  sdkDependencies: [
    uniswapV2SdkDependencies.sdkCore,
    uniswapV2SdkDependencies.v2Sdk,
  ],
  deployments: [uniswapV2DeploymentIdentity],
  capabilities: [{ capabilityId: uniswapV2QuoteCapabilityId }],
});
