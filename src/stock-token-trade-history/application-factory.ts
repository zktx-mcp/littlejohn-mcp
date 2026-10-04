import {
  createObservationAuthority,
  sourceReferenceSchema,
  type CanonicalClock,
  type ObservationAuthority,
} from "../core/index.js";
import { officialAssetSourceDefinition } from "../registry/index.js";
import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import { createApplicationLifecycle } from "../runtime/application-lifecycle.js";
import type { OwnedResourceRegistry } from "../runtime/resource-ownership.js";
import type { RuntimeSupportManifest } from "../runtime/support-manifest.js";
import { createStockTokenTradeHistoryApplication } from "./application.js";
import { createGitHubStockTokenTradeHistoryTransport } from "./github-source.js";
import type {
  StockTokenTradeHistoryApplicationDependencies,
  StockTokenTradeHistoryApplicationPort,
} from "./ports.js";
import { createStockTokenTradeHistorySource } from "./source.js";
import { stockTokenTradeHistoryProducerAdmission } from "./source-contract.js";
import { extendStockTokenTradeHistorySupportManifest } from "./support.js";

export interface StockTokenTradeHistoryObservationAuthorities {
  readonly officialAsset: ObservationAuthority;
  readonly archive: ObservationAuthority;
}

export const createStockTokenTradeHistoryObservationAuthorities = (
  clock: CanonicalClock,
): StockTokenTradeHistoryObservationAuthorities => Object.freeze({
  officialAsset: createObservationAuthority({
    clock,
    sourceClass: "web_api",
    owner: officialAssetSourceDefinition.sourceOwner,
    reference: sourceReferenceSchema.parse({
      kind: "public",
      sourceId: officialAssetSourceDefinition.sourceId,
      uri: officialAssetSourceDefinition.sourceUri,
    }),
  }),
  archive: createObservationAuthority({
    clock,
    sourceClass: "public_dataset",
    owner: "stelis-dev",
    reference: sourceReferenceSchema.parse({
      kind: "public",
      sourceId: "robinhood-stock-token-index",
      uri: stockTokenTradeHistoryProducerAdmission.publicContractReference,
    }),
  }),
});

export interface StockTokenTradeHistoryOwnerApplication
  extends StockTokenTradeHistoryApplicationPort {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: RuntimeSupportManifest;
  close(): Promise<void>;
}

export interface StockTokenTradeHistoryApplicationFactoryInput
  extends Omit<StockTokenTradeHistoryApplicationDependencies, "source" | "admission"> {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: RuntimeSupportManifest;
  readonly startupResources: OwnedResourceRegistry;
  readonly now?: () => Date;
}

export const createStockTokenTradeHistoryApplicationFactory = async (
  input: StockTokenTradeHistoryApplicationFactoryInput,
): Promise<StockTokenTradeHistoryOwnerApplication> => {
  const lifecycle = createApplicationLifecycle();
  const lifecycleOwnership = input.startupResources.register(lifecycle);
  try {
    const source = createStockTokenTradeHistorySource({
      transport: createGitHubStockTokenTradeHistoryTransport({}),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    lifecycle.resources.register(source);
    const application = createStockTokenTradeHistoryApplication({
      admission: lifecycle.admission,
      chainInvocations: input.chainInvocations,
      currentBlockReads: input.currentBlockReads,
      officialAssets: input.officialAssets,
      officialAssetReads: input.officialAssetReads,
      protocolReads: input.protocolReads,
      source,
      invocationAuthority: input.invocationAuthority,
      invocationPorts: input.invocationPorts,
      officialAssetObservationAuthority: input.officialAssetObservationAuthority,
      archiveObservationAuthority: input.archiveObservationAuthority,
    });
    lifecycle.resources.register(application);
    const result = Object.freeze({
      routes: input.routes,
      supportManifest: extendStockTokenTradeHistorySupportManifest(input.supportManifest),
      binding: application.binding,
      close: lifecycle.close,
    });
    lifecycle.open();
    lifecycleOwnership.transfer();
    return result;
  } catch (startupError) {
    try {
      await lifecycle.close();
      lifecycleOwnership.transfer();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Stock Token trade-history startup and cleanup failed.",
      );
    }
    throw startupError;
  }
};
