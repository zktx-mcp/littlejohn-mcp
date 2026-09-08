import { describe, expect, it } from "vitest";

import { chainInterfaceErrorMappings } from "../../src/chain/error-mappings.js";
import {
  admitChainReadFailure,
  ChainOperationError,
  chainErrorRegistry,
  createChainFailure,
  createChainInvocationStoppedError,
  getChainOperationFailure,
} from "../../src/chain/errors.js";
import { ChainRpcError } from "../../src/chain/rpc.js";
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
        "chain_response_unavailable",
        "rate_limited",
        "source_inconsistent",
        "source_unavailable",
      ]),
    );
  });

  it("uses the fixed safe messages and exact interface projections", () => {
    expect(createChainFailure("chain_response_unavailable")).toEqual({
      ok: false,
      error: {
        code: "chain_response_unavailable",
        category: "transport",
        message: "A complete chain response was not obtained.",
        retryable: true,
        issues: [],
      },
    });
    expect(chainInterfaceErrorMappings.get("chain_response_unavailable")).toEqual({
      code: "chain_response_unavailable",
      httpStatus: 502,
      problemTitle: "Chain response unavailable",
      cliExitCode: 4,
    });
    expect(chainInterfaceErrorMappings.get("runtime_state_unavailable")).toEqual({
      code: "runtime_state_unavailable",
      httpStatus: 500,
      problemTitle: "Runtime state unavailable",
      cliExitCode: 7,
    });
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

  it("admits every branded lifecycle and requester fact through one canonical mapping", () => {
    const active = new AbortController();
    const cancelled = new AbortController();
    cancelled.abort();

    const stopCases = [
      ["caller_aborted", "request_aborted"],
      ["application_closed", "runtime_state_unavailable"],
      ["deadline_reached", "chain_response_unavailable"],
    ] as const;
    for (const [reason, code] of stopCases) {
      expect(admitChainReadFailure(
        createChainInvocationStoppedError(reason),
        active.signal,
      )?.error.code).toBe(code);
    }

    const rpcCases = [
      ["chain_response_unavailable", "chain_response_unavailable"],
      ["rate_limited", "rate_limited"],
      ["runtime_busy", "runtime_busy"],
      ["source_inconsistent", "source_inconsistent"],
      ["source_unavailable", "source_unavailable"],
    ] as const;
    for (const [rpcCode, failureCode] of rpcCases) {
      expect(admitChainReadFailure(
        new ChainRpcError(rpcCode),
        active.signal,
      )?.error.code).toBe(failureCode);
    }
    expect(admitChainReadFailure(
      new ChainRpcError("request_aborted"),
      active.signal,
    )?.error.code).toBe("chain_response_unavailable");
    expect(admitChainReadFailure(
      new ChainRpcError("request_aborted"),
      cancelled.signal,
    )?.error.code).toBe("request_aborted");
  });

  it("recognizes only errors created by the chain authority without inspecting hostile wrappers", () => {
    const failure = createChainFailure("source_inconsistent");
    const canonical = new ChainOperationError(failure);
    expect(getChainOperationFailure(canonical)).toBe(failure);
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
    expect(admitChainReadFailure(proxied, new AbortController().signal)).toBeUndefined();
    expect(admitChainReadFailure({ code: "source_unavailable" }, new AbortController().signal))
      .toBeUndefined();
    expect(proxyReads).toBe(0);
  });
});
