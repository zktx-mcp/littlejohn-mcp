import {z} from "zod";

import { readCapabilityLimits } from "../evm/read-limits.js";
import {captureCanonicalJson, type CanonicalJson} from "../core/client.js";
import {deepFreezeValue} from "../core/client.js";
import {evmAddressSchema, evmChainIdSchema, type EvmAddress} from "../evm/identities.js";
import {jsonObject} from "../core/client.js";
import {chainAnchorSchema} from "../evm/primitives.js";
import {isStrictlyOrderedUnique, hash32Schema, unsignedDecimalSchema} from "../core/client.js";

export const contractProxyMethods = Object.freeze([
  "eip1967_implementation",
  "eip1967_beacon",
  "erc1167",
] as const);

const contractProxyPreTerminalUnresolvedReasons = Object.freeze([
  "conflicting_supported_proxy_markers",
  "admin_without_supported_implementation",
  "malformed_eip1967_address_storage",
  "beacon_implementation_reverted",
  "malformed_beacon_implementation",
  "implementation_runtime_code_empty",
] as const);

export const contractProxyUnresolvedReasons = Object.freeze([
  ...contractProxyPreTerminalUnresolvedReasons,
  "implementation_terminality_unresolved",
] as const);

export const contractSourceVerificationStatuses = Object.freeze([
  "exact_match",
  "non_exact_match",
  "no_record_observed",
  "unavailable",
  "inconsistent",
] as const);

export const contractControlFailureReasons = Object.freeze([
  "deployment_unresolved",
  "exact_abi_unavailable",
  "source_inconsistent",
  "call_reverted",
  "malformed_return",
] as const);

export const contractDefaultAdminMemberLimit = 32 as const;
export const contractDeclaredFunctionCountLimit = 8_192 as const;
export const contractDeclaredFunctionUtf16CodeUnitLimit = 1_024 as const;

const positiveUnsignedDecimalSchema = unsignedDecimalSchema.refine(
  (value) => BigInt(value) > 0n,
  "Expected a positive integer.",
);

export const contractRuntimeCodeIdentitySchema = jsonObject({
  byteLength: positiveUnsignedDecimalSchema.refine(
    (value) => BigInt(value) <= BigInt(readCapabilityLimits.runtimeCodeBytes),
    "Runtime code exceeds the public result limit.",
  ),
  codeHash: hash32Schema,
}).strict();

export type ContractRuntimeCodeIdentity = z.infer<typeof contractRuntimeCodeIdentitySchema>;

const proxyAdminSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("observed"), address: evmAddressSchema }).strict(),
  jsonObject({ status: z.literal("not_present") }).strict(),
  jsonObject({ status: z.literal("not_applicable") }).strict(),
]);

const proxyHopObservationShape = {
  method: z.enum(contractProxyMethods),
  implementation: evmAddressSchema,
  implementationRuntimeCode: contractRuntimeCodeIdentitySchema,
  admin: proxyAdminSchema,
} as const;

const proxyTerminalitySchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("supported_proxy_marker_observed"),
    method: z.enum(contractProxyMethods),
  }).strict(),
  jsonObject({ status: z.literal("conflicting_supported_proxy_markers") }).strict(),
  jsonObject({ status: z.literal("malformed_eip1967_address_storage") }).strict(),
  jsonObject({ status: z.literal("admin_without_supported_implementation") }).strict(),
]);

export const contractProxyResultSchema = z.union([
  jsonObject({
    status: z.literal("resolved"),
    ...proxyHopObservationShape,
  }).strict(),
  jsonObject({
    status: z.literal("no_supported_proxy_observed"),
  }).strict(),
  jsonObject({
    status: z.literal("unresolved"),
    reason: z.enum(contractProxyPreTerminalUnresolvedReasons),
  }).strict(),
  jsonObject({
    status: z.literal("unresolved"),
    reason: z.literal("implementation_terminality_unresolved"),
    firstHop: jsonObject(proxyHopObservationShape).strict(),
    terminality: proxyTerminalitySchema,
  }).strict(),
]).superRefine((value, context) => {
  const hop = value.status === "resolved"
    ? value
    : value.status === "unresolved" &&
        value.reason === "implementation_terminality_unresolved"
      ? value.firstHop
      : undefined;
  if (
    hop !== undefined &&
    hop.method === "erc1167" &&
    hop.admin.status !== "not_applicable"
  ) {
    context.addIssue({
      code: "custom",
      message: "ERC-1167 proxy results cannot contain an EIP-1967 administrator.",
    });
  }
  if (
    hop !== undefined &&
    hop.method !== "erc1167" &&
    hop.admin.status === "not_applicable"
  ) {
    context.addIssue({
      code: "custom",
      message: "EIP-1967 proxy results require an administrator observation.",
    });
  }
});

export type ContractProxyResult = z.infer<typeof contractProxyResultSchema>;

const sourceVerificationEntrySchema = jsonObject({
  role: z.enum(["target", "implementation"]),
  address: evmAddressSchema,
  status: z.enum(contractSourceVerificationStatuses),
}).strict();

const declaredFunctionsSchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("observed"),
    signatures: z.array(
      z.string().min(1).max(contractDeclaredFunctionUtf16CodeUnitLimit),
    ).max(contractDeclaredFunctionCountLimit),
  }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.enum(contractControlFailureReasons),
  }).strict(),
]).superRefine((value, context) => {
  if (
    value.status === "observed" &&
    !isStrictlyOrderedUnique(value.signatures)
  ) {
    context.addIssue({
      code: "custom",
      message: "Declared function signatures must be unique and ordered.",
    });
  }
});

const singleControlSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("observed"), value: evmAddressSchema }).strict(),
  jsonObject({ status: z.literal("not_declared") }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.enum(contractControlFailureReasons),
  }).strict(),
]);

const pauseControlSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("observed"), value: z.boolean() }).strict(),
  jsonObject({ status: z.literal("not_declared") }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.enum(contractControlFailureReasons),
  }).strict(),
]);

const defaultAdminsSchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("observed"),
    members: z.array(evmAddressSchema).max(contractDefaultAdminMemberLimit),
  }).strict(),
  jsonObject({ status: z.literal("not_declared") }).strict(),
  jsonObject({ status: z.literal("not_enumerable") }).strict(),
  jsonObject({
    status: z.literal("limit_exceeded"),
    count: positiveUnsignedDecimalSchema,
  }).strict(),
  jsonObject({
    status: z.literal("unavailable"),
    reason: z.enum(contractControlFailureReasons),
  }).strict(),
]).superRefine((value, context) => {
  if (value.status === "observed" && !isStrictlyOrderedUnique(value.members)) {
    context.addIssue({
      code: "custom",
      message: "Default administrators must be unique and ordered.",
    });
  }
  if (
    value.status === "limit_exceeded" &&
    BigInt(value.count) <= BigInt(contractDefaultAdminMemberLimit)
  ) {
    context.addIssue({
      code: "custom",
      message: "Default-administrator count does not exceed the public limit.",
    });
  }
});

export const contractAnalysisSchema = jsonObject({
  chainId: evmChainIdSchema,
  target: evmAddressSchema,
  block: chainAnchorSchema,
  targetRuntimeCode: contractRuntimeCodeIdentitySchema,
  proxy: contractProxyResultSchema,
  sources: z.array(sourceVerificationEntrySchema).min(1).max(2),
  declaredFunctions: declaredFunctionsSchema,
  controls: jsonObject({
    owner: singleControlSchema,
    paused: pauseControlSchema,
    defaultAdmins: defaultAdminsSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.chainId !== value.block.chainId) {
    context.addIssue({
      code: "custom",
      message: "Contract analysis chain and block chain differ.",
    });
  }
});

export type ContractAnalysis = z.infer<typeof contractAnalysisSchema>;
export type ContractSourceVerificationStatus =
  (typeof contractSourceVerificationStatuses)[number];
export type ContractControlFailureReason =
  (typeof contractControlFailureReasons)[number];

export interface ContractAnalysisTarget {
  readonly chainId: ContractAnalysis["chainId"];
  readonly address: ContractAnalysis["target"];
  readonly block: ContractAnalysis["block"];
  readonly runtimeCode: ContractRuntimeCodeIdentity;
}

const effectiveSourceRole = (
  analysis: ContractAnalysis,
): "target" | "implementation" | undefined =>
  analysis.proxy.status === "unresolved"
    ? undefined
    : analysis.proxy.status === "resolved"
      ? "implementation"
      : "target";

const contractInterfaceFromAnalysis = (
  analysis: ContractAnalysis,
): ExactContractInterface => {
  if (analysis.declaredFunctions.status !== "observed") {
    throw new TypeError("Exact contract interface requires declared functions.");
  }
  return exactContractInterfaceSchema.parse({
    declaredFunctions: analysis.declaredFunctions.signatures,
    owner: analysis.controls.owner.status === "not_declared"
      ? "not_declared"
      : "erc173",
    paused: analysis.controls.paused.status === "not_declared"
      ? "not_declared"
      : "declared",
    defaultAdmins: analysis.controls.defaultAdmins.status === "not_declared"
      ? "not_declared"
      : analysis.controls.defaultAdmins.status === "not_enumerable"
        ? "not_enumerable"
        : "enumerable",
  });
};

export const createContractAnalysisSourceClaim = (
  analysisInput: ContractAnalysis,
  role: "target" | "implementation",
  exactInterfaceInput?: ExactContractInterface,
): CanonicalJson => {
  const analysis = contractAnalysisSchema.parse(analysisInput);
  const source = analysis.sources.find((candidate) => candidate.role === role);
  if (source === undefined) throw new TypeError("Contract analysis source role is absent.");
  const effectiveRole = effectiveSourceRole(analysis);
  const base = {
    role: source.role,
    address: source.address,
    status: source.status,
  };
  if (role !== effectiveRole) return captureCanonicalJson(base);
  if (source.status === "exact_match") {
    const contractInterface = exactInterfaceInput === undefined
      ? contractInterfaceFromAnalysis(analysis)
      : exactContractInterfaceSchema.parse(exactInterfaceInput);
    return captureCanonicalJson({ ...base, contractInterface });
  }
  return captureCanonicalJson({
    ...base,
    declaredFunctions: analysis.declaredFunctions,
    controls: analysis.controls,
  });
};

const observedControlResults = (
  analysis: ContractAnalysis,
): CanonicalJson | undefined => {
  const callResult = (
    control:
      | ContractAnalysis["controls"]["owner"]
      | ContractAnalysis["controls"]["paused"]
      | ContractAnalysis["controls"]["defaultAdmins"],
  ): boolean =>
    control.status === "observed" ||
    control.status === "limit_exceeded" ||
    (control.status === "unavailable" &&
      (control.reason === "call_reverted" || control.reason === "malformed_return"));
  const values = {
    ...(callResult(analysis.controls.owner) ? { owner: analysis.controls.owner } : {}),
    ...(callResult(analysis.controls.paused) ? { paused: analysis.controls.paused } : {}),
    ...(callResult(analysis.controls.defaultAdmins)
      ? { defaultAdmins: analysis.controls.defaultAdmins }
      : {}),
  };
  return Object.keys(values).length === 0 ? undefined : captureCanonicalJson(values);
};

export const createContractAnalysisChainClaims = (
  analysisInput: ContractAnalysis,
): Readonly<{
  readonly deployment: CanonicalJson;
  readonly controlResults?: CanonicalJson;
}> => {
  const analysis = contractAnalysisSchema.parse(analysisInput);
  const deployment = captureCanonicalJson({
    chainId: analysis.chainId,
    target: analysis.target,
    block: analysis.block,
    targetRuntimeCode: analysis.targetRuntimeCode,
    proxy: analysis.proxy,
    ...(analysis.proxy.status === "unresolved"
      ? {
          declaredFunctions: analysis.declaredFunctions,
          controls: analysis.controls,
        }
      : {}),
  });
  const controlResults = analysis.proxy.status === "unresolved"
    ? undefined
    : observedControlResults(analysis);
  return deepFreezeValue({
    deployment,
    ...(controlResults === undefined ? {} : { controlResults }),
  });
};

const unavailableReasonFor = (
  status: ContractSourceVerificationStatus,
): ContractControlFailureReason => status === "inconsistent"
  ? "source_inconsistent"
  : "exact_abi_unavailable";

const assertControlAvailability = (
  control: ContractAnalysis["controls"]["owner"] |
    ContractAnalysis["controls"]["paused"] |
    ContractAnalysis["controls"]["defaultAdmins"],
  expectedReason: ContractControlFailureReason | undefined,
): void => {
  if (expectedReason === undefined) {
    if (control.status === "unavailable" && (
      control.reason === "deployment_unresolved" ||
      control.reason === "exact_abi_unavailable" ||
      control.reason === "source_inconsistent"
    )) {
      throw new TypeError("Contract control result contradicts the effective exact source.");
    }
    return;
  }
  if (control.status !== "unavailable" || control.reason !== expectedReason) {
    throw new TypeError("Contract control result contradicts deployment or source availability.");
  }
};

export const assertContractAnalysisForTarget = (
  targetInput: ContractAnalysisTarget,
  analysisInput: unknown,
): ContractAnalysis => {
  const target = Object.freeze({
    chainId: evmChainIdSchema.parse(targetInput.chainId),
    address: evmAddressSchema.parse(targetInput.address),
    block: chainAnchorSchema.parse(targetInput.block),
    runtimeCode: contractRuntimeCodeIdentitySchema.parse(targetInput.runtimeCode),
  });
  const analysis = contractAnalysisSchema.parse(analysisInput);
  if (
    analysis.chainId !== target.chainId ||
    analysis.target !== target.address ||
    analysis.block.chainId !== target.block.chainId ||
    analysis.block.blockNumber !== target.block.blockNumber ||
    analysis.block.blockHash !== target.block.blockHash ||
    analysis.block.blockTimestamp !== target.block.blockTimestamp ||
    analysis.targetRuntimeCode.byteLength !== target.runtimeCode.byteLength ||
    analysis.targetRuntimeCode.codeHash !== target.runtimeCode.codeHash
  ) {
    throw new TypeError("Contract analysis does not match its target.");
  }

  const targetSource = analysis.sources[0];
  if (
    targetSource === undefined ||
    targetSource.role !== "target" ||
    targetSource.address !== target.address
  ) {
    throw new TypeError("Contract analysis target source is invalid.");
  }

  let effectiveStatus: ContractSourceVerificationStatus;
  let expectedUnavailable: ContractControlFailureReason | undefined;
  if (analysis.proxy.status === "unresolved") {
    if (analysis.sources.length !== 1) {
      throw new TypeError("Unresolved contract analysis cannot contain an implementation source.");
    }
    effectiveStatus = targetSource.status;
    expectedUnavailable = "deployment_unresolved";
  } else if (analysis.proxy.status === "resolved") {
    const implementationSource = analysis.sources[1];
    if (
      implementationSource === undefined ||
      implementationSource.role !== "implementation" ||
      implementationSource.address !== analysis.proxy.implementation ||
      analysis.sources.length !== 2
    ) {
      throw new TypeError("Resolved contract analysis implementation source is invalid.");
    }
    effectiveStatus = implementationSource.status;
    expectedUnavailable = effectiveStatus === "exact_match"
      ? undefined
      : unavailableReasonFor(effectiveStatus);
  } else {
    if (analysis.sources.length !== 1) {
      throw new TypeError("Non-proxy contract analysis cannot contain an implementation source.");
    }
    effectiveStatus = targetSource.status;
    expectedUnavailable = effectiveStatus === "exact_match"
      ? undefined
      : unavailableReasonFor(effectiveStatus);
  }

  if (expectedUnavailable === undefined) {
    if (analysis.declaredFunctions.status !== "observed") {
      throw new TypeError("Exact contract source requires declared functions.");
    }
    contractInterfaceFromAnalysis(analysis);
  } else if (
    analysis.declaredFunctions.status !== "unavailable" ||
    analysis.declaredFunctions.reason !== expectedUnavailable
  ) {
    throw new TypeError("Declared functions contradict deployment or source availability.");
  }

  assertControlAvailability(analysis.controls.owner, expectedUnavailable);
  assertControlAvailability(analysis.controls.paused, expectedUnavailable);
  assertControlAvailability(analysis.controls.defaultAdmins, expectedUnavailable);

  return deepFreezeValue(analysis);
};

const controlFunctionSignature = (
  definition: Readonly<{
    readonly name: string;
    readonly inputs: readonly Readonly<{ readonly type: string }>[];
  }>,
): string => `${definition.name}(${definition.inputs.map(({ type }) => type).join(",")})`;

const containsControlFunctions = (
  signatures: readonly string[],
  definitions: readonly Readonly<{
    readonly name: string;
    readonly inputs: readonly Readonly<{ readonly type: string }>[];
  }>[],
): boolean => definitions.every((definition) =>
  signatures.includes(controlFunctionSignature(definition)));

export const exactContractInterfaceSchema = jsonObject({
  declaredFunctions: z.array(
    z.string().min(1).max(contractDeclaredFunctionUtf16CodeUnitLimit),
  ).max(contractDeclaredFunctionCountLimit),
  owner: z.enum(["erc173", "not_declared"]),
  paused: z.enum(["declared", "not_declared"]),
  defaultAdmins: z.enum(["enumerable", "not_enumerable", "not_declared"]),
}).strict().superRefine((value, context) => {
  if (!isStrictlyOrderedUnique(value.declaredFunctions)) {
    context.addIssue({
      code: "custom",
      message: "Exact contract functions must be unique and ordered.",
    });
  }
  if (
    value.owner === "erc173" &&
    !containsControlFunctions(
      value.declaredFunctions,
      contractControlInterfaceDefinitions.owner.functions,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "ERC-173 classification requires its declared functions.",
    });
  }
  if (
    value.paused === "declared" &&
    !containsControlFunctions(
      value.declaredFunctions,
      contractControlInterfaceDefinitions.paused.functions,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Pause classification requires its declared function.",
    });
  }
  const defaultAdminDefinitions = contractControlInterfaceDefinitions.defaultAdmins;
  if (
    value.defaultAdmins !== "not_declared" &&
    !containsControlFunctions(value.declaredFunctions, defaultAdminDefinitions.baseFunctions)
  ) {
    context.addIssue({
      code: "custom",
      message: "Default-administrator classification requires its base functions.",
    });
  }
  if (
    value.defaultAdmins === "enumerable" &&
    !containsControlFunctions(value.declaredFunctions, defaultAdminDefinitions.enumerableFunctions)
  ) {
    context.addIssue({
      code: "custom",
      message: "Enumerable administrator classification requires its enumeration functions.",
    });
  }
});

export type ExactContractInterface = z.infer<typeof exactContractInterfaceSchema>;

type AbiInput = Readonly<{ readonly type: string; readonly indexed?: boolean }>;
type AbiOutput = Readonly<{ readonly type: string }>;
type FunctionDefinition = Readonly<{
  readonly name: string;
  readonly inputs: readonly AbiInput[];
  readonly outputs: readonly AbiOutput[];
  readonly stateMutability: readonly ("view" | "pure" | "nonpayable")[];
}>;
type EventDefinition = Readonly<{
  readonly name: string;
  readonly inputs: readonly AbiInput[];
}>;

export const contractControlInterfaceDefinitions = deepFreezeValue({
  owner: {
    functions: [
      { name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: ["view", "pure"] },
      {
        name: "transferOwnership",
        inputs: [{ type: "address" }],
        outputs: [],
        stateMutability: ["nonpayable"],
      },
    ],
    events: [{
      name: "OwnershipTransferred",
      inputs: [
        { type: "address", indexed: true },
        { type: "address", indexed: true },
      ],
    }],
  },
  paused: {
    functions: [{
      name: "paused",
      inputs: [],
      outputs: [{ type: "bool" }],
      stateMutability: ["view"],
    }],
  },
  defaultAdmins: {
    baseFunctions: [
      { name: "DEFAULT_ADMIN_ROLE", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: ["view"] },
      {
        name: "hasRole",
        inputs: [{ type: "bytes32" }, { type: "address" }],
        outputs: [{ type: "bool" }],
        stateMutability: ["view"],
      },
      {
        name: "getRoleAdmin",
        inputs: [{ type: "bytes32" }],
        outputs: [{ type: "bytes32" }],
        stateMutability: ["view"],
      },
      {
        name: "grantRole",
        inputs: [{ type: "bytes32" }, { type: "address" }],
        outputs: [],
        stateMutability: ["nonpayable"],
      },
      {
        name: "revokeRole",
        inputs: [{ type: "bytes32" }, { type: "address" }],
        outputs: [],
        stateMutability: ["nonpayable"],
      },
      {
        name: "renounceRole",
        inputs: [{ type: "bytes32" }, { type: "address" }],
        outputs: [],
        stateMutability: ["nonpayable"],
      },
    ],
    enumerableFunctions: [
      {
        name: "getRoleMember",
        inputs: [{ type: "bytes32" }, { type: "uint256" }],
        outputs: [{ type: "address" }],
        stateMutability: ["view"],
      },
      {
        name: "getRoleMemberCount",
        inputs: [{ type: "bytes32" }],
        outputs: [{ type: "uint256" }],
        stateMutability: ["view"],
      },
    ],
  },
} as const);

export type ContractControlFunctionDefinition = FunctionDefinition;
export type ContractControlEventDefinition = EventDefinition;
export type ContractSourceAddress = EvmAddress;
