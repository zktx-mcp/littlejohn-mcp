import type {EvmAddress} from "../evm/identities.js";
import type {Hash32} from "../core/index.js";

export interface SigningCodec {
  hashMessage(bytes: string): Hash32;
  hashTypedData(input: Readonly<{
    types: Readonly<Record<string, readonly Readonly<{ name: string; type: string }>[]>>;
    primaryType: string;
    domain: Readonly<Record<string, unknown>>;
    message: Readonly<Record<string, unknown>>;
  }>): Hash32;
  recoverAddress(hash: Hash32, signature: string): Promise<EvmAddress>;
}
