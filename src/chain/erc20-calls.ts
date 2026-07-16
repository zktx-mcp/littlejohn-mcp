import { parseEvmAddress, parseHexBytes, type EvmAddress, type HexBytes } from "../core/index.js";
import chainExternalModulesValue from "./external-modules.cjs";

const chainExternalModules = chainExternalModulesValue as unknown as Readonly<{
  loadViemUtilitiesModule(): Promise<unknown>;
}>;

type EncodeFunctionData = (input: {
  readonly abi: readonly unknown[];
  readonly functionName: string;
  readonly args?: readonly unknown[];
}) => unknown;

const balanceOfAbi = Object.freeze([Object.freeze({
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: Object.freeze([Object.freeze({ name: "account", type: "address" })]),
  outputs: Object.freeze([Object.freeze({ name: "", type: "uint256" })]),
})]);

const decimalsAbi = Object.freeze([Object.freeze({
  type: "function",
  name: "decimals",
  stateMutability: "view",
  inputs: Object.freeze([]),
  outputs: Object.freeze([Object.freeze({ name: "", type: "uint8" })]),
})]);

export interface Erc20CallEncoder {
  balanceOf(account: EvmAddress): HexBytes;
  decimals(): HexBytes;
}

const captureEncoder = (moduleValue: unknown): EncodeFunctionData => {
  if (typeof moduleValue !== "object" || moduleValue === null) {
    throw new TypeError("Viem utility module is invalid.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(moduleValue, "encodeFunctionData");
  if (descriptor === undefined) {
    throw new TypeError("Viem function encoder is unavailable.");
  }
  let value: unknown;
  try {
    value = "value" in descriptor
      ? descriptor.value
      : descriptor.get !== undefined && descriptor.set === undefined
        ? Reflect.get(moduleValue, "encodeFunctionData")
        : undefined;
  } catch {
    throw new TypeError("Viem function encoder is unavailable.");
  }
  if (typeof value !== "function") throw new TypeError("Viem function encoder is unavailable.");
  return value as EncodeFunctionData;
};

const parseEncodedCall = (value: unknown, expected: string): HexBytes => {
  const parsed = parseHexBytes(value);
  if (parsed !== expected) throw new TypeError("Viem produced an unexpected ERC-20 call encoding.");
  return parsed;
};

export const createErc20CallEncoder = async (
  loadModule: () => Promise<unknown> = chainExternalModules.loadViemUtilitiesModule,
): Promise<Erc20CallEncoder> => {
  if (typeof loadModule !== "function") throw new TypeError("Viem module loader is invalid.");
  const encodeFunctionData = captureEncoder(await loadModule());
  const decimalsCall = parseEncodedCall(encodeFunctionData({
    abi: decimalsAbi,
    functionName: "decimals",
  }), "0x313ce567");
  return Object.freeze({
    balanceOf(accountInput: EvmAddress): HexBytes {
      const account = parseEvmAddress(accountInput);
      const expected = `0x70a08231${account.slice(2).padStart(64, "0")}`;
      return parseEncodedCall(encodeFunctionData({
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: [account],
      }), expected);
    },
    decimals(): HexBytes { return decimalsCall; },
  });
};
