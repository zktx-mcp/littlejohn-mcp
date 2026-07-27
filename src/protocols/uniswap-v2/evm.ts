import {
  evmAddressSchema,
  parseHexBytes,
  type EvmAddress,
  type HexBytes,
} from "../../core/index.js";

const functionSelectors = Object.freeze({
  getPair: "e6a43905",
  factory: "c45a0155",
  token0: "0dfe1681",
  token1: "d21220a7",
  getReserves: "0902f1ac",
});

const addressWord = (addressInput: EvmAddress): string => {
  const address = evmAddressSchema.parse(addressInput);
  return `${"0".repeat(24)}${address.slice(2)}`;
};

const exactWords = (input: HexBytes, count: number): readonly string[] => {
  const value = parseHexBytes(input);
  if (value.length !== 2 + count * 64) {
    throw new TypeError("V2 ABI result has an unexpected byte length.");
  }
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      value.slice(2 + index * 64, 2 + (index + 1) * 64)),
  );
};

const decodeAddressWord = (word: string): EvmAddress => {
  if (!/^0{24}[0-9a-f]{40}$/u.test(word)) {
    throw new TypeError("V2 ABI address result is not canonical.");
  }
  return evmAddressSchema.parse(`0x${word.slice(24)}`);
};

const decodeBoundedWord = (
  word: string,
  maximum: bigint,
  label: string,
): bigint => {
  if (!/^[0-9a-f]{64}$/u.test(word)) {
    throw new TypeError(`${label} ABI result is not canonical.`);
  }
  const value = BigInt(`0x${word}`);
  if (value > maximum) throw new TypeError(`${label} ABI result is out of range.`);
  return value;
};

export const uniswapV2Evm = Object.freeze({
  getPair(tokenA: EvmAddress, tokenB: EvmAddress): HexBytes {
    return parseHexBytes(
      `0x${functionSelectors.getPair}${addressWord(tokenA)}${addressWord(tokenB)}`,
    );
  },
  factory(): HexBytes {
    return parseHexBytes(`0x${functionSelectors.factory}`);
  },
  token0(): HexBytes {
    return parseHexBytes(`0x${functionSelectors.token0}`);
  },
  token1(): HexBytes {
    return parseHexBytes(`0x${functionSelectors.token1}`);
  },
  reserves(): HexBytes {
    return parseHexBytes(`0x${functionSelectors.getReserves}`);
  },
  decodePair(input: HexBytes): EvmAddress {
    return decodeAddressWord(exactWords(input, 1)[0] ?? "");
  },
  decodeFactory(input: HexBytes): EvmAddress {
    return decodeAddressWord(exactWords(input, 1)[0] ?? "");
  },
  decodeToken0(input: HexBytes): EvmAddress {
    return decodeAddressWord(exactWords(input, 1)[0] ?? "");
  },
  decodeToken1(input: HexBytes): EvmAddress {
    return decodeAddressWord(exactWords(input, 1)[0] ?? "");
  },
  decodeReserves(input: HexBytes): Readonly<{
    readonly reserve0: bigint;
    readonly reserve1: bigint;
  }> {
    const words = exactWords(input, 3);
    const reserve0 = decodeBoundedWord(
      words[0] ?? "",
      (1n << 112n) - 1n,
      "V2 reserve0",
    );
    const reserve1 = decodeBoundedWord(
      words[1] ?? "",
      (1n << 112n) - 1n,
      "V2 reserve1",
    );
    decodeBoundedWord(
      words[2] ?? "",
      (1n << 32n) - 1n,
      "V2 reserve timestamp",
    );
    return Object.freeze({ reserve0, reserve1 });
  },
});
