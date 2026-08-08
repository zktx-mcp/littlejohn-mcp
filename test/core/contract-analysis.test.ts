import { describe, expect, it } from "vitest";

import {
  assertContractAnalysisForTarget,
  chainAnchorSchema,
  contractAnalysisSchema,
  contractRuntimeCodeIdentitySchema,
  parseEvmAddress,
  parseEvmChainId,
  type ContractAnalysis,
} from "../../src/core/index.js";

const target = parseEvmAddress("0x1111111111111111111111111111111111111111");
const implementation = parseEvmAddress("0x2222222222222222222222222222222222222222");
const chainId = parseEvmChainId("eip155:4663");
const block = chainAnchorSchema.parse({
  chainId,
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: "2026-07-26T00:00:00.000Z",
});
const targetRuntimeCode = contractRuntimeCodeIdentitySchema.parse({
  byteLength: "2",
  codeHash: `0x${"11".repeat(32)}`,
});
const implementationRuntimeCode = contractRuntimeCodeIdentitySchema.parse({
  byteLength: "3",
  codeHash: `0x${"22".repeat(32)}`,
});
const context = {
  chainId,
  address: target,
  block,
  runtimeCode: targetRuntimeCode,
} as const;

const directUnavailable = (): ContractAnalysis => contractAnalysisSchema.parse({
  chainId,
  target,
  block,
  targetRuntimeCode,
  proxy: { status: "no_supported_proxy_observed" },
  sources: [{ role: "target", address: target, status: "no_record_observed" }],
  declaredFunctions: { status: "unavailable", reason: "exact_abi_unavailable" },
  controls: {
    owner: { status: "unavailable", reason: "exact_abi_unavailable" },
    paused: { status: "unavailable", reason: "exact_abi_unavailable" },
    defaultAdmins: { status: "unavailable", reason: "exact_abi_unavailable" },
  },
});

const resolvedExact = (): ContractAnalysis => contractAnalysisSchema.parse({
  chainId,
  target,
  block,
  targetRuntimeCode,
  proxy: {
    status: "resolved",
    method: "eip1967_implementation",
    implementation,
    implementationRuntimeCode,
    admin: { status: "not_present" },
  },
  sources: [
    { role: "target", address: target, status: "no_record_observed" },
    { role: "implementation", address: implementation, status: "exact_match" },
  ],
  declaredFunctions: {
    status: "observed",
    signatures: ["owner()", "paused()", "transferOwnership(address)"],
  },
  controls: {
    owner: { status: "observed", value: implementation },
    paused: { status: "observed", value: false },
    defaultAdmins: { status: "not_declared" },
  },
});

const terminalityFirstHop = {
  method: "eip1967_implementation",
  implementation,
  implementationRuntimeCode,
  admin: { status: "not_present" },
} as const;
const supportedCandidateMarker = {
  status: "supported_proxy_marker_observed",
  method: "erc1167",
} as const;

const terminalityUnresolved = (): ContractAnalysis => contractAnalysisSchema.parse({
  ...directUnavailable(),
  proxy: {
    status: "unresolved",
    reason: "implementation_terminality_unresolved",
    firstHop: terminalityFirstHop,
    terminality: supportedCandidateMarker,
  },
  declaredFunctions: { status: "unavailable", reason: "deployment_unresolved" },
  controls: {
    owner: { status: "unavailable", reason: "deployment_unresolved" },
    paused: { status: "unavailable", reason: "deployment_unresolved" },
    defaultAdmins: { status: "unavailable", reason: "deployment_unresolved" },
  },
});

describe("contract analysis relation validation", () => {
  it("admits complete direct and resolved results", () => {
    expect(assertContractAnalysisForTarget(context, directUnavailable()))
      .toEqual(directUnavailable());
    expect(assertContractAnalysisForTarget(context, resolvedExact()))
      .toEqual(resolvedExact());
    expect(assertContractAnalysisForTarget(context, terminalityUnresolved()))
      .toEqual(terminalityUnresolved());
    expect(assertContractAnalysisForTarget(context, {
      ...resolvedExact(),
      proxy: {
        ...resolvedExact().proxy,
        implementation: target,
        implementationRuntimeCode: targetRuntimeCode,
      },
      sources: [
        { role: "target", address: target, status: "no_record_observed" },
        { role: "implementation", address: target, status: "exact_match" },
      ],
    })).toMatchObject({
      proxy: {
        status: "resolved",
        implementation: target,
        implementationRuntimeCode: targetRuntimeCode,
      },
    });
    expect(assertContractAnalysisForTarget(context, {
      ...resolvedExact(),
      proxy: {
        ...resolvedExact().proxy,
        implementationRuntimeCode: targetRuntimeCode,
      },
    })).toMatchObject({
      proxy: {
        status: "resolved",
        implementation,
        implementationRuntimeCode: targetRuntimeCode,
      },
    });
  });

  it("rejects target, source, runtime, availability, and ordering contradictions", () => {
    const cases: unknown[] = [
      { ...directUnavailable(), target: implementation },
      {
        ...directUnavailable(),
        block: { ...block, blockTimestamp: "2026-07-26T00:00:01.000Z" },
      },
      {
        ...directUnavailable(),
        sources: [{ role: "implementation", address: target, status: "no_record_observed" }],
      },
      {
        ...resolvedExact(),
        sources: [
          { role: "target", address: target, status: "no_record_observed" },
          { role: "implementation", address: implementation, status: "unavailable" },
        ],
      },
      {
        ...resolvedExact(),
        declaredFunctions: { status: "observed", signatures: ["paused()", "owner()"] },
      },
      {
        ...resolvedExact(),
        declaredFunctions: { status: "observed", signatures: ["owner()", "paused()"] },
      },
      {
        ...resolvedExact(),
        controls: {
          ...resolvedExact().controls,
          defaultAdmins: {
            status: "observed",
            members: [implementation, implementation],
          },
        },
      },
      {
        ...directUnavailable(),
        proxy: { status: "unresolved", reason: "implementation_runtime_code_empty" },
        declaredFunctions: { status: "unavailable", reason: "deployment_unresolved" },
        controls: {
          owner: { status: "not_declared" },
          paused: { status: "unavailable", reason: "deployment_unresolved" },
          defaultAdmins: { status: "unavailable", reason: "deployment_unresolved" },
        },
      },
      {
        ...terminalityUnresolved(),
        proxy: {
          status: "unresolved",
          reason: "implementation_terminality_unresolved",
        },
      },
      {
        ...terminalityUnresolved(),
        proxy: {
          status: "unresolved",
          reason: "implementation_runtime_code_empty",
          firstHop: terminalityFirstHop,
          terminality: supportedCandidateMarker,
        },
      },
      {
        ...terminalityUnresolved(),
        proxy: {
          ...terminalityUnresolved().proxy,
          firstHop: {
            ...terminalityFirstHop,
            method: "erc1167",
            admin: { status: "not_present" },
          },
        },
      },
    ];
    for (const candidate of cases) {
      expect(() => assertContractAnalysisForTarget(context, candidate)).toThrow();
    }
  });
});
