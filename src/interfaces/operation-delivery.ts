import { z } from "zod";
import {walletSelectAccountInputSchema, walletAccountSelectionInputSchema, type WalletSelectAccountInput} from "../wallet/account-selection-contract.js";

import {
  deepFreezeValue,
  operationIdSchema,
  type OperationId,
} from "../core/client.js";

export const operationDeliveryActions = Object.freeze(["decide", "cancel"] as const);
export type OperationDeliveryAction = typeof operationDeliveryActions[number];

export const operationDeliveryUnknownSchema = z.object({
  status: z.literal("delivery_unknown"),
  action: z.enum(operationDeliveryActions),
  operationId: operationIdSchema,
  resendAllowed: z.literal(false),
}).strict();
export const selectorDeliveryUnknownSchema = z.object({
  status: z.literal("delivery_unknown"), action: z.literal("select_account"),
  selector: walletSelectAccountInputSchema, cardId: operationIdSchema.nullable(),
  recovery: z.object({capabilityId: z.literal("wallet.account_selection"), input: walletAccountSelectionInputSchema}).strict(),
  resendAllowed: z.literal(false),
}).strict();
export type SelectorDeliveryUnknown = z.infer<typeof selectorDeliveryUnknownSchema>;
export const deliveryUnknownSchema = z.union([operationDeliveryUnknownSchema, selectorDeliveryUnknownSchema]);
export type DeliveryUnknown = z.infer<typeof deliveryUnknownSchema>;

export const createDeliveryUnknown = (
  action: OperationDeliveryAction,
  operationId: OperationId,
): z.infer<typeof operationDeliveryUnknownSchema> => deepFreezeValue(operationDeliveryUnknownSchema.parse({
  status: "delivery_unknown",
  action,
  operationId,
  resendAllowed: false,
}));

export const createSelectorDeliveryUnknown = (selector: WalletSelectAccountInput, cardId: string | null): SelectorDeliveryUnknown =>
  deepFreezeValue(selectorDeliveryUnknownSchema.parse({status: "delivery_unknown", action: "select_account", selector, cardId,
    recovery: {capabilityId: "wallet.account_selection", input: {chainId: selector.chainId}}, resendAllowed: false}));

export const parseDeliveryUnknown = (value: unknown): DeliveryUnknown =>
  deepFreezeValue(deliveryUnknownSchema.parse(value));

export const isDeliveryUnknown = (value: unknown): value is DeliveryUnknown =>
  deliveryUnknownSchema.safeParse(value).success;
