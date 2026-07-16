import { describe, expect, it } from "vitest";

import {
  captureCanonicalJson,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  createInterfaceFailure,
  dispatchCanonical,
  normalizeProblemDetailsFailure,
  type RuntimeDispatchPort,
} from "../../src/interfaces/http-client.js";
import {
  RuntimeOperationError,
  toProblemDetails,
  type RuntimeDispatchResponse,
} from "../../src/runtime/index.js";
import {
  createWalletFailure,
  walletErrorRegistry,
  walletInterfaceErrorMappings,
} from "../../src/wallet/errors.js";

const request = Object.freeze({
  requestClass: "public_read" as const,
  method: "GET" as const,
  path: "/api/v1/capabilities",
});

const throwingRuntime = (error: unknown): RuntimeDispatchPort => Object.freeze({
  dispatchRuntimeRequest: async () => { throw error; },
});

describe("interface HTTP client error boundary", () => {
  it("preserves only a runtime error created by the runtime authority", async () => {
    expect(await dispatchCanonical(
      throwingRuntime(new RuntimeOperationError("request_aborted")),
      request,
      200,
    )).toEqual({ ok: false, failure: createInterfaceFailure("request_aborted") });

    const forged = Object.create(RuntimeOperationError.prototype) as Record<string, unknown>;
    forged["failure"] = createInterfaceFailure("request_aborted");
    expect(await dispatchCanonical(throwingRuntime(forged), request, 200)).toEqual({
      ok: false,
      failure: createInterfaceFailure("internal_error"),
    });
  });

  it("does not inspect arbitrary failure getters or proxy traps", async () => {
    let getterReads = 0;
    const getterError = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(getterError, "failure", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        throw new Error("secret-getter-payload");
      },
    });

    let proxyReads = 0;
    const proxyError = new Proxy(new RuntimeOperationError("request_aborted"), {
      get: () => {
        proxyReads += 1;
        throw new Error("secret-proxy-payload");
      },
      has: () => {
        proxyReads += 1;
        throw new Error("secret-proxy-payload");
      },
    });

    for (const error of [getterError, proxyError]) {
      expect(await dispatchCanonical(throwingRuntime(error), request, 200)).toEqual({
        ok: false,
        failure: createInterfaceFailure("internal_error"),
      });
    }
    expect(getterReads).toBe(0);
    expect(proxyReads).toBe(0);
  });

  it("normalizes wallet and chain Problem Details through one explicit authority", () => {
    const failure = createWalletFailure("wallet_session_unusable");
    const problem = toProblemDetails(failure, walletInterfaceErrorMappings);
    const response: RuntimeDispatchResponse = Object.freeze({
      status: problem.status,
      body: problem as unknown as CanonicalJson,
    });
    expect(normalizeProblemDetailsFailure(
      response,
      walletErrorRegistry,
      walletInterfaceErrorMappings,
      "runtime_state_unavailable",
    )).toEqual(failure);

    expect(normalizeProblemDetailsFailure(
      Object.freeze({ status: 500, body: captureCanonicalJson({ detail: "forged" }) }),
      walletErrorRegistry,
      walletInterfaceErrorMappings,
      "runtime_state_unavailable",
    )).toEqual(createWalletFailure("runtime_state_unavailable"));

    expect(normalizeProblemDetailsFailure(
      Object.freeze({
        status: problem.status,
        body: captureCanonicalJson({ ...problem, detail: "forged provider detail" }),
      }),
      walletErrorRegistry,
      walletInterfaceErrorMappings,
      "runtime_state_unavailable",
    )).toEqual(createWalletFailure("runtime_state_unavailable"));

    expect(normalizeProblemDetailsFailure(
      Object.freeze({ status: 500, body: problem as unknown as CanonicalJson }),
      walletErrorRegistry,
      walletInterfaceErrorMappings,
      "runtime_state_unavailable",
    )).toEqual(createWalletFailure("runtime_state_unavailable"));
  });
});
