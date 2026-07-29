import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type AccountAssetExactSuccess,
  type AccountAssetOverviewSuccess,
  type AccountAssetViewRevision,
} from "../../account-assets/browser.js";
import type { TokenSelection } from "../../token-catalog/browser.js";
import {
  loadAccountAssetsOverview,
  loadExactAccountAsset,
} from "./account-assets-client.js";
import {
  invalidBrowserResponse,
  type BrowserFetch,
} from "./browser-client.js";
import {
  presentBrowserRequestFailure,
  type HumanFailurePresentation,
} from "./human-failures.js";
import { createBrowserRequestAuthority } from "./request-authority.js";

export interface ConnectedAccount {
  readonly chainId: TokenSelection["account"]["chainId"];
  readonly address: TokenSelection["account"]["address"];
  readonly connectionRevision: string;
}

export const connectedAccountKey = (
  account: ConnectedAccount | undefined,
): string | undefined => account === undefined
  ? undefined
  : `${account.connectionRevision}:${account.chainId}:${account.address}`;

export const sameConnectedAccount = (
  expected: ConnectedAccount,
  actual: ConnectedAccount | undefined,
): boolean => actual !== undefined &&
  expected.chainId === actual.chainId &&
  expected.address === actual.address &&
  expected.connectionRevision === actual.connectionRevision;

type BoundOverviewSnapshot = Readonly<{
  accountKey: string;
  result: AccountAssetOverviewSuccess;
}>;

export type AccountAssetOverviewReadState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; failure: HumanFailurePresentation }>;

type BoundOverviewReadState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading"; accountKey: string }>
  | Readonly<{
      status: "error";
      accountKey: string;
      failure: HumanFailurePresentation;
    }>;

type BoundExactReadState =
  | Readonly<{ status: "idle" }>
  | Readonly<{
      status: "loading";
      accountKey: string;
      selection: TokenSelection;
    }>
  | Readonly<{
      status: "available";
      accountKey: string;
      selection: TokenSelection;
      result: AccountAssetExactSuccess;
    }>
  | Readonly<{
      status: "error";
      accountKey: string;
      selection: TokenSelection;
      failure: HumanFailurePresentation;
    }>;

export type AccountAssetExactReadState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading"; selection: TokenSelection }>
  | Readonly<{
      status: "available";
      selection: TokenSelection;
      result: AccountAssetExactSuccess;
    }>
  | Readonly<{
      status: "error";
      selection: TokenSelection;
      failure: HumanFailurePresentation;
    }>;

const idleOverviewRead = Object.freeze({ status: "idle" as const });
const loadingOverviewRead = Object.freeze({ status: "loading" as const });
const idleExactRead = Object.freeze({ status: "idle" as const });

const resultMatchesAccount = (
  expected: ConnectedAccount,
  result: Pick<AccountAssetOverviewSuccess | AccountAssetExactSuccess, "account">,
): boolean => result.account.chainId === expected.chainId &&
  result.account.address === expected.address;

const selectionMatchesAccount = (
  expected: ConnectedAccount,
  selection: TokenSelection,
): boolean => selection.account.chainId === expected.chainId &&
  selection.account.address === expected.address;

const revisionKey = (revision: AccountAssetViewRevision): string => [
  revision.officialSnapshotStatus,
  revision.officialSnapshotRevision ?? "",
  revision.selectionSetRevision ?? "",
].join(":");

export interface AccountAssetsController {
  readonly snapshot: BoundOverviewSnapshot | undefined;
  readonly overviewRead: AccountAssetOverviewReadState;
  readonly exactRead: AccountAssetExactReadState;
  readonly refresh: () => void;
  readonly retryExact: () => void;
  readonly openExact: (selection: TokenSelection) => boolean;
  readonly closeExact: () => void;
  readonly invalidate: () => void;
  readonly reconcileAddedSelection: () => void;
  readonly reconcileRemovedSelection: (selection: TokenSelection) => void;
}

export const useAccountAssetsController = ({
  account,
  active,
  recoverSession,
  request,
}: Readonly<{
  account: ConnectedAccount | undefined;
  active: boolean;
  recoverSession: (error: unknown) => boolean;
  request?: BrowserFetch;
}>): AccountAssetsController => {
  const accountRef = useRef(account);
  accountRef.current = account;
  const activeRef = useRef(active);
  activeRef.current = active;
  const requestRef = useRef(request);
  requestRef.current = request;
  const currentAccountKey = connectedAccountKey(account);

  const [snapshot, setSnapshot] = useState<BoundOverviewSnapshot>();
  const snapshotRef = useRef<BoundOverviewSnapshot | undefined>(undefined);
  const [overviewRead, setOverviewRead] =
    useState<BoundOverviewReadState>(idleOverviewRead);
  const [overviewAuthority] = useState(createBrowserRequestAuthority);

  const [exactRead, setExactRead] =
    useState<BoundExactReadState>(idleExactRead);
  const exactReadRef = useRef<BoundExactReadState>(idleExactRead);
  const [exactAuthority] = useState(createBrowserRequestAuthority);

  const replaceSnapshot = useCallback((
    value: BoundOverviewSnapshot | undefined,
  ): void => {
    snapshotRef.current = value;
    setSnapshot(value);
  }, []);

  const replaceExactRead = useCallback((value: BoundExactReadState): void => {
    exactReadRef.current = value;
    setExactRead(value);
  }, []);

  const closeExact = useCallback((): void => {
    exactAuthority.invalidateRead();
    replaceExactRead(idleExactRead);
  }, [exactAuthority, replaceExactRead]);

  const readOverview = useCallback(async (
    expected: ConnectedAccount,
    retainSnapshot: boolean,
  ): Promise<void> => {
    const expectedKey = connectedAccountKey(expected)!;
    if (
      !activeRef.current ||
      connectedAccountKey(accountRef.current) !== expectedKey
    ) return;
    const read = overviewAuthority.beginRead();
    if (read === undefined) return;
    if (!retainSnapshot) replaceSnapshot(undefined);
    setOverviewRead(Object.freeze({
      status: "loading",
      accountKey: expectedKey,
    }));
    try {
      const result = await loadAccountAssetsOverview({
        ...(requestRef.current === undefined
          ? {}
          : { request: requestRef.current }),
        signal: read.signal,
      });
      if (!overviewAuthority.isCurrent(read)) return;
      if (
        connectedAccountKey(accountRef.current) !== expectedKey ||
        !activeRef.current
      ) return;
      if (!resultMatchesAccount(expected, result)) {
        setOverviewRead(Object.freeze({
          status: "error",
          accountKey: expectedKey,
          failure: presentBrowserRequestFailure(
            "assets_collection",
            invalidBrowserResponse(),
          ),
        }));
        return;
      }
      closeExact();
      replaceSnapshot(Object.freeze({ accountKey: expectedKey, result }));
      setOverviewRead(idleOverviewRead);
    } catch (error) {
      if (
        !overviewAuthority.isCurrent(read) ||
        !activeRef.current ||
        connectedAccountKey(accountRef.current) !== expectedKey ||
        recoverSession(error)
      ) return;
      setOverviewRead(Object.freeze({
        status: "error",
        accountKey: expectedKey,
        failure: presentBrowserRequestFailure("assets_collection", error),
      }));
    } finally {
      if (overviewAuthority.isCurrent(read)) overviewAuthority.cancelRead(read);
    }
  }, [
    closeExact,
    overviewAuthority,
    recoverSession,
    replaceSnapshot,
  ]);

  const refresh = useCallback((): void => {
    const current = accountRef.current;
    if (current === undefined || !activeRef.current) return;
    void readOverview(current, true);
  }, [readOverview]);

  const invalidate = useCallback((): void => {
    refresh();
  }, [refresh]);

  const readExact = useCallback(async (
    expected: ConnectedAccount,
    selection: TokenSelection,
    viewRevision: AccountAssetViewRevision,
  ): Promise<AccountAssetExactSuccess | undefined> => {
    const expectedKey = connectedAccountKey(expected)!;
    if (
      !activeRef.current ||
      connectedAccountKey(accountRef.current) !== expectedKey ||
      !selectionMatchesAccount(expected, selection)
    ) return undefined;
    const read = exactAuthority.beginRead();
    if (read === undefined) return undefined;
    const identity = Object.freeze({
      accountKey: expectedKey,
      selection,
    });
    replaceExactRead(Object.freeze({ status: "loading", ...identity }));
    try {
      const result = await loadExactAccountAsset(selection.asset, viewRevision, {
        ...(requestRef.current === undefined
          ? {}
          : { request: requestRef.current }),
        signal: read.signal,
      });
      if (!exactAuthority.isCurrent(read)) return undefined;
      if (
        connectedAccountKey(accountRef.current) !== identity.accountKey ||
        !activeRef.current
      ) return undefined;
      if (!resultMatchesAccount(expected, result)) {
        replaceExactRead(Object.freeze({
          status: "error",
          ...identity,
          failure: presentBrowserRequestFailure(
            "stock_token_information",
            invalidBrowserResponse(),
          ),
        }));
        return undefined;
      }
      replaceExactRead(Object.freeze({
        status: "available",
        ...identity,
        selection: result.asset.selection,
        result,
      }));
      return result;
    } catch (error) {
      if (
        !exactAuthority.isCurrent(read) ||
        !activeRef.current ||
        connectedAccountKey(accountRef.current) !== identity.accountKey ||
        recoverSession(error)
      ) return undefined;
      replaceExactRead(Object.freeze({
        status: "error",
        ...identity,
        failure: presentBrowserRequestFailure("stock_token_information", error),
      }));
      return undefined;
    } finally {
      if (exactAuthority.isCurrent(read)) exactAuthority.cancelRead(read);
    }
  }, [exactAuthority, recoverSession, replaceExactRead]);

  const openExact = useCallback((selection: TokenSelection): boolean => {
    const current = accountRef.current;
    const currentSnapshot = snapshotRef.current;
    if (
      !activeRef.current ||
      current === undefined ||
      currentSnapshot === undefined ||
      overviewRead.status !== "idle" ||
      currentSnapshot.accountKey !== connectedAccountKey(current) ||
      !selectionMatchesAccount(current, selection)
    ) return false;
    void readExact(current, selection, currentSnapshot.result.viewRevision);
    return true;
  }, [overviewRead.status, readExact]);

  const retryExact = useCallback((): void => {
    const current = accountRef.current;
    const currentSnapshot = snapshotRef.current;
    const failed = exactReadRef.current;
    if (
      !activeRef.current ||
      current === undefined ||
      currentSnapshot === undefined ||
      failed.status !== "error" ||
      failed.accountKey !== currentSnapshot.accountKey ||
      failed.accountKey !== connectedAccountKey(current) ||
      !selectionMatchesAccount(current, failed.selection)
    ) return;
    void readExact(current, failed.selection, currentSnapshot.result.viewRevision);
  }, [readExact]);

  const reconcileAddedSelection = useCallback((): void => {
    closeExact();
    refresh();
  }, [closeExact, refresh]);

  const reconcileRemovedSelection = useCallback((_selection: TokenSelection): void => {
    closeExact();
    refresh();
  }, [closeExact, refresh]);

  useEffect(() => {
    overviewAuthority.activate();
    exactAuthority.activate();
    return () => {
      overviewAuthority.close();
      exactAuthority.close();
    };
  }, [exactAuthority, overviewAuthority]);

  useEffect(() => {
    overviewAuthority.invalidateRead();
    closeExact();
    replaceSnapshot(undefined);
    setOverviewRead(idleOverviewRead);
    const current = accountRef.current;
    if (!active || current === undefined) return;
    void readOverview(current, false);
    return () => { overviewAuthority.invalidateRead(); };
  }, [
    active,
    closeExact,
    overviewAuthority,
    readOverview,
    replaceSnapshot,
    currentAccountKey,
  ]);

  const snapshotRevision = snapshot === undefined
    ? ""
    : revisionKey(snapshot.result.viewRevision);
  useEffect(() => {
    closeExact();
  }, [closeExact, snapshotRevision]);

  const visibleSnapshot =
    active && snapshot?.accountKey === currentAccountKey
      ? snapshot
      : undefined;

  const visibleOverviewRead: AccountAssetOverviewReadState = (() => {
    if (!active || currentAccountKey === undefined) return idleOverviewRead;
    if (overviewRead.status === "idle") {
      return visibleSnapshot === undefined
        ? loadingOverviewRead
        : idleOverviewRead;
    }
    if (overviewRead.accountKey !== currentAccountKey) return loadingOverviewRead;
    return overviewRead.status === "loading"
      ? loadingOverviewRead
      : Object.freeze({
          status: "error",
          failure: overviewRead.failure,
        });
  })();

  const visibleExactRead: AccountAssetExactReadState =
    active &&
    exactRead.status !== "idle" &&
    exactRead.accountKey === currentAccountKey
      ? exactRead
      : idleExactRead;

  return Object.freeze({
    snapshot: visibleSnapshot,
    overviewRead: visibleOverviewRead,
    exactRead: visibleExactRead,
    refresh,
    retryExact,
    openExact,
    closeExact,
    invalidate,
    reconcileAddedSelection,
    reconcileRemovedSelection,
  });
};
