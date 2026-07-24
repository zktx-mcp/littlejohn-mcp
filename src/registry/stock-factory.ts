import {
  deepFreezeValue,
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
  getChainRpcErrorCode,
  isRpcExecutionRevertedError,
  type RpcCanonicalBlockReference,
  type RpcRequester,
} from "../chain/rpc.js";
import {
  assertOfficialAssetSourceMember,
} from "./official-assets.js";
import {
  stockFactoryAdmissionManifest,
  stockFactoryVerificationSchema,
  type OfficialAssetSourceMember,
  type StockFactoryVerification,
  type StockFactoryVerificationErrorCode,
} from "./official-asset-contract.js";

const verificationErrorCodes = new WeakMap<object, StockFactoryVerificationErrorCode>();

export class StockFactoryVerificationError extends Error {
  override readonly name = "StockFactoryVerificationError";
  readonly code: StockFactoryVerificationErrorCode;

  constructor(code: StockFactoryVerificationErrorCode) {
    super(code);
    this.code = code;
    verificationErrorCodes.set(this, code);
    Object.freeze(this);
  }
}

export const getStockFactoryVerificationErrorCode = (
  error: unknown,
): StockFactoryVerificationErrorCode | undefined =>
  typeof error === "object" && error !== null ? verificationErrorCodes.get(error) : undefined;

export interface StockFactoryVerifier {
  readonly block: ChainAnchor;
  verify(member: OfficialAssetSourceMember): Promise<StockFactoryVerification>;
}

export interface StockFactoryVerifierInput {
  readonly rpc: RpcRequester;
  readonly block: ChainAnchor;
  readonly stateReference: RpcCanonicalBlockReference;
  readonly signal: AbortSignal;
}

const normalizeFailure = (error: unknown, signal: AbortSignal): StockFactoryVerificationError => {
  const existing = getStockFactoryVerificationErrorCode(error);
  if (existing !== undefined) return error as StockFactoryVerificationError;
  if (signal.aborted || getChainRpcErrorCode(error) === "request_aborted") {
    return new StockFactoryVerificationError("request_aborted");
  }
  const rpcCode = getChainRpcErrorCode(error);
  if (rpcCode === "source_inconsistent" || isRpcExecutionRevertedError(error)) {
    return new StockFactoryVerificationError("source_inconsistent");
  }
  if (rpcCode !== undefined) return new StockFactoryVerificationError("source_unavailable");
  return new StockFactoryVerificationError("source_inconsistent");
};

const decodeImplementationAddress = (input: unknown): EvmAddress => {
  const word = normalizeRpcHash(input);
  if (!/^0x0{24}[0-9a-f]{40}$/u.test(word)) {
    throw new StockFactoryVerificationError("factory_identity_mismatch");
  }
  return parseEvmAddressInput(`0x${word.slice(-40)}`);
};

const requiredRuntimeCodeHash = (
  input: unknown,
  missingCode: StockFactoryVerificationErrorCode,
): Hash32 => {
  const code = normalizeRpcRuntimeCode(input);
  if (code.status === "empty") throw new StockFactoryVerificationError(missingCode);
  return code.codeHash;
};

export const createStockFactoryVerifier = async (
  input: StockFactoryVerifierInput,
): Promise<StockFactoryVerifier> => {
  if (input.block.chainId !== stockFactoryAdmissionManifest.chainId) {
    throw new TypeError("StockFactory verification requires Robinhood Chain.");
  }
  if (input.stateReference.blockHash !== input.block.blockHash) {
    throw new TypeError("StockFactory verification block reference is inconsistent.");
  }
  const encoder = createStockFactoryCallEncoder();
  let proxyCodeHash: Hash32;
  let implementationAddress: EvmAddress;
  let implementationCodeHash: Hash32;
  try {
    const [proxyCodeRaw, implementationWordRaw] = await Promise.all([
      input.rpc.request(
        "eth_getCode",
        [stockFactoryAdmissionManifest.proxyAddress, input.stateReference],
        input.signal,
      ),
      input.rpc.request(
        "eth_getStorageAt",
        [
          stockFactoryAdmissionManifest.proxyAddress,
          stockFactoryAdmissionManifest.implementationSlot,
          input.stateReference,
        ],
        input.signal,
      ),
    ]);
    proxyCodeHash = requiredRuntimeCodeHash(proxyCodeRaw, "factory_identity_mismatch");
    implementationAddress = decodeImplementationAddress(implementationWordRaw);
    if (
      proxyCodeHash !== stockFactoryAdmissionManifest.proxyCodeHash ||
      implementationAddress !== stockFactoryAdmissionManifest.implementationAddress
    ) throw new StockFactoryVerificationError("factory_identity_mismatch");
    const implementationCodeRaw = await input.rpc.request(
      "eth_getCode",
      [implementationAddress, input.stateReference],
      input.signal,
    );
    implementationCodeHash = requiredRuntimeCodeHash(
      implementationCodeRaw,
      "factory_identity_mismatch",
    );
    if (
      implementationCodeHash !== stockFactoryAdmissionManifest.implementationCodeHash
    ) {
      throw new StockFactoryVerificationError("factory_identity_mismatch");
    }
  } catch (error) {
    throw normalizeFailure(error, input.signal);
  }

  return Object.freeze({
    block: input.block,
    async verify(member: OfficialAssetSourceMember): Promise<StockFactoryVerification> {
      const validatedMember = assertOfficialAssetSourceMember(member);
      try {
        const [mappedAddressRaw, tokenCodeRaw] = await Promise.all([
          input.rpc.request("eth_call", [{
            to: stockFactoryAdmissionManifest.proxyAddress,
            data: encoder.tokenAddress(validatedMember.assetUid),
          }, input.stateReference], input.signal),
          input.rpc.request(
            "eth_getCode",
            [validatedMember.contractAddress, input.stateReference],
            input.signal,
          ),
        ]);
        const mappedAddress = decodeAbiAddressResult(normalizeRpcBytes(mappedAddressRaw));
        if (mappedAddress !== validatedMember.contractAddress) {
          throw new StockFactoryVerificationError("token_identity_mismatch");
        }
        const tokenCodeHash = requiredRuntimeCodeHash(tokenCodeRaw, "token_code_missing");
        return deepFreezeValue(stockFactoryVerificationSchema.parse({
          assetUid: validatedMember.assetUid,
          contractAddress: validatedMember.contractAddress,
          block: input.block,
          proxyAddress: stockFactoryAdmissionManifest.proxyAddress,
          proxyCodeHash,
          implementationAddress,
          implementationCodeHash,
          tokenCodeHash,
        }));
      } catch (error) {
        throw normalizeFailure(error, input.signal);
      }
    },
  });
};
