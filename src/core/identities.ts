export const robinhoodChainIdentity = Object.freeze({
  chainId: "4663",
  caip2: "eip155:4663",
} as const);

export const robinhoodWalletNamespaceRequirements = Object.freeze({
  chainId: robinhoodChainIdentity.caip2,
  methods: Object.freeze(["eth_sendTransaction"] as const),
  events: Object.freeze(["accountsChanged", "chainChanged"] as const),
});
