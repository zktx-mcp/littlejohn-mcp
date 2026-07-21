import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AccountAssetOperationError,
  accountAssetControlRoutes,
  extendAccountAssetControlRouteRegistry,
} from "../../src/account-assets/index.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import { createRuntimeRouteRegistry } from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import { tokenCatalogInterfaceErrorMappings } from "../../src/token-catalog/errors.js";
import type { AccountAssetApplicationPort } from "../../src/account-assets/ports.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const routesAfterTokenCatalog = async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-account-assets-routes-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const authority = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return createRuntimeRouteRegistry({
    controlVerifier: createControlCredentialVerifier(authority),
    errorMappings: tokenCatalogInterfaceErrorMappings,
  });
};

describe("account asset routes", () => {
  it("inherits the token-catalog error mapping lineage without inventing an extension", async () => {
    const failure = new AccountAssetOperationError("wallet_not_connected").failure;
    const accountAssets: AccountAssetApplicationPort = Object.freeze({
      list: async () => failure,
      get: async () => failure,
      listOfficialCandidates: async () => failure,
    });
    const routes = extendAccountAssetControlRouteRegistry({
      routes: await routesAfterTokenCatalog(),
      accountAssets,
    });
    const match = routes.match("POST", accountAssetControlRoutes.queries);
    expect(match.status).toBe("matched");
    if (match.status !== "matched") throw new TypeError("Expected the account asset route.");
    const result = await match.route.handler({
      params: match.params,
      body: { limit: 5 },
      signal: new AbortController().signal,
    });
    expect(routes.normalizeResult(match.route, result)).toMatchObject({
      ok: false,
      problem: { code: "wallet_not_connected" },
    });
  });
});
