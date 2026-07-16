import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  ObservationAuthorityRegistry,
  accountBalanceCapability,
  bindCapability,
  canonicalJsonStringify,
  chainAnchorSchema,
  chainStatusCapability,
  contractInspectCapability,
  coreErrorRegistry,
  createCanonicalClock,
  createCapabilityInvocationAuthority,
  createObservationAuthority,
  evmAddressSchema,
  getCapabilityDefinitionSnapshot,
  parseCapabilitySuccess,
  productDisplayName,
  safeParseCapabilityInput,
  safeParseCapabilityData,
  sourceReferenceSchema,
  walletConnectionCapability,
  type ObservationClaim,
  type ObservationWriter,
} from "../../src/core/index.js";
import { defineReadCapability } from "../../src/core/capability.js";
import {
  bindForHarness,
  createCapabilityHarness,
  fixedEvaluationTime,
  invokeBinding,
} from "./capability-harness.js";

const execFileAsync = promisify(execFile);

const runInvocationRngChild = async (mode: "success" | "failure") => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", resolve("test/core/invocation-rng-child.ts"), mode],
    { cwd: resolve("."), encoding: "utf8" },
  );
  expect(stderr).toBe("");
  return JSON.parse(stdout) as {
    readonly randomByteCalls: number;
    readonly handlerCalls: number;
    readonly block: typeof block;
    readonly result: Awaited<ReturnType<typeof invokeBinding<typeof chainStatusCapability>>>;
  };
};

const block = chainAnchorSchema.parse({
  chainId: "4663",
  blockNumber: "10",
  blockHash: `0x${"a".repeat(64)}`,
  blockTimestamp: fixedEvaluationTime,
});

const recordRpc = (
  context: Parameters<Parameters<typeof bindForHarness>[2]>[1],
  observations: ObservationWriter,
  slotId: string,
  claims: readonly ObservationClaim[],
) => observations.record(slotId, {
  source: context.ports.observations.get("chain_rpc"),
  claims,
});

const successfulHandler = (
  context: Parameters<Parameters<typeof bindForHarness>[2]>[1],
  observations: ObservationWriter,
) => {
  recordRpc(context, observations, "rpc_chain_id", [{ role: "chain_id", value: "4663" }]);
  recordRpc(context, observations, "latest_block", [{
    role: "latest_block",
    value: block,
    chainAnchor: block,
  }]);
  return {
    status: "success",
    data: { chainId: "4663", caip2: "eip155:4663", latestBlock: block },
  };
};

describe("capability binding authority", () => {
  it("derives canonical conclusions, coverage, and deterministic observation identity", async () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) =>
      successfulHandler(context, observations));
    const result = await invokeBinding(chainStatusCapability, binding, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.coverage.status).toBe("complete");
    expect(result.evidence.conclusions.map((item) => item.id)).toEqual([
      "latest_block_observed",
      "rpc_chain_id_matches_scope",
    ]);
    const chainIdSource = result.evidence.sources.find((item) => item.purpose === "chain_id");
    expect(chainIdSource).toBeDefined();
    const expected = `obs:${createHash("sha256").update(canonicalJsonStringify([
      "rpc_test",
      "chain_id",
      fixedEvaluationTime,
      null,
      chainIdSource?.invocationId ?? "",
      "0",
    ])).digest("base64url")}`;
    expect(chainIdSource?.observationId).toBe(expected);
    expect(result.evidence.sources.every((source) => source.invocationId === chainIdSource?.invocationId)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("separates concurrent invocations that observe the same millisecond", async () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) =>
      successfulHandler(context, observations));
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      invokeBinding(chainStatusCapability, binding, {})));
    expect(results.every((result) => result.ok)).toBe(true);
    const invocationIds = results.map((result) => result.ok ? result.evidence.sources[0]?.invocationId : undefined);
    const observationIds = results.flatMap((result) => result.ok
      ? result.evidence.sources.map((source) => source.observationId)
      : []);
    expect(invocationIds.every((value) => value?.startsWith("inv:") === true)).toBe(true);
    expect(new Set(invocationIds).size).toBe(invocationIds.length);
    expect(new Set(observationIds).size).toBe(observationIds.length);
  });

  it("uses one CSPRNG draw and binds anchored and unanchored ordinals independently", async () => {
    const child = await runInvocationRngChild("success");
    expect(child.randomByteCalls).toBe(1);
    expect(child.handlerCalls).toBe(1);
    expect(child.result.ok).toBe(true);
    if (!child.result.ok) return;
    const invocationId = `inv:${Buffer.alloc(32, 7).toString("base64url")}`;
    expect(child.result.evidence.sources.every((source) => source.invocationId === invocationId)).toBe(true);
    const chainId = child.result.evidence.sources.find((source) => source.purpose === "chain_id");
    const latestBlock = child.result.evidence.sources.find((source) => source.purpose === "latest_block");
    expect(chainId?.observationId).toBe(`obs:${createHash("sha256").update(canonicalJsonStringify([
      "rpc_test", "chain_id", fixedEvaluationTime, null, invocationId, "0",
    ])).digest("base64url")}`);
    expect(latestBlock?.observationId).toBe(`obs:${createHash("sha256").update(canonicalJsonStringify([
      "rpc_test", "latest_block", fixedEvaluationTime, child.block, invocationId, "1",
    ])).digest("base64url")}`);
  });

  it("fails closed before the handler when CSPRNG generation fails", async () => {
    const child = await runInvocationRngChild("failure");
    expect(child.randomByteCalls).toBe(1);
    expect(child.handlerCalls).toBe(0);
    expect(child.result.ok).toBe(false);
    if (child.result.ok) return;
    expect(child.result.error.code).toBe("internal_error");
    expect(JSON.stringify(child)).not.toContain("secret-rng-provider-detail");
  });

  it("rejects data that differs from definition-owned source claims", async () => {
    const otherBlock = chainAnchorSchema.parse({
      ...block,
      blockNumber: "11",
      blockHash: `0x${"b".repeat(64)}`,
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) => {
      const result = successfulHandler(context, observations);
      return { ...result, data: { ...result.data, latestBlock: otherBlock } };
    });
    const result = await invokeBinding(chainStatusCapability, binding, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("internal_error");
  });

  it("contains hostile handler wrappers without reading getters or disclosing values", async () => {
    const harness = createCapabilityHarness();
    const extra = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) => ({
      ...successfulHandler(context, observations),
      unexpected: "secret-provider-payload",
    }));
    const extraFailure = await invokeBinding(chainStatusCapability, extra, {});
    expect(extraFailure.ok).toBe(false);
    expect(JSON.stringify(extraFailure)).not.toContain("secret-provider-payload");

    let getterInvoked = false;
    const getterResult = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error("secret-provider-payload");
      },
    });
    const getter = bindForHarness(chainStatusCapability, harness, async () => getterResult);
    const getterFailure = await invokeBinding(chainStatusCapability, getter, {});
    expect(getterInvoked).toBe(false);
    expect(getterFailure.ok).toBe(false);

    const proxy = bindForHarness(chainStatusCapability, harness, async () => new Proxy({}, {
      ownKeys() {
        throw new Error("secret-provider-payload");
      },
    }));
    const proxyFailure = await invokeBinding(chainStatusCapability, proxy, {});
    expect(proxyFailure.ok).toBe(false);
    expect(JSON.stringify(proxyFailure)).not.toContain("secret-provider-payload");

    let nestedGetterInvoked = false;
    const hostileArray: unknown[] = [];
    Object.defineProperty(hostileArray, "0", {
      enumerable: true,
      get() {
        nestedGetterInvoked = true;
        return "secret-provider-payload";
      },
    });
    Object.defineProperty(hostileArray, "length", { value: 1 });
    const nested = bindForHarness(chainStatusCapability, harness, async () => ({
      status: "failure",
      code: "internal_error",
      issues: hostileArray,
    }));
    const nestedFailure = await invokeBinding(chainStatusCapability, nested, {});
    expect(nestedGetterInvoked).toBe(false);
    expect(nestedFailure.ok).toBe(false);

    let lengthRead = false;
    const proxiedIssues = new Proxy([], {
      get(target, key, receiver) {
        if (key === "length") lengthRead = true;
        return Reflect.get(target, key, receiver);
      },
    });
    const arrayProxy = bindForHarness(chainStatusCapability, harness, async () => ({
      status: "failure",
      code: "internal_error",
      issues: proxiedIssues,
    }));
    expect((await invokeBinding(chainStatusCapability, arrayProxy, {})).ok).toBe(false);
    expect(lengthRead).toBe(false);

    const prototypeData = bindForHarness(chainStatusCapability, harness, async () => JSON.parse(`{
      "status":"success",
      "data":{
        "chainId":"4663",
        "caip2":"eip155:4663",
        "latestBlock":{
          "chainId":"4663",
          "blockNumber":"10",
          "blockHash":"0x${"a".repeat(64)}",
          "blockTimestamp":"${fixedEvaluationTime}"
        },
        "__proto__":[]
      }
    }`));
    expect((await invokeBinding(chainStatusCapability, prototypeData, {})).ok).toBe(false);
  });

  it("rejects forged observation tokens and a non-monotonic authority clock", async () => {
    const harness = createCapabilityHarness();
    const forged = bindForHarness(chainStatusCapability, harness, async (_input, _context, observations) => {
      observations.record("rpc_chain_id", {} as never);
      return { status: "success", data: { chainId: "4663", caip2: "eip155:4663", latestBlock: block } };
    });
    expect((await invokeBinding(chainStatusCapability, forged, {})).ok).toBe(false);

    const unregistered = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) => {
      const source = createObservationAuthority({
        clock: context.clock,
        sourceClass: "chain_rpc",
        owner: "forged_provider",
        reference: sourceReferenceSchema.parse({
          kind: "public",
          sourceId: "rpc_forged",
          uri: "https://forged.example/",
        }),
      });
      observations.record("rpc_chain_id", {
        source,
        claims: [{ role: "chain_id", value: "4663" }],
      });
      return { status: "success", data: { chainId: "4663", caip2: "eip155:4663", latestBlock: block } };
    });
    expect((await invokeBinding(chainStatusCapability, unregistered, {})).ok).toBe(false);

    let reads = 0;
    const nonMonotonic = createCapabilityHarness(() => {
      reads += 1;
      return reads <= 2 ? "2099-01-01T00:00:00.000Z" : fixedEvaluationTime;
    });
    const future = bindForHarness(chainStatusCapability, nonMonotonic, async (_input, context, observations) =>
      successfulHandler(context, observations));
    expect((await invokeBinding(chainStatusCapability, future, {})).ok).toBe(false);
  });

  it("normalizes invalid input and handler exceptions without rejected data", async () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async () => {
      throw new Error("secret-provider-payload");
    });
    const inputFailure = await invokeBinding(chainStatusCapability, binding, { unexpected: "private-address" });
    expect(inputFailure.ok).toBe(false);
    expect(JSON.stringify(inputFailure)).not.toContain("private-address");
    const handlerFailure = await invokeBinding(chainStatusCapability, binding, {});
    expect(handlerFailure.ok).toBe(false);
    expect(JSON.stringify(handlerFailure)).not.toContain("secret-provider-payload");
  });

  it("fixes definition slot order before input-dependent invocation ports perform work", async () => {
    const events: string[] = [];
    const definition = defineReadCapability<{ values: string[] }, { values: string[] }>({
      capabilityId: "test.portlifecycle",
      inputSchema: z.object({ values: z.array(z.string()).min(1) }).strict(),
      dataSchema: z.object({ values: z.array(z.string()).min(1) }).strict(),
      normalizeInput: (input) => ({ values: [...input.values].sort() }),
      conclusionIds: ["input_validated"],
      observationSlots: (input) => {
        events.push(`slots:${input.values.join(",")}`);
        return [{
          slotId: "input",
          factId: "input",
          kind: "validated_input" as const,
          purpose: "validated_input",
        }];
      },
      observationExpectations: (input) => [{
        slotId: "input",
        claims: [{ role: "validated_input", value: input as never }],
      }],
      factRequirements: () => [{
        factId: "input",
        observationSlotIds: ["input"],
        requiredObservationSlotIds: ["input"],
        minimumObservationCount: 1,
        outcome: "validated_input" as const,
      }],
      deriveConclusions: () => [{
        id: "input_validated",
        outcomeFactId: "input",
        evidenceFactIds: ["input"],
        freshnessRuleId: "validated_input_current" as const,
      }],
      deriveWarnings: () => [],
      validateInvocation: (input, data) => {
        if (input.values.join("\0") !== data.values.join("\0")) throw new TypeError("Input mismatch.");
      },
      warningCodes: [],
      staticScopeExclusions: [],
    });
    const harness = createCapabilityHarness();
    const binding = bindCapability({
      definition,
      errorRegistry: coreErrorRegistry,
      invocationAuthority: harness.invocationAuthority,
      createInvocationPorts: (input) => {
        events.push(`ports:${input.values.join(",")}`);
        return harness.ports;
      },
      handler: async (input) => {
        events.push(`handler:${input.values.join(",")}`);
        return { status: "success", data: input };
      },
    });

    expect((await invokeBinding(definition, binding, { values: ["b", "a"] })).ok).toBe(true);
    expect(events).toEqual(["slots:a,b", "ports:a,b", "handler:a,b"]);

    events.length = 0;
    expect((await invokeBinding(definition, binding, { values: [] })).ok).toBe(false);
    expect(events).toEqual([]);
  });

  it("does not accept handler-controlled issue messages or value-derived paths", async () => {
    const harness = createCapabilityHarness();
    const message = bindForHarness(chainStatusCapability, harness, async () => ({
      status: "failure",
      code: "invalid_input",
      issues: [{ path: "", code: "invalid_value", message: "secret-provider-payload" }],
    }));
    const messageFailure = await invokeBinding(chainStatusCapability, message, {});
    expect(messageFailure.ok).toBe(false);
    expect(JSON.stringify(messageFailure)).not.toContain("secret-provider-payload");

    const path = bindForHarness(chainStatusCapability, harness, async () => ({
      status: "failure",
      code: "invalid_input",
      issues: [{
        path: "/0x1111111111111111111111111111111111111111",
        code: "invalid_value",
        message: "The field value is invalid.",
      }],
    }));
    const pathFailure = await invokeBinding(chainStatusCapability, path, {});
    expect(pathFailure.ok).toBe(false);
    expect(JSON.stringify(pathFailure)).not.toContain("0x1111111111111111111111111111111111111111");

    const arrayProperty = bindForHarness(accountBalanceCapability, harness, async () => ({
      status: "failure",
      code: "invalid_input",
      issues: [{
        path: "/tokens/length",
        code: "invalid_value",
        message: "The field value is invalid.",
      }],
    }));
    const arrayPropertyFailure = await invokeBinding(accountBalanceCapability, arrayProperty, {
      account: { kind: "address", address: `0x${"1".repeat(40)}` },
      includeNative: false,
      tokens: [`0x${"2".repeat(40)}`],
      block: { kind: "latest" },
    });
    expect(arrayPropertyFailure.ok).toBe(false);
    if (!arrayPropertyFailure.ok) expect(arrayPropertyFailure.error.code).toBe("internal_error");
  });

  it("bounds high-cardinality input issues without rejecting the invocation promise", async () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(accountBalanceCapability, harness, async () => {
      throw new Error("Handler must not run for invalid input.");
    });
    const result = await invokeBinding(accountBalanceCapability, binding, {
      account: { kind: "address", address: `0x${"1".repeat(40)}` },
      includeNative: false,
      tokens: Array.from({ length: 100 }, () => "not-an-address"),
      block: { kind: "latest" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.length).toBeLessThanOrEqual(64);
  });

  it("keeps raw schemas and callbacks private behind an opaque definition handle", () => {
    expect(Reflect.ownKeys(chainStatusCapability)).toEqual([]);
    const snapshot = getCapabilityDefinitionSnapshot(chainStatusCapability);
    expect(snapshot.capabilityId).toBe("chain.status");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.values(snapshot).some((value) => typeof value === "function")).toBe(false);
    expect(() => new CapabilityRegistry([{} as never])).toThrow("provenance");
  });

  it("keeps official private schemas independent from a caller-mutated public helper", () => {
    const runtime = (evmAddressSchema as unknown as { _zod: { run: unknown } })._zod;
    const original = runtime.run;
    try {
      runtime.run = () => ({ value: `0x${"1".repeat(40)}`, issues: [] });
      expect(safeParseCapabilityInput(contractInspectCapability, {
        address: "not-an-address",
        block: { kind: "latest" },
      }).success).toBe(false);
    } finally {
      runtime.run = original;
    }
  });

  it("captures one hostile input descriptor snapshot and rejects its unknown field", () => {
    let ownKeyReads = 0;
    const input = new Proxy({ unexpected: true }, {
      ownKeys() {
        ownKeyReads += 1;
        return ownKeyReads === 1 ? ["unexpected"] : [];
      },
      getOwnPropertyDescriptor(_target, key) {
        if (key === "unexpected") {
          return { configurable: true, enumerable: true, writable: true, value: true };
        }
        return undefined;
      },
    });
    expect(safeParseCapabilityInput(chainStatusCapability, input).success).toBe(false);
    expect(ownKeyReads).toBe(1);
  });

  it("freezes validated input before the handler receives it", async () => {
    const harness = createCapabilityHarness();
    let mutationRejected = false;
    const binding = bindForHarness(contractInspectCapability, harness, async (input, context, observations) => {
      try {
        (input as { address: string }).address = `0x${"9".repeat(40)}`;
      } catch {
        mutationRejected = true;
      }
      recordRpc(context, observations, "rpc_chain_id", [{ role: "chain_id", value: "4663" }]);
      recordRpc(context, observations, "block", [{
        role: "contract_block",
        value: { address: input.address, block },
        chainAnchor: block,
      }]);
      recordRpc(context, observations, "runtime_code", [{
        role: "runtime_code",
        value: { address: input.address, runtimeCode: { status: "empty" } },
        chainAnchor: block,
      }]);
      return {
        status: "success",
        data: { address: input.address, block, runtimeCode: { status: "empty" } },
      };
    });
    const result = await invokeBinding(contractInspectCapability, binding, {
      address: `0x${"1".repeat(40)}`,
      block: { kind: "latest" },
    });
    expect(mutationRejected).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("binds one opaque binding to one exact registered definition", () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) =>
      successfulHandler(context, observations));
    expect(() => new CapabilityBindingRegistry(
      new CapabilityRegistry([contractInspectCapability]),
      [binding as never],
    )).toThrow("provenance");
    expect(() => new CapabilityBindingRegistry(
      new CapabilityRegistry([chainStatusCapability]),
      [{} as never],
    )).toThrow("provenance");
    expect(() => new CapabilityRegistry([{ ...chainStatusCapability } as never])).toThrow("provenance");
    expect(() => new CapabilityRegistry([new Proxy(chainStatusCapability, {}) as never])).toThrow("provenance");
    expect(() => new CapabilityBindingRegistry(
      new CapabilityRegistry([chainStatusCapability]),
      [{ ...binding } as never],
    )).toThrow("provenance");
    expect(() => new CapabilityBindingRegistry(
      new CapabilityRegistry([chainStatusCapability]),
      [new Proxy(binding, {}) as never],
    )).toThrow("provenance");
  });

  it("rejects an error registry without core registry lineage at the bind boundary", () => {
    const harness = createCapabilityHarness();
    const forgedRegistry = Object.create(Object.getPrototypeOf(coreErrorRegistry)) as typeof coreErrorRegistry;
    expect(() => bindCapability({
      definition: chainStatusCapability,
      errorRegistry: forgedRegistry,
      invocationAuthority: harness.invocationAuthority,
      createInvocationPorts: () => harness.ports,
      handler: async () => ({ status: "failure", code: "internal_error", issues: [] }),
    })).toThrow("provenance");
  });

  it("creates and captures invocation ports exactly once after input validation", async () => {
    const base = createCapabilityHarness();
    let calls = 0;
    const binding = bindCapability({
      definition: chainStatusCapability,
      errorRegistry: coreErrorRegistry,
      invocationAuthority: base.invocationAuthority,
      createInvocationPorts: () => {
        calls += 1;
        return { observations: base.ports.observations };
      },
      handler: async (_input, context, observations) => successfulHandler(context, observations),
    });

    const invalid = await invokeBinding(chainStatusCapability, binding, { unexpected: true });
    expect(invalid.ok).toBe(false);
    expect(calls).toBe(0);
    expect((await invokeBinding(chainStatusCapability, binding, {})).ok).toBe(true);
    expect(calls).toBe(1);
    expect((await invokeBinding(chainStatusCapability, binding, {})).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("fails closed on hostile invocation-port factories without running the handler", async () => {
    const base = createCapabilityHarness();
    const wrongClock = createCapabilityHarness();
    let getterReads = 0;
    const accessorPorts = Object.defineProperty({}, "observations", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("secret accessor value");
      },
    });
    const factories: readonly (() => unknown)[] = [
      () => { throw new Error("secret factory value"); },
      () => new Proxy({}, {
        getPrototypeOf() { throw new Error("secret proxy value"); },
      }),
      () => accessorPorts,
      () => Promise.resolve(base.ports),
      () => Object.create({ observations: base.ports.observations }),
      () => wrongClock.ports,
    ];

    for (const createInvocationPorts of factories) {
      let handlerCalls = 0;
      const binding = bindCapability({
        definition: chainStatusCapability,
        errorRegistry: coreErrorRegistry,
        invocationAuthority: base.invocationAuthority,
        createInvocationPorts: createInvocationPorts as () => typeof base.ports,
        handler: async (_input, context, observations) => {
          handlerCalls += 1;
          return successfulHandler(context, observations);
        },
      });
      const result = await invokeBinding(chainStatusCapability, binding, {});
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected an internal failure.");
      expect(result.error.code).toBe("internal_error");
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(handlerCalls).toBe(0);
    }
    expect(getterReads).toBe(0);
  });

  it("keeps each invocation on the one captured authority snapshot", async () => {
    const clock = createCanonicalClock(() => fixedEvaluationTime);
    const invocationAuthority = createCapabilityInvocationAuthority(clock);
    const registry = (label: string) => new ObservationAuthorityRegistry(clock, [
      createObservationAuthority({
        clock,
        sourceClass: "chain_rpc",
        owner: "user_configured",
        reference: sourceReferenceSchema.parse({
          kind: "public",
          sourceId: `rpc_${label}`,
          uri: `https://${label}.example/`,
        }),
      }),
    ]);
    const firstRegistry = registry("first");
    const secondRegistry = registry("second");
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const mutablePorts = { observations: firstRegistry };
    const binding = bindCapability({
      definition: chainStatusCapability,
      errorRegistry: coreErrorRegistry,
      invocationAuthority,
      createInvocationPorts: () => mutablePorts,
      handler: async (_input, context, observations) => {
        await gate;
        return successfulHandler(context, observations);
      },
    });

    const first = invokeBinding(chainStatusCapability, binding, {});
    mutablePorts.observations = secondRegistry;
    const second = invokeBinding(chainStatusCapability, binding, {});
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    if (!firstResult.ok || !secondResult.ok) return;
    expect(firstResult.evidence.sources.find(({ purpose }) => purpose === "chain_id")?.reference)
      .toMatchObject({ uri: "https://first.example/" });
    expect(secondResult.evidence.sources.find(({ purpose }) => purpose === "chain_id")?.reference)
      .toMatchObject({ uri: "https://second.example/" });
  });

  it("parses a strict transport success with definition-owned data invariants", async () => {
    const harness = createCapabilityHarness(() => "2026-07-12T10:16:02.000Z");
    const connected = {
      status: "connected" as const,
      account: "eip155:4663:0x1111111111111111111111111111111111111111",
      address: "0x1111111111111111111111111111111111111111",
      chainId: "eip155:4663" as const,
      approvedMethods: ["eth_sendTransaction"],
      approvedEvents: ["accountsChanged", "chainChanged"],
      expiresAt: "2026-07-13T10:16:02.000Z",
    };
    const binding = bindForHarness(walletConnectionCapability, harness, async (_input, context, observations) => {
      observations.record("wallet_sdk", {
        source: context.ports.observations.get("wallet_sdk"),
        claims: [{ role: "wallet_sdk_state", value: connected }],
      });
      observations.record("wallet_session", {
        source: context.ports.observations.get("wallet_session"),
        claims: [{ role: "wallet_session_state", value: connected }],
      });
      return { status: "success", data: connected };
    });
    const result = await invokeBinding(walletConnectionCapability, binding, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseCapabilitySuccess(walletConnectionCapability, result);
    expect(parsed).toEqual(result);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.data)).toBe(true);

    expect(() => parseCapabilitySuccess(walletConnectionCapability, {
      ...result,
      unexpected: true,
    })).toThrow();
    expect(() => parseCapabilitySuccess(walletConnectionCapability, {
      ...result,
      meta: { ...result.meta, capabilityId: "chain.status" },
    })).toThrow();
    expect(() => parseCapabilitySuccess(walletConnectionCapability, {
      ...result,
      data: { ...result.data, account: `eip155:4663:0x${"2".repeat(40)}` },
    })).toThrow();
    expect(() => parseCapabilitySuccess(walletConnectionCapability, {
      ...result,
      meta: { ...result.meta, evaluatedAt: connected.expiresAt },
    })).toThrow();

    let getterReads = 0;
    const hostile = Object.defineProperty({}, "ok", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("secret transport value");
      },
    });
    expect(() => parseCapabilitySuccess(walletConnectionCapability, hostile)).toThrow();
    expect(getterReads).toBe(0);
    expect(() => parseCapabilitySuccess(walletConnectionCapability, new Proxy({}, {
      ownKeys(): never { throw new Error("secret transport proxy"); },
    }))).toThrow();
  });

  it("rejects a capability target that differs from its validated request", async () => {
    const inputAddress = `0x${"1".repeat(40)}`;
    const outputAddress = `0x${"2".repeat(40)}`;
    const harness = createCapabilityHarness();
    const binding = bindForHarness(contractInspectCapability, harness, async (_input, context, observations) => {
      recordRpc(context, observations, "rpc_chain_id", [{ role: "chain_id", value: "4663" }]);
      recordRpc(context, observations, "block", [{
        role: "contract_block",
        value: { address: outputAddress, block },
        chainAnchor: block,
      }]);
      recordRpc(context, observations, "runtime_code", [{
        role: "runtime_code",
        value: { address: outputAddress, runtimeCode: { status: "empty" } },
        chainAnchor: block,
      }]);
      return {
        status: "success",
        data: { address: outputAddress, block, runtimeCode: { status: "empty" } },
      };
    });
    const result = await invokeBinding(
      contractInspectCapability,
      binding,
      { address: inputAddress, block: { kind: "latest" } },
    );
    expect(result.ok).toBe(false);
  });

  it("makes validated-input fact support binder-owned", async () => {
    let dataMutationRejected = false;
    let factMutationRejected = false;
    let factSetExposed = false;
    const definition = defineReadCapability<{ value: string }, { value: string }>({
      capabilityId: "test.validated",
      inputSchema: z.object({ value: z.string() }).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      conclusionIds: ["input_validated"],
      observationSlots: () => [{
        slotId: "input",
        factId: "input",
        kind: "validated_input" as const,
        purpose: "validated_input",
      }],
      observationExpectations: (input, data) => {
        try {
          data.value = "mutated";
        } catch {
          dataMutationRejected = true;
        }
        return [{
          slotId: "input",
          claims: [{ role: "validated_input", value: input as never }],
        }];
      },
      factRequirements: () => [{
        factId: "input",
        observationSlotIds: ["input"],
        requiredObservationSlotIds: ["input"],
        minimumObservationCount: 1,
        outcome: "validated_input" as const,
      }],
      deriveConclusions: (_input, _data, facts) => {
        factSetExposed = typeof (facts as unknown as { set?: unknown }).set === "function";
        const fact = facts.get("input");
        try {
          if (fact !== undefined) (fact as { outcome: string }).outcome = "source_failed";
        } catch {
          factMutationRejected = true;
        }
        return [{
          id: "input_validated",
          outcomeFactId: "input",
          evidenceFactIds: ["input"],
          freshnessRuleId: "validated_input_current" as const,
        }];
      },
      deriveWarnings: () => [],
      validateInvocation: (input, data) => {
        if (input.value !== data.value) throw new TypeError("Input mismatch.");
      },
      warningCodes: [],
      staticScopeExclusions: [],
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async (input) => ({
      status: "success",
      data: input,
    }));
    const result = await invokeBinding(definition, binding, { value: "safe" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.value).toBe("safe");
      expect(result.evidence.sources.find((source) => source.sourceClass === "validated_input")?.owner)
        .toBe(`${productDisplayName} validated input`);
    }
    expect(dataMutationRejected).toBe(true);
    expect(factMutationRejected).toBe(true);
    expect(factSetExposed).toBe(false);
  });

  it("binds dynamic conclusion identities to one declared address template", async () => {
    const address = `0x${"3".repeat(40)}`;
    const definition = defineReadCapability<{ address: string }, { address: string }>({
      capabilityId: "test.dynamicconclusion",
      inputSchema: z.object({ address: z.string().regex(/^0x[0-9a-f]{40}$/) }).strict(),
      dataSchema: z.object({ address: z.string().regex(/^0x[0-9a-f]{40}$/) }).strict(),
      conclusionIds: ["address_observed:<address>"],
      expectedConclusionIds: (input) => [`address_observed:${input.address}`],
      observationSlots: () => [{
        slotId: "input",
        factId: "input",
        kind: "validated_input" as const,
        purpose: "validated_input",
      }],
      observationExpectations: (input) => [{
        slotId: "input",
        claims: [{ role: "validated_input", value: input as never }],
      }],
      factRequirements: () => [{
        factId: "input",
        observationSlotIds: ["input"],
        requiredObservationSlotIds: ["input"],
        minimumObservationCount: 1,
        outcome: "validated_input" as const,
      }],
      deriveConclusions: (input) => [{
        id: `address_observed:${input.address}`,
        outcomeFactId: "input",
        evidenceFactIds: ["input"],
        freshnessRuleId: "validated_input_current" as const,
      }],
      deriveWarnings: () => [],
      validateInvocation: (input, data) => {
        if (input.address !== data.address) throw new TypeError("Address mismatch.");
      },
      warningCodes: [],
      staticScopeExclusions: [],
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async (input) => ({ status: "success", data: input }));
    const result = await invokeBinding(definition, binding, { address });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence.conclusions[0]?.id).toBe(`address_observed:${address}`);
  });

  it("rejects data meaning that references an exclusion absent from its descriptor", () => {
    const definition = defineReadCapability<{}, { value: string }>({
      capabilityId: "test.scopeexclusion",
      inputSchema: z.object({}).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      conclusionIds: ["value_observed"],
      observationSlots: () => [],
      observationExpectations: () => [],
      factRequirements: () => [],
      deriveConclusions: () => [],
      deriveWarnings: () => [],
      validateIntrinsicData: (_data, context) => context.assertDeclaredScopeExclusion({
        id: "missing_exclusion" as never,
        message: "This exclusion is not declared.",
      }),
      validateInvocation: () => undefined,
      warningCodes: [],
      staticScopeExclusions: [],
    });
    expect(safeParseCapabilityData(definition, { value: "safe" }).success).toBe(false);
  });

  it("requires every observation slot to be owned by its exact fact requirement", async () => {
    const definition = defineReadCapability<{}, { value: string }>({
      capabilityId: "test.slotownership",
      inputSchema: z.object({}).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      conclusionIds: ["value_observed"],
      observationSlots: () => [
        { slotId: "used", factId: "value", kind: "source", purpose: "used", sourceClass: "chain_rpc" },
        { slotId: "orphan", factId: "value", kind: "source", purpose: "orphan", sourceClass: "chain_rpc" },
      ],
      observationExpectations: () => [
        { slotId: "used", claims: [{ role: "used", value: "safe", chainAnchor: block }] },
        { slotId: "orphan", claims: [{ role: "orphan", value: "safe", chainAnchor: block }] },
      ],
      factRequirements: () => [{
        factId: "value",
        observationSlotIds: ["used"],
        requiredObservationSlotIds: ["used"],
        minimumObservationCount: 1,
        outcome: "observed",
      }],
      deriveConclusions: () => [{
        id: "value_observed",
        outcomeFactId: "value",
        evidenceFactIds: ["value"],
        freshnessRuleId: "chain_anchor_exact",
      }],
      deriveWarnings: () => [],
      validateInvocation: () => undefined,
      warningCodes: [],
      staticScopeExclusions: [],
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async (_input, context, observations) => {
      recordRpc(context, observations, "used", [{ role: "used", value: "safe", chainAnchor: block }]);
      recordRpc(context, observations, "orphan", [{ role: "orphan", value: "safe", chainAnchor: block }]);
      return { status: "success", data: { value: "safe" } };
    });
    expect((await invokeBinding(definition, binding, {})).ok).toBe(false);
  });

  it("requires each fact requirement to declare one observation authority", async () => {
    const definition = defineReadCapability<{}, { value: string }>({
      capabilityId: "test.factauthority",
      inputSchema: z.object({}).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      conclusionIds: ["input_validated"],
      observationSlots: () => [
        { slotId: "input", factId: "input", kind: "validated_input", purpose: "validated_input" },
        { slotId: "source", factId: "input", kind: "source", purpose: "source", sourceClass: "chain_rpc" },
      ],
      observationExpectations: (input) => [{
        slotId: "input",
        claims: [{ role: "validated_input", value: input as never }],
      }],
      factRequirements: () => [{
        factId: "input",
        observationSlotIds: ["input", "source"],
        requiredObservationSlotIds: ["input"],
        minimumObservationCount: 1,
        outcome: "validated_input",
      }],
      deriveConclusions: () => [{
        id: "input_validated",
        outcomeFactId: "input",
        evidenceFactIds: ["input"],
        freshnessRuleId: "validated_input_current",
      }],
      deriveWarnings: () => [],
      validateInvocation: () => undefined,
      warningCodes: [],
      staticScopeExclusions: [],
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async () => ({
      status: "success",
      data: { value: "safe" },
    }));
    expect((await invokeBinding(definition, binding, {})).ok).toBe(false);
  });

  it("does not construct freshness from a fact with no evidence", async () => {
    const definition = defineReadCapability<{}, { value: string }>({
      capabilityId: "test.emptyevidence",
      inputSchema: z.object({}).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      conclusionIds: ["value_not_present"],
      observationSlots: () => [{
        slotId: "value",
        factId: "value",
        kind: "source",
        purpose: "value",
        sourceClass: "chain_rpc",
      }],
      observationExpectations: () => [],
      factRequirements: () => [{
        factId: "value",
        observationSlotIds: ["value"],
        requiredObservationSlotIds: [],
        minimumObservationCount: 0,
        outcome: "not_present",
      }],
      deriveConclusions: () => [{
        id: "value_not_present",
        outcomeFactId: "value",
        evidenceFactIds: ["value"],
        freshnessRuleId: "chain_anchor_exact",
      }],
      deriveWarnings: () => [],
      validateInvocation: () => undefined,
      warningCodes: [],
      staticScopeExclusions: [],
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async () => ({
      status: "success",
      data: { value: "safe" },
    }));
    expect((await invokeBinding(definition, binding, {})).ok).toBe(false);
  });
});
