import {type ApplicationFailure} from "../core/index.js";
import {type ChainAnchor} from "../evm/primitives.js";
import {type EvmAccountIdentity} from "../evm/identities.js";
import type {
  CanonicalBlock,
  ChainInvocationContext,
} from "../chain/index.js";
import {
  requireAvailableAddressTarget,
  sameResolvedAddressTarget,
  type ResolvedAddressTarget,
} from "../chain/address-target.js";
import {
  defaultStockTokenManifest,
  findOfficialAssetMember,
  projectOfficialAssetSnapshotEvidence,
  type CommittedOfficialAssetSnapshot,
  type OfficialAssetSnapshotEvidence,
  type OfficialAssetSourceMember,
  type StockFactoryVerificationResult,
} from "../registry/index.js";
import {
  type DefaultTokenSelectionVerification,
  type TokenSelection,
  type TokenSelectionState,
} from "../token-catalog/index.js";
import {
  accountAssetApplicationContracts,
  accountAssetPositionForAddress,
  compareAccountAssetPositions,
  createAccountAssetAmount,
  type AccountAssetRequestContract,
  type AccountAssetClassification,
  type AccountAssetCollectionRequest,
  type AccountAssetCollectionSuccess,
  type AccountAssetCursor,
  type AccountAssetOfficialSnapshotUnavailableReason,
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

type OfficialView =
  | Readonly<{
      status: "current";
      snapshot: CommittedOfficialAssetSnapshot;
      evidence: OfficialAssetSnapshotEvidence;
    }>
  | Readonly<{
      status: "unavailable";
      storedRevision: CommittedOfficialAssetSnapshot["revision"] | null;
      failureReason: AccountAssetOfficialSnapshotUnavailableReason;
    }>;

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

const resolveTarget = async (
  dependencies: AccountAssetReadProcessDependencies,
  target: AccountAssetCollectionRequest["account"],
  signal: AbortSignal,
): Promise<ResolvedAddressTarget> => requireAvailableAddressTarget(
  await dependencies.addressTargets.resolve(target, signal),
);

const assertTargetContinuity = async (
  dependencies: AccountAssetReadProcessDependencies,
  initial: ResolvedAddressTarget,
  signal: AbortSignal,
): Promise<void> => {
  if (!initial.active) return;
  try {
    const current = requireAvailableAddressTarget(
      await dependencies.addressTargets.resolve(initial.target, signal),
    );
    if (!sameResolvedAddressTarget(initial, current)) {
      throw new AccountAssetOperationError("state_conflict");
    }
  } catch {
    throw new AccountAssetOperationError("state_conflict");
  }
};

const ensureNotAborted = (caller: AbortSignal, owner: AbortSignal): void => {
  if (caller.aborted) throw new AccountAssetOperationError("request_aborted");
  if (owner.aborted) throw new AccountAssetOperationError("runtime_state_unavailable");
};

const synchronizeOfficialView = async (
  dependencies: AccountAssetReadProcessDependencies,
  signal: AbortSignal,
): Promise<OfficialView> => {
  const result = await dependencies.officialAssets.synchronize(signal);
  if (result.status === "current") {
    return Object.freeze({
      status: "current",
      snapshot: result.snapshot,
      evidence: projectOfficialAssetSnapshotEvidence(result.snapshot),
    });
  }
  switch (result.reason) {
    case "request_aborted":
    case "runtime_state_unavailable":
      throw new AccountAssetOperationError(result.reason);
    case "official_asset_response_too_large":
    case "official_asset_response_unavailable":
    case "rate_limited":
    case "source_inconsistent":
    case "source_unavailable":
      return Object.freeze({
        status: "unavailable",
        storedRevision: result.storedRevision,
        failureReason: result.reason,
      });
  }
};

const readOfficialView = (
  dependencies: AccountAssetReadProcessDependencies,
  revision: AccountAssetViewRevision,
  admittedView: OfficialView | undefined,
): OfficialView => {
  const stored = dependencies.officialAssets.readStored();
  if ((stored?.revision ?? null) !== revision.officialSnapshotRevision) {
    throw new AccountAssetOperationError("state_conflict");
  }
  if (revision.officialSnapshotStatus === "current") {
    if (
      stored === undefined ||
      admittedView?.status !== "current" ||
      admittedView.snapshot.revision !== revision.officialSnapshotRevision
    ) throw new AccountAssetOperationError("state_conflict");
    return admittedView;
  }
  if (
    admittedView?.status !== "unavailable" ||
    admittedView.storedRevision !== revision.officialSnapshotRevision ||
    admittedView.failureReason !== revision.officialSnapshotUnavailableReason
  ) throw new AccountAssetOperationError("state_conflict");
  return admittedView;
};

const viewRevision = (
  account: EvmAccountIdentity,
  official: OfficialView,
  state: TokenSelectionState | undefined,
): AccountAssetViewRevision => official.status === "current"
  ? Object.freeze({
      account,
      officialSnapshotStatus: "current",
      officialSnapshotRevision: official.snapshot.revision,
      selectionSetRevision: state?.revision ?? null,
    })
  : Object.freeze({
      account,
      officialSnapshotStatus: "unavailable",
      officialSnapshotRevision: official.storedRevision,
      officialSnapshotUnavailableReason: official.failureReason,
      selectionSetRevision: state?.revision ?? null,
    });

const cursorViewRevision = (cursor: AccountAssetCursor): AccountAssetViewRevision =>
  cursor.officialSnapshotStatus === "current"
    ? Object.freeze({
        account: cursor.account,
        officialSnapshotStatus: "current",
        officialSnapshotRevision: cursor.officialSnapshotRevision,
        selectionSetRevision: cursor.selectionSetRevision,
      })
    : Object.freeze({
        account: cursor.account,
        officialSnapshotStatus: "unavailable",
        officialSnapshotRevision: cursor.officialSnapshotRevision,
        officialSnapshotUnavailableReason: cursor.officialSnapshotUnavailableReason,
        selectionSetRevision: cursor.selectionSetRevision,
      });

const assertViewContinuity = (
  dependencies: AccountAssetReadProcessDependencies,
  target: ResolvedAddressTarget,
  expected: AccountAssetViewRevision,
  admittedView: OfficialView | undefined,
): void => {
  if (
    target.account.chainId !== expected.account.chainId ||
    target.account.address !== expected.account.address ||
    (dependencies.selections.getState(target.account)?.revision ?? null) !==
    expected.selectionSetRevision) throw new AccountAssetOperationError("state_conflict");
  readOfficialView(dependencies, expected, admittedView);
};

const assertCursor = (cursor: AccountAssetCursor, revision: AccountAssetViewRevision): void => {
  if (
    cursor.account.chainId !== revision.account.chainId ||
    cursor.account.address !== revision.account.address ||
    cursor.officialSnapshotStatus !== revision.officialSnapshotStatus ||
    cursor.officialSnapshotRevision !== revision.officialSnapshotRevision ||
    cursor.selectionSetRevision !== revision.selectionSetRevision ||
    (cursor.officialSnapshotStatus === "unavailable" &&
      revision.officialSnapshotStatus === "unavailable" &&
      cursor.officialSnapshotUnavailableReason !== revision.officialSnapshotUnavailableReason)
  ) throw new AccountAssetOperationError("state_conflict");
  if (compareAccountAssetPositions(cursor, accountAssetPositionForAddress(cursor.address)) !== 0) {
    throw new AccountAssetOperationError("invalid_input");
  }
};

type PreparedSelection = TokenSelection | DefaultTokenSelectionVerification;

interface PreparedSelectionPage {
  readonly entries: readonly PreparedSelection[];
  readonly hasMore: boolean;
}

const prepareSelectionPage = (
  dependencies: AccountAssetReadProcessDependencies,
  account: EvmAccountIdentity,
  request: AccountAssetCollectionRequest,
  revision: AccountAssetViewRevision,
  preparedDefaults: PreparedDefaultInitialization,
): PreparedSelectionPage => {
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
  const pendingDefaults = new Map(
    (preparedDefaults.commit?.verifiedDefaults ?? []).map((entry) => [entry.asset.address, entry]),
  );
  const firstRank = request.cursor?.group === "default" ? request.cursor.rank + 1 :
    request.cursor?.group === "other" ? defaultStockTokenManifest.assets.length : 0;
  const defaults = defaultStockTokenManifest.assets.flatMap<PreparedSelection>((entry, rank) => {
    if (rank < firstRank) return [];
    const detail = dependencies.selections.getForAccount({
      account,
      asset: { kind: "erc20", chainId: account.chainId, address: entry.contractAddress },
    });
    if (detail !== undefined) return detail.selection.included ? [detail.selection] : [];
    const pending = pendingDefaults.get(entry.contractAddress);
    return pending === undefined ? [] : [pending];
  });
  const otherPage = dependencies.selections.listIncludedForAccount({
    account,
    limit: request.limit + 1,
    cursor: request.cursor?.group === "other" ? request.cursor.address : null,
    excludedAddresses: defaultStockTokenManifest.assets.map((entry) => entry.contractAddress),
  });
  const combined = [...defaults, ...otherPage.selections];
  const positions = combined.map((entry) => accountAssetPositionForAddress(entry.asset.address));
  if (positions.some((position, index) =>
    (index > 0 && compareAccountAssetPositions(positions[index - 1]!, position) >= 0) ||
    (request.cursor !== null && compareAccountAssetPositions(position, request.cursor) <= 0)
  )) throw new AccountAssetOperationError("internal_error");
  const entries = Object.freeze(combined.slice(0, request.limit));
  const hasMore = combined.length > request.limit || otherPage.nextCursor !== null;
  return Object.freeze({ entries, hasMore });
};

const pageCursor = (
  page: PreparedSelectionPage,
  revision: AccountAssetViewRevision,
): AccountAssetCursor | null => {
  const last = page.entries.at(-1);
  return !page.hasMore || last === undefined
    ? null
    : Object.freeze({ ...revision, ...accountAssetPositionForAddress(last.asset.address) });
};

const classification = (
  official: OfficialView,
  asset: TokenSelection["asset"],
  result: StockFactoryVerificationResult | undefined,
): AccountAssetClassification => {
  if (official.status === "unavailable") {
    return Object.freeze({
      kind: "classification_unavailable",
      cause: Object.freeze({
        kind: "official_snapshot_unavailable",
        storedRevision: official.storedRevision,
        reason: official.failureReason,
      }),
    });
  }
  const member = findOfficialAssetMember(official.snapshot, asset.address);
  if (member === undefined) {
    return Object.freeze({
      kind: "custom_erc20",
      snapshot: official.evidence,
    });
  }
  if (result === undefined) throw new AccountAssetOperationError("internal_error");
  if (result.status !== "verified") {
    return Object.freeze({
      kind: "classification_unavailable",
      cause: Object.freeze({
        kind: "stock_factory_verification_unavailable",
        snapshot: official.evidence,
        member: {
          assetUid: member.assetUid,
          contractAddress: member.contractAddress,
          sourceName: member.sourceName ?? null,
          sourceSymbol: member.sourceSymbol ?? null,
        },
        reason: result.reason,
      }),
    });
  }
  return Object.freeze({
    kind: "robinhood_stock_token",
    snapshot: official.evidence,
    member: {
      assetUid: member.assetUid,
      contractAddress: member.contractAddress,
      sourceName: member.sourceName ?? null,
      sourceSymbol: member.sourceSymbol ?? null,
    },
    verification: result.verification,
  });
};

const verificationResultsByAddress = (
  members: readonly OfficialAssetSourceMember[],
  inputs: readonly StockFactoryVerificationResult[],
): ReadonlyMap<string, StockFactoryVerificationResult> => {
  if (inputs.length !== members.length) {
    throw new AccountAssetOperationError("internal_error");
  }
  const results = new Map<string, StockFactoryVerificationResult>();
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    const result = inputs[index];
    if (
      member === undefined ||
      result === undefined ||
      result.member.assetUid !== member.assetUid ||
      result.member.contractAddress !== member.contractAddress
    ) throw new AccountAssetOperationError("internal_error");
    results.set(member.contractAddress, result);
  }
  return results;
};

const verifyVisibleMembers = async (
  dependencies: AccountAssetReadProcessDependencies,
  official: OfficialView,
  assets: readonly TokenSelection["asset"][],
  block: CanonicalBlock,
  context: ChainInvocationContext,
  retained: ReadonlyMap<string, StockFactoryVerificationResult> = new Map(),
): Promise<ReadonlyMap<string, StockFactoryVerificationResult>> => {
  if (official.status !== "current") return new Map();
  const results = new Map<string, StockFactoryVerificationResult>();
  const pending: OfficialAssetSourceMember[] = [];
  for (const asset of assets) {
    const address = asset.address;
    const member = findOfficialAssetMember(official.snapshot, address);
    if (member === undefined) continue;
    const prior = retained.get(address);
    if (prior !== undefined) results.set(address, prior);
    else pending.push(member);
  }
  const verified = pending.length === 0
    ? []
    : await dependencies.officialAssetReads.verifyManyAtBlock(pending, block, context);
  for (const [address, result] of verificationResultsByAddress(pending, verified)) {
    results.set(address, result);
  }
  return results;
};

interface PreparedDefaultInitialization {
  readonly commit: null | Readonly<{
    snapshotRevision: CommittedOfficialAssetSnapshot["revision"];
    verifiedDefaults: Parameters<
      AccountAssetReadProcessDependencies["selections"]["initializeDefaults"]
    >[0]["verifiedDefaults"];
  }>;
  readonly verification: ReadonlyMap<string, StockFactoryVerificationResult>;
}

const prepareDefaultInitialization = async (
  dependencies: AccountAssetReadProcessDependencies,
  account: EvmAccountIdentity,
  retainedAccount: boolean,
  official: OfficialView,
  block: CanonicalBlock,
  context: ChainInvocationContext,
): Promise<PreparedDefaultInitialization> => {
  if (!retainedAccount || official.status !== "current") {
    return Object.freeze({ commit: null, verification: new Map() });
  }
  const state = dependencies.selections.getState(account);
  if (state?.defaultsInitialized === true) {
    return Object.freeze({ commit: null, verification: new Map() });
  }
  const missingMembers: OfficialAssetSourceMember[] = [];
  for (const entry of defaultStockTokenManifest.assets) {
    const member = findOfficialAssetMember(official.snapshot, entry.contractAddress);
    const existing = dependencies.selections.getForAccount({
      account,
      asset: { kind: "erc20", chainId: account.chainId, address: entry.contractAddress },
    });
    if (member !== undefined && existing === undefined) missingMembers.push(member);
  }
  const results = missingMembers.length === 0
    ? []
    : await dependencies.officialAssetReads.verifyManyAtBlock(missingMembers, block, context);
  const resultByAddress = verificationResultsByAddress(missingMembers, results);
  const verifiedDefaults = missingMembers.flatMap((member) => {
    const result = resultByAddress.get(member.contractAddress);
    return result?.status === "verified"
      ? [{
          asset: {
            kind: "erc20" as const,
            chainId: account.chainId,
            address: member.contractAddress,
          },
          verification: result.verification,
        }]
      : [];
  });
  return Object.freeze({
    commit: verifiedDefaults.length === missingMembers.length
      ? Object.freeze({
          snapshotRevision: official.snapshot.revision,
          verifiedDefaults: Object.freeze(verifiedDefaults),
        })
      : null,
    verification: resultByAddress,
  });
};

const contractAsset = (
  selection: TokenSelection,
  read: Awaited<ReturnType<AccountAssetReadProcessDependencies["chainReads"]["readCollectionAtBlock"]>>["tokens"][number],
  official: OfficialView,
  verification: StockFactoryVerificationResult | undefined,
): ContractAccountAsset => Object.freeze({
  kind: "erc20",
  selection,
  name: read.name,
  symbol: read.symbol,
  classification: classification(official, selection.asset, verification),
  amount: createAccountAssetAmount({
    raw: read.rawBalance,
    decimals: read.decimals,
    multiplier: read.requiredStandards.values?.currentMultiplier ?? null,
  }),
  requiredStandards: read.requiredStandards,
});

export const createAccountAssetApplication = (
  dependencies: AccountAssetReadProcessDependencies,
): Readonly<AccountAssetApplicationPort & { close(): Promise<void> }> => {
  const ownerAbort = new AbortController();
  const active = new Set<Promise<unknown>>();
  let state: "open" | "closing" | "closed" = "open";
  let closePromise: Promise<void> | undefined;
  let admittedOfficialView: OfficialView | undefined;
  const abortFromParent = (): void => ownerAbort.abort();
  if (dependencies.signal.aborted) ownerAbort.abort();
  else dependencies.signal.addEventListener("abort", abortFromParent, { once: true });

  const synchronizeOfficial = async (signal: AbortSignal): Promise<OfficialView> => {
    const official = await synchronizeOfficialView(dependencies, signal);
    admittedOfficialView = official;
    return official;
  };

  const readAdmittedOfficialView = (revision: AccountAssetViewRevision): OfficialView =>
    readOfficialView(dependencies, revision, admittedOfficialView);

  type PreparedCollection = Readonly<{
    target: ResolvedAddressTarget;
    official: OfficialView;
    block: CanonicalBlock;
    expectedRevision: AccountAssetViewRevision;
    preparedDefaults: PreparedDefaultInitialization;
    page: PreparedSelectionPage;
    verification: ReadonlyMap<string, StockFactoryVerificationResult>;
    chain: Awaited<ReturnType<
      AccountAssetReadProcessDependencies["chainReads"]["readCollectionAtBlock"]
    >>;
  }>;

  const prepareCollection = async (
    request: AccountAssetCollectionRequest,
    signal: AbortSignal,
  ): Promise<PreparedCollection> => {
    const target = await resolveTarget(dependencies, request.account, signal);
    const firstPage = request.cursor === null;
    const official = firstPage
      ? await synchronizeOfficial(signal)
      : readAdmittedOfficialView(request.cursor!);
    if (!firstPage) {
      const cursor = request.cursor!;
      if (
        cursor.account.chainId !== target.account.chainId ||
        cursor.account.address !== target.account.address
      ) throw new AccountAssetOperationError("state_conflict");
    }
    return dependencies.chainInvocations.run(signal, async (context) => {
      const block = await dependencies.currentBlockReads.resolveCurrentBlock(context);
      const retainedAccount = dependencies.selections.isAccountRetained(target.account);
      const preparedDefaults = firstPage
        ? await prepareDefaultInitialization(
            dependencies,
            target.account,
            retainedAccount,
            official,
            block,
            context,
          )
        : Object.freeze({ commit: null, verification: new Map() });
      const expectedRevision = firstPage
        ? viewRevision(
            target.account,
            official,
            dependencies.selections.getState(target.account),
          )
        : cursorViewRevision(request.cursor!);
      const page = prepareSelectionPage(
        dependencies,
        target.account,
        request,
        expectedRevision,
        preparedDefaults,
      );
      const plannedAssets = page.entries.map((entry) => entry.asset);
      const verification = await verifyVisibleMembers(
        dependencies,
        official,
        plannedAssets,
        block,
        context,
        preparedDefaults.verification,
      );
      const chain = await dependencies.chainReads.readCollectionAtBlock({
        account: target.account,
        assets: plannedAssets,
        block,
      }, context);
      if (chain.tokens.length !== plannedAssets.length) {
        throw new AccountAssetOperationError("internal_error");
      }
      return Object.freeze({
        target,
        official,
        block,
        expectedRevision,
        preparedDefaults,
        page,
        verification,
        chain,
      });
    }) as Promise<PreparedCollection>;
  };

  const finalizeCollection = (
    contract: typeof accountAssetApplicationContracts.collection,
    request: AccountAssetCollectionRequest,
    prepared: PreparedCollection,
  ): AccountAssetCollectionSuccess => {
    assertViewContinuity(
      dependencies,
      prepared.target,
      prepared.expectedRevision,
      admittedOfficialView,
    );
    const defaultCommit = prepared.preparedDefaults.commit;
    const committed = defaultCommit === null ? undefined :
      dependencies.selections.initializeDefaults({
        account: prepared.target.account,
        snapshotRevision: defaultCommit.snapshotRevision,
        verifiedDefaults: defaultCommit.verifiedDefaults,
        now: dependencies.clock.now(),
      });
    const revision = committed !== undefined
      ? viewRevision(
          prepared.target.account,
          prepared.official,
          committed.state,
        )
      : prepared.expectedRevision;
    const inserted = new Map((committed?.selections ?? []).map((entry) => [entry.asset.address, entry]));
    const selections = prepared.page.entries.map((entry) => {
      if (!("verification" in entry)) return entry;
      const selection = inserted.get(entry.asset.address);
      if (selection === undefined) throw new AccountAssetOperationError("internal_error");
      return selection;
    });
    const success = Object.freeze({
      account: prepared.target.account,
      block: prepared.block.anchor,
      viewRevision: revision,
      native: {
        kind: "native" as const,
        asset: { kind: "native" as const, chainId: prepared.target.account.chainId },
        rawBalance: prepared.chain.nativeRawBalance,
        classification: "native" as const,
      },
      assets: selections.map((entry, index) => contractAsset(
        entry,
        prepared.chain.tokens[index]!,
        prepared.official,
        prepared.verification.get(entry.asset.address),
      )),
      nextCursor: pageCursor(prepared.page, revision),
    });
    return contract.parsePublicSuccess(request, success);
  };

  const runCollection = (
    inputValue: unknown,
    callerSignal: AbortSignal | undefined,
  ): Promise<AccountAssetCollectionSuccess | ApplicationFailure> => {
    const contract = accountAssetApplicationContracts.collection;
    let request: AccountAssetCollectionRequest;
    try { request = contract.parseInput(inputValue); }
    catch { return Promise.resolve(contract.parseFailure(createAccountAssetFailure("invalid_input"))); }
    const caller = callerSignal ?? new AbortController().signal;
    if (state !== "open" || ownerAbort.signal.aborted) {
      return Promise.resolve(contract.parseFailure(createAccountAssetFailure("runtime_state_unavailable")));
    }
    const signal = AbortSignal.any([caller, ownerAbort.signal]);
    let resolveInvocation!: (
      value: AccountAssetCollectionSuccess | ApplicationFailure |
        PromiseLike<AccountAssetCollectionSuccess | ApplicationFailure>,
    ) => void;
    let rejectInvocation!: (reason?: unknown) => void;
    const invocation = new Promise<AccountAssetCollectionSuccess | ApplicationFailure>((resolve, reject) => {
      resolveInvocation = resolve;
      rejectInvocation = reject;
    });
    active.add(invocation);
    const clearInvocation = (): void => { active.delete(invocation); };
    void invocation.then(clearInvocation, clearInvocation);
    void (async () => {
      try {
        ensureNotAborted(caller, ownerAbort.signal);
        const prepared = await prepareCollection(request, signal);
        await assertTargetContinuity(dependencies, prepared.target, signal);
        ensureNotAborted(caller, ownerAbort.signal);
        return finalizeCollection(contract, request, prepared);
      } catch (error) {
        if (caller.aborted) return contract.parseFailure(createAccountAssetFailure("request_aborted"));
        if (ownerAbort.signal.aborted) {
          return contract.parseFailure(createAccountAssetFailure("runtime_state_unavailable"));
        }
        return normalizeFailure(contract, error);
      }
    })().then(resolveInvocation, rejectInvocation);
    return invocation;
  };

  const application: AccountAssetApplicationPort = {
    list(inputValue, callerSignal) {
      return runCollection(inputValue, callerSignal);
    },
  };

  return Object.freeze({
    ...application,
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      let resolveClose!: () => void;
      const publishedClose = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      closePromise = publishedClose;
      state = "closing";
      const admitted = [...active];
      admittedOfficialView = undefined;
      ownerAbort.abort();
      dependencies.signal.removeEventListener("abort", abortFromParent);
      void Promise.allSettled(admitted).then(() => {
        state = "closed";
        resolveClose();
      });
      return publishedClose;
    },
  });
};
