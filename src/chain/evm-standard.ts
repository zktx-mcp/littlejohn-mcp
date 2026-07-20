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
    readonly functionName:
      | "balanceOf"
      | "balanceOfUI"
      | "decimals"
      | "effectiveAt"
      | "name"
      | "newUIMultiplier"
      | "supportsInterface"
      | "symbol"
      | "tokenAddress"
      | "totalSupply"
      | "uiMultiplier";
    readonly data: string;
  }): unknown;
  encodeEventTopics(input: {
    readonly abi: readonly unknown[];
    readonly eventName: "Approval" | "Transfer";
  }): unknown;
  encodeFunctionData(input: {
    readonly abi: readonly unknown[];
    readonly functionName:
      | "balanceOf"
      | "balanceOfUI"
      | "decimals"
      | "effectiveAt"
      | "name"
      | "newUIMultiplier"
      | "supportsInterface"
      | "symbol"
      | "tokenAddress"
      | "totalSupply"
      | "uiMultiplier";
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

const erc165Abi = Object.freeze([{
  type: "function",
  name: "supportsInterface",
  stateMutability: "view",
  inputs: [{ name: "interfaceId", type: "bytes4" }],
  outputs: [{ name: "", type: "bool" }],
}] as const);

const erc8056Abi = Object.freeze([
  {
    type: "function",
    name: "uiMultiplier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "newUIMultiplier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "effectiveAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOfUI",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const);

const stockFactoryAbi = Object.freeze([{
  type: "function",
  name: "tokenAddress",
  stateMutability: "view",
  inputs: [{ name: "uid", type: "bytes32" }],
  outputs: [{ name: "", type: "address" }],
}] as const);

const canonicalWordPattern = /^0x[0-9a-f]{64}$/u;
const canonicalIndexedAddressWordPattern = /^0x0{24}[0-9a-f]{40}$/u;
const abiWordByteLength = 32;
const abiTextHeaderByteLength = abiWordByteLength * 2;
const abiTextDecodeChunkByteLength = 4 * 1_024;

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

export const decodeErc20TotalSupplyResult = (input: unknown): UnsignedDecimal =>
  decodeErc20BalanceOfResult(input);

export const decodeAbiUint256Result = (input: unknown): UnsignedDecimal =>
  decodeErc20BalanceOfResult(input);

export const decodeAbiBooleanResult = (input: unknown): boolean => {
  const word = exactWord(input);
  if (word !== `0x${"0".repeat(64)}` && word !== `0x${"0".repeat(63)}1`) {
    return invalidStandardEncoding();
  }
  let decoded: unknown;
  try {
    decoded = viemStandard.decodeFunctionResult({
      abi: erc165Abi,
      functionName: "supportsInterface",
      data: word,
    });
  } catch {
    return invalidStandardEncoding();
  }
  if (typeof decoded !== "boolean") return invalidStandardEncoding();
  return decoded;
};

export const decodeAbiAddressResult = (input: unknown): EvmAddress => {
  const word = exactWord(input);
  if (!/^0x0{24}[0-9a-f]{40}$/u.test(word)) return invalidStandardEncoding();
  let decoded: unknown;
  try {
    decoded = viemStandard.decodeFunctionResult({
      abi: stockFactoryAbi,
      functionName: "tokenAddress",
      data: word,
    });
  } catch {
    return invalidStandardEncoding();
  }
  return decodedAddress(decoded);
};

const abiUint256At = (data: HexBytes, byteOffset: number): bigint => {
  const hexOffset = 2 + byteOffset * 2;
  return BigInt(`0x${data.slice(hexOffset, hexOffset + abiWordByteLength * 2)}`);
};

interface CanonicalAbiTextLayout {
  readonly textByteLength: number;
  readonly textHexOffset: number;
}

const canonicalAbiTextLayout = (data: HexBytes): CanonicalAbiTextLayout => {
  const byteLength = (data.length - 2) / 2;
  if (byteLength < abiTextHeaderByteLength || abiUint256At(data, 0) !== 32n) {
    return invalidStandardEncoding();
  }

  const textByteLengthValue = abiUint256At(data, abiWordByteLength);
  const availableByteLength = byteLength - abiTextHeaderByteLength;
  if (textByteLengthValue > BigInt(availableByteLength)) return invalidStandardEncoding();

  const textByteLength = Number(textByteLengthValue);
  const paddedTextByteLength = Math.ceil(textByteLength / abiWordByteLength) * abiWordByteLength;
  if (byteLength !== abiTextHeaderByteLength + paddedTextByteLength) {
    return invalidStandardEncoding();
  }

  const textHexOffset = 2 + abiTextHeaderByteLength * 2;
  const textHexEnd = textHexOffset + textByteLength * 2;
  if (!/^0*$/u.test(data.slice(textHexEnd))) return invalidStandardEncoding();

  return Object.freeze({ textByteLength, textHexOffset });
};

const decodeAbiTextUtf8 = (
  data: HexBytes,
  layout: CanonicalAbiTextLayout,
  retainText: boolean,
): string | undefined => {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let text = "";

  if (layout.textByteLength === 0) return retainText ? decoder.decode() : undefined;

  for (let start = 0; start < layout.textByteLength; start += abiTextDecodeChunkByteLength) {
    const chunkByteLength = Math.min(
      abiTextDecodeChunkByteLength,
      layout.textByteLength - start,
    );
    const chunkHexOffset = layout.textHexOffset + start * 2;
    const bytes = Buffer.from(
      data.slice(chunkHexOffset, chunkHexOffset + chunkByteLength * 2),
      "hex",
    );
    const decoded = decoder.decode(bytes, {
      stream: start + chunkByteLength < layout.textByteLength,
    });
    if (retainText) text += decoded;
  }

  return retainText ? text : undefined;
};

export type Erc20TextDecodeResult =
  | Readonly<{ status: "decoded"; value: string }>
  | Readonly<{ status: "byte_limit_exceeded" }>;

const byteLimitExceeded = Object.freeze({ status: "byte_limit_exceeded" as const });

const decodeCanonicalAbiText = (
  data: HexBytes,
  maximumUtf8Bytes: number,
): Erc20TextDecodeResult => {
  const layout = canonicalAbiTextLayout(data);

  try {
    if (layout.textByteLength > maximumUtf8Bytes) {
      decodeAbiTextUtf8(data, layout, false);
      return byteLimitExceeded;
    }
    const value = decodeAbiTextUtf8(data, layout, true);
    if (value === undefined) return invalidStandardEncoding();
    return Object.freeze({ status: "decoded", value });
  } catch {
    return invalidStandardEncoding();
  }
};

export const decodeErc20TextResult = (
  input: unknown,
  functionName: "name" | "symbol",
  maximumUtf8Bytes: number,
): Erc20TextDecodeResult => {
  if (!Number.isSafeInteger(maximumUtf8Bytes) || maximumUtf8Bytes < 0) {
    throw new TypeError("Maximum ERC-20 text byte length is invalid.");
  }
  const data = parseHexBytes(input);
  const exact = decodeCanonicalAbiText(data, maximumUtf8Bytes);
  if (exact.status === "byte_limit_exceeded") return exact;
  let decoded: unknown;
  try {
    decoded = viemStandard.decodeFunctionResult({
      abi: erc20Abi,
      functionName,
      data,
    });
  } catch {
    return invalidStandardEncoding();
  }
  if (typeof decoded !== "string" || decoded !== exact.value) return invalidStandardEncoding();
  return exact;
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
  name(): HexBytes;
  symbol(): HexBytes;
  totalSupply(): HexBytes;
}

export interface TokenStandardCallEncoder {
  supportsInterface(interfaceId: HexBytes): HexBytes;
  uiMultiplier(): HexBytes;
  newUiMultiplier(): HexBytes;
  effectiveAt(): HexBytes;
  balanceOfUi(account: EvmAddress): HexBytes;
}

export interface StockFactoryCallEncoder {
  tokenAddress(uid: Hash32): HexBytes;
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
  const nameCall = parseEncodedCall(viemStandard.encodeFunctionData({
    abi: erc20Abi,
    functionName: "name",
  }), "0x06fdde03");
  const symbolCall = parseEncodedCall(viemStandard.encodeFunctionData({
    abi: erc20Abi,
    functionName: "symbol",
  }), "0x95d89b41");
  const totalSupplyCall = parseEncodedCall(viemStandard.encodeFunctionData({
    abi: erc20Abi,
    functionName: "totalSupply",
  }), "0x18160ddd");
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
    name(): HexBytes { return nameCall; },
    symbol(): HexBytes { return symbolCall; },
    totalSupply(): HexBytes { return totalSupplyCall; },
  });
};

export const createTokenStandardCallEncoder = (): TokenStandardCallEncoder => {
  const uiMultiplier = parseEncodedCall(viemStandard.encodeFunctionData({
    abi: erc8056Abi,
    functionName: "uiMultiplier",
  }), "0xa60bf13d");
  const newUiMultiplier = parseEncodedCall(viemStandard.encodeFunctionData({
    abi: erc8056Abi,
    functionName: "newUIMultiplier",
  }), "0xdc767007");
  const effectiveAt = parseEncodedCall(viemStandard.encodeFunctionData({
    abi: erc8056Abi,
    functionName: "effectiveAt",
  }), "0x97a4064f");
  return Object.freeze({
    supportsInterface(interfaceIdInput: HexBytes): HexBytes {
      const interfaceId = parseHexBytes(interfaceIdInput);
      if (!/^0x[0-9a-f]{8}$/u.test(interfaceId)) {
        throw new TypeError("Expected a canonical four-byte interface identifier.");
      }
      const expected = `0x01ffc9a7${interfaceId.slice(2).padEnd(64, "0")}`;
      return parseEncodedCall(viemStandard.encodeFunctionData({
        abi: erc165Abi,
        functionName: "supportsInterface",
        args: [interfaceId],
      }), expected);
    },
    uiMultiplier(): HexBytes { return uiMultiplier; },
    newUiMultiplier(): HexBytes { return newUiMultiplier; },
    effectiveAt(): HexBytes { return effectiveAt; },
    balanceOfUi(accountInput: EvmAddress): HexBytes {
      const account = parseEvmAddress(accountInput);
      const expected = `0x437a9958${account.slice(2).padStart(64, "0")}`;
      return parseEncodedCall(viemStandard.encodeFunctionData({
        abi: erc8056Abi,
        functionName: "balanceOfUI",
        args: [account],
      }), expected);
    },
  });
};

export const createStockFactoryCallEncoder = (): StockFactoryCallEncoder => Object.freeze({
  tokenAddress(uidInput: Hash32): HexBytes {
    const uid = parseHash32(uidInput);
    return parseEncodedCall(viemStandard.encodeFunctionData({
      abi: stockFactoryAbi,
      functionName: "tokenAddress",
      args: [uid],
    }), `0x97bb3ce9${uid.slice(2)}`);
  },
});
