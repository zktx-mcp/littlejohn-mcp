import { describe, expect, it } from "vitest";

import {
  ChainOperationError,
  chainErrorRegistry,
  chainInterfaceErrorMappings,
  createChainFailure,
  getChainOperationFailure,
} from "../../src/chain/errors.js";
import { walletErrorRegistry, walletInterfaceErrorMappings } from "../../src/wallet/errors.js";

describe("chain error authority", () => {
  it("extends the wallet registry without replacing inherited definitions", () => {
    for (const definition of walletErrorRegistry.values()) {
      expect(chainErrorRegistry.get(definition.code)).toEqual(definition);
      expect(chainInterfaceErrorMappings.get(definition.code)).toEqual(
        walletInterfaceErrorMappings.get(definition.code),
      );
    }
    expect(chainErrorRegistry.values().map((definition) => definition.code)).toEqual(
      expect.arrayContaining([
        "not_found",
        "rate_limited",
        "source_inconsistent",
        "source_unavailable",
        "unsupported_capability",
      ]),
    );
  });

  it("uses the fixed safe messages and exact interface projections", () => {
    expect(createChainFailure("source_unavailable")).toEqual({
      ok: false,
      error: {
        code: "source_unavailable",
        category: "source",
        message: "A required data source is unavailable.",
        retryable: true,
        issues: [],
      },
    });
    expect(chainInterfaceErrorMappings.get("source_inconsistent")).toEqual({
      code: "source_inconsistent",
      httpStatus: 502,
      problemTitle: "Source inconsistent",
      cliExitCode: 4,
    });
  });

  it("recognizes only errors created by the chain authority without inspecting hostile wrappers", () => {
    const canonical = new ChainOperationError("source_inconsistent");
    expect(getChainOperationFailure(canonical)).toEqual(createChainFailure("source_inconsistent"));
    expect(getChainOperationFailure(Object.create(ChainOperationError.prototype))).toBeUndefined();

    let proxyReads = 0;
    const proxied = new Proxy(canonical, {
      get: () => {
        proxyReads += 1;
        throw new Error("secret-chain-error");
      },
      getPrototypeOf: () => {
        proxyReads += 1;
        throw new Error("secret-chain-error");
      },
    });
    expect(getChainOperationFailure(proxied)).toBeUndefined();
    expect(proxyReads).toBe(0);
  });
});
