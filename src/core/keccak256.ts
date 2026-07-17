import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const canonicalHexBytesPattern = /^0x(?:[0-9a-f]{2})*$/u;

export const keccak256Hex = (hexBytes: string): string => {
  if (!canonicalHexBytesPattern.test(hexBytes)) {
    throw new TypeError("Expected canonical hexadecimal bytes.");
  }
  const bytes = hexToBytes(hexBytes.slice(2));
  return `0x${bytesToHex(keccak_256(bytes))}`;
};
