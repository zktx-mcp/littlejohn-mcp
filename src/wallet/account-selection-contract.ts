import { z } from "zod";
import { capabilityIdSchema, defineApplicationContract, isStrictlyOrderedUnique, type UnsignedDecimal, type ApplicationContract, type CapabilityId } from "../core/client.js";
import { deriveCaip10Account, evmAccountIdentitySchema, evmChainIdSchema, sameEvmAccountIdentity, type EvmAccountIdentity } from "../evm/identities.js";
import { walletSdkNamespaceArrayLimit } from "./session-limits.js";
import { walletConnectionIdSchema } from "./connection-contract.js";
import { walletErrorRegistry } from "./error-registry.js";
import { walletLocalRevisionSchema } from "./local-revision.js";
import type {CardDecisionAdmission} from "../interfaces/mcp-app/card-contract.js";

export const walletAccountSelectionInputSchema = z.object({ chainId: evmChainIdSchema }).strict();
export const walletSelectAccountInputSchema = z.object({
  connectionId: walletConnectionIdSchema,
  chainId: evmChainIdSchema,
  account: evmAccountIdentitySchema,
  expectedConnectionRevision: walletLocalRevisionSchema,
  expectedSelectionRevision: walletLocalRevisionSchema,
}).strict().refine((value) => value.account.chainId === value.chainId, "Account and requested network must match.");
const selectionFields = {
  connectionId: walletConnectionIdSchema,
  connectionRevision: walletLocalRevisionSchema,
  chainId: evmChainIdSchema,
  selectionRevision: walletLocalRevisionSchema,
};
export const walletAccountSelectionSchema = z.object({
  ...selectionFields,
  account: evmAccountIdentitySchema.nullable(),
  eligibleAccounts: z.array(evmAccountIdentitySchema).max(2 * walletSdkNamespaceArrayLimit),
}).strict().refine((value) =>
  value.eligibleAccounts.every((account) => account.chainId === value.chainId) &&
  isStrictlyOrderedUnique(value.eligibleAccounts.map(deriveCaip10Account)) &&
  (value.account === null || value.eligibleAccounts.some((account) => sameEvmAccountIdentity(account, value.account!))),
  "Selection must refer to the complete ordered eligible account set.");
export const walletSelectAccountSuccessSchema = z.object({ ...selectionFields, account: evmAccountIdentitySchema }).strict()
  .refine((value) => value.account.chainId === value.chainId, "Selected account network mismatch.");
const failureCodes = Object.freeze([
  "invalid_input", "internal_error", "request_aborted", "runtime_state_unavailable", "state_conflict",
  "wallet_not_connected", "wallet_session_unusable", "wallet_account_unavailable",
] as const);
const common = { contractVersion: "1" as const, internalContextSchema: z.object({}).strict(), errorRegistry: walletErrorRegistry, failureCodes };
export const walletAccountSelectionContract = defineApplicationContract({
  ...common, inputSchema: walletAccountSelectionInputSchema, successSchema: walletAccountSelectionSchema,
  validatePublicSuccess: (input, success) => {
    if (input.chainId !== success.chainId) throw new TypeError("Account selection network mismatch.");
  },
});
export const walletSelectAccountContract = defineApplicationContract({
  ...common, inputSchema: walletSelectAccountInputSchema, successSchema: walletSelectAccountSuccessSchema,
  validatePublicSuccess: (input, success) => {
    if (input.connectionId !== success.connectionId || input.chainId !== success.chainId ||
        input.expectedConnectionRevision !== success.connectionRevision || !sameEvmAccountIdentity(input.account, success.account)) {
      throw new TypeError("Selected account does not match the direct action.");
    }
  },
});
export interface WalletAccountSelectionDefinition<Input, Result> extends ApplicationContract<Input, Record<string, never>, Result> {
  readonly capabilityId: CapabilityId;
  readonly applicationContract: ApplicationContract<Input, Record<string, never>, Result>;
}
export const walletAccountSelectionContracts: Readonly<{
  get: WalletAccountSelectionDefinition<WalletAccountSelectionInput, WalletAccountSelection>;
  select: WalletAccountSelectionDefinition<WalletSelectAccountInput, WalletSelectAccountSuccess>;
}> = Object.freeze({
  get: Object.freeze({capabilityId: capabilityIdSchema.parse("wallet.account_selection"),
    ...walletAccountSelectionContract, applicationContract: walletAccountSelectionContract}),
  select: Object.freeze({capabilityId: capabilityIdSchema.parse("wallet.select_account"),
    ...walletSelectAccountContract, applicationContract: walletSelectAccountContract}),
});
export type WalletAccountSelection = z.infer<typeof walletAccountSelectionSchema>;
export type WalletAccountSelectionInput = z.infer<typeof walletAccountSelectionInputSchema>;
export type WalletSelectAccountInput = z.infer<typeof walletSelectAccountInputSchema>;
export type WalletSelectAccountSuccess = z.infer<typeof walletSelectAccountSuccessSchema>;
export interface WalletAccountPreference {
  readonly connectionId: string | null;
  readonly chainId: WalletAccountSelectionInput["chainId"];
  readonly account: EvmAccountIdentity | null;
  readonly selectionRevision: UnsignedDecimal;
}
export interface WalletAccountSelectionPort {
  getAccountSelection(input: WalletAccountSelectionInput, signal?: AbortSignal): Promise<WalletAccountSelection>;
  selectAccount(input: WalletSelectAccountInput, signal?: AbortSignal, cardAdmission?: CardDecisionAdmission): Promise<WalletSelectAccountSuccess>;
}
