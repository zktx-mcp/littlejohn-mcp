import { canonicalSha256, captureCanonicalJson, deepFreezeValue, productChainId } from "../core/client.js";

// Robinhood's network specification identifies ETH for this chain. Ethereum's
// denomination specification defines one wei as 10^-18 ETH. This registry
// record is separate from an RPC quantity observation and ERC-20 decimals().
const definition = {
  registryVersion: "1", recordId: "native_ether",
  asset: { kind: "native" as const, chainId: productChainId }, decimals: "18",
  chainSource: "https://docs.robinhood.com/chain/connecting/",
  denominationSource: "https://ethereum.org/developers/docs/intro-to-ether/",
};
export const nativeAssetUnitDefinition = deepFreezeValue({
  ...definition, recordDigest: canonicalSha256(captureCanonicalJson(definition)),
});
