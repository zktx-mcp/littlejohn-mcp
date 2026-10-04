import {isCanonicalHexWord32, type Hash32, type HexBytes, type UnsignedDecimal} from "../core/client.js";
import {type EvmAddress} from "./identities.js";

export const erc20TransferTopic0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
export const erc20ApprovalTopic0 =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925" as const;

export type CanonicalErc20EventEvidence =
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

export type CanonicalErc20EventKind = CanonicalErc20EventEvidence["kind"];

const canonicalIndexedAddressWordPattern = /^0x0{24}[0-9a-f]{40}$/u;

const indexedAddressWord = (address: EvmAddress): Hash32 =>
  `0x${"0".repeat(24)}${address.slice(2)}` as Hash32;

const uint256Word = (value: UnsignedDecimal): HexBytes | null => {
  const hexadecimal = BigInt(value).toString(16);
  return hexadecimal.length <= 64
    ? `0x${hexadecimal.padStart(64, "0")}` as HexBytes
    : null;
};

export const canonicalErc20EventEncodingKind = (
  topics: readonly Hash32[],
  data: HexBytes,
): CanonicalErc20EventKind | null => {
  if (
    topics.length !== 3 ||
    !canonicalIndexedAddressWordPattern.test(topics[1] ?? "") ||
    !canonicalIndexedAddressWordPattern.test(topics[2] ?? "") ||
    !isCanonicalHexWord32(data)
  ) return null;
  if (topics[0] === erc20TransferTopic0) return "erc20_transfer";
  if (topics[0] === erc20ApprovalTopic0) return "erc20_approval";
  return null;
};

export const matchesCanonicalErc20EventEvidence = (
  topics: readonly Hash32[],
  data: HexBytes,
  event: CanonicalErc20EventEvidence,
): boolean => {
  if (canonicalErc20EventEncodingKind(topics, data) !== event.kind) return false;
  const amountWord = uint256Word(event.amountRaw);
  if (amountWord === null || data !== amountWord) return false;
  if (event.kind === "erc20_transfer") {
    return topics[1] === indexedAddressWord(event.from) && topics[2] === indexedAddressWord(event.to);
  }
  return topics[1] === indexedAddressWord(event.owner) && topics[2] === indexedAddressWord(event.spender);
};
