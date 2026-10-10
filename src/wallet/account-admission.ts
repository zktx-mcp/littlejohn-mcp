import { z } from "zod";
import { compareCodePointSequences, fixedIdentifierSchema, isStrictlyOrderedUnique } from "../core/client.js";
import { parseCaip10EvmAccount } from "../evm/address-input.js";
import { deriveCaip10Account, parseEvmChainId, type EvmAccountIdentity, type EvmChainId } from "../evm/identities.js";
import { walletSdkNamespaceArrayLimit, walletSdkNamespaceLimit } from "./session-limits.js";

// CAIP-2 and CAIP-10 grammar widths, including separators.
export const walletAccountIdentifierLimits = Object.freeze({ chain: 8 + 1 + 32, account: 8 + 1 + 32 + 1 + 128 });
export const walletNamespaceKeySchema = z.string().regex(/^[-a-z0-9]{3,8}(?::[-_a-zA-Z0-9]{1,32})?$/u);
export const walletChainIdentifierSchema = z.string().max(walletAccountIdentifierLimits.chain)
  .regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/u);
export const walletAccountIdentifierSchema = z.string().max(walletAccountIdentifierLimits.account)
  .regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$/u);
const orderedArray = <Schema extends z.ZodType<string>>(schema: Schema) => z.array(schema)
  .max(walletSdkNamespaceArrayLimit).refine(isStrictlyOrderedUnique, "Expected a canonically ordered unique set.");
export const walletNamespaceSchema = z.object({
  key: walletNamespaceKeySchema,
  accounts: orderedArray(walletAccountIdentifierSchema),
  methods: orderedArray(fixedIdentifierSchema),
  events: orderedArray(fixedIdentifierSchema),
  chains: orderedArray(walletChainIdentifierSchema).optional(),
}).strict().superRefine((namespace, context) => {
  try { assertWalletNamespaceScope(namespace); }
  catch { context.addIssue({ code: "custom", message: "Wallet namespace scope is inconsistent." }); }
});
export type WalletNamespace = z.infer<typeof walletNamespaceSchema>;
export const walletNamespacesSchema = z.array(walletNamespaceSchema).max(walletSdkNamespaceLimit)
  .refine((values) => isStrictlyOrderedUnique(values.map((value) => value.key)), "Expected unique ordered namespace keys.");
export const walletAccountChain = (account: string): string => account.slice(0, account.lastIndexOf(":"));
export function assertWalletNamespaceScope(namespace: WalletNamespace): void {
  const family = namespace.key.split(":")[0]!;
  const scopedChain = namespace.key.includes(":") ? namespace.key : undefined;
  if (family === "eip155" && scopedChain !== undefined) parseEvmChainId(scopedChain);
  for (const chain of namespace.chains ?? []) {
    if (family === "eip155") parseEvmChainId(chain);
    if (chain.split(":")[0] !== family || (scopedChain !== undefined && chain !== scopedChain)) {
      throw new TypeError("Approved chain is outside its namespace scope.");
    }
  }
  for (const account of namespace.accounts) {
    const chain = walletAccountChain(account);
    if (chain.split(":")[0] !== family || (scopedChain !== undefined && chain !== scopedChain) ||
        (namespace.chains !== undefined && !namespace.chains.includes(chain))) {
      throw new TypeError("Approved account is outside its namespace scope.");
    }
    if (family === "eip155" && deriveCaip10Account(parseCaip10EvmAccount(account)) !== account) {
      throw new TypeError("Expected a canonical EVM account.");
    }
  }
}
export interface WalletAccountPermission {
  readonly account: EvmAccountIdentity;
  readonly methods: readonly string[];
  readonly events: readonly string[];
}
const orderedUnion = (values: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(values)].sort(compareCodePointSequences));
// Parent selection and the worker native gate consume exactly the same scoped grants.
export const walletAccountPermissions = (
  namespaces: readonly WalletNamespace[], chainId: EvmChainId,
): readonly WalletAccountPermission[] => {
  const scopes = namespaces.filter((namespace) => namespace.key === "eip155" || namespace.key === chainId);
  const accounts = orderedUnion(scopes.flatMap((namespace) => namespace.accounts)
    .filter((account) => walletAccountChain(account) === chainId));
  return Object.freeze(accounts.map((reference) => {
    const grants = scopes.filter((namespace) => namespace.accounts.includes(reference));
    return Object.freeze({
      account: Object.freeze(parseCaip10EvmAccount(reference)),
      methods: orderedUnion(grants.flatMap((namespace) => namespace.methods)),
      events: orderedUnion(grants.flatMap((namespace) => namespace.events)),
    });
  }));
};
export const eligibleWalletAccounts = (
  namespaces: readonly WalletNamespace[], chainId: EvmChainId, requiredMethods: readonly string[],
): readonly WalletAccountPermission[] => Object.freeze(walletAccountPermissions(namespaces, chainId)
  .filter((permission) => requiredMethods.every((method) => permission.methods.includes(method))));
export const normalizeWalletNamespaces = (
  input: Readonly<Record<string, Readonly<{
    accounts: readonly string[]; methods: readonly string[]; events: readonly string[]; chains?: readonly string[];
  }>>>,
): readonly WalletNamespace[] => {
  const ordered = (values: readonly string[]): string[] => [...values].sort(compareCodePointSequences);
  const keys = Object.keys(input);
  if (keys.length > walletSdkNamespaceLimit) throw new TypeError("Wallet namespace set is excessive.");
  return Object.freeze(walletNamespacesSchema.parse(keys.sort(compareCodePointSequences).map((key) => {
    const namespace = input[key]!;
    walletNamespaceKeySchema.parse(key);
    for (const values of [namespace.accounts, namespace.methods, namespace.events, namespace.chains ?? []]) {
      if (!Array.isArray(values) || values.length > walletSdkNamespaceArrayLimit) throw new TypeError("Wallet namespace array is excessive.");
    }
    const family = key.split(":")[0];
    return {
      key,
      accounts: ordered(namespace.accounts.map((value) => family === "eip155"
        ? deriveCaip10Account(parseCaip10EvmAccount(value)) : value)),
      methods: ordered(namespace.methods), events: ordered(namespace.events),
      ...(namespace.chains === undefined ? {} : { chains: ordered(namespace.chains) }),
    };
  })).map((namespace) => Object.freeze(namespace)));
};
