import type {
  UtcTimestamp,
  WalletConnectionData,
} from "../core/index.js";
import type {
  RuntimeRevision,
} from "./runtime-identity.js";

export interface WalletConnectionRecord {
  readonly revision: RuntimeRevision;
  readonly connection: WalletConnectionData;
  readonly revalidationRequired: boolean;
  readonly updatedAt: UtcTimestamp;
}

export interface WalletProjectionStore {
  read(): WalletConnectionRecord;
  replace(
    expectedRevision: string,
    connection: WalletConnectionData,
    revalidationRequired: boolean,
    updatedAt: UtcTimestamp,
  ): WalletConnectionRecord;
}
