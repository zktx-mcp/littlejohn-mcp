import {
  createObservationAuthority,
  sourceReferenceSchema,
  type CanonicalClock,
  type ObservationAuthority,
} from "../core/index.js";
import { officialAssetSourceDefinition } from "../registry/index.js";
import type { RuntimeRouteRegistry } from "../runtime/http-routing.js";
import {
  createResourceOwnershipScope,
  type OwnedResourceRegistry,
} from "../runtime/resource-ownership.js";
import type {
  AccountAssetRuntimeSupportManifest,
  StockTokenTradeHistoryRuntimeSupportManifest,
} from "../runtime/support-manifest.js";
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
    owner: "Robinhood",
    reference: sourceReferenceSchema.parse({
      kind: "public",
      sourceId: "robinhood-official-assets",
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
  readonly supportManifest: StockTokenTradeHistoryRuntimeSupportManifest;
  close(): Promise<void>;
}

export interface StockTokenTradeHistoryApplicationFactoryInput
  extends Omit<StockTokenTradeHistoryApplicationDependencies, "source"> {
  readonly routes: RuntimeRouteRegistry;
  readonly supportManifest: AccountAssetRuntimeSupportManifest;
  readonly startupResources: OwnedResourceRegistry;
  readonly now?: () => Date;
}

export const createStockTokenTradeHistoryApplicationFactory = async (
  input: StockTokenTradeHistoryApplicationFactoryInput,
): Promise<StockTokenTradeHistoryOwnerApplication> => {
  const lifecycle = createResourceOwnershipScope();
  const lifecycleOwnership = input.startupResources.register(lifecycle);
  let state: "starting" | "open" | "closing" | "closed" = "starting";
  let activeClose: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (state === "closed") return Promise.resolve();
    if (activeClose !== undefined) return activeClose;
    state = "closing";
    let tracked!: Promise<void>;
    tracked = lifecycle.close().then(() => {
      state = "closed";
    }).finally(() => {
      if (activeClose === tracked) activeClose = undefined;
    });
    activeClose = tracked;
    return tracked;
  };
  try {
    const source = createStockTokenTradeHistorySource({
      transport: createGitHubStockTokenTradeHistoryTransport({}),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    lifecycle.resources.register(source);
    const application = createStockTokenTradeHistoryApplication({
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
    lifecycle.seal();
    const result = Object.freeze({
      routes: input.routes,
      supportManifest: extendStockTokenTradeHistorySupportManifest(input.supportManifest),
      binding: application.binding,
      close,
    });
    state = "open";
    lifecycleOwnership.transfer();
    return result;
  } catch (startupError) {
    if (!lifecycle.sealed) lifecycle.seal();
    try {
      await close();
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
