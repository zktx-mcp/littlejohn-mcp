import type { ApplicationContract, CapabilityId } from "../core/client.js";
import { z, type ZodType } from "zod";
import { applicationFailureSchemaFor, capabilityIdSchema, defineApplicationContract, evmAccountIdentitySchema,
  hash32Schema, jsonObject, sameEvmAccountIdentity } from "../core/client.js";
import { receiptActivityErrorRegistry, receiptActivityFailureCodes } from "./errors.js";
import { transactionLedgerRecordSchema } from "./contracts.js";
import { receiptActivityLimits } from "./limits.js";

export const activityCursorSchema = jsonObject({ account: evmAccountIdentitySchema, after: hash32Schema }).strict();
const subject = jsonObject({ account: evmAccountIdentitySchema, transactionHash: hash32Schema }).strict();
const listInput = jsonObject({ account: evmAccountIdentitySchema, cursor: activityCursorSchema.nullable() }).strict().superRefine((value, context) => {
  if (value.cursor !== null && !sameEvmAccountIdentity(value.account, value.cursor.account)) context.addIssue({ code: "custom", message: "Activity continuation belongs to another account." });
});
const listResult = jsonObject({ account: evmAccountIdentitySchema,
  records: z.array(transactionLedgerRecordSchema).max(receiptActivityLimits.pageSize), nextCursor: activityCursorSchema.nullable() }).strict();
export const receiptQueryAcknowledgementSchema = jsonObject({ account: evmAccountIdentitySchema, transactionHash: hash32Schema,
  status: z.enum(["observed", "unavailable"]), observation: z.enum(["not_found", "pending", "reorged", "included"]).nullable(),
  recorded: z.boolean(), failure: applicationFailureSchemaFor(receiptActivityErrorRegistry, receiptActivityFailureCodes).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.status === "unavailable") !== (value.failure !== null)) context.addIssue({ code: "custom", message: "Lookup failure does not match its outcome." });
});
type ContractDefinition<Input, Output> = ApplicationContract<Input, Record<string, never>, Output> & Readonly<{
  capabilityId: CapabilityId;
  applicationContract: ApplicationContract<Input, Record<string, never>, Output>;
}>;

const define = <Input, Output>(id: string, inputSchema: ZodType<Input>, successSchema: ZodType<Output>,
  validatePublicSuccess: (input: Input, value: Output) => void): ContractDefinition<Input, Output> => {
  const applicationContract = defineApplicationContract({ contractVersion: "1", inputSchema, successSchema,
    internalContextSchema: jsonObject({}).strict(), errorRegistry: receiptActivityErrorRegistry,
    failureCodes: receiptActivityFailureCodes, validatePublicSuccess });
  return Object.freeze({ capabilityId: capabilityIdSchema.parse(id), ...applicationContract, applicationContract });
};
export const receiptApplicationContracts = Object.freeze({
  get: define("activity.get_transaction", subject, transactionLedgerRecordSchema.nullable(), (input, value) => {
    if (value !== null && (!sameEvmAccountIdentity(input.account, value.account) || input.transactionHash !== value.transactionHash)) throw new TypeError("Activity transaction identity changed.");
  }),
  list: define("activity.list_transactions", listInput, listResult, (input, value) => {
    if (!sameEvmAccountIdentity(input.account, value.account) || value.records.some((record, index) =>
      !sameEvmAccountIdentity(record.account, input.account) || (index > 0 && record.transactionHash <= value.records[index - 1]!.transactionHash) ||
      (input.cursor !== null && record.transactionHash <= input.cursor.after)) ||
      (value.nextCursor !== null && (!sameEvmAccountIdentity(input.account, value.nextCursor.account) || value.nextCursor.after !== value.records.at(-1)?.transactionHash))) {
      throw new TypeError("Activity page or continuation changed its subject or order.");
    }
  }),
  inspect: define("activity.inspect_transaction", subject, receiptQueryAcknowledgementSchema, (input, value) => {
    if (!sameEvmAccountIdentity(input.account, value.account) || input.transactionHash !== value.transactionHash) throw new TypeError("Transaction lookup identity changed.");
  }),
});
export interface ReceiptActivityPort {
  get(input: z.infer<typeof subject>): z.infer<typeof transactionLedgerRecordSchema> | null;
  list(input: z.infer<typeof listInput>): z.infer<typeof listResult>;
  inspect(input: z.infer<typeof subject>, signal: AbortSignal): Promise<z.infer<typeof receiptQueryAcknowledgementSchema>>;
}
