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
  | "wallet_not_connected";

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
  return left.connectionRevision === right.connectionRevision &&
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

      const snapshot = await activeWallet.capture(signal);
      if (snapshot.connection.status !== "connected") {
        return deepFreezeValue({
          status: "unavailable" as const,
          target,
          failure: snapshot.connection.status === "unknown" ? "runtime_state_unavailable" as const : "wallet_not_connected" as const,
        });
      }
      if (
        snapshot.connection.chainId !== chainId ||
        snapshot.sessionSource === undefined
      ) {
        return deepFreezeValue({
          status: "unavailable" as const,
          target,
          failure: "runtime_state_unavailable" as const,
        });
      }
      return deepFreezeValue({
        status: "available" as const,
        target,
        account: evmAccountIdentitySchema.parse({
          chainId,
          address: snapshot.connection.address,
        }),
        active: true as const,
        connectionRevision: snapshot.connectionRevision,
        sessionSource: snapshot.sessionSource,
      });
    },
  });
};
