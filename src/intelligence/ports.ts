import {assertObservationAuthorityRegistrationOwns, type ObservationAuthorityRegistration, type HexBytes, type ObservationAuthority, type SourceReference, type UnsignedDecimal} from "../core/index.js";
import {type ChainAnchor} from "../evm/primitives.js";
import {type ContractRuntimeCodeIdentity, type ContractSourceVerificationStatus, type ExactContractInterface} from "./analysis-contract.js";
import {type EvmAddress, type EvmChainId} from "../evm/identities.js";

export type ContractReadResult<Value> =
  | Readonly<{ readonly status: "observed"; readonly value: Value }>
  | Readonly<{ readonly status: "reverted" }>
  | Readonly<{ readonly status: "malformed" }>;

export type ContractStorageAddress =
  | Readonly<{ readonly status: "not_present" }>
  | Readonly<{ readonly status: "observed"; readonly address: EvmAddress }>
  | Readonly<{ readonly status: "malformed" }>;

export interface Eip1967ProxyStorage {
  readonly implementation: ContractStorageAddress;
  readonly beacon: ContractStorageAddress;
  readonly admin: ContractStorageAddress;
}

export interface ContractRuntimeCode {
  readonly bytecode: HexBytes;
  readonly identity: ContractRuntimeCodeIdentity;
}

export interface ContractAnalysisChainReadPort {
  readonly chainId: EvmChainId;
  readonly block: ChainAnchor;
  readRuntimeCode(address: EvmAddress): Promise<ContractRuntimeCode | null>;
  readEip1967ProxyStorage(address: EvmAddress): Promise<Eip1967ProxyStorage>;
  readBeaconImplementation(address: EvmAddress): Promise<ContractReadResult<EvmAddress>>;
  readOwner(address: EvmAddress): Promise<ContractReadResult<EvmAddress>>;
  readPaused(address: EvmAddress): Promise<ContractReadResult<boolean>>;
  readDefaultAdminRole(address: EvmAddress): Promise<ContractReadResult<HexBytes>>;
  readDefaultAdminMemberCount(
    address: EvmAddress,
    role: HexBytes,
  ): Promise<ContractReadResult<UnsignedDecimal>>;
  readDefaultAdminMembers(
    address: EvmAddress,
    role: HexBytes,
    count: UnsignedDecimal,
  ): Promise<ContractReadResult<readonly EvmAddress[]>>;
}

export interface ContractSourceVerificationRequest {
  readonly chainId: EvmChainId;
  readonly address: EvmAddress;
  readonly runtimeBytecode: HexBytes;
  readonly signal: AbortSignal;
}

export interface ContractSourceVerification {
  readonly status: ContractSourceVerificationStatus;
  readonly reference: Extract<SourceReference, { readonly kind: "public" }>;
  readonly observationAuthority: ObservationAuthority;
  readonly exactInterface?: ExactContractInterface;
}

export interface ContractSourceVerificationPort {
  inspect(request: ContractSourceVerificationRequest): Promise<ContractSourceVerification>;
}

const contractSourceVerificationRegistrations =
  new WeakMap<ContractSourceVerificationPort, ObservationAuthorityRegistration>();

export const createContractSourceVerificationPort = (input: {
  readonly inspect: ContractSourceVerificationPort["inspect"];
  readonly observationAuthorityRegistration: ObservationAuthorityRegistration;
}): ContractSourceVerificationPort => {
  if (typeof input.inspect !== "function") {
    throw new TypeError("Contract source verification implementation is invalid.");
  }
  const port = Object.freeze({ inspect: input.inspect });
  contractSourceVerificationRegistrations.set(port, input.observationAuthorityRegistration);
  return port;
};

export const assertContractSourceVerificationAuthority = (
  port: ContractSourceVerificationPort,
  authority: ObservationAuthority,
  reference: Extract<SourceReference, { readonly kind: "public" }>,
): void => {
  const registration = contractSourceVerificationRegistrations.get(port);
  if (registration === undefined) {
    throw new TypeError("Contract source verification port provenance is invalid.");
  }
  assertObservationAuthorityRegistrationOwns(
    registration,
    authority,
    "contract_verification_service",
    reference,
  );
};
