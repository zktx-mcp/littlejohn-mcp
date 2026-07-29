import { beforeAll, describe, expect, it } from "vitest";

import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import {
  contractAnalysisSchema,
  contractInspectCapability,
  parseEvmAddress,
} from "../../src/core/index.js";
import { publicInspectionPaths } from "../../src/interfaces/browser-contract.js";
import type {
  BrowserFetch,
  BrowserFetchInit,
} from "../../src/interfaces/web/browser-client.js";
import { inspectContract } from "../../src/interfaces/web/contract-inspection-client.js";
import {
  createChainHandlerHarness,
  disconnectedWallet,
  rpcValue,
  ScriptedRpc,
} from "../chain/handler-harness.js";

const address = parseEvmAddress(`0x${"1".repeat(40)}`);
const blockHash = `0x${"a".repeat(64)}` as const;
const runtimeCode = "0x6001600055";
const emptyStorageWord = `0x${"0".repeat(64)}`;
let encoder: Erc20CallEncoder;

beforeAll(async () => {
  encoder = await createErc20CallEncoder();
});

const createSuccess = async () => {
  const harness = createChainHandlerHarness({
    rpc: new ScriptedRpc([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", {
        number: "0x2a",
        hash: blockHash,
        timestamp: "0x687c3c00",
        transactions: [],
      }),
      rpcValue("eth_getCode", runtimeCode),
      rpcValue("eth_getStorageAt", emptyStorageWord),
      rpcValue("eth_getStorageAt", emptyStorageWord),
      rpcValue("eth_getStorageAt", emptyStorageWord),
    ]),
    encoder,
    wallet: disconnectedWallet(),
  });
  try {
    const result = await harness.invoke(contractInspectCapability, {
      address,
      block: { kind: "latest" },
    });
    if (!result.ok) throw new Error(`Contract inspection fixture failed: ${result.error.code}`);
    return result;
  } finally {
    await harness.close();
  }
};

const response = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

describe("contract inspection browser client", () => {
  it("uses the public route without credentials and applies complete public validation", async () => {
    const success = await createSuccess();
    const requests: Array<{ readonly path: string; readonly init: BrowserFetchInit }> = [];
    const request: BrowserFetch = async (path, init) => {
      requests.push({ path, init });
      return response(success);
    };
    const signal = new AbortController().signal;
    const input = { address, block: { kind: "latest" as const } };

    await expect(inspectContract(input, { request, signal })).resolves.toEqual(success);
    expect(requests).toEqual([{
      path: publicInspectionPaths.contractQueries,
      init: {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: expect.any(AbortSignal),
      },
    }]);
  });

  it("rejects a structurally valid result whose source claim no longer matches its evidence", async () => {
    const success = await createSuccess();
    const targetSource = success.data.analysis.sources[0];
    if (targetSource === undefined || targetSource.role !== "target") {
      throw new Error("Contract inspection fixture has no target source.");
    }
    const changedAnalysis = contractAnalysisSchema.parse({
      ...success.data.analysis,
      sources: [{ ...targetSource, status: "unavailable" }],
    });
    const changedClaim = {
      ...success,
      data: {
        ...success.data,
        analysis: changedAnalysis,
      },
    };
    const request: BrowserFetch = async () => response(changedClaim);

    await expect(inspectContract(
      { address, block: { kind: "latest" } },
      { request },
    )).rejects.toMatchObject({
      name: "BrowserRequestError",
      message: "The local response is invalid.",
      failure: {
        kind: "local_failure",
        code: "invalid_response",
        detail: "The local response is invalid.",
        retryable: false,
        issues: [],
      },
    });
  });
});
