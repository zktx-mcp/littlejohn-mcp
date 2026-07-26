import {
  assertContractAnalysisForTarget,
  canonicalJsonStringify,
  createContractAnalysisChainClaims,
  createContractAnalysisSourceClaim,
  compareCodePointSequences,
  contractDefaultAdminMemberLimit,
  contractRuntimeCodeIdentitySchema,
  contractSourceVerificationStatuses,
  deepFreezeValue,
  evmAddressSchema,
  exactContractInterfaceSchema,
  keccak256FromHex,
  parseSourceReference,
  parseHexBytes,
  type ContractAnalysis,
  type ContractAnalysisTarget,
  type ContractControlFailureReason,
  type ContractRuntimeCodeIdentity,
  type ContractAnalysisEvidenceFragment,
  type CanonicalJson,
  type EvmAddress,
  type ExactContractInterface,
  type HexBytes,
  type ObservationAuthority,
  type ObservationWriter,
  type SourceReference,
} from "../core/index.js";
import type {
  ContractAnalysisChainReadPort,
  ContractReadResult,
  ContractRuntimeCode,
  ContractSourceVerification,
  ContractSourceVerificationPort,
} from "./ports.js";
import { assertContractSourceVerificationAuthority } from "./ports.js";

const emptyBytes32 = `0x${"0".repeat(64)}` as HexBytes;
const erc1167Prefix = "363d3d373d3d3d363d";
const erc1167SuffixPrefix = "5af43d82803e903d9160";
const erc1167SuffixTail = "57fd5bf3";

const targetNotFoundErrors = new WeakSet<object>();

const targetNotFound = (): Error => {
  const error = new Error("contract_not_found");
  error.name = "ContractAnalysisTargetNotFoundError";
  targetNotFoundErrors.add(error);
  Object.freeze(error);
  return error;
};

export const isContractAnalysisTargetNotFoundError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && targetNotFoundErrors.has(error);

const admittedRuntimeCode = (input: ContractRuntimeCode): ContractRuntimeCode => {
  const bytecode = parseHexBytes(input.bytecode);
  const identity = contractRuntimeCodeIdentitySchema.parse(input.identity);
  if (
    identity.byteLength !== String((bytecode.length - 2) / 2) ||
    identity.codeHash !== keccak256FromHex(bytecode)
  ) {
    throw new TypeError("Contract runtime code does not match its identity.");
  }
  return Object.freeze({
    bytecode,
    identity: Object.freeze(identity),
  });
};

const erc1167Implementation = (bytecode: HexBytes): EvmAddress | null => {
  const hex = bytecode.slice(2);
  if (!hex.startsWith(erc1167Prefix)) return null;
  const opcodeIndex = erc1167Prefix.length;
  const opcode = Number.parseInt(hex.slice(opcodeIndex, opcodeIndex + 2), 16);
  const addressByteLength = opcode - 0x5f;
  if (!Number.isInteger(addressByteLength) || addressByteLength < 1 || addressByteLength > 20) {
    return null;
  }
  const omittedLeadingBytes = 20 - addressByteLength;
  const addressStart = opcodeIndex + 2;
  const addressEnd = addressStart + addressByteLength * 2;
  const jumpDestination = (0x2b - omittedLeadingBytes).toString(16).padStart(2, "0");
  const expectedSuffix = `${erc1167SuffixPrefix}${jumpDestination}${erc1167SuffixTail}`;
  if (hex.length !== addressEnd + expectedSuffix.length || hex.slice(addressEnd) !== expectedSuffix) {
    return null;
  }
  const addressHex = `${"0".repeat(omittedLeadingBytes * 2)}${hex.slice(addressStart, addressEnd)}`;
  if (/^0+$/u.test(addressHex)) return null;
  return evmAddressSchema.parse(`0x${addressHex}`);
};

const admittedVerification = (
  port: ContractSourceVerificationPort,
  value: ContractSourceVerification,
): ContractSourceVerification => {
  if (!contractSourceVerificationStatuses.includes(value.status)) {
    throw new TypeError("Contract source verification status is invalid.");
  }
  const reference = parseSourceReference(value.reference);
  if (reference.kind !== "public") {
    throw new TypeError("Contract source verification reference is invalid.");
  }
  const exactInterface = value.exactInterface === undefined
    ? undefined
    : exactContractInterfaceSchema.parse(value.exactInterface);
  if ((value.status === "exact_match") !== (exactInterface !== undefined)) {
    throw new TypeError("Contract source verification interface is inconsistent.");
  }
  if (typeof value.observationAuthority !== "object" || value.observationAuthority === null) {
    throw new TypeError("Contract source observation authority is invalid.");
  }
  assertContractSourceVerificationAuthority(port, value.observationAuthority, reference);
  return Object.freeze({
    status: value.status,
    reference: Object.freeze(reference),
    observationAuthority: value.observationAuthority,
    ...(exactInterface === undefined ? {} : { exactInterface: Object.freeze(exactInterface) }),
  });
};

const sourceUnavailableReason = (
  status: ContractSourceVerification["status"],
): ContractControlFailureReason =>
  status === "inconsistent" ? "source_inconsistent" : "exact_abi_unavailable";

const unresolvedControls = (
  reason: ContractControlFailureReason,
): ContractAnalysis["controls"] => Object.freeze({
  owner: Object.freeze({ status: "unavailable" as const, reason }),
  paused: Object.freeze({ status: "unavailable" as const, reason }),
  defaultAdmins: Object.freeze({ status: "unavailable" as const, reason }),
});

const controlUnavailable = (
  result: Exclude<ContractReadResult<unknown>, { readonly status: "observed" }>,
): ContractControlFailureReason =>
  result.status === "reverted" ? "call_reverted" : "malformed_return";

const ownerResult = (
  definition: ExactContractInterface["owner"],
  result: ContractReadResult<EvmAddress> | undefined,
): ContractAnalysis["controls"]["owner"] => {
  if (definition === "not_declared") return Object.freeze({ status: "not_declared" });
  if (result === undefined) throw new TypeError("Owner read result is missing.");
  return result.status === "observed"
    ? Object.freeze({ status: "observed", value: result.value })
    : Object.freeze({ status: "unavailable", reason: controlUnavailable(result) });
};

const pausedResult = (
  definition: ExactContractInterface["paused"],
  result: ContractReadResult<boolean> | undefined,
): ContractAnalysis["controls"]["paused"] => {
  if (definition === "not_declared") return Object.freeze({ status: "not_declared" });
  if (result === undefined) throw new TypeError("Pause read result is missing.");
  return result.status === "observed"
    ? Object.freeze({ status: "observed", value: result.value })
    : Object.freeze({ status: "unavailable", reason: controlUnavailable(result) });
};

const defaultAdminsResult = async (
  chain: ContractAnalysisChainReadPort,
  target: EvmAddress,
  definition: ExactContractInterface["defaultAdmins"],
  roleResult: ContractReadResult<HexBytes> | undefined,
): Promise<ContractAnalysis["controls"]["defaultAdmins"]> => {
  if (definition === "not_declared") return Object.freeze({ status: "not_declared" });
  if (definition === "not_enumerable") return Object.freeze({ status: "not_enumerable" });
  if (roleResult === undefined) throw new TypeError("Default-administrator role result is missing.");
  if (roleResult.status !== "observed") {
    return Object.freeze({
      status: "unavailable",
      reason: controlUnavailable(roleResult),
    });
  }
  if (roleResult.value !== emptyBytes32) {
    return Object.freeze({ status: "unavailable", reason: "malformed_return" });
  }
  const countResult = await chain.readDefaultAdminMemberCount(target, roleResult.value);
  if (countResult.status !== "observed") {
    return Object.freeze({
      status: "unavailable",
      reason: controlUnavailable(countResult),
    });
  }
  if (BigInt(countResult.value) > BigInt(contractDefaultAdminMemberLimit)) {
    return Object.freeze({ status: "limit_exceeded", count: countResult.value });
  }
  const membersResult = await chain.readDefaultAdminMembers(
    target,
    roleResult.value,
    countResult.value,
  );
  if (membersResult.status !== "observed") {
    return Object.freeze({
      status: "unavailable",
      reason: controlUnavailable(membersResult),
    });
  }
  if (BigInt(membersResult.value.length) !== BigInt(countResult.value)) {
    return Object.freeze({ status: "unavailable", reason: "malformed_return" });
  }
  const members = [...membersResult.value].sort(compareCodePointSequences);
  if (new Set(members).size !== members.length) {
    return Object.freeze({ status: "unavailable", reason: "malformed_return" });
  }
  return Object.freeze({ status: "observed", members });
};

const readControls = async (
  chain: ContractAnalysisChainReadPort,
  target: EvmAddress,
  exactInterface: ExactContractInterface,
): Promise<ContractAnalysis["controls"]> => {
  const ownerPromise = exactInterface.owner === "erc173"
    ? chain.readOwner(target)
    : Promise.resolve(undefined);
  const pausedPromise = exactInterface.paused === "declared"
    ? chain.readPaused(target)
    : Promise.resolve(undefined);
  const rolePromise = exactInterface.defaultAdmins === "enumerable"
    ? chain.readDefaultAdminRole(target)
    : Promise.resolve(undefined);
  const settled = await Promise.allSettled([ownerPromise, pausedPromise, rolePromise]);
  const rejected = settled.find(
    (entry): entry is PromiseRejectedResult => entry.status === "rejected",
  );
  if (rejected !== undefined) throw rejected.reason;
  const owner = (settled[0] as PromiseFulfilledResult<
    ContractReadResult<EvmAddress> | undefined
  >).value;
  const paused = (settled[1] as PromiseFulfilledResult<
    ContractReadResult<boolean> | undefined
  >).value;
  const role = (settled[2] as PromiseFulfilledResult<
    ContractReadResult<HexBytes> | undefined
  >).value;
  return Object.freeze({
    owner: ownerResult(exactInterface.owner, owner),
    paused: pausedResult(exactInterface.paused, paused),
    defaultAdmins: await defaultAdminsResult(
      chain,
      target,
      exactInterface.defaultAdmins,
      role,
    ),
  });
};

interface ResolvedDeployment {
  readonly proxy: ContractAnalysis["proxy"];
  readonly implementationRuntimeCode?: ContractRuntimeCode;
}

const resolveDeployment = async (
  chain: ContractAnalysisChainReadPort,
  target: EvmAddress,
  targetRuntimeCode: ContractRuntimeCode,
): Promise<ResolvedDeployment> => {
  const storage = await chain.readEip1967ProxyStorage(target);
  if (
    storage.implementation.status === "malformed" ||
    storage.beacon.status === "malformed" ||
    storage.admin.status === "malformed"
  ) {
    return Object.freeze({
      proxy: Object.freeze({
        status: "unresolved",
        reason: "malformed_eip1967_address_storage",
      }),
    });
  }

  const minimalProxyImplementation = erc1167Implementation(targetRuntimeCode.bytecode);
  const implementation = storage.implementation.status === "observed"
    ? storage.implementation.address
    : undefined;
  const beacon = storage.beacon.status === "observed" ? storage.beacon.address : undefined;
  const markerCount = Number(implementation !== undefined) +
    Number(beacon !== undefined) +
    Number(minimalProxyImplementation !== null);
  if (markerCount > 1) {
    return Object.freeze({
      proxy: Object.freeze({
        status: "unresolved",
        reason: "conflicting_supported_proxy_markers",
      }),
    });
  }
  if (
    markerCount === 0 &&
    storage.admin.status === "observed"
  ) {
    return Object.freeze({
      proxy: Object.freeze({
        status: "unresolved",
        reason: "admin_without_supported_implementation",
      }),
    });
  }
  if (markerCount === 0) {
    return Object.freeze({
      proxy: Object.freeze({ status: "no_supported_proxy_observed" }),
    });
  }

  let method: Extract<ContractAnalysis["proxy"], { readonly status: "resolved" }>["method"];
  let resolvedAddress: EvmAddress;
  if (minimalProxyImplementation !== null) {
    method = "erc1167";
    resolvedAddress = minimalProxyImplementation;
  } else if (implementation !== undefined) {
    method = "eip1967_implementation";
    resolvedAddress = implementation;
  } else {
    if (beacon === undefined) throw new TypeError("Proxy marker resolution is incomplete.");
    const beaconResult = await chain.readBeaconImplementation(beacon);
    if (beaconResult.status === "reverted") {
      return Object.freeze({
        proxy: Object.freeze({
          status: "unresolved",
          reason: "beacon_implementation_reverted",
        }),
      });
    }
    if (beaconResult.status === "malformed") {
      return Object.freeze({
        proxy: Object.freeze({
          status: "unresolved",
          reason: "malformed_beacon_implementation",
        }),
      });
    }
    method = "eip1967_beacon";
    resolvedAddress = beaconResult.value;
  }

  const implementationRuntimeCodeInput = await chain.readRuntimeCode(resolvedAddress);
  if (implementationRuntimeCodeInput === null) {
    return Object.freeze({
      proxy: Object.freeze({
        status: "unresolved",
        reason: "implementation_runtime_code_empty",
      }),
    });
  }
  const implementationRuntimeCode = admittedRuntimeCode(implementationRuntimeCodeInput);
  const admin = method === "erc1167"
    ? Object.freeze({ status: "not_applicable" as const })
    : storage.admin.status === "observed"
      ? Object.freeze({ status: "observed" as const, address: storage.admin.address })
      : Object.freeze({ status: "not_present" as const });
  return Object.freeze({
    proxy: Object.freeze({
      status: "resolved",
      method,
      implementation: resolvedAddress,
      implementationRuntimeCode: implementationRuntimeCode.identity,
      admin,
    }),
    implementationRuntimeCode,
  });
};

export interface ContractAnalysisSourceObservation {
  readonly role: "target" | "implementation";
  readonly address: EvmAddress;
  readonly status: ContractSourceVerification["status"];
  readonly reference: Extract<SourceReference, { readonly kind: "public" }>;
  readonly observationAuthority: ObservationAuthority;
  readonly claim: CanonicalJson;
}

export interface ContractAnalysisExecution {
  readonly analysis: ContractAnalysis;
  readonly targetRuntimeCode: ContractRuntimeCode;
  readonly sourceObservations: readonly ContractAnalysisSourceObservation[];
}

export const assertContractAnalysisExecutionForTarget = (
  target: ContractAnalysisTarget,
  sourceVerification: ContractSourceVerificationPort,
  executionInput: ContractAnalysisExecution,
): ContractAnalysisExecution => {
  const analysis = assertContractAnalysisForTarget(target, executionInput.analysis);
  const targetRuntimeCode = admittedRuntimeCode(executionInput.targetRuntimeCode);
  if (
    targetRuntimeCode.identity.byteLength !== target.runtimeCode.byteLength ||
    targetRuntimeCode.identity.codeHash !== target.runtimeCode.codeHash
  ) {
    throw new TypeError("Contract analysis target runtime code is inconsistent.");
  }
  if (
    !Array.isArray(executionInput.sourceObservations) ||
    executionInput.sourceObservations.length !== analysis.sources.length
  ) {
    throw new TypeError("Contract analysis source observations are incomplete.");
  }
  const sourceObservations = executionInput.sourceObservations.map((observation, index) => {
    const source = analysis.sources[index];
    if (
      source === undefined ||
      observation.role !== source.role ||
      observation.address !== source.address ||
      observation.status !== source.status
    ) {
      throw new TypeError("Contract analysis source observation is inconsistent.");
    }
    const reference = parseSourceReference(observation.reference);
    if (
      reference.kind !== "public" ||
      typeof observation.observationAuthority !== "object" ||
      observation.observationAuthority === null
    ) {
      throw new TypeError("Contract analysis source observation authority is invalid.");
    }
    assertContractSourceVerificationAuthority(
      sourceVerification,
      observation.observationAuthority,
      reference,
    );
    const expectedClaim = deepFreezeValue(
      createContractAnalysisSourceClaim(analysis, observation.role),
    );
    if (canonicalJsonStringify(observation.claim) !== canonicalJsonStringify(expectedClaim)) {
      throw new TypeError("Contract analysis source observation claim is inconsistent.");
    }
    return deepFreezeValue({
      role: observation.role,
      address: observation.address,
      status: observation.status,
      reference,
      observationAuthority: observation.observationAuthority,
      claim: expectedClaim,
    });
  });
  return deepFreezeValue({
    analysis,
    targetRuntimeCode,
    sourceObservations,
  });
};

export const analyzeContract = async (input: {
  readonly target: EvmAddress;
  readonly chain: ContractAnalysisChainReadPort;
  readonly sourceVerification: ContractSourceVerificationPort;
  readonly signal: AbortSignal;
}): Promise<ContractAnalysisExecution> => {
  const target = evmAddressSchema.parse(input.target);
  const targetRuntimeCodeInput = await input.chain.readRuntimeCode(target);
  if (targetRuntimeCodeInput === null) throw targetNotFound();
  const targetRuntimeCode = admittedRuntimeCode(targetRuntimeCodeInput);
  const deployment = await resolveDeployment(input.chain, target, targetRuntimeCode);

  const sourceRequests: Array<Readonly<{
    role: "target" | "implementation";
    address: EvmAddress;
    runtimeCode: ContractRuntimeCode;
  }>> = [{
    role: "target",
    address: target,
    runtimeCode: targetRuntimeCode,
  }];
  if (
    deployment.proxy.status === "resolved" &&
    deployment.implementationRuntimeCode !== undefined
  ) {
    sourceRequests.push({
      role: "implementation",
      address: deployment.proxy.implementation,
      runtimeCode: deployment.implementationRuntimeCode,
    });
  }
  const sourceCalls = sourceRequests.map(async (request) => ({
    request,
    verification: admittedVerification(input.sourceVerification, await input.sourceVerification.inspect({
      chainId: input.chain.chainId,
      address: request.address,
      runtimeBytecode: request.runtimeCode.bytecode,
      signal: input.signal,
    })),
  }));
  let sourceResults: Awaited<(typeof sourceCalls)[number]>[];
  try {
    sourceResults = await Promise.all(sourceCalls);
  } catch (error) {
    await Promise.allSettled(sourceCalls);
    throw error;
  }
  const sources = sourceResults.map(({ request, verification }) => Object.freeze({
    role: request.role,
    address: request.address,
    status: verification.status,
  }));

  let declaredFunctions: ContractAnalysis["declaredFunctions"];
  let controls: ContractAnalysis["controls"];
  if (deployment.proxy.status === "unresolved") {
    declaredFunctions = Object.freeze({
      status: "unavailable",
      reason: "deployment_unresolved",
    });
    controls = unresolvedControls("deployment_unresolved");
  } else {
    const effectiveSource = sourceResults[sourceResults.length - 1];
    if (effectiveSource === undefined) {
      throw new TypeError("Effective contract source verification is missing.");
    }
    const exactInterface = effectiveSource.verification.exactInterface;
    if (exactInterface === undefined) {
      const reason = sourceUnavailableReason(effectiveSource.verification.status);
      declaredFunctions = Object.freeze({ status: "unavailable", reason });
      controls = unresolvedControls(reason);
    } else {
      declaredFunctions = Object.freeze({
        status: "observed",
        signatures: exactInterface.declaredFunctions,
      });
      controls = await readControls(input.chain, target, exactInterface);
    }
  }

  const analysis = assertContractAnalysisForTarget({
    chainId: input.chain.chainId,
    address: target,
    block: input.chain.block,
    runtimeCode: targetRuntimeCode.identity,
  }, {
    chainId: input.chain.chainId,
    target,
    block: input.chain.block,
    targetRuntimeCode: targetRuntimeCode.identity,
    proxy: deployment.proxy,
    sources,
    declaredFunctions,
    controls,
  });
  return assertContractAnalysisExecutionForTarget({
    chainId: input.chain.chainId,
    address: target,
    block: input.chain.block,
    runtimeCode: targetRuntimeCode.identity,
  }, input.sourceVerification, {
    analysis,
    targetRuntimeCode,
    sourceObservations: sourceResults.map(({ request, verification }) => Object.freeze({
      role: request.role,
      address: request.address,
      status: verification.status,
      reference: verification.reference,
      observationAuthority: verification.observationAuthority,
      claim: createContractAnalysisSourceClaim(
        analysis,
        request.role,
        verification.exactInterface,
      ),
    })),
  });
};

export const recordContractAnalysisEvidence = (input: {
  readonly target: ContractAnalysisTarget;
  readonly sourceVerification: ContractSourceVerificationPort;
  readonly execution: ContractAnalysisExecution;
  readonly fragment: ContractAnalysisEvidenceFragment;
  readonly observations: ObservationWriter;
  readonly chainAuthority: ObservationAuthority;
}): ContractAnalysis => {
  const execution = assertContractAnalysisExecutionForTarget(
    input.target,
    input.sourceVerification,
    input.execution,
  );
  const analysis = execution.analysis;
  const deployment = input.observations.bind(input.fragment.targets.deployment);
  const controls = input.observations.bind(input.fragment.targets.controls);
  const targetSource = input.observations.bind(input.fragment.targets.targetSource);
  const implementationSource = input.observations.bind(
    input.fragment.targets.implementationSource,
  );
  const chainClaims = createContractAnalysisChainClaims(analysis);
  input.observations.record(deployment.slot, {
    source: input.chainAuthority,
    claims: [{
      role: deployment.roles.value,
      value: chainClaims.deployment,
      chainAnchor: analysis.block,
    }],
  });
  if (chainClaims.controlResults !== undefined) {
    input.observations.record(controls.slot, {
      source: input.chainAuthority,
      claims: [{
        role: controls.roles.value,
        value: chainClaims.controlResults,
        chainAnchor: analysis.block,
      }],
    });
  }
  for (const source of execution.sourceObservations) {
    const bound = source.role === "target" ? targetSource : implementationSource;
    input.observations.record(bound.slot, {
      source: source.observationAuthority,
      claims: [{
        role: bound.roles.value,
        value: source.claim,
        chainAnchor: analysis.block,
      }],
    });
  }
  return analysis;
};
