import {canonicalErc20EventEncodingKind, matchesCanonicalErc20EventEvidence, type CanonicalErc20EventEvidence} from "../evm/erc20-events.js";
import {isCanonicalHexWord32, deepFreezeValue, parseHash32, parseHexBytes, parseUnsignedDecimal, type Hash32, type HexBytes, type UnsignedDecimal} from "../core/index.js";
import {maximumTokenDecimals} from "../evm/amounts.js";
import {parseEvmAddress, type EvmAddress} from "../evm/identities.js";
import * as viemStandardNamespace from "./viem-standard.cjs";
import type { SigningCodec } from "./signing-port.js";

type ViemStandardModule = Readonly<{
  encodeAbiParameters(parameters: readonly unknown[], values: readonly unknown[]): unknown;
  decodeAbiParameters(
    parameters: readonly unknown[],
    data: string,
  ): unknown;
  decodeEventLog(input: {
    readonly abi: readonly unknown[];
    readonly eventName: "Approval" | "Transfer";
    readonly topics: readonly string[];
    readonly data: string;
    readonly strict: true;
  }): unknown;
  decodeFunctionResult(input: {
    readonly abi: readonly unknown[];
    readonly functionName: string;
    readonly data: string;
  }): unknown;
  encodeFunctionData(input: {
    readonly abi: readonly unknown[];
    readonly functionName: string;
    readonly args?: readonly unknown[];
  }): unknown;
  readonly erc20Abi: unknown;
  keccak256(input: string): unknown;
  hashMessage(input: { raw: string }): unknown;
  hashTypedData(input: Parameters<SigningCodec["hashTypedData"]>[0]): unknown;
  recoverAddress(input: { hash: string; signature: string }): Promise<unknown>;
}>;

const viemStandard = (
  viemStandardNamespace as unknown as Readonly<{ readonly default: unknown }>
).default as ViemStandardModule;
if (typeof viemStandard.decodeAbiParameters !== "function") {
  throw new TypeError("Viem ABI parameter decoder is unavailable.");
}
if (!Array.isArray(viemStandard.erc20Abi)) {
  throw new TypeError("Viem ERC-20 ABI is unavailable.");
}
const erc20Abi: readonly unknown[] = viemStandard.erc20Abi;

export const createSigningCodec = (): SigningCodec => Object.freeze({
  hashMessage: (bytes) => parseHash32(viemStandard.hashMessage({ raw: parseHexBytes(bytes) })),
  hashTypedData: (input) => parseHash32(viemStandard.hashTypedData(input)),
  async recoverAddress(hash, signature) {
    const address = await viemStandard.recoverAddress({ hash: parseHash32(hash), signature });
    if (typeof address !== "string") throw new TypeError("Invalid recovered address.");
    return parseEvmAddress(address.toLowerCase());
  },
} satisfies SigningCodec);

export interface EvmAbiCodec {
  encodeParameters(parameters: readonly unknown[], values: readonly unknown[]): HexBytes;
  decodeParameters(parameters: readonly unknown[], data: HexBytes): readonly unknown[];
  encodeFunction(abi: readonly unknown[], functionName: string, args: readonly unknown[]): HexBytes;
  encodeErc20(functionName: "approve" | "allowance", args: readonly unknown[]): HexBytes;
}

export const createEvmAbiCodec = (): EvmAbiCodec => Object.freeze({
  encodeParameters(parameters: readonly unknown[], values: readonly unknown[]): HexBytes {
    return parseHexBytes(viemStandard.encodeAbiParameters(parameters, values));
  },
  decodeParameters(parameters: readonly unknown[], data: HexBytes): readonly unknown[] {
    const original = parseHexBytes(data);
    const decoded = viemStandard.decodeAbiParameters(parameters, original);
    if (!Array.isArray(decoded) ||
        parseHexBytes(viemStandard.encodeAbiParameters(parameters, decoded)) !== original) {
      throw new TypeError("ABI parameters are not canonical.");
    }
    return Object.freeze(decoded);
  },
  encodeFunction(abi: readonly unknown[], functionName: string, args: readonly unknown[]): HexBytes {
    return parseHexBytes(viemStandard.encodeFunctionData({ abi, functionName, args }));
  },
  encodeErc20(functionName: "approve" | "allowance", args: readonly unknown[]): HexBytes {
    return parseHexBytes(viemStandard.encodeFunctionData({ abi: erc20Abi, functionName, args }));
  },
});

const eip1967StorageSlot = (name: "implementation" | "beacon" | "admin"): Hash32 => {
  const label = `eip1967.proxy.${name}`;
  const encoded = `0x${Buffer.from(label, "utf8").toString("hex")}`;
  const hash = parseHash32(viemStandard.keccak256(encoded));
  return parseHash32(`0x${(BigInt(hash) - 1n).toString(16).padStart(64, "0")}`);
};

export const eip1967StorageSlots = deepFreezeValue({
  implementation: eip1967StorageSlot("implementation"),
  beacon: eip1967StorageSlot("beacon"),
  admin: eip1967StorageSlot("admin"),
});

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

const contractAnalysisAbi = Object.freeze([
  {
    type: "function",
    name: "implementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "DEFAULT_ADMIN_ROLE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getRoleMemberCount",
    stateMutability: "view",
    inputs: [{ name: "role", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getRoleMember",
    stateMutability: "view",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const);

const abiWordByteLength = 32;
const abiTextHeaderByteLength = abiWordByteLength * 2;
const abiTextDecodeChunkByteLength = 4 * 1_024;

const invalidStandardEncoding = (): never => {
  throw new TypeError("Invalid standard EVM encoding.");
};

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
  if (!isCanonicalHexWord32(word)) return invalidStandardEncoding();
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

const uint256Word = (value: UnsignedDecimal): HexBytes =>
  `0x${BigInt(value).toString(16).padStart(64, "0")}` as HexBytes;

export const hashEvmBytes = (input: HexBytes): Hash32 =>
  parseHash32(viemStandard.keccak256(parseHexBytes(input)));

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

const decodeAbiScalar = (
  word: HexBytes,
  type: "uint256" | "bool" | "address",
): unknown => {
  let decoded: unknown;
  try {
    decoded = viemStandard.decodeAbiParameters([{ type }], word);
  } catch {
    return invalidStandardEncoding();
  }
  if (!Array.isArray(decoded) || decoded.length !== 1) return invalidStandardEncoding();
  return decoded[0];
};

export const decodeAbiUint256Result = (input: unknown): UnsignedDecimal =>
  decodedUint256(decodeAbiScalar(exactWord(input), "uint256"));

export const decodeAbiBooleanResult = (input: unknown): boolean => {
  const word = exactWord(input);
  if (word !== `0x${"0".repeat(64)}` && word !== `0x${"0".repeat(63)}1`) {
    return invalidStandardEncoding();
  }
  const decoded = decodeAbiScalar(word, "bool");
  if (typeof decoded !== "boolean") return invalidStandardEncoding();
  return decoded;
};

export const decodeAbiAddressResult = (input: unknown): EvmAddress => {
  const word = exactWord(input);
  if (!/^0x0{24}[0-9a-f]{40}$/u.test(word)) return invalidStandardEncoding();
  return decodedAddress(decodeAbiScalar(word, "address"));
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

export const decodeCanonicalErc20Event = (
  topics: readonly Hash32[],
  data: HexBytes,
): CanonicalErc20EventEvidence | null => {
  const kind = canonicalErc20EventEncodingKind(topics, data);
  if (kind === null) return null;
  try {
    const eventName = kind === "erc20_transfer" ? "Transfer" : "Approval";
    const args = eventArguments(viemStandard.decodeEventLog({
      abi: erc20Abi,
      eventName,
      topics,
      data,
      strict: true,
    }), eventName);
    const amountRaw = decodedUint256(args["value"]);
    const event: CanonicalErc20EventEvidence = kind === "erc20_transfer"
      ? { kind, from: decodedAddress(args["from"]), to: decodedAddress(args["to"]), amountRaw }
      : { kind, owner: decodedAddress(args["owner"]), spender: decodedAddress(args["spender"]), amountRaw };
    return matchesCanonicalErc20EventEvidence(topics, data, event)
      ? deepFreezeValue(event)
      : null;
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

export interface ContractAnalysisCallEncoder {
  beaconImplementation(): HexBytes;
  owner(): HexBytes;
  paused(): HexBytes;
  defaultAdminRole(): HexBytes;
  defaultAdminMemberCount(role: HexBytes): HexBytes;
  defaultAdminMember(role: HexBytes, index: UnsignedDecimal): HexBytes;
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

export const createContractAnalysisCallEncoder = (): ContractAnalysisCallEncoder => {
  const beaconImplementation = parseEncodedCall(viemStandard.encodeFunctionData({
    abi: contractAnalysisAbi,
    functionName: "implementation",
  }), "0x5c60da1b");
  const owner = parseEncodedCall(viemStandard.encodeFunctionData({
    abi: contractAnalysisAbi,
    functionName: "owner",
  }), "0x8da5cb5b");
  const paused = parseEncodedCall(viemStandard.encodeFunctionData({
    abi: contractAnalysisAbi,
    functionName: "paused",
  }), "0x5c975abb");
  const defaultAdminRole = parseEncodedCall(viemStandard.encodeFunctionData({
    abi: contractAnalysisAbi,
    functionName: "DEFAULT_ADMIN_ROLE",
  }), "0xa217fddf");
  return Object.freeze({
    beaconImplementation(): HexBytes { return beaconImplementation; },
    owner(): HexBytes { return owner; },
    paused(): HexBytes { return paused; },
    defaultAdminRole(): HexBytes { return defaultAdminRole; },
    defaultAdminMemberCount(roleInput: HexBytes): HexBytes {
      const role = parseHexBytes(roleInput);
      if (!isCanonicalHexWord32(role)) throw new TypeError("Default-administrator role is invalid.");
      return parseEncodedCall(viemStandard.encodeFunctionData({
        abi: contractAnalysisAbi,
        functionName: "getRoleMemberCount",
        args: [role],
      }), `0xca15c873${role.slice(2)}`);
    },
    defaultAdminMember(roleInput: HexBytes, indexInput: UnsignedDecimal): HexBytes {
      const role = parseHexBytes(roleInput);
      if (!isCanonicalHexWord32(role)) throw new TypeError("Default-administrator role is invalid.");
      const index = parseUnsignedDecimal(indexInput);
      return parseEncodedCall(viemStandard.encodeFunctionData({
        abi: contractAnalysisAbi,
        functionName: "getRoleMember",
        args: [role, BigInt(index)],
      }), `0x9010d07c${role.slice(2)}${uint256Word(index).slice(2)}`);
    },
  });
};
