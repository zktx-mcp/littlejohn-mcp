import {getWalletOperationFailure} from "../wallet/operation-error.js";
import type {WalletBoundAccountReference} from "../wallet/bound-account-contract.js";
import {sameEvmAccountIdentity, evmAccountIdentitySchema, type EvmAccountIdentity, type EvmChainId} from "../evm/identities.js";
import {addressTargetSchema, type AddressTarget} from "../evm/address-target.js";
import {deepFreezeValue, type UnsignedDecimal} from "../core/index.js";
import type {
  ActiveWalletReadPort,
  ActiveWalletReadSnapshot,
} from "../wallet/coordinator.js";
import { ChainOperationError } from "./errors.js";

type WalletSessionSource = NonNullable<ActiveWalletReadSnapshot["sessionSource"]>;

export type AddressTargetResolutionFailure =
  | "runtime_state_unavailable"
  | "wallet_not_connected"
  | "wallet_session_unusable"
  | "wallet_account_unavailable"
  | "wallet_account_selection_required"
  | "request_aborted";

export type ResolvedAddressTarget =
  | Readonly<{
      status: "available";
      target: Extract<AddressTarget, { readonly kind: "address" }>;
      account: EvmAccountIdentity;
      active: false;
    }>
  | Readonly<{
      status: "available";
      target: Extract<AddressTarget, { readonly kind: "active_wallet" }>;
      account: EvmAccountIdentity;
      active: true;
      connectionRevision: UnsignedDecimal;
      selectionRevision: UnsignedDecimal;
      permission: WalletBoundAccountReference;
      sessionSource: WalletSessionSource;
    }>;

export type AddressTargetResolution =
  | ResolvedAddressTarget
  | Readonly<{
      status: "unavailable";
      target: Extract<AddressTarget, { readonly kind: "active_wallet" }>;
      failure: AddressTargetResolutionFailure;
    }>;

export interface AddressTargetResolverPort {
  resolve(target: AddressTarget, signal?: AbortSignal): Promise<AddressTargetResolution>;
  validateBoundAccount(reference: WalletBoundAccountReference, signal?: AbortSignal): Promise<ResolvedAddressTarget>;
  assertBoundAccountCurrent(reference: WalletBoundAccountReference): void;
}

export const sameResolvedAddressTarget = (
  left: ResolvedAddressTarget,
  right: ResolvedAddressTarget,
): boolean => {
  if (
    left.target.kind !== right.target.kind ||
    !sameEvmAccountIdentity(left.account, right.account)
  ) return false;
  if (!left.active || !right.active) return !left.active && !right.active;
  return left.connectionRevision === right.connectionRevision && left.selectionRevision === right.selectionRevision &&
    left.sessionSource.sourceId === right.sessionSource.sourceId;
};

export const requireAvailableAddressTarget = (
  resolution: AddressTargetResolution,
): ResolvedAddressTarget => {
  if (resolution.status === "unavailable") {
    throw new ChainOperationError(resolution.failure);
  }
  return resolution;
};

export const createAddressTargetResolver = (input: Readonly<{
  chainId: EvmChainId;
  activeWallet: ActiveWalletReadPort;
}>): AddressTargetResolverPort => {
  const chainId = input.chainId;
  const activeWallet = input.activeWallet;
  return Object.freeze({
    assertBoundAccountCurrent(reference: WalletBoundAccountReference): void {
      if (reference.account.chainId !== chainId) throw new ChainOperationError("wallet_account_unavailable");
      activeWallet.assertBoundAccountCurrent(reference);
    },
    async validateBoundAccount(reference: WalletBoundAccountReference, signal?: AbortSignal): Promise<ResolvedAddressTarget> {
      const snapshot = await activeWallet.validateBoundAccount(reference, signal);
      activeWallet.assertBoundAccountCurrent(reference);
      if (snapshot.account.chainId !== chainId) throw new ChainOperationError("wallet_account_unavailable");
      return deepFreezeValue({status: "available" as const, target: {kind: "active_wallet" as const}, account: snapshot.account,
        active: true as const, connectionRevision: snapshot.connectionRevision, selectionRevision: snapshot.selectionRevision,
        permission: snapshot.permission, sessionSource: snapshot.sessionSource});
    },
    async resolve(targetInput: AddressTarget, signal?: AbortSignal): Promise<AddressTargetResolution> {
      const target = addressTargetSchema.parse(targetInput);
      if (target.kind === "address") {
        return deepFreezeValue({
          status: "available" as const,
          target,
          account: evmAccountIdentitySchema.parse({
            chainId,
            address: target.address,
          }),
          active: false as const,
        });
      }

      try {
        const snapshot = await activeWallet.resolveAccount({chainId, requiredMethods: []}, signal);
        return deepFreezeValue({status: "available" as const, target, account: snapshot.account, active: true as const,
          connectionRevision: snapshot.connectionRevision, selectionRevision: snapshot.selectionRevision,
          permission: snapshot.permission, sessionSource: snapshot.sessionSource});
      } catch (error) {
        const code = getWalletOperationFailure(error)?.error.code;
        if (code !== "runtime_state_unavailable" && code !== "wallet_not_connected" && code !== "wallet_session_unusable" &&
            code !== "wallet_account_unavailable" && code !== "wallet_account_selection_required" && code !== "request_aborted") throw error;
        return deepFreezeValue({status: "unavailable" as const, target, failure: code as AddressTargetResolutionFailure});
      }
    },
  });
};
