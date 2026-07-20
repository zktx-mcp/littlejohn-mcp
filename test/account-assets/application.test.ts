import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createAccountAssetApplication } from "../../src/account-assets/application.js";
import { createErc20CallEncoder, type Erc20CallEncoder } from "../../src/chain/evm-standard.js";
import {
  parseEvmAddress,
  parseEvmChainId,
  parseUnsignedDecimal,
  type EvmAccountIdentity,
} from "../../src/core/index.js";
import {
  tokenInspectionDigest,
  tokenRegistrationWithInspectionSchema,
  type AccountTokenRegistrationReadPort,
  type TokenRegistrationWithInspection,
} from "../../src/token-catalog/index.js";
import type { ActiveWalletReadPort, ActiveWalletReadSnapshot } from "../../src/wallet/coordinator.js";
import {
  ScriptedRpc,
  connectedWallet,
  createChainHandlerHarness,
  rpcFailure,
  rpcValue,
  type ChainHandlerHarness,
  type RpcStep,
} from "../chain/handler-harness.js";
import {
  chainId,
  createInspectionSuccess,
  walletAddress,
} from "../token-catalog/harness.js";

const blockHash = `0x${"88".repeat(32)}`;
const block = Object.freeze({
  number: "0x2a",
  hash: blockHash,
  timestamp: "0x65a00000",
  transactions: [],
});
const abiWord = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;

let encoder: Erc20CallEncoder;
const openApplications: ReturnType<typeof createAccountAssetApplication>[] = [];
const openChains: ChainHandlerHarness[] = [];

beforeAll(async () => { encoder = await createErc20CallEncoder(); });

afterEach(async () => {
  await Promise.allSettled(openApplications.splice(0).map((application) => application.close()));
  await Promise.allSettled(openChains.splice(0).map((chain) => chain.close()));
});

const registration = async (index: number): Promise<TokenRegistrationWithInspection> => {
  const address = parseEvmAddress(`0x${index.toString(16).padStart(2, "0").repeat(20)}`);
  const inspection = await createInspectionSuccess({
    asset: { kind: "erc20", chainId, address },
    block: { kind: "latest" },
  });
  return tokenRegistrationWithInspectionSchema.parse({
    registration: {
      account: { chainId, address: walletAddress },
      asset: inspection.data.asset,
      revision: Buffer.alloc(16, index).toString("base64url"),
      inspectionDigest: tokenInspectionDigest(inspection),
      createdAt: "2026-07-18T00:00:03.000Z",
    },
    inspection,
  });
};

const registrationStore = (
  readEntries: () => readonly TokenRegistrationWithInspection[],
): AccountTokenRegistrationReadPort => Object.freeze({
  getForAccount({ account, asset }: Parameters<AccountTokenRegistrationReadPort["getForAccount"]>[0]) {
    return readEntries().find((entry) =>
      entry.registration.account.chainId === account.chainId &&
      entry.registration.account.address === account.address &&
      entry.registration.asset.chainId === asset.chainId &&
      entry.registration.asset.address === asset.address);
  },
  listForAccount({
    account,
    limit,
    cursor,
  }: Parameters<AccountTokenRegistrationReadPort["listForAccount"]>[0]) {
    const matching = readEntries()
      .filter((entry) =>
        entry.registration.account.chainId === account.chainId &&
        entry.registration.account.address === account.address &&
        (cursor === null || entry.registration.asset.address > cursor))
      .sort((left, right) => left.registration.asset.address.localeCompare(right.registration.asset.address));
    const entries = matching.slice(0, limit);
    return Object.freeze({
      entries: Object.freeze(entries),
      nextCursor: matching.length > limit ? entries.at(-1)!.registration.asset.address : null,
    });
  },
});

const mutableWallet = (): Readonly<{
  port: ActiveWalletReadPort;
  replace(snapshot: ActiveWalletReadSnapshot): void;
  read(): ActiveWalletReadSnapshot;
}> => {
  let snapshot = connectedWallet(walletAddress).port.capture();
  return Object.freeze({
    port: Object.freeze({ capture: () => snapshot }),
    replace(next) { snapshot = next; },
    read: () => snapshot,
  });
};

const createApplication = (
  entries: () => readonly TokenRegistrationWithInspection[],
  steps: readonly RpcStep[],
  wallet = mutableWallet(),
) => {
  const chain = createChainHandlerHarness({
    rpc: new ScriptedRpc(steps),
    encoder,
    wallet: { port: wallet.port, captures: () => 0 },
  });
  const owner = new AbortController();
  const application = createAccountAssetApplication({
    activeWallet: wallet.port,
    registrations: registrationStore(entries),
    accountBalance: chain.service.chainReads.accountBalance,
    signal: owner.signal,
  });
  openChains.push(chain);
  openApplications.push(application);
  return Object.freeze({ application, chain, wallet, owner });
};

const collectionSteps = (tokenCount: number): readonly RpcStep[] => Object.freeze([
  rpcValue("eth_chainId", "0x1237"),
  rpcValue("eth_getBlockByNumber", block),
  rpcValue("eth_getBalance", "0x64"),
  ...Array.from({ length: tokenCount }, (_, index) => rpcValue("eth_call", abiWord(BigInt(index + 1)))),
  ...Array.from({ length: tokenCount }, () => rpcValue("eth_call", abiWord(6n))),
]);

describe("account asset read process", () => {
  it("reads one current-account page at one block and preserves canonical pagination", async () => {
    const entries = await Promise.all([1, 2, 3, 4, 5, 6].map(registration));
    const { application, chain } = createApplication(() => entries, collectionSteps(5));

    const result = await application.list({ limit: 5 });
    expect(result).toMatchObject({
      account: { chainId, address: walletAddress },
      assets: entries.slice(0, 5).map((entry) => ({ registration: entry.registration })),
      nextCursor: entries[4]!.registration.asset.address,
      balance: {
        status: "available",
        snapshot: {
          data: {
            account: walletAddress,
            native: { status: "available", amount: { raw: "100" } },
          },
        },
      },
    });
    if (!("balance" in result) || result.balance.status !== "available") throw new TypeError();
    expect(result.balance.snapshot.data.tokens.map((entry) => entry.asset.address))
      .toEqual(entries.slice(0, 5).map((entry) => entry.registration.asset.address));
    expect(new Set(result.balance.snapshot.data.tokens.map((entry) =>
      entry.result.status === "available" ? entry.result.amount.raw : entry.result.status,
    ))).toEqual(new Set(["1", "2", "3", "4", "5"]));
    expect(chain.rpc.remainingSteps).toBe(0);
  });

  it("keeps membership and metadata when the chain source is unavailable", async () => {
    const entry = await registration(1);
    const { application } = createApplication(() => [entry], [
      rpcFailure("eth_chainId", "source_unavailable"),
    ]);

    const result = await application.list({});
    expect(result).toMatchObject({
      assets: [{ registration: entry.registration }],
      balance: { status: "unavailable", failure: { error: { code: "source_unavailable" } } },
    });
  });

  it("reads one exact registered token without requesting the native balance", async () => {
    const entry = await registration(1);
    const { application, chain } = createApplication(() => [entry], [
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block),
      rpcValue("eth_call", abiWord(1234500n)),
      rpcValue("eth_call", abiWord(6n)),
    ]);

    const result = await application.get({ asset: entry.registration.asset });
    expect(result).toMatchObject({
      account: entry.registration.account,
      asset: { registration: entry.registration },
      balance: {
        status: "available",
        snapshot: {
          data: {
            native: { status: "not_requested" },
            tokens: [{
              asset: entry.registration.asset,
              result: { status: "available", amount: { raw: "1234500" } },
            }],
          },
        },
      },
    });
    expect(chain.rpc.calls.some(({ method }) => method === "eth_getBalance")).toBe(false);
    expect(chain.rpc.remainingSteps).toBe(0);
  });

  it("rejects registration and wallet drift across the balance observation", async () => {
    const entry = await registration(1);
    let entries: readonly TokenRegistrationWithInspection[] = [entry];
    const registrationDrift = createApplication(() => entries, [
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block),
      {
        method: "eth_getBalance",
        run: () => { entries = []; return "0x1"; },
      },
      rpcValue("eth_call", abiWord(1n)),
      rpcValue("eth_call", abiWord(6n)),
    ]);
    expect(await registrationDrift.application.list({})).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });

    const wallet = mutableWallet();
    const initial = wallet.read();
    const walletDrift = createApplication(() => [], [
      rpcValue("eth_chainId", "0x1237"),
      rpcValue("eth_getBlockByNumber", block),
      {
        method: "eth_getBalance",
        run: () => {
          wallet.replace(Object.freeze({
            ...initial,
            connectionRevision: parseUnsignedDecimal("1"),
          }));
          return "0x1";
        },
      },
    ], wallet);
    expect(await walletDrift.application.list({})).toMatchObject({
      ok: false,
      error: { code: "state_conflict" },
    });
  });

  it("rejects wrong-chain and missing exact identities before returning an asset", async () => {
    const entry = await registration(1);
    const wrongChain = createApplication(() => [entry], []);
    expect(await wrongChain.application.get({
      asset: { ...entry.registration.asset, chainId: parseEvmChainId("eip155:1") },
    })).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const missing = await registration(2);
    expect(await wrongChain.application.get({ asset: missing.registration.asset }))
      .toMatchObject({ ok: false, error: { code: "token_registration_not_found" } });
    expect(wrongChain.chain.rpc.calls).toEqual([]);
  });

  it("maps caller cancellation separately and closes by aborting and draining admitted reads", async () => {
    const started: Array<() => void> = [];
    const blockingStep = (): RpcStep => Object.freeze({
      method: "eth_chainId",
      run: (_params: readonly unknown[], signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        started.shift()?.();
        const abort = (): void => reject(new Error("aborted"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    });

    const callerHarness = createApplication(() => [], [blockingStep()]);
    const callerStarted = new Promise<void>((resolve) => { started.push(resolve); });
    const caller = new AbortController();
    const callerRead = callerHarness.application.list({}, caller.signal);
    await callerStarted;
    caller.abort();
    expect(await callerRead).toMatchObject({ ok: false, error: { code: "request_aborted" } });

    const closeHarness = createApplication(() => [], [blockingStep()]);
    const closeStarted = new Promise<void>((resolve) => { started.push(resolve); });
    const closeRead = closeHarness.application.list({});
    await closeStarted;
    const closing = closeHarness.application.close();
    expect(await closeRead).toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
    await closing;
    expect(await closeHarness.application.list({})).toMatchObject({
      ok: false,
      error: { code: "runtime_state_unavailable" },
    });
  });
});
