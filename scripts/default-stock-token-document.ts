import { defaultStockTokenManifest } from "../src/registry/index.js";

export const defaultStockTokenSectionMarker =
  "<!-- Generated from defaultStockTokenManifest. Do not edit this section. -->";

export const renderDefaultStockTokenSection = (): string => [
  "## Default Stock Tokens",
  "",
  defaultStockTokenSectionMarker,
  "",
  "Little John attempts to include the following Robinhood Stock Tokens on an",
  "account's first successful asset read. Inclusion occurs only while the exact",
  "UID and contract address remain in the current official asset snapshot and pass",
  "the required onchain verification. An existing account choice is never replaced.",
  "",
  `Canonical source: \`defaultStockTokenManifest\` for \`${defaultStockTokenManifest.chainId}\`.`,
  "",
  ...defaultStockTokenManifest.assets.map((asset, index) =>
    `${index + 1}. UID \`${asset.assetUid}\`; contract \`${asset.contractAddress}\`.`),
].join("\n") + "\n";
