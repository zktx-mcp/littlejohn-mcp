import { deepFreezeValue } from "./immutability.js";
import { keccak256Hex } from "./keccak256.js";
import {
  isCanonicalHexWord32,
  parseEvmAddress,
  parseUnsignedDecimal,
  type EvmAddress,
  type Hash32,
  type HexBytes,
  type UnsignedDecimal,
} from "./primitives.js";

const asciiHex = (value: string): string =>
  "0x" + Array.from(value, (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");

export const erc20TransferSignature = "Transfer(address,address,uint256)" as const;
export const erc20ApprovalSignature = "Approval(address,address,uint256)" as const;
export const erc20TransferTopic0 = keccak256Hex(asciiHex(erc20TransferSignature));
export const erc20ApprovalTopic0 = keccak256Hex(asciiHex(erc20ApprovalSignature));

export type CanonicalErc20Event =
  | {
      readonly kind: "erc20_transfer";
      readonly from: EvmAddress;
      readonly to: EvmAddress;
      readonly amountRaw: UnsignedDecimal;
    }
  | {
      readonly kind: "erc20_approval";
      readonly owner: EvmAddress;
      readonly spender: EvmAddress;
      readonly amountRaw: UnsignedDecimal;
    };

const indexedAddress = (topic: string): EvmAddress | null => {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(topic)) return null;
  try {
    return parseEvmAddress("0x" + topic.slice(26));
  } catch {
    return null;
  }
};

export const decodeCanonicalErc20Event = (
  topics: readonly Hash32[],
  data: HexBytes,
): CanonicalErc20Event | null => {
  if (topics.length !== 3 || !isCanonicalHexWord32(data)) return null;
  const first = indexedAddress(topics[1] ?? "");
  const second = indexedAddress(topics[2] ?? "");
  if (first === null || second === null) return null;
  const amountRaw = parseUnsignedDecimal(BigInt(data).toString(10));
  if (topics[0] === erc20TransferTopic0) {
    return deepFreezeValue({ kind: "erc20_transfer", from: first, to: second, amountRaw });
  }
  if (topics[0] === erc20ApprovalTopic0) {
    return deepFreezeValue({ kind: "erc20_approval", owner: first, spender: second, amountRaw });
  }
  return null;
};
