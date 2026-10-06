import { rpcReadFailureCodes, addressTargetReadFailureCodes } from "./read-failures.js";
import {createEvmPrimitiveSchemaSet} from "../evm/primitives.js";
import {z} from "zod";
import {addressTargetSchema} from "../evm/address-target.js";
import { readCapabilityLimits } from "../evm/read-limits.js";
import {canonicalUnsignedDecimalMaximumPattern, createAmountSchemaSet, type CanonicalAmount, type NativeGasRate} from "../evm/amounts.js";
import {defineEvmReadCapability} from "../evm/capability.js";
import {type IntrinsicDataValidationContext, type ReadCapabilityEvidence} from "../core/client.js";
import {type BoundEvidenceObservationSlotDeclaration, type EvidenceReplayBinder, type EvidenceReplayDeclaration, type ObservationExpectation, type ObservationReference} from "../core/client.js";
import {assertContractAnalysisForTarget, contractAnalysisSchema, contractRuntimeCodeIdentitySchema} from "../intelligence/analysis-contract.js";
import {chainStatusEvidence, addressInspectEvidence, receiptLogAmountRole, transactionEventDecimalsExclusion, transactionInspectEvidence, transactionNativeDecimalsExclusion} from "./evidence.js";
import {createContractAnalysisEvidenceDeclaration} from "../intelligence/analysis-evidence.js";
import type {CanonicalJson} from "../core/client.js";
import type {StaticScopeExclusion} from "../core/client.js";
import {canonicalErc20EventEncodingKind, matchesCanonicalErc20EventEvidence} from "../evm/erc20-events.js";
import type {ObservationClaim} from "../core/client.js";
import {jsonObject} from "../core/client.js";
import {evmChainIdSchema, type EvmChainId} from "../evm/identities.js";
import {keccak256FromHex} from "../evm/keccak256.js";
import { canonicalFailureCodes, noInputSchema, requirement, claim, expectation, asJson, conclusionFromFact, observationReference } from "../core/client.js";
import {amountObservationReferences} from "../evm/read-evidence.js";

const capabilityPrimitives = createEvmPrimitiveSchemaSet();
const capabilityAmounts = createAmountSchemaSet();

const transactionReadFailureCodes = canonicalFailureCodes([...rpcReadFailureCodes, "not_found"]);

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

const chainStatusInputSchema = noInputSchema;

const chainStatusDataSchema = jsonObject({
  chainId: evmChainIdSchema,
  latestBlock: chainAnchorSchema,
}).strict();

const addressInspectInputSchema = jsonObject({
  target: addressTargetSchema,
  block: blockSelectorSchema,
}).strict();

const addressRuntimeCodeSchema = hexBytesSchema
  .max(readCapabilityLimits.runtimeCodeBytes * 2 + 2);

const addressInspectDataSchema = z.discriminatedUnion("status", [
  jsonObject({
    status: z.literal("no_runtime_code_observed"),
    address: evmAddressSchema,
    block: chainAnchorSchema,
    runtimeCode: z.literal("0x"),
  }).strict(),
  jsonObject({
    status: z.literal("runtime_code_observed"),
    address: evmAddressSchema,
    block: chainAnchorSchema,
    runtimeCode: addressRuntimeCodeSchema.refine(
      (value) => value !== "0x",
      "Address runtime code is empty.",
    ),
    analysis: contractAnalysisSchema,
  }).strict(),
]);

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

export type ChainStatusInput = z.infer<typeof chainStatusInputSchema>;

export type ChainStatusData = z.infer<typeof chainStatusDataSchema>;

export type AddressInspectInput = z.infer<typeof addressInspectInputSchema>;

export type AddressInspectData = z.infer<typeof addressInspectDataSchema>;

export type TransactionInspectInput = z.infer<typeof transactionInspectInputSchema>;

export type TransactionInspectData = z.infer<typeof transactionInspectDataSchema>;

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

export const chainStatusCapability = defineEvmReadCapability<ChainStatusInput, ChainStatusData>({
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

const addressInspectCapabilityEvidence: ReadCapabilityEvidence<
  AddressInspectInput,
  AddressInspectData
> = Object.freeze({
  definition: addressInspectEvidence.definition,
  observationTargets: (input: AddressInspectInput) => [
    addressInspectEvidence.configuredChain.target,
    input.target.kind === "address"
      ? addressInspectEvidence.validatedInput.target
      : addressInspectEvidence.targets.activeWallet,
    addressInspectEvidence.targets.runtimeCode,
    ...Object.values(addressInspectEvidence.analysis.targets),
  ],
  declaration: (
    input: AddressInspectInput,
    data: AddressInspectData,
    binder: EvidenceReplayBinder,
  ) => {
    const chain = binder.bind(addressInspectEvidence.configuredChain.target);
    let targetSlot: BoundEvidenceObservationSlotDeclaration;
    let targetExpectation: ObservationExpectation;
    if (input.target.kind === "address") {
      const target = binder.bind(addressInspectEvidence.validatedInput.target);
      targetSlot = target.slot;
      targetExpectation = expectation(target.slot, [claim(target.roles.input, asJson(input))]);
    } else {
      const target = binder.bind(addressInspectEvidence.targets.activeWallet);
      targetSlot = target.slot;
      targetExpectation = expectation(target.slot, [claim(target.roles.address, data.address)]);
    }
    const runtimeCode = binder.bind(addressInspectEvidence.targets.runtimeCode);
    const analysis = data.status === "runtime_code_observed"
      ? createContractAnalysisEvidenceDeclaration(
          data.analysis,
          addressInspectEvidence.analysis,
          binder,
        )
      : undefined;
    const addressTargetFreshness = input.target.kind === "address"
      ? addressInspectEvidence.validatedInput.freshnessRuleId
      : "wallet_session_current" as const;
    return {
      conclusionSet: data.status === "runtime_code_observed"
        ? addressInspectEvidence.conclusionSets.runtimeCode
        : addressInspectEvidence.conclusionSets.noRuntimeCode,
      observationExpectations: [
        expectation(chain.slot, [claim(chain.roles.chainId, data.block.chainId)]),
        targetExpectation,
        expectation(runtimeCode.slot, [claim(runtimeCode.roles.runtimeCode, asJson({
          address: data.address,
          block: data.block,
          runtimeCode: data.runtimeCode,
        }), { chainAnchor: data.block })]),
        ...(analysis?.observationExpectations ?? []),
      ],
      observationReferences: analysis?.observationReferences ?? [],
      factRequirements: [
        requirement(
          addressInspectEvidence.facts.addressTarget,
          input.target.kind === "address" ? "validated_input" : "observed",
          [targetSlot],
        ),
        requirement(addressInspectEvidence.facts.runtimeCode, "observed", [runtimeCode.slot]),
        requirement(
          addressInspectEvidence.configuredChain.fact,
          addressInspectEvidence.configuredChain.outcome,
          [chain.slot],
        ),
        ...(analysis?.factRequirements ?? []),
      ],
      conclusionDrafts: [
        conclusionFromFact(
          addressInspectEvidence.conclusions.addressTargetBound,
          addressInspectEvidence.facts.addressTarget,
          addressTargetFreshness,
        ),
        conclusionFromFact(
          data.status === "runtime_code_observed"
            ? addressInspectEvidence.conclusions.runtimeCodeObserved
            : addressInspectEvidence.conclusions.noRuntimeCodeObserved,
          addressInspectEvidence.facts.runtimeCode,
          "chain_anchor_exact",
        ),
        ...(analysis?.conclusionDrafts ?? []),
      ],
      warningRequirements: analysis?.warningRequirements ?? [],
    };
  },
  staticScopeExclusions: addressInspectEvidence.staticScopeExclusions,
});

export const addressInspectCapability = defineEvmReadCapability<AddressInspectInput, AddressInspectData>({
  capabilityId: "address.inspect",
  contractVersion: "1",
  inputSchema: addressInspectInputSchema,
  dataSchema: addressInspectDataSchema,
  failureCodes: addressTargetReadFailureCodes,
  evidence: addressInspectCapabilityEvidence,
  validateIntrinsicData: (data) => {
    if (data.status === "no_runtime_code_observed") return;
    const byteLength = BigInt((data.runtimeCode.length - 2) / 2);
    if (byteLength > BigInt(readCapabilityLimits.runtimeCodeBytes)) {
      throw new TypeError("Runtime code exceeds the public result limit.");
    }
    const runtimeCode = contractRuntimeCodeIdentitySchema.parse({
      byteLength: byteLength.toString(10),
      codeHash: keccak256FromHex(data.runtimeCode),
    });
    assertContractAnalysisForTarget({
      chainId: data.block.chainId,
      address: data.address,
      block: data.block,
      runtimeCode,
    }, data.analysis);
  },
  validateSuccess: (data, context) => {
    if (data.block.chainId !== context.chainId) {
      throw new TypeError("Address chain scope mismatch.");
    }
  },
  validateRequest: (input, data) => {
    if (input.target.kind === "address" && input.target.address !== data.address) {
      throw new TypeError("Address target mismatch.");
    }
    if (
      input.block.kind === "number" &&
      input.block.blockNumber !== data.block.blockNumber
    ) {
      throw new TypeError("Address block selector mismatch.");
    }
  },
});

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

export const transactionInspectCapability = defineEvmReadCapability<TransactionInspectInput, TransactionInspectData>({
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
