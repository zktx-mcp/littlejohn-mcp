import { z } from "zod";

import { canonicalSha256 } from "./canonical-json.js";
import { sourceReferenceSchema } from "./evidence.js";
import { deepFreezeValue } from "./immutability.js";
import { evmAddressSchema } from "./identities.js";
import {
  readCanonicalClock,
  readObservationAuthority,
  type CanonicalClock,
  type ObservationAuthority,
} from "./invocation.js";
import { jsonObject } from "./json-object.js";
import { productChainId, productChainNumericId } from "./product-identity.js";
import { stockTokenReferenceMarketGeneratedCatalog } from
  "./stock-token-reference-market.generated.js";
import {
  canonicalBase64UrlSchema,
  chainAnchorSchema,
  closedTupleSchema,
  generalSingleLineTextSchema,
  hash32Schema,
  unsignedDecimalSchema,
  utcTimestampSchema,
  type ChainAnchor,
} from "./primitives.js";

export const referenceMarketManifestVersion = 1 as const;

const definitionValues = <
  const Definitions extends readonly [
    Readonly<Record<string, unknown>>,
    ...Readonly<Record<string, unknown>>[],
  ],
  const Key extends keyof Definitions[number],
>(
  definitions: Definitions,
  key: Key,
): { readonly [Index in keyof Definitions]: Definitions[Index][Key] } =>
  Object.freeze(definitions.map((definition) =>
    definition[key as keyof typeof definition])) as {
    readonly [Index in keyof Definitions]: Definitions[Index][Key];
  };

type StringLiteralSchemas<Values extends readonly string[]> = {
  readonly [Index in keyof Values]:
    Values[Index] extends string ? z.ZodLiteral<Values[Index]> : never;
};
const literalTupleSchema = <
  const Values extends readonly [string, ...string[]],
>(values: Values) => closedTupleSchema(
  values.map((value) => z.literal(value)) as unknown as StringLiteralSchemas<Values>,
);

const referenceHistoryWindowDefinitionEntries = deepFreezeValue([
  {
    window: "1d",
    windowMilliseconds: 24 * 60 * 60 * 1_000,
    bucketMilliseconds: 15 * 60 * 1_000,
    maximumBuckets: 96,
  },
  {
    window: "7d",
    windowMilliseconds: 7 * 24 * 60 * 60 * 1_000,
    bucketMilliseconds: 60 * 60 * 1_000,
    maximumBuckets: 168,
  },
  {
    window: "30d",
    windowMilliseconds: 30 * 24 * 60 * 60 * 1_000,
    bucketMilliseconds: 4 * 60 * 60 * 1_000,
    maximumBuckets: 180,
  },
] as const);
const referenceHistoryWindowIds =
  definitionValues(referenceHistoryWindowDefinitionEntries, "window");
const maximumReferenceHistoryWindowDefinition =
  referenceHistoryWindowDefinitionEntries[referenceHistoryWindowDefinitionEntries.length - 1]!;

export const referenceHistoryWindowSchema = z.enum(referenceHistoryWindowIds);
export type ReferenceHistoryWindow = z.infer<typeof referenceHistoryWindowSchema>;
type ReferenceHistoryWindowDefinition = Readonly<{
  windowMilliseconds: number;
  bucketMilliseconds: number;
  maximumBuckets: number;
}>;
const referenceHistoryWindowDefinitionRecord =
  {} as Record<ReferenceHistoryWindow, ReferenceHistoryWindowDefinition>;
const referenceHistoryCandleBucketRecord =
  {} as Record<ReferenceHistoryWindow, number>;
for (const definition of referenceHistoryWindowDefinitionEntries) {
  referenceHistoryWindowDefinitionRecord[definition.window] = Object.freeze({
    windowMilliseconds: definition.windowMilliseconds,
    bucketMilliseconds: definition.bucketMilliseconds,
    maximumBuckets: definition.maximumBuckets,
  });
  referenceHistoryCandleBucketRecord[definition.window] = definition.maximumBuckets;
}
export const referenceHistoryWindowDefinitions =
  Object.freeze(referenceHistoryWindowDefinitionRecord);
const referenceHistoryCandleBuckets = Object.freeze(referenceHistoryCandleBucketRecord);
export const referenceHistoryRetentionMilliseconds =
  maximumReferenceHistoryWindowDefinition.windowMilliseconds;

const maximumReferencePairSources = 2 as const;

const referenceMarketMappingEvidenceDefinition = deepFreezeValue({
  sourceOwner: "Chainlink Foundation",
  sourceClass: "official_document",
  sourceUri: "https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood",
  sourceObservedAt: "2026-07-23T02:00:12.000Z",
  freshnessStatus: "unknown",
  freshnessRule: "not_revalidated_at_runtime",
  coverage: "two_named_robinhood_chain_standard_proxy_mappings",
  exclusions: ["all_other_networks_and_feeds"],
  supportedConclusions: [
    "feed_address_association_at_observation_time",
    "feed_description_at_observation_time",
    "feed_decimals_at_observation_time",
    "feed_heartbeat_at_observation_time",
  ],
  unsupportedConclusions: [
    "ongoing_directory_membership",
    "proxy_correctness_after_observation",
    "source_uptime",
    "price_correctness",
    "endorsement",
    "trade_price",
    "sequencer_status",
    "legal_value",
  ],
} as const);

export const referenceMarketSourceUri = referenceMarketMappingEvidenceDefinition.sourceUri;
export const referenceMarketSourceObservedAt =
  referenceMarketMappingEvidenceDefinition.sourceObservedAt;

export const referenceMarketMappingEvidenceSchema = jsonObject({
  sourceOwner: z.literal(referenceMarketMappingEvidenceDefinition.sourceOwner),
  sourceClass: z.literal(referenceMarketMappingEvidenceDefinition.sourceClass),
  sourceUri: z.literal(referenceMarketSourceUri),
  sourceObservedAt: z.literal(referenceMarketSourceObservedAt),
  freshnessStatus: z.literal(referenceMarketMappingEvidenceDefinition.freshnessStatus),
  freshnessRule: z.literal(referenceMarketMappingEvidenceDefinition.freshnessRule),
  coverage: z.literal(referenceMarketMappingEvidenceDefinition.coverage),
  exclusions: literalTupleSchema(referenceMarketMappingEvidenceDefinition.exclusions),
  supportedConclusions:
    literalTupleSchema(referenceMarketMappingEvidenceDefinition.supportedConclusions),
  unsupportedConclusions:
    literalTupleSchema(referenceMarketMappingEvidenceDefinition.unsupportedConclusions),
}).strict();
export type ReferenceMarketMappingEvidence = z.infer<typeof referenceMarketMappingEvidenceSchema>;

export const referenceMarketMappingEvidence = deepFreezeValue(
  referenceMarketMappingEvidenceSchema.parse(referenceMarketMappingEvidenceDefinition),
);

export const canonicalUsdgAddress = evmAddressSchema.parse(
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
);

const genericReferenceFeedDefinitions = deepFreezeValue([
  {
    feedId: "eth_usd",
    chainId: productChainId,
    asset: "native_eth",
    quote: "usd_reference",
    standardProxy: evmAddressSchema.parse("0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9"),
    expectedDescription: "ETH / USD",
    decimals: 8,
    heartbeatSeconds: 86_400,
    availability: "continuous_24_7",
    mappingBasis: "manual_official_source_association",
    sequencerEvidence: "sequencer_status_unavailable",
  },
  {
    feedId: "usdg_usd",
    chainId: productChainId,
    asset: "canonical_usdg",
    quote: "usd_reference",
    standardProxy: evmAddressSchema.parse("0x61b7e5650328764b076a108eff5fa7282a1b9ad2"),
    expectedDescription: "USDG / USD",
    decimals: 8,
    heartbeatSeconds: 86_400,
    availability: "continuous_24_7",
    mappingBasis: "manual_official_source_association",
    sequencerEvidence: "sequencer_status_unavailable",
  },
] as const);

const stockTokenCatalogSourceUriSchemas = [
  z.literal(stockTokenReferenceMarketGeneratedCatalog.sources[0].uri),
  z.literal(stockTokenReferenceMarketGeneratedCatalog.sources[1].uri),
] as const;
const stockTokenCatalogSourceSchema = jsonObject({
  uri: z.union(stockTokenCatalogSourceUriSchemas),
  observedAt: utcTimestampSchema,
  rawResponseBytes: z.number().int().positive().max(1_048_576),
  rawResponseDigest: hash32Schema,
}).strict();
const stockTokenCatalogDeploymentSchema = jsonObject({
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contractAddress: evmAddressSchema,
  networkName: generalSingleLineTextSchema,
}).strict();
export const stockTokenCatalogAssetSchema = jsonObject({
  assetUid: hash32Schema,
  sourceStatus: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/u),
  symbol: z.string().min(1).max(32).regex(/^[A-Z0-9][A-Z0-9.-]*$/u),
  name: generalSingleLineTextSchema,
  deployments: z.array(stockTokenCatalogDeploymentSchema).max(8),
}).strict();
export type StockTokenCatalogAsset = z.infer<typeof stockTokenCatalogAssetSchema>;

export const stockTokenCatalogUnmappedReasonSchema = z.enum([
  "asset_inactive",
  "asset_deployment_missing",
  "asset_deployment_ambiguous",
  "asset_symbol_ambiguous",
  "feed_not_found",
  "feed_ambiguous",
  "feed_non_usd",
  "feed_source_inconsistent",
]);
export type StockTokenCatalogUnmappedReason =
  z.infer<typeof stockTokenCatalogUnmappedReasonSchema>;

const stockTokenCatalogFeedSchema = jsonObject({
  feedId: evmAddressSchema,
  proxyAddress: evmAddressSchema,
  expectedDescription: generalSingleLineTextSchema,
  decimals: z.literal(8),
  heartbeatSeconds: z.literal(86_400),
  availability: z.literal("session_dependent_24_5"),
  sourceRow: z.number().int().nonnegative().max(511),
}).strict().superRefine((value, context) => {
  if (value.feedId !== value.proxyAddress) {
    context.addIssue({ code: "custom", message: "Stock Token feed identity is inconsistent." });
  }
});
const mappedStockTokenSourceStatus =
  stockTokenReferenceMarketGeneratedCatalog.dispositions.find((entry) =>
    entry.mapping.status === "mapped")?.asset.sourceStatus;
if (mappedStockTokenSourceStatus === undefined) {
  throw new TypeError("The generated Stock Token catalog has no mapped source status.");
}
const mappedStockTokenCatalogDispositionSchema = jsonObject({
  asset: stockTokenCatalogAssetSchema,
  mapping: jsonObject({
    status: z.literal("mapped"),
    selectedDeployment: stockTokenCatalogDeploymentSchema,
    feed: stockTokenCatalogFeedSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const selected = value.mapping.selectedDeployment;
  if (
    value.asset.sourceStatus !== mappedStockTokenSourceStatus ||
    selected.chainId !== productChainNumericId ||
    !value.asset.deployments.some((deployment) =>
      deployment.chainId === selected.chainId &&
      deployment.contractAddress === selected.contractAddress &&
      deployment.networkName === selected.networkName)
  ) {
    context.addIssue({ code: "custom", message: "Mapped Stock Token deployment is inconsistent." });
  }
});
const unmappedStockTokenCatalogDispositionSchema = jsonObject({
  asset: stockTokenCatalogAssetSchema,
  mapping: jsonObject({
    status: z.literal("unmapped"),
    reason: stockTokenCatalogUnmappedReasonSchema,
  }).strict(),
}).strict();
export const stockTokenCatalogDispositionSchema = z.union([
  mappedStockTokenCatalogDispositionSchema,
  unmappedStockTokenCatalogDispositionSchema,
]);
export type StockTokenCatalogDisposition =
  z.infer<typeof stockTokenCatalogDispositionSchema>;

export const stockTokenReferenceMarketGeneratedCatalogSchema = jsonObject({
  contractVersion: z.literal("1"),
  sources: closedTupleSchema([
    stockTokenCatalogSourceSchema,
    stockTokenCatalogSourceSchema,
  ]),
  dispositionSetDigest: hash32Schema,
  dispositions: z.array(stockTokenCatalogDispositionSchema).min(1).max(512),
}).strict().superRefine((value, context) => {
  if (value.sources.some((source, index) =>
    source.uri !== stockTokenReferenceMarketGeneratedCatalog.sources[index]!.uri)) {
    context.addIssue({ code: "custom", message: "Stock Token catalog source order is invalid." });
  }
  if (
    value.dispositionSetDigest !== `0x${canonicalSha256(value.dispositions)}`
  ) {
    context.addIssue({ code: "custom", message: "Stock Token catalog digest is invalid." });
  }
  const assetUids = value.dispositions.map((entry) => entry.asset.assetUid);
  if (
    new Set(assetUids).size !== assetUids.length ||
    assetUids.some((assetUid, index) => index > 0 && assetUids[index - 1]! >= assetUid)
  ) {
    context.addIssue({ code: "custom", message: "Stock Token catalog order is invalid." });
  }
  const mappedFeedIds = value.dispositions.flatMap((entry) =>
    entry.mapping.status === "mapped" ? [entry.mapping.feed.feedId] : []);
  if (new Set(mappedFeedIds).size !== mappedFeedIds.length) {
    context.addIssue({ code: "custom", message: "Stock Token feed identities are duplicated." });
  }
});
export type StockTokenReferenceMarketGeneratedCatalog =
  z.infer<typeof stockTokenReferenceMarketGeneratedCatalogSchema>;

export const stockTokenReferenceMarketCatalog = deepFreezeValue(
  stockTokenReferenceMarketGeneratedCatalogSchema.parse(
    stockTokenReferenceMarketGeneratedCatalog,
  ),
);

export const stockTokenCatalogSourceEvidenceSchema = jsonObject({
  uri: z.union(stockTokenCatalogSourceUriSchemas),
  observedAt: utcTimestampSchema,
  rawResponseDigest: hash32Schema,
}).strict();
export type StockTokenCatalogSourceEvidence =
  z.infer<typeof stockTokenCatalogSourceEvidenceSchema>;

export const stockTokenCatalogEvidenceSchema = jsonObject({
  contractVersion: z.literal(stockTokenReferenceMarketCatalog.contractVersion),
  dispositionSetDigest: z.literal(
    stockTokenReferenceMarketCatalog.dispositionSetDigest,
  ),
  sources: closedTupleSchema([
    stockTokenCatalogSourceEvidenceSchema,
    stockTokenCatalogSourceEvidenceSchema,
  ]),
}).strict().superRefine((value, context) => {
  const expected = stockTokenReferenceMarketCatalog.sources;
  if (value.sources.some((source, index) =>
    source.uri !== expected[index]!.uri ||
    source.observedAt !== expected[index]!.observedAt ||
    source.rawResponseDigest !== expected[index]!.rawResponseDigest)) {
    context.addIssue({ code: "custom", message: "Stock Token catalog evidence is invalid." });
  }
});
export type StockTokenCatalogEvidence = z.infer<typeof stockTokenCatalogEvidenceSchema>;

export const stockTokenCatalogEvidence = deepFreezeValue(
  stockTokenCatalogEvidenceSchema.parse({
    contractVersion: stockTokenReferenceMarketCatalog.contractVersion,
    dispositionSetDigest: stockTokenReferenceMarketCatalog.dispositionSetDigest,
    sources: stockTokenReferenceMarketCatalog.sources.map((source) => ({
      uri: source.uri,
      observedAt: source.observedAt,
      rawResponseDigest: source.rawResponseDigest,
    })),
  }),
);

const stockTokenCatalogDispositionByAssetUid = new Map(
  stockTokenReferenceMarketCatalog.dispositions.map((entry) =>
    [entry.asset.assetUid, entry] as const),
);
export const findStockTokenCatalogDisposition = (
  assetUidInput: unknown,
): StockTokenCatalogDisposition | undefined =>
  stockTokenCatalogDispositionByAssetUid.get(hash32Schema.parse(assetUidInput));

const referencePairSourceIds = definitionValues(genericReferenceFeedDefinitions, "feedId");
const genericReferenceFeedAssets =
  definitionValues(genericReferenceFeedDefinitions, "asset");
const genericReferenceFeedDescriptions =
  definitionValues(genericReferenceFeedDefinitions, "expectedDescription");
export const referencePairSourceIdSchema = z.enum(referencePairSourceIds);
export type ReferencePairSourceId = z.infer<typeof referencePairSourceIdSchema>;
const fixedReferenceFeedDecimals = genericReferenceFeedDefinitions[0].decimals;
const fixedReferenceFeedHeartbeatSeconds =
  genericReferenceFeedDefinitions[0].heartbeatSeconds;

type MappedStockTokenCatalogDisposition = Extract<
  StockTokenCatalogDisposition,
  { readonly mapping: { readonly status: "mapped" } }
>;
const isMappedStockTokenCatalogDisposition = (
  entry: StockTokenCatalogDisposition,
): entry is MappedStockTokenCatalogDisposition => entry.mapping.status === "mapped";
const mappedStockTokenCatalogDispositions =
  stockTokenReferenceMarketCatalog.dispositions.filter(
    isMappedStockTokenCatalogDisposition,
  );
const stockTokenReferenceFeedDefinitions = deepFreezeValue(
  mappedStockTokenCatalogDispositions.map((entry) => ({
    feedId: entry.mapping.feed.feedId,
    chainId: productChainId,
    asset: {
      kind: "stock_token" as const,
      assetUid: entry.asset.assetUid,
      tokenAddress: entry.mapping.selectedDeployment.contractAddress,
      symbol: entry.asset.symbol,
    },
    quote: "usd_reference" as const,
    standardProxy: entry.mapping.feed.proxyAddress,
    expectedDescription: entry.mapping.feed.expectedDescription,
    decimals: entry.mapping.feed.decimals,
    heartbeatSeconds: entry.mapping.feed.heartbeatSeconds,
    availability: entry.mapping.feed.availability,
    mappingBasis: "generated_complete_source_association" as const,
    sequencerEvidence: "sequencer_status_unavailable" as const,
  })),
);
const referenceFeedDefinitions = deepFreezeValue([
  ...genericReferenceFeedDefinitions,
  ...stockTokenReferenceFeedDefinitions,
]);

export type ReferenceFeedId = ReferencePairSourceId |
  z.infer<typeof evmAddressSchema>;
export const referenceFeedIds = Object.freeze(
  referenceFeedDefinitions.map((definition) => definition.feedId),
) as readonly ReferenceFeedId[];
export const stockTokenReferenceFeedIds = Object.freeze(
  stockTokenReferenceFeedDefinitions.map((definition) => definition.feedId),
);
export const stockTokenReferenceFeedIdSchema = z.enum(
  stockTokenReferenceFeedIds as unknown as readonly [string, ...string[]],
).pipe(evmAddressSchema);
export const referenceFeedIdSchema = z.union([
  referencePairSourceIdSchema,
  stockTokenReferenceFeedIdSchema,
]);

const referenceFeedDefinitionById = new Map(
  referenceFeedDefinitions.map((definition) => [definition.feedId, definition] as const),
);
const genericReferenceFeedManifestEntrySchema = jsonObject({
  feedId: referencePairSourceIdSchema,
  chainId: z.literal(genericReferenceFeedDefinitions[0].chainId),
  asset: z.enum(genericReferenceFeedAssets),
  quote: z.literal(genericReferenceFeedDefinitions[0].quote),
  standardProxy: evmAddressSchema,
  expectedDescription: z.enum(genericReferenceFeedDescriptions),
  decimals: z.literal(genericReferenceFeedDefinitions[0].decimals),
  heartbeatSeconds: z.literal(genericReferenceFeedDefinitions[0].heartbeatSeconds),
  availability: z.literal(genericReferenceFeedDefinitions[0].availability),
  mappingBasis: z.literal(genericReferenceFeedDefinitions[0].mappingBasis),
  sequencerEvidence: z.literal(genericReferenceFeedDefinitions[0].sequencerEvidence),
}).strict();
const stockTokenReferenceFeedManifestEntrySchema = jsonObject({
  feedId: stockTokenReferenceFeedIdSchema,
  chainId: z.literal(productChainId),
  asset: jsonObject({
    kind: z.literal("stock_token"),
    assetUid: hash32Schema,
    tokenAddress: evmAddressSchema,
    symbol: z.string().min(1).max(32).regex(/^[A-Z0-9][A-Z0-9.-]*$/u),
  }).strict(),
  quote: z.literal("usd_reference"),
  standardProxy: evmAddressSchema,
  expectedDescription: generalSingleLineTextSchema,
  decimals: z.literal(8),
  heartbeatSeconds: z.literal(86_400),
  availability: z.literal("session_dependent_24_5"),
  mappingBasis: z.literal("generated_complete_source_association"),
  sequencerEvidence: z.literal("sequencer_status_unavailable"),
}).strict();
export const referenceFeedManifestEntrySchema = z.union([
  genericReferenceFeedManifestEntrySchema,
  stockTokenReferenceFeedManifestEntrySchema,
]).superRefine((value, context) => {
  const expected = referenceFeedDefinitionById.get(value.feedId);
  if (
    expected === undefined ||
    canonicalSha256(value) !== canonicalSha256(expected)
  ) {
    context.addIssue({ code: "custom", message: "Reference feed identity differs from the manifest." });
  }
});
export type ReferenceFeedManifestEntry = z.infer<typeof referenceFeedManifestEntrySchema>;

export const referenceAssetSchema = z.discriminatedUnion("kind", [
  jsonObject({ kind: z.literal("native_eth"), chainId: z.literal(productChainId) }).strict(),
  jsonObject({
    kind: z.literal("erc20"),
    chainId: z.literal(productChainId),
    address: evmAddressSchema,
  }).strict(),
  jsonObject({ kind: z.literal("reference_currency"), code: z.literal("USD") }).strict(),
]);
export type ReferenceAsset = z.infer<typeof referenceAssetSchema>;

export const referencePairContractSchema = jsonObject({
  chainId: z.literal(productChainId),
  base: referenceAssetSchema,
  quote: referenceAssetSchema,
  seriesType: z.literal("reference_price"),
  sourceIds: z.array(referencePairSourceIdSchema).min(1).max(maximumReferencePairSources),
}).strict().superRefine((value, context) => {
  if (new Set(value.sourceIds).size !== value.sourceIds.length) {
    context.addIssue({ code: "custom", message: "Reference pair sources must be unique." });
  }
});
export type ReferencePairContract = z.infer<typeof referencePairContractSchema>;

export const referencePairIdSchema = hash32Schema.brand("ReferencePairId");
export type ReferencePairId = z.infer<typeof referencePairIdSchema>;

const pairIdFor = (contract: ReferencePairContract): ReferencePairId =>
  referencePairIdSchema.parse(`0x${canonicalSha256(contract)}`);

const nativeEth = Object.freeze({ kind: "native_eth" as const, chainId: productChainId });
const canonicalUsdg = Object.freeze({
  kind: "erc20" as const,
  chainId: productChainId,
  address: canonicalUsdgAddress,
});
const usdReference = Object.freeze({ kind: "reference_currency" as const, code: "USD" as const });

const pairContract = (input: Readonly<{
  chainId: ReferencePairContract["chainId"];
  base: ReferencePairContract["base"];
  quote: ReferencePairContract["quote"];
  seriesType: ReferencePairContract["seriesType"];
  sourceIds: readonly ReferencePairSourceId[];
}>): ReferencePairContract => deepFreezeValue(referencePairContractSchema.parse(input));

const referencePairDefinitions = deepFreezeValue([
  {
    label: "ETH/USD",
    starter: true,
    contract: {
      chainId: productChainId,
      base: nativeEth,
      quote: usdReference,
      seriesType: "reference_price",
      sourceIds: [genericReferenceFeedDefinitions[0].feedId],
    },
  },
  {
    label: "USDG/USD",
    starter: true,
    contract: {
      chainId: productChainId,
      base: canonicalUsdg,
      quote: usdReference,
      seriesType: "reference_price",
      sourceIds: [genericReferenceFeedDefinitions[1].feedId],
    },
  },
  {
    label: "ETH/USDG",
    starter: false,
    contract: {
      chainId: productChainId,
      base: nativeEth,
      quote: canonicalUsdg,
      seriesType: "reference_price",
      sourceIds: [
        genericReferenceFeedDefinitions[0].feedId,
        genericReferenceFeedDefinitions[1].feedId,
      ],
    },
  },
] as const);

const referencePairLabels = definitionValues(referencePairDefinitions, "label");
const canonicalPairEntries = deepFreezeValue(referencePairDefinitions.map((definition) => {
  const contract = pairContract(definition.contract);
  return {
    pairId: pairIdFor(contract),
    label: definition.label,
    starter: definition.starter,
    contract,
  };
}));
const canonicalPairEntryById = new Map(
  canonicalPairEntries.map((entry) => [entry.pairId, entry] as const),
);

export const referencePairIds = Object.freeze(
  canonicalPairEntries.map((entry) => entry.pairId),
);
export const referenceStarterPairIds = Object.freeze(canonicalPairEntries
  .filter((entry) => entry.starter)
  .map((entry) => entry.pairId));

export const referenceMarketLimits = Object.freeze({
  feedCount: referenceFeedDefinitions.length,
  pairCount: referencePairDefinitions.length,
  watchlistEntries: 3,
  maximumPairSources: maximumReferencePairSources,
  historyProbes: 1_024,
  providerBatchCalls: 32,
  historyRoundsPerFeed: 16_384,
  historyRoundsAggregate: 32_768,
  historySourceObservations:
    maximumReferenceHistoryWindowDefinition.maximumBuckets * 4 * maximumReferencePairSources,
  stockTokenHistorySourceObservations:
    maximumReferenceHistoryWindowDefinition.maximumBuckets * 4,
  synchronizationJobs: 32,
  synchronizationActiveJobs: 2,
  revisionBytes: 16,
  exactRationalDigits: 96,
  candleBuckets: referenceHistoryCandleBuckets,
});

const exactPairEntry = (value: {
  pairId: ReferencePairId;
  label: string;
  starter: boolean;
  contract: ReferencePairContract;
}): boolean => {
  const expected = canonicalPairEntryById.get(value.pairId);
  return expected !== undefined &&
    value.label === expected.label &&
    value.starter === expected.starter &&
    canonicalSha256(value.contract) === canonicalSha256(expected.contract);
};

export const referencePairManifestEntrySchema = jsonObject({
  pairId: referencePairIdSchema,
  label: z.enum(referencePairLabels),
  starter: z.boolean(),
  contract: referencePairContractSchema,
}).strict().superRefine((value, context) => {
  if (value.pairId !== pairIdFor(value.contract) || !exactPairEntry(value)) {
    context.addIssue({ code: "custom", message: "Reference pair differs from the manifest." });
  }
});
export type ReferencePairManifestEntry = z.infer<typeof referencePairManifestEntrySchema>;

export const referenceMarketManifestSchema = jsonObject({
  version: z.literal(referenceMarketManifestVersion),
  chainId: z.literal(productChainId),
  mappingEvidence: referenceMarketMappingEvidenceSchema,
  feeds: z.array(referenceFeedManifestEntrySchema).length(referenceMarketLimits.feedCount),
  pairs: z.array(referencePairManifestEntrySchema).length(referenceMarketLimits.pairCount),
}).strict().superRefine((value, context) => {
  if (value.feeds.map((entry) => entry.feedId).join("\0") !== referenceFeedIds.join("\0")) {
    context.addIssue({ code: "custom", message: "Reference feed order is invalid." });
  }
  if (value.pairs.map((entry) => entry.pairId).join("\0") !==
    referencePairIds.join("\0")) {
    context.addIssue({ code: "custom", message: "Reference pair order is invalid." });
  }
  const feedIds = new Set(value.feeds.map((entry) => entry.feedId));
  if (value.pairs.some((entry) => entry.contract.sourceIds.some((feedId) => !feedIds.has(feedId)))) {
    context.addIssue({ code: "custom", message: "Reference pair feed coverage is incomplete." });
  }
});
export type ReferenceMarketManifest = z.infer<typeof referenceMarketManifestSchema>;

export const referenceMarketManifest = deepFreezeValue(referenceMarketManifestSchema.parse({
  version: referenceMarketManifestVersion,
  chainId: productChainId,
  mappingEvidence: referenceMarketMappingEvidence,
  feeds: referenceFeedDefinitions,
  pairs: canonicalPairEntries,
}));

const referenceFeedById = new Map(
  referenceMarketManifest.feeds.map((entry) => [entry.feedId, entry] as const),
);
const referencePairById = new Map(
  referenceMarketManifest.pairs.map((entry) => [entry.pairId, entry] as const),
);

export const referenceSupportedPairIdSchema = referencePairIdSchema.refine(
  (pairId) => referencePairIds.includes(pairId),
  "Reference pair is not supported.",
);

export const findReferenceFeed = (feedId: ReferenceFeedId): ReferenceFeedManifestEntry => {
  const feed = referenceFeedById.get(feedId);
  if (feed === undefined) throw new TypeError("Reference feed is not supported.");
  return feed;
};

export const findReferencePair = (pairId: ReferencePairId): ReferencePairManifestEntry => {
  const pair = referencePairById.get(pairId);
  if (pair === undefined) throw new TypeError("Reference pair is not supported.");
  return pair;
};

const boundedDecimalSchema = (maximum: bigint, maximumDigits: number, positive: boolean) =>
  unsignedDecimalSchema.superRefine((value, context) => {
    if ((positive && value === "0") || value.length > maximumDigits || BigInt(value) > maximum) {
      context.addIssue({ code: "custom", message: "Integer is outside the supported range." });
    }
  });

const positiveRationalComponentSchema = boundedDecimalSchema(
  10n ** BigInt(referenceMarketLimits.exactRationalDigits) - 1n,
  referenceMarketLimits.exactRationalDigits,
  true,
);
const uint80Maximum = (1n << 80n) - 1n;
const uint64Maximum = (1n << 64n) - 1n;
const int256PositiveMaximum = (1n << 255n) - 1n;
const maximumUtcUnixSeconds = 253_402_300_799n;
const positiveRoundIdSchema = boundedDecimalSchema(uint80Maximum, 25, true);
export const referenceCompositeRoundIdSchema = positiveRoundIdSchema.superRefine((value, context) => {
  const roundId = BigInt(value);
  const phaseId = roundId >> 64n;
  const aggregatorRoundId = roundId & uint64Maximum;
  if (phaseId === 0n || aggregatorRoundId === 0n) {
    context.addIssue({
      code: "custom",
      message: "Reference round identity requires positive phase and aggregator components.",
    });
  }
});
export type ReferenceCompositeRoundId = z.infer<typeof referenceCompositeRoundIdSchema>;
export interface ReferenceCompositeRoundIdentity {
  readonly roundId: ReferenceCompositeRoundId;
  readonly phaseId: string;
  readonly aggregatorRoundId: string;
}
export const parseReferenceCompositeRoundId = (
  value: unknown,
): ReferenceCompositeRoundIdentity => {
  const roundId = referenceCompositeRoundIdSchema.parse(value);
  const numeric = BigInt(roundId);
  return Object.freeze({
    roundId,
    phaseId: (numeric >> 64n).toString(10),
    aggregatorRoundId: (numeric & uint64Maximum).toString(10),
  });
};
const answeredInRoundSchema = boundedDecimalSchema(uint80Maximum, 25, false);
const positiveAnswerSchema = boundedDecimalSchema(int256PositiveMaximum, 77, true);
const unixTimestampSecondsSchema = boundedDecimalSchema(maximumUtcUnixSeconds, 12, true);
const unixTimestampSecondsIncludingZeroSchema = boundedDecimalSchema(maximumUtcUnixSeconds, 12, false);

export const exactRationalSchema = jsonObject({
  numerator: positiveRationalComponentSchema,
  denominator: positiveRationalComponentSchema,
}).strict().superRefine((value, context) => {
  let left = BigInt(value.numerator);
  let right = BigInt(value.denominator);
  while (right !== 0n) [left, right] = [right, left % right];
  if (left !== 1n) context.addIssue({ code: "custom", message: "Exact rational value is not reduced." });
});
export type ExactRational = z.infer<typeof exactRationalSchema>;

const gcd = (left: bigint, right: bigint): bigint => {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
};

export const createExactRational = (numerator: bigint, denominator: bigint): ExactRational => {
  if (numerator <= 0n || denominator <= 0n) throw new TypeError("Exact rational components must be positive.");
  const divisor = gcd(numerator, denominator);
  return deepFreezeValue(exactRationalSchema.parse({
    numerator: (numerator / divisor).toString(10),
    denominator: (denominator / divisor).toString(10),
  }));
};

export const compareExactRationals = (left: ExactRational, right: ExactRational): number => {
  const leftValue = BigInt(left.numerator) * BigInt(right.denominator);
  const rightValue = BigInt(right.numerator) * BigInt(left.denominator);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
};

const exactRationalsEqual = (left: ExactRational, right: ExactRational): boolean =>
  left.numerator === right.numerator && left.denominator === right.denominator;

export const referenceMarketWarningDefinitions = deepFreezeValue([
  {
    code: "reference_price_not_trade_price",
    meaning: "The value is a reference value, not an executable quote, trade, fill, or recommendation.",
    appliesTo: ["price", "history", "stock_token"],
  },
  {
    code: "source_listing_not_revalidated",
    meaning: "Runtime did not re-fetch the maintainer-only feed directory.",
    appliesTo: ["price", "history", "stock_token"],
  },
  {
    code: "sequencer_status_unavailable",
    meaning: "No independently admitted sequencer-status observation qualifies the chain read.",
    appliesTo: ["price", "history", "stock_token"],
  },
  {
    code: "no_trade_volume",
    meaning: "Reference-round candles contain no trade-volume observation.",
    appliesTo: ["history", "stock_token"],
  },
  {
    code: "partial_history",
    meaning: "The admitted observations do not establish the complete requested history window.",
    appliesTo: ["history", "stock_token"],
  },
] as const);
const referenceMarketWarningCodes =
  definitionValues(referenceMarketWarningDefinitions, "code");
export const referenceMarketWarningCodeSchema = z.enum(referenceMarketWarningCodes);
export type ReferenceMarketWarningCode = z.infer<typeof referenceMarketWarningCodeSchema>;

const warningCodesFor = (
  result: "price" | "history" | "stock_token",
): readonly ReferenceMarketWarningCode[] => Object.freeze(
  referenceMarketWarningDefinitions
    .filter((definition) =>
      (definition.appliesTo as readonly string[]).includes(result))
    .map((definition) => definition.code),
);
export const referencePriceWarnings = warningCodesFor("price");
export const referenceHistoryWarnings = Object.freeze(
  warningCodesFor("history").filter((code) => code !== "partial_history"),
);
export const stockTokenMarketBaseWarnings = Object.freeze(
  warningCodesFor("stock_token").filter((code) => code !== "partial_history"),
);
export const stockTokenMarketWarningCodes = Object.freeze(
  warningCodesFor("stock_token"),
);

export const stockTokenMarketLimitationDefinitions = deepFreezeValue([
  {
    code: "oracle_paused",
    meaning: "The token contract reported that its oracle is paused at the result block.",
  },
  {
    code: "observation_not_fresh",
    meaning: "The latest valid round is older than its admitted heartbeat at the result block.",
  },
  {
    code: "source_history_not_exhaustive",
    meaning: "Round traversal cannot prove that the provider published no additional rounds.",
  },
  {
    code: "remaining_continuation",
    meaning: "A durable continuation remains after bounded synchronization.",
  },
  {
    code: "remaining_gap",
    meaning: "A bounded unresolved round interval remains.",
  },
  {
    code: "phase_boundary",
    meaning: "Traversal reached an aggregator phase boundary it did not cross.",
  },
  {
    code: "malformed_round",
    meaning: "A traversed source round failed strict round admission.",
  },
  {
    code: "retention_boundary",
    meaning: "Local deterministic retention excludes an older round prefix.",
  },
  {
    code: "empty_history",
    meaning: "No admitted source observation produced a candle in the requested window.",
  },
] as const);
export const stockTokenMarketLimitationCodes =
  definitionValues(stockTokenMarketLimitationDefinitions, "code");
export const stockTokenMarketLimitationCodeSchema =
  z.enum(stockTokenMarketLimitationCodes);
export type StockTokenMarketLimitationCode =
  z.infer<typeof stockTokenMarketLimitationCodeSchema>;

const exactSequence = <Value>(actual: readonly Value[], expected: readonly Value[]): boolean =>
  actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);

export const referenceFeedIntegrityStatuses = Object.freeze(["conflict"] as const);
export const referenceFeedIntegrityStatusSchema = z.enum(referenceFeedIntegrityStatuses);
export type ReferenceFeedIntegrityStatus = z.infer<typeof referenceFeedIntegrityStatusSchema> | null;

export const referenceFeedTraversalStatuses = Object.freeze([
  "malformed",
  "phase_boundary",
  "retention_boundary",
] as const);
export const referenceFeedTraversalStatusSchema = z.enum(referenceFeedTraversalStatuses);
export type ReferenceFeedTraversalStatus = z.infer<typeof referenceFeedTraversalStatusSchema> | null;

const referencePhaseIdSchema = boundedDecimalSchema((1n << 16n) - 1n, 5, true);

export const referenceFeedTraversalStateSchema = jsonObject({
  backfillPhaseId: referencePhaseIdSchema.nullable(),
  backfillNextRoundId: referenceCompositeRoundIdSchema.nullable(),
  backfillStatus: referenceFeedTraversalStatusSchema.nullable(),
  retentionCutoffRoundId: referenceCompositeRoundIdSchema.nullable(),
}).strict().superRefine((value, context) => {
  const phase = value.backfillPhaseId === null ? null : BigInt(value.backfillPhaseId);
  const nextPhase = value.backfillNextRoundId === null
    ? null
    : BigInt(parseReferenceCompositeRoundId(value.backfillNextRoundId).phaseId);
  const cutoff = value.retentionCutoffRoundId === null
    ? null
    : parseReferenceCompositeRoundId(value.retentionCutoffRoundId);
  if (
    (phase === null && (value.backfillNextRoundId !== null || value.backfillStatus !== null)) ||
    (nextPhase !== null && nextPhase !== phase) ||
    (value.backfillStatus === "malformed" && value.backfillNextRoundId === null) ||
    ((value.backfillStatus === "phase_boundary" || value.backfillStatus === "retention_boundary") &&
      value.backfillNextRoundId !== null) ||
    (cutoff === null && value.backfillStatus === "retention_boundary") ||
    (value.backfillStatus === "retention_boundary" &&
      phase?.toString(10) !== cutoff?.phaseId) ||
    (value.backfillNextRoundId !== null && cutoff !== null &&
      BigInt(value.backfillNextRoundId) <= BigInt(cutoff.roundId)) ||
    (phase !== null && value.backfillNextRoundId === null && value.backfillStatus === null)
  ) {
    context.addIssue({ code: "custom", message: "Reference feed traversal state is inconsistent." });
  }
});
export type ReferenceFeedTraversalState = z.infer<typeof referenceFeedTraversalStateSchema>;

export const referenceHistoryTraversalReportSchema = jsonObject({
  remainingContinuation: z.boolean(),
  remainingGap: z.boolean(),
  phaseBoundaryObserved: z.boolean(),
  malformedRoundObserved: z.boolean(),
}).strict();
export type ReferenceHistoryTraversalReport = z.infer<typeof referenceHistoryTraversalReportSchema>;

export const referenceRoundFactSchema = jsonObject({
  manifestVersion: z.literal(referenceMarketManifestVersion),
  feedId: referenceFeedIdSchema,
  proxyAddress: evmAddressSchema,
  decimals: z.literal(fixedReferenceFeedDecimals),
  roundId: referenceCompositeRoundIdSchema,
  answeredInRound: answeredInRoundSchema,
  answer: positiveAnswerSchema,
  startedAtUnixSeconds: unixTimestampSecondsIncludingZeroSchema,
  updatedAtUnixSeconds: unixTimestampSecondsSchema,
  value: exactRationalSchema,
}).strict().superRefine((value, context) => {
  const feed = findReferenceFeed(value.feedId);
  if (
    value.proxyAddress !== feed.standardProxy ||
    value.decimals !== feed.decimals
  ) {
    context.addIssue({ code: "custom", message: "Reference round identity differs from the manifest." });
  }
  const expected = createExactRational(BigInt(value.answer), 10n ** BigInt(value.decimals));
  if (!exactRationalsEqual(expected, value.value)) {
    context.addIssue({ code: "custom", message: "Reference round value is inconsistent." });
  }
  if (BigInt(value.startedAtUnixSeconds) > BigInt(value.updatedAtUnixSeconds)) {
    context.addIssue({ code: "custom", message: "Reference round timestamps are inconsistent." });
  }
});
export type ReferenceRoundFact = z.infer<typeof referenceRoundFactSchema>;

export const referenceRoundReadEvidenceSchema = jsonObject({
  observedAt: utcTimestampSchema,
  sourceOwner: generalSingleLineTextSchema,
  sourceClass: z.literal("chain_rpc"),
  sourceReference: sourceReferenceSchema,
  block: chainAnchorSchema,
}).strict().superRefine((value, context) => {
  if (value.sourceReference.kind !== "configured_rpc" || value.block.chainId !== productChainId) {
    context.addIssue({ code: "custom", message: "Reference round read source is inconsistent." });
  }
});
export type ReferenceRoundReadEvidence = z.infer<typeof referenceRoundReadEvidenceSchema>;

export const referenceRoundObservationSchema = jsonObject({
  fact: referenceRoundFactSchema,
  readEvidence: referenceRoundReadEvidenceSchema,
}).strict().superRefine((value, context) => {
  if (Number(value.fact.updatedAtUnixSeconds) * 1_000 > Date.parse(value.readEvidence.block.blockTimestamp)) {
    context.addIssue({ code: "custom", message: "Reference round update is after its read block." });
  }
});
export type ReferenceRoundObservation = z.infer<typeof referenceRoundObservationSchema>;

export interface ReferenceHistoryWorkSegment {
  readonly kind: "continuation" | "gap";
  readonly firstRoundId: ReferenceCompositeRoundId;
  readonly stopExclusiveRoundId: ReferenceCompositeRoundId | null;
}

export interface ReferenceHistoryWorkPlan {
  readonly segments: readonly ReferenceHistoryWorkSegment[];
  readonly remainingContinuation: boolean;
  readonly remainingGap: boolean;
}

const previousReferenceRoundId = (
  roundId: ReferenceCompositeRoundId,
): ReferenceCompositeRoundId | null => {
  const identity = parseReferenceCompositeRoundId(roundId);
  const aggregator = BigInt(identity.aggregatorRoundId);
  if (aggregator <= 1n) return null;
  return referenceCompositeRoundIdSchema.parse(
    ((BigInt(identity.phaseId) << 64n) | (aggregator - 1n)).toString(10),
  );
};

export const createReferenceHistoryWorkPlan = (input: Readonly<{
  latestRoundId: ReferenceCompositeRoundId;
  observations: readonly ReferenceRoundObservation[];
  traversal: ReferenceFeedTraversalState;
}>): ReferenceHistoryWorkPlan => {
  const latestRoundId = referenceCompositeRoundIdSchema.parse(input.latestRoundId);
  const observations = input.observations.map((observation) =>
    referenceRoundObservationSchema.parse(observation));
  const traversal = referenceFeedTraversalStateSchema.parse(input.traversal);
  const cutoff = traversal.retentionCutoffRoundId === null
    ? null
    : BigInt(traversal.retentionCutoffRoundId);
  const identities = new Map<string, ReferenceCompositeRoundId>();
  identities.set(latestRoundId, latestRoundId);
  for (const observation of observations) {
    identities.set(observation.fact.roundId, observation.fact.roundId);
  }
  if ([...identities.values()].some((roundId) => cutoff !== null && BigInt(roundId) <= cutoff)) {
    throw new TypeError("Reference history work contains an identity at or below retention.");
  }

  const byPhase = new Map<string, ReferenceCompositeRoundId[]>();
  for (const roundId of identities.values()) {
    const phaseId = parseReferenceCompositeRoundId(roundId).phaseId;
    const phase = byPhase.get(phaseId) ?? [];
    phase.push(roundId);
    byPhase.set(phaseId, phase);
  }
  for (const phase of byPhase.values()) {
    phase.sort((left, right) => BigInt(left) === BigInt(right) ? 0 : BigInt(left) > BigInt(right) ? -1 : 1);
  }

  const segments: ReferenceHistoryWorkSegment[] = [];
  const continuationPhase = traversal.backfillNextRoundId === null
    ? null
    : parseReferenceCompositeRoundId(traversal.backfillNextRoundId).phaseId;
  if (traversal.backfillNextRoundId !== null) {
    const phaseObservations = byPhase.get(continuationPhase!) ?? [];
    if (
      phaseObservations.length > 0 &&
      BigInt(traversal.backfillNextRoundId) >= BigInt(phaseObservations.at(-1)!)
    ) {
      throw new TypeError("Reference history continuation overlaps admitted observations.");
    }
    segments.push(Object.freeze({
      kind: "continuation",
      firstRoundId: traversal.backfillNextRoundId,
      stopExclusiveRoundId: null,
    }));
  }

  const orderedPhases = [...byPhase.entries()].sort(([left], [right]) =>
    BigInt(left) === BigInt(right) ? 0 : BigInt(left) > BigInt(right) ? -1 : 1);
  for (const [phaseId, roundIds] of orderedPhases) {
    for (let index = 0; index < roundIds.length - 1; index += 1) {
      const upper = roundIds[index]!;
      const lower = roundIds[index + 1]!;
      const first = previousReferenceRoundId(upper);
      if (first !== null && BigInt(first) > BigInt(lower)) {
        segments.push(Object.freeze({
          kind: "gap",
          firstRoundId: first,
          stopExclusiveRoundId: lower,
        }));
      }
    }
    if (continuationPhase === phaseId) continue;
    const lowest = roundIds.at(-1)!;
    const first = previousReferenceRoundId(lowest);
    if (first === null) continue;
    let stopExclusiveRoundId: ReferenceCompositeRoundId | null = null;
    if (traversal.retentionCutoffRoundId !== null) {
      const cutoffIdentity = parseReferenceCompositeRoundId(traversal.retentionCutoffRoundId);
      if (BigInt(phaseId) < BigInt(cutoffIdentity.phaseId)) continue;
      if (phaseId === cutoffIdentity.phaseId) {
        stopExclusiveRoundId = traversal.retentionCutoffRoundId;
      }
    }
    if (stopExclusiveRoundId === null || BigInt(first) > BigInt(stopExclusiveRoundId)) {
      segments.push(Object.freeze({
        kind: "gap",
        firstRoundId: first,
        stopExclusiveRoundId,
      }));
    }
  }

  segments.sort((left, right) =>
    BigInt(left.firstRoundId) === BigInt(right.firstRoundId)
      ? left.kind === right.kind ? 0 : left.kind === "continuation" ? -1 : 1
      : BigInt(left.firstRoundId) > BigInt(right.firstRoundId) ? -1 : 1);
  return Object.freeze({
    segments: Object.freeze(segments),
    remainingContinuation: traversal.backfillNextRoundId !== null,
    remainingGap: segments.some((segment) => segment.kind === "gap"),
  });
};

export const captureReferenceRoundObservation = (input: Readonly<{
  fact: ReferenceRoundFact;
  clock: CanonicalClock;
  source: ObservationAuthority;
  block: ChainAnchor;
}>): ReferenceRoundObservation => {
  const source = readObservationAuthority(input.source, input.clock);
  return deepFreezeValue(referenceRoundObservationSchema.parse({
    fact: input.fact,
    readEvidence: {
      observedAt: readCanonicalClock(input.clock),
      sourceOwner: source.owner,
      sourceClass: source.sourceClass,
      sourceReference: source.reference,
      block: input.block,
    },
  }));
};

const expectedSourcesForPair = (
  pair: ReferencePairManifestEntry,
  sources: readonly ReferenceRoundObservation[],
): boolean => exactSequence(sources.map((source) => source.fact.feedId), pair.contract.sourceIds);

export const deriveReferencePairValue = (
  pair: ReferencePairManifestEntry,
  sources: readonly ReferenceRoundObservation[],
): ExactRational => {
  const parsedPair = referencePairManifestEntrySchema.parse(pair);
  const parsedSources = sources.map((source) => referenceRoundObservationSchema.parse(source));
  if (!expectedSourcesForPair(parsedPair, parsedSources)) {
    throw new TypeError("Reference pair sources are incomplete or out of order.");
  }
  if (parsedSources.length === 1) return parsedSources[0]!.fact.value;
  const [base, quote] = parsedSources;
  if (base === undefined || quote === undefined) throw new TypeError("Reference cross sources are incomplete.");
  return createExactRational(
    BigInt(base.fact.value.numerator) * BigInt(quote.fact.value.denominator),
    BigInt(base.fact.value.denominator) * BigInt(quote.fact.value.numerator),
  );
};

const blockTimeMilliseconds = (blockTimestamp: string): number => Date.parse(blockTimestamp);
const sourceTimeMilliseconds = (source: ReferenceRoundObservation): number =>
  Number(source.fact.updatedAtUnixSeconds) * 1_000;
export const isReferenceObservationFresh = (
  source: ReferenceRoundObservation,
  blockTimestamp: string,
): boolean =>
  blockTimeMilliseconds(blockTimestamp) - sourceTimeMilliseconds(source) <=
    findReferenceFeed(source.fact.feedId).heartbeatSeconds * 1_000;

export const referencePriceInputSchema = jsonObject({ pairId: referenceSupportedPairIdSchema }).strict();
export type ReferencePriceInput = z.infer<typeof referencePriceInputSchema>;

const referencePriceCommon = {
  pair: referencePairManifestEntrySchema,
  block: chainAnchorSchema,
  mappingEvidence: referenceMarketMappingEvidenceSchema,
  sources: z.array(referenceRoundObservationSchema)
    .min(1)
    .max(referenceMarketLimits.maximumPairSources),
  warnings: z.array(referenceMarketWarningCodeSchema).length(referencePriceWarnings.length),
};
export const referencePriceSuccessSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("current"), ...referencePriceCommon, currentPrice: exactRationalSchema }).strict(),
  jsonObject({ status: z.literal("stale"), ...referencePriceCommon, lastObserved: exactRationalSchema }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    ...referencePriceCommon,
    reason: z.literal("derived_sources_not_fresh"),
  }).strict(),
]).superRefine((value, context) => {
  if (value.block.chainId !== productChainId || !expectedSourcesForPair(value.pair, value.sources)) {
    context.addIssue({ code: "custom", message: "Reference price sources do not match the pair and chain." });
    return;
  }
  if (canonicalSha256(value.mappingEvidence) !== canonicalSha256(referenceMarketMappingEvidence)) {
    context.addIssue({ code: "custom", message: "Reference price mapping evidence is inconsistent." });
  }
  if (value.sources.some((source) => canonicalSha256(source.readEvidence.block) !== canonicalSha256(value.block))) {
    context.addIssue({ code: "custom", message: "Reference price read evidence does not match its block." });
  }
  const blockTime = blockTimeMilliseconds(value.block.blockTimestamp);
  if (value.sources.some((source) => sourceTimeMilliseconds(source) > blockTime)) {
    context.addIssue({ code: "custom", message: "Reference price contains a future observation." });
  }
  const allFresh = value.sources.every((source) => isReferenceObservationFresh(source, value.block.blockTimestamp));
  const derived = value.pair.contract.sourceIds.length === 2;
  if (
    (value.status === "current" && !allFresh) ||
    (value.status === "stale" && (derived || allFresh)) ||
    (value.status === "unavailable" && (!derived || allFresh))
  ) {
    context.addIssue({ code: "custom", message: "Reference price freshness status is inconsistent." });
  }
  if (value.status !== "unavailable") {
    const expectedValue = deriveReferencePairValue(value.pair, value.sources);
    const actualValue = value.status === "current" ? value.currentPrice : value.lastObserved;
    if (!exactRationalsEqual(expectedValue, actualValue)) {
      context.addIssue({ code: "custom", message: "Reference price value is inconsistent with its sources." });
    }
  }
  if (!exactSequence(value.warnings, referencePriceWarnings)) {
    context.addIssue({ code: "custom", message: "Reference price warnings are inconsistent." });
  }
});
export type ReferencePriceSuccess = z.infer<typeof referencePriceSuccessSchema>;

export const referenceHistoryInputSchema = jsonObject({
  pairId: referenceSupportedPairIdSchema,
  window: referenceHistoryWindowSchema,
}).strict();
export type ReferenceHistoryInput = z.infer<typeof referenceHistoryInputSchema>;

export const referenceRoundPointerSchema = jsonObject({
  feedId: referenceFeedIdSchema,
  roundId: referenceCompositeRoundIdSchema,
}).strict();
export type ReferenceRoundPointer = z.infer<typeof referenceRoundPointerSchema>;

const candleSourcePointerSetSchema = z.array(referenceRoundPointerSchema)
  .min(1)
  .max(referenceMarketLimits.maximumPairSources);
const candleSourceSkewSecondsSchema = boundedDecimalSchema(
  BigInt(fixedReferenceFeedHeartbeatSeconds),
  5,
  false,
);
export const referenceCandleSchema = jsonObject({
  openedAt: utcTimestampSchema,
  closedAt: utcTimestampSchema,
  openBucket: z.boolean(),
  open: exactRationalSchema,
  high: exactRationalSchema,
  low: exactRationalSchema,
  close: exactRationalSchema,
  openSourcePointers: candleSourcePointerSetSchema,
  openSourceSkewSeconds: candleSourceSkewSecondsSchema,
  highSourcePointers: candleSourcePointerSetSchema,
  highSourceSkewSeconds: candleSourceSkewSecondsSchema,
  lowSourcePointers: candleSourcePointerSetSchema,
  lowSourceSkewSeconds: candleSourceSkewSecondsSchema,
  closeSourcePointers: candleSourcePointerSetSchema,
  closeSourceSkewSeconds: candleSourceSkewSecondsSchema,
}).strict().superRefine((value, context) => {
  const openedAt = Date.parse(value.openedAt);
  const closedAt = Date.parse(value.closedAt);
  if (openedAt >= closedAt) {
    context.addIssue({ code: "custom", message: "Reference candle interval is invalid." });
  }
  if (
    compareExactRationals(value.low, value.open) > 0 ||
    compareExactRationals(value.low, value.close) > 0 ||
    compareExactRationals(value.high, value.open) < 0 ||
    compareExactRationals(value.high, value.close) < 0 ||
    compareExactRationals(value.low, value.high) > 0
  ) {
    context.addIssue({ code: "custom", message: "Reference candle bounds are inconsistent." });
  }
  for (const pointers of [
    value.openSourcePointers,
    value.highSourcePointers,
    value.lowSourcePointers,
    value.closeSourcePointers,
  ]) {
    const identities = pointers.map((pointer) => `${pointer.feedId}:${pointer.roundId}`);
    if (new Set(identities).size !== identities.length) {
      context.addIssue({ code: "custom", message: "Reference candle source pointers are invalid." });
    }
  }
});
export type ReferenceCandle = z.infer<typeof referenceCandleSchema>;

export const referenceHistoryLimitationCodes = Object.freeze([
  "source_history_not_exhaustive",
  "traversal_incomplete",
  "phase_boundary",
  "malformed_round",
  "retention_limited",
] as const);
export const referenceHistoryLimitationCodeSchema = z.enum(referenceHistoryLimitationCodes);
export type ReferenceHistoryLimitationCode = z.infer<typeof referenceHistoryLimitationCodeSchema>;

export const referenceHistoryCoverageSchema = jsonObject({
  basis: z.literal("observed_rounds"),
  requestedStart: utcTimestampSchema,
  requestedEnd: utcTimestampSchema,
  emptyBucketStarts: z.array(utcTimestampSchema)
    .max(maximumReferenceHistoryWindowDefinition.maximumBuckets),
  limitations: z.array(referenceHistoryLimitationCodeSchema)
    .min(1)
    .max(referenceHistoryLimitationCodes.length),
}).strict().superRefine((value, context) => {
  const requestedStart = Date.parse(value.requestedStart);
  const requestedEnd = Date.parse(value.requestedEnd);
  if (requestedStart >= requestedEnd) {
    context.addIssue({ code: "custom", message: "Reference history request interval is invalid." });
    return;
  }
  const empty = value.emptyBucketStarts;
  if (new Set(empty).size !== empty.length || empty.some((timestamp) => {
    const time = Date.parse(timestamp);
    return time < requestedStart || time >= requestedEnd;
  })) {
    context.addIssue({ code: "custom", message: "Reference history empty buckets are invalid." });
  }
  const expectedLimitations = referenceHistoryLimitationCodes.filter((limitation) =>
    value.limitations.includes(limitation));
  if (
    value.limitations[0] !== "source_history_not_exhaustive" ||
    new Set(value.limitations).size !== value.limitations.length ||
    !exactSequence(value.limitations, expectedLimitations)
  ) {
    context.addIssue({ code: "custom", message: "Reference history limitations are invalid." });
  }
});
export type ReferenceHistoryCoverage = z.infer<typeof referenceHistoryCoverageSchema>;

const historyCommon = {
  pair: referencePairManifestEntrySchema,
  window: referenceHistoryWindowSchema,
  block: chainAnchorSchema,
  mappingEvidence: referenceMarketMappingEvidenceSchema,
  coverage: referenceHistoryCoverageSchema,
  candles: z.array(referenceCandleSchema).max(maximumReferenceHistoryWindowDefinition.maximumBuckets),
  sourceObservations: z.array(referenceRoundObservationSchema)
    .max(referenceMarketLimits.historySourceObservations),
  warnings: z.array(referenceMarketWarningCodeSchema).min(referenceHistoryWarnings.length)
    .max(referenceHistoryWarnings.length + 1),
};
export const referenceHistorySuccessSchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("partial"),
    ...historyCommon,
    candles: z.array(referenceCandleSchema)
      .min(1)
      .max(maximumReferenceHistoryWindowDefinition.maximumBuckets),
  }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    ...historyCommon,
    candles: z.array(referenceCandleSchema).length(0),
    sourceObservations: z.array(referenceRoundObservationSchema).length(0),
    reason: z.literal("no_valid_observation"),
  }).strict(),
]).superRefine((value, context) => {
  if (value.block.chainId !== productChainId) {
    context.addIssue({ code: "custom", message: "Reference history chain is inconsistent." });
  }
  if (canonicalSha256(value.mappingEvidence) !== canonicalSha256(referenceMarketMappingEvidence)) {
    context.addIssue({ code: "custom", message: "Reference history mapping evidence is inconsistent." });
  }
  if (value.candles.length > referenceMarketLimits.candleBuckets[value.window]) {
    context.addIssue({ code: "custom", message: "Reference history exceeds the selected window." });
  }
  const requestedStart = Date.parse(value.coverage.requestedStart);
  const requestedEnd = Date.parse(value.coverage.requestedEnd);
  const windowDefinition = referenceHistoryWindowDefinitions[value.window];
  if (
    value.coverage.requestedEnd !== value.block.blockTimestamp ||
    requestedEnd - requestedStart !== windowDefinition.windowMilliseconds ||
    value.coverage.emptyBucketStarts.length > referenceMarketLimits.candleBuckets[value.window]
  ) {
    context.addIssue({ code: "custom", message: "Reference history window does not match its block anchor." });
  }
  const bucketMilliseconds = windowDefinition.bucketMilliseconds;
  const firstBucketStart = Math.ceil(requestedStart / bucketMilliseconds) * bucketMilliseconds;
  for (const candle of value.candles) {
    const openedAt = Date.parse(candle.openedAt);
    const closedAt = Date.parse(candle.closedAt);
    if (
      openedAt < firstBucketStart || closedAt > requestedEnd ||
      openedAt % bucketMilliseconds !== 0 ||
      (candle.openBucket
        ? closedAt !== requestedEnd || requestedEnd >= openedAt + bucketMilliseconds
        : closedAt - openedAt !== bucketMilliseconds)
    ) {
      context.addIssue({ code: "custom", message: "Reference candle does not match the selected UTC window." });
    }
  }
  if (value.coverage.emptyBucketStarts.some((timestamp) =>
    Date.parse(timestamp) < firstBucketStart || Date.parse(timestamp) % bucketMilliseconds !== 0)) {
    context.addIssue({ code: "custom", message: "Reference history empty bucket is not a UTC bucket start." });
  }
  const expectedBucketStarts: number[] = [];
  for (let openedAt = firstBucketStart; openedAt < requestedEnd; openedAt += bucketMilliseconds) {
    expectedBucketStarts.push(openedAt);
  }
  const candleBucketStarts = value.candles.map((candle) => Date.parse(candle.openedAt));
  const emptyBucketStarts = value.coverage.emptyBucketStarts.map(Date.parse);
  const representedBucketStarts = [...candleBucketStarts, ...emptyBucketStarts].sort((left, right) => left - right);
  if (
    new Set(candleBucketStarts).size !== candleBucketStarts.length ||
    candleBucketStarts.some((openedAt) => emptyBucketStarts.includes(openedAt)) ||
    !exactSequence(representedBucketStarts, expectedBucketStarts)
  ) {
    context.addIssue({
      code: "custom",
      message: "Reference candles and empty buckets do not partition the represented buckets.",
    });
  }
  const observationKey = (observation: ReferenceRoundObservation): string =>
    `${observation.fact.feedId}:${observation.fact.roundId}`;
  const pointerKey = (pointer: ReferenceRoundPointer): string => `${pointer.feedId}:${pointer.roundId}`;
  const observationKeys = value.sourceObservations.map(observationKey);
  const observationByKey = new Map(value.sourceObservations.map((observation) =>
    [observationKey(observation), observation] as const));
  if (observationByKey.size !== value.sourceObservations.length) {
    context.addIssue({ code: "custom", message: "Reference history source observations are not unique." });
  }
  const usedKeys: string[] = [];
  const usedKeySet = new Set<string>();
  const pointFields = [
    ["open", "openSourcePointers", "openSourceSkewSeconds"],
    ["high", "highSourcePointers", "highSourceSkewSeconds"],
    ["low", "lowSourcePointers", "lowSourceSkewSeconds"],
    ["close", "closeSourcePointers", "closeSourceSkewSeconds"],
  ] as const;
  for (const candle of value.candles) {
    const openedAt = Date.parse(candle.openedAt);
    const closedAt = Date.parse(candle.closedAt);
    for (const [valueField, pointersField, skewField] of pointFields) {
      const pointers = candle[pointersField];
      if (!exactSequence(pointers.map((pointer) => pointer.feedId), value.pair.contract.sourceIds)) {
        context.addIssue({ code: "custom", message: "Reference candle source pointers do not match the pair." });
        continue;
      }
      const sources = pointers.map((pointer) => observationByKey.get(pointerKey(pointer)));
      if (sources.some((source) => source === undefined)) {
        context.addIssue({ code: "custom", message: "Reference candle source pointer is unresolved." });
        continue;
      }
      const resolved = sources as ReferenceRoundObservation[];
      for (const pointer of pointers) {
        const key = pointerKey(pointer);
        if (!usedKeySet.has(key)) {
          usedKeySet.add(key);
          usedKeys.push(key);
        }
      }
      const times = resolved.map((source) => Number(source.fact.updatedAtUnixSeconds) * 1_000);
      const pointTime = Math.max(...times);
      const expectedSkew = Math.floor((pointTime - Math.min(...times)) / 1_000).toString(10);
      const expectedValue = deriveReferencePairValue(value.pair, resolved);
      if (
        pointTime < openedAt || (candle.openBucket ? pointTime > closedAt : pointTime >= closedAt) ||
        resolved.some((source, index) => pointTime - (times[index] ?? pointTime) >
          findReferenceFeed(source.fact.feedId).heartbeatSeconds * 1_000) ||
        candle[skewField] !== expectedSkew ||
        !exactRationalsEqual(candle[valueField], expectedValue)
      ) {
        context.addIssue({ code: "custom", message: "Reference candle source evidence is inconsistent." });
      }
    }
  }
  if (!exactSequence(observationKeys, usedKeys)) {
    context.addIssue({ code: "custom", message: "Reference history source observations are unused or out of order." });
  }
  for (let index = 1; index < value.candles.length; index += 1) {
    if (value.candles[index - 1]!.openedAt >= value.candles[index]!.openedAt) {
      context.addIssue({ code: "custom", message: "Reference candles are not in chronological order." });
    }
  }
  if (value.candles.some((candle, index) => candle.openBucket && index !== value.candles.length - 1)) {
    context.addIssue({ code: "custom", message: "Only the final reference candle may be open." });
  }
  const expectedWarnings = value.status === "partial"
    ? [...referenceHistoryWarnings, "partial_history"]
    : referenceHistoryWarnings;
  if (!exactSequence(value.warnings, expectedWarnings)) {
    context.addIssue({ code: "custom", message: "Reference history warnings are inconsistent." });
  }
});
export type ReferenceHistorySuccess = z.infer<typeof referenceHistorySuccessSchema>;

export const referenceWatchlistRevisionSchema =
  canonicalBase64UrlSchema(referenceMarketLimits.revisionBytes);
export type ReferenceWatchlistRevision = z.infer<typeof referenceWatchlistRevisionSchema>;
export const initialReferenceWatchlistRevision =
  referenceWatchlistRevisionSchema.parse("AAAAAAAAAAAAAAAAAAAAAA");

export const referenceWatchlistSuccessSchema = jsonObject({
  account: jsonObject({ chainId: z.literal(productChainId), address: evmAddressSchema }).strict(),
  revision: referenceWatchlistRevisionSchema,
  entries: z.array(referencePairManifestEntrySchema).max(referenceMarketLimits.watchlistEntries),
}).strict().superRefine((value, context) => {
  const ids = value.entries.map((entry) => entry.pairId);
  if (new Set(ids).size !== ids.length || value.entries.some((entry) => !exactPairEntry(entry))) {
    context.addIssue({ code: "custom", message: "Reference watchlist entries are invalid." });
  }
});
export type ReferenceWatchlistSuccess = z.infer<typeof referenceWatchlistSuccessSchema>;

export const referenceWatchlistInputSchema = jsonObject({}).strict();
export const referenceWatchlistMutationInputSchema = jsonObject({
  pairId: referenceSupportedPairIdSchema,
  expectedRevision: referenceWatchlistRevisionSchema,
}).strict();
export type ReferenceWatchlistMutationInput = z.infer<typeof referenceWatchlistMutationInputSchema>;
export const referenceWatchlistReorderInputSchema = jsonObject({
  pairIds: z.array(referenceSupportedPairIdSchema).max(referenceMarketLimits.watchlistEntries),
  expectedRevision: referenceWatchlistRevisionSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.pairIds).size !== value.pairIds.length) {
    context.addIssue({ code: "custom", message: "Reference watchlist order contains duplicates." });
  }
});
export type ReferenceWatchlistReorderInput = z.infer<typeof referenceWatchlistReorderInputSchema>;

export const referenceMarketReadFailureCodes = Object.freeze([
  "chain_response_unavailable",
  "internal_error",
  "invalid_input",
  "rate_limited",
  "request_aborted",
  "result_too_large",
  "runtime_busy",
  "runtime_state_unavailable",
  "source_inconsistent",
  "source_unavailable",
] as const);
export const referenceWatchlistReadFailureCodes = Object.freeze([
  "internal_error",
  "invalid_input",
  "request_aborted",
  "result_too_large",
  "runtime_busy",
  "runtime_state_unavailable",
  "state_conflict",
  "wallet_not_connected",
  "wallet_session_unusable",
] as const);
export const referenceWatchlistMutationCommonFailureCodes = Object.freeze([
  ...referenceWatchlistReadFailureCodes,
] as const);
