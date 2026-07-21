import { z } from "zod";

import {
  deepFreezeValue,
  evmAddressSchema,
  evmChainIdSchema,
  hash32Schema,
} from "../core/index.js";
import { robinhoodChainId } from "./official-assets.js";

const defaultStockTokenEntrySchema = z.object({
  assetUid: hash32Schema,
  contractAddress: evmAddressSchema,
}).strict();

const defaultStockTokenManifestSchema = z.object({
  chainId: z.literal(robinhoodChainId),
  assets: z.array(defaultStockTokenEntrySchema).min(1).max(5),
}).strict().superRefine((value, context) => {
  const uids = value.assets.map((asset) => asset.assetUid);
  const addresses = value.assets.map((asset) => asset.contractAddress);
  if (new Set(uids).size !== uids.length) {
    context.addIssue({ code: "custom", message: "Default Stock Token UIDs must be unique." });
  }
  if (new Set(addresses).size !== addresses.length) {
    context.addIssue({ code: "custom", message: "Default Stock Token addresses must be unique." });
  }
});

export type DefaultStockTokenManifest = z.infer<typeof defaultStockTokenManifestSchema>;

export const defaultStockTokenManifest = deepFreezeValue(defaultStockTokenManifestSchema.parse({
  chainId: robinhoodChainId,
  assets: [
    {
      assetUid: "0x00000000000000000000000000000000c2425be3658540dd8e2424cbf3c5c649",
      contractAddress: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9",
    },
    {
      assetUid: "0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5",
      contractAddress: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    },
    {
      assetUid: "0x00000000000000000000000000000000cfece3244ea34bb29414dd9488b32d9f",
      contractAddress: "0x322f0929c4625ed5bad873c95208d54e1c003b2d",
    },
    {
      assetUid: "0x0000000000000000000000000000000053b69e2076884cc9ae2ada9bc7095df3",
      contractAddress: "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3",
    },
    {
      assetUid: "0x000000000000000000000000000000001c6f27a62789417d8ed359ed3c2d3da1",
      contractAddress: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c",
    },
  ],
}));

export const defaultStockTokenRank = (
  contractAddress: string,
): number | undefined => {
  const rank = defaultStockTokenManifest.assets.findIndex(
    (asset) => asset.contractAddress === contractAddress,
  );
  return rank < 0 ? undefined : rank;
};
