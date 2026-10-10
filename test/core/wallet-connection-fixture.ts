// Independent literal observations; no owning parser or generated projection
// constructs the positive fixture used by the Core consumers.
export const createConnectedWalletFixture = () => ({
  status: "connected" as const,
  connectionId: `wallet-session:${"A".repeat(43)}`,
  namespaces: [{
    key: "eip155",
    accounts: [`eip155:4663:0x${"1".repeat(40)}`],
    methods: ["eth_sendTransaction"],
    events: ["accountsChanged", "chainChanged"],
  }],
  expiresAt: "2026-07-13T10:16:02.000Z",
});
