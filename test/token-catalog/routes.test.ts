import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { chainInterfaceErrorMappings } from "../../src/chain/errors.js";
import {
  createControlCredentialVerifier,
  loadOrCreateControlCredential,
} from "../../src/runtime/control-credential.js";
import {
  createRuntimeRouteRegistry,
  type NormalizedRouteResult,
  type RouteMethod,
  type RuntimeRouteRegistry,
} from "../../src/runtime/http-routing.js";
import { runtimePaths } from "../../src/runtime/paths.js";
import {
  extendTokenCatalogQueryRoutes,
  tokenCatalogControlRoutes,
} from "../../src/token-catalog/routes.js";
import { TokenCatalogOperationError } from "../../src/token-catalog/operation-error.js";
import type { TokenCatalogQueryApplicationPort } from "../../src/token-catalog/ports.js";
import {
  chainId,
  createInspectionBinding,
  createTokenSelectionDetail,
  createInspectionSuccess,
  tokenAddress,
  walletAddress,
} from "./harness.js";

const account = Object.freeze({ chainId, address: walletAddress });
const target = Object.freeze({ kind: "address" as const, address: walletAddress });

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const baseRoutes = async (): Promise<RuntimeRouteRegistry> => {
  const directory = await mkdtemp(resolve(tmpdir(), "littlejohn-token-routes-"));
  directories.push(directory);
  const paths = runtimePaths(directory);
  const authority = await loadOrCreateControlCredential(directory, paths.controlCredential);
  return createRuntimeRouteRegistry({
    controlVerifier: createControlCredentialVerifier(authority),
    errorMappings: chainInterfaceErrorMappings,
  });
};

const invoke = async (
  registry: RuntimeRouteRegistry,
  method: RouteMethod,
  path: string,
  body: unknown = {},
): Promise<NormalizedRouteResult> => {
  const match = registry.match(method, path);
  expect(match.status).toBe("matched");
  if (match.status !== "matched") throw new Error("Expected a token catalog route match.");
  return registry.normalizeResult(match.route, await match.route.handler({
    params: match.params,
    body,
    query: "",
    signal: new AbortController().signal,
  }));
};

describe("token catalog local query routes", () => {
  it("owns the three token query resources", async () => {
    const routes = extendTokenCatalogQueryRoutes({
      routes: await baseRoutes(),
      inspection: createInspectionBinding(),
      queries: Object.freeze({
        getSelection: () => new TokenCatalogOperationError("token_selection_not_found").failure,
        listSelections: () => Object.freeze({ account, selections: [], nextCursor: null }),
      }),
    });
    expect(routes.match("POST", tokenCatalogControlRoutes.inspections).status).toBe("matched");
    expect(routes.match("POST", tokenCatalogControlRoutes.selectionQueries).status).toBe("matched");
    expect(routes.match("POST", tokenCatalogControlRoutes.selectionListQueries).status)
      .toBe("matched");
    expect(routes.match(
      "GET",
      `/api/v1/internal/control/token-catalog/selections/${chainId}/${tokenAddress}`,
    ).status).toBe("not_found");
  });

  it("normalizes the exact path identity and list body before query authority", async () => {
    const detail = createTokenSelectionDetail(await createInspectionSuccess());
    const getSelection = vi.fn(() => detail);
    const listSelections = vi.fn(() => Object.freeze({
      account,
      selections: [detail.selection],
      nextCursor: null,
    }));
    const queries: TokenCatalogQueryApplicationPort = Object.freeze({ getSelection, listSelections });
    const routes = extendTokenCatalogQueryRoutes({
      routes: await baseRoutes(),
      inspection: createInspectionBinding(),
      queries,
    });

    expect(await invoke(
      routes,
      "POST",
      tokenCatalogControlRoutes.selectionQueries,
      { account: target, asset: { kind: "erc20", chainId, address: tokenAddress } },
    )).toEqual({ ok: true, body: detail });
    expect(getSelection).toHaveBeenCalledWith({
      account: target,
      asset: { kind: "erc20", chainId, address: tokenAddress },
    });

    expect(await invoke(routes, "POST", tokenCatalogControlRoutes.selectionListQueries, {
      account: target,
      limit: 25,
    })).toEqual({ ok: true, body: { account, selections: [detail.selection], nextCursor: null } });
    expect(listSelections).toHaveBeenCalledWith({ account: target, limit: 25 });
  });

  it("projects a declared application failure through the shared error registry", async () => {
    const routes = extendTokenCatalogQueryRoutes({
      routes: await baseRoutes(),
      inspection: createInspectionBinding(),
      queries: Object.freeze({
        getSelection: () => new TokenCatalogOperationError("token_selection_not_found").failure,
        listSelections: () => Object.freeze({ account, selections: [], nextCursor: null }),
      }),
    });
    expect(await invoke(
      routes,
      "POST",
      tokenCatalogControlRoutes.selectionQueries,
      { account: target, asset: { kind: "erc20", chainId, address: tokenAddress } },
    )).toMatchObject({ ok: false, problem: { code: "token_selection_not_found", status: 404 } });
  });
});
