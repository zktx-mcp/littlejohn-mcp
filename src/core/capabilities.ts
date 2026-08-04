import { z } from "zod";

import {
  accountBalanceDataSchema,
  accountBalanceInputSchema,
  assertAccountBalanceChainSemantics,
  assertAccountBalanceDataSemantics,
  assertAccountBalanceRequestSemantics,
  type AccountBalanceData,
  type AccountBalanceInput,
} from "./account-balance-contract.js";

export { readCapabilityLimits } from "./capability-contract.js";
import { readCapabilityLimits } from "./capability-contract.js";
import {
  canonicalUnsignedDecimalMaximumPattern,
  createAmountSchemaSet,
  type CanonicalAmount,
  type NativeGasRate,
} from "./amounts.js";
import {
  CapabilityRegistry,
  defineReadCapability,
  type AnyReadCapabilityDefinition,
  type IntrinsicDataValidationContext,
  type ReadCapabilityEvidence,
} from "./capability.js";
import {
  type BoundEvidenceClaimRoleDeclaration,
  type BoundEvidenceObservationSlotDeclaration,
  type ConclusionDraft,
  type EvidenceReplayBinder,
  type EvidenceReplayDeclaration,
  type FactRequirement,
  type ObservationExpectation,
  type ObservationReference,
  type WarningRequirement,
} from "./evidence-replay.js";
import {
  assertContractAnalysisForTarget,
  contractAnalysisSchema,
} from "./contract-analysis.js";
import {
  accountBalanceEvidence,
  accountNativeDecimalsExclusion,
  accountTokenEvidenceIdentity,
  chainStatusEvidence,
  contractInspectEvidence,
  createContractAnalysisEvidenceDeclaration,
  receiptLogAmountRole,
  transactionEventDecimalsExclusion,
  transactionInspectEvidence,
  transactionNativeDecimalsExclusion,
  walletConnectionEvidence,
} from "./capability-evidence.js";
import type { CanonicalJson } from "./canonical-json.js";
import type { FactOutcome, Freshness, StaticScopeExclusion } from "./evidence.js";
import {
  canonicalErc20EventEncodingKind,
  matchesCanonicalErc20EventEvidence,
} from "./erc20-events.js";
import type { ObservationClaim } from "./evidence-replay.js";
import { jsonObject } from "./json-object.js";
import { evmAddressInputSchema } from "./evm-address-input.js";
import { evmChainIdSchema, type EvmChainId } from "./identities.js";
import { keccak256FromHex } from "./keccak256.js";
import {
  compareCodePointSequences,
  createPrimitiveSchemaSet,
  sortUniqueStrings,
  type EvmAddress,
  type SnakeCaseCode,
} from "./primitives.js";
import {
  assertCanonicalWalletConnection,
  walletConnectionDataSchema,
  type WalletConnectionData,
} from "./wallet-connection.js";

const capabilityPrimitives = createPrimitiveSchemaSet();
const capabilityAmounts = createAmountSchemaSet();

const canonicalFailureCodes = (codes: readonly string[]): readonly SnakeCaseCode[] => Object.freeze(
  sortUniqueStrings(codes.map((code) => capabilityPrimitives.snakeCaseCode.parse(code))),
);

export const readBoundaryFailureCodes = canonicalFailureCodes([
  "internal_error",
  "invalid_input",
  "port_conflict",
  "request_aborted",
  "runtime_busy",
  "runtime_state_unavailable",
]);

const semanticReadFailureCodes = canonicalFailureCodes([
  ...readBoundaryFailureCodes,
  "result_too_large",
]);

const rpcReadFailureCodes = canonicalFailureCodes([
  ...semanticReadFailureCodes,
  "chain_response_unavailable",
  "rate_limited",
  "source_inconsistent",
  "source_unavailable",
]);
const transactionReadFailureCodes = canonicalFailureCodes([...rpcReadFailureCodes, "not_found"]);
const accountReadFailureCodes = canonicalFailureCodes([...rpcReadFailureCodes, "wallet_not_connected"]);
const {
  blockSelector: blockSelectorSchema,
  chainAnchor: chainAnchorSchema,
  evmAddress: evmAddressSchema,
  hash32: hash32Schema,
  hexBytes: hexBytesSchema,
  unsignedDecimal: unsignedDecimalSchema,
  utcTimestamp: utcTimestampSchema,
} = capabilityPrimitives;
const {
  canonicalAmount: canonicalAmountSchema,
  erc20AssetIdentity: erc20AssetIdentitySchema,
  gasUnits: gasUnitsSchema,
  nativeGasRate: nativeGasRateSchema,
} = capabilityAmounts;

const noInputSchema = jsonObject({}).strict();

const chainStatusInputSchema = noInputSchema;
const chainStatusDataSchema = jsonObject({
  chainId: evmChainIdSchema,
  latestBlock: chainAnchorSchema,
}).strict();

const contractInspectInputSchema = jsonObject({
  address: evmAddressInputSchema,
  block: blockSelectorSchema,
}).strict();
const contractInspectDataSchema = jsonObject({
  analysis: contractAnalysisSchema,
  runtimeCode: hexBytesSchema
    .max(readCapabilityLimits.runtimeCodeBytes * 2 + 2)
    .refine((value) => value !== "0x", "Contract runtime code is empty."),
}).strict();

const transactionLogSchema = jsonObject({
  address: evmAddressSchema,
  topics: z.array(hash32Schema).max(readCapabilityLimits.transactionLogTopics),
  data: hexBytesSchema,
  logIndex: unsignedDecimalSchema,
  transactionIndex: unsignedDecimalSchema,
  decodedEvent: z.discriminatedUnion("kind", [
    jsonObject({ kind: z.literal("not_decoded") }).strict(),
    jsonObject({
      kind: z.literal("erc20_transfer"),
      token: evmAddressSchema,
      from: evmAddressSchema,
      to: evmAddressSchema,
      amount: canonicalAmountSchema,
    }).strict(),
    jsonObject({
      kind: z.literal("erc20_approval"),
      token: evmAddressSchema,
      owner: evmAddressSchema,
      spender: evmAddressSchema,
      amount: canonicalAmountSchema,
    }).strict(),
  ]),
}).strict();

const accessListSchema = z.discriminatedUnion("kind", [
  jsonObject({ kind: z.literal("none") }).strict(),
  jsonObject({
    kind: z.literal("entries"),
    entries: z.array(jsonObject({
      address: evmAddressSchema,
      storageKeys: z.array(hash32Schema)
        .max(readCapabilityLimits.transactionAccessListStorageKeyOccurrences),
    }).strict()).max(readCapabilityLimits.transactionAccessListEntries),
  }).strict(),
]);

const receiptSchema = jsonObject({
  status: z.enum(["success", "reverted"]),
  cumulativeGasUsed: gasUnitsSchema,
  gasUsed: gasUnitsSchema,
  effectiveGasPrice: nativeGasRateSchema,
  createdContract: z.discriminatedUnion("kind", [
    jsonObject({ kind: z.literal("none") }).strict(),
    jsonObject({ kind: z.literal("address"), address: evmAddressSchema }).strict(),
  ]),
  logs: z.array(transactionLogSchema).max(readCapabilityLimits.transactionReceiptLogs),
}).strict();

const transactionInspectInputSchema = jsonObject({ transactionHash: hash32Schema }).strict();
const transactionTypeSchema = z.string()
  .regex(
    new RegExp(canonicalUnsignedDecimalMaximumPattern(readCapabilityLimits.transactionType), "u"),
    "Transaction type is out of range.",
  )
  .brand("UnsignedDecimal");
const transactionInspectDataSchema = jsonObject({
  transactionHash: hash32Schema,
  chainId: evmChainIdSchema,
  from: evmAddressSchema,
  recipient: z.discriminatedUnion("kind", [
    jsonObject({ kind: z.literal("call"), address: evmAddressSchema }).strict(),
    jsonObject({ kind: z.literal("contract_creation") }).strict(),
  ]),
  value: canonicalAmountSchema,
  input: hexBytesSchema.max(
    readCapabilityLimits.transactionCalldataBytes * 2 + 2,
    "Transaction calldata exceeds the supported size.",
  ),
  nonce: unsignedDecimalSchema,
  gasLimit: gasUnitsSchema,
  type: transactionTypeSchema,
  accessList: accessListSchema,
  fee: z.discriminatedUnion("kind", [
    jsonObject({ kind: z.literal("legacy"), gasPrice: nativeGasRateSchema }).strict(),
    jsonObject({
      kind: z.literal("dynamic"),
      maxFeePerGas: nativeGasRateSchema,
      maxPriorityFeePerGas: nativeGasRateSchema,
    }).strict(),
    jsonObject({ kind: z.literal("unsupported"), type: transactionTypeSchema }).strict(),
  ]),
  inclusion: z.discriminatedUnion("status", [
    jsonObject({ status: z.literal("pending") }).strict(),
    jsonObject({
      status: z.literal("included"),
      block: chainAnchorSchema,
      transactionIndex: unsignedDecimalSchema,
      receipt: receiptSchema,
    }).strict(),
  ]),
}).strict();

const walletConnectionInputSchema = noInputSchema;

export type ChainStatusInput = z.infer<typeof chainStatusInputSchema>;
export type ChainStatusData = z.infer<typeof chainStatusDataSchema>;
export type ContractInspectInput = z.infer<typeof contractInspectInputSchema>;
export type ContractInspectData = z.infer<typeof contractInspectDataSchema>;
export type TransactionInspectInput = z.infer<typeof transactionInspectInputSchema>;
export type TransactionInspectData = z.infer<typeof transactionInspectDataSchema>;
export type { AccountBalanceData, AccountBalanceInput } from "./account-balance-contract.js";
export type WalletConnectionInput = z.infer<typeof walletConnectionInputSchema>;
export type { WalletConnectionData } from "./wallet-connection.js";

const requirement = (
  fact: FactRequirement["fact"],
  outcome: FactOutcome,
  observationSlots: readonly BoundEvidenceObservationSlotDeclaration[],
  requiredObservationSlots: readonly BoundEvidenceObservationSlotDeclaration[] =
    observationSlots,
  minimumObservationCount = requiredObservationSlots.length,
): FactRequirement => ({
  fact,
  observationSlots,
  requiredObservationSlots,
  minimumObservationCount,
  outcome,
});

const claim = (
  role: BoundEvidenceClaimRoleDeclaration,
  value: CanonicalJson,
  options: Partial<Pick<ObservationClaim, "asset" | "chainAnchor">> = {},
): ObservationClaim => ({ role, value, ...options });

const expectation = (
  slot: BoundEvidenceObservationSlotDeclaration,
  claims: readonly ObservationClaim[],
): ObservationExpectation => ({
  slot,
  claims,
});

const asJson = (value: unknown): CanonicalJson => value as CanonicalJson;

const assertOrderedUnique = (values: readonly string[], label: string): void => {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodePointSequences(values[index - 1] ?? "", values[index] ?? "") >= 0) {
      throw new TypeError(`${label} must be unique and canonically ordered.`);
    }
  }
};

const conclusionFromFact = (
  conclusion: ConclusionDraft["conclusion"],
  fact: ConclusionDraft["outcomeFact"],
  freshnessRuleId: Freshness["ruleId"],
  evidenceFacts: readonly ConclusionDraft["outcomeFact"][] = [fact],
): ConclusionDraft => ({
  conclusion,
  outcomeFact: fact,
  evidenceFacts,
  freshnessRuleId,
});

const chainStatusCapabilityEvidence: ReadCapabilityEvidence<
  ChainStatusInput,
  ChainStatusData
> = Object.freeze({
  definition: chainStatusEvidence.definition,
  observationTargets: () => [
    chainStatusEvidence.configuredChain.target,
    chainStatusEvidence.targets.latestBlock,
  ],
  declaration: (
    _input: ChainStatusInput,
    data: ChainStatusData,
    binder: EvidenceReplayBinder,
  ) => {
    const chain = binder.bind(chainStatusEvidence.configuredChain.target);
    const latestBlock = binder.bind(chainStatusEvidence.targets.latestBlock);
    return {
      observationExpectations: [
        expectation(chain.slot, [claim(chain.roles.chainId, data.chainId)]),
        expectation(latestBlock.slot, [
          claim(latestBlock.roles.block, asJson(data.latestBlock), {
            chainAnchor: data.latestBlock,
          }),
        ]),
      ],
      observationReferences: [],
      factRequirements: [
        requirement(chainStatusEvidence.facts.latestBlock, "observed", [latestBlock.slot]),
        requirement(
          chainStatusEvidence.configuredChain.fact,
          chainStatusEvidence.configuredChain.outcome,
          [chain.slot],
        ),
      ],
      expectedConclusions: [
        chainStatusEvidence.conclusions.latestBlockObserved,
        chainStatusEvidence.conclusions.rpcChainIdMatchesScope,
      ],
      conclusionDrafts: [
        conclusionFromFact(
          chainStatusEvidence.conclusions.latestBlockObserved,
          chainStatusEvidence.facts.latestBlock,
          "chain_anchor_exact",
        ),
        conclusionFromFact(
          chainStatusEvidence.conclusions.rpcChainIdMatchesScope,
          chainStatusEvidence.configuredChain.fact,
          chainStatusEvidence.configuredChain.freshnessRuleId,
          [
            chainStatusEvidence.facts.latestBlock,
            chainStatusEvidence.configuredChain.fact,
          ],
        ),
      ],
      warningRequirements: [],
    };
  },
  staticScopeExclusions: chainStatusEvidence.staticScopeExclusions,
});

export const chainStatusCapability = defineReadCapability<ChainStatusInput, ChainStatusData>({
  capabilityId: "chain.status",
  contractVersion: "1",
  inputSchema: chainStatusInputSchema,
  dataSchema: chainStatusDataSchema,
  failureCodes: rpcReadFailureCodes,
  evidence: chainStatusCapabilityEvidence,
  validateIntrinsicData: (data) => {
    if (data.latestBlock.chainId !== data.chainId) throw new TypeError("Chain status anchor mismatch.");
  },
  validateSuccess: (data, context) => {
    if (data.chainId !== context.chainId) throw new TypeError("Chain status scope mismatch.");
  },
});

const contractInspectCapabilityEvidence: ReadCapabilityEvidence<
  ContractInspectInput,
  ContractInspectData
> = Object.freeze({
  definition: contractInspectEvidence.definition,
  observationTargets: () => [
    contractInspectEvidence.configuredChain.target,
    contractInspectEvidence.targets.block,
    ...Object.values(contractInspectEvidence.analysis.targets),
  ],
  declaration: (
    _input: ContractInspectInput,
    data: ContractInspectData,
    binder: EvidenceReplayBinder,
  ) => {
    const chain = binder.bind(contractInspectEvidence.configuredChain.target);
    const block = binder.bind(contractInspectEvidence.targets.block);
    const analysis = createContractAnalysisEvidenceDeclaration(
      data.analysis,
      contractInspectEvidence.analysis,
      binder,
    );
    return {
      observationExpectations: [
        expectation(chain.slot, [claim(chain.roles.chainId, data.analysis.block.chainId)]),
        expectation(block.slot, [claim(block.roles.block, asJson({
          address: data.analysis.target,
          block: data.analysis.block,
        }), { chainAnchor: data.analysis.block })]),
        ...analysis.observationExpectations,
      ],
      observationReferences: analysis.observationReferences,
      factRequirements: [
        requirement(contractInspectEvidence.facts.account, "observed", [block.slot]),
        requirement(
          contractInspectEvidence.configuredChain.fact,
          contractInspectEvidence.configuredChain.outcome,
          [chain.slot],
        ),
        ...analysis.factRequirements,
      ],
      expectedConclusions: [
        contractInspectEvidence.conclusions.accountObserved,
        ...analysis.expectedConclusions,
      ],
      conclusionDrafts: [
        conclusionFromFact(
          contractInspectEvidence.conclusions.accountObserved,
          contractInspectEvidence.facts.account,
          "chain_anchor_exact",
        ),
        ...analysis.conclusionDrafts,
      ],
      warningRequirements: analysis.warningRequirements,
    };
  },
  staticScopeExclusions: contractInspectEvidence.staticScopeExclusions,
});

export const contractInspectCapability = defineReadCapability<ContractInspectInput, ContractInspectData>({
  capabilityId: "contract.inspect",
  contractVersion: "1",
  inputSchema: contractInspectInputSchema,
  dataSchema: contractInspectDataSchema,
  failureCodes: transactionReadFailureCodes,
  evidence: contractInspectCapabilityEvidence,
  validateIntrinsicData: (data) => {
    const byteLength = BigInt((data.runtimeCode.length - 2) / 2);
    if (
      data.runtimeCode === "0x" ||
      byteLength > BigInt(readCapabilityLimits.runtimeCodeBytes) ||
      byteLength.toString(10) !== data.analysis.targetRuntimeCode.byteLength ||
      keccak256FromHex(data.runtimeCode) !== data.analysis.targetRuntimeCode.codeHash
    ) {
      throw new TypeError("Runtime code identity mismatch.");
    }
  },
  validateSuccess: (data, context) => {
    if (data.analysis.block.chainId !== context.chainId) {
      throw new TypeError("Contract chain scope mismatch.");
    }
  },
  validateRequest: (input, data) => {
    assertContractAnalysisForTarget({
      chainId: data.analysis.chainId,
      address: input.address,
      block: data.analysis.block,
      runtimeCode: data.analysis.targetRuntimeCode,
    }, data.analysis);
    if (
      input.block.kind === "number" &&
      input.block.blockNumber !== data.analysis.block.blockNumber
    ) {
      throw new TypeError("Contract block selector mismatch.");
    }
  },
});

const observationReference = (
  observationId: ObservationReference["observationId"],
  slot: BoundEvidenceObservationSlotDeclaration,
  role: BoundEvidenceClaimRoleDeclaration,
): ObservationReference => ({ observationId, slot, role });

const amountObservationReferences = (
  amount: CanonicalAmount,
  quantity: Readonly<{
    readonly slot: BoundEvidenceObservationSlotDeclaration;
    readonly role: BoundEvidenceClaimRoleDeclaration;
  }>,
  decimals?: Readonly<{
    readonly slot: BoundEvidenceObservationSlotDeclaration;
    readonly role: BoundEvidenceClaimRoleDeclaration;
  }>,
): readonly ObservationReference[] => {
  const references = [
    observationReference(amount.quantityObservationId, quantity.slot, quantity.role),
  ];
  if (amount.decimals.status === "not_observed") return references;
  if (decimals === undefined) {
    throw new TypeError("Observed decimals require a public observation reference.");
  }
  const observationIds = amount.decimals.status === "available"
    ? [amount.decimals.observationId]
    : amount.decimals.observationIds;
  return [
    ...references,
    ...observationIds.map((observationId) =>
      observationReference(observationId, decimals.slot, decimals.role)),
  ];
};

const assertAmountChain = (amount: CanonicalAmount, chainId: EvmChainId): void => {
  if (amount.asset.chainId !== chainId) throw new TypeError("Amount chain scope mismatch.");
};

const assertNativeGasRateChain = (rate: NativeGasRate, chainId: EvmChainId): void => {
  assertAmountChain(rate.numerator, chainId);
};

const assertNativeAmountIdentity = (
  amount: CanonicalAmount,
  exclusion: StaticScopeExclusion,
  context: IntrinsicDataValidationContext,
): void => {
  context.assertDeclaredScopeExclusion(exclusion);
  if (
    amount.asset.kind !== "native" ||
    amount.decimals.status !== "not_observed" ||
    amount.decimals.scopeExclusionId !== exclusion.id
  ) throw new TypeError("Native amount meaning is inconsistent.");
};

const transactionAnchor = (data: TransactionInspectData) =>
  data.inclusion.status === "included" ? data.inclusion.block : undefined;

const amountSourceValue = (amount: CanonicalAmount): CanonicalJson => ({
  asset: amount.asset as unknown as CanonicalJson,
  raw: amount.raw,
  decimals: amount.decimals.status === "available"
    ? { status: "available", value: amount.decimals.value }
    : amount.decimals.status === "not_observed"
      ? { status: "not_observed", scopeExclusionId: amount.decimals.scopeExclusionId }
      : { status: "unavailable", reason: amount.decimals.reason },
});

const gasRateSourceValue = (rate: NativeGasRate): CanonicalJson => ({
  numerator: amountSourceValue(rate.numerator),
  denominator: rate.denominator as unknown as CanonicalJson,
});

const transactionFeeSourceValue = (fee: TransactionInspectData["fee"]): CanonicalJson => {
  if (fee.kind === "legacy") return { kind: "legacy", gasPrice: gasRateSourceValue(fee.gasPrice) };
  if (fee.kind === "dynamic") return {
    kind: "dynamic",
    maxFeePerGas: gasRateSourceValue(fee.maxFeePerGas),
    maxPriorityFeePerGas: gasRateSourceValue(fee.maxPriorityFeePerGas),
  };
  return { kind: "unsupported", type: fee.type };
};

const transactionReceiptSourceValue = (
  receipt: Extract<TransactionInspectData["inclusion"], { status: "included" }>["receipt"],
): CanonicalJson => ({
  status: receipt.status,
  cumulativeGasUsed: { raw: receipt.cumulativeGasUsed.raw },
  gasUsed: { raw: receipt.gasUsed.raw },
  effectiveGasPrice: gasRateSourceValue(receipt.effectiveGasPrice),
  createdContract: receipt.createdContract as unknown as CanonicalJson,
  logs: receipt.logs.map((log) => ({
    address: log.address,
    topics: log.topics,
    data: log.data,
    logIndex: log.logIndex,
    transactionIndex: log.transactionIndex,
    decodedEvent: log.decodedEvent.kind === "not_decoded"
      ? { kind: "not_decoded" }
      : { ...log.decodedEvent, amount: amountSourceValue(log.decodedEvent.amount) },
  })) as unknown as CanonicalJson,
});

const transactionObservationExpectations = (
  _input: TransactionInspectInput,
  data: TransactionInspectData,
  binder: EvidenceReplayBinder,
): ObservationExpectation[] => {
  const chain = binder.bind(transactionInspectEvidence.configuredChain.target);
  const transaction = binder.bind(transactionInspectEvidence.targets.transaction);
  const receiptTarget = binder.bind(transactionInspectEvidence.targets.receipt);
  const block = binder.bind(transactionInspectEvidence.targets.block);
  const anchor = transactionAnchor(data);
  const transactionClaims: ObservationClaim[] = [
    claim(transaction.roles.transaction, asJson({
      transactionHash: data.transactionHash,
      chainId: data.chainId,
      from: data.from,
      recipient: data.recipient,
      value: amountSourceValue(data.value),
      input: data.input,
      nonce: data.nonce,
      gasLimit: { raw: data.gasLimit.raw },
      type: data.type,
      accessList: data.accessList,
      fee: transactionFeeSourceValue(data.fee),
      inclusion: data.inclusion.status === "pending"
        ? { status: "pending" }
        : {
            status: "included",
            blockNumber: data.inclusion.block.blockNumber,
            blockHash: data.inclusion.block.blockHash,
            transactionIndex: data.inclusion.transactionIndex,
          },
    }), { ...(anchor === undefined ? {} : { chainAnchor: anchor }) }),
    claim(transaction.roles.value, data.value.raw, {
      asset: data.value.asset,
      ...(anchor === undefined ? {} : { chainAnchor: anchor }),
    }),
    claim(transaction.roles.gasLimit, data.gasLimit.raw, {
      ...(anchor === undefined ? {} : { chainAnchor: anchor }),
    }),
  ];
  if (data.fee.kind === "legacy") {
    transactionClaims.push(claim(transaction.roles.gasPrice, data.fee.gasPrice.numerator.raw, {
      asset: data.fee.gasPrice.numerator.asset,
      ...(anchor === undefined ? {} : { chainAnchor: anchor }),
    }));
  } else if (data.fee.kind === "dynamic") {
    transactionClaims.push(
      claim(transaction.roles.maxFeePerGas, data.fee.maxFeePerGas.numerator.raw, {
        asset: data.fee.maxFeePerGas.numerator.asset,
        ...(anchor === undefined ? {} : { chainAnchor: anchor }),
      }),
      claim(
        transaction.roles.maxPriorityFeePerGas,
        data.fee.maxPriorityFeePerGas.numerator.raw,
        {
        asset: data.fee.maxPriorityFeePerGas.numerator.asset,
        ...(anchor === undefined ? {} : { chainAnchor: anchor }),
        },
      ),
    );
  }
  const expectations: ObservationExpectation[] = [
    expectation(chain.slot, [claim(chain.roles.chainId, data.chainId)]),
    expectation(transaction.slot, transactionClaims),
  ];
  if (data.inclusion.status === "included") {
    const included = data.inclusion;
    const receipt = included.receipt;
    const receiptClaims: ObservationClaim[] = [
      claim(receiptTarget.roles.receipt, transactionReceiptSourceValue(receipt), {
        chainAnchor: included.block,
      }),
      claim(receiptTarget.roles.cumulativeGasUsed, receipt.cumulativeGasUsed.raw, {
        chainAnchor: included.block,
      }),
      claim(receiptTarget.roles.gasUsed, receipt.gasUsed.raw, {
        chainAnchor: included.block,
      }),
      claim(receiptTarget.roles.effectiveGasPrice, receipt.effectiveGasPrice.numerator.raw, {
        asset: receipt.effectiveGasPrice.numerator.asset,
        chainAnchor: included.block,
      }),
    ];
    receipt.logs.forEach((log, index) => {
      if (log.decodedEvent.kind !== "not_decoded") {
        receiptClaims.push(claim(
          binder.bindRole(receiptLogAmountRole(index)),
          log.decodedEvent.amount.raw,
          {
          asset: log.decodedEvent.amount.asset,
          chainAnchor: included.block,
          },
        ));
      }
    });
    expectations.push(
      expectation(receiptTarget.slot, receiptClaims),
      expectation(block.slot, [claim(block.roles.block, asJson(included.block), {
        chainAnchor: included.block,
      })]),
    );
  }
  return expectations;
};

const validateTransactionIntrinsicData = (
  data: TransactionInspectData,
  context: IntrinsicDataValidationContext,
): void => {
  if (data.type === "0" && data.accessList.kind !== "none") {
    throw new TypeError("Type 0 transaction access-list meaning is invalid.");
  }
  if (
    (data.type === "1" || data.type === "2" || data.type === "3" || data.type === "4") &&
    data.accessList.kind !== "entries"
  ) {
    throw new TypeError("Typed transaction access-list meaning is invalid.");
  }
  const expectedFee = data.type === "0" || data.type === "1"
    ? "legacy"
    : data.type === "2"
      ? "dynamic"
      : "unsupported";
  if (data.fee.kind !== expectedFee || (data.fee.kind === "unsupported" && data.fee.type !== data.type)) {
    throw new TypeError("Transaction fee meaning is inconsistent with its type.");
  }
  if (data.accessList.kind === "entries") {
    let storageKeyCount = 0;
    for (const entry of data.accessList.entries) {
      storageKeyCount += entry.storageKeys.length;
    }
    if (storageKeyCount > readCapabilityLimits.transactionAccessListStorageKeyOccurrences) {
      throw new TypeError("Access list has too many storage keys.");
    }
  }
  assertNativeAmountIdentity(data.value, transactionNativeDecimalsExclusion, context);
  if (data.fee.kind === "legacy") {
    assertNativeAmountIdentity(data.fee.gasPrice.numerator, transactionNativeDecimalsExclusion, context);
  } else if (data.fee.kind === "dynamic") {
    assertNativeAmountIdentity(data.fee.maxFeePerGas.numerator, transactionNativeDecimalsExclusion, context);
    assertNativeAmountIdentity(data.fee.maxPriorityFeePerGas.numerator, transactionNativeDecimalsExclusion, context);
    if (
      BigInt(data.fee.maxPriorityFeePerGas.numerator.raw) >
      BigInt(data.fee.maxFeePerGas.numerator.raw)
    ) {
      throw new TypeError("Dynamic fee limits are inconsistent.");
    }
  }
  if (data.inclusion.status !== "included") return;
  const receipt = data.inclusion.receipt;
  assertNativeAmountIdentity(receipt.effectiveGasPrice.numerator, transactionNativeDecimalsExclusion, context);
  for (let index = 1; index < receipt.logs.length; index += 1) {
    const previous = receipt.logs[index - 1];
    const current = receipt.logs[index];
    if (previous === undefined || current === undefined || BigInt(previous.logIndex) >= BigInt(current.logIndex)) {
      throw new TypeError("Receipt log order is invalid.");
    }
  }
  for (const log of receipt.logs) {
    if (log.transactionIndex !== data.inclusion.transactionIndex) {
      throw new TypeError("Receipt log transaction mismatch.");
    }
    const encodedKind = canonicalErc20EventEncodingKind(log.topics, log.data);
    if (encodedKind === null) {
      if (log.decodedEvent.kind !== "not_decoded") throw new TypeError("Malformed log cannot carry a decoded event.");
      continue;
    }
    if (log.decodedEvent.kind === "not_decoded") {
      throw new TypeError("Canonical ERC-20 event encoding must carry its decoded evidence.");
    }
    if (
      log.decodedEvent.kind !== encodedKind ||
      log.decodedEvent.token !== log.address ||
      log.decodedEvent.amount.asset.kind !== "erc20" ||
      log.decodedEvent.amount.asset.address !== log.address ||
      log.decodedEvent.amount.decimals.status !== "not_observed" ||
      log.decodedEvent.amount.decimals.scopeExclusionId !== transactionEventDecimalsExclusion.id ||
      !matchesCanonicalErc20EventEvidence(
        log.topics,
        log.data,
        log.decodedEvent.kind === "erc20_transfer"
          ? {
              kind: "erc20_transfer",
              from: log.decodedEvent.from,
              to: log.decodedEvent.to,
              amountRaw: log.decodedEvent.amount.raw,
            }
          : {
              kind: "erc20_approval",
              owner: log.decodedEvent.owner,
              spender: log.decodedEvent.spender,
              amountRaw: log.decodedEvent.amount.raw,
            },
      )
    ) throw new TypeError("Decoded event does not match its canonical log encoding.");
    context.assertDeclaredScopeExclusion(transactionEventDecimalsExclusion);
  }
};

const transactionEvidenceDeclaration = (
  input: TransactionInspectInput,
  data: TransactionInspectData,
  binder: EvidenceReplayBinder,
): EvidenceReplayDeclaration => {
  const chain = binder.bind(transactionInspectEvidence.configuredChain.target);
  const transaction = binder.bind(transactionInspectEvidence.targets.transaction);
  const receiptTarget = binder.bind(transactionInspectEvidence.targets.receipt);
  const block = binder.bind(transactionInspectEvidence.targets.block);
  const pending = data.inclusion.status === "pending";
  const rule = pending ? "pending_transaction_observed" : "chain_anchor_exact";
  const references: ObservationReference[] = [
    ...amountObservationReferences(data.value, {
      slot: transaction.slot,
      role: transaction.roles.value,
    }),
    observationReference(
      data.gasLimit.observationId,
      transaction.slot,
      transaction.roles.gasLimit,
    ),
  ];
  if (data.fee.kind === "legacy") {
    references.push(...amountObservationReferences(data.fee.gasPrice.numerator, {
      slot: transaction.slot,
      role: transaction.roles.gasPrice,
    }));
  } else if (data.fee.kind === "dynamic") {
    references.push(
      ...amountObservationReferences(data.fee.maxFeePerGas.numerator, {
        slot: transaction.slot,
        role: transaction.roles.maxFeePerGas,
      }),
      ...amountObservationReferences(data.fee.maxPriorityFeePerGas.numerator, {
        slot: transaction.slot,
        role: transaction.roles.maxPriorityFeePerGas,
      }),
    );
  }
  if (data.inclusion.status === "included") {
    const receipt = data.inclusion.receipt;
    references.push(
      observationReference(
        receipt.cumulativeGasUsed.observationId,
        receiptTarget.slot,
        receiptTarget.roles.cumulativeGasUsed,
      ),
      observationReference(
        receipt.gasUsed.observationId,
        receiptTarget.slot,
        receiptTarget.roles.gasUsed,
      ),
      ...amountObservationReferences(receipt.effectiveGasPrice.numerator, {
        slot: receiptTarget.slot,
        role: receiptTarget.roles.effectiveGasPrice,
      }),
    );
    for (const [index, log] of receipt.logs.entries()) {
      if (log.decodedEvent.kind !== "not_decoded") {
        references.push(...amountObservationReferences(
          log.decodedEvent.amount,
          {
            slot: receiptTarget.slot,
            role: binder.bindRole(receiptLogAmountRole(index)),
          },
        ));
      }
    }
  }
  return {
    observationExpectations: transactionObservationExpectations(input, data, binder),
    observationReferences: references,
    factRequirements: [
      requirement(
        transactionInspectEvidence.facts.block,
        data.inclusion.status === "included" ? "observed" : "not_present",
        [block.slot],
        data.inclusion.status === "included" ? [block.slot] : [],
        data.inclusion.status === "included" ? 1 : 0,
      ),
      requirement(
        transactionInspectEvidence.facts.receipt,
        data.inclusion.status === "included" ? "observed" : "not_present",
        [receiptTarget.slot],
        data.inclusion.status === "included" ? [receiptTarget.slot] : [],
        data.inclusion.status === "included" ? 1 : 0,
      ),
      requirement(
        transactionInspectEvidence.configuredChain.fact,
        transactionInspectEvidence.configuredChain.outcome,
        [chain.slot],
      ),
      requirement(
        transactionInspectEvidence.facts.transaction,
        pending ? "pending" : "observed",
        [transaction.slot],
      ),
    ],
    expectedConclusions: [
      transactionInspectEvidence.conclusions.inclusionObserved,
      transactionInspectEvidence.conclusions.receiptObserved,
      transactionInspectEvidence.conclusions.standardEventsDecoded,
      transactionInspectEvidence.conclusions.transactionObserved,
    ],
    conclusionDrafts: [
      conclusionFromFact(
        transactionInspectEvidence.conclusions.inclusionObserved,
        pending
          ? transactionInspectEvidence.facts.transaction
          : transactionInspectEvidence.facts.block,
        rule,
      ),
      conclusionFromFact(
        transactionInspectEvidence.conclusions.receiptObserved,
        transactionInspectEvidence.facts.receipt,
        rule,
        [pending
          ? transactionInspectEvidence.facts.transaction
          : transactionInspectEvidence.facts.receipt],
      ),
      conclusionFromFact(
        transactionInspectEvidence.conclusions.standardEventsDecoded,
        transactionInspectEvidence.facts.receipt,
        rule,
        [pending
          ? transactionInspectEvidence.facts.transaction
          : transactionInspectEvidence.facts.receipt],
      ),
      conclusionFromFact(
        transactionInspectEvidence.conclusions.transactionObserved,
        transactionInspectEvidence.facts.transaction,
        rule,
      ),
    ],
    warningRequirements: [
      {
        code: "decimals_unavailable",
        facts: [transactionInspectEvidence.facts.transaction],
      },
      ...(data.inclusion.status === "included"
        ? [{
            code: "decimals_unavailable" as const,
            facts: [transactionInspectEvidence.facts.receipt],
          }]
        : []),
      ...(data.fee.kind === "unsupported"
        ? [{
            code: "unsupported_transaction_type" as const,
            facts: [transactionInspectEvidence.facts.transaction],
          }]
        : []),
    ],
  };
};

const transactionInspectCapabilityEvidence: ReadCapabilityEvidence<
  TransactionInspectInput,
  TransactionInspectData
> = Object.freeze({
  definition: transactionInspectEvidence.definition,
  observationTargets: () => [
    transactionInspectEvidence.configuredChain.target,
    transactionInspectEvidence.targets.transaction,
    transactionInspectEvidence.targets.receipt,
    transactionInspectEvidence.targets.block,
  ],
  declaration: transactionEvidenceDeclaration,
  staticScopeExclusions: transactionInspectEvidence.staticScopeExclusions,
});

export const transactionInspectCapability = defineReadCapability<TransactionInspectInput, TransactionInspectData>({
  capabilityId: "transaction.inspect",
  contractVersion: "1",
  inputSchema: transactionInspectInputSchema,
  dataSchema: transactionInspectDataSchema,
  failureCodes: transactionReadFailureCodes,
  evidence: transactionInspectCapabilityEvidence,
  validateIntrinsicData: validateTransactionIntrinsicData,
  validateSuccess: (data, context) => {
    if (data.chainId !== context.chainId) throw new TypeError("Transaction chain scope mismatch.");
    assertAmountChain(data.value, context.chainId);
    if (data.fee.kind === "legacy") {
      assertNativeGasRateChain(data.fee.gasPrice, context.chainId);
    } else if (data.fee.kind === "dynamic") {
      assertNativeGasRateChain(data.fee.maxFeePerGas, context.chainId);
      assertNativeGasRateChain(data.fee.maxPriorityFeePerGas, context.chainId);
    }
    if (data.inclusion.status === "included") {
      if (data.inclusion.block.chainId !== context.chainId) {
        throw new TypeError("Transaction block chain scope mismatch.");
      }
      assertNativeGasRateChain(data.inclusion.receipt.effectiveGasPrice, context.chainId);
      for (const log of data.inclusion.receipt.logs) {
        if (log.decodedEvent.kind !== "not_decoded") {
          assertAmountChain(log.decodedEvent.amount, context.chainId);
        }
      }
    }
  },
  validateRequest: (input, data) => {
    if (input.transactionHash !== data.transactionHash) throw new TypeError("Transaction target mismatch.");
  },
});

const accountObservationTargets = (input: AccountBalanceInput) => [
  accountBalanceEvidence.configuredChain.target,
  accountBalanceEvidence.targets.block,
  input.account.kind === "address"
    ? accountBalanceEvidence.validatedInput.target
    : accountBalanceEvidence.targets.walletAccount,
  ...(input.includeNative ? [accountBalanceEvidence.targets.nativeBalance] : []),
  ...input.tokens.flatMap((address) => {
    const identity = accountTokenEvidenceIdentity(input, address);
    return [identity.balanceTarget, identity.decimalsTarget];
  }),
];

const accountObservationExpectations = (
  input: AccountBalanceInput,
  data: AccountBalanceData,
  binder: EvidenceReplayBinder,
): ObservationExpectation[] => {
  const chain = binder.bind(accountBalanceEvidence.configuredChain.target);
  const block = binder.bind(accountBalanceEvidence.targets.block);
  const expectations: ObservationExpectation[] = [
    expectation(chain.slot, [claim(chain.roles.chainId, data.block.chainId)]),
    expectation(block.slot, [
      claim(block.roles.block, asJson(data.block), { chainAnchor: data.block }),
    ]),
    ...(input.account.kind === "address"
      ? [expectation(
          binder.bind(accountBalanceEvidence.validatedInput.target).slot,
          [claim(
            binder.bind(accountBalanceEvidence.validatedInput.target).roles.input,
            asJson(input),
          )],
        )]
      : [expectation(
          binder.bind(accountBalanceEvidence.targets.walletAccount).slot,
          [claim(
            binder.bind(accountBalanceEvidence.targets.walletAccount).roles.account,
            data.account,
          )],
        )]),
  ];
  if (data.native.status === "available") {
    const nativeBalance = binder.bind(accountBalanceEvidence.targets.nativeBalance);
    expectations.push(expectation(nativeBalance.slot, [
      claim(nativeBalance.roles.balance, data.native.amount.raw, {
        asset: data.native.amount.asset,
        chainAnchor: data.block,
      }),
    ]));
  }
  for (const token of data.tokens) {
    const identity = accountTokenEvidenceIdentity(input, token.asset.address);
    const balance = binder.bind(identity.balanceTarget);
    const decimals = binder.bind(identity.decimalsTarget);
    if (token.result.status === "unavailable") {
      const failed = asJson({ status: "unavailable", errorCode: token.result.errorCode });
      expectations.push(
        expectation(balance.slot, [claim(balance.roles.balance, failed, {
          asset: token.asset,
          chainAnchor: data.block,
        })]),
        expectation(decimals.slot, [claim(decimals.roles.decimals, failed, {
          asset: token.asset,
          chainAnchor: data.block,
        })]),
      );
      continue;
    }
    const amount = token.result.amount;
    if (amount.decimals.status === "unavailable" && amount.decimals.reason === "conflicting") {
      throw new TypeError("One RPC decimals source cannot establish conflicting decimals values.");
    }
    const decimalsValue = amount.decimals.status === "available" ? amount.decimals.value : null;
    expectations.push(
      expectation(balance.slot, [claim(balance.roles.balance, amount.raw, {
        asset: amount.asset,
        chainAnchor: data.block,
      })]),
      expectation(decimals.slot, [claim(decimals.roles.decimals, decimalsValue, {
        asset: amount.asset,
        chainAnchor: data.block,
      })]),
    );
  }
  return expectations;
};

const accountBalanceEvidenceDeclaration = (
  input: AccountBalanceInput,
  data: AccountBalanceData,
  binder: EvidenceReplayBinder,
): EvidenceReplayDeclaration => {
  const chain = binder.bind(accountBalanceEvidence.configuredChain.target);
  const block = binder.bind(accountBalanceEvidence.targets.block);
  const account = input.account.kind === "address"
    ? binder.bind(accountBalanceEvidence.validatedInput.target)
    : binder.bind(accountBalanceEvidence.targets.walletAccount);
  const references: ObservationReference[] = [];
  if (data.native.status === "available") {
    const nativeBalance = binder.bind(accountBalanceEvidence.targets.nativeBalance);
    references.push(...amountObservationReferences(
      data.native.amount,
      { slot: nativeBalance.slot, role: nativeBalance.roles.balance },
    ));
  }
  for (const token of data.tokens) {
    if (token.result.status === "available") {
      const identity = accountTokenEvidenceIdentity(input, token.asset.address);
      const balance = binder.bind(identity.balanceTarget);
      const decimals = binder.bind(identity.decimalsTarget);
      references.push(...amountObservationReferences(
        token.result.amount,
        { slot: balance.slot, role: balance.roles.balance },
        { slot: decimals.slot, role: decimals.roles.decimals },
      ));
    }
  }

  const warningRequirements: WarningRequirement[] = [];
  if (data.native.status === "available") {
    warningRequirements.push({
      code: "decimals_unavailable",
      facts: [accountBalanceEvidence.facts.nativeBalance],
    });
  }
  for (const token of data.tokens) {
    const fact = accountTokenEvidenceIdentity(input, token.asset.address).fact;
    if (token.result.status === "unavailable") {
      warningRequirements.push({ code: "partial_result", facts: [fact] });
    } else if (token.result.amount.decimals.status !== "available") {
      warningRequirements.push({ code: "decimals_unavailable", facts: [fact] });
    }
  }

  return {
    observationExpectations: accountObservationExpectations(input, data, binder),
    observationReferences: references,
    factRequirements: [
      requirement(
        accountBalanceEvidence.validatedInput.fact,
        input.account.kind === "address"
          ? accountBalanceEvidence.validatedInput.outcome
          : "observed",
        [account.slot],
      ),
      requirement(accountBalanceEvidence.facts.block, "observed", [block.slot]),
      ...(input.includeNative
        ? [requirement(
            accountBalanceEvidence.facts.nativeBalance,
            "observed",
            [binder.bind(accountBalanceEvidence.targets.nativeBalance).slot],
          )]
        : []),
      requirement(
        accountBalanceEvidence.configuredChain.fact,
        accountBalanceEvidence.configuredChain.outcome,
        [chain.slot],
      ),
      ...data.tokens.map((token) => {
        const identity = accountTokenEvidenceIdentity(input, token.asset.address);
        const slots = [
          binder.bind(identity.balanceTarget).slot,
          binder.bind(identity.decimalsTarget).slot,
        ];
        if (token.result.status === "available") {
          return requirement(identity.fact, "observed", slots);
        }
        return requirement(
          identity.fact,
          token.result.errorCode === "source_inconsistent" ? "source_inconsistent" : "source_failed",
          slots,
          [],
          1,
        );
      }),
    ],
    expectedConclusions: [
      accountBalanceEvidence.conclusions.accountBound,
      ...(input.includeNative
        ? [accountBalanceEvidence.conclusions.nativeBalanceObserved]
        : []),
      ...input.tokens.map((address) =>
        accountTokenEvidenceIdentity(input, address).conclusion),
    ],
    conclusionDrafts: [
      conclusionFromFact(
        accountBalanceEvidence.conclusions.accountBound,
        accountBalanceEvidence.validatedInput.fact,
        input.account.kind === "address"
          ? accountBalanceEvidence.validatedInput.freshnessRuleId
          : "wallet_session_current",
      ),
      ...(input.includeNative
        ? [conclusionFromFact(
            accountBalanceEvidence.conclusions.nativeBalanceObserved,
            accountBalanceEvidence.facts.nativeBalance,
            "chain_anchor_exact",
          )]
        : []),
      ...input.tokens.map((address) => {
        const identity = accountTokenEvidenceIdentity(input, address);
        return conclusionFromFact(
          identity.conclusion,
          identity.fact,
          "chain_anchor_exact",
        );
      }),
    ],
    warningRequirements,
  };
};

const accountBalanceCapabilityEvidence: ReadCapabilityEvidence<
  AccountBalanceInput,
  AccountBalanceData
> = Object.freeze({
  definition: accountBalanceEvidence.definition,
  observationTargets: accountObservationTargets,
  declaration: accountBalanceEvidenceDeclaration,
  staticScopeExclusions: accountBalanceEvidence.staticScopeExclusions,
});

export const accountBalanceCapability = defineReadCapability<AccountBalanceInput, AccountBalanceData>({
  capabilityId: "account.balance",
  contractVersion: "1",
  inputSchema: accountBalanceInputSchema,
  dataSchema: accountBalanceDataSchema,
  failureCodes: accountReadFailureCodes,
  normalizeInput: (input) => {
    if (new Set(input.tokens).size !== input.tokens.length) {
      throw new TypeError("Token addresses must be unique.");
    }
    return { ...input, tokens: [...input.tokens].sort(compareCodePointSequences) };
  },
  evidence: accountBalanceCapabilityEvidence,
  validateIntrinsicData: (data, context) => {
    context.assertDeclaredScopeExclusion(accountNativeDecimalsExclusion);
    assertAccountBalanceDataSemantics(data);
  },
  validateSuccess: (data, context) => {
    assertAccountBalanceChainSemantics(data, context.chainId);
  },
  validateRequest: assertAccountBalanceRequestSemantics,
});

const walletConnectionCapabilityEvidence: ReadCapabilityEvidence<
  WalletConnectionInput,
  WalletConnectionData
> = Object.freeze({
  definition: walletConnectionEvidence.definition,
  observationTargets: () => [
    walletConnectionEvidence.targets.sdk,
    walletConnectionEvidence.targets.session,
  ],
  declaration: (
    _input: WalletConnectionInput,
    data: WalletConnectionData,
    binder: EvidenceReplayBinder,
  ) => {
    const sdk = binder.bind(walletConnectionEvidence.targets.sdk);
    const session = binder.bind(walletConnectionEvidence.targets.session);
    return {
      observationExpectations: [
        expectation(sdk.slot, [claim(sdk.roles.state, asJson(data))]),
        ...(data.status === "connected"
          ? [expectation(session.slot, [claim(session.roles.state, asJson(data))])]
          : []),
      ],
      observationReferences: [],
      factRequirements: [requirement(
        walletConnectionEvidence.facts.connection,
        "observed",
        [sdk.slot, session.slot],
        data.status === "connected" ? [sdk.slot, session.slot] : [sdk.slot],
        data.status === "connected" ? 2 : 1,
      )],
      expectedConclusions: [walletConnectionEvidence.conclusions.connectionState],
      conclusionDrafts: [
        conclusionFromFact(
          walletConnectionEvidence.conclusions.connectionState,
          walletConnectionEvidence.facts.connection,
          "wallet_session_current",
        ),
      ],
      warningRequirements: [],
    };
  },
  staticScopeExclusions: walletConnectionEvidence.staticScopeExclusions,
});

export const walletConnectionCapability = defineReadCapability<WalletConnectionInput, WalletConnectionData>({
  capabilityId: "wallet.connection",
  contractVersion: "1",
  inputSchema: walletConnectionInputSchema,
  dataSchema: walletConnectionDataSchema,
  failureCodes: semanticReadFailureCodes,
  evidence: walletConnectionCapabilityEvidence,
  validateIntrinsicData: assertCanonicalWalletConnection,
  validateDataContext: (data, context) => {
    if (data.status === "connected" && Date.parse(data.expiresAt) <= Date.parse(context.evaluatedAt)) {
        throw new TypeError("A connected wallet session must expire after evaluation.");
    }
  },
  validateSuccess: (data, context) => {
    if (data.status === "connected" && data.chainId !== context.chainId) {
      throw new TypeError("Wallet connection chain scope mismatch.");
    }
  },
});

export const chainReadCapabilities = Object.freeze([
  accountBalanceCapability,
  chainStatusCapability,
  contractInspectCapability,
  transactionInspectCapability,
] as const);

export const readCapabilityRegistry = new CapabilityRegistry([
  ...chainReadCapabilities.map((definition) => definition as unknown as AnyReadCapabilityDefinition),
  walletConnectionCapability as unknown as AnyReadCapabilityDefinition,
]);
