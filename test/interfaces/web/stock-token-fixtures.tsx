import {
  accountAssetApplicationContracts,
  accountAssetOverviewQueryContract,
} from "../../../src/account-assets/browser.js";
import { createAccountAssetAmount } from "../../../src/account-assets/contracts.js";
import {
  officialAssetCandidateListDigest,
} from "../../../src/registry/official-asset-contract.js";
import {
  evmChainIdSchema,
  parseEvmAddressInput,
  parseHash32,
  requiredErc8056ObservationSchema,
  scaledUiAmountScale,
  tokenStandardObservationResultSchema,
  utcTimestampSchema,
} from "../../../src/core/browser.js";
import type {
  StockTokenAddContext,
} from "../../../src/interfaces/web/stock-token-task-presentation.js";
import {
  officialAssetSourceDefinition,
  officialAssetSnapshotRevisionSchema,
  stockFactoryAdmissionManifest,
} from "../../../src/registry/browser.js";
import {
  tokenSelectionRevisionSchema,
  tokenSelectionSetRevisionSchema,
} from "../../../src/token-catalog/browser.js";

export const stockTokenChainId = evmChainIdSchema.parse("eip155:4663");
export const stockTokenAccount = Object.freeze({
  chainId: stockTokenChainId,
  address: parseEvmAddressInput(`0x${"34".repeat(20)}`),
});
export const stockTokenAddress =
  parseEvmAddressInput(`0x${"12".repeat(20)}`);
export const stockTokenAsset = Object.freeze({
  kind: "erc20" as const,
  chainId: stockTokenChainId,
  address: stockTokenAddress,
});
export const stockTokenObservedAt =
  utcTimestampSchema.parse("2026-07-21T00:00:00.000Z");
export const stockTokenOfficialRevision =
  officialAssetSnapshotRevisionSchema.parse(
    Buffer.alloc(16, 4).toString("base64url"),
  );
const stockTokenSelectionSetRevision =
  tokenSelectionSetRevisionSchema.parse(
    Buffer.alloc(16, 3).toString("base64url"),
  );
const stockTokenSelectionRevision =
  tokenSelectionRevisionSchema.parse(
    Buffer.alloc(16, 1).toString("base64url"),
  );
export const stockTokenAssetUid = parseHash32(`0x${"56".repeat(32)}`);
export const stockTokenCandidate = Object.freeze({
  assetUid: stockTokenAssetUid,
  contractAddress: stockTokenAddress,
  sourceName: "Example Stock Token",
  sourceSymbol: "EXT",
});
export const stockTokenViewRevision = Object.freeze({
  officialSnapshotStatus: "current" as const,
  officialSnapshotRevision: stockTokenOfficialRevision,
  selectionSetRevision: stockTokenSelectionSetRevision,
});
export const stockTokenAddContext: StockTokenAddContext = Object.freeze({
  taskId: 1,
  form: Object.freeze({
    account: Object.freeze({
      ...stockTokenAccount,
      connectionRevision: "1",
    }),
    viewRevision: stockTokenViewRevision,
    candidates: [stockTokenCandidate],
  }),
  candidate: stockTokenCandidate,
});
export const stockTokenBlock = Object.freeze({
  chainId: stockTokenChainId,
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: utcTimestampSchema.parse("2026-07-18T00:00:00.000Z"),
});
export const stockTokenSelection = Object.freeze({
  account: stockTokenAccount,
  asset: stockTokenAsset,
  included: true,
  revision: stockTokenSelectionRevision,
  createdAt: stockTokenObservedAt,
  updatedAt: stockTokenObservedAt,
});
const requiredStandards = requiredErc8056ObservationSchema.parse({
  asset: stockTokenAsset,
  block: stockTokenBlock,
  erc165: { standardId: "erc165", status: "not_supported" },
  erc8056: { standardId: "erc8056", status: "unknown" },
  pendingMultiplier: {
    standardId: "erc8056_pending_multiplier",
    status: "unknown",
  },
});

export const stockTokenExactResult =
  accountAssetApplicationContracts.exact.parsePublicSuccess(
    {
      asset: stockTokenAsset,
      viewRevision: stockTokenViewRevision,
    },
    {
      account: stockTokenAccount,
      block: stockTokenBlock,
      viewRevision: stockTokenViewRevision,
      asset: {
        kind: "erc20",
        selection: stockTokenSelection,
        name: { status: "available", value: "Example Stock Token" },
        symbol: { status: "available", value: "EXT" },
        classification: {
          kind: "robinhood_stock_token",
          snapshot: {
            sourceUri: officialAssetSourceDefinition.sourceUri,
            sourceObservedAt: stockTokenObservedAt,
            rawResponseDigest: stockTokenBlock.blockHash,
            memberSetDigest: stockTokenBlock.blockHash,
            revision: stockTokenOfficialRevision,
          },
          member: stockTokenCandidate,
          verification: {
            assetUid: stockTokenAssetUid,
            contractAddress: stockTokenAddress,
            block: stockTokenBlock,
            proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
            proxyCodeHash: stockFactoryAdmissionManifest.proxyCodeHash,
            implementationAddress:
              stockFactoryAdmissionManifest.implementationAddress,
            implementationCodeHash:
              stockFactoryAdmissionManifest.implementationCodeHash,
            tokenCodeHash: stockTokenBlock.blockHash,
          },
        },
        amount: {
          raw: "0",
          decimals: "0",
          formattedRaw: "0",
          uiAdjusted: null,
          formattedUiAdjusted: null,
        },
        requiredStandards,
      },
      totalSupply: "100",
      standards: tokenStandardObservationResultSchema.parse({
        asset: stockTokenAsset,
        account: stockTokenAccount,
        block: stockTokenBlock,
        standards: [
          { standardId: "erc20_read_surface", status: "observed" },
          { standardId: "erc165", status: "not_supported" },
          { standardId: "erc8056", status: "unknown" },
          {
            standardId: "erc8056_pending_multiplier",
            status: "unknown",
          },
          { standardId: "erc8056_conversion", status: "unknown" },
          { standardId: "erc8056_balances", status: "unknown" },
        ],
      }),
    },
  );

const stockTokenBalanceRequiredStandards = requiredErc8056ObservationSchema.parse({
  asset: stockTokenAsset,
  block: stockTokenBlock,
  erc165: { standardId: "erc165", status: "supported" },
  erc8056: { standardId: "erc8056", status: "supported" },
  pendingMultiplier: {
    standardId: "erc8056_pending_multiplier",
    status: "supported",
  },
  values: {
    currentMultiplier: scaledUiAmountScale,
    pendingMultiplier: scaledUiAmountScale,
    pendingEffectiveAt: "0",
  },
});

export const stockTokenExactBalanceInconsistentResult =
  accountAssetApplicationContracts.exact.parsePublicSuccess(
    {
      asset: stockTokenAsset,
      viewRevision: stockTokenViewRevision,
    },
    {
      ...stockTokenExactResult,
      asset: {
        ...stockTokenExactResult.asset,
        amount: createAccountAssetAmount({
          raw: "5",
          decimals: "0",
          multiplier: scaledUiAmountScale,
        }),
        requiredStandards: stockTokenBalanceRequiredStandards,
      },
      standards: tokenStandardObservationResultSchema.parse({
        asset: stockTokenAsset,
        account: stockTokenAccount,
        block: stockTokenBlock,
        standards: [
          { standardId: "erc20_read_surface", status: "observed" },
          { standardId: "erc165", status: "supported" },
          { standardId: "erc8056", status: "supported" },
          {
            standardId: "erc8056_pending_multiplier",
            status: "supported",
          },
          { standardId: "erc8056_conversion", status: "not_supported" },
          { standardId: "erc8056_balances", status: "inconsistent" },
        ],
        requiredErc8056: stockTokenBalanceRequiredStandards.values,
        balanceOfUi: "6",
        calculatedBalance: {
          status: "available",
          raw: "5",
          multiplier: scaledUiAmountScale,
          scale: scaledUiAmountScale,
          adjustedRaw: "5",
        },
      }),
    },
  );

export const stockTokenOverviewResult =
  accountAssetOverviewQueryContract.parsePublicSuccess(
    {},
    {
      account: stockTokenAccount,
      block: stockTokenBlock,
      viewRevision: stockTokenViewRevision,
      native: {
        kind: "native",
        asset: { kind: "native", chainId: stockTokenChainId },
        rawBalance: "0",
        classification: "native",
      },
      stockTokens: {
        status: "current",
        candidateListDigest: officialAssetCandidateListDigest([
          stockTokenCandidate,
        ]),
        members: [{
          status: "selected",
          asset: stockTokenExactResult.asset,
        }],
      },
    },
  );
