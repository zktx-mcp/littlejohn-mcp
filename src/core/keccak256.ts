import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const canonicalHexBytesPattern = /^0x(?:[0-9a-f]{2})*$/u;

const keccak256Bytes = (bytes: Uint8Array): string => `0x${bytesToHex(keccak_256(bytes))}`;

export const keccak256FromHex = (hexBytes: string): string => {
  if (!canonicalHexBytesPattern.test(hexBytes)) {
    throw new TypeError("Expected canonical hexadecimal bytes.");
  }
  return keccak256Bytes(hexToBytes(hexBytes.slice(2)));
};

export const keccak256FromUtf8 = (text: string): string => {
  if (typeof text !== "string") throw new TypeError("Expected UTF-8 text.");
  return keccak256Bytes(utf8ToBytes(text));
};
