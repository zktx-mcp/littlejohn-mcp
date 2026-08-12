import { z } from "zod";

import {
  deepFreezeValue,
  operationIdSchema,
  type OperationId,
} from "../core/client.js";

export const operationDeliveryActions = Object.freeze(["decide", "cancel"] as const);
export type OperationDeliveryAction = typeof operationDeliveryActions[number];

export const deliveryUnknownSchema = z.object({
  status: z.literal("delivery_unknown"),
  action: z.enum(operationDeliveryActions),
  operationId: operationIdSchema,
  resendAllowed: z.literal(false),
}).strict();
export type DeliveryUnknown = z.infer<typeof deliveryUnknownSchema>;

export const createDeliveryUnknown = (
  action: OperationDeliveryAction,
  operationId: OperationId,
): DeliveryUnknown => deepFreezeValue(deliveryUnknownSchema.parse({
  status: "delivery_unknown",
  action,
  operationId,
  resendAllowed: false,
}));

export const parseDeliveryUnknown = (value: unknown): DeliveryUnknown =>
  deepFreezeValue(deliveryUnknownSchema.parse(value));

export const isDeliveryUnknown = (value: unknown): value is DeliveryUnknown =>
  deliveryUnknownSchema.safeParse(value).success;
