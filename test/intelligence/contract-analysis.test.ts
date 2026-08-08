import { describe, expect, it, vi } from "vitest";

import {
  createCanonicalClock,
  createObservationAuthorityIssuer,
  chainAnchorSchema,
  contractRuntimeCodeIdentitySchema,
  exactContractInterfaceSchema,
  keccak256FromHex,
  parseEvmAddress,
  parseEvmChainId,
  parseHexBytes,
  parseUnsignedDecimal,
  sourceReferenceSchema,
  type EvmAddress,
  type ExactContractInterface,
} from "../../src/core/index.js";
import {
  analyzeContract,
  assertContractAnalysisExecutionForTarget,
} from "../../src/intelligence/contract-analysis.js";
import {
  createContractSourceVerificationPort,
  type ContractAnalysisChainReadPort,
  type ContractRuntimeCode,
  type ContractSourceVerificationPort,
} from "../../src/intelligence/ports.js";

const target = parseEvmAddress("0x1111111111111111111111111111111111111111");
const implementation = parseEvmAddress("0x2222222222222222222222222222222222222222");
const owner = parseEvmAddress("0x3333333333333333333333333333333333333333");
const chainId = parseEvmChainId("eip155:4663");
const block = chainAnchorSchema.parse({
  chainId,
  blockNumber: "42",
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: "2026-07-26T00:00:00.000Z",
});
const targetCode: ContractRuntimeCode = {
  bytecode: parseHexBytes("0x6000"),
  identity: contractRuntimeCodeIdentitySchema.parse({
    byteLength: "2",
    codeHash: keccak256FromHex("0x6000"),
  }),
};
const implementationCode: ContractRuntimeCode = {
  bytecode: parseHexBytes("0x6001"),
  identity: contractRuntimeCodeIdentitySchema.parse({
    byteLength: "2",
    codeHash: keccak256FromHex("0x6001"),
  }),
};
const runtimeCode = (bytecode: `0x${string}`): ContractRuntimeCode => ({
  bytecode: parseHexBytes(bytecode),
  identity: contractRuntimeCodeIdentitySchema.parse({
    byteLength: String((bytecode.length - 2) / 2),
    codeHash: keccak256FromHex(bytecode),
  }),
});
const erc1167Code = (address: EvmAddress): ContractRuntimeCode => runtimeCode(
  `0x363d3d373d3d3d363d73${address.slice(2)}5af43d82803e903d91602b57fd5bf3`,
);
const erc1167TargetCode = erc1167Code(implementation);
const exactInterface: ExactContractInterface = exactContractInterfaceSchema.parse({
  declaredFunctions: ["owner()", "paused()", "transferOwnership(address)"],
  owner: "erc173",
  paused: "declared",
  defaultAdmins: "not_declared",
});
const enumerableAdminInterface: ExactContractInterface = exactContractInterfaceSchema.parse({
  declaredFunctions: [
    "DEFAULT_ADMIN_ROLE()",
    "getRoleAdmin(bytes32)",
    "getRoleMember(bytes32,uint256)",
    "getRoleMemberCount(bytes32)",
    "grantRole(bytes32,address)",
    "hasRole(bytes32,address)",
    "renounceRole(bytes32,address)",
    "revokeRole(bytes32,address)",
  ],
  owner: "not_declared",
  paused: "not_declared",
  defaultAdmins: "enumerable",
});

type ProxyStorage = Awaited<
  ReturnType<ContractAnalysisChainReadPort["readEip1967ProxyStorage"]>
>;

const emptyProxyStorage: ProxyStorage = Object.freeze({
  implementation: Object.freeze({ status: "not_present" }),
  beacon: Object.freeze({ status: "not_present" }),
  admin: Object.freeze({ status: "not_present" }),
});

const chain = (
  storage: ProxyStorage,
  candidateStorage: ProxyStorage = emptyProxyStorage,
): ContractAnalysisChainReadPort => ({
  chainId,
  block,
  async readRuntimeCode(address) {
    if (address === target) return targetCode;
    if (address === implementation) return implementationCode;
    return null;
  },
  async readEip1967ProxyStorage(address) {
    return address === target ? storage : candidateStorage;
  },
  async readBeaconImplementation() {
    return { status: "observed", value: implementation };
  },
  async readOwner(address) {
    expect(address).toBe(target);
    return { status: "observed", value: owner };
  },
  async readPaused(address) {
    expect(address).toBe(target);
    return { status: "observed", value: false };
  },
  async readDefaultAdminRole() {
    return { status: "observed", value: parseHexBytes(`0x${"0".repeat(64)}`) };
  },
  async readDefaultAdminMemberCount() {
    return { status: "observed", value: parseUnsignedDecimal("0") };
  },
  async readDefaultAdminMembers() {
    return { status: "observed", value: [] };
  },
});

const verifiedPort = (
  verifiedInterface: ExactContractInterface = exactInterface,
  inspectedAddresses?: EvmAddress[],
  exactAddress: EvmAddress = implementation,
): ContractSourceVerificationPort => {
  const clock = createCanonicalClock(() => "2026-07-26T00:00:00.000Z");
  const issuer = createObservationAuthorityIssuer({
    clock,
    sourceClass: "contract_verification_service",
    owner: "Sourcify",
    referenceKind: "public",
    sourceId: "sourcify-v2",
  });
  return createContractSourceVerificationPort({
    observationAuthorityRegistration: issuer.registration,
    async inspect(request) {
      inspectedAddresses?.push(request.address);
      const reference = sourceReferenceSchema.parse({
        kind: "public",
        sourceId: "sourcify-v2",
        uri: `https://sourcify.example/contract/${request.address}`,
      });
      if (reference.kind !== "public") throw new TypeError("Expected a public reference.");
      return {
        status: request.address === exactAddress ? "exact_match" : "no_record_observed",
        reference,
        observationAuthority: issuer.issue(reference),
        ...(request.address === exactAddress ? { exactInterface: verifiedInterface } : {}),
      };
    },
  });
};

const executionTarget = (
  execution: Awaited<ReturnType<typeof analyzeContract>>,
) => ({
  chainId,
  address: target,
  block,
  runtimeCode: execution.targetRuntimeCode.identity,
});

describe("contract analysis process", () => {
  it("uses the implementation ABI but reads controls through the requested proxy", async () => {
    const execution = await analyzeContract({
      target,
      chain: chain({
        implementation: { status: "observed", address: implementation },
        beacon: { status: "not_present" },
        admin: { status: "not_present" },
      }),
      sourceVerification: verifiedPort(),
      signal: new AbortController().signal,
    });
    expect(execution.analysis).toMatchObject({
      proxy: {
        status: "resolved",
        method: "eip1967_implementation",
        implementation,
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
        owner: { status: "observed", value: owner },
        paused: { status: "observed", value: false },
      },
    });
  });

  it("turns conflicting proxy markers into one unresolved deployment result", async () => {
    const execution = await analyzeContract({
      target,
      chain: chain({
        implementation: { status: "observed", address: implementation },
        beacon: { status: "observed", address: owner },
        admin: { status: "not_present" },
      }),
      sourceVerification: verifiedPort(),
      signal: new AbortController().signal,
    });
    expect(execution.analysis).toMatchObject({
      proxy: { status: "unresolved", reason: "conflicting_supported_proxy_markers" },
      sources: [{ role: "target", address: target }],
      declaredFunctions: { status: "unavailable", reason: "deployment_unresolved" },
    });
  });

  it("resolves beacon and ERC-1167 proxies without adding provider-specific branches", async () => {
    const beaconExecution = await analyzeContract({
      target,
      chain: chain({
        implementation: { status: "not_present" },
        beacon: { status: "observed", address: owner },
        admin: { status: "observed", address: owner },
      }),
      sourceVerification: verifiedPort(),
      signal: new AbortController().signal,
    });
    expect(beaconExecution.analysis.proxy).toEqual({
      status: "resolved",
      method: "eip1967_beacon",
      implementation,
      implementationRuntimeCode: implementationCode.identity,
      admin: { status: "observed", address: owner },
    });

    const minimalProxyChain = {
      ...chain({
        implementation: { status: "not_present" },
        beacon: { status: "not_present" },
        admin: { status: "not_present" },
      }),
      async readRuntimeCode(address) {
        if (address === target) return erc1167TargetCode;
        if (address === implementation) return implementationCode;
        return null;
      },
    } satisfies ContractAnalysisChainReadPort;
    const minimalExecution = await analyzeContract({
      target,
      chain: minimalProxyChain,
      sourceVerification: verifiedPort(),
      signal: new AbortController().signal,
    });
    expect(minimalExecution.analysis.proxy).toEqual({
      status: "resolved",
      method: "erc1167",
      implementation,
      implementationRuntimeCode: implementationCode.identity,
      admin: { status: "not_applicable" },
    });
  });

  it("applies one marker grammar to candidate terminality without following another hop", async () => {
    const targetStorage: ProxyStorage = {
      implementation: { status: "observed", address: implementation },
      beacon: { status: "not_present" },
      admin: { status: "not_present" },
    };
    const candidateErc1167Code = erc1167Code(owner);
    const cases = [
      {
        label: "ERC-1167 marker",
        candidateCode: candidateErc1167Code,
        candidateStorage: emptyProxyStorage,
        terminality: {
          status: "supported_proxy_marker_observed",
          method: "erc1167",
        },
      },
      {
        label: "EIP-1967 implementation marker",
        candidateCode: implementationCode,
        candidateStorage: {
          implementation: { status: "observed" as const, address: owner },
          beacon: { status: "not_present" as const },
          admin: { status: "not_present" as const },
        },
        terminality: {
          status: "supported_proxy_marker_observed",
          method: "eip1967_implementation",
        },
      },
      {
        label: "EIP-1967 beacon marker",
        candidateCode: implementationCode,
        candidateStorage: {
          implementation: { status: "not_present" as const },
          beacon: { status: "observed" as const, address: owner },
          admin: { status: "not_present" as const },
        },
        terminality: {
          status: "supported_proxy_marker_observed",
          method: "eip1967_beacon",
        },
      },
      {
        label: "conflicting markers",
        candidateCode: candidateErc1167Code,
        candidateStorage: {
          implementation: { status: "observed" as const, address: owner },
          beacon: { status: "not_present" as const },
          admin: { status: "not_present" as const },
        },
        terminality: { status: "conflicting_supported_proxy_markers" },
      },
      {
        label: "malformed marker storage",
        candidateCode: implementationCode,
        candidateStorage: {
          implementation: { status: "malformed" as const },
          beacon: { status: "not_present" as const },
          admin: { status: "not_present" as const },
        },
        terminality: { status: "malformed_eip1967_address_storage" },
      },
      {
        label: "administrator without implementation",
        candidateCode: implementationCode,
        candidateStorage: {
          implementation: { status: "not_present" as const },
          beacon: { status: "not_present" as const },
          admin: { status: "observed" as const, address: owner },
        },
        terminality: { status: "admin_without_supported_implementation" },
      },
    ] as const;

    for (const candidate of cases) {
      const storageReads: EvmAddress[] = [];
      const beaconReads: EvmAddress[] = [];
      const sourceReads: EvmAddress[] = [];
      let controlReads = 0;
      const base = chain(targetStorage, candidate.candidateStorage);
      const candidateChain = {
        ...base,
        async readRuntimeCode(address: EvmAddress) {
          if (address === target) return targetCode;
          if (address === implementation) return candidate.candidateCode;
          return null;
        },
        async readEip1967ProxyStorage(address: EvmAddress) {
          storageReads.push(address);
          return base.readEip1967ProxyStorage(address);
        },
        async readBeaconImplementation(address: EvmAddress) {
          beaconReads.push(address);
          return { status: "observed" as const, value: owner };
        },
        async readOwner(address: EvmAddress) {
          controlReads += 1;
          return base.readOwner(address);
        },
        async readPaused(address: EvmAddress) {
          controlReads += 1;
          return base.readPaused(address);
        },
      } satisfies ContractAnalysisChainReadPort;

      const execution = await analyzeContract({
        target,
        chain: candidateChain,
        sourceVerification: verifiedPort(exactInterface, sourceReads, target),
        signal: new AbortController().signal,
      });
      expect(execution.analysis.proxy, candidate.label).toEqual({
        status: "unresolved",
        reason: "implementation_terminality_unresolved",
        firstHop: {
          method: "eip1967_implementation",
          implementation,
          implementationRuntimeCode: candidate.candidateCode.identity,
          admin: { status: "not_present" },
        },
        terminality: candidate.terminality,
      });
      expect(storageReads, candidate.label).toEqual([target, implementation]);
      expect(beaconReads, candidate.label).toEqual([]);
      expect(sourceReads, candidate.label).toEqual([target]);
      expect(controlReads, candidate.label).toBe(0);
      expect(execution.analysis.declaredFunctions, candidate.label).toEqual({
        status: "unavailable",
        reason: "deployment_unresolved",
      });
    }
  });

  it("rejects self-reference while preserving a terminal equal-runtime implementation", async () => {
    const selfSourceAddresses: EvmAddress[] = [];
    const selfAddressExecution = await analyzeContract({
      target,
      chain: chain({
        implementation: { status: "observed", address: target },
        beacon: { status: "not_present" },
        admin: { status: "not_present" },
      }),
      sourceVerification: verifiedPort(exactInterface, selfSourceAddresses),
      signal: new AbortController().signal,
    });
    expect(selfAddressExecution.analysis.proxy).toEqual({
      status: "unresolved",
      reason: "implementation_terminality_unresolved",
      firstHop: {
        method: "eip1967_implementation",
        implementation: target,
        implementationRuntimeCode: targetCode.identity,
        admin: { status: "not_present" },
      },
      terminality: {
        status: "supported_proxy_marker_observed",
        method: "eip1967_implementation",
      },
    });
    expect(selfAddressExecution.analysis.sources).toEqual([
      { role: "target", address: target, status: "no_record_observed" },
    ]);
    expect(selfSourceAddresses).toEqual([target]);

    const equalRuntimeExecution = await analyzeContract({
      target,
      chain: {
        ...chain({
          implementation: { status: "observed", address: implementation },
          beacon: { status: "not_present" },
          admin: { status: "not_present" },
        }),
        async readRuntimeCode(address) {
          if (address === target || address === implementation) return targetCode;
          return null;
        },
      },
      sourceVerification: verifiedPort(),
      signal: new AbortController().signal,
    });
    expect(equalRuntimeExecution.analysis.proxy).toEqual({
      status: "resolved",
      method: "eip1967_implementation",
      implementation,
      implementationRuntimeCode: targetCode.identity,
      admin: { status: "not_present" },
    });

    const cycleStorageReads: EvmAddress[] = [];
    const cycleBase = chain({
      implementation: { status: "observed", address: implementation },
      beacon: { status: "not_present" },
      admin: { status: "not_present" },
    }, {
      implementation: { status: "observed", address: target },
      beacon: { status: "not_present" },
      admin: { status: "not_present" },
    });
    const cycleExecution = await analyzeContract({
      target,
      chain: {
        ...cycleBase,
        async readEip1967ProxyStorage(address) {
          cycleStorageReads.push(address);
          return cycleBase.readEip1967ProxyStorage(address);
        },
      },
      sourceVerification: verifiedPort(),
      signal: new AbortController().signal,
    });
    expect(cycleExecution.analysis.proxy).toMatchObject({
      status: "unresolved",
      reason: "implementation_terminality_unresolved",
      firstHop: { implementation },
      terminality: {
        status: "supported_proxy_marker_observed",
        method: "eip1967_implementation",
      },
    });
    expect(cycleStorageReads).toEqual([target, implementation]);
  });

  it("keeps ambiguous and incomplete proxy observations unresolved", async () => {
    const cases: readonly Readonly<{
      readonly reason:
        | "admin_without_supported_implementation"
        | "malformed_eip1967_address_storage"
        | "implementation_runtime_code_empty"
        | "beacon_implementation_reverted"
        | "malformed_beacon_implementation"
        | "conflicting_supported_proxy_markers";
      readonly chain: ContractAnalysisChainReadPort;
    }>[] = [
      {
        reason: "admin_without_supported_implementation",
        chain: chain({
          implementation: { status: "not_present" },
          beacon: { status: "not_present" },
          admin: { status: "observed", address: owner },
        }),
      },
      {
        reason: "malformed_eip1967_address_storage",
        chain: chain({
          implementation: { status: "malformed" },
          beacon: { status: "not_present" },
          admin: { status: "not_present" },
        }),
      },
      {
        reason: "implementation_runtime_code_empty",
        chain: {
          ...chain({
            implementation: { status: "observed", address: implementation },
            beacon: { status: "not_present" },
            admin: { status: "not_present" },
          }),
          async readRuntimeCode(address) {
            return address === target ? targetCode : null;
          },
        },
      },
      {
        reason: "beacon_implementation_reverted",
        chain: {
          ...chain({
            implementation: { status: "not_present" },
            beacon: { status: "observed", address: owner },
            admin: { status: "not_present" },
          }),
          async readBeaconImplementation() {
            return { status: "reverted" };
          },
        },
      },
      {
        reason: "malformed_beacon_implementation",
        chain: {
          ...chain({
            implementation: { status: "not_present" },
            beacon: { status: "observed", address: owner },
            admin: { status: "not_present" },
          }),
          async readBeaconImplementation() {
            return { status: "malformed" };
          },
        },
      },
      {
        reason: "conflicting_supported_proxy_markers",
        chain: {
          ...chain({
            implementation: { status: "observed", address: implementation },
            beacon: { status: "not_present" },
            admin: { status: "not_present" },
          }),
          async readRuntimeCode(address) {
            if (address === target) return erc1167TargetCode;
            if (address === implementation) return implementationCode;
            return null;
          },
        },
      },
    ];
    for (const candidate of cases) {
      const execution = await analyzeContract({
        target,
        chain: candidate.chain,
        sourceVerification: verifiedPort(),
        signal: new AbortController().signal,
      });
      expect(execution.analysis.proxy, candidate.reason).toEqual({
        status: "unresolved",
        reason: candidate.reason,
      });
      expect(execution.analysis.sources).toHaveLength(1);
      expect(execution.analysis.declaredFunctions).toEqual({
        status: "unavailable",
        reason: "deployment_unresolved",
      });
    }
  });

  it("propagates candidate read rejection without constructing proxy or source evidence", async () => {
    const targetStorage: ProxyStorage = {
      implementation: { status: "observed", address: implementation },
      beacon: { status: "not_present" },
      admin: { status: "not_present" },
    };
    const abortController = new AbortController();
    abortController.abort(new Error("candidate runtime read aborted"));
    const storageFailure = new Error("candidate storage unavailable");
    const cases = [
      {
        label: "runtime abort",
        error: abortController.signal.reason,
        createChain() {
          const base = chain(targetStorage);
          return {
            ...base,
            async readRuntimeCode(address: EvmAddress) {
              if (address === target) return targetCode;
              throw abortController.signal.reason;
            },
          } satisfies ContractAnalysisChainReadPort;
        },
      },
      {
        label: "storage rejection",
        error: storageFailure,
        createChain() {
          const base = chain(targetStorage);
          return {
            ...base,
            async readEip1967ProxyStorage(address: EvmAddress) {
              if (address === implementation) throw storageFailure;
              return base.readEip1967ProxyStorage(address);
            },
          } satisfies ContractAnalysisChainReadPort;
        },
      },
    ] as const;
    for (const candidate of cases) {
      const sourceReads: EvmAddress[] = [];
      await expect(analyzeContract({
        target,
        chain: candidate.createChain(),
        sourceVerification: verifiedPort(exactInterface, sourceReads),
        signal: abortController.signal,
      }), candidate.label).rejects.toBe(candidate.error);
      expect(sourceReads, candidate.label).toEqual([]);
    }
  });

  it("bounds, orders, and validates enumerable default administrators", async () => {
    const proxyStorage = {
      implementation: { status: "observed" as const, address: implementation },
      beacon: { status: "not_present" as const },
      admin: { status: "not_present" as const },
    };
    let overLimitMemberReads = 0;
    const overLimitChain = {
      ...chain(proxyStorage),
      async readDefaultAdminMemberCount() {
        return { status: "observed" as const, value: parseUnsignedDecimal("33") };
      },
      async readDefaultAdminMembers() {
        overLimitMemberReads += 1;
        return { status: "observed" as const, value: [] };
      },
    } satisfies ContractAnalysisChainReadPort;
    const overLimit = await analyzeContract({
      target,
      chain: overLimitChain,
      sourceVerification: verifiedPort(enumerableAdminInterface),
      signal: new AbortController().signal,
    });
    expect(overLimit.analysis.controls.defaultAdmins).toEqual({
      status: "limit_exceeded",
      count: "33",
    });
    expect(overLimitMemberReads).toBe(0);

    const observedChain = {
      ...chain(proxyStorage),
      async readDefaultAdminMemberCount() {
        return { status: "observed" as const, value: parseUnsignedDecimal("2") };
      },
      async readDefaultAdminMembers() {
        return {
          status: "observed" as const,
          value: [owner, implementation],
        };
      },
    } satisfies ContractAnalysisChainReadPort;
    const observed = await analyzeContract({
      target,
      chain: observedChain,
      sourceVerification: verifiedPort(enumerableAdminInterface),
      signal: new AbortController().signal,
    });
    expect(observed.analysis.controls.defaultAdmins).toEqual({
      status: "observed",
      members: [implementation, owner],
    });

    const duplicateChain = {
      ...observedChain,
      async readDefaultAdminMembers() {
        return {
          status: "observed" as const,
          value: [owner, owner],
        };
      },
    } satisfies ContractAnalysisChainReadPort;
    const duplicate = await analyzeContract({
      target,
      chain: duplicateChain,
      sourceVerification: verifiedPort(enumerableAdminInterface),
      signal: new AbortController().signal,
    });
    expect(duplicate.analysis.controls.defaultAdmins).toEqual({
      status: "unavailable",
      reason: "malformed_return",
    });

    const missingMemberChain = {
      ...observedChain,
      async readDefaultAdminMembers() {
        return {
          status: "observed" as const,
          value: [owner],
        };
      },
    } satisfies ContractAnalysisChainReadPort;
    const missingMember = await analyzeContract({
      target,
      chain: missingMemberChain,
      sourceVerification: verifiedPort(enumerableAdminInterface),
      signal: new AbortController().signal,
    });
    expect(missingMember.analysis.controls.defaultAdmins).toEqual({
      status: "unavailable",
      reason: "malformed_return",
    });
  });

  it("rejects an authority issued by a different source adapter instance", async () => {
    const clock = createCanonicalClock(() => "2026-07-26T00:00:00.000Z");
    const configured = createObservationAuthorityIssuer({
      clock,
      sourceClass: "contract_verification_service",
      owner: "Sourcify",
      referenceKind: "public",
      sourceId: "sourcify-v2",
    });
    const foreign = createObservationAuthorityIssuer({
      clock,
      sourceClass: "contract_verification_service",
      owner: "Sourcify",
      referenceKind: "public",
      sourceId: "sourcify-v2",
    });
    const port = createContractSourceVerificationPort({
      observationAuthorityRegistration: configured.registration,
      async inspect(request) {
        const reference = sourceReferenceSchema.parse({
          kind: "public",
          sourceId: "sourcify-v2",
          uri: `https://sourcify.example/contract/${request.address}`,
        });
        if (reference.kind !== "public") throw new TypeError("Expected a public reference.");
        return {
          status: "no_record_observed",
          reference,
          observationAuthority: foreign.issue(reference),
        };
      },
    });
    await expect(analyzeContract({
      target,
      chain: chain({
        implementation: { status: "not_present" },
        beacon: { status: "not_present" },
        admin: { status: "not_present" },
      }),
      sourceVerification: port,
      signal: new AbortController().signal,
    })).rejects.toThrow("not owned");
  });

  it("rejects runtime code whose byte content does not match its identity", async () => {
    const invalidChain = {
      ...chain({
        implementation: { status: "not_present" },
        beacon: { status: "not_present" },
        admin: { status: "not_present" },
      }),
      async readRuntimeCode() {
        return {
          bytecode: targetCode.bytecode,
          identity: implementationCode.identity,
        };
      },
    } satisfies ContractAnalysisChainReadPort;
    await expect(analyzeContract({
      target,
      chain: invalidChain,
      sourceVerification: verifiedPort(),
      signal: new AbortController().signal,
    })).rejects.toThrow("does not match its identity");
  });

  it("validates provider provenance and runtime bytecode at the execution handoff", async () => {
    const configuredPort = verifiedPort();
    const execution = await analyzeContract({
      target,
      chain: chain({
        implementation: { status: "not_present" },
        beacon: { status: "not_present" },
        admin: { status: "not_present" },
      }),
      sourceVerification: configuredPort,
      signal: new AbortController().signal,
    });
    const source = execution.sourceObservations[0];
    if (source === undefined) throw new Error("Expected a source observation.");

    const foreignIssuer = createObservationAuthorityIssuer({
      clock: createCanonicalClock(() => "2026-07-26T00:00:00.000Z"),
      sourceClass: "contract_verification_service",
      owner: "Sourcify",
      referenceKind: "public",
      sourceId: "sourcify-v2",
    });
    expect(() => assertContractAnalysisExecutionForTarget(
      executionTarget(execution),
      configuredPort,
      {
        ...execution,
        sourceObservations: [{
          ...source,
          observationAuthority: foreignIssuer.issue(source.reference),
        }],
      },
    )).toThrow("not owned");

    expect(() => assertContractAnalysisExecutionForTarget(
      executionTarget(execution),
      configuredPort,
      {
        ...execution,
        targetRuntimeCode: {
          bytecode: implementationCode.bytecode,
          identity: targetCode.identity,
        },
      },
    )).toThrow("does not match its identity");
  });

  it("owns and deeply freezes admitted execution values", async () => {
    const configuredPort = verifiedPort();
    const execution = await analyzeContract({
      target,
      chain: chain({
        implementation: { status: "not_present" },
        beacon: { status: "not_present" },
        admin: { status: "not_present" },
      }),
      sourceVerification: configuredPort,
      signal: new AbortController().signal,
    });
    const source = execution.sourceObservations[0];
    if (source === undefined) throw new Error("Expected a source observation.");
    const mutableClaim = JSON.parse(JSON.stringify(source.claim)) as typeof source.claim;
    const admitted = assertContractAnalysisExecutionForTarget(
      executionTarget(execution),
      configuredPort,
      {
        ...execution,
        targetRuntimeCode: {
          bytecode: execution.targetRuntimeCode.bytecode,
          identity: { ...execution.targetRuntimeCode.identity },
        },
        sourceObservations: [{
          ...source,
          claim: mutableClaim,
        }],
      },
    );
    if (
      typeof mutableClaim !== "object" ||
      mutableClaim === null ||
      Array.isArray(mutableClaim)
    ) {
      throw new Error("Expected an object claim.");
    }
    expect(Reflect.set(mutableClaim, "status", "inconsistent")).toBe(true);
    expect(admitted.sourceObservations[0]?.claim).toEqual(source.claim);
    expect(admitted.sourceObservations[0]?.claim).not.toBe(mutableClaim);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.targetRuntimeCode)).toBe(true);
    expect(Object.isFrozen(admitted.targetRuntimeCode.identity)).toBe(true);
    expect(Object.isFrozen(admitted.sourceObservations)).toBe(true);
    expect(Object.isFrozen(admitted.sourceObservations[0]?.claim)).toBe(true);
    const admittedClaim = admitted.sourceObservations[0]?.claim;
    if (
      typeof admittedClaim !== "object" ||
      admittedClaim === null ||
      Array.isArray(admittedClaim)
    ) {
      throw new Error("Expected an admitted object claim.");
    }
    expect(Object.isFrozen(admittedClaim["declaredFunctions"])).toBe(true);
    expect(Object.isFrozen(admittedClaim["controls"])).toBe(true);
  });

  it("waits for both proxy source lookups before reporting an internal lookup failure", async () => {
    const clock = createCanonicalClock(() => "2026-07-26T00:00:00.000Z");
    const issuer = createObservationAuthorityIssuer({
      clock,
      sourceClass: "contract_verification_service",
      owner: "Sourcify",
      referenceKind: "public",
      sourceId: "sourcify-v2",
    });
    let implementationLookupStarted = false;
    let releaseImplementation: (() => void) | undefined;
    const implementationDone = new Promise<void>((resolve) => {
      releaseImplementation = resolve;
    });
    const port = createContractSourceVerificationPort({
      observationAuthorityRegistration: issuer.registration,
      async inspect(request) {
        if (request.address === target) throw new Error("target lookup failed");
        implementationLookupStarted = true;
        await implementationDone;
        const reference = sourceReferenceSchema.parse({
          kind: "public",
          sourceId: "sourcify-v2",
          uri: `https://sourcify.example/contract/${request.address}`,
        });
        if (reference.kind !== "public") throw new TypeError("Expected a public reference.");
        return {
          status: "no_record_observed",
          reference,
          observationAuthority: issuer.issue(reference),
        };
      },
    });
    let settled = false;
    const pending = analyzeContract({
      target,
      chain: chain({
        implementation: { status: "observed", address: implementation },
        beacon: { status: "not_present" },
        admin: { status: "not_present" },
      }),
      sourceVerification: port,
      signal: new AbortController().signal,
    }).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(implementationLookupStarted).toBe(true));
      expect(settled).toBe(false);
    } finally {
      releaseImplementation?.();
    }
    await expect(pending).rejects.toThrow("target lookup failed");
  });
});
