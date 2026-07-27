import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import { chainErrorRegistry, chainInterfaceErrorMappings } from "../../src/chain/errors.js";
import {
  canonicalJsonStringify,
  captureCanonicalJson,
  chainStatusCapability,
  createApplicationFailure,
  type CanonicalJson,
} from "../../src/core/index.js";
import {
  parseReadCliCommand,
  runReadCliCommand as runReadCliCommandWithClient,
  type ReadCliOutputPort,
} from "../../src/interfaces/cli-read.js";
import { LocalOperationClient } from "../../src/interfaces/operation-client.js";
import {
  toProblemDetails,
  type RuntimeDispatchRequest,
  type RuntimeDispatchResponse,
} from "../../src/runtime/index.js";
import {
  runCli,
  type CliRuntimePort,
  type CliTerminalPort,
} from "../../src/cli.js";
import {
  uniswapV2FactoryAddress,
  uniswapV2QuoteInputSchema,
} from "../../src/protocols/uniswap-v2/index.js";
import {
  ScriptedRpc,
  createChainHandlerHarness,
  disconnectedWallet,
  rpcValue,
  type ChainHandlerHarness,
} from "../chain/handler-harness.js";
import { createUniswapV2DirectQuoteSuccess } from "../protocols/interface-harness.js";
import { openTestOwnerSession } from "./owner-session-harness.js";

const address = `0x${"11".repeat(20)}`;
const tokenA = `0x${"22".repeat(20)}`;
const tokenB = `0x${"33".repeat(20)}`;
const transactionHash = `0x${"44".repeat(32)}`;
const blockHash = `0x${"55".repeat(32)}`;
let encoder: Erc20CallEncoder;
const harnesses: ChainHandlerHarness[] = [];

beforeAll(async () => { encoder = await createErc20CallEncoder(); });
afterEach(async () => { await Promise.all(harnesses.splice(0).map((harness) => harness.close())); });

class FakeRuntime implements CliRuntimePort {
  readonly ownerState = "deferred" as const;
  readonly requests: RuntimeDispatchRequest[] = [];
  startCount = 0;
  stopCount = 0;
  readonly #response: RuntimeDispatchResponse;

  constructor(response: RuntimeDispatchResponse) { this.#response = response; }
  async start(): Promise<void> { this.startCount += 1; }
  async stop(): Promise<void> { this.stopCount += 1; }
  openOwnerSession(signal?: AbortSignal) { return openTestOwnerSession(this, signal); }
  async dispatchRuntimeRequest(request: RuntimeDispatchRequest): Promise<RuntimeDispatchResponse> {
    this.requests.push(request);
    return this.#response;
  }
}

const runReadCliCommand = (
  runtime: FakeRuntime,
  command: ReturnType<typeof parseReadCliCommand>,
  output: ReadCliOutputPort,
  signal?: AbortSignal,
) => runReadCliCommandWithClient(
  runtime,
  new LocalOperationClient({
    ownerSessions: runtime,
    createOperationId: () => "A".repeat(43),
  }),
  command,
  output,
  signal,
);

const outputPort = (): ReadCliOutputPort & { readonly output: string[]; readonly errors: string[] } => {
  const output: string[] = [];
  const errors: string[] = [];
  return Object.freeze({
    output,
    errors,
    writeOutput: (value: string) => { output.push(value); },
    writeError: (value: string) => { errors.push(value); },
  });
};

const nonInteractiveTerminal = (): CliTerminalPort & {
  readonly output: string[];
  readonly errors: string[];
  disposed(): boolean;
} => {
  const output: string[] = [];
  const errors: string[] = [];
  let disposed = false;
  return Object.freeze({
    inputIsTTY: false,
    outputIsTTY: false,
    columns: undefined,
    rows: undefined,
    interruptSignal: new AbortController().signal,
    output,
    errors,
    writeOutput: (value: string) => { output.push(value); },
    writeError: (value: string) => { errors.push(value); },
    showQr: () => { throw new Error("Read CLI must not show QR."); },
    hideQr: () => { throw new Error("Read CLI must not hide QR."); },
    readLine: async () => { throw new Error("Read CLI must not read terminal input."); },
    dispose: () => { disposed = true; },
    disposed: () => disposed,
  });
};

const chainStatusSuccess = async (): Promise<CanonicalJson> => {
  const harness = createChainHandlerHarness({
    rpc: new ScriptedRpc([
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", {
        number: "0x20000000000001",
        hash: blockHash,
        timestamp: "0x65a00000",
        transactions: [],
      }),
    ]),
    encoder,
    wallet: disconnectedWallet(),
  });
  harnesses.push(harness);
  const result = await harness.invoke(chainStatusCapability, {});
  if (!result.ok) throw new Error("Expected a chain status success.");
  return captureCanonicalJson(result);
};

describe("read CLI", () => {
  it("accepts only the fixed grammar and delegates semantic canonicalization to the capability contract", () => {
    expect(parseReadCliCommand(["read", "chain-status"])).toEqual({ kind: "chain_status", json: false });
    expect(parseReadCliCommand(["read", "transaction", transactionHash, "--json"]))
      .toMatchObject({ kind: "transaction", json: true, input: { transactionHash } });
    expect(parseReadCliCommand([
      "read", "contract", address, "--block", "9007199254740993",
    ])).toMatchObject({
      kind: "contract",
      input: { address, block: { kind: "number", blockNumber: "9007199254740993" } },
    });
    expect(parseReadCliCommand([
      "read", "balance", "--token", tokenB, "--active", "--native", "false",
      "--block", "latest", "--token", tokenA,
    ])).toMatchObject({
      kind: "balance",
      input: {
        account: { kind: "active_wallet" },
        includeNative: false,
        tokens: [tokenA, tokenB],
        block: { kind: "latest" },
      },
    });
    expect(parseReadCliCommand([
      "read", "balance", "--address", address, "--native", "true", "--block", "latest",
    ])).toMatchObject({
      input: { account: { kind: "address", address }, includeNative: true, tokens: [] },
    });
    expect(parseReadCliCommand([
      "uniswap-v2",
      "quote-exact-input",
      "--factory",
      uniswapV2FactoryAddress,
      "--token-in",
      tokenA,
      "--token-out",
      tokenB,
      "--amount-in",
      "1000",
      "--block",
      "latest",
      "--json",
    ])).toEqual({
      kind: "uniswap_v2_quote",
      json: true,
      input: {
        tokenIn: { kind: "erc20", chainId: "eip155:4663", address: tokenA },
        tokenOut: { kind: "erc20", chainId: "eip155:4663", address: tokenB },
        factory: uniswapV2FactoryAddress,
        amountIn: "1000",
        block: { kind: "latest" },
      },
    });

    const invalid = [
      ["read", "chain-status", "extra"],
      ["read", "chain-status", "--json", "--json"],
      ["read", "balance", "--active", "true", "--native", "true", "--block", "latest"],
      ["read", "balance", "--active", "--address", address, "--native", "true", "--block", "latest"],
      ["read", "balance", "--active", "--native", "false", "--block", "latest"],
      ["read", "balance", "--active", "--native", "true", "--block", "latest", "--token", tokenA, "--token", tokenA],
      ["read", "contract", address, "--block", "01"],
      [
        "uniswap-v2", "quote-exact-input", "--factory", uniswapV2FactoryAddress,
        "--token-in", tokenA, "--token-out", tokenB, "--block", "latest",
      ],
      [
        "uniswap-v2", "quote-exact-input", "--factory", uniswapV2FactoryAddress,
        "--token-in", tokenA, "--token-out", tokenB, "--amount-in", "1000",
        "--amount-in", "1001", "--block", "latest",
      ],
      [
        "uniswap-v2", "quote-exact-input", "--factory", `0x${"99".repeat(20)}`,
        "--token-in", tokenA, "--token-out", tokenB, "--amount-in", "1000",
        "--block", "latest",
      ],
      [
        "uniswap-v2", "quote-exact-input", "--factory", uniswapV2FactoryAddress,
        "--token-in", tokenA, "--token-out", tokenA, "--amount-in", "1000",
        "--block", "latest",
      ],
    ];
    for (const command of invalid) expect(() => parseReadCliCommand(command)).toThrow();
  });

  it("dispatches a canonical read with the caller signal and emits the unchanged JSON result", async () => {
    const success = await chainStatusSuccess();
    const runtime = new FakeRuntime(Object.freeze({ status: 200, body: success }));
    const output = outputPort();
    const signal = new AbortController().signal;
    const command = parseReadCliCommand(["read", "chain-status", "--json"]);

    expect(await runReadCliCommand(runtime, command, output, signal)).toBe(0);
    expect(output.output).toEqual([`${canonicalJsonStringify(success)}\n`]);
    expect(output.errors).toEqual([]);
    expect(runtime.requests).toEqual([{
      requestClass: "public_read",
      method: "GET",
      path: "/api/v1/chain-status",
      signal,
    }]);
  });

  it("rejects the removed parallel chain identity instead of printing legacy JSON", async () => {
    const success = JSON.parse(JSON.stringify(await chainStatusSuccess())) as {
      data: Record<string, unknown>;
    };
    success.data["caip2"] = "eip155:4663";
    const output = outputPort();
    expect(await runReadCliCommand(
      new FakeRuntime(Object.freeze({ status: 200, body: captureCanonicalJson(success) })),
      parseReadCliCommand(["read", "chain-status", "--json"]),
      output,
    )).toBe(chainInterfaceErrorMappings.get("internal_error").cliExitCode);
    expect(output.errors).toEqual([]);
    expect(JSON.parse(output.output.join(""))).toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    expect(output.output.join("")).not.toContain("caip2");
  });

  it("rejects a structurally valid success from a different chain scope", async () => {
    const success = JSON.parse(JSON.stringify(await chainStatusSuccess())) as {
      data: { chainId: string; latestBlock: { chainId: string } };
    };
    success.data.chainId = "eip155:1";
    success.data.latestBlock.chainId = "eip155:1";
    const output = outputPort();
    expect(await runReadCliCommand(
      new FakeRuntime(Object.freeze({ status: 200, body: captureCanonicalJson(success) })),
      parseReadCliCommand(["read", "chain-status", "--json"]),
      output,
    )).toBe(chainInterfaceErrorMappings.get("internal_error").cliExitCode);
    expect(JSON.parse(output.output.join(""))).toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    expect(output.output.join("")).not.toContain("eip155:1");
  });

  it("uses exact integer text in human output without display arithmetic", async () => {
    const success = await chainStatusSuccess();
    const runtime = new FakeRuntime(Object.freeze({ status: 200, body: success }));
    const output = outputPort();
    expect(await runReadCliCommand(
      runtime,
      parseReadCliCommand(["read", "chain-status"]),
      output,
    )).toBe(0);
    expect(output.output.join("")).toContain("Latest block: 9007199254740993");
    expect(output.output.join("")).toContain(`Block hash: ${blockHash}`);
    expect(output.output.join("")).not.toContain("9,007,199");
  });

  it("reports the complete V2 candidate observations, evidence, and limitations", async () => {
    const input = uniswapV2QuoteInputSchema.parse({
      tokenIn: { kind: "erc20", chainId: "eip155:4663", address: tokenA },
      tokenOut: { kind: "erc20", chainId: "eip155:4663", address: tokenB },
      factory: uniswapV2FactoryAddress,
      amountIn: "1000",
      block: { kind: "latest" },
    });
    const success = await createUniswapV2DirectQuoteSuccess(input);
    const direct = success.data.candidates[0];
    if (direct?.status !== "quoted") throw new TypeError("Expected a direct V2 quote.");
    const hop = direct.evaluatedHops[0];
    if (hop?.status !== "completed") throw new TypeError("Expected a completed V2 hop.");
    const output = outputPort();
    expect(await runReadCliCommand(
      new FakeRuntime(Object.freeze({ status: 200, body: captureCanonicalJson(success) })),
      parseReadCliCommand([
        "uniswap-v2",
        "quote-exact-input",
        "--factory",
        uniswapV2FactoryAddress,
        "--token-in",
        tokenA,
        "--token-out",
        tokenB,
        "--amount-in",
        "1000",
        "--block",
        "latest",
      ]),
      output,
    )).toBe(0);
    const text = output.output.join("");
    expect(text).toContain(`Pair: ${hop.pair.pairAddress}`);
    expect(text).toContain(`Reserve 0: ${hop.pair.reserve0}`);
    expect(text).toContain(`Output: ${direct.amountOut}`);
    expect(text).toContain(
      `Deployment source revision: ${success.data.deployment.source.sourceRevision}`,
    );
    expect(text).toContain(
      `Deployment source coverage: ${success.data.deployment.source.coverage}`,
    );
    expect(text).toContain(
      `Route-asset source observed at: ${success.data.coverage.source.sourceObservedAt}`,
    );
    expect(text).toContain(
      `Route-asset source coverage: ${success.data.coverage.source.coverage}`,
    );
    for (const exclusion of success.data.deployment.source.exclusions) {
      expect(text).toContain(exclusion);
    }
    for (const conclusion of success.data.coverage.source.unsupportedConclusions) {
      expect(text).toContain(conclusion);
    }
    expect(text).toContain("Mid price (raw output units per raw input unit):");
    expect(text).toContain("Mid price (output tokens per input token):");
    expect(text).toContain("Execution price (raw output units per raw input unit):");
    expect(text).toContain("Execution price (output tokens per input token):");
    for (const source of success.evidence.sources) {
      expect(text).toContain(source.observationId);
      expect(text).toContain(source.recordDigest);
    }
    for (const conclusion of success.evidence.conclusions) {
      expect(text).toContain(conclusion.id);
    }
    expect(text).toContain("Limitation: This capability does not select a best route or venue.");
    expect(text).not.toContain("Best route:");
  });

  it("normalizes canonical errors to the shared CLI exit mapping", async () => {
    const failure = createApplicationFailure(chainErrorRegistry, "source_unavailable");
    const problem = toProblemDetails(failure, chainInterfaceErrorMappings);
    const runtime = new FakeRuntime(Object.freeze({
      status: problem.status,
      body: problem as unknown as CanonicalJson,
    }));
    const output = outputPort();
    expect(await runReadCliCommand(
      runtime,
      parseReadCliCommand(["read", "chain-status"]),
      output,
    )).toBe(chainInterfaceErrorMappings.get("source_unavailable").cliExitCode);
    expect(output.output).toEqual([]);
    expect(output.errors).toEqual(["source_unavailable: A required data source is unavailable.\n"]);
  });

  it("reports an aggregate read result failure through the canonical CLI mapping", async () => {
    const failure = createApplicationFailure(chainErrorRegistry, "result_too_large");
    const problem = toProblemDetails(failure, chainInterfaceErrorMappings);
    const output = outputPort();
    expect(await runReadCliCommand(
      new FakeRuntime(Object.freeze({
        status: problem.status,
        body: problem as unknown as CanonicalJson,
      })),
      parseReadCliCommand(["read", "chain-status"]),
      output,
    )).toBe(3);
    expect(output.output).toEqual([]);
    expect(output.errors).toEqual([
      "result_too_large: The canonical result exceeds the supported size.\n",
    ]);
  });

  it("does not expose registry errors outside the selected capability contract", async () => {
    const failure = createApplicationFailure(chainErrorRegistry, "not_found");
    const problem = toProblemDetails(failure, chainInterfaceErrorMappings);
    const output = outputPort();
    expect(await runReadCliCommand(
      new FakeRuntime(Object.freeze({
        status: problem.status,
        body: problem as unknown as CanonicalJson,
      })),
      parseReadCliCommand(["read", "chain-status"]),
      output,
    )).toBe(chainInterfaceErrorMappings.get("internal_error").cliExitCode);
    expect(output.errors).toEqual(["internal_error: The request could not be completed.\n"]);
  });

  it("runs a valid read through the product CLI without requiring an interactive terminal", async () => {
    const success = await chainStatusSuccess();
    const runtime = new FakeRuntime(Object.freeze({ status: 200, body: success }));
    const terminal = nonInteractiveTerminal();
    expect(await runCli(["read", "chain-status", "--json"], {
      createOperationId: () => "A".repeat(43),
      createRuntime: async () => runtime,
      terminal,
      waitForPoll: async () => undefined,
      terminateProcess: () => undefined,
    })).toBe(0);
    expect(terminal.output).toEqual([`${canonicalJsonStringify(success)}\n`]);
    expect(terminal.errors).toEqual([]);
    expect(terminal.disposed()).toBe(true);
    expect(runtime.startCount).toBe(1);
    expect(runtime.stopCount).toBe(1);
  });
});
