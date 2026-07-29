import {
  type ApplicationFailure,
  type ChainAnchor,
  type EvmAccountIdentity,
} from "../core/index.js";
import type {
  CanonicalBlock,
  ChainInvocationContext,
  OfficialAssetVerificationResult,
} from "../chain/index.js";
import {
  defaultStockTokenManifest,
  defaultStockTokenRank,
  findOfficialAssetMember,
  officialAssetSourceDefinition,
  officialAssetSnapshotEvidenceSchema,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSourceMember,
  type StockFactoryVerification,
} from "../registry/index.js";
import {
  type TokenSelection,
  type TokenSelectionDetail,
  type TokenSelectionState,
} from "../token-catalog/index.js";
import {
  captureConnectedWalletSession,
  type ConnectedWalletSession,
} from "../token-catalog/active-wallet.js";
import {
  accountAssetApplicationContracts,
  accountAssetLimits,
  accountAssetOverviewQueryContract,
  createAccountAssetAmount,
  type AccountAssetRequestContract,
  type AccountAssetClassification,
  type AccountAssetCollectionRequest,
  type AccountAssetCollectionSuccess,
  type AccountAssetCursor,
  type AccountAssetExactInput,
  type AccountAssetExactSuccess,
  type AccountAssetOverviewInput,
  type AccountAssetOverviewSuccess,
  type AccountAssetViewRevision,
  type ContractAccountAsset,
} from "./contracts.js";
import {
  AccountAssetOperationError,
  createAccountAssetFailure,
  normalizeAccountAssetError,
} from "./errors.js";
import type {
  AccountAssetApplicationPort,
  AccountAssetReadProcessDependencies,
} from "./ports.js";

type CapturedWallet = Readonly<{
  account: EvmAccountIdentity;
  connectionRevision: ConnectedWalletSession["connectionRevision"];
  sessionSourceId: string;
}>;

interface OfficialView {
  readonly status: "current" | "unavailable";
  readonly snapshot: CommittedOfficialAssetSnapshot | null;
  readonly storedRevision: CommittedOfficialAssetSnapshot["revision"] | null;
  readonly failureReason: "source_inconsistent" | "source_unavailable" | null;
}

const sameAccount = (left: EvmAccountIdentity, right: EvmAccountIdentity): boolean =>
  left.chainId === right.chainId && left.address === right.address;

const internalFailure = (): ApplicationFailure => createAccountAssetFailure("internal_error");

const normalizeFailure = <Input, Success>(
  contract: AccountAssetRequestContract<Input, Success>,
  error: unknown,
): ApplicationFailure => {
  try {
    return contract.parseFailure(
      error instanceof AccountAssetOperationError
        ? error.failure
        : normalizeAccountAssetError(error).failure,
    );
  } catch {
    return contract.parseFailure(internalFailure());
  }
};

const captureWallet = (dependencies: AccountAssetReadProcessDependencies): CapturedWallet => {
  const captured = captureConnectedWalletSession(dependencies.activeWallet);
  return Object.freeze({
    account: captured.account,
    connectionRevision: captured.connectionRevision,
    sessionSourceId: captured.sessionSource.sourceId,
  });
};

const assertWalletContinuity = (initial: CapturedWallet, final: CapturedWallet): void => {
  if (
    !sameAccount(initial.account, final.account) ||
    initial.connectionRevision !== final.connectionRevision ||
    initial.sessionSourceId !== final.sessionSourceId
  ) throw new AccountAssetOperationError("state_conflict");
};

const ensureNotAborted = (caller: AbortSignal, owner: AbortSignal): void => {
  if (caller.aborted) throw new AccountAssetOperationError("request_aborted");
  if (owner.aborted) throw new AccountAssetOperationError("runtime_state_unavailable");
};

const sourceFailureReason = (failure: ApplicationFailure): OfficialView["failureReason"] => {
  const code: string = failure.error.code;
  return code === "source_inconsistent" || code === "source_unavailable"
    ? code
    : "source_unavailable";
};

const synchronizeOfficialView = async (
  dependencies: AccountAssetReadProcessDependencies,
  signal: AbortSignal,
): Promise<OfficialView> => {
  const result = await dependencies.officialAssets.synchronize(signal);
  if (result.status === "unavailable" && (
    result.failure.error.code === "request_aborted" ||
    result.failure.error.code === "runtime_state_unavailable"
  )) throw new AccountAssetOperationError(result.failure.error.code);
  return result.status === "current"
    ? Object.freeze({
        status: "current",
        snapshot: result.snapshot,
        storedRevision: result.snapshot.revision,
        failureReason: null,
      })
    : Object.freeze({
        status: "unavailable",
        snapshot: null,
        storedRevision: result.storedRevision,
        failureReason: sourceFailureReason(result.failure),
      });
};

const readOfficialView = (
  dependencies: AccountAssetReadProcessDependencies,
  revision: AccountAssetViewRevision,
): OfficialView => {
  const stored = dependencies.officialAssets.readStored();
  if ((stored?.revision ?? null) !== revision.officialSnapshotRevision) {
    throw new AccountAssetOperationError("state_conflict");
  }
  return revision.officialSnapshotStatus === "current"
    ? Object.freeze({
        status: "current",
        snapshot: stored ?? null,
        storedRevision: stored?.revision ?? null,
        failureReason: null,
      })
    : Object.freeze({
        status: "unavailable",
        snapshot: null,
        storedRevision: stored?.revision ?? null,
        failureReason: "source_unavailable",
      });
};

const viewRevision = (
  official: OfficialView,
  state: TokenSelectionState | undefined,
): AccountAssetViewRevision => Object.freeze({
  officialSnapshotStatus: official.status,
  officialSnapshotRevision: official.storedRevision,
  selectionSetRevision: state?.revision ?? null,
});

const cursorViewRevision = (cursor: AccountAssetCursor): AccountAssetViewRevision => Object.freeze({
  officialSnapshotStatus: cursor.officialSnapshotStatus,
  officialSnapshotRevision: cursor.officialSnapshotRevision,
  selectionSetRevision: cursor.selectionSetRevision,
});

const assertViewContinuity = (
  dependencies: AccountAssetReadProcessDependencies,
  wallet: CapturedWallet,
  expected: AccountAssetViewRevision,
): void => {
  assertWalletContinuity(wallet, captureWallet(dependencies));
  if (
    (dependencies.officialAssets.readStored()?.revision ?? null) !== expected.officialSnapshotRevision ||
    (dependencies.selections.getState(wallet.account)?.revision ?? null) !== expected.selectionSetRevision
  ) throw new AccountAssetOperationError("state_conflict");
};

const defaultDetails = (
  dependencies: AccountAssetReadProcessDependencies,
  account: EvmAccountIdentity,
): readonly TokenSelectionDetail[] => Object.freeze(defaultStockTokenManifest.assets.flatMap((entry) => {
  const detail = dependencies.selections.getForAccount({
    account,
    asset: { kind: "erc20", chainId: account.chainId, address: entry.contractAddress },
  });
  return detail?.selection.included === true ? [detail] : [];
}));

const assertCursor = (cursor: AccountAssetCursor, revision: AccountAssetViewRevision): void => {
  if (
    cursor.officialSnapshotStatus !== revision.officialSnapshotStatus ||
    cursor.officialSnapshotRevision !== revision.officialSnapshotRevision ||
    cursor.selectionSetRevision !== revision.selectionSetRevision
  ) throw new AccountAssetOperationError("state_conflict");
  if (cursor.group === "default") {
    const expected = defaultStockTokenManifest.assets[cursor.rank];
    if (expected?.contractAddress !== cursor.address) {
      throw new AccountAssetOperationError("invalid_input");
    }
  } else if (defaultStockTokenRank(cursor.address) !== undefined) {
    throw new AccountAssetOperationError("invalid_input");
  }
};

const pageSelections = (
  dependencies: AccountAssetReadProcessDependencies,
  account: EvmAccountIdentity,
  request: AccountAssetCollectionRequest,
  revision: AccountAssetViewRevision,
): Readonly<{ entries: readonly TokenSelectionDetail[]; nextCursor: AccountAssetCursor | null }> => {
  if (request.cursor !== null) {
    assertCursor(request.cursor, revision);
    if (request.cursor.group === "other") {
      const cursorSelection = dependencies.selections.getForAccount({
        account,
        asset: {
          kind: "erc20",
          chainId: account.chainId,
          address: request.cursor.address,
        },
      });
      if (cursorSelection?.selection.included !== true) {
        throw new AccountAssetOperationError("invalid_input");
      }
    }
  }
  const defaults = defaultDetails(dependencies, account);
  const firstRank = request.cursor?.group === "default" ? request.cursor.rank + 1 :
    request.cursor?.group === "other" ? defaultStockTokenManifest.assets.length : 0;
  const remainingDefaults = defaults.filter((entry) =>
    (defaultStockTokenRank(entry.selection.asset.address) ?? -1) >= firstRank);
  const otherPage = dependencies.selections.listIncludedForAccount({
    account,
    limit: request.limit + 1,
    cursor: request.cursor?.group === "other" ? request.cursor.address : null,
    excludedAddresses: defaultStockTokenManifest.assets.map((entry) => entry.contractAddress),
  });
  const combined = [...remainingDefaults, ...otherPage.selections.map((selection) => {
    const detail = dependencies.selections.getForAccount({ account, asset: selection.asset });
    if (detail === undefined || !detail.selection.included) {
      throw new AccountAssetOperationError("state_conflict");
    }
    return detail;
  })];
  const entries = Object.freeze(combined.slice(0, request.limit));
  const hasMore = combined.length > request.limit || otherPage.nextCursor !== null;
  const last = entries.at(-1);
  const nextCursor: AccountAssetCursor | null = !hasMore || last === undefined
    ? null
    : (() => {
        const rank = defaultStockTokenRank(last.selection.asset.address);
        return rank === undefined
          ? Object.freeze({
              group: "other" as const,
              ...revision,
              address: last.selection.asset.address,
            })
          : Object.freeze({
              group: "default" as const,
              rank,
              ...revision,
              address: last.selection.asset.address,
            });
      })();
  return Object.freeze({ entries, nextCursor });
};

const snapshotEvidence = (snapshot: CommittedOfficialAssetSnapshot) =>
  Object.freeze(officialAssetSnapshotEvidenceSchema.parse({
    sourceUri: snapshot.sourceUri,
    sourceObservedAt: snapshot.sourceObservedAt,
    rawResponseDigest: snapshot.rawResponseDigest,
    memberSetDigest: snapshot.memberSetDigest,
    revision: snapshot.revision,
  }));

const classification = (
  official: OfficialView,
  asset: TokenSelection["asset"],
  result: OfficialAssetVerificationResult | undefined,
): AccountAssetClassification => {
  if (official.status === "unavailable" || official.snapshot === null) {
    return Object.freeze({
      kind: "classification_unavailable",
      storedRevision: official.storedRevision,
      snapshot: null,
      member: null,
      reason: official.failureReason ?? "source_unavailable",
    });
  }
  const member = findOfficialAssetMember(official.snapshot, asset.address);
  if (member === undefined) {
    return Object.freeze({ kind: "custom_erc20", snapshot: snapshotEvidence(official.snapshot) });
  }
  if (result?.status !== "verified") {
    return Object.freeze({
      kind: "classification_unavailable",
      storedRevision: official.snapshot.revision,
      snapshot: snapshotEvidence(official.snapshot),
      member: {
        assetUid: member.assetUid,
        contractAddress: member.contractAddress,
        sourceName: member.sourceName ?? null,
        sourceSymbol: member.sourceSymbol ?? null,
      },
      reason: result?.reason ?? "source_inconsistent",
    });
  }
  return Object.freeze({
    kind: "robinhood_stock_token",
    snapshot: snapshotEvidence(official.snapshot),
    member: {
      assetUid: member.assetUid,
      contractAddress: member.contractAddress,
      sourceName: member.sourceName ?? null,
      sourceSymbol: member.sourceSymbol ?? null,
    },
    verification: result.verification,
  });
};

const verifyVisibleMembers = async (
  dependencies: AccountAssetReadProcessDependencies,
  official: OfficialView,
  selections: readonly TokenSelectionDetail[],
  block: CanonicalBlock,
  context: ChainInvocationContext,
  retained: ReadonlyMap<string, OfficialAssetVerificationResult> = new Map(),
): Promise<ReadonlyMap<string, OfficialAssetVerificationResult>> => {
  if (official.status !== "current" || official.snapshot === null) return new Map();
  const results = new Map<string, OfficialAssetVerificationResult>();
  const pending: OfficialAssetSourceMember[] = [];
  for (const detail of selections) {
    const address = detail.selection.asset.address;
    const member = findOfficialAssetMember(official.snapshot, address);
    if (member === undefined) continue;
    const prior = retained.get(address);
    if (prior !== undefined) results.set(address, prior);
    else pending.push(member);
  }
  const verified = pending.length === 0
    ? []
    : await dependencies.officialAssetReads.verifyManyAtBlock(pending, block, context);
  pending.forEach((member, index) => {
    const result = verified[index];
    if (result === undefined) throw new AccountAssetOperationError("internal_error");
    results.set(member.contractAddress, result);
  });
  return results;
};

const initializeDefaults = async (
  dependencies: AccountAssetReadProcessDependencies,
  wallet: CapturedWallet,
  official: OfficialView,
  block: CanonicalBlock,
  pageLimit: number,
  context: ChainInvocationContext,
): Promise<ReadonlyMap<string, OfficialAssetVerificationResult>> => {
  if (official.status !== "current" || official.snapshot === null) return new Map();
  const state = dependencies.selections.getState(wallet.account);
  if (state?.defaultsInitialized === true) return new Map();
  const missingMembers: OfficialAssetSourceMember[] = [];
  const includedDefaults: string[] = [];
  for (const entry of defaultStockTokenManifest.assets) {
    const member = findOfficialAssetMember(official.snapshot!, entry.contractAddress);
    const existing = dependencies.selections.getForAccount({
      account: wallet.account,
      asset: { kind: "erc20", chainId: wallet.account.chainId, address: entry.contractAddress },
    });
    if (existing?.selection.included === true) includedDefaults.push(entry.contractAddress);
    else if (member !== undefined && existing === undefined) {
      missingMembers.push(member);
      includedDefaults.push(entry.contractAddress);
    }
  }
  const other = dependencies.selections.listIncludedForAccount({
    account: wallet.account,
    limit: pageLimit,
    cursor: null,
    excludedAddresses: defaultStockTokenManifest.assets.map((entry) => entry.contractAddress),
  });
  const visibleAddresses = [...includedDefaults, ...other.selections.map((entry) => entry.asset.address)]
    .slice(0, pageLimit);
  const verificationMembers = new Map<string, OfficialAssetSourceMember>();
  for (const member of missingMembers) verificationMembers.set(member.contractAddress, member);
  for (const address of visibleAddresses) {
    const member = findOfficialAssetMember(official.snapshot, address as TokenSelection["asset"]["address"]);
    if (member !== undefined) verificationMembers.set(member.contractAddress, member);
  }
  const members = [...verificationMembers.values()];
  const results = members.length === 0
    ? []
    : await dependencies.officialAssetReads.verifyManyAtBlock(members, block, context);
  const resultByAddress = new Map(members.map((member, index) => {
    const result = results[index];
    if (result === undefined) throw new AccountAssetOperationError("internal_error");
    return [member.contractAddress, result] as const;
  }));
  if (missingMembers.some((member) => resultByAddress.get(member.contractAddress)?.status !== "verified")) {
    throw new AccountAssetOperationError("source_inconsistent");
  }
  const verifiedDefaults = missingMembers.map((member) => ({
    asset: {
      kind: "erc20" as const,
      chainId: wallet.account.chainId,
      address: member.contractAddress,
    },
    verification: (resultByAddress.get(member.contractAddress) as Extract<
      OfficialAssetVerificationResult,
      { status: "verified" }
    >).verification,
  }));
  dependencies.selections.initializeDefaults({
    account: wallet.account,
    expectedConnectionRevision: wallet.connectionRevision,
    snapshotRevision: official.snapshot.revision,
    verifiedDefaults,
    now: dependencies.clock.now(),
  });
  return resultByAddress;
};

const contractAsset = (
  detail: TokenSelectionDetail,
  read: Awaited<ReturnType<AccountAssetReadProcessDependencies["chainReads"]["readCollectionAtBlock"]>>["tokens"][number],
  official: OfficialView,
  verification: OfficialAssetVerificationResult | undefined,
): ContractAccountAsset => Object.freeze({
  kind: "erc20",
  selection: detail.selection,
  name: read.name,
  symbol: read.symbol,
  classification: classification(official, detail.selection.asset, verification),
  amount: createAccountAssetAmount({
    raw: read.rawBalance,
    decimals: read.decimals,
    multiplier: read.requiredStandards.values?.currentMultiplier ?? null,
  }),
  requiredStandards: read.requiredStandards,
});

const selectedOfficialDetails = (
  dependencies: AccountAssetReadProcessDependencies,
  account: EvmAccountIdentity,
  official: OfficialView,
): readonly TokenSelectionDetail[] => {
  if (official.snapshot === null) throw new AccountAssetOperationError("source_unavailable");
  const selected: TokenSelectionDetail[] = [];
  for (const member of official.snapshot.members) {
    const detail = dependencies.selections.getForAccount({
      account,
      asset: {
        kind: "erc20",
        chainId: account.chainId,
        address: member.contractAddress,
      },
    });
    if (detail?.selection.included === true) selected.push(detail);
  }
  if (selected.length > officialAssetSourceDefinition.memberLimit) {
    throw new AccountAssetOperationError("internal_error");
  }
  return Object.freeze(selected);
};

export const createAccountAssetApplication = (
  dependencies: AccountAssetReadProcessDependencies,
): Readonly<AccountAssetApplicationPort & { close(): Promise<void> }> => {
  const ownerAbort = new AbortController();
  const active = new Set<Promise<unknown>>();
  let state: "open" | "closing" | "closed" = "open";
  let closePromise: Promise<void> | undefined;
  const abortFromParent = (): void => ownerAbort.abort();
  if (dependencies.signal.aborted) ownerAbort.abort();
  else dependencies.signal.addEventListener("abort", abortFromParent, { once: true });

  const run = <Input, Success>(
    contract: AccountAssetRequestContract<Input, Success>,
    inputValue: unknown,
    callerSignal: AbortSignal | undefined,
    effect: (request: Input, signal: AbortSignal) => Promise<Success>,
  ): Promise<Success | ApplicationFailure> => {
    let request: Input;
    try { request = contract.parseInput(inputValue); }
    catch { return Promise.resolve(contract.parseFailure(createAccountAssetFailure("invalid_input"))); }
    const caller = callerSignal ?? new AbortController().signal;
    if (state !== "open" || ownerAbort.signal.aborted) {
      return Promise.resolve(contract.parseFailure(createAccountAssetFailure("runtime_state_unavailable")));
    }
    const signal = AbortSignal.any([caller, ownerAbort.signal]);
    const invocation = (async () => {
      try {
        ensureNotAborted(caller, ownerAbort.signal);
        const success = await effect(request, signal);
        ensureNotAborted(caller, ownerAbort.signal);
        return contract.parsePublicSuccess(request, success);
      } catch (error) {
        if (caller.aborted) return contract.parseFailure(createAccountAssetFailure("request_aborted"));
        if (ownerAbort.signal.aborted) {
          return contract.parseFailure(createAccountAssetFailure("runtime_state_unavailable"));
        }
        return normalizeFailure(contract, error);
      }
    })();
    active.add(invocation);
    void invocation.finally(() => active.delete(invocation));
    return invocation;
  };

  const application: AccountAssetApplicationPort = {
    list(inputValue, callerSignal) {
      return run(
        accountAssetApplicationContracts.collection,
        inputValue,
        callerSignal,
        async (request: AccountAssetCollectionRequest, signal): Promise<AccountAssetCollectionSuccess> => {
          const wallet = captureWallet(dependencies);
          const firstPage = request.cursor === null;
          const official = firstPage
            ? await synchronizeOfficialView(dependencies, signal)
            : readOfficialView(dependencies, request.cursor!);
          return dependencies.chainInvocations.run(signal, async (context) => {
            const block = await dependencies.chainReads.resolveCurrentBlock(context);
            const retained = firstPage
              ? await initializeDefaults(dependencies, wallet, official, block, request.limit, context)
              : new Map<string, OfficialAssetVerificationResult>();
            const revision: AccountAssetViewRevision = firstPage
              ? viewRevision(official, dependencies.selections.getState(wallet.account))
              : cursorViewRevision(request.cursor!);
            const page = pageSelections(dependencies, wallet.account, request, revision);
            const verification = await verifyVisibleMembers(
              dependencies,
              official,
              page.entries,
              block,
              context,
              retained,
            );
            const chain = await dependencies.chainReads.readCollectionAtBlock({
              account: wallet.account,
              assets: page.entries.map((entry) => entry.selection.asset),
              block,
            }, context);
            if (chain.tokens.length !== page.entries.length) {
              throw new AccountAssetOperationError("internal_error");
            }
            assertViewContinuity(dependencies, wallet, revision);
            return Object.freeze({
              account: wallet.account,
              block: block.anchor,
              viewRevision: revision,
              native: {
                kind: "native",
                asset: { kind: "native", chainId: wallet.account.chainId },
                rawBalance: chain.nativeRawBalance,
                classification: "native",
              },
              assets: page.entries.map((entry, index) => contractAsset(
                entry,
                chain.tokens[index]!,
                official,
                verification.get(entry.selection.asset.address),
              )),
              nextCursor: page.nextCursor,
            });
          });
        },
      );
    },

    getOverview(inputValue, callerSignal) {
      return run(
        accountAssetOverviewQueryContract,
        inputValue,
        callerSignal,
        async (_request: AccountAssetOverviewInput, signal): Promise<AccountAssetOverviewSuccess> => {
          const wallet = captureWallet(dependencies);
          const official = await synchronizeOfficialView(dependencies, signal);
          return dependencies.chainInvocations.run(signal, async (context) => {
            const block = await dependencies.chainReads.resolveCurrentBlock(context);
            const retained = await initializeDefaults(
              dependencies,
              wallet,
              official,
              block,
              accountAssetLimits.maximumPageSize,
              context,
            );
            const revision = viewRevision(
              official,
              dependencies.selections.getState(wallet.account),
            );
            const entries = official.status === "current"
              ? selectedOfficialDetails(dependencies, wallet.account, official)
              : [];
            const verification = await verifyVisibleMembers(
              dependencies,
              official,
              entries,
              block,
              context,
              retained,
            );
            const chain = await dependencies.chainReads.readCollectionAtBlock({
              account: wallet.account,
              assets: entries.map((entry) => entry.selection.asset),
              block,
            }, context);
            if (chain.tokens.length !== entries.length) {
              throw new AccountAssetOperationError("internal_error");
            }
            const selectedByAddress = new Map(
              entries.map((entry, index) => [
                entry.selection.asset.address,
                contractAsset(
                  entry,
                  chain.tokens[index]!,
                  official,
                  verification.get(entry.selection.asset.address),
                ),
              ]),
            );
            assertViewContinuity(dependencies, wallet, revision);
            return Object.freeze({
              account: wallet.account,
              block: block.anchor,
              viewRevision: revision,
              native: {
                kind: "native",
                asset: { kind: "native", chainId: wallet.account.chainId },
                rawBalance: chain.nativeRawBalance,
                classification: "native",
              },
              stockTokens: official.status === "current"
                ? {
                    status: "current" as const,
                    candidateListDigest: official.snapshot!.candidateListDigest,
                    members: official.snapshot!.members.map((member) => {
                      const asset = selectedByAddress.get(member.contractAddress);
                      return asset === undefined
                        ? Object.freeze({
                            status: "available_to_add" as const,
                            candidate: Object.freeze({
                              assetUid: member.assetUid,
                              contractAddress: member.contractAddress,
                              sourceName: member.sourceName ?? null,
                              sourceSymbol: member.sourceSymbol ?? null,
                            }),
                          })
                        : Object.freeze({
                            status: "selected" as const,
                            asset,
                          });
                    }),
                  }
                : {
                    status: "unavailable" as const,
                    reason: official.failureReason ?? "source_unavailable",
                  },
            });
          });
        },
      );
    },

    get(inputValue, callerSignal) {
      return run(
        accountAssetApplicationContracts.exact,
        inputValue,
        callerSignal,
        async (request: AccountAssetExactInput, signal): Promise<AccountAssetExactSuccess> => {
          const wallet = captureWallet(dependencies);
          if (request.asset.chainId !== wallet.account.chainId ||
            request.viewRevision.selectionSetRevision === null) {
            throw new AccountAssetOperationError("invalid_input");
          }
          const state = dependencies.selections.getState(wallet.account);
          if (state?.revision !== request.viewRevision.selectionSetRevision) {
            throw new AccountAssetOperationError("state_conflict");
          }
          const detail = dependencies.selections.getForAccount({
            account: wallet.account,
            asset: request.asset,
          });
          if (detail === undefined || !detail.selection.included) {
            throw new AccountAssetOperationError("token_selection_not_found");
          }
          const official = readOfficialView(dependencies, request.viewRevision);
          return dependencies.chainInvocations.run(signal, async (context) => {
            const block = await dependencies.chainReads.resolveCurrentBlock(context);
            const verification = await verifyVisibleMembers(
              dependencies,
              official,
              [detail],
              block,
              context,
            );
            const chain = await dependencies.chainReads.readExactAtBlock({
              account: wallet.account,
              asset: detail.selection.asset,
              block,
            }, context);
            assertViewContinuity(dependencies, wallet, request.viewRevision);
            return Object.freeze({
              account: wallet.account,
              block: block.anchor,
              viewRevision: request.viewRevision,
              asset: contractAsset(
                detail,
                chain,
                official,
                verification.get(detail.selection.asset.address),
              ),
              totalSupply: chain.totalSupply,
              standards: chain.standards,
            });
          });
        },
      );
    },
  };

  return Object.freeze({
    ...application,
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      state = "closing";
      ownerAbort.abort();
      dependencies.signal.removeEventListener("abort", abortFromParent);
      closePromise = Promise.allSettled([...active]).then(() => { state = "closed"; });
      return closePromise;
    },
  });
};
