import {
  blockSelectorSchema,
  chainAnchorSchema,
  decodeCanonicalErc20Event,
  keccak256Hex,
  maximumTokenDecimals,
  parseEvmAddress,
  parseHash32,
  parseHexBytes,
  parseUnsignedDecimal,
  parseUtcTimestamp,
  readCapabilityLimits,
  robinhoodChainIdentity,
  type BlockSelector,
  type ChainAnchor,
  type EvmAddress,
  type Hash32,
  type HexBytes,
  type UnsignedDecimal,
} from "../core/index.js";
import { maximumBlockTransactionHashes } from "./limits.js";

const maxUint256 = (1n << 256n) - 1n;
const maximumTimestampSeconds = 253_402_300_799n;
const quantityPattern = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const bytesPattern = /^0x(?:[0-9a-fA-F]{2})*$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;

const invalid = (): never => {
  throw new TypeError("Invalid RPC value.");
};

const freezeNormalized = <Value>(value: Value, seen = new WeakSet<object>()): Value => {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) freezeNormalized(descriptor.value, seen);
  }
  return Object.freeze(value);
};

type CapturedObject = ReadonlyMap<string, unknown>;

const captureObject = (input: unknown): CapturedObject => {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const fields = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return invalid();
      fields.set(key, descriptor.value);
    }
    return fields;
  } catch {
    return invalid();
  }
};

const captureArray = (input: unknown, maximumLength: number): readonly unknown[] => {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return invalid();
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) return invalid();
    for (const key of Reflect.ownKeys(input)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) return invalid();
      const index = Number(key);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (index >= length || descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return invalid();
      }
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return invalid();
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return invalid();
  }
};

const required = (fields: CapturedObject, name: string): unknown => {
  if (!fields.has(name)) return invalid();
  return fields.get(name);
};

const normalizeBytes = (input: unknown, maximumBytes?: number): HexBytes => {
  if (typeof input !== "string" || !bytesPattern.test(input)) return invalid();
  const byteLength = (input.length - 2) / 2;
  if (maximumBytes !== undefined && byteLength > maximumBytes) return invalid();
  return parseHexBytes(input.toLowerCase());
};

export const parseRpcQuantity = (input: unknown): bigint => {
  if (typeof input !== "string" || !quantityPattern.test(input)) return invalid();
  const value = BigInt(input);
  if (value > maxUint256) return invalid();
  return value;
};

export const rpcQuantityToUnsignedDecimal = (input: unknown): UnsignedDecimal =>
  parseUnsignedDecimal(parseRpcQuantity(input).toString(10));

export const unsignedDecimalToRpcQuantity = (input: unknown): `0x${string}` => {
  const value = BigInt(parseUnsignedDecimal(input));
  if (value > maxUint256) return invalid();
  return `0x${value.toString(16)}`;
};

export const normalizeRpcAddress = (input: unknown): EvmAddress => {
  if (typeof input !== "string" || !addressPattern.test(input)) return invalid();
  return parseEvmAddress(input.toLowerCase());
};

export const normalizeRpcHash = (input: unknown): Hash32 => {
  if (typeof input !== "string" || !hashPattern.test(input)) return invalid();
  return parseHash32(input.toLowerCase());
};

export const normalizeRpcBytes = (input: unknown): HexBytes => normalizeBytes(input);

export const blockSelectorToRpcTag = (input: unknown): "latest" | `0x${string}` => {
  const selector = blockSelectorSchema.parse(input) as BlockSelector;
  return selector.kind === "latest" ? "latest" : unsignedDecimalToRpcQuantity(selector.blockNumber);
};

export const normalizeRpcBlockAnchor = (input: unknown): ChainAnchor => {
  const fields = captureObject(input);
  const seconds = parseRpcQuantity(required(fields, "timestamp"));
  if (seconds > maximumTimestampSeconds) return invalid();
  const blockTimestamp = parseUtcTimestamp(new Date(Number(seconds * 1_000n)).toISOString());
  return chainAnchorSchema.parse(freezeNormalized({
    chainId: robinhoodChainIdentity.chainId,
    blockNumber: rpcQuantityToUnsignedDecimal(required(fields, "number")),
    blockHash: normalizeRpcHash(required(fields, "hash")),
    blockTimestamp,
  })) as ChainAnchor;
};

export type NormalizedRuntimeCode =
  | { readonly status: "empty" }
  | {
      readonly status: "present";
      readonly bytecode: HexBytes;
      readonly byteLength: UnsignedDecimal;
      readonly codeHash: Hash32;
    };

export const normalizeRpcRuntimeCode = (input: unknown): NormalizedRuntimeCode => {
  const bytecode = normalizeBytes(input, readCapabilityLimits.runtimeCodeBytes);
  if (bytecode === "0x") return Object.freeze({ status: "empty" });
  return freezeNormalized({
    status: "present" as const,
    bytecode,
    byteLength: parseUnsignedDecimal(String((bytecode.length - 2) / 2)),
    codeHash: parseHash32(keccak256Hex(bytecode)),
  });
};

export const normalizeAbiUint256 = (input: unknown): UnsignedDecimal => {
  const word = normalizeBytes(input);
  if (word.length !== 66) return invalid();
  return parseUnsignedDecimal(BigInt(word).toString(10));
};

export const normalizeAbiDecimals = (input: unknown): UnsignedDecimal => {
  const value = normalizeAbiUint256(input);
  if (BigInt(value) > BigInt(maximumTokenDecimals)) return invalid();
  return value;
};

export type NormalizedAccessList =
  | { readonly kind: "none" }
  | {
      readonly kind: "entries";
      readonly entries: readonly {
        readonly address: EvmAddress;
        readonly storageKeys: readonly Hash32[];
      }[];
    };

export const normalizeRpcAccessList = (input: unknown, transactionType: UnsignedDecimal): NormalizedAccessList => {
  if (input === undefined) return Object.freeze({ kind: "none" });
  if (transactionType === "0") return invalid();
  const entries = captureArray(input, readCapabilityLimits.transactionAccessListEntries).map((candidate) => {
    const fields = captureObject(candidate);
    const address = normalizeRpcAddress(required(fields, "address"));
    const storageKeys = captureArray(
      required(fields, "storageKeys"),
      readCapabilityLimits.transactionAccessListStorageKeyOccurrences,
    )
      .map(normalizeRpcHash);
    return freezeNormalized({ address, storageKeys });
  });
  const storageKeyCount = entries.reduce((count, entry) => count + entry.storageKeys.length, 0);
  if (storageKeyCount > readCapabilityLimits.transactionAccessListStorageKeyOccurrences) return invalid();
  return freezeNormalized({ kind: "entries" as const, entries });
};

type NormalizedRecipient =
  | { readonly kind: "call"; readonly address: EvmAddress }
  | { readonly kind: "contract_creation" };
type NormalizedFee =
  | { readonly kind: "legacy"; readonly gasPrice: UnsignedDecimal }
  | {
      readonly kind: "dynamic";
      readonly maxFeePerGas: UnsignedDecimal;
      readonly maxPriorityFeePerGas: UnsignedDecimal;
    }
  | { readonly kind: "unsupported"; readonly type: UnsignedDecimal };
type TransactionPosition =
  | { readonly status: "pending" }
  | {
      readonly status: "included";
      readonly blockNumber: UnsignedDecimal;
      readonly blockHash: Hash32;
      readonly transactionIndex: UnsignedDecimal;
    };

export interface NormalizedRpcTransaction {
  readonly transactionHash: Hash32;
  readonly chainScope: typeof robinhoodChainIdentity.chainId;
  readonly from: EvmAddress;
  readonly recipient: NormalizedRecipient;
  readonly value: UnsignedDecimal;
  readonly input: HexBytes;
  readonly nonce: UnsignedDecimal;
  readonly gasLimit: UnsignedDecimal;
  readonly type: UnsignedDecimal;
  readonly accessList: NormalizedAccessList;
  readonly fee: NormalizedFee;
  readonly position: TransactionPosition;
}

const normalizeTransactionType = (input: unknown): UnsignedDecimal => {
  const type = rpcQuantityToUnsignedDecimal(input);
  if (BigInt(type) > BigInt(readCapabilityLimits.transactionType)) return invalid();
  return type;
};

export const normalizeRpcTransaction = (input: unknown): NormalizedRpcTransaction => {
  const fields = captureObject(input);
  const type = normalizeTransactionType(required(fields, "type"));
  const requiresTypedChainIdentity = type === "1" || type === "2" || type === "3" || type === "4";
  const observedChainId = fields.has("chainId")
    ? rpcQuantityToUnsignedDecimal(fields.get("chainId"))
    : undefined;
  if (
    (requiresTypedChainIdentity && observedChainId === undefined) ||
    (observedChainId !== undefined && observedChainId !== robinhoodChainIdentity.chainId)
  ) return invalid();
  const blockNumber = required(fields, "blockNumber");
  const blockHash = required(fields, "blockHash");
  const transactionIndex = required(fields, "transactionIndex");
  const pending = blockNumber === null && blockHash === null && transactionIndex === null;
  if (!pending && (blockNumber === null || blockHash === null || transactionIndex === null)) return invalid();
  const to = required(fields, "to");
  if ((type === "3" || type === "4") && to === null) return invalid();
  const typedAccessListRequired = type === "1" || type === "2" || type === "3" || type === "4";
  if (typedAccessListRequired && !fields.has("accessList")) return invalid();
  const accessList = normalizeRpcAccessList(
    fields.has("accessList") ? fields.get("accessList") : undefined,
    type,
  );
  const fee: NormalizedFee = type === "0" || type === "1"
    ? { kind: "legacy", gasPrice: rpcQuantityToUnsignedDecimal(required(fields, "gasPrice")) }
    : type === "2"
      ? {
          kind: "dynamic",
          maxFeePerGas: rpcQuantityToUnsignedDecimal(required(fields, "maxFeePerGas")),
          maxPriorityFeePerGas: rpcQuantityToUnsignedDecimal(required(fields, "maxPriorityFeePerGas")),
        }
      : { kind: "unsupported", type };
  if (
    fee.kind === "dynamic" &&
    BigInt(fee.maxPriorityFeePerGas) > BigInt(fee.maxFeePerGas)
  ) return invalid();
  return freezeNormalized({
    transactionHash: normalizeRpcHash(required(fields, "hash")),
    chainScope: robinhoodChainIdentity.chainId,
    from: normalizeRpcAddress(required(fields, "from")),
    recipient: to === null
      ? { kind: "contract_creation" as const }
      : { kind: "call" as const, address: normalizeRpcAddress(to) },
    value: rpcQuantityToUnsignedDecimal(required(fields, "value")),
    input: normalizeBytes(required(fields, "input"), readCapabilityLimits.transactionCalldataBytes),
    nonce: rpcQuantityToUnsignedDecimal(required(fields, "nonce")),
    gasLimit: rpcQuantityToUnsignedDecimal(required(fields, "gas")),
    type,
    accessList,
    fee,
    position: pending
      ? { status: "pending" as const }
      : {
          status: "included" as const,
          blockNumber: rpcQuantityToUnsignedDecimal(blockNumber),
          blockHash: normalizeRpcHash(blockHash),
          transactionIndex: rpcQuantityToUnsignedDecimal(transactionIndex),
        },
  });
};

type NormalizedDecodedEvent =
  | { readonly kind: "not_decoded" }
  | {
      readonly kind: "erc20_transfer";
      readonly token: EvmAddress;
      readonly from: EvmAddress;
      readonly to: EvmAddress;
      readonly amountRaw: UnsignedDecimal;
    }
  | {
      readonly kind: "erc20_approval";
      readonly token: EvmAddress;
      readonly owner: EvmAddress;
      readonly spender: EvmAddress;
      readonly amountRaw: UnsignedDecimal;
    };

export interface NormalizedRpcLog {
  readonly address: EvmAddress;
  readonly topics: readonly Hash32[];
  readonly data: HexBytes;
  readonly logIndex: UnsignedDecimal;
  readonly transactionIndex: UnsignedDecimal;
  readonly transactionHash: Hash32;
  readonly blockNumber: UnsignedDecimal;
  readonly blockHash: Hash32;
  readonly decodedEvent: NormalizedDecodedEvent;
}

export const normalizeRpcLog = (input: unknown): NormalizedRpcLog => {
  const fields = captureObject(input);
  if (fields.has("removed") && fields.get("removed") !== false) return invalid();
  const address = normalizeRpcAddress(required(fields, "address"));
  const topics = captureArray(
    required(fields, "topics"),
    readCapabilityLimits.transactionLogTopics,
  ).map(normalizeRpcHash);
  const data = normalizeBytes(required(fields, "data"));
  const decoded = decodeCanonicalErc20Event(topics, data);
  const decodedEvent: NormalizedDecodedEvent = decoded === null
    ? { kind: "not_decoded" }
    : decoded.kind === "erc20_transfer"
      ? { ...decoded, token: address }
      : { ...decoded, token: address };
  return freezeNormalized({
    address,
    topics,
    data,
    logIndex: rpcQuantityToUnsignedDecimal(required(fields, "logIndex")),
    transactionIndex: rpcQuantityToUnsignedDecimal(required(fields, "transactionIndex")),
    transactionHash: normalizeRpcHash(required(fields, "transactionHash")),
    blockNumber: rpcQuantityToUnsignedDecimal(required(fields, "blockNumber")),
    blockHash: normalizeRpcHash(required(fields, "blockHash")),
    decodedEvent,
  });
};

export interface NormalizedRpcReceipt {
  readonly transactionHash: Hash32;
  readonly from: EvmAddress;
  readonly recipient?: NormalizedRecipient;
  readonly type?: UnsignedDecimal;
  readonly transactionIndex: UnsignedDecimal;
  readonly blockNumber: UnsignedDecimal;
  readonly blockHash: Hash32;
  readonly status: "success" | "reverted";
  readonly cumulativeGasUsed: UnsignedDecimal;
  readonly gasUsed: UnsignedDecimal;
  readonly effectiveGasPrice: UnsignedDecimal;
  readonly createdContract:
    | { readonly kind: "none" }
    | { readonly kind: "address"; readonly address: EvmAddress };
  readonly logs: readonly NormalizedRpcLog[];
}

export const normalizeRpcReceipt = (input: unknown): NormalizedRpcReceipt => {
  const fields = captureObject(input);
  const transactionHash = normalizeRpcHash(required(fields, "transactionHash"));
  const from = normalizeRpcAddress(required(fields, "from"));
  const to = fields.has("to") ? fields.get("to") : undefined;
  const recipient = to === undefined
    ? undefined
    : to === null
      ? { kind: "contract_creation" as const }
      : { kind: "call" as const, address: normalizeRpcAddress(to) };
  const type = fields.has("type") ? normalizeTransactionType(fields.get("type")) : undefined;
  const transactionIndex = rpcQuantityToUnsignedDecimal(required(fields, "transactionIndex"));
  const blockNumber = rpcQuantityToUnsignedDecimal(required(fields, "blockNumber"));
  const blockHash = normalizeRpcHash(required(fields, "blockHash"));
  const statusQuantity = parseRpcQuantity(required(fields, "status"));
  if (statusQuantity !== 0n && statusQuantity !== 1n) return invalid();
  const contractAddress = required(fields, "contractAddress");
  const logs = captureArray(
    required(fields, "logs"),
    readCapabilityLimits.transactionReceiptLogs,
  ).map(normalizeRpcLog);
  for (let index = 0; index < logs.length; index += 1) {
    const log = logs[index];
    if (
      log === undefined ||
      log.transactionHash !== transactionHash ||
      log.transactionIndex !== transactionIndex ||
      log.blockNumber !== blockNumber ||
      log.blockHash !== blockHash ||
      (index > 0 && BigInt(logs[index - 1]?.logIndex ?? "0") >= BigInt(log.logIndex))
    ) return invalid();
  }
  return freezeNormalized({
    transactionHash,
    from,
    ...(recipient === undefined ? {} : { recipient }),
    ...(type === undefined ? {} : { type }),
    transactionIndex,
    blockNumber,
    blockHash,
    status: statusQuantity === 1n ? "success" as const : "reverted" as const,
    cumulativeGasUsed: rpcQuantityToUnsignedDecimal(required(fields, "cumulativeGasUsed")),
    gasUsed: rpcQuantityToUnsignedDecimal(required(fields, "gasUsed")),
    effectiveGasPrice: rpcQuantityToUnsignedDecimal(required(fields, "effectiveGasPrice")),
    createdContract: contractAddress === null
      ? { kind: "none" as const }
      : { kind: "address" as const, address: normalizeRpcAddress(contractAddress) },
    logs,
  });
};

export interface NormalizedIncludedTransaction {
  readonly transaction: NormalizedRpcTransaction & {
    readonly position: Extract<TransactionPosition, { readonly status: "included" }>;
  };
  readonly receipt: NormalizedRpcReceipt;
  readonly block: ChainAnchor;
}

export const normalizeIncludedTransaction = (
  transactionInput: unknown,
  receiptInput: unknown,
  blockInput: unknown,
): NormalizedIncludedTransaction => {
  const transaction = normalizeRpcTransaction(transactionInput);
  if (transaction.position.status !== "included") return invalid();
  const receipt = normalizeRpcReceipt(receiptInput);
  const block = normalizeRpcBlockAnchor(blockInput);
  const blockFields = captureObject(blockInput);
  const blockTransactions = captureArray(
    required(blockFields, "transactions"),
    maximumBlockTransactionHashes,
  ).map(normalizeRpcHash);
  const transactionIndex = BigInt(transaction.position.transactionIndex);
  if (
    transactionIndex > BigInt(Number.MAX_SAFE_INTEGER) ||
    blockTransactions[Number(transactionIndex)] !== transaction.transactionHash
  ) return invalid();
  if (
    transaction.transactionHash !== receipt.transactionHash ||
    transaction.from !== receipt.from ||
    (receipt.recipient !== undefined && (
      transaction.recipient.kind !== receipt.recipient.kind ||
      (transaction.recipient.kind === "call" &&
        receipt.recipient.kind === "call" &&
        transaction.recipient.address !== receipt.recipient.address)
    )) ||
    (receipt.type !== undefined && transaction.type !== receipt.type) ||
    transaction.position.transactionIndex !== receipt.transactionIndex ||
    transaction.position.blockNumber !== receipt.blockNumber ||
    transaction.position.blockHash !== receipt.blockHash ||
    transaction.position.blockNumber !== block.blockNumber ||
    transaction.position.blockHash !== block.blockHash
  ) return invalid();
  if (
    BigInt(receipt.gasUsed) > BigInt(transaction.gasLimit) ||
    BigInt(receipt.cumulativeGasUsed) < BigInt(receipt.gasUsed) ||
    (transaction.recipient.kind === "call" && receipt.createdContract.kind !== "none") ||
    (transaction.recipient.kind === "contract_creation" &&
      receipt.status === "success" &&
      receipt.createdContract.kind !== "address") ||
    (receipt.status === "reverted" && receipt.createdContract.kind !== "none")
  ) return invalid();
  const effectiveGasPrice = BigInt(receipt.effectiveGasPrice);
  if (
    (transaction.fee.kind === "legacy" &&
      effectiveGasPrice !== BigInt(transaction.fee.gasPrice)) ||
    (transaction.fee.kind === "dynamic" && (
      effectiveGasPrice < BigInt(transaction.fee.maxPriorityFeePerGas) ||
      effectiveGasPrice > BigInt(transaction.fee.maxFeePerGas)
    ))
  ) return invalid();
  return freezeNormalized({ transaction, receipt, block }) as NormalizedIncludedTransaction;
};
