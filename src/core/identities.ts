import { z } from "zod";

import { guardJsonSchema, jsonObject } from "./json-object.js";

const evmChainIdPattern = /^eip155:[1-9][0-9]{0,31}$/u;
const canonicalEvmAddressPattern = /^0x[0-9a-f]{40}$/u;

const brandedString = <Brand extends string>(
  pattern: RegExp,
  message: string,
  brand: Brand,
) => z.string().regex(pattern, message).brand(brand);

export const evmChainIdSchema = brandedString(
  evmChainIdPattern,
  "Expected a canonical EIP-155 CAIP-2 chain identifier.",
  "EvmChainId",
);
export type EvmChainId = z.infer<typeof evmChainIdSchema>;

export const evmAddressSchema = brandedString(
  canonicalEvmAddressPattern,
  "Expected a canonical lowercase EVM address.",
  "EvmAddress",
);
export type EvmAddress = z.infer<typeof evmAddressSchema>;

export const evmAccountIdentitySchema = guardJsonSchema(jsonObject({
  chainId: evmChainIdSchema,
  address: evmAddressSchema,
}).strict());
export type EvmAccountIdentity = z.infer<typeof evmAccountIdentitySchema>;

export const sameEvmAccountIdentity = (
  left: EvmAccountIdentity,
  right: EvmAccountIdentity,
): boolean => left.chainId === right.chainId && left.address === right.address;

export const evmContractIdentitySchema = guardJsonSchema(jsonObject({
  chainId: evmChainIdSchema,
  contractAddress: evmAddressSchema,
}).strict());
export type EvmContractIdentity = z.infer<typeof evmContractIdentitySchema>;

export const parseEvmChainId = (value: unknown): EvmChainId => evmChainIdSchema.parse(value);
export const parseEvmAddress = (value: unknown): EvmAddress => evmAddressSchema.parse(value);
export const parseEvmAccountIdentity = (value: unknown): EvmAccountIdentity =>
  evmAccountIdentitySchema.parse(value);
export const parseEvmContractIdentity = (value: unknown): EvmContractIdentity =>
  evmContractIdentitySchema.parse(value);

export const deriveEip155Reference = (chainIdInput: EvmChainId): string => {
  const chainId = parseEvmChainId(chainIdInput);
  return chainId.slice("eip155:".length);
};

export const deriveCaip10Account = (identityInput: EvmAccountIdentity): string => {
  const identity = parseEvmAccountIdentity(identityInput);
  return `${identity.chainId}:${identity.address}`;
};
