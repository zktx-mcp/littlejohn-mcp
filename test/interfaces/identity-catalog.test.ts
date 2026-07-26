import { describe, expect, it } from "vitest";

import { extendChainSupportManifest } from "../../src/chain/application.js";
import { extendAccountAssetSupportManifest } from "../../src/account-assets/support.js";
import { accountAssetApplicationContracts } from "../../src/account-assets/contracts.js";
import {
  compareCodePointSequences,
  getCapabilityDefinitionSnapshot,
  readCapabilityRegistry,
} from "../../src/core/index.js";
import {
  declaredCliCommandIdentities,
  declaredMcpToolNames,
  interfaceReadCapabilityRegistry,
  accountAssetInterfaceBindingList,
  contractInspectInterface,
  readInterfaceIdentities,
  tokenCatalogInterfaceBindingList,
  tokenInspectInterface,
} from "../../src/interfaces/identities.js";
import { publicInspectionPaths } from "../../src/interfaces/browser-contract.js";
import { extendInterfaceSupportManifest } from "../../src/interfaces/support.js";
import { extendReferenceMarketSupportManifest } from "../../src/market-portfolio/support.js";
import { readRuntimeConfiguration } from "../../src/runtime/configuration.js";
import {
  createInitialRuntimeSupportManifest,
  readRuntimeSupportManifest,
} from "../../src/runtime/support-manifest.js";
import {
  tokenCatalogApplicationContractList,
  tokenCatalogOperationConfirmationContract,
  tokenInspectCapability,
} from "../../src/token-catalog/contracts.js";
import { extendTokenCatalogSupportManifest } from "../../src/token-catalog/support.js";
import { extendWalletSupportManifest } from "../../src/wallet/application.js";

const tokenCatalogManifest = () => extendTokenCatalogSupportManifest(
  extendChainSupportManifest(extendWalletSupportManifest(
    createInitialRuntimeSupportManifest(readRuntimeConfiguration({}).chain),
  )),
);

const interfaceManifest = () => extendInterfaceSupportManifest(
  extendReferenceMarketSupportManifest(extendAccountAssetSupportManifest(tokenCatalogManifest())),
);

describe("interface binding identity authority", () => {
  it("builds the six-read registry from the exact binding definition objects", () => {
    expect(readInterfaceIdentities.map((identity) => identity.capabilityId)).toEqual([
      "account.balance",
      "chain.status",
      "contract.inspect",
      "token.inspect",
      "transaction.inspect",
      "wallet.connection",
    ]);
    expect(interfaceReadCapabilityRegistry.values()).toEqual(
      readInterfaceIdentities.map((identity) => identity.definition),
    );
    for (const identity of readInterfaceIdentities) {
      expect(interfaceReadCapabilityRegistry.owns(identity.definition)).toBe(true);
      expect(identity.capabilityId).toBe(getCapabilityDefinitionSnapshot(identity.definition).capabilityId);
    }
    expect(tokenInspectInterface.definition).toBe(tokenInspectCapability);
    expect(tokenInspectInterface.mcp.name).toBe("token_inspect_contract");
    expect(tokenInspectInterface.cli).toEqual({
      domain: "token",
      command: "inspect",
      argumentSyntax: "<token-address> --block <latest|block-number> [--json]",
    });
    expect(tokenInspectInterface.web).toBe(true);
    expect(contractInspectInterface.web).toBe(true);
    expect(contractInspectInterface.http.path).toBe(publicInspectionPaths.contractQueries);
    expect(tokenInspectInterface.http.path).toBe(publicInspectionPaths.tokenQueries);
    expect(readCapabilityRegistry.owns(tokenInspectCapability)).toBe(false);
  });

  it("maps each token application contract to one canonical interface binding", () => {
    expect(tokenCatalogInterfaceBindingList.map((binding) => binding.contract)).toEqual(
      [...tokenCatalogApplicationContractList]
        .sort((left, right) => compareCodePointSequences(left.capabilityId, right.capabilityId)),
    );
    expect(tokenCatalogInterfaceBindingList.map((binding) => binding.contract.capabilityId)).toEqual([
      "token.cancel_operation",
      "token.operation",
      "token.selection",
      "token.selections",
      "token.start_addition",
      "token.start_removal",
    ]);
    expect(tokenCatalogInterfaceBindingList.map((binding) => binding.mcp.name)).toEqual([
      "token_cancel_operation",
      "token_get_operation",
      "token_get_selection",
      "token_list_selections",
      "token_start_addition",
      "token_start_removal",
    ]);
    expect(tokenCatalogInterfaceBindingList.map((binding) => [binding.action, binding.operationKind ?? null]))
      .toEqual([
        ["cancel_operation", null],
        ["get_operation", null],
        ["get", null],
        ["list", null],
        ["start", "add"],
        ["start", "remove"],
      ]);
    expect(tokenCatalogInterfaceBindingList.some(
      (binding) => binding.contract === tokenCatalogOperationConfirmationContract as never,
    )).toBe(false);
    expect(new Set(tokenCatalogInterfaceBindingList.map((binding) => binding.contract)).size)
      .toBe(tokenCatalogApplicationContractList.length);
  });

  it("derives CLI, MCP, and final support availability from the binding catalogs", () => {
    expect(accountAssetInterfaceBindingList.map((binding) => binding.contract)).toEqual([
      accountAssetApplicationContracts.collection,
      accountAssetApplicationContracts.exact,
    ]);
    for (const binding of tokenCatalogInterfaceBindingList) {
      expect(declaredMcpToolNames).toContain(binding.mcp.name);
      expect(declaredCliCommandIdentities).toContain(binding.cli);
    }
    expect(declaredMcpToolNames).toContain(tokenInspectInterface.mcp.name);
    expect(declaredCliCommandIdentities).toContain(tokenInspectInterface.cli);

    const internalSnapshot = readRuntimeSupportManifest(tokenCatalogManifest());
    for (const capabilityId of [
      "token.inspect",
      ...tokenCatalogInterfaceBindingList.map((binding) => binding.contract.capabilityId),
    ]) {
      expect(internalSnapshot.capabilities.find((entry) => entry.capabilityId === capabilityId)?.availability)
        .toEqual({
          overall: "internal",
          direct: "internal",
          http: "unavailable",
          mcp: "unavailable",
          cli: "unavailable",
          web: "unavailable",
        });
    }

    const snapshot = readRuntimeSupportManifest(interfaceManifest());
    const availability = new Map<string, (typeof snapshot.capabilities)[number]["availability"]>(
      snapshot.capabilities.map((entry): [string, (typeof snapshot.capabilities)[number]["availability"]] =>
        [entry.capabilityId, entry.availability]),
    );
    expect(availability.get("token.inspect")).toEqual({
      overall: "available",
      direct: "internal",
      http: "available",
      mcp: "available",
      cli: "available",
      web: "available",
    });
    for (const binding of tokenCatalogInterfaceBindingList) {
      expect(availability.get(binding.contract.capabilityId)).toEqual({
        overall: "available",
        direct: "internal",
        http: "internal",
        mcp: "available",
        cli: "available",
        web: "available",
      });
    }
    expect(availability.get("account.balance")?.web).toBe("unavailable");
  });
});
