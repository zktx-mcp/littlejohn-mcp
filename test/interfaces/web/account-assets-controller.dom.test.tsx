// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  accountAssetOverviewQueryContract,
  type AccountAssetOverviewSuccess,
} from "../../../src/account-assets/browser.js";
import {
  evmChainIdSchema,
  parseHash32,
  parseEvmAddressInput,
} from "../../../src/core/browser.js";
import {
  officialAssetCandidateListDigest,
} from "../../../src/registry/official-asset-contract.js";
import {
  useAccountAssetsController,
  type AccountAssetsController,
  type ConnectedAccount,
} from "../../../src/interfaces/web/account-assets-controller.js";
import type {
  BrowserFetch,
  BrowserFetchResponse,
} from "../../../src/interfaces/web/browser-client.js";

const chainId = evmChainIdSchema.parse("eip155:4663");
const firstAddress = parseEvmAddressInput(`0x${"11".repeat(20)}`);
const secondAddress = parseEvmAddressInput(`0x${"22".repeat(20)}`);
const snapshotRevision = Buffer.alloc(16, 3).toString("base64url");
const selectionSetRevision = Buffer.alloc(16, 4).toString("base64url");
const blockHash = `0x${"ab".repeat(32)}` as const;
const candidate = Object.freeze({
  assetUid: parseHash32(`0x${"01".repeat(32)}`),
  contractAddress: parseEvmAddressInput(`0x${"33".repeat(20)}`),
  sourceName: "Example",
  sourceSymbol: "EXT",
});
const candidateListDigest = officialAssetCandidateListDigest([candidate]);

const connectedAccount = (
  address: typeof firstAddress | typeof secondAddress,
  connectionRevision: string,
): ConnectedAccount => Object.freeze({
  chainId,
  address,
  connectionRevision,
});

const overview = (
  account: ConnectedAccount,
  rawBalance: string,
): AccountAssetOverviewSuccess => accountAssetOverviewQueryContract.parsePublicSuccess(
  {},
  {
    account: {
      chainId: account.chainId,
      address: account.address,
    },
    block: {
      chainId,
      blockNumber: "42",
      blockHash,
      blockTimestamp: "2026-07-29T00:00:00.000Z",
    },
    viewRevision: {
      officialSnapshotStatus: "current",
      officialSnapshotRevision: snapshotRevision,
      selectionSetRevision,
    },
    native: {
      kind: "native",
      asset: { kind: "native", chainId },
      rawBalance,
      classification: "native",
    },
    stockTokens: {
      status: "current",
      candidateListDigest,
      members: [{ status: "available_to_add", candidate }],
    },
  },
);

const response = (
  value: unknown,
  status = 200,
): BrowserFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
};

let latest: AccountAssetsController | undefined;
const doNotRecoverSession = (): boolean => false;

const Harness = ({
  account,
  request,
}: {
  readonly account: ConnectedAccount;
  readonly request: BrowserFetch;
}) => {
  latest = useAccountAssetsController({
    account,
    active: true,
    recoverSession: doNotRecoverSession,
    request,
  });
  return null;
};

afterEach(() => {
  cleanup();
  latest = undefined;
  vi.restoreAllMocks();
});

describe("account asset overview lifecycle", () => {
  it("keeps the admitted overview during refresh and replaces it atomically", async () => {
    const account = connectedAccount(firstAddress, "1");
    const refreshResult = deferred<BrowserFetchResponse>();
    let reads = 0;
    const request = vi.fn<BrowserFetch>(async () => {
      reads += 1;
      return reads === 1
        ? response(overview(account, "1"))
        : refreshResult.promise;
    });

    render(<Harness account={account} request={request} />);
    await waitFor(() => {
      expect(latest?.snapshot?.result.native.rawBalance).toBe("1");
    });

    act(() => { latest?.refresh(); });
    await waitFor(() => {
      expect(latest?.overviewRead.status).toBe("loading");
    });
    expect(latest?.snapshot?.result.native.rawBalance).toBe("1");

    await act(async () => {
      refreshResult.resolve(response(overview(account, "2")));
      await refreshResult.promise;
    });
    await waitFor(() => {
      expect(latest?.overviewRead.status).toBe("idle");
      expect(latest?.snapshot?.result.native.rawBalance).toBe("2");
    });
  });

  it("keeps the last overview on refresh failure and clears it across account changes", async () => {
    const first = connectedAccount(firstAddress, "1");
    const second = connectedAccount(secondAddress, "2");
    const staleResult = deferred<BrowserFetchResponse>();
    const secondResult = deferred<BrowserFetchResponse>();
    let reads = 0;
    const request = vi.fn<BrowserFetch>(async () => {
      reads += 1;
      if (reads === 1) return response(overview(first, "1"));
      if (reads === 2) {
        return response({
          type: "about:blank",
          title: "Source unavailable",
          status: 503,
          code: "source_unavailable",
          detail: "A required data source is unavailable.",
          retryable: true,
          issues: [],
        }, 503);
      }
      if (reads === 3) return staleResult.promise;
      return secondResult.promise;
    });

    const rendered = render(<Harness account={first} request={request} />);
    await waitFor(() => {
      expect(latest?.snapshot?.result.native.rawBalance).toBe("1");
    });

    act(() => { latest?.refresh(); });
    await waitFor(() => {
      expect(latest?.overviewRead.status).toBe("error");
    });
    expect(latest?.snapshot?.result.native.rawBalance).toBe("1");

    act(() => { latest?.refresh(); });
    await waitFor(() => { expect(reads).toBe(3); });
    rendered.rerender(<Harness account={second} request={request} />);
    await waitFor(() => {
      expect(reads).toBe(4);
      expect(latest?.snapshot).toBeUndefined();
    });

    await act(async () => {
      staleResult.resolve(response(overview(first, "7")));
      await staleResult.promise;
    });
    expect(latest?.snapshot).toBeUndefined();

    await act(async () => {
      secondResult.resolve(response(overview(second, "9")));
      await secondResult.promise;
    });
    await waitFor(() => {
      expect(latest?.snapshot?.result.account.address).toBe(secondAddress);
      expect(latest?.snapshot?.result.native.rawBalance).toBe("9");
    });
  });
});
