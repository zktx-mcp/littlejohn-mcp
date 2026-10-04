import type {EvmAddress} from "../evm/identities.js";
import type {ObservationAuthority} from "../core/index.js";
import type { CanonicalBlock, ChainInvocationContext } from "../chain/index.js";
import type { PoolPriceProtocol, PoolPriceState } from "./pool-price-contract.js";

export interface PoolPriceSessionPort {
  read(input: Readonly<{ protocol: PoolPriceProtocol; poolId: string; stock: EvmAddress; quote: EvmAddress }>): Promise<PoolPriceState>;
}
export interface PoolPriceReadPort {
  readonly observationAuthority: ObservationAuthority;
  createSession(context: ChainInvocationContext, block: CanonicalBlock): PoolPriceSessionPort;
}
