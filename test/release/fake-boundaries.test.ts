import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from "node:crypto";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { request } from "node:https";
import { isAbsolute, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { inspectModuleImports } from "../runtime/import-audit.js";
import { startFakeRpc } from "../../scripts/release/fake-rpc.mjs";
import { parseReleasePackageIdentity } from "../../scripts/release/package-audit.mjs";
import {
  assertPackagedMcpServerIdentity,
  packagedToolSchemaBundleSha256,
} from "../../scripts/release/packaged-integration.mjs";
import { renderPackagedOwnerWorkerSource } from "../../scripts/release/packaged-owner-worker-source.mjs";
import {
  stockFactoryImplementationAddress,
  stockFactoryProxyAddress,
} from "../../scripts/release/stock-factory-fixture.mjs";

const rawRpcRequest = (
  url: string,
  body: string,
  ca: Buffer | Buffer[],
  servername?: string,
): Promise<unknown> => new Promise((resolveRequest, rejectRequest) => {
  const target = new URL(url);
  const outgoing = request({
    hostname: target.hostname,
    port: Number(target.port),
    path: target.pathname,
    method: "POST",
    ca,
    rejectUnauthorized: true,
    ...(servername === undefined ? {} : { servername }),
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.once("end", () => {
      try { resolveRequest(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { rejectRequest(error); }
    });
  });
  outgoing.once("error", rejectRequest);
  outgoing.end(body);
});

const rpcRequest = (
  url: string,
  caCertificatePath: string,
  method: string,
  params: readonly unknown[],
): Promise<unknown> => rawRpcRequest(
  url,
  JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  readFileSync(caCertificatePath),
);

describe("release fake boundaries", () => {
  it("digests complete tool schemas independently of object-key insertion order", () => {
    const schemaBundle = [{
      name: "read_control",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string", minLength: 1 } },
        required: ["value"],
      },
      outputSchema: {
        oneOf: [
          { type: "null", const: null },
          { type: "array", items: { type: "integer", minimum: 0 } },
        ],
      },
    }];
    const reordered = [{
      outputSchema: {
        oneOf: [
          { const: null, type: "null" },
          { items: { minimum: 0, type: "integer" }, type: "array" },
        ],
      },
      inputSchema: {
        required: ["value"],
        properties: { value: { minLength: 1, type: "string" } },
        additionalProperties: false,
        type: "object",
      },
      name: "read_control",
    }];
    const baseline = packagedToolSchemaBundleSha256(schemaBundle);
    expect(packagedToolSchemaBundleSha256(reordered)).toBe(baseline);

    const schema = schemaBundle[0]!;
    const firstOutputVariant = schema.outputSchema.oneOf[0]!;
    const mutations: Parameters<typeof packagedToolSchemaBundleSha256>[0][] = [
      [{ ...schema, inputSchema: {
        ...schema.inputSchema,
        additionalProperties: true,
      } }],
      [{ ...schema, inputSchema: {
        ...schema.inputSchema,
        required: [],
      } }],
      [{ ...schema, inputSchema: {
        ...schema.inputSchema,
        properties: {
          ...schema.inputSchema.properties,
          extra: { type: "boolean" },
        },
      } }],
      [{ ...schema, outputSchema: {
        oneOf: [
          ...schema.outputSchema.oneOf,
          { type: "boolean" },
        ],
      } }],
      [{ ...schema, outputSchema: {
        oneOf: [
          firstOutputVariant,
          { type: "array", items: { type: "number", minimum: 0 } },
        ],
      } }],
    ];
    for (const mutation of mutations) {
      expect(packagedToolSchemaBundleSha256(mutation)).not.toBe(baseline);
    }
  });

  it("binds the MCP handshake to the package manifest identity", () => {
    const identity = parseReleasePackageIdentity(
      JSON.parse(readFileSync("package.json", "utf8")),
    );
    expect(() => assertPackagedMcpServerIdentity({
      serverInfo: { name: identity.name, version: identity.version },
    }, identity)).not.toThrow();
    expect(() => assertPackagedMcpServerIdentity({
      serverInfo: { name: identity.name, version: "0.0.0-stale" },
    }, identity)).toThrow("identity");
    expect(() => assertPackagedMcpServerIdentity({
      serverInfo: { name: "foreign-package", version: identity.version },
    }, identity)).toThrow("identity");
    expect(() => assertPackagedMcpServerIdentity(
      Object.defineProperty({}, "serverInfo", {
        get: () => { throw new Error("secret getter"); },
      }),
      identity,
    )).toThrow("identity");
  });

  it("retains one valid loopback certificate chain without the CA private key", () => {
    const fixtureDirectory = resolve("scripts/release/fixtures");
    const fixtureNames = [
      "rpc-loopback-ca.pem",
      "rpc-loopback-server-cert.pem",
      "rpc-loopback-server-key.pem",
    ];
    expect(readdirSync(fixtureDirectory).sort()).toEqual(fixtureNames);
    const caPath = resolve(fixtureDirectory, "rpc-loopback-ca.pem");
    const serverCertificatePath = resolve(
      fixtureDirectory,
      "rpc-loopback-server-cert.pem",
    );
    const serverPrivateKeyPath = resolve(
      fixtureDirectory,
      "rpc-loopback-server-key.pem",
    );
    for (const path of [caPath, serverCertificatePath, serverPrivateKeyPath]) {
      expect(statSync(path).isFile()).toBe(true);
    }

    const caPem = readFileSync(caPath, "utf8");
    const serverCertificatePem = readFileSync(serverCertificatePath, "utf8");
    const serverPrivateKeyPem = readFileSync(serverPrivateKeyPath, "utf8");
    expect(caPem).toMatch(
      /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END CERTIFICATE-----\n$/u,
    );
    expect(serverCertificatePem).toMatch(
      /^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END CERTIFICATE-----\n$/u,
    );
    expect(serverPrivateKeyPem).toMatch(
      /^-----BEGIN PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END PRIVATE KEY-----\n$/u,
    );

    const ca = new X509Certificate(caPem);
    const server = new X509Certificate(serverCertificatePem);
    expect(ca.ca).toBe(true);
    expect(server.ca).toBe(false);
    expect(ca.subject).toBe(ca.issuer);
    expect(ca.verify(ca.publicKey)).toBe(true);
    expect(server.checkIssued(ca)).toBe(true);
    expect(server.verify(ca.publicKey)).toBe(true);
    expect(server.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(server.subjectAltName).toBe("IP Address:127.0.0.1");
    expect(server.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(server.checkHost("localhost")).toBeUndefined();

    const now = Date.now();
    const caFrom = Date.parse(ca.validFrom);
    const caTo = Date.parse(ca.validTo);
    const serverFrom = Date.parse(server.validFrom);
    const serverTo = Date.parse(server.validTo);
    expect(caFrom).toBeLessThanOrEqual(now);
    expect(serverFrom).toBeLessThanOrEqual(now);
    expect(caTo).toBeGreaterThan(now);
    expect(serverTo).toBeGreaterThan(now);
    expect(caFrom).toBeLessThanOrEqual(serverFrom);
    expect(caTo).toBeGreaterThanOrEqual(serverTo);

    const privatePublicKey = createPublicKey(
      createPrivateKey(serverPrivateKeyPem),
    ).export({ format: "der", type: "spki" });
    const certificatePublicKey = server.publicKey.export({
      format: "der",
      type: "spki",
    });
    expect(Buffer.from(privatePublicKey).equals(certificatePublicKey)).toBe(true);
    expect(Buffer.from(privatePublicKey).equals(
      ca.publicKey.export({ format: "der", type: "spki" }),
    )).toBe(false);
  });

  it("requires the retained CA and the exact IP identity for independent HTTPS requests", async () => {
    const rpc = await startFakeRpc();
    try {
      const ca = readFileSync(rpc.caCertificatePath);
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "eth_chainId",
        params: [],
      });
      expect(rpc.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/u);
      expect(rpc.assetSourceUrl).toBe(`${rpc.url}/rhj/assets`);
      expect(isAbsolute(rpc.caCertificatePath)).toBe(true);
      expect(realpathSync(rpc.caCertificatePath)).toBe(rpc.caCertificatePath);
      expect(rpc.caCertificatePath).toBe(realpathSync(resolve(
        "scripts/release/fixtures/rpc-loopback-ca.pem",
      )));
      expect(statSync(rpc.caCertificatePath).isFile()).toBe(true);
      await expect(rawRpcRequest(rpc.url, body, ca)).resolves.toMatchObject({
        result: "0x1237",
      });
      await expect(rawRpcRequest(rpc.url, body, [])).rejects.toThrow();
      await expect(rawRpcRequest(rpc.url, body, ca, "localhost")).rejects.toThrow();
    } finally {
      await rpc.close();
    }
  });

  it("projects one final TLS environment and removes inherited aliases", async () => {
    const rpc = await startFakeRpc();
    try {
      const environment = rpc.createChildEnvironment(Object.freeze({
        KEEP: "exact",
        OMIT: undefined,
        LITTLEJOHN_RELEASE_ASSET_SOURCE_URL: "http://inherited.invalid/assets",
        littlejohn_release_asset_source_url: "http://alias.invalid/assets",
        LITTLEJOHN_RPC_URL: "http://inherited.invalid",
        LiTtLeJoHn_RpC_Url: "http://alias.invalid",
        NODE_EXTRA_CA_CERTS: "/inherited/ca.pem",
        node_extra_ca_certs: "/alias/ca.pem",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        node_tls_reject_unauthorized: "0",
      }));
      expect(environment).toEqual({
        KEEP: "exact",
        LITTLEJOHN_RELEASE_ASSET_SOURCE_URL: rpc.assetSourceUrl,
        LITTLEJOHN_RPC_URL: rpc.url,
        NODE_EXTRA_CA_CERTS: rpc.caCertificatePath,
      });
      expect(Object.isFrozen(environment)).toBe(true);
      expect(Object.keys(environment).filter((name) =>
        name.toUpperCase() === "NODE_TLS_REJECT_UNAUTHORIZED"
      )).toEqual([]);
      for (const name of [
        "LITTLEJOHN_RELEASE_ASSET_SOURCE_URL",
        "LITTLEJOHN_RPC_URL",
        "NODE_EXTRA_CA_CERTS",
      ]) {
        expect(Object.keys(environment).filter((candidate) =>
          candidate.toUpperCase() === name
        )).toEqual([name]);
      }
      expect(rpc.createChildEnvironment(
        { KEEP: "exact" },
        `${rpc.url}/`,
      )).toMatchObject({ LITTLEJOHN_RPC_URL: `${rpc.url}/` });
      expect(() => rpc.createChildEnvironment(
        { KEEP: "exact" },
        "https://example.invalid/",
      )).toThrow("fake RPC root");
    } finally {
      await rpc.close();
    }
  });

  it("preserves the exact fake request-size boundary over HTTPS", async () => {
    const rpc = await startFakeRpc();
    try {
      const ca = readFileSync(rpc.caCertificatePath);
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "eth_chainId",
        params: [],
      });
      const maximumBody = request.padEnd(32 * 1024, " ");
      expect(Buffer.byteLength(maximumBody)).toBe(32 * 1024);
      await expect(rawRpcRequest(rpc.url, maximumBody, ca)).resolves.toMatchObject({
        result: "0x1237",
      });
      await expect(rawRpcRequest(rpc.url, `${maximumBody} `, ca)).resolves.toMatchObject({
        error: { code: -32601, message: "Fake RPC request is too large." },
      });
      expect(rpc.failures.at(-1)?.message).toBe("Fake RPC request is too large.");
    } finally {
      await rpc.close();
    }
  });

  it("serves only the exact automated read RPC methods and records prohibited calls", async () => {
    const rpc = await startFakeRpc();
    try {
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_chainId", [])).resolves.toMatchObject({
        result: "0x1237",
      });
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getCode", [
        rpc.token.address,
        rpc.canonicalBlockReference,
      ])).resolves.toMatchObject({ result: rpc.token.runtimeCode });
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getBalance", [
        rpc.semanticReads.account.address,
        rpc.canonicalBlockReference,
      ])).resolves.toMatchObject({
        result: `0x${BigInt(rpc.semanticReads.account.nativeBalanceRaw).toString(16)}`,
      });
      const latestBlock = await rpcRequest(
        rpc.url,
        rpc.caCertificatePath,
        "eth_getBlockByNumber",
        ["latest", false],
      );
      const exactBlock = await rpcRequest(
        rpc.url,
        rpc.caCertificatePath,
        "eth_getBlockByNumber",
        ["0x20000000000001", false],
      );
      expect(exactBlock).toEqual(latestBlock);
      expect(rpc.semanticReads.address.runtimeCodeObserved).toEqual({
        address: `0x${"2a".repeat(20)}`,
        runtimeCode: "0x600060005260206000f3",
        byteLength: "10",
        codeHash: "0x52262f711ffacf04147d1bc4b323c69df60a55163b5b86666f3c227f25a34008",
      });
      expect(rpc.semanticReads.address.noRuntimeCodeObserved).toEqual({
        address: `0x${"2b".repeat(20)}`,
        runtimeCode: "0x",
      });
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getCode", [
        rpc.semanticReads.address.runtimeCodeObserved.address,
        rpc.canonicalBlockReference,
      ])).resolves.toMatchObject({ result: "0x600060005260206000f3" });
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getCode", [
        rpc.semanticReads.address.noRuntimeCodeObserved.address,
        rpc.canonicalBlockReference,
      ])).resolves.toMatchObject({ result: "0x" });
      const addressFixtureIdentities = [
        rpc.semanticReads.address.runtimeCodeObserved.address,
        rpc.semanticReads.address.noRuntimeCodeObserved.address,
      ];
      const unrelatedIdentities = [
        rpc.semanticReads.account.address,
        `0x${"33".repeat(20)}`,
        rpc.semanticReads.account.token.address,
        rpc.semanticReads.transaction.from,
        rpc.semanticReads.transaction.to,
        rpc.semanticReads.transaction.accessListAddress,
        rpc.semanticReads.transaction.transferToken,
        rpc.semanticReads.uniswapV2.factory,
        rpc.semanticReads.uniswapV2.pair,
        rpc.semanticReads.uniswapV2.tokenIn.address,
        rpc.semanticReads.uniswapV2.tokenOut.address,
        rpc.stockTokenTradeHistory.tokenAddress,
        rpc.officialCandidate.address,
        stockFactoryProxyAddress,
        stockFactoryImplementationAddress,
        ...rpc.defaultTokens.map((entry) => entry.address),
      ];
      expect(new Set(addressFixtureIdentities).size).toBe(2);
      expect(addressFixtureIdentities.some((identity) =>
        unrelatedIdentities.includes(identity))).toBe(false);
      for (const address of addressFixtureIdentities) {
        await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getCode", [
          address,
          "latest",
        ])).resolves.toMatchObject({ error: { code: -32601 } });
      }
      const addressStorageSlots = [
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
        "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
        "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
      ] as const;
      for (const slot of addressStorageSlots) {
        await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getStorageAt", [
          rpc.semanticReads.address.runtimeCodeObserved.address,
          slot,
          rpc.canonicalBlockReference,
        ])).resolves.toMatchObject({ result: `0x${"0".repeat(64)}` });
      }
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getStorageAt", [
        rpc.semanticReads.address.runtimeCodeObserved.address,
        addressStorageSlots[0],
        "latest",
      ])).resolves.toMatchObject({ error: { code: -32601 } });
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getCode", [
        `0x${"2c".repeat(20)}`,
        rpc.canonicalBlockReference,
      ])).resolves.toMatchObject({ error: { code: -32601 } });
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getStorageAt", [
        rpc.semanticReads.address.noRuntimeCodeObserved.address,
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
        rpc.canonicalBlockReference,
      ])).resolves.toMatchObject({ error: { code: -32601 } });
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_call", [{
        to: rpc.semanticReads.address.noRuntimeCodeObserved.address,
        data: "0x8da5cb5b",
      }, rpc.canonicalBlockReference])).resolves.toMatchObject({ error: { code: -32601 } });
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getCode", [
        rpc.semanticReads.transaction.accessListAddress,
        rpc.canonicalBlockReference,
      ])).resolves.toMatchObject({ error: { code: -32601 } });
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getStorageAt", [
        rpc.semanticReads.transaction.accessListAddress,
        addressStorageSlots[0],
        rpc.canonicalBlockReference,
      ])).resolves.toMatchObject({ error: { code: -32601 } });
      for (const [selector, result] of [
        ["0x18160ddd", `0x${BigInt(rpc.token.totalSupplyRaw).toString(16).padStart(64, "0")}`],
        ["0x313ce567", `0x${BigInt(rpc.token.decimals).toString(16).padStart(64, "0")}`],
      ] as const) {
        await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_call", [{
          to: rpc.token.address,
          data: selector,
        }, rpc.canonicalBlockReference])).resolves.toMatchObject({ result });
      }
      await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_sendTransaction", [{}])).resolves.toMatchObject({
        error: { code: -32601 },
      });
      expect(() => rpc.assertNoUnexpectedMethods()).toThrow("eth_sendTransaction");
    } finally {
      await rpc.close();
    }
  });

  it("serves one exact large included transaction and rejects adjacent identities", async () => {
    const rpc = await startFakeRpc();
    try {
      const transaction = await rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getTransactionByHash", [
        rpc.semanticReads.transaction.transactionHash,
      ]) as { result?: { input?: unknown } };
      expect(transaction.result?.input).toBe(rpc.semanticReads.transaction.input);

      const receipt = await rpcRequest(rpc.url, rpc.caCertificatePath, "eth_getTransactionReceipt", [
        rpc.semanticReads.transaction.transactionHash,
      ]) as { result?: { logs?: readonly { data?: unknown }[] } };
      expect(receipt.result?.logs?.[0]?.data).toBe(rpc.semanticReads.transaction.undecodedLogData);
      expect(receipt.result?.logs?.[1]).toMatchObject({
        address: rpc.semanticReads.transaction.transferToken,
      });

      for (const [method, params] of [
        ["eth_getTransactionByHash", [`0x${"76".repeat(32)}`]],
        ["eth_getTransactionReceipt", [`0x${"76".repeat(32)}`]],
        ["eth_getBlockByHash", [rpc.canonicalBlockReference.blockHash, true]],
      ] as const) {
        await expect(rpcRequest(rpc.url, rpc.caCertificatePath, method, params)).resolves.toMatchObject({
          error: { code: -32601 },
        });
      }
      expect(() => rpc.assertNoUnexpectedMethods()).toThrow("eth_getTransactionByHash");
    } finally {
      await rpc.close();
    }
  });

  it("rejects token reads outside the exact address, selector, and canonical block", async () => {
    const rpc = await startFakeRpc();
    try {
      for (const params of [
        [{ to: `0x${"33".repeat(20)}`, data: "0x18160ddd" }, rpc.canonicalBlockReference],
        [{ to: rpc.token.address, data: "0x70a08231" }, rpc.canonicalBlockReference],
        [{ to: rpc.token.address, data: "0x18160ddd" }, "latest"],
      ] as const) {
        await expect(rpcRequest(rpc.url, rpc.caCertificatePath, "eth_call", params)).resolves.toMatchObject({
          error: { code: -32601 },
        });
      }
      expect(() => rpc.assertNoUnexpectedMethods()).toThrow("eth_call");
    } finally {
      await rpc.close();
    }
  });

  it("generates a static installed-package worker without loader or remote imports", () => {
    const identity = parseReleasePackageIdentity(
      JSON.parse(readFileSync("package.json", "utf8")),
    );
    const source = renderPackagedOwnerWorkerSource(identity.installRelativePath);
    const imports = inspectModuleImports(source, "release-owner-worker.mjs");
    expect(imports).toHaveLength(10);
    expect(imports.every((entry) =>
      entry.kind === "module" &&
      typeof entry.specifier === "string" &&
      (entry.specifier.startsWith("node:") ||
        entry.specifier.startsWith(`./${identity.installRelativePath}/dist/`))
    )).toBe(true);
    expect(source).not.toMatch(/\b(?:eval|Function|createRequire)\s*\(/u);
    expect(source).not.toContain("http://");
    expect(source).not.toContain("https://");
    expect(source).not.toContain("wc:");
    expect(source).not.toContain("pairingTopic");
  });
});
