import {contractAnalysisSchema, type ContractAnalysis} from "../../src/intelligence/analysis-contract.js";
import {evmAddressSchema, type EvmAddress} from "../../src/evm/identities.js";
import {keccak256FromHex} from "../../src/evm/keccak256.js";
import {type ChainAnchor} from "../../src/evm/primitives.js";

export const analysisImplementation = evmAddressSchema.parse(`0x${"8".repeat(40)}`);
export const analysisOwner = evmAddressSchema.parse(`0x${"9".repeat(40)}`);
export const analysisAdmin = evmAddressSchema.parse(`0x${"a".repeat(40)}`);
export const changedAnalysisAddress = evmAddressSchema.parse(`0x${"b".repeat(40)}`);

const exactControlSignatures = Object.freeze([
  "DEFAULT_ADMIN_ROLE()",
  "custom()",
  "getRoleAdmin(bytes32)",
  "getRoleMember(bytes32,uint256)",
  "getRoleMemberCount(bytes32)",
  "grantRole(bytes32,address)",
  "hasRole(bytes32,address)",
  "owner()",
  "paused()",
  "renounceRole(bytes32,address)",
  "revokeRole(bytes32,address)",
  "transferOwnership(address)",
] as const);

export const createExactResolvedAnalysis = (
  target: EvmAddress,
  block: ChainAnchor,
  owner: ContractAnalysis["controls"]["owner"] = {
    status: "observed",
    value: analysisOwner,
  },
): ContractAnalysis => contractAnalysisSchema.parse({
  chainId: block.chainId,
  target,
  block,
  targetRuntimeCode: {
    byteLength: "2",
    codeHash: keccak256FromHex("0x6000"),
  },
  proxy: {
    status: "resolved",
    method: "eip1967_implementation",
    implementation: analysisImplementation,
    implementationRuntimeCode: {
      byteLength: "2",
      codeHash: keccak256FromHex("0x6001"),
    },
    admin: { status: "not_present" },
  },
  sources: [
    { role: "target", address: target, status: "no_record_observed" },
    { role: "implementation", address: analysisImplementation, status: "exact_match" },
  ],
  declaredFunctions: {
    status: "observed",
    signatures: exactControlSignatures,
  },
  controls: {
    owner,
    paused: { status: "observed", value: false },
    defaultAdmins: { status: "observed", members: [analysisAdmin] },
  },
});

export const createTerminalityUnresolvedAnalysis = (
  target: EvmAddress,
  block: ChainAnchor,
): ContractAnalysis => contractAnalysisSchema.parse({
  chainId: block.chainId,
  target,
  block,
  targetRuntimeCode: {
    byteLength: "2",
    codeHash: keccak256FromHex("0x6000"),
  },
  proxy: {
    status: "unresolved",
    reason: "implementation_terminality_unresolved",
    firstHop: {
      method: "eip1967_implementation",
      implementation: analysisImplementation,
      implementationRuntimeCode: {
        byteLength: "2",
        codeHash: keccak256FromHex("0x6001"),
      },
      admin: { status: "not_present" },
    },
    terminality: {
      status: "supported_proxy_marker_observed",
      method: "erc1167",
    },
  },
  sources: [{ role: "target", address: target, status: "no_record_observed" }],
  declaredFunctions: { status: "unavailable", reason: "deployment_unresolved" },
  controls: {
    owner: { status: "unavailable", reason: "deployment_unresolved" },
    paused: { status: "unavailable", reason: "deployment_unresolved" },
    defaultAdmins: { status: "unavailable", reason: "deployment_unresolved" },
  },
});

export const validContractAnalysisClaimMutations = (
  analysis: ContractAnalysis,
): readonly Readonly<{ readonly label: string; readonly analysis: ContractAnalysis }>[] => {
  if (
    analysis.proxy.status !== "resolved" ||
    analysis.declaredFunctions.status !== "observed" ||
    analysis.controls.owner.status !== "observed" ||
    analysis.controls.paused.status !== "observed" ||
    analysis.controls.defaultAdmins.status !== "observed"
  ) {
    throw new TypeError("Exact analysis mutation fixture is incomplete.");
  }
  const implementationSource = analysis.sources[1];
  if (implementationSource === undefined) {
    throw new TypeError("Exact analysis implementation source is absent.");
  }
  return Object.freeze([
    {
      label: "proxy method",
      analysis: contractAnalysisSchema.parse({
        ...analysis,
        proxy: { ...analysis.proxy, method: "eip1967_beacon" },
      }),
    },
    {
      label: "implementation address",
      analysis: contractAnalysisSchema.parse({
        ...analysis,
        proxy: { ...analysis.proxy, implementation: changedAnalysisAddress },
        sources: [
          analysis.sources[0],
          { ...implementationSource, address: changedAnalysisAddress },
        ],
      }),
    },
    {
      label: "source status",
      analysis: contractAnalysisSchema.parse({
        ...analysis,
        sources: [
          analysis.sources[0],
          { ...implementationSource, status: "non_exact_match" },
        ],
        declaredFunctions: { status: "unavailable", reason: "exact_abi_unavailable" },
        controls: {
          owner: { status: "unavailable", reason: "exact_abi_unavailable" },
          paused: { status: "unavailable", reason: "exact_abi_unavailable" },
          defaultAdmins: { status: "unavailable", reason: "exact_abi_unavailable" },
        },
      }),
    },
    {
      label: "declared function",
      analysis: contractAnalysisSchema.parse({
        ...analysis,
        declaredFunctions: {
          status: "observed",
          signatures: analysis.declaredFunctions.signatures.map((signature) =>
            signature === "custom()" ? "custom2()" : signature),
        },
      }),
    },
    {
      label: "owner",
      analysis: contractAnalysisSchema.parse({
        ...analysis,
        controls: {
          ...analysis.controls,
          owner: { status: "observed", value: changedAnalysisAddress },
        },
      }),
    },
    {
      label: "paused",
      analysis: contractAnalysisSchema.parse({
        ...analysis,
        controls: {
          ...analysis.controls,
          paused: { status: "observed", value: true },
        },
      }),
    },
    {
      label: "administrator count",
      analysis: contractAnalysisSchema.parse({
        ...analysis,
        controls: {
          ...analysis.controls,
          defaultAdmins: { status: "limit_exceeded", count: "33" },
        },
      }),
    },
    {
      label: "administrator member",
      analysis: contractAnalysisSchema.parse({
        ...analysis,
        controls: {
          ...analysis.controls,
          defaultAdmins: { status: "observed", members: [changedAnalysisAddress] },
        },
      }),
    },
  ]);
};

export const reversedDeclaredFunctions = (
  analysis: ContractAnalysis,
): unknown => {
  if (analysis.declaredFunctions.status !== "observed") {
    throw new TypeError("Declared function mutation fixture is unavailable.");
  }
  const first = analysis.declaredFunctions.signatures[0];
  const second = analysis.declaredFunctions.signatures[1];
  if (first === undefined || second === undefined) {
    throw new TypeError("Declared function mutation fixture is too small.");
  }
  return {
    ...analysis,
    declaredFunctions: {
      status: "observed",
      signatures: [
        second,
        first,
        ...analysis.declaredFunctions.signatures.slice(2),
      ],
    },
  };
};

export const changeUnavailableOwnerReason = (
  analysis: ContractAnalysis,
): ContractAnalysis => contractAnalysisSchema.parse({
  ...analysis,
  controls: {
    ...analysis.controls,
    owner: { status: "unavailable", reason: "malformed_return" },
  },
});
