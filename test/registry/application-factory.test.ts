import { describe, expect, it } from "vitest";
import { createRegistryOwnerApplication } from "../../src/registry/application-factory.js";
import { officialAssetSourceUnavailable } from "../../src/registry/official-asset-source-contract.js";
import { createResourceOwnershipScope } from "../../src/runtime/resource-ownership.js";
import type { RuntimeRouteRegistry } from "../../src/runtime/http-routing.js";

describe("Registry application ownership", () => {
  it("assembles without Token and drains its active source before closing", async () => {
    const startup = createResourceOwnershipScope();
    let sourceSignal: AbortSignal | undefined;
    let sourceAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { sourceAborted = resolve; });
    let releaseSource!: () => void;
    const pending = new Promise<void>((resolve) => { releaseSource = resolve; });
    const registry = createRegistryOwnerApplication({
      routes: {} as RuntimeRouteRegistry,
      startupResources: startup.resources,
      signal: new AbortController().signal,
      source: { async read(signal) {
        sourceSignal = signal;
        signal.addEventListener("abort", sourceAborted, { once: true });
        await pending;
        return officialAssetSourceUnavailable("source_unavailable");
      } },
      store: {
        readSnapshot: () => undefined,
        replaceSnapshot: () => { throw new Error("Unavailable source must not commit."); },
      },
    });
    expect(startup.empty).toBe(true);
    const read = registry.officialAssets.synchronize(new AbortController().signal);
    const close = registry.close();
    expect(registry.close()).toBe(close);
    let drained = false;
    void close.then(() => { drained = true; });
    await aborted;
    expect(sourceSignal?.aborted).toBe(true);
    expect(drained).toBe(false);
    releaseSource();
    await expect(read).resolves.toMatchObject({ status: "unavailable", reason: "runtime_state_unavailable" });
    await close;
    await expect(registry.officialAssets.synchronize(new AbortController().signal))
      .resolves.toMatchObject({ status: "unavailable", reason: "runtime_state_unavailable" });
  });
});
