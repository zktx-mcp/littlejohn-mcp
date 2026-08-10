import {
  parseEvmAddressInput,
  type ChainAnchor,
  type EvmAddress,
  type Hash32,
} from "../core/index.js";
import {
  createStockFactoryCallEncoder,
  decodeAbiAddressResult,
} from "../chain/evm-standard.js";
import {
  normalizeRpcBytes,
  normalizeRpcHash,
  normalizeRpcRuntimeCode,
} from "../chain/normalization.js";
import {
  isRpcExecutionRevertedError,
  type ChainRpcMethod,
  type ChainRpcRequestMap,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "../chain/rpc.js";
import { admitChainReadFailure } from "../chain/errors.js";
import {
  assertOfficialAssetSourceMember,
  assertStockFactoryVerificationResult,
  stockFactoryAdmissionManifest,
  stockFactoryClassificationUnavailableReasonSchema,
  type OfficialAssetSourceMember,
  type StockFactoryClassificationUnavailableReason,
  type StockFactoryVerificationResult,
} from "./official-asset-contract.js";

type StockFactoryUnavailableResult = Readonly<{
  status: "unavailable";
  reason: StockFactoryClassificationUnavailableReason;
}>;

export type StockFactoryVerifierInitializationResult =
  | Readonly<{ status: "ready"; verifier: StockFactoryVerifier }>
  | StockFactoryUnavailableResult;

export interface StockFactoryVerifier {
  readonly block: ChainAnchor;
  verify(member: OfficialAssetSourceMember): Promise<StockFactoryVerificationResult>;
}

export interface StockFactoryVerifierInput {
  readonly rpc: RpcRequester;
  readonly block: ChainAnchor;
  readonly stateReference: RpcCanonicalBlockReference;
  readonly signal: AbortSignal;
}

type ReadResult<Value> =
  | Readonly<{ status: "available"; value: Value }>
  | StockFactoryUnavailableResult;

const unavailable = (
  reason: StockFactoryClassificationUnavailableReason,
): StockFactoryUnavailableResult => Object.freeze({
  status: "unavailable",
  reason: stockFactoryClassificationUnavailableReasonSchema.parse(reason),
});

const admittedReadFailure = (
  error: unknown,
  signal: AbortSignal,
): StockFactoryClassificationUnavailableReason | undefined => {
  if (isRpcExecutionRevertedError(error)) return "source_inconsistent";
  const failure = admitChainReadFailure(error, signal);
  if (failure === undefined) return undefined;
  const reason = stockFactoryClassificationUnavailableReasonSchema.safeParse(
    failure.error.code,
  );
  return reason.success ? reason.data : undefined;
};

const request = async <Method extends ChainRpcMethod>(
  rpc: RpcRequester,
  method: Method,
  params: ChainRpcRequestMap[Method],
  signal: AbortSignal,
): Promise<ReadResult<unknown>> => {
  try {
    return Object.freeze({
      status: "available",
      value: await rpc.request(method, params, signal),
    });
  } catch (error) {
    const reason = admittedReadFailure(error, signal);
    if (reason !== undefined) return unavailable(reason);
    throw error;
  }
};

const decodeImplementationAddress = (input: unknown): ReadResult<EvmAddress> => {
  let word: Hash32;
  try {
    word = normalizeRpcHash(input);
  } catch {
    return unavailable("source_inconsistent");
  }
  if (!/^0x0{24}[0-9a-f]{40}$/u.test(word)) {
    return unavailable("source_inconsistent");
  }
  return Object.freeze({
    status: "available",
    value: parseEvmAddressInput(`0x${word.slice(-40)}`),
  });
};

const decodeRuntimeCodeHash = (
  input: unknown,
  emptyReason: StockFactoryClassificationUnavailableReason,
): ReadResult<Hash32> => {
  try {
    const code = normalizeRpcRuntimeCode(input);
    return code.status === "empty"
      ? unavailable(emptyReason)
      : Object.freeze({ status: "available", value: code.codeHash });
  } catch {
    return unavailable("source_inconsistent");
  }
};

const decodeMappedAddress = (input: unknown): ReadResult<EvmAddress> => {
  try {
    return Object.freeze({
      status: "available",
      value: decodeAbiAddressResult(normalizeRpcBytes(input)),
    });
  } catch {
    return unavailable("source_inconsistent");
  }
};

const verificationUnavailable = (
  member: OfficialAssetSourceMember,
  reason: StockFactoryClassificationUnavailableReason,
): StockFactoryVerificationResult => assertStockFactoryVerificationResult({
    status: "unavailable",
    member,
    reason,
  });

export const createStockFactoryVerifier = async (
  input: StockFactoryVerifierInput,
): Promise<StockFactoryVerifierInitializationResult> => {
  if (input.block.chainId !== stockFactoryAdmissionManifest.chainId) {
    throw new TypeError("StockFactory verification requires Robinhood Chain.");
  }
  if (input.stateReference.blockHash !== input.block.blockHash) {
    throw new TypeError("StockFactory verification block reference is inconsistent.");
  }
  const encoder = createStockFactoryCallEncoder();

  const proxyCodeRead = await request(
    input.rpc,
    "eth_getCode",
    [stockFactoryAdmissionManifest.proxyAddress, input.stateReference],
    input.signal,
  );
  if (proxyCodeRead.status === "unavailable") return proxyCodeRead;
  const proxyCode = decodeRuntimeCodeHash(
    proxyCodeRead.value,
    "factory_identity_mismatch",
  );
  if (proxyCode.status === "unavailable") return proxyCode;
  if (proxyCode.value !== stockFactoryAdmissionManifest.proxyCodeHash) {
    return unavailable("factory_identity_mismatch");
  }

  const implementationRead = await request(
    input.rpc,
    "eth_getStorageAt",
    [
      stockFactoryAdmissionManifest.proxyAddress,
      stockFactoryAdmissionManifest.implementationSlot,
      input.stateReference,
    ],
    input.signal,
  );
  if (implementationRead.status === "unavailable") return implementationRead;
  const implementation = decodeImplementationAddress(implementationRead.value);
  if (implementation.status === "unavailable") return implementation;
  if (implementation.value !== stockFactoryAdmissionManifest.implementationAddress) {
    return unavailable("factory_identity_mismatch");
  }

  const implementationCodeRead = await request(
    input.rpc,
    "eth_getCode",
    [implementation.value, input.stateReference],
    input.signal,
  );
  if (implementationCodeRead.status === "unavailable") return implementationCodeRead;
  const implementationCode = decodeRuntimeCodeHash(
    implementationCodeRead.value,
    "factory_identity_mismatch",
  );
  if (implementationCode.status === "unavailable") return implementationCode;
  if (implementationCode.value !== stockFactoryAdmissionManifest.implementationCodeHash) {
    return unavailable("factory_identity_mismatch");
  }

  const verifier: StockFactoryVerifier = Object.freeze({
    block: input.block,
    async verify(memberInput: OfficialAssetSourceMember): Promise<StockFactoryVerificationResult> {
      const member = assertOfficialAssetSourceMember(memberInput);
      const mappedAddressRead = await request(
        input.rpc,
        "eth_call",
        [{
          to: stockFactoryAdmissionManifest.proxyAddress,
          data: encoder.tokenAddress(member.assetUid),
        }, input.stateReference],
        input.signal,
      );
      if (mappedAddressRead.status === "unavailable") {
        return verificationUnavailable(member, mappedAddressRead.reason);
      }
      const mappedAddress = decodeMappedAddress(mappedAddressRead.value);
      if (mappedAddress.status === "unavailable") {
        return verificationUnavailable(member, mappedAddress.reason);
      }
      if (mappedAddress.value !== member.contractAddress) {
        return verificationUnavailable(member, "token_identity_mismatch");
      }

      const tokenCodeRead = await request(
        input.rpc,
        "eth_getCode",
        [member.contractAddress, input.stateReference],
        input.signal,
      );
      if (tokenCodeRead.status === "unavailable") {
        return verificationUnavailable(member, tokenCodeRead.reason);
      }
      const tokenCode = decodeRuntimeCodeHash(tokenCodeRead.value, "token_code_missing");
      if (tokenCode.status === "unavailable") {
        return verificationUnavailable(member, tokenCode.reason);
      }
      return assertStockFactoryVerificationResult({
        status: "verified",
        member,
        verification: {
          assetUid: member.assetUid,
          contractAddress: member.contractAddress,
          block: input.block,
          proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
          proxyCodeHash: proxyCode.value,
          implementationAddress: implementation.value,
          implementationCodeHash: implementationCode.value,
          tokenCodeHash: tokenCode.value,
        },
      });
    },
  });

  return Object.freeze({ status: "ready", verifier });
};
