import {
  deepFreezeValue,
  parseEvmAddressInput,
  parseHash32,
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
  robinhoodChainId,
  type OfficialAssetSourceMember,
} from "./official-assets.js";

export const stockFactoryProxyAddress = parseEvmAddressInput(
  "0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046",
);
export const stockFactoryImplementationAddress = parseEvmAddressInput(
  "0xEe351E53BCe6AAF106428358838197C91e36EE0E",
);
export const stockFactoryImplementationSlot = parseHash32(
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
);
export const stockFactoryProxyCodeHash = parseHash32(
  "0x394c3517e9331e7c88ef8af388c0cb63c720af1b1b4d5a5cace212f7df0b045a",
);
export const stockFactoryImplementationCodeHash = parseHash32(
  "0x3bfd5841605b9931c9dbb0f9f54a28b4038918ceb74d6d1081bc7f963fe528b4",
);

export type StockFactoryVerificationErrorCode =
  | "factory_identity_mismatch"
  | "request_aborted"
  | "source_inconsistent"
  | "source_unavailable"
  | "token_code_missing"
  | "token_identity_mismatch";

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

export interface StockFactoryVerification {
  readonly assetUid: Hash32;
  readonly contractAddress: EvmAddress;
  readonly block: ChainAnchor;
  readonly proxyAddress: EvmAddress;
  readonly proxyCodeHash: Hash32;
  readonly implementationAddress: EvmAddress;
  readonly implementationCodeHash: Hash32;
  readonly tokenCodeHash: Hash32;
}

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
  if (input.block.chainId !== robinhoodChainId) {
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
        [stockFactoryProxyAddress, input.stateReference],
        input.signal,
      ),
      input.rpc.request(
        "eth_getStorageAt",
        [stockFactoryProxyAddress, stockFactoryImplementationSlot, input.stateReference],
        input.signal,
      ),
    ]);
    proxyCodeHash = requiredRuntimeCodeHash(proxyCodeRaw, "factory_identity_mismatch");
    implementationAddress = decodeImplementationAddress(implementationWordRaw);
    if (
      proxyCodeHash !== stockFactoryProxyCodeHash ||
      implementationAddress !== stockFactoryImplementationAddress
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
    if (implementationCodeHash !== stockFactoryImplementationCodeHash) {
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
            to: stockFactoryProxyAddress,
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
        return deepFreezeValue({
          assetUid: validatedMember.assetUid,
          contractAddress: validatedMember.contractAddress,
          block: input.block,
          proxyAddress: stockFactoryProxyAddress,
          proxyCodeHash,
          implementationAddress,
          implementationCodeHash,
          tokenCodeHash,
        });
      } catch (error) {
        throw normalizeFailure(error, input.signal);
      }
    },
  });
};
