import {z} from "zod";

import {parseEvmAccountIdentity, parseEvmChainId, type EvmAccountIdentity, type EvmAddress} from "./identities.js";
import {keccak256FromUtf8} from "./keccak256.js";

const evmAddressInputPattern = /^0x[0-9A-Fa-f]{40}$/u;

const checksummedAddress = (body: string): string => {
  const lowercase = body.toLowerCase();
  const hash = keccak256FromUtf8(lowercase).slice(2);
  let output = "";
  for (let index = 0; index < lowercase.length; index += 1) {
    const character = lowercase[index] as string;
    output += character >= "a" && character <= "f" && Number.parseInt(hash[index] as string, 16) >= 8
      ? character.toUpperCase()
      : character;
  }
  return output;
};

const hasValidEvmAddressChecksum = (value: string): boolean => {
  const body = value.slice(2);
  const lowercase = body.toLowerCase();
  const uppercase = body.toUpperCase();
  return body === lowercase || body === uppercase || body === checksummedAddress(body);
};

export const evmAddressInputSchema = z.string()
  .regex(evmAddressInputPattern, "Expected an EVM address with a lowercase 0x prefix.")
  .refine(hasValidEvmAddressChecksum, "Expected a valid EIP-55 address checksum.")
  .overwrite((value) => `0x${value.slice(2).toLowerCase()}`)
  .brand("EvmAddress");

export const parseEvmAddressInput = (value: unknown): EvmAddress => evmAddressInputSchema.parse(value);

export const parseCaip10EvmAccount = (value: unknown): EvmAccountIdentity => {
  if (typeof value !== "string") throw new TypeError("Expected a CAIP-10 EVM account identifier.");
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new TypeError("Expected a CAIP-10 EVM account identifier.");
  }
  try {
    return parseEvmAccountIdentity({
      chainId: parseEvmChainId(value.slice(0, separator)),
      address: parseEvmAddressInput(value.slice(separator + 1)),
    });
  } catch {
    throw new TypeError("Expected a CAIP-10 EVM account identifier.");
  }
};
