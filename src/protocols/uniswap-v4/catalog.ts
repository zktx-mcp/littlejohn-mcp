import {deepFreezeValue} from "../../core/client.js";
import {evmAddressSchema} from "../../evm/identities.js";
import {productUsdgAsset} from "../../registry/product-assets.js";
import {
  deriveUniswapV4PoolId,
  uniswapV4PoolIdSchema,
  uniswapV4PoolKeySchema,
  type UniswapV4PoolKey,
} from "./identity.js";

// Initial candidate identities from the publisher's registry at revision
// 326a2d6247b319b65aa6ff042e142f7b23d19750. This catalog owns the selected
// candidates; current official membership and live pool state are read separately.
const entries = [
  {
    "poolId": "0x3a03bd306e0cbec0c0a33d5dee9c88e31c1ed46fd1d9a1e0350cd76260e2da73",
    "poolKey": {
      "currency0": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "currency1": "0xb0992820e760d836549ba69bc7598b4af75dee03",
      "fee": 20000,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 400
    }
  },
  {
    "poolId": "0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1",
    "poolKey": {
      "currency0": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "currency1": "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
      "fee": 3000,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 60
    }
  },
  {
    "poolId": "0x5875d407a42965b0e768c8925cea290e06fa50603ef34fc99eb92a1050e6ae36",
    "poolKey": {
      "currency0": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "currency1": "0xc0d6457c16cc70d6790dd43521c899c87ce02f35",
      "fee": 3000,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 60
    }
  },
  {
    "poolId": "0x6fa3ee0048e78bf0a513eb0ab56f482944a767c21db990fcf555605e69f05659",
    "poolKey": {
      "currency0": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "currency1": "0xff080c8ce2e5feadaca0da81314ae59d232d4afd",
      "fee": 10000,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 200
    }
  },
  {
    "poolId": "0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e",
    "poolKey": {
      "currency0": "0x322f0929c4625ed5bad873c95208d54e1c003b2d",
      "currency1": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "fee": 3000,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 60
    }
  },
  {
    "poolId": "0x9194a557b6a6bb2236b49ea7e2bbccec5d3eeb705aef00903be4b3de1d949579",
    "poolKey": {
      "currency0": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "currency1": "0xe93237c50d904957cf27e7b1133b510c669c2e74",
      "fee": 3000,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 60
    }
  },
  {
    "poolId": "0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb",
    "poolKey": {
      "currency0": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "currency1": "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
      "fee": 3000,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 60
    }
  },
  {
    "poolId": "0xd32646872e6712af8cf778e34b6bbef1d2ae0bddd83764e1b07333518ad59333",
    "poolKey": {
      "currency0": "0x12f190a9f9d7d37a250758b26824b97ce941bf54",
      "currency1": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "fee": 3000,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 60
    }
  },
  {
    "poolId": "0xd4ecb79fdc521d7725d22b33ed43cb4e47aa96bfad76aa29577e3151f723ac5e",
    "poolKey": {
      "currency0": "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3",
      "currency1": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "fee": 3000,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 60
    }
  },
  {
    "poolId": "0xde9f85fdd9e05a943a52f2c69ffafe3064a3287df03d02c9b431bc92d4781274",
    "poolKey": {
      "currency0": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "currency1": "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc",
      "fee": 10000,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 200
    }
  },
  {
    "poolId": "0xe4930a6215f21aa3b37c01adbded3362f56ae31b9a60066f5f9641e601d5111f",
    "poolKey": {
      "currency0": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "currency1": "0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8",
      "fee": 10000,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 100
    }
  },
  {
    "poolId": "0xe5923c8a8be481ec89a2ca784a2bbfa4235de6d88f92260fd66b660c4babf907",
    "poolKey": {
      "currency0": "0x117cc2133c37b721f49de2a7a74833232b3b4c0c",
      "currency1": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      "fee": 500,
      "hooks": "0x0000000000000000000000000000000000000000",
      "tickSpacing": 5
    }
  }
] as const;

export interface UniswapV4PoolCandidate {
  readonly poolId: ReturnType<typeof uniswapV4PoolIdSchema.parse>;
  readonly stockTokenAddress: ReturnType<typeof evmAddressSchema.parse>;
  readonly poolKey: UniswapV4PoolKey;
}

const seen = new Set<string>();
export const uniswapV4PoolCatalog: readonly UniswapV4PoolCandidate[] = deepFreezeValue(
  entries.map((entry) => {
    const poolKey = uniswapV4PoolKeySchema.parse(entry.poolKey);
    const poolId = uniswapV4PoolIdSchema.parse(entry.poolId);
    const quoteIsFirst = poolKey.currency0 === productUsdgAsset.address;
    const stockTokenAddress = quoteIsFirst ? poolKey.currency1 : poolKey.currency0;
    if (seen.has(poolId) || deriveUniswapV4PoolId(poolKey) !== poolId ||
        BigInt(poolKey.currency0) >= BigInt(poolKey.currency1) ||
        (!quoteIsFirst && poolKey.currency1 !== productUsdgAsset.address) ||
        BigInt(stockTokenAddress) === 0n || BigInt(poolKey.hooks) !== 0n) {
      throw new TypeError("Uniswap V4 pool catalog is inconsistent.");
    }
    seen.add(poolId);
    return { poolId, poolKey, stockTokenAddress };
  }),
);

export const getUniswapV4PoolCandidate = (poolIdInput: unknown): UniswapV4PoolCandidate => {
  const poolId = uniswapV4PoolIdSchema.parse(poolIdInput);
  const candidate = uniswapV4PoolCatalog.find((entry) => entry.poolId === poolId);
  if (candidate === undefined) throw new TypeError("The selected V4 pool is outside the catalog.");
  return candidate;
};
