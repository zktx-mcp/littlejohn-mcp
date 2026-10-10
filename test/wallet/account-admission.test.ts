import {describe, expect, it} from "vitest";
import {parseEvmChainId} from "../../src/evm/identities.js";
import {walletAccountIdentifierSchema, walletChainIdentifierSchema, walletNamespaceKeySchema,
  walletNamespacesSchema, normalizeWalletNamespaces, walletAccountPermissions, eligibleWalletAccounts} from "../../src/wallet/account-admission.js";

const chainId = parseEvmChainId("eip155:4663");
const a = "0x1111111111111111111111111111111111111111";
const b = "0x2222222222222222222222222222222222222222";
const scope = (key: string, accounts: string[], methods: string[] = [], chains?: string[]) =>
  ({key, accounts, methods, events: [], ...(chains === undefined ? {} : {chains})});

describe("CAIP account and permission admission", () => {
  it("uses generic case-sensitive CAIP grammar independently of native EVM meaning", () => {
    for (const key of ["abc", "a-b", "abcdefgh", "solana:Main_Net", "eip155:4663"]) expect(walletNamespaceKeySchema.safeParse(key).success, key).toBe(true);
    for (const key of ["ab", "abcdefghi", "EIP155", "eip155:", "eip155:4663:extra", "abc\n", "abc:" + "a".repeat(33)]) expect(walletNamespaceKeySchema.safeParse(key).success, key).toBe(false);
    for (const value of ["abc:a", "abcdefgh:" + "A".repeat(32), "solana:Main_Net"]) expect(walletChainIdentifierSchema.safeParse(value).success, value).toBe(true);
    for (const value of ["ab:a", "ABC:a", "abc:", "abc:" + "a".repeat(33), "abc:a:b", "abc:a\n"]) expect(walletChainIdentifierSchema.safeParse(value).success, value).toBe(false);
    for (const value of ["abc:a:A.%-.9", "abcdefgh:" + "B".repeat(32) + ":" + "Z".repeat(128)]) expect(walletAccountIdentifierSchema.safeParse(value).success, value).toBe(true);
    for (const value of ["abc:a:", "abc:a:" + "A".repeat(129), "abc:a:a_b", "abc:a:a:b", "abc:a:a/b", "abc:a:AAA\n"]) expect(walletAccountIdentifierSchema.safeParse(value).success, value).toBe(false);
    const opaque = normalizeWalletNamespaces({solana: {accounts: ["solana:Main_Net:ABC", "solana:Main_Net:abc"], methods: [], events: []}});
    expect(opaque[0]!.accounts).toEqual(["solana:Main_Net:ABC", "solana:Main_Net:abc"]);
    expect(walletAccountPermissions(opaque, chainId)).toEqual([]);
    expect(() => normalizeWalletNamespaces({eip155: {accounts: ["eip155:0:ABC"], methods: [], events: []}})).toThrow();
  });

  it("rejects every inconsistent scope while admitting empty and matching scopes", () => {
    for (const value of [scope("eip155", [], [], []), scope("eip155:4663", [`eip155:4663:${a}`], [], ["eip155:4663"]), scope("solana:Net", ["solana:Net:Abc"])]) {
      expect(walletNamespacesSchema.safeParse([value]).success).toBe(true);
    }
    for (const value of [scope("eip155", [`solana:Net:Abc`]), scope("eip155:1", [`eip155:4663:${a}`]),
      scope("eip155:4663", [`eip155:4663:${a}`], [], ["eip155:1"]), scope("eip155", [`eip155:4663:${a}`], [], ["eip155:1"]),
      scope("eip155", [], [], ["solana:Net"]), scope("solana:Net", ["solana:Other:Abc"]), scope("eip155:04663", [])]) {
      expect(walletNamespacesSchema.safeParse([value]).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("combines only grants for the same approved account and requested chain", () => {
    const namespaces = walletNamespacesSchema.parse([
      scope("eip155", [`eip155:1:${a}`, `eip155:4663:${a}`, `eip155:4663:${b}`], ["personal_sign"]),
      scope("eip155:1", [`eip155:1:${a}`], ["eth_signTypedData_v4"]),
      scope("eip155:4663", [`eip155:4663:${a}`], ["eth_sendTransaction"]),
    ]);
    expect(walletAccountPermissions(namespaces, chainId)).toEqual([
      {account: {chainId: "eip155:4663", address: a}, methods: ["eth_sendTransaction", "personal_sign"], events: []},
      {account: {chainId: "eip155:4663", address: b}, methods: ["personal_sign"], events: []},
    ]);
    expect(eligibleWalletAccounts(namespaces, chainId, ["eth_sendTransaction", "personal_sign"]).map(value => value.account.address)).toEqual([a]);
    expect(eligibleWalletAccounts(namespaces, chainId, ["eth_signTypedData_v4"])).toEqual([]);
  });

  it("normalizes native casing and rejects duplicates after normalization without retaining a prefix", () => {
    const lower = "0x" + "ab".repeat(20); const upper = "0x" + "AB".repeat(20);
    expect(normalizeWalletNamespaces({eip155: {accounts: [`eip155:4663:${upper}`], methods: [], events: []}})[0]!.accounts).toEqual([`eip155:4663:${lower}`]);
    expect(() => normalizeWalletNamespaces({eip155: {accounts: [`eip155:4663:${lower}`, `eip155:4663:${upper}`], methods: [], events: []}})).toThrow();
    for (const field of ["accounts", "methods", "events", "chains"] as const) {
      const values = field === "accounts" ? Array.from({length: 64}, (_, index) => `abc:Net:A${index.toString().padStart(2, "0")}`)
        : field === "chains" ? Array.from({length: 64}, (_, index) => `abc:N${index.toString().padStart(2, "0")}`)
          : Array.from({length: 64}, (_, index) => `method_${index.toString().padStart(2, "0")}`);
      const value = {accounts: [] as string[], methods: [] as string[], events: [] as string[], [field]: values};
      expect(() => normalizeWalletNamespaces({abc: value})).not.toThrow();
      expect(() => normalizeWalletNamespaces({abc: {...value, [field]: [...values, field === "accounts" ? "abc:Net:A64" : field === "chains" ? "abc:N64" : "method_64"]}})).toThrow();
    }
    const namespaces = Object.fromEntries(Array.from({length: 16}, (_, index) => [`n${index.toString().padStart(2, "0")}`, {accounts: [], methods: [], events: []}]));
    expect(normalizeWalletNamespaces(namespaces)).toHaveLength(16);
    expect(() => normalizeWalletNamespaces({...namespaces, n16: {accounts: [], methods: [], events: []}})).toThrow();
  });
});
