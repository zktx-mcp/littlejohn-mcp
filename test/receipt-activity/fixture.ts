import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {parseHash32, parseHexBytes} from "../../src/core/index.js";
import {parseEvmAddress} from "../../src/evm/identities.js";
import {keccak256FromUtf8} from "../../src/evm/keccak256.js";
import { normalizeIncludedTransaction, normalizeRpcTransaction } from "../../src/chain/normalization.js";
import { serializeDynamicFeeRequest, type TransactionChainReadPort } from "../../src/chain/transaction-reads.js";
import { ProductDatabase } from "../../src/runtime/database.js";
import { ReceiptActivity } from "../../src/receipt-activity/application.js";
import { createReviewApplication } from "../../src/review/application.js";
import { createReadyExchangeReview } from "../../src/review/contracts.js";
import { createReviewedRequestReference } from "../../src/review/request-reference.js";
import { observeExchange } from "../../src/review/preparation.js";
import { createExchangeFixture } from "../review/fixture.js";
import { uniswapV4ContractAddresses } from "../../src/protocols/uniswap-v4/client.js";

const qty = (value: string | bigint) => `0x${BigInt(value).toString(16)}`;
const indexed = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;

export const createReceiptFixture = async (kind: "swap" | "erc20_approval" | "permit2_approval" = "swap") => {
  const base = createExchangeFixture(kind);
  const original = await observeExchange(base.deps, base.input, new AbortController().signal);
  if (!original.ok || "replacement" in original.review.data) throw new Error("Original exchange fixture required.");
  const review = createReadyExchangeReview(original.review);
  const reference = createReviewedRequestReference(review, original.privateRequest);
  const data = original.review.data;
  const hash = parseHash32(`0x${"ad".repeat(32)}`);
  const root = await mkdtemp(resolve(tmpdir(), "littlejohn-ledger-"));
  if (process.platform !== "win32") await chmod(root, 0o700);
  const path = resolve(root, "product.sqlite");
  let database = await ProductDatabase.open(path, base.deps.clock.now());
  database.configuredChainStore().insertConfiguredChainIfAbsent(data.intent.account.chainId);
  const wire = serializeDynamicFeeRequest(original.privateRequest);
  const position = { blockNumber: qty(data.block.blockNumber), blockHash: data.block.blockHash, transactionIndex: "0x0" };
  const tx = { ...wire, hash, input: wire.data, ...position };
  const logs: object[] = [];
  const log = (address: string, topics: string[], payload: string) => {
    logs.push({ address, topics, data: payload, ...position, transactionHash: hash, logIndex: qty(BigInt(logs.length)), removed: false });
  };
  if (kind === "swap") {
    const topic = keccak256FromUtf8("Transfer(address,address,uint256)");
    // Encode independent raw event values, not expected-effect output.
    log(data.intent.input.token, [topic, indexed(reference.account.address), indexed(uniswapV4ContractAddresses.poolManager)], `0x${10n.toString(16).padStart(64, "0")}`);
    log(data.intent.output.token, [topic, indexed(uniswapV4ContractAddresses.poolManager), indexed(reference.account.address)], `0x${20n.toString(16).padStart(64, "0")}`);
    log(uniswapV4ContractAddresses.poolManager,
      [keccak256FromUtf8("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"), data.intent.poolId, indexed(uniswapV4ContractAddresses.router)],
      base.codec.encodeParameters([{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }], [-10n, 20n, 1n << 96n, 100n, 0, 3000]));
  } else if (kind === "erc20_approval") {
    log(data.intent.input.token, [keccak256FromUtf8("Approval(address,address,uint256)"), indexed(reference.account.address), indexed(uniswapV4ContractAddresses.permit2)], `0x${10n.toString(16).padStart(64, "0")}`);
  } else {
    log(uniswapV4ContractAddresses.permit2,
      [keccak256FromUtf8("Approval(address,address,address,uint160,uint48)"), indexed(reference.account.address), indexed(data.intent.input.token), indexed(uniswapV4ContractAddresses.router)],
      base.codec.encodeParameters([{ type: "uint160" }, { type: "uint48" }], [10n, Date.parse(data.intent.deadline) / 1000]));
  }
  const receipt = { transactionHash: hash, from: wire.from, to: wire.to, type: "0x2", ...position,
    status: "0x1", cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x5", contractAddress: null, logs };
  const block = { number: position.blockNumber, hash: data.block.blockHash, timestamp: qty(BigInt(Date.parse(data.block.blockTimestamp) / 1000)), transactions: [hash] };
  const included = () => normalizeIncludedTransaction(tx, receipt, block, reference.account.chainId);
  const transactions: TransactionChainReadPort = { ...base.deps.transactions, readTransaction: async () => ({ status: "included", value: included() }),
    finality: async () => ({ status: "finalized", head: data.block }) };
  const dependencies = { chain: { ...base.deps, invocationPorts: base.invocationPorts,
    transactions,
  }, codec: base.codec, nativeUnitAuthority: base.nativeUnitAuthority };
  let activity = new ReceiptActivity(dependencies, database.transactionLedgerStore());
  return { ...base, original, reference, hash, path, tx, receipt, block, transactions,
    get activity() { return activity; }, get database() { return database; },
    receive() { const reservation = activity.reserveWalletTransaction(); activity.recordWalletTransaction(reservation, { reference, transactionHash: hash, receivedAt: base.deps.clock.now() }); },
    async reopen() { await activity.close(); database.close(); database = await ProductDatabase.open(path, base.deps.clock.now()); activity = new ReceiptActivity(dependencies, database.transactionLedgerStore()); },
    async close() { await activity.close(); database.close(); await base.close(); await rm(root, { recursive: true, force: true }); },
  };
};

