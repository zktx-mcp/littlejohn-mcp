import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  blockSelectorToRpcTag,
  normalizeAbiDecimals,
  normalizeAbiUint256,
  normalizeIncludedTransaction,
  normalizeRpcAccessList,
  normalizeRpcAddress,
  normalizeRpcBlockAnchor,
  normalizeRpcHash,
  normalizeRpcReceipt,
  normalizeRpcRuntimeCode,
  normalizeRpcTransaction,
  parseRpcQuantity,
  rpcQuantityToUnsignedDecimal,
  unsignedDecimalToRpcQuantity,
} from "../../src/chain/normalization.js";
import { erc20TransferTopic0, parseUnsignedDecimal } from "../../src/core/index.js";

const addressA = `0x${"a".repeat(40)}`;
const addressB = `0x${"b".repeat(40)}`;
const transactionHash = `0x${"c".repeat(64)}`;
const blockHash = `0x${"d".repeat(64)}`;
const topicAddress = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const hexCharacter = fc.constantFrom(..."0123456789abcdef");
const fixedHex = (length: number) => fc.array(hexCharacter, {
  minLength: length,
  maxLength: length,
}).map((characters) => characters.join(""));
const accessListEntryArbitrary = fc.record({
  address: fixedHex(40).map((value) => `0x${value}`),
  storageKeys: fc.array(fixedHex(64).map((value) => `0x${value}`), { maxLength: 8 }),
});

const includedTransaction = () => ({
  hash: transactionHash.toUpperCase().replace("0X", "0x"),
  from: addressA.toUpperCase().replace("0X", "0x"),
  to: addressB,
  value: "0x20000000000001",
  input: "0xAABB",
  nonce: "0x0",
  gas: "0x5208",
  type: "0x2",
  chainId: "0x1237",
  maxFeePerGas: "0x20000000000001",
  maxPriorityFeePerGas: "0x1",
  accessList: [],
  blockNumber: "0x20000000000001",
  blockHash,
  transactionIndex: "0x3",
});

const legacyIncludedTransaction = () => ({
  hash: transactionHash,
  from: addressA,
  to: addressB,
  value: "0x20000000000001",
  input: "0xAABB",
  nonce: "0x0",
  gas: "0x5208",
  type: "0x0",
  gasPrice: "0x2",
  blockNumber: "0x20000000000001",
  blockHash,
  transactionIndex: "0x3",
});

const receiptLog = (logIndex = "0x0") => ({
  address: addressB,
  topics: [erc20TransferTopic0, topicAddress(addressA), topicAddress(addressB)],
  data: word(9_007_199_254_740_993n),
  logIndex,
  transactionIndex: "0x3",
  transactionHash,
  blockNumber: "0x20000000000001",
  blockHash,
  removed: false,
});

const receipt = (logs: unknown[] = [receiptLog()]) => ({
  transactionHash,
  from: addressA,
  to: addressB,
  type: "0x2",
  transactionIndex: "0x3",
  blockNumber: "0x20000000000001",
  blockHash,
  status: "0x1",
  cumulativeGasUsed: "0x20000000000001",
  gasUsed: "0x5208",
  effectiveGasPrice: "0x20000000000001",
  contractAddress: null,
  logs,
});

const block = () => ({
  number: "0x20000000000001",
  hash: blockHash,
  timestamp: "0x65920080",
  transactions: [
    `0x${"1".repeat(64)}`,
    `0x${"2".repeat(64)}`,
    `0x${"3".repeat(64)}`,
    transactionHash,
  ],
});

describe("RPC normalization", () => {
  it("round-trips canonical quantities without Number conversion", () => {
    const value = (1n << 255n) + 9_007_199_254_740_993n;
    const hex = `0x${value.toString(16)}`;
    expect(parseRpcQuantity(hex)).toBe(value);
    expect(rpcQuantityToUnsignedDecimal(hex)).toBe(value.toString(10));
    expect(unsignedDecimalToRpcQuantity(value.toString(10))).toBe(hex);
    for (const malformed of ["0x", "0x00", "0X1", "1", "-0x1", `0x1${"0".repeat(64)}`]) {
      expect(() => parseRpcQuantity(malformed)).toThrow(TypeError);
    }
  });

  it("canonicalizes identities, block selectors, timestamps, and runtime code", () => {
    expect(normalizeRpcAddress(addressA.toUpperCase().replace("0X", "0x"))).toBe(addressA);
    expect(normalizeRpcHash(blockHash.toUpperCase().replace("0X", "0x"))).toBe(blockHash);
    expect(blockSelectorToRpcTag({ kind: "latest" })).toBe("latest");
    expect(blockSelectorToRpcTag({ kind: "number", blockNumber: "9007199254740993" })).toBe("0x20000000000001");
    expect(normalizeRpcBlockAnchor(block())).toEqual({
      chainId: "4663",
      blockNumber: "9007199254740993",
      blockHash,
      blockTimestamp: "2024-01-01T00:00:00.000Z",
    });
    expect(normalizeRpcRuntimeCode("0x")).toEqual({ status: "empty" });
    expect(normalizeRpcRuntimeCode("0xAABB")).toEqual({
      status: "present",
      bytecode: "0xaabb",
      byteLength: "2",
      codeHash: "0x65b043cdd93fde12ee6629de2d9ce786ba7d5b4c514afecea4d1b4b2c740087c",
    });
    expect(() => normalizeRpcRuntimeCode(`0x${"00".repeat(262_145)}`)).toThrow(TypeError);
  });

  it("decodes only exact ABI words and bounded decimals", () => {
    expect(normalizeAbiUint256(word(9_007_199_254_740_993n))).toBe("9007199254740993");
    expect(normalizeAbiDecimals(word(255n))).toBe("255");
    expect(() => normalizeAbiDecimals(word(256n))).toThrow(TypeError);
    expect(() => normalizeAbiUint256("0x01")).toThrow(TypeError);
    expect(() => normalizeAbiUint256(`${word(1n)}${word(2n).slice(2)}`)).toThrow(TypeError);
  });

  it("normalizes transaction fees and preserves the exact access-list sequence and multiplicity", () => {
    const transaction = normalizeRpcTransaction(includedTransaction());
    expect(transaction.value).toBe("9007199254740993");
    expect(transaction.input).toBe("0xaabb");
    expect(transaction.fee).toEqual({
      kind: "dynamic",
      maxFeePerGas: "9007199254740993",
      maxPriorityFeePerGas: "1",
    });
    expect(transaction.position).toEqual({
      status: "included",
      blockNumber: "9007199254740993",
      blockHash,
      transactionIndex: "3",
    });
    expect(normalizeRpcAccessList([
      { address: addressB, storageKeys: [`0x${"2".repeat(64)}`, `0x${"1".repeat(64)}`] },
      { address: addressA, storageKeys: [] },
      { address: addressB, storageKeys: [`0x${"2".repeat(64)}`] },
    ], parseUnsignedDecimal("1"))).toEqual({
      kind: "entries",
      entries: [
        { address: addressB, storageKeys: [`0x${"2".repeat(64)}`, `0x${"1".repeat(64)}`] },
        { address: addressA, storageKeys: [] },
        { address: addressB, storageKeys: [`0x${"2".repeat(64)}`] },
      ],
    });
    expect(normalizeRpcAccessList([
      { address: addressA, storageKeys: [] },
      { address: addressA.toUpperCase().replace("0X", "0x"), storageKeys: [] },
    ], parseUnsignedDecimal("1"))).toEqual({
      kind: "entries",
      entries: [
        { address: addressA, storageKeys: [] },
        { address: addressA, storageKeys: [] },
      ],
    });
  });

  it("round-trips every uint256 quantity and ABI word without precision loss", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: (1n << 256n) - 1n }), (value) => {
      const decimal = value.toString(10);
      const quantity = `0x${value.toString(16)}`;
      expect(rpcQuantityToUnsignedDecimal(quantity)).toBe(decimal);
      expect(unsignedDecimalToRpcQuantity(decimal)).toBe(quantity);
      expect(normalizeAbiUint256(word(value))).toBe(decimal);
    }));
    for (const value of [0n, 1n, 9_007_199_254_740_993n, (1n << 256n) - 1n]) {
      expect(normalizeAbiUint256(word(value))).toBe(value.toString(10));
    }
    fc.assert(fc.property(fc.integer({ min: 0, max: 255 }), (value) => {
      expect(normalizeAbiDecimals(word(BigInt(value)))).toBe(String(value));
    }));
  });

  it("preserves access-list sequence and duplicates for every valid bounded input", () => {
    fc.assert(fc.property(
      fc.array(accessListEntryArbitrary, { maxLength: 12 }),
      (entries) => {
        expect(normalizeRpcAccessList(entries, parseUnsignedDecimal("1"))).toEqual({
          kind: "entries",
          entries,
        });
      },
    ));
  });

  it("binds transaction, receipt, block, and logs to one exact inclusion anchor", () => {
    const result = normalizeIncludedTransaction(includedTransaction(), receipt(), block());
    expect(result.block.blockNumber).toBe("9007199254740993");
    expect(result.receipt.cumulativeGasUsed).toBe("9007199254740993");
    expect(result.receipt.logs[0]?.decodedEvent).toEqual({
      kind: "erc20_transfer",
      token: addressB,
      from: addressA,
      to: addressB,
      amountRaw: "9007199254740993",
    });
    expect(Object.isFrozen(result.receipt.logs[0]?.decodedEvent)).toBe(true);
  });

  it("rejects partial inclusion, anchor disagreement, reordered logs, and removed logs", () => {
    expect(() => normalizeRpcTransaction({ ...includedTransaction(), blockHash: null })).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      includedTransaction(),
      { ...receipt(), blockHash: `0x${"e".repeat(64)}` },
      block(),
    )).toThrow(TypeError);
    expect(() => normalizeRpcReceipt(receipt([receiptLog("0x2"), receiptLog("0x1")]))).toThrow(TypeError);
    expect(() => normalizeRpcReceipt(receipt([{ ...receiptLog(), removed: true }]))).toThrow(TypeError);
    expect(() => normalizeRpcReceipt(receipt([{ ...receiptLog(), transactionIndex: "0x4" }]))).toThrow(TypeError);
  });

  it("rejects transaction, receipt, and block identity or execution-accounting disagreement", () => {
    expect(() => normalizeRpcTransaction({ ...includedTransaction(), chainId: "0x1" })).toThrow(TypeError);
    expect(() => normalizeRpcTransaction({ ...includedTransaction(), chainId: undefined })).toThrow(TypeError);
    expect(() => normalizeRpcTransaction({
      ...includedTransaction(),
      type: "0x3",
      to: null,
    })).toThrow(TypeError);
    expect(() => normalizeRpcTransaction({
      ...includedTransaction(),
      type: "0x4",
      to: null,
    })).toThrow(TypeError);
    expect(() => normalizeRpcTransaction({
      ...includedTransaction(),
      maxFeePerGas: "0x1",
      maxPriorityFeePerGas: "0x2",
    })).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      includedTransaction(),
      { ...receipt(), from: addressB },
      block(),
    )).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      includedTransaction(),
      { ...receipt(), to: addressA },
      block(),
    )).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      includedTransaction(),
      { ...receipt(), type: "0x1" },
      block(),
    )).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      includedTransaction(),
      { ...receipt(), gasUsed: "0x5209" },
      block(),
    )).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      includedTransaction(),
      { ...receipt(), cumulativeGasUsed: "0x5207" },
      block(),
    )).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      legacyIncludedTransaction(),
      {
        ...receipt(),
        type: "0x0",
        effectiveGasPrice: "0x1",
      },
      block(),
    )).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      {
        ...includedTransaction(),
        maxFeePerGas: "0x5",
        maxPriorityFeePerGas: "0x2",
      },
      { ...receipt(), effectiveGasPrice: "0x1" },
      block(),
    )).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      {
        ...includedTransaction(),
        maxFeePerGas: "0x5",
        maxPriorityFeePerGas: "0x2",
      },
      { ...receipt(), effectiveGasPrice: "0x6" },
      block(),
    )).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      includedTransaction(),
      { ...receipt(), contractAddress: addressA },
      block(),
    )).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      includedTransaction(),
      receipt(),
      { ...block(), transactions: [`0x${"1".repeat(64)}`] },
    )).toThrow(TypeError);
    expect(() => normalizeIncludedTransaction(
      includedTransaction(),
      receipt(),
      {
        ...block(),
        transactions: [
          `0x${"1".repeat(64)}`,
          `0x${"2".repeat(64)}`,
          `0x${"3".repeat(64)}`,
          `0x${"4".repeat(64)}`,
        ],
      },
    )).toThrow(TypeError);
  });

  it("enforces calldata, log-count, and aggregate access-list limits", () => {
    expect(() => normalizeRpcTransaction({
      ...includedTransaction(),
      input: `0x${"00".repeat(2_097_153)}`,
    })).toThrow(TypeError);
    expect(() => normalizeRpcReceipt(receipt(new Array(4_097).fill(receiptLog())))).toThrow(TypeError);
    expect(() => normalizeRpcAccessList([
      { address: addressA, storageKeys: new Array(4_097).fill(`0x${"1".repeat(64)}`) },
    ], parseUnsignedDecimal("1"))).toThrow(TypeError);
    expect(() => normalizeRpcAccessList([
      {
        address: addressA,
        storageKeys: Array.from({ length: 2_049 }, (_, index) =>
          `0x${index.toString(16).padStart(64, "0")}`),
      },
      {
        address: addressB,
        storageKeys: Array.from({ length: 2_048 }, (_, index) =>
          `0x${(index + 4_096).toString(16).padStart(64, "0")}`),
      },
    ], parseUnsignedDecimal("1"))).toThrow(TypeError);
  });

  it("does not invoke provider-controlled accessors while rejecting non-data fields", () => {
    let getterCalls = 0;
    const malicious = { ...includedTransaction() };
    Object.defineProperty(malicious, "value", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "0x1";
      },
    });
    expect(() => normalizeRpcTransaction(malicious)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });
});
