import { describe, expect, it } from "vitest";

import {
  defaultRpcUrl,
  getInvalidRpcConfigurationError,
  readConfiguredRpcEndpoint,
  readRuntimeConfiguration,
} from "../../src/runtime/configuration.js";

const captureInvalidRpcConfiguration = (value: unknown): Error => {
  let thrown: unknown;
  try {
    readRuntimeConfiguration({ LITTLEJOHN_RPC_URL: value } as never);
  } catch (error) {
    thrown = error;
  }
  const admitted = getInvalidRpcConfigurationError(thrown);
  if (admitted === undefined) throw new Error("Expected an invalid RPC configuration error.");
  return admitted;
};

describe("Runtime RPC configuration", () => {
  it("selects the default only for exact undefined", () => {
    for (const environment of [{}, { LITTLEJOHN_RPC_URL: undefined }]) {
      const configuration = readRuntimeConfiguration(environment);
      expect(readConfiguredRpcEndpoint(configuration.rpc.endpoint).exactUri).toBe(defaultRpcUrl);
      expect(configuration.rpc.endpoint).toMatchObject({
        publicOrigin: defaultRpcUrl,
        sourceOwner: "Robinhood",
      });
    }

    const nullFailure = captureInvalidRpcConfiguration(null);
    expect(nullFailure.message)
      .toBe("LITTLEJOHN_RPC_URL must be a valid absolute HTTPS URL without a fragment.");
  });

  it.each([
    ["plaintext target", "http://user:plaintext-secret@rpc.example/private?key=secret"],
    ["literal fragment", "https://rpc.example/#secret"],
    ["malformed credentials", "https://user%3Asecret:password@rpc.example/"],
  ] as const)("reports a fixed private failure for a %s", (_name, value) => {
    const failure = captureInvalidRpcConfiguration(value);
    expect(failure).toMatchObject({
      name: "InvalidRpcConfigurationError",
      message: "LITTLEJOHN_RPC_URL must be a valid absolute HTTPS URL without a fragment.",
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain("secret");
    expect(String(failure.stack)).not.toContain(value);
  });

  it("keeps network projections out of Runtime state while preserving exact identity", () => {
    const exactUri = "https://user:password@rpc.example/private?key=secret";
    const configuration = readRuntimeConfiguration({ LITTLEJOHN_RPC_URL: exactUri });
    const first = readConfiguredRpcEndpoint(configuration.rpc.endpoint);
    first.exactUtf8.fill(0);
    const second = readConfiguredRpcEndpoint(configuration.rpc.endpoint);

    expect(Reflect.ownKeys(configuration.rpc.endpoint)).toEqual([
      "publicOrigin",
      "sourceOwner",
    ]);
    expect(configuration.rpc.endpoint).toEqual({
      publicOrigin: "https://rpc.example",
      sourceOwner: "user_configured",
    });
    expect(second.exactUri).toBe(exactUri);
    expect(second.exactUtf8).toEqual(new TextEncoder().encode(exactUri));
    expect(JSON.stringify(configuration.rpc.endpoint)).not.toContain("password");
    expect(JSON.stringify(configuration.rpc.endpoint)).not.toContain("private");
    expect(JSON.stringify(configuration.rpc.endpoint)).not.toContain("secret");
  });

  it("preserves official ownership and distinct bytes for empty user information", () => {
    const exactUris = [
      "https://@rpc.mainnet.chain.robinhood.com/",
      "https://:@rpc.mainnet.chain.robinhood.com/",
    ] as const;
    const exactResults = exactUris.map((exactUri) => {
      const configuration = readRuntimeConfiguration({ LITTLEJOHN_RPC_URL: exactUri });
      expect(configuration.rpc.endpoint.sourceOwner).toBe("Robinhood");
      return readConfiguredRpcEndpoint(configuration.rpc.endpoint);
    });

    expect(exactResults.map(({ exactUri }) => exactUri)).toEqual(exactUris);
    expect(exactResults[0]?.exactUtf8).not.toEqual(exactResults[1]?.exactUtf8);
  });

  it("does not admit forged, proxied, or unrelated errors as RPC configuration failures", () => {
    const message = "LITTLEJOHN_RPC_URL must be a valid absolute HTTPS URL without a fragment.";
    expect(getInvalidRpcConfigurationError(new Error(message))).toBeUndefined();
    expect(getInvalidRpcConfigurationError(Object.freeze({
      name: "InvalidRpcConfigurationError",
      message,
    }))).toBeUndefined();

    let proxyReads = 0;
    const proxied = new Proxy(new Error(message), {
      get: () => {
        proxyReads += 1;
        throw new Error("must not inspect proxy fields");
      },
      getPrototypeOf: () => {
        proxyReads += 1;
        throw new Error("must not inspect proxy prototype");
      },
    });
    expect(getInvalidRpcConfigurationError(proxied)).toBeUndefined();
    expect(proxyReads).toBe(0);

    let walletFailure: unknown;
    try {
      readRuntimeConfiguration({ LITTLEJOHN_WALLETCONNECT_PROJECT_ID: "invalid" });
    } catch (error) {
      walletFailure = error;
    }
    expect(getInvalidRpcConfigurationError(walletFailure)).toBeUndefined();
  });
});
