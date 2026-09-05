import { defaultStockTokenManifest } from "../src/registry/index.js";

export const defaultStockTokenSectionMarker =
  "<!-- Generated from defaultStockTokenManifest. Do not edit this section. -->";

export const renderDefaultStockTokenSection = (): string => [
  "## Default Stock Tokens",
  "",
  defaultStockTokenSectionMarker,
  "",
  "Until initialization succeeds, Little John attempts to include the following",
  "Robinhood Stock Tokens on each first-page asset read for a deliberately retained",
  "account. A validated Wallet connection or confirmed Token addition retains an",
  "account; merely reading an explicit address does not. Explicit and active selectors",
  "for the same retained account use the same choices. Inclusion occurs only while the",
  "exact UID and contract address remain in the current official asset snapshot and pass",
  "the required onchain verification. An existing account choice is never replaced.",
  "",
  `Canonical source: \`defaultStockTokenManifest\` for \`${defaultStockTokenManifest.chainId}\`.`,
  "",
  ...defaultStockTokenManifest.assets.map((asset, index) =>
    `${index + 1}. UID \`${asset.assetUid}\`; contract \`${asset.contractAddress}\`.`),
].join("\n") + "\n";
