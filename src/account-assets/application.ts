import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  accountBalanceCapability,
  canonicalJsonStringify,
  captureCanonicalJson,
  type ApplicationFailure,
  type CanonicalJson,
  type EvmAccountIdentity,
} from "../core/index.js";
import {
  captureConnectedWalletSession,
  type ConnectedWalletSession,
} from "../token-catalog/active-wallet.js";
import type {
  TokenRegistrationWithInspection,
} from "../token-catalog/index.js";
import {
  accountAssetApplicationContracts,
  accountAssetBalanceFailureCodes,
  accountAssetBalanceSchema,
  accountAssetMetadataAuthority,
  projectAccountAssetCollectionSuccess,
  projectAccountAssetExactSuccess,
  type AccountAssetApplicationContract,
  type AccountAssetBalanceWithReferences,
  type AccountAssetCollectionRequest,
  type AccountAssetCollectionSuccess,
  type AccountAssetExactInput,
  type AccountAssetExactSuccess,
} from "./contracts.js";
import {
  AccountAssetOperationError,
  createAccountAssetFailure,
  normalizeAccountAssetError,
} from "./errors.js";
import { projectAccountAssetEntry } from "./metadata.js";
import type {
  AccountAssetApplicationPort,
  AccountAssetReadProcessDependencies,
} from "./ports.js";

type CapturedWallet = Readonly<{
  account: EvmAccountIdentity;
  connectionRevision: ConnectedWalletSession["connectionRevision"];
  sessionSourceId: string;
}>;

const sameAccount = (left: EvmAccountIdentity, right: EvmAccountIdentity): boolean =>
  left.chainId === right.chainId && left.address === right.address;

const registrationBytes = (entries: readonly TokenRegistrationWithInspection[]): string =>
  canonicalJsonStringify(captureCanonicalJson(entries.map((entry) => entry.registration)));

const mappedBalanceFailureCodes = new Set<string>(accountAssetBalanceFailureCodes);

const internalFailure = (): ApplicationFailure => createAccountAssetFailure("internal_error");

const normalizeFailure = <Input, Success>(
  contract: AccountAssetApplicationContract<Input, Success>,
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

const assertWalletContinuity = (
  initial: CapturedWallet,
  final: CapturedWallet,
): void => {
  if (
    !sameAccount(initial.account, final.account) ||
    initial.connectionRevision !== final.connectionRevision ||
    initial.sessionSourceId !== final.sessionSourceId
  ) throw new AccountAssetOperationError("state_conflict");
};

const balanceResult = async (
  bindings: CapabilityBindingRegistry,
  input: Readonly<{
    account: EvmAccountIdentity;
    includeNative: boolean;
    tokenAddresses: readonly string[];
  }>,
  signal: AbortSignal,
): Promise<AccountAssetBalanceWithReferences> => {
  const result = await bindings.invoke(accountBalanceCapability, {
    account: { kind: "address", address: input.account.address },
    includeNative: input.includeNative,
    tokens: input.tokenAddresses,
    block: { kind: "latest" },
  }, { signal });
  if (result.ok) return Object.freeze({ status: "available" as const, snapshot: result });
  if (mappedBalanceFailureCodes.has(result.error.code)) {
    accountAssetBalanceSchema.parse({ status: "unavailable", failure: result });
    return Object.freeze({ status: "unavailable" as const, failure: result });
  }
  throw new AccountAssetOperationError(result.error.code);
};

const ensureNotAborted = (caller: AbortSignal, owner: AbortSignal): void => {
  if (caller.aborted) throw new AccountAssetOperationError("request_aborted");
  if (owner.aborted) throw new AccountAssetOperationError("runtime_state_unavailable");
};

export const createAccountAssetApplication = (
  dependencies: AccountAssetReadProcessDependencies,
): Readonly<AccountAssetApplicationPort & { close(): Promise<void> }> => {
  const bindings = new CapabilityBindingRegistry(
    new CapabilityRegistry([accountBalanceCapability]),
    [dependencies.accountBalance],
  );
  const ownerAbort = new AbortController();
  const active = new Set<Promise<unknown>>();
  let state: "open" | "closing" | "closed" = "open";
  let closePromise: Promise<void> | undefined;
  const abortFromParent = (): void => ownerAbort.abort();
  if (dependencies.signal.aborted) ownerAbort.abort();
  else dependencies.signal.addEventListener("abort", abortFromParent, { once: true });

  const run = <Input, Success>(
    contract: AccountAssetApplicationContract<Input, Success>,
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
          const initial = dependencies.registrations.listForAccount({ account: wallet.account, ...request });
          const selected = [...initial.entries];
          const balance = await balanceResult(bindings, {
            account: wallet.account,
            includeNative: true,
            tokenAddresses: selected.map((entry) => entry.registration.asset.address),
          }, signal);
          const final = dependencies.registrations.listForAccount({ account: wallet.account, ...request });
          const recaptured = captureWallet(dependencies);
          assertWalletContinuity(wallet, recaptured);
          if (
            initial.nextCursor !== final.nextCursor ||
            registrationBytes(selected) !== registrationBytes(final.entries)
          ) throw new AccountAssetOperationError("state_conflict");
          return projectAccountAssetCollectionSuccess({
            account: wallet.account,
            metadataAuthority: accountAssetMetadataAuthority,
            assets: selected.map(projectAccountAssetEntry),
            nextCursor: initial.nextCursor,
            balance,
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
          if (request.asset.chainId !== wallet.account.chainId) {
            throw new AccountAssetOperationError("invalid_input");
          }
          const initial = dependencies.registrations.getForAccount({
            account: wallet.account,
            asset: request.asset,
          });
          if (initial === undefined) throw new AccountAssetOperationError("token_registration_not_found");
          const balance = await balanceResult(bindings, {
            account: wallet.account,
            includeNative: false,
            tokenAddresses: [request.asset.address],
          }, signal);
          const final = dependencies.registrations.getForAccount({
            account: wallet.account,
            asset: request.asset,
          });
          const recaptured = captureWallet(dependencies);
          assertWalletContinuity(wallet, recaptured);
          if (final === undefined || registrationBytes([initial]) !== registrationBytes([final])) {
            throw new AccountAssetOperationError("state_conflict");
          }
          return projectAccountAssetExactSuccess({
            account: wallet.account,
            metadataAuthority: accountAssetMetadataAuthority,
            asset: projectAccountAssetEntry(initial),
            balance,
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
