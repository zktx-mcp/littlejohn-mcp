import {createEvmCapabilitySuccessSchema} from "../evm/capability.js";
import { z } from "zod";
import { canonicalJsonStringify, captureCanonicalJson, createEvidenceFactIdentityDeclaration, createEvidenceObservationTargetDeclaration, createExactConclusionIdentityDeclaration, hash32Schema, jsonObject, parseCapabilitySuccess, staticScopeExclusionSchema, utcTimestampSchema, utf8ByteLength, getCapabilityDefinitionSnapshot, type CapabilitySuccess, type EvidenceReplayBinder, type ObservationExpectation, type ObservationReference } from "../core/client.js";
import { createEvmEvidenceReplayDefinition } from "../evm/evidence-replay.js";
import {defineEvmReadCapability} from "../evm/capability.js";
import {evmAccountIdentitySchema, evmAddressSchema} from "../evm/identities.js";
import {uint256DecimalSchema} from "../evm/amounts.js";
import { reviewedRequestReferenceSchema } from "../review/request-reference.js";
import { nativeAssetUnitDefinition } from "../registry/native-asset.js";
import { receiptActivityFailureCodes } from "./errors.js";
import { ReceiptActivityError } from "./errors.js";
import type { ReceivedWalletTransaction } from "./admission.js";
import {
  receiptInspectionDataSchema, receiptInspectionInputSchema, receiptQuantityClaim, receiptUnitClaim,
  type ReceiptInspectionData, type ReceiptInspectionInput,
} from "./data.js";
import { receiptActivityLimits } from "./limits.js";

const conclusion = createExactConclusionIdentityDeclaration("transaction_lookup_observed");
const definition = createEvmEvidenceReplayDefinition({ capabilityId: "transaction.receipt", conclusions: [conclusion], warningCodes: [] });
const target = (name: string, sourceClass: "chain_rpc" | "official_document", purpose = name) => {
  const fact = createEvidenceFactIdentityDeclaration(definition, name);
  return { fact, declaration: createEvidenceObservationTargetDeclaration(definition,
    { slotId: name, fact, kind: "source", purpose, sourceClass, roles: { value: name } }) };
};
const quantity = target("receipt_facts", "chain_rpc", "transaction");
const units = target("receipt_token_units", "chain_rpc");
const native = target("receipt_native_units", "official_document");
const exclusions = [
  { id: "wallet_private_state", message: "Chain lookup does not reveal Wallet-only signing or queue state." },
  { id: "whole_block_deltas", message: "End-of-block balances and allowances are not transaction-attributable deltas." },
  { id: "native_unit_registry", message: "Native units use the cited chain and Ether denomination definitions, not an ERC-20 decimals call." },
  { id: "receipt_token_units_not_observed", message: "The initial receipt observation reports raw token effects before token-unit and post-state reads." },
].map((value) => staticScopeExclusionSchema.parse(value));
const declaration = (_input: ReceiptInspectionInput, data: ReceiptInspectionData, binder: EvidenceReplayBinder) => {
  const expectations: ObservationExpectation[] = [];
  const references: ObservationReference[] = [];
  const entries = [{ target: quantity, value: receiptQuantityClaim(data),
    block: data.status === "included" ? data.block : undefined,
    id: data.status === "included" ? data.quantityObservationId : undefined },
    ...(data.status !== "included" ? [] : [
      ...(data.unitsObservationId === null ? [] : [{ target: units, value: receiptUnitClaim(data), block: data.block, id: data.unitsObservationId }]),
      { target: native, value: captureCanonicalJson(nativeAssetUnitDefinition), block: undefined, id: data.nativeUnitsObservationId },
    ]),
  ];
  const requirements = entries.map((entry) => {
    const bound = binder.bind(entry.target.declaration);
    expectations.push({ slot: bound.slot, claims: [{ role: bound.roles.value, value: entry.value,
      ...(entry.block === undefined ? {} : { chainAnchor: entry.block }) }] });
    if (entry.id !== undefined) references.push({ observationId: entry.id, slot: bound.slot, role: bound.roles.value });
    return { fact: entry.target.fact, outcome: "observed" as const, observationSlots: [bound.slot], requiredObservationSlots: [bound.slot], minimumObservationCount: 1 };
  });
  return { observationExpectations: expectations, observationReferences: references,
    factRequirements: requirements,
    conclusionDrafts: [{ conclusion, outcomeFact: quantity.fact, evidenceFacts: [quantity.fact],
      freshnessRuleId: data.status === "included" ? "chain_anchor_exact" as const : "pending_transaction_observed" as const }], warningRequirements: [] };
};
export const receiptInspectionEvidence = Object.freeze({
  definition, quantity, units, native,
  observationTargets: () => [quantity.declaration, units.declaration, native.declaration], declaration, staticScopeExclusions: exclusions,
});
export const receiptInspectionCapability = defineEvmReadCapability<ReceiptInspectionInput, ReceiptInspectionData>({
  capabilityId: "transaction.receipt", contractVersion: "1", inputSchema: receiptInspectionInputSchema,
  dataSchema: receiptInspectionDataSchema, failureCodes: receiptActivityFailureCodes, evidence: receiptInspectionEvidence,
  validateIntrinsicData(data, context) {
    receiptInspectionDataSchema.parse(data);
    for (const exclusion of exclusions) context.assertDeclaredScopeExclusion(exclusion);
  },
  validateRequest(input, data) {
    if (input.transactionHash !== data.transactionHash || canonicalJsonStringify(captureCanonicalJson(input.account)) !==
      canonicalJsonStringify(captureCanonicalJson(data.account))) throw new TypeError("Receipt lookup attribution changed.");
    if (data.status === "included" || data.status === "pending") {
      const expected = input.reference === null ? "unavailable" : data.actualRequestCommitment === input.reference.walletRequestCommitment ? "matched" : "mismatched";
      if (data.requestComparison !== expected) throw new TypeError("Receipt comparison has no matching independent reference.");
    }
  },
  validateDataContext(data, context) {
    if (data.status === "included" && data.block.blockTimestamp > context.evaluatedAt) throw new TypeError("Receipt block is in the future.");
  },
  validateSuccess(data, context) {
    if (data.account.chainId !== context.chainId) throw new TypeError("Receipt belongs to another chain.");
  },
});

export const receiptInspectionSuccessSchema = createEvmCapabilitySuccessSchema(getCapabilityDefinitionSnapshot(receiptInspectionCapability).capabilityId, "1", receiptInspectionDataSchema);
export type ReceiptInspectionSuccess = CapabilitySuccess<ReceiptInspectionData>;
export const admitReceiptInspection = (input: ReceiptInspectionInput, value: unknown): ReceiptInspectionSuccess =>
  parseCapabilitySuccess(receiptInspectionCapability, input, value);

export const transactionLedgerRecordSchema = jsonObject({
  account: evmAccountIdentitySchema, transactionHash: hash32Schema,
  origin: z.discriminatedUnion("kind", [
    jsonObject({ kind: z.literal("wallet"), reference: reviewedRequestReferenceSchema }).strict(),
    jsonObject({ kind: z.literal("user_lookup") }).strict(),
  ]),
  receivedAt: utcTimestampSchema,
  observedTransaction: jsonObject({ sender: evmAddressSchema, nonce: uint256DecimalSchema }).strict().nullable(),
  inspection: receiptInspectionSuccessSchema.nullable(),
}).strict().superRefine((value, context) => {
  const reference = value.origin.kind === "wallet" ? value.origin.reference : null;
  if (reference !== null && canonicalJsonStringify(captureCanonicalJson(reference.account)) !== canonicalJsonStringify(captureCanonicalJson(value.account))) {
    context.addIssue({ code: "custom", message: "Stored transaction has another request account." });
  }
  if (value.inspection !== null) {
    const data = value.inspection.data;
    if ((data.status === "included" || data.status === "pending") &&
        (value.observedTransaction?.nonce !== data.nonce || value.observedTransaction.sender !== data.actualSender)) {
      context.addIssue({ code: "custom", message: "Stored transaction identity differs from its observed sender and nonce." });
    }
    const inspectedReference = (data.status === "included" || data.status === "pending") && data.requestComparison === "unavailable" ? null : reference;
    try { admitReceiptInspection({ account: value.account, transactionHash: value.transactionHash, reference: inspectedReference }, value.inspection); }
    catch { context.addIssue({ code: "custom", message: "Stored receipt evidence is invalid." }); }
  }
  if (utf8ByteLength(canonicalJsonStringify(captureCanonicalJson(value))) > receiptActivityLimits.recordUtf8Bytes) {
    context.addIssue({ code: "custom", message: "Transaction ledger record exceeds its byte boundary." });
  }
});
export type TransactionLedgerRecord = Omit<z.infer<typeof transactionLedgerRecordSchema>, "inspection"> & { readonly inspection: ReceiptInspectionSuccess | null };
const sameRecordValue = (a: unknown, b: unknown) => canonicalJsonStringify(captureCanonicalJson(a)) === canonicalJsonStringify(captureCanonicalJson(b));

export const assertLedgerTransition = (previous: TransactionLedgerRecord | null, next: TransactionLedgerRecord): void => {
  if (previous === null) return;
  if (!sameRecordValue(previous.account, next.account) || previous.transactionHash !== next.transactionHash ||
      previous.receivedAt !== next.receivedAt ||
      (previous.origin.kind === "wallet" && !sameRecordValue(previous.origin, next.origin)) ||
      (previous.observedTransaction !== null && !sameRecordValue(previous.observedTransaction, next.observedTransaction))) {
    throw new ReceiptActivityError("source_inconsistent");
  }
};

export const recordReceivedWalletHash = (value: ReceivedWalletTransaction, previous: TransactionLedgerRecord | null): TransactionLedgerRecord => {
  const next = transactionLedgerRecordSchema.parse({
    account: value.reference.account, transactionHash: value.transactionHash, origin: { kind: "wallet", reference: value.reference },
    receivedAt: previous?.receivedAt ?? value.receivedAt, observedTransaction: previous?.observedTransaction ?? null,
    inspection: previous?.inspection ?? null,
  });
  assertLedgerTransition(previous, next);
  return next;
};

export const recordReceiptInspection = (
  previous: TransactionLedgerRecord | null,
  input: Pick<ReceiptInspectionInput, "account" | "transactionHash">,
  receivedAt: z.infer<typeof utcTimestampSchema>,
  inspection: ReceiptInspectionSuccess,
): TransactionLedgerRecord => {
  const data = inspection.data;
  const next = transactionLedgerRecordSchema.parse({
    ...(previous ?? { ...input, receivedAt, origin: { kind: "user_lookup" } }), inspection,
    observedTransaction: data.status === "included" || data.status === "pending"
      ? { sender: data.actualSender, nonce: data.nonce } : previous?.observedTransaction ?? null,
  });
  assertLedgerTransition(previous, next);
  const oldData = previous?.inspection?.data;
  if (oldData?.status === "included" && oldData.metadataComplete && data.status === "included" && !data.metadataComplete &&
      oldData.block.blockHash === data.block.blockHash && oldData.actualRequestCommitment === data.actualRequestCommitment) return previous!;
  return next;
};
export interface TransactionLedgerStore {
  read(account: z.infer<typeof evmAccountIdentitySchema>, hash: z.infer<typeof hash32Schema>): TransactionLedgerRecord | null;
  list(account: z.infer<typeof evmAccountIdentitySchema>, cursor: z.infer<typeof hash32Schema> | null, limit: number): readonly TransactionLedgerRecord[];
  capacity(): Readonly<{ records: number; bytes: number }>;
  write(value: TransactionLedgerRecord): void;
}
