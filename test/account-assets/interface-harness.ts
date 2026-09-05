import { AccountAssetOperationError } from "../../src/account-assets/index.js";
import type { AccountAssetApplicationPort } from "../../src/account-assets/ports.js";

const unavailable = () => new AccountAssetOperationError("wallet_not_connected").failure;

export const accountAssetInterfaceHarnessPort = (): AccountAssetApplicationPort => Object.freeze({
  list: async () => unavailable(),
});
