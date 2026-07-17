import {
  deepFreezeValue,
  maximumTokenDecimals,
  parseEvmAddress,
  parseHash32,
  parseHexBytes,
  parseUnsignedDecimal,
  type EvmAddress,
  type Hash32,
  type HexBytes,
  type UnsignedDecimal,
} from "../core/index.js";
import viemStandardValue from "./viem-standard.cjs";

type ViemStandardModule = Readonly<{
  decodeEventLog(input: {
    readonly abi: readonly unknown[];
    readonly eventName: "Approval" | "Transfer";
    readonly topics: readonly string[];
    readonly data: string;
    readonly strict: true;
  }): unknown;
  decodeFunctionResult(input: {
    readonly abi: readonly unknown[];
    readonly functionName: "balanceOf" | "decimals";
    readonly data: string;
  }): unknown;
  encodeEventTopics(input: {
    readonly abi: readonly unknown[];
    readonly eventName: "Approval" | "Transfer";
  }): unknown;
  encodeFunctionData(input: {
    readonly abi: readonly unknown[];
    readonly functionName: "balanceOf" | "decimals";
    readonly args?: readonly unknown[];
  }): unknown;
  readonly erc20Abi: unknown;
  keccak256(input: string): unknown;
}>;

const viemStandard = viemStandardValue as unknown as ViemStandardModule;
if (!Array.isArray(viemStandard.erc20Abi)) {
  throw new TypeError("Viem ERC-20 ABI is unavailable.");
}
const erc20Abi: readonly unknown[] = viemStandard.erc20Abi;

const canonicalWordPattern = /^0x[0-9a-f]{64}$/u;
const canonicalIndexedAddressWordPattern = /^0x0{24}[0-9a-f]{40}$/u;

const invalidStandardEncoding = (): never => {
  throw new TypeError("Invalid standard EVM encoding.");
};

const eventTopic0 = (eventName: "Approval" | "Transfer"): Hash32 => {
  const encoded = viemStandard.encodeEventTopics({ abi: erc20Abi, eventName });
  if (!Array.isArray(encoded) || encoded.length !== 1) return invalidStandardEncoding();
  return parseHash32(encoded[0]);
};

const transferTopic0 = eventTopic0("Transfer");
const approvalTopic0 = eventTopic0("Approval");

const eventArguments = (
  input: unknown,
  eventName: "Approval" | "Transfer",
): Readonly<Record<string, unknown>> => {
  if (typeof input !== "object" || input === null) return invalidStandardEncoding();
  const decoded = input as Readonly<Record<string, unknown>>;
  if (decoded["eventName"] !== eventName) return invalidStandardEncoding();
  const args = decoded["args"];
  if (typeof args !== "object" || args === null || Array.isArray(args)) return invalidStandardEncoding();
  return args as Readonly<Record<string, unknown>>;
};

const exactWord = (input: unknown): HexBytes => {
  const word = parseHexBytes(input);
  if (!canonicalWordPattern.test(word)) return invalidStandardEncoding();
  return word;
};

const decodedAddress = (input: unknown): EvmAddress => {
  if (typeof input !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(input)) {
    return invalidStandardEncoding();
  }
  return parseEvmAddress(input.toLowerCase());
};

const decodedUint256 = (input: unknown): UnsignedDecimal => {
  if (typeof input !== "bigint" || input < 0n || input >= (1n << 256n)) {
    return invalidStandardEncoding();
  }
  return parseUnsignedDecimal(input.toString(10));
};

const indexedAddressWord = (address: EvmAddress): Hash32 =>
  `0x${"0".repeat(24)}${address.slice(2)}` as Hash32;

const uint256Word = (value: UnsignedDecimal): HexBytes =>
  `0x${BigInt(value).toString(16).padStart(64, "0")}` as HexBytes;

export const hashEvmBytes = (input: HexBytes): Hash32 =>
  parseHash32(viemStandard.keccak256(parseHexBytes(input)));

export const decodeErc20BalanceOfResult = (input: unknown): UnsignedDecimal => {
  const word = exactWord(input);
  let decoded: unknown;
  try {
    decoded = viemStandard.decodeFunctionResult({
      abi: erc20Abi,
      functionName: "balanceOf",
      data: word,
    });
  } catch {
    return invalidStandardEncoding();
  }
  return decodedUint256(decoded);
};

export const decodeErc20DecimalsResult = (input: unknown): UnsignedDecimal => {
  const word = exactWord(input);
  if (!/^0x0{62}[0-9a-f]{2}$/u.test(word)) return invalidStandardEncoding();
  let decoded: unknown;
  try {
    decoded = viemStandard.decodeFunctionResult({
      abi: erc20Abi,
      functionName: "decimals",
      data: word,
    });
  } catch {
    return invalidStandardEncoding();
  }
  if (!Number.isInteger(decoded) || typeof decoded !== "number" || decoded < 0 || decoded > maximumTokenDecimals) {
    return invalidStandardEncoding();
  }
  return parseUnsignedDecimal(String(decoded));
};

export type DecodedCanonicalErc20Event =
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

export const decodeCanonicalErc20Event = (
  topics: readonly Hash32[],
  data: HexBytes,
): DecodedCanonicalErc20Event | null => {
  if (
    topics.length !== 3 ||
    !canonicalIndexedAddressWordPattern.test(topics[1] ?? "") ||
    !canonicalIndexedAddressWordPattern.test(topics[2] ?? "") ||
    !canonicalWordPattern.test(data)
  ) return null;
  const topic0 = topics[0];
  if (topic0 !== transferTopic0 && topic0 !== approvalTopic0) return null;
  const viemTopics = [topic0, topics[1] as Hash32, topics[2] as Hash32];
  try {
    if (topic0 === transferTopic0) {
      const decoded = viemStandard.decodeEventLog({
        abi: erc20Abi,
        eventName: "Transfer",
        topics: viemTopics,
        data,
        strict: true,
      });
      const args = eventArguments(decoded, "Transfer");
      const from = decodedAddress(args["from"]);
      const to = decodedAddress(args["to"]);
      const amountRaw = decodedUint256(args["value"]);
      if (
        topics[1] !== indexedAddressWord(from) ||
        topics[2] !== indexedAddressWord(to) ||
        data !== uint256Word(amountRaw)
      ) return null;
      return deepFreezeValue({ kind: "erc20_transfer", from, to, amountRaw });
    }
    const decoded = viemStandard.decodeEventLog({
      abi: erc20Abi,
      eventName: "Approval",
      topics: viemTopics,
      data,
      strict: true,
    });
    const args = eventArguments(decoded, "Approval");
    const owner = decodedAddress(args["owner"]);
    const spender = decodedAddress(args["spender"]);
    const amountRaw = decodedUint256(args["value"]);
    if (
      topics[1] !== indexedAddressWord(owner) ||
      topics[2] !== indexedAddressWord(spender) ||
      data !== uint256Word(amountRaw)
    ) return null;
    return deepFreezeValue({ kind: "erc20_approval", owner, spender, amountRaw });
  } catch {
    return null;
  }
};

export interface Erc20CallEncoder {
  balanceOf(account: EvmAddress): HexBytes;
  decimals(): HexBytes;
}

const parseEncodedCall = (value: unknown, expected: string): HexBytes => {
  const parsed = parseHexBytes(value);
  if (parsed !== expected) throw new TypeError("Viem produced an unexpected ERC-20 call encoding.");
  return parsed;
};

export const createErc20CallEncoder = async (): Promise<Erc20CallEncoder> => {
  const decimalsCall = parseEncodedCall(viemStandard.encodeFunctionData({
    abi: erc20Abi,
    functionName: "decimals",
  }), "0x313ce567");
  return Object.freeze({
    balanceOf(accountInput: EvmAddress): HexBytes {
      const account = parseEvmAddress(accountInput);
      const expected = `0x70a08231${account.slice(2).padStart(64, "0")}`;
      return parseEncodedCall(viemStandard.encodeFunctionData({
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      }), expected);
    },
    decimals(): HexBytes { return decimalsCall; },
  });
};
