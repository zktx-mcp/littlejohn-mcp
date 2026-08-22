import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  accountAssetApplicationContracts,
  accountAssetInterfaceErrorMappings,
} from "../../src/account-assets/index.js";
import { getCapabilityDefinitionSnapshot } from "../../src/core/index.js";
import {
  accountAssetInterfaceBindingList,
  declaredCliCommandIdentities,
  declaredMcpToolNames,
  interfaceReadCapabilityRegistry,
  readInterfaceIdentities,
  marketPortfolioInterfaceBindingList,
  tokenCatalogInterfaceBindingList,
} from "../../src/interfaces/identities.js";
import { LocalOperationClient } from "../../src/interfaces/operation-client.js";
import {
  operationCliCommandIdentities,
  operationControlResources,
  operationInterfaceBindingList,
  operationInterfaceBindings,
  operationMcpToolNames,
} from "../../src/interfaces/operation-bindings.js";
import { resolveLocalOperationIdentity } from "../../src/interfaces/local-operation.js";
import { createMcpToolRegistry, type McpRuntimePort } from "../../src/interfaces/mcp.js";
import { extendOperationRoutes } from "../../src/interfaces/operation-routes.js";
import { createControlCredentialVerifier, loadOrCreateControlCredential } from "../../src/runtime/control-credential.js";
import { createRuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  marketPortfolioApplicationContracts,
  marketPortfolioErrorRegistry,
  marketPortfolioInterfaceErrorMappings,
  type MarketPortfolioApplicationPort,
} from "../../src/market-portfolio/index.js";
import {
  tokenCatalogApplicationContracts,
  tokenCatalogErrorRegistry,
  type TokenCatalogManagementApplicationPort,
} from "../../src/token-catalog/index.js";
import type { WalletManagementPort } from "../../src/wallet/contracts.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

const unreachableRuntime = Object.freeze({
  async dispatchRuntimeRequest(): Promise<never> {
    throw new Error("The registry test must not dispatch a runtime request.");
  },
  async openOwnerSession(): Promise<never> {
    throw new Error("The registry test must not open an owner session.");
  },
}) as McpRuntimePort;

const routeRegistry = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-operation-bindings-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const credential = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return extendOperationRoutes({
    routes: createRuntimeRouteRegistry({
      controlVerifier: createControlCredentialVerifier(credential),
    }),
    wallet: Object.freeze({}) as WalletManagementPort,
    token: Object.freeze({}) as TokenCatalogManagementApplicationPort,
    markets: Object.freeze({}) as MarketPortfolioApplicationPort,
  });
};

describe("operation interface binding authority", () => {
  it("retains each surviving read contract and derives its public identities without copies", () => {
    expect(interfaceReadCapabilityRegistry.values()).toEqual(
      readInterfaceIdentities.map((identity) => identity.definition),
    );
    for (const identity of readInterfaceIdentities) {
      expect(interfaceReadCapabilityRegistry.owns(identity.definition)).toBe(true);
      expect(identity.capabilityId).toBe(
        getCapabilityDefinitionSnapshot(identity.definition).capabilityId,
      );
      expect(declaredMcpToolNames.filter((name) => name === identity.mcp.name)).toHaveLength(1);
      expect(declaredCliCommandIdentities.filter((entry) =>
        entry.domain === identity.cli.domain && entry.command === identity.cli.command,
      )).toHaveLength(1);
    }

    expect(accountAssetInterfaceBindingList.map((binding) => binding.contract)).toEqual([
      accountAssetApplicationContracts.collection,
      accountAssetApplicationContracts.exact,
    ]);
    for (const binding of accountAssetInterfaceBindingList) {
      expect(binding.responseAuthority.applicationErrors).toBe(tokenCatalogErrorRegistry);
      expect(binding.responseAuthority.interfaceMappings).toBe(accountAssetInterfaceErrorMappings);
    }
    for (const binding of marketPortfolioInterfaceBindingList) {
      expect(binding.contract).toBe(marketPortfolioApplicationContracts[binding.action]);
      expect(binding.responseAuthority.applicationErrors).toBe(marketPortfolioErrorRegistry);
      expect(binding.responseAuthority.interfaceMappings).toBe(marketPortfolioInterfaceErrorMappings);
    }
    expect(tokenCatalogInterfaceBindingList.map((binding) => binding.contract)).toEqual([
      tokenCatalogApplicationContracts.selection,
      tokenCatalogApplicationContracts.selections,
    ]);

    for (const binding of [
      ...accountAssetInterfaceBindingList,
      ...marketPortfolioInterfaceBindingList,
      ...tokenCatalogInterfaceBindingList,
    ]) {
      if (binding.mcp !== undefined) {
        expect(declaredMcpToolNames.filter((name) => name === binding.mcp?.name)).toHaveLength(1);
      }
      if (binding.cli !== undefined) {
        expect(declaredCliCommandIdentities.filter((entry) =>
          entry.domain === binding.cli?.domain && entry.command === binding.cli?.command,
        )).toHaveLength(1);
      }
    }
  });

  it("derives MCP and CLI identities from one closed operation binding list", async () => {
    expect(operationInterfaceBindingList).toEqual(Object.values(operationInterfaceBindings));
    expect(new Set(operationInterfaceBindingList).size).toBe(operationInterfaceBindingList.length);
    expect(Object.keys(operationInterfaceBindings)).toEqual([
      "walletReview",
      "walletConnect",
      "walletDisconnect",
      "walletOperation",
      "walletCancel",
      "tokenReview",
      "tokenAdd",
      "tokenRemove",
      "tokenOperation",
      "watchlistReview",
      "watchlistAdd",
      "watchlistRemove",
      "watchlistReorder",
      "watchlistOperation",
    ]);

    const expectedMcpNames = operationInterfaceBindingList.map((binding) => binding.mcp.name);
    expect(operationMcpToolNames).toEqual(expectedMcpNames);
    for (const name of expectedMcpNames) {
      expect(declaredMcpToolNames.filter((candidate) => candidate === name)).toHaveLength(1);
    }

    const expectedCli = operationInterfaceBindingList.flatMap((binding) =>
      binding.cli === undefined ? [] : [binding.cli]);
    expect(operationCliCommandIdentities).toEqual(expectedCli);
    for (const identity of expectedCli) {
      expect(declaredCliCommandIdentities.filter((candidate) =>
        candidate.domain === identity.domain && candidate.command === identity.command,
      )).toHaveLength(1);
    }

    const client = new LocalOperationClient({ ownerSessions: unreachableRuntime });
    try {
      const definitions = createMcpToolRegistry(unreachableRuntime, client).values();
      for (const binding of operationInterfaceBindingList) {
        const definition = definitions.find((candidate) => candidate.name === binding.mcp.name);
        expect(definition).toBeDefined();
        expect(definition?.operationBinding).toBe(binding);
        expect(definition?.visibility).toEqual(binding.mcp.visibility);
        expect(definition?.annotations).toEqual(binding.mcp.annotations);
        expect(definition?.createsView).toBe(binding.mcp.createsView);
      }
    } finally {
      await client.close();
    }
  });

  it("keeps pure Reviews, direct decisions, exact reads, and recovery distinct by structure", () => {
    const reviews = operationInterfaceBindingList.filter((binding) => binding.action === "review");
    const decisions = operationInterfaceBindingList.filter((binding) => binding.action === "decide");
    const exactReads = operationInterfaceBindingList.filter((binding) => binding.action === "get_operation");
    const cancellations = operationInterfaceBindingList.filter((binding) => binding.action === "cancel_operation");

    expect(reviews).toHaveLength(3);
    expect(decisions).toHaveLength(7);
    expect(exactReads).toHaveLength(3);
    expect(cancellations).toEqual([operationInterfaceBindings.walletCancel]);

    for (const review of reviews) {
      expect(review.mcp.visibility).toEqual(["model"]);
      expect(review.mcp.createsView).toBe(true);
      expect(review.mcp.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(resolveLocalOperationIdentity(review.identity)).toMatchObject({ action: "read" });
      expect(review.recoveryOperation).toBeUndefined();
    }

    for (const decision of [...decisions, ...cancellations]) {
      expect(decision.mcp.visibility).toEqual(["app"]);
      expect(decision.mcp.createsView).toBe(false);
      expect(resolveLocalOperationIdentity(decision.identity).action).toMatch(/^(decide|cancel)$/u);
      expect(decision.recoveryOperation?.action).toBe("get_operation");
      expect(decision.recoveryOperation?.contract.capabilityId.split(".")[0]).toBe(
        decision.contract.capabilityId.split(".")[0],
      );
    }

    for (const exactRead of exactReads) {
      expect(exactRead.mcp.visibility).toEqual(["model", "app"]);
      expect(exactRead.mcp.createsView).toBe(false);
      expect(resolveLocalOperationIdentity(exactRead.identity)).toMatchObject({ action: "read" });
      expect(exactRead.recoveryOperation).toBeUndefined();
    }
  });

  it("registers only the final exact operation resources with their owning mutation class", async () => {
    const routes = await routeRegistry();
    const operationId = Buffer.alloc(32, 17).toString("base64url");
    const expected = [
      ["POST", "/api/v1/internal/control/wallet/connection-change-reviews", "none"],
      ["POST", "/api/v1/internal/control/wallet/connection-decisions", "declared_control"],
      ["GET", `/api/v1/internal/control/wallet/operations/${operationId}`, "none"],
      ["GET", `/api/v1/internal/control/wallet/operations/${operationId}/presentation`, "none"],
      ["POST", `/api/v1/internal/control/wallet/operations/${operationId}/cancellation`, "declared_control"],
      ["POST", "/api/v1/internal/control/token-selection/change-reviews", "none"],
      ["POST", "/api/v1/internal/control/token-selection/decisions", "declared_control"],
      ["GET", `/api/v1/internal/control/token-selection/operations/${operationId}`, "none"],
      ["POST", "/api/v1/internal/control/reference-watchlist/change-reviews", "none"],
      ["POST", "/api/v1/internal/control/reference-watchlist/decisions", "declared_control"],
      ["GET", `/api/v1/internal/control/reference-watchlist/operations/${operationId}`, "none"],
    ] as const;

    expect([
      operationControlResources.wallet.reviews,
      operationControlResources.wallet.decisions,
      operationControlResources.wallet.operation(operationId),
      operationControlResources.wallet.presentation(operationId),
      operationControlResources.wallet.cancellation(operationId),
      operationControlResources.tokenSelection.reviews,
      operationControlResources.tokenSelection.decisions,
      operationControlResources.tokenSelection.operation(operationId),
      operationControlResources.referenceWatchlist.reviews,
      operationControlResources.referenceWatchlist.decisions,
      operationControlResources.referenceWatchlist.operation(operationId),
    ]).toEqual(expected.map((entry) => entry[1]));

    for (const [method, path, mutation] of expected) {
      const match = routes.match(method, path);
      expect(match.status).toBe("matched");
      if (match.status !== "matched") throw new TypeError(`Route ${method} ${path} is unavailable.`);
      expect(match.route.mutation).toBe(mutation);
    }
  });
});
