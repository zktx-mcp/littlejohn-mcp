import { z } from "zod";

import {
  assertCanonicalAmountBindings,
  createAmountSchemaSet,
  type CanonicalAmount,
  type NativeGasRate,
  type ObservationClaimBinding,
} from "./amounts.js";
import {
  CapabilityRegistry,
  defineReadCapability,
  type AnyReadCapabilityDefinition,
  type ConclusionDraft,
  type FactRequirement,
  type IntrinsicDataValidationContext,
  type ObservationExpectation,
  type ObservationSlot,
  type ObservedFact,
  type WarningRequirement,
} from "./capability.js";
import type { CanonicalJson } from "./canonical-json.js";
import type { ExternalSourceClass, FactOutcome, Freshness, StaticScopeExclusion } from "./evidence.js";
import { decodeCanonicalErc20Event } from "./erc20-events.js";
import type { ObservationClaim } from "./invocation.js";
import { jsonObject } from "./json-object.js";
import { keccak256Hex } from "./keccak256.js";
import { robinhoodChainIdentity, robinhoodWalletNamespaceRequirements } from "./identities.js";
import {
  compareCodePointSequences,
  createPrimitiveSchemaSet,
} from "./primitives.js";

const capabilityPrimitives = createPrimitiveSchemaSet();
const capabilityAmounts = createAmountSchemaSet();
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
  chainId: z.literal(robinhoodChainIdentity.chainId),
  caip2: z.literal(robinhoodChainIdentity.caip2),
  latestBlock: chainAnchorSchema,
}).strict();

const contractInspectInputSchema = jsonObject({ address: evmAddressSchema, block: blockSelectorSchema }).strict();
const contractInspectDataSchema = jsonObject({
  address: evmAddressSchema,
  block: chainAnchorSchema,
  runtimeCode: z.discriminatedUnion("status", [
    jsonObject({ status: z.literal("empty") }).strict(),
    jsonObject({
      status: z.literal("present"),
      bytecode: hexBytesSchema.max(524_290),
      byteLength: unsignedDecimalSchema,
      codeHash: hash32Schema,
    }).strict(),
  ]),
}).strict();

const transactionLogSchema = jsonObject({
  address: evmAddressSchema,
  topics: z.array(hash32Schema).max(4),
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
      storageKeys: z.array(hash32Schema).max(4096),
    }).strict()).max(1024),
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
  logs: z.array(transactionLogSchema).max(4096),
}).strict();

const transactionInspectInputSchema = jsonObject({ transactionHash: hash32Schema }).strict();
const transactionTypeSchema = z.string()
  .regex(/^(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/, "Transaction type is out of range.")
  .brand("UnsignedDecimal");
const transactionInspectDataSchema = jsonObject({
  transactionHash: hash32Schema,
  chainId: z.literal(robinhoodChainIdentity.chainId),
  from: evmAddressSchema,
  recipient: z.discriminatedUnion("kind", [
    jsonObject({ kind: z.literal("call"), address: evmAddressSchema }).strict(),
    jsonObject({ kind: z.literal("contract_creation") }).strict(),
  ]),
  value: canonicalAmountSchema,
  input: hexBytesSchema.max(4_194_306, "Transaction calldata exceeds the supported size."),
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

const accountSelectorSchema = z.discriminatedUnion("kind", [
  jsonObject({ kind: z.literal("address"), address: evmAddressSchema }).strict(),
  jsonObject({ kind: z.literal("active_wallet") }).strict(),
]);
const canonicalTokenInputSchema = (minimum: 0 | 1) => z.array(evmAddressSchema)
  .min(minimum)
  .max(50)
  .meta({ uniqueItems: true });

const accountBalanceInputSchema = z.discriminatedUnion("includeNative", [
  jsonObject({
    account: accountSelectorSchema,
    includeNative: z.literal(true),
    tokens: canonicalTokenInputSchema(0),
    block: blockSelectorSchema,
  }).strict(),
  jsonObject({
    account: accountSelectorSchema,
    includeNative: z.literal(false),
    tokens: canonicalTokenInputSchema(1),
    block: blockSelectorSchema,
  }).strict(),
]);

const tokenBalanceResultSchema = jsonObject({
  asset: erc20AssetIdentitySchema,
  result: z.discriminatedUnion("status", [
    jsonObject({ status: z.literal("available"), amount: canonicalAmountSchema }).strict(),
    jsonObject({
      status: z.literal("unavailable"),
      errorCode: z.enum(["source_unavailable", "source_inconsistent"]),
    }).strict(),
  ]),
}).strict();

const accountBalanceDataSchema = jsonObject({
  account: evmAddressSchema,
  block: chainAnchorSchema,
  native: z.discriminatedUnion("status", [
    jsonObject({ status: z.literal("not_requested") }).strict(),
    jsonObject({ status: z.literal("available"), amount: canonicalAmountSchema }).strict(),
  ]),
  tokens: z.array(tokenBalanceResultSchema).max(50),
}).strict();

const walletIdentifierSchema = capabilityPrimitives.fixedIdentifier;
const eligibleSessionCountSchema = unsignedDecimalSchema
  .regex(/^(?:[2-9]|[1-9][0-9]+)$/, "Unresolved wallet state requires at least two eligible sessions.");
const walletConnectionInputSchema = noInputSchema;
const walletConnectionDataSchema = z.discriminatedUnion("status", [
  jsonObject({ status: z.literal("unknown"), reason: z.enum(["reconciling", "owner_unavailable"]) }).strict(),
  jsonObject({
    status: z.literal("disconnected"),
    reason: z.enum(["no_session", "expired", "deleted", "disconnected", "unusable_store"]),
  }).strict(),
  jsonObject({ status: z.literal("unresolved"), eligibleSessionCount: eligibleSessionCountSchema }).strict(),
  jsonObject({
    status: z.literal("connected"),
    account: z.string(),
    address: evmAddressSchema,
    chainId: z.literal(robinhoodChainIdentity.caip2),
    approvedMethods: z.array(walletIdentifierSchema).max(64),
    approvedEvents: z.array(walletIdentifierSchema).max(64),
    expiresAt: utcTimestampSchema,
  }).strict(),
]);

export type ChainStatusInput = z.infer<typeof chainStatusInputSchema>;
export type ChainStatusData = z.infer<typeof chainStatusDataSchema>;
export type ContractInspectInput = z.infer<typeof contractInspectInputSchema>;
export type ContractInspectData = z.infer<typeof contractInspectDataSchema>;
export type TransactionInspectInput = z.infer<typeof transactionInspectInputSchema>;
export type TransactionInspectData = z.infer<typeof transactionInspectDataSchema>;
export type AccountBalanceInput = z.infer<typeof accountBalanceInputSchema>;
export type AccountBalanceData = z.infer<typeof accountBalanceDataSchema>;
export type WalletConnectionInput = z.infer<typeof walletConnectionInputSchema>;
export type WalletConnectionData = z.infer<typeof walletConnectionDataSchema>;

const exclusion = (id: string, message: string): StaticScopeExclusion =>
  Object.freeze({ id, message }) as StaticScopeExclusion;
const transactionEventDecimalsExclusion = exclusion(
  "transaction_event_decimals_not_observed",
  "Event token decimals are not read by this capability.",
);
const transactionNativeDecimalsExclusion = exclusion(
  "transaction_native_decimals_not_observed",
  "Native asset decimals are not read by this capability.",
);
const accountNativeDecimalsExclusion = exclusion(
  "account_native_decimals_not_observed",
  "Native asset decimals are not read by this capability.",
);
const sourceSlot = (
  slotId: string,
  factId: string,
  purpose: string,
  sourceClass: ExternalSourceClass,
): ObservationSlot => ({ slotId, factId, kind: "source", purpose, sourceClass });
const inputSlot = (slotId: string, factId: string, purpose: string): ObservationSlot => ({
  slotId,
  factId,
  kind: "validated_input",
  purpose,
});
const requirement = (
  factId: string,
  outcome: FactOutcome,
  observationSlotIds: readonly string[],
  requiredObservationSlotIds: readonly string[] = observationSlotIds,
  minimumObservationCount = requiredObservationSlotIds.length,
): FactRequirement => ({
  factId,
  observationSlotIds,
  requiredObservationSlotIds,
  minimumObservationCount,
  outcome,
});

const claim = (
  role: string,
  value: CanonicalJson,
  options: Partial<Pick<ObservationClaim, "asset" | "chainAnchor">> = {},
): ObservationClaim => ({ role, value, ...options });

const expectation = (slotId: string, claims: readonly ObservationClaim[]): ObservationExpectation => ({
  slotId,
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
  id: string,
  factId: string,
  facts: ReadonlyMap<string, ObservedFact>,
  freshnessRuleId: Freshness["ruleId"],
  evidenceFactIds: readonly string[] = [factId],
): ConclusionDraft => {
  const fact = facts.get(factId);
  if (fact === undefined) throw new TypeError("Missing capability fact.");
  return {
    id,
    outcomeFactId: factId,
    evidenceFactIds,
    freshnessRuleId,
  };
};

export const chainStatusCapability = defineReadCapability<ChainStatusInput, ChainStatusData>({
  capabilityId: "chain.status",
  inputSchema: chainStatusInputSchema,
  dataSchema: chainStatusDataSchema,
  conclusionIds: ["latest_block_observed", "rpc_chain_id_matches_scope"],
  observationSlots: () => [
    sourceSlot("rpc_chain_id", "rpc_chain_id", "chain_id", "chain_rpc"),
    sourceSlot("latest_block", "latest_block", "latest_block", "chain_rpc"),
  ],
  observationExpectations: (_input, data) => [
    expectation("rpc_chain_id", [claim("chain_id", data.chainId)]),
    expectation("latest_block", [claim("latest_block", asJson(data.latestBlock), { chainAnchor: data.latestBlock })]),
  ],
  factRequirements: () => [
    requirement("latest_block", "observed", ["latest_block"]),
    requirement("rpc_chain_id", "observed", ["rpc_chain_id"]),
  ],
  deriveConclusions: (_input, _data, facts) => [
    conclusionFromFact("latest_block_observed", "latest_block", facts, "chain_anchor_exact"),
    {
      ...conclusionFromFact("rpc_chain_id_matches_scope", "rpc_chain_id", facts, "chain_anchor_exact"),
      evidenceFactIds: ["latest_block", "rpc_chain_id"],
    },
  ],
  deriveWarnings: () => [],
  validateIntrinsicData: (data) => {
    if (data.latestBlock.chainId !== data.chainId) throw new TypeError("Chain status anchor mismatch.");
  },
  validateInvocation: () => undefined,
  warningCodes: [],
  staticScopeExclusions: [
    exclusion("execution_readiness", "This capability does not establish execution readiness."),
    exclusion("finality", "This capability does not establish block finality."),
    exclusion("independent_provider_agreement", "This capability does not compare independent providers."),
    exclusion("official_network_identity", "Configured scope does not establish official network identity."),
    exclusion("provider_health", "This capability does not establish provider health beyond the observation."),
  ],
});

export const contractInspectCapability = defineReadCapability<ContractInspectInput, ContractInspectData>({
  capabilityId: "contract.inspect",
  inputSchema: contractInspectInputSchema,
  dataSchema: contractInspectDataSchema,
  conclusionIds: ["account_observed", "runtime_code_observed"],
  observationSlots: () => [
    sourceSlot("rpc_chain_id", "rpc_chain_id", "chain_id", "chain_rpc"),
    sourceSlot("block", "account", "contract_block", "chain_rpc"),
    sourceSlot("runtime_code", "runtime_code", "runtime_code", "chain_rpc"),
  ],
  observationExpectations: (_input, data) => [
    expectation("rpc_chain_id", [claim("chain_id", robinhoodChainIdentity.chainId)]),
    expectation("block", [claim("contract_block", asJson({ address: data.address, block: data.block }), {
      chainAnchor: data.block,
    })]),
    expectation("runtime_code", [claim("runtime_code", asJson({
      address: data.address,
      runtimeCode: data.runtimeCode,
    }), { chainAnchor: data.block })]),
  ],
  factRequirements: () => [
    requirement("account", "observed", ["block"]),
    requirement("rpc_chain_id", "observed", ["rpc_chain_id"]),
    requirement("runtime_code", "observed", ["runtime_code"]),
  ],
  deriveConclusions: (_input, _data, facts) => [
    conclusionFromFact("account_observed", "account", facts, "chain_anchor_exact"),
    conclusionFromFact("runtime_code_observed", "runtime_code", facts, "chain_anchor_exact"),
  ],
  deriveWarnings: () => [],
  validateIntrinsicData: (data) => {
    if (data.runtimeCode.status === "present") {
      const byteLength = BigInt((data.runtimeCode.bytecode.length - 2) / 2);
      if (
        data.runtimeCode.bytecode === "0x" ||
        byteLength > 262_144n ||
        byteLength.toString(10) !== data.runtimeCode.byteLength ||
        keccak256Hex(data.runtimeCode.bytecode) !== data.runtimeCode.codeHash
      ) {
        throw new TypeError("Runtime code identity mismatch.");
      }
    }
  },
  validateInvocation: (input, data) => {
    if (input.address !== data.address) throw new TypeError("Contract target mismatch.");
    if (input.block.kind === "number" && input.block.blockNumber !== data.block.blockNumber) {
      throw new TypeError("Contract block selector mismatch.");
    }
  },
  warningCodes: [],
  staticScopeExclusions: [
    exclusion("abi_identity", "This capability does not establish ABI identity."),
    exclusion("control_roles", "This capability does not inspect contract control roles."),
    exclusion("execution_readiness", "This capability does not establish execution readiness."),
    exclusion("protocol_identity", "This capability does not establish protocol identity."),
    exclusion("proxy_identity", "This capability does not resolve proxy identity."),
    exclusion("safety", "This capability does not establish contract safety."),
    exclusion("source_verification", "This capability does not establish source verification."),
  ],
});

const assertNativeAmount = (
  amount: CanonicalAmount,
  bindings: readonly ObservationClaimBinding[],
  exclusion: StaticScopeExclusion,
  quantityRole: string,
  decimalsRole: string,
): void => {
  assertCanonicalAmountBindings(amount, bindings, new Set([exclusion.id]), {
    quantity: quantityRole,
    decimals: decimalsRole,
  });
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
): ObservationExpectation[] => {
  const anchor = transactionAnchor(data);
  const transactionClaims: ObservationClaim[] = [
    claim("transaction", asJson({
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
    claim("transaction_value", data.value.raw, {
      asset: data.value.asset,
      ...(anchor === undefined ? {} : { chainAnchor: anchor }),
    }),
    claim("transaction_gas_limit", data.gasLimit.raw, { ...(anchor === undefined ? {} : { chainAnchor: anchor }) }),
  ];
  if (data.fee.kind === "legacy") {
    transactionClaims.push(claim("transaction_gas_price", data.fee.gasPrice.numerator.raw, {
      asset: data.fee.gasPrice.numerator.asset,
      ...(anchor === undefined ? {} : { chainAnchor: anchor }),
    }));
  } else if (data.fee.kind === "dynamic") {
    transactionClaims.push(
      claim("transaction_max_fee_per_gas", data.fee.maxFeePerGas.numerator.raw, {
        asset: data.fee.maxFeePerGas.numerator.asset,
        ...(anchor === undefined ? {} : { chainAnchor: anchor }),
      }),
      claim("transaction_max_priority_fee_per_gas", data.fee.maxPriorityFeePerGas.numerator.raw, {
        asset: data.fee.maxPriorityFeePerGas.numerator.asset,
        ...(anchor === undefined ? {} : { chainAnchor: anchor }),
      }),
    );
  }
  const expectations: ObservationExpectation[] = [
    expectation("rpc_chain_id", [claim("chain_id", robinhoodChainIdentity.chainId)]),
    expectation("transaction", transactionClaims),
  ];
  if (data.inclusion.status === "included") {
    const included = data.inclusion;
    const receipt = included.receipt;
    const receiptClaims: ObservationClaim[] = [
      claim("transaction_receipt", transactionReceiptSourceValue(receipt), { chainAnchor: included.block }),
      claim("receipt_cumulative_gas_used", receipt.cumulativeGasUsed.raw, { chainAnchor: included.block }),
      claim("receipt_gas_used", receipt.gasUsed.raw, { chainAnchor: included.block }),
      claim("receipt_effective_gas_price", receipt.effectiveGasPrice.numerator.raw, {
        asset: receipt.effectiveGasPrice.numerator.asset,
        chainAnchor: included.block,
      }),
    ];
    receipt.logs.forEach((log, index) => {
      if (log.decodedEvent.kind !== "not_decoded") {
        receiptClaims.push(claim(`receipt_log_amount:${index}`, log.decodedEvent.amount.raw, {
          asset: log.decodedEvent.amount.asset,
          chainAnchor: included.block,
        }));
      }
    });
    expectations.push(
      expectation("receipt", receiptClaims),
      expectation("block", [claim("transaction_block", asJson(included.block), {
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
  const expectedFee = data.type === "0" || data.type === "1"
    ? "legacy"
    : data.type === "2"
      ? "dynamic"
      : "unsupported";
  if (data.fee.kind !== expectedFee || (data.fee.kind === "unsupported" && data.fee.type !== data.type)) {
    throw new TypeError("Transaction fee meaning is inconsistent with its type.");
  }
  if (data.accessList.kind === "entries") {
    assertOrderedUnique(data.accessList.entries.map((entry) => entry.address), "Access-list addresses");
    let storageKeyCount = 0;
    for (const entry of data.accessList.entries) {
      assertOrderedUnique(entry.storageKeys, "Access-list storage keys");
      storageKeyCount += entry.storageKeys.length;
    }
    if (storageKeyCount > 4_096) throw new TypeError("Access list has too many storage keys.");
  }
  assertNativeAmountIdentity(data.value, transactionNativeDecimalsExclusion, context);
  if (data.fee.kind === "legacy") {
    assertNativeAmountIdentity(data.fee.gasPrice.numerator, transactionNativeDecimalsExclusion, context);
  } else if (data.fee.kind === "dynamic") {
    assertNativeAmountIdentity(data.fee.maxFeePerGas.numerator, transactionNativeDecimalsExclusion, context);
    assertNativeAmountIdentity(data.fee.maxPriorityFeePerGas.numerator, transactionNativeDecimalsExclusion, context);
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
    const decoded = decodeCanonicalErc20Event(log.topics, log.data);
    if (decoded === null) {
      if (log.decodedEvent.kind !== "not_decoded") throw new TypeError("Malformed log cannot carry a decoded event.");
      continue;
    }
    if (
      log.decodedEvent.kind !== decoded.kind ||
      log.decodedEvent.token !== log.address ||
      log.decodedEvent.amount.asset.kind !== "erc20" ||
      log.decodedEvent.amount.asset.address !== log.address ||
      log.decodedEvent.amount.raw !== decoded.amountRaw ||
      log.decodedEvent.amount.decimals.status !== "not_observed" ||
      log.decodedEvent.amount.decimals.scopeExclusionId !== transactionEventDecimalsExclusion.id ||
      (decoded.kind === "erc20_transfer" && (
        log.decodedEvent.kind !== "erc20_transfer" ||
        log.decodedEvent.from !== decoded.from ||
        log.decodedEvent.to !== decoded.to
      )) ||
      (decoded.kind === "erc20_approval" && (
        log.decodedEvent.kind !== "erc20_approval" ||
        log.decodedEvent.owner !== decoded.owner ||
        log.decodedEvent.spender !== decoded.spender
      ))
    ) throw new TypeError("Decoded event does not match its canonical log encoding.");
    context.assertDeclaredScopeExclusion(transactionEventDecimalsExclusion);
  }
};

const assertObservationClaimValue = (
  bindings: readonly ObservationClaimBinding[],
  observationId: string,
  role: string,
  value: CanonicalJson,
): void => {
  const binding = bindings.find((candidate) => candidate.observationId === observationId && candidate.role === role);
  if (binding === undefined || asJson(binding.value) !== value) {
    throw new TypeError("Observed numeric value does not match its declared role.");
  }
};

export const transactionInspectCapability = defineReadCapability<TransactionInspectInput, TransactionInspectData>({
  capabilityId: "transaction.inspect",
  inputSchema: transactionInspectInputSchema,
  dataSchema: transactionInspectDataSchema,
  conclusionIds: ["inclusion_observed", "receipt_observed", "standard_events_decoded", "transaction_observed"],
  observationSlots: () => [
    sourceSlot("rpc_chain_id", "rpc_chain_id", "chain_id", "chain_rpc"),
    sourceSlot("transaction", "transaction", "transaction", "chain_rpc"),
    sourceSlot("receipt", "receipt", "transaction_receipt", "chain_rpc"),
    sourceSlot("block", "block", "transaction_block", "chain_rpc"),
  ],
  observationExpectations: transactionObservationExpectations,
  factRequirements: (_input, data) => [
    requirement("block", data.inclusion.status === "included" ? "observed" : "not_present", ["block"],
      data.inclusion.status === "included" ? ["block"] : [], data.inclusion.status === "included" ? 1 : 0),
    requirement("receipt", data.inclusion.status === "included" ? "observed" : "not_present", ["receipt"],
      data.inclusion.status === "included" ? ["receipt"] : [], data.inclusion.status === "included" ? 1 : 0),
    requirement("rpc_chain_id", "observed", ["rpc_chain_id"]),
    requirement("transaction", data.inclusion.status === "pending" ? "pending" : "observed", ["transaction"]),
  ],
  deriveConclusions: (_input, data, facts) => {
    const pending = data.inclusion.status === "pending";
    const rule = pending ? "pending_transaction_observed" : "chain_anchor_exact";
    return [
      conclusionFromFact("inclusion_observed", pending ? "transaction" : "block", facts, rule),
      conclusionFromFact("receipt_observed", "receipt", facts, rule, pending ? ["transaction"] : ["receipt"]),
      conclusionFromFact("standard_events_decoded", "receipt", facts, rule, pending ? ["transaction"] : ["receipt"]),
      conclusionFromFact("transaction_observed", "transaction", facts, rule),
    ];
  },
  deriveWarnings: (_input, data) => [
    { code: "decimals_unavailable", factIds: ["transaction"] },
    ...(data.inclusion.status === "included"
      ? [{ code: "decimals_unavailable" as const, factIds: ["receipt"] }]
      : []),
    ...(data.fee.kind === "unsupported"
      ? [{ code: "unsupported_transaction_type" as const, factIds: ["transaction"] }]
      : []),
  ],
  validateIntrinsicData: validateTransactionIntrinsicData,
  validateInvocation: (input, data, context) => {
    if (input.transactionHash !== data.transactionHash) throw new TypeError("Transaction target mismatch.");
    const bindings = context.observationClaims;
    assertNativeAmount(data.value, bindings, transactionNativeDecimalsExclusion,
      "transaction_value", "transaction_value_decimals");
    assertObservationClaimValue(bindings, data.gasLimit.observationId, "transaction_gas_limit", data.gasLimit.raw);
    if (data.fee.kind === "legacy") {
      assertNativeAmount(data.fee.gasPrice.numerator, bindings, transactionNativeDecimalsExclusion,
        "transaction_gas_price", "transaction_gas_price_decimals");
    } else if (data.fee.kind === "dynamic") {
      assertNativeAmount(data.fee.maxFeePerGas.numerator, bindings, transactionNativeDecimalsExclusion,
        "transaction_max_fee_per_gas", "transaction_max_fee_per_gas_decimals");
      assertNativeAmount(data.fee.maxPriorityFeePerGas.numerator, bindings, transactionNativeDecimalsExclusion,
        "transaction_max_priority_fee_per_gas", "transaction_max_priority_fee_per_gas_decimals");
    }
    if (data.inclusion.status === "included") {
      const receipt = data.inclusion.receipt;
      assertObservationClaimValue(bindings, receipt.cumulativeGasUsed.observationId,
        "receipt_cumulative_gas_used", receipt.cumulativeGasUsed.raw);
      assertObservationClaimValue(bindings, receipt.gasUsed.observationId, "receipt_gas_used", receipt.gasUsed.raw);
      assertNativeAmount(receipt.effectiveGasPrice.numerator, bindings, transactionNativeDecimalsExclusion,
        "receipt_effective_gas_price", "receipt_effective_gas_price_decimals");
      for (const [index, log] of receipt.logs.entries()) {
        if (log.decodedEvent.kind !== "not_decoded") {
          assertCanonicalAmountBindings(
            log.decodedEvent.amount,
            bindings,
            new Set([transactionEventDecimalsExclusion.id]),
            { quantity: `receipt_log_amount:${index}`, decimals: `receipt_log_decimals:${index}` },
          );
        }
      }
    }
  },
  warningCodes: ["decimals_unavailable", "unsupported_transaction_type"],
  staticScopeExclusions: [
    exclusion("asset_identity_from_symbols", "This capability does not derive asset identity from symbols."),
    exclusion("execution_readiness", "This capability does not establish execution readiness."),
    exclusion("finality", "This capability does not establish finality."),
    exclusion("non_standard_abi_meaning", "This capability does not decode non-standard ABI meaning."),
    exclusion("raw_signatures", "This capability does not resolve raw signatures."),
    exclusion("safety", "This capability does not establish transaction safety."),
    exclusion("traces", "This capability does not inspect execution traces."),
    transactionEventDecimalsExclusion,
    transactionNativeDecimalsExclusion,
    exclusion("unsupported_type_fields", "Unsupported transaction-type fields are not interpreted."),
  ],
});

const accountObservationSlots = (input: AccountBalanceInput): ObservationSlot[] => [
  sourceSlot("rpc_chain_id", "rpc_chain_id", "chain_id", "chain_rpc"),
  sourceSlot("block", "block", "balance_block", "chain_rpc"),
  ...(input.account.kind === "address"
    ? [inputSlot("account", "account", "account_input")]
    : [sourceSlot("account", "account", "active_wallet_account", "wallet_session")]),
  ...(input.includeNative ? [sourceSlot("native_balance", "native_balance", "native_balance", "chain_rpc")] : []),
  ...input.tokens.flatMap((address) => [
    sourceSlot(`token_balance:${address}:balance`, `token_balance:${address}`, "token_balance", "chain_rpc"),
    sourceSlot(`token_balance:${address}:decimals`, `token_balance:${address}`, "token_decimals", "chain_rpc"),
  ]),
];

const accountObservationExpectations = (
  input: AccountBalanceInput,
  data: AccountBalanceData,
): ObservationExpectation[] => {
  const expectations: ObservationExpectation[] = [
    expectation("rpc_chain_id", [claim("chain_id", robinhoodChainIdentity.chainId)]),
    expectation("block", [claim("balance_block", asJson(data.block), { chainAnchor: data.block })]),
    expectation("account", input.account.kind === "address"
      ? [claim("validated_input", asJson(input))]
      : [claim("active_wallet_account", data.account)]),
  ];
  if (data.native.status === "available") {
    expectations.push(expectation("native_balance", [claim("native_balance", data.native.amount.raw, {
      asset: data.native.amount.asset,
      chainAnchor: data.block,
    })]));
  }
  for (const token of data.tokens) {
    const address = token.asset.address;
    const balanceSlot = `token_balance:${address}:balance`;
    const decimalsSlot = `token_balance:${address}:decimals`;
    if (token.result.status === "unavailable") {
      const failed = asJson({ status: "unavailable", errorCode: token.result.errorCode });
      expectations.push(
        expectation(balanceSlot, [claim(`token_balance:${address}`, failed, { asset: token.asset, chainAnchor: data.block })]),
        expectation(decimalsSlot, [claim(`token_decimals:${address}`, failed, { asset: token.asset, chainAnchor: data.block })]),
      );
      continue;
    }
    const amount = token.result.amount;
    if (amount.decimals.status === "unavailable" && amount.decimals.reason === "conflicting") {
      throw new TypeError("One RPC decimals source cannot establish conflicting decimals values.");
    }
    const decimalsValue = amount.decimals.status === "available" ? amount.decimals.value : null;
    expectations.push(
      expectation(balanceSlot, [claim(`token_balance:${address}`, amount.raw, {
        asset: amount.asset,
        chainAnchor: data.block,
      })]),
      expectation(decimalsSlot, [claim(`token_decimals:${address}`, decimalsValue, {
        asset: amount.asset,
        chainAnchor: data.block,
      })]),
    );
  }
  return expectations;
};

export const accountBalanceCapability = defineReadCapability<AccountBalanceInput, AccountBalanceData>({
  capabilityId: "account.balance",
  inputSchema: accountBalanceInputSchema,
  dataSchema: accountBalanceDataSchema,
  normalizeInput: (input) => {
    if (new Set(input.tokens).size !== input.tokens.length) {
      throw new TypeError("Token addresses must be unique.");
    }
    return { ...input, tokens: [...input.tokens].sort(compareCodePointSequences) };
  },
  conclusionIds: ["account_bound", "native_balance_observed", "token_balance:<address>"],
  expectedConclusionIds: (input) => [
    "account_bound",
    ...(input.includeNative ? ["native_balance_observed"] : []),
    ...input.tokens.map((address) => `token_balance:${address}`),
  ],
  observationSlots: accountObservationSlots,
  observationExpectations: accountObservationExpectations,
  factRequirements: (input, data) => [
    requirement("account", input.account.kind === "address" ? "validated_input" : "observed", ["account"]),
    requirement("block", "observed", ["block"]),
    ...(input.includeNative ? [requirement("native_balance", "observed", ["native_balance"])] : []),
    requirement("rpc_chain_id", "observed", ["rpc_chain_id"]),
    ...data.tokens.map((token) => {
      const slots = [
        `token_balance:${token.asset.address}:balance`,
        `token_balance:${token.asset.address}:decimals`,
      ];
      if (token.result.status === "available") {
        return requirement(`token_balance:${token.asset.address}`, "observed", slots);
      }
      return requirement(
        `token_balance:${token.asset.address}`,
        token.result.errorCode === "source_inconsistent" ? "source_inconsistent" : "source_failed",
        slots,
        [],
        1,
      );
    }),
  ],
  deriveConclusions: (input, _data, facts) => [
    conclusionFromFact("account_bound", "account", facts,
      input.account.kind === "address" ? "validated_input_current" : "wallet_session_current"),
    ...(input.includeNative
      ? [conclusionFromFact("native_balance_observed", "native_balance", facts, "chain_anchor_exact")]
      : []),
    ...input.tokens.map((address) =>
      conclusionFromFact(`token_balance:${address}`, `token_balance:${address}`, facts, "chain_anchor_exact")),
  ],
  deriveWarnings: (_input, data) => {
    const warnings: WarningRequirement[] = [];
    if (data.native.status === "available") {
      warnings.push({ code: "decimals_unavailable", factIds: ["native_balance"] });
    }
    for (const token of data.tokens) {
      const factId = `token_balance:${token.asset.address}`;
      if (token.result.status === "unavailable") {
        warnings.push({ code: "partial_result", factIds: [factId] });
      } else if (token.result.amount.decimals.status !== "available") {
        warnings.push({ code: "decimals_unavailable", factIds: [factId] });
      }
    }
    return warnings;
  },
  validateIntrinsicData: (data, context) => {
    const resultAddresses = data.tokens.map((entry) => entry.asset.address);
    assertOrderedUnique(resultAddresses, "Token result addresses");
    if (data.native.status === "available") {
      assertNativeAmountIdentity(data.native.amount, accountNativeDecimalsExclusion, context);
    }
    for (const token of data.tokens) {
      if (token.result.status === "available" && (
        token.result.amount.asset.kind !== "erc20" ||
        token.result.amount.asset.address !== token.asset.address ||
        token.result.amount.decimals.status === "not_observed"
      )) throw new TypeError("Token result amount identity is inconsistent.");
    }
  },
  validateInvocation: (input, data, context) => {
    if (input.account.kind === "address" && input.account.address !== data.account) throw new TypeError("Account target mismatch.");
    if (input.block.kind === "number" && input.block.blockNumber !== data.block.blockNumber) {
      throw new TypeError("Account block selector mismatch.");
    }
    if (input.includeNative !== (data.native.status === "available")) throw new TypeError("Native result selection mismatch.");
    const resultAddresses = data.tokens.map((entry) => entry.asset.address);
    if (resultAddresses.join("\0") !== input.tokens.join("\0")) throw new TypeError("Token result selection mismatch.");
    if (data.native.status === "available") {
      assertNativeAmount(
        data.native.amount,
        context.observationClaims,
        accountNativeDecimalsExclusion,
        "native_balance",
        "native_balance_decimals",
      );
    }
    for (const token of data.tokens) {
      if (token.result.status === "available") {
        assertCanonicalAmountBindings(token.result.amount, context.observationClaims, new Set(), {
          quantity: `token_balance:${token.asset.address}`,
          decimals: `token_decimals:${token.asset.address}`,
        });
      }
    }
  },
  warningCodes: ["decimals_unavailable", "partial_result"],
  staticScopeExclusions: [
    accountNativeDecimalsExclusion,
    exclusion("canonical_asset_identity", "This capability does not establish canonical asset identity."),
    exclusion("cost_basis", "This capability does not calculate cost basis."),
    exclusion("execution_readiness", "This capability does not establish execution readiness."),
    exclusion("portfolio_completeness", "This capability does not establish portfolio completeness."),
    exclusion("profit_and_loss", "This capability does not calculate profit and loss."),
    exclusion("valuation", "This capability does not calculate valuation."),
  ],
});

export const walletConnectionCapability = defineReadCapability<WalletConnectionInput, WalletConnectionData>({
  capabilityId: "wallet.connection",
  inputSchema: walletConnectionInputSchema,
  dataSchema: walletConnectionDataSchema,
  conclusionIds: ["wallet_connection_state"],
  observationSlots: () => [
    sourceSlot("wallet_sdk", "wallet_connection", "wallet_sdk_sessions", "wallet_sdk"),
    sourceSlot("wallet_session", "wallet_connection", "wallet_session", "wallet_session"),
  ],
  observationExpectations: (_input, data) => [
    expectation("wallet_sdk", [claim("wallet_sdk_state", asJson(data))]),
    ...(data.status === "connected"
      ? [expectation("wallet_session", [claim("wallet_session_state", asJson(data))])]
      : []),
  ],
  factRequirements: (_input, data) => [requirement(
    "wallet_connection",
    "observed",
    ["wallet_sdk", "wallet_session"],
    data.status === "connected" ? ["wallet_sdk", "wallet_session"] : ["wallet_sdk"],
    data.status === "connected" ? 2 : 1,
  )],
  deriveConclusions: (_input, _data, facts) => [
    conclusionFromFact("wallet_connection_state", "wallet_connection", facts, "wallet_session_current"),
  ],
  deriveWarnings: () => [],
  validateIntrinsicData: (data) => {
    if (data.status === "connected") {
      if (data.account !== `${robinhoodChainIdentity.caip2}:${data.address}`) {
        throw new TypeError("The CAIP-10 account does not match the address.");
      }
      assertOrderedUnique(data.approvedMethods, "Approved wallet methods");
      assertOrderedUnique(data.approvedEvents, "Approved wallet events");
      if (
        !robinhoodWalletNamespaceRequirements.methods.every((method) =>
          data.approvedMethods.some((approved) => approved === method)) ||
        !robinhoodWalletNamespaceRequirements.events.every((event) =>
          data.approvedEvents.some((approved) => approved === event))
      ) throw new TypeError("Required wallet namespace approval is incomplete.");
    }
  },
  validateDataContext: (data, context) => {
    if (data.status === "connected" && Date.parse(data.expiresAt) <= Date.parse(context.evaluatedAt)) {
        throw new TypeError("A connected wallet session must expire after evaluation.");
    }
  },
  validateInvocation: () => undefined,
  warningCodes: [],
  staticScopeExclusions: [
    exclusion("address_ownership", "Connection state does not prove address ownership."),
    exclusion("future_session_usability", "Connection state does not guarantee future session usability."),
    exclusion("signing_authority", "Connection state does not grant signing authority."),
    exclusion("transaction_approval", "Connection state does not approve a transaction."),
    exclusion("wallet_safety", "Connection state does not establish wallet safety."),
  ],
});

export const readCapabilityRegistry = new CapabilityRegistry([
  accountBalanceCapability as unknown as AnyReadCapabilityDefinition,
  chainStatusCapability as unknown as AnyReadCapabilityDefinition,
  contractInspectCapability as unknown as AnyReadCapabilityDefinition,
  transactionInspectCapability as unknown as AnyReadCapabilityDefinition,
  walletConnectionCapability as unknown as AnyReadCapabilityDefinition,
]);
