import {canonicalJsonStringify, fixedIdentifierAsciiLengthLimit, maximumSuccessUtf8Bytes, type CanonicalJson} from "../core/index.js";
import {walletConnectionLimits, walletConnectionStatusDefinitions, type WalletConnectionData} from "../wallet/connection-contract.js";
import { internalCanonicalJsonResponseLimitBytes } from "./http-limits.js";

const permissionArrayBytes = (count: number): number =>
  count * (2 * fixedIdentifierAsciiLengthLimit + 3) + 1;

export const walletConnectionStorageLimits = Object.freeze({
  approvedMethodsJson: permissionArrayBytes(walletConnectionLimits.approvedMethods),
  approvedEventsJson: permissionArrayBytes(walletConnectionLimits.approvedEvents),
  revision: internalCanonicalJsonResponseLimitBytes,
  sessionCount: maximumSuccessUtf8Bytes,
});

export const assertWalletConnectionStorageSize = (
  values: WalletConnectionStorageValues,
  revision: string,
): void => {
  for (const [value, maximum] of [
    [revision, walletConnectionStorageLimits.revision],
    [values.sessionCount, walletConnectionStorageLimits.sessionCount],
    [values.approvedMethodsJson, walletConnectionStorageLimits.approvedMethodsJson],
    [values.approvedEventsJson, walletConnectionStorageLimits.approvedEventsJson],
  ] as const) {
    if (value !== null && new TextEncoder().encode(value).length > maximum) {
      throw new TypeError("Wallet connection storage value exceeds its containing contract.");
    }
  }
};

export interface WalletConnectionStorageRow {
  readonly status: string;
  readonly reason: string | null;
  readonly chainId: string | null;
  readonly walletAddress: string | null;
  readonly approvedMethodsJson: string | null;
  readonly approvedEventsJson: string | null;
  readonly expiresAt: string | null;
  readonly sessionCount: string | null;
}

export type WalletConnectionStorageValues = WalletConnectionStorageRow;

type StoredField = Exclude<keyof WalletConnectionStorageRow, "status">;
type WalletConnectionStatus = keyof typeof walletConnectionStatusDefinitions;

const storedFields = Object.freeze([
  { field: "reason", column: "reason" },
  { field: "chainId", column: "chain_id" },
  { field: "walletAddress", column: "wallet_address" },
  { field: "approvedMethodsJson", column: "approved_methods_json" },
  { field: "approvedEventsJson", column: "approved_events_json" },
  { field: "expiresAt", column: "expires_at" },
  { field: "sessionCount", column: "session_count" },
] as const satisfies readonly { readonly field: StoredField; readonly column: string }[]);

const emptyValues = (): Omit<WalletConnectionStorageValues, "status"> => ({
  reason: null,
  chainId: null,
  walletAddress: null,
  approvedMethodsJson: null,
  approvedEventsJson: null,
  expiresAt: null,
  sessionCount: null,
});

const parseCanonicalArray = (value: string): unknown => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || canonicalJsonStringify(parsed as CanonicalJson) !== value) {
    throw new Error("Stored canonical array is invalid.");
  }
  return parsed;
};

interface StorageVariant {
  readonly status: WalletConnectionStatus;
  readonly present: readonly StoredField[];
  readonly reasons: readonly string[];
  encode(connection: WalletConnectionData): WalletConnectionStorageValues;
  decode(row: WalletConnectionStorageRow): unknown;
}

const reasonVariant = <Status extends "unknown" | "disconnected">(
  status: Status,
  reasons: (typeof walletConnectionStatusDefinitions)[Status]["reasons"],
): StorageVariant => Object.freeze({
  status,
  present: Object.freeze(["reason"] as const),
  reasons,
  encode(connection: WalletConnectionData): WalletConnectionStorageValues {
    if (connection.status !== status) throw new TypeError("Wallet storage projection status is invalid.");
    return Object.freeze({ status, ...emptyValues(), reason: connection.reason });
  },
  decode: (row: WalletConnectionStorageRow) => ({ status, reason: row.reason }),
});

const storageVariants = Object.freeze({
  unknown: reasonVariant("unknown", walletConnectionStatusDefinitions.unknown.reasons),
  disconnected: reasonVariant("disconnected", walletConnectionStatusDefinitions.disconnected.reasons),
  unresolved: Object.freeze({
    status: "unresolved",
    present: Object.freeze(["sessionCount"] as const),
    reasons: walletConnectionStatusDefinitions.unresolved.reasons,
    encode(connection: WalletConnectionData): WalletConnectionStorageValues {
      if (connection.status !== "unresolved") throw new TypeError("Wallet storage projection status is invalid.");
      return Object.freeze({
        status: "unresolved",
        ...emptyValues(),
        sessionCount: connection.sessionCount,
      });
    },
    decode: (row: WalletConnectionStorageRow) => ({
      status: "unresolved",
      sessionCount: row.sessionCount,
    }),
  }),
  connected: Object.freeze({
    status: "connected",
    present: Object.freeze([
      "chainId",
      "walletAddress",
      "approvedMethodsJson",
      "approvedEventsJson",
      "expiresAt",
    ] as const),
    reasons: walletConnectionStatusDefinitions.connected.reasons,
    encode(connection: WalletConnectionData): WalletConnectionStorageValues {
      if (connection.status !== "connected") throw new TypeError("Wallet storage projection status is invalid.");
      return Object.freeze({
        status: "connected",
        ...emptyValues(),
        chainId: connection.chainId,
        walletAddress: connection.address,
        approvedMethodsJson: canonicalJsonStringify(connection.approvedMethods as unknown as CanonicalJson),
        approvedEventsJson: canonicalJsonStringify(connection.approvedEvents as unknown as CanonicalJson),
        expiresAt: connection.expiresAt,
      });
    },
    decode: (row: WalletConnectionStorageRow) => ({
      status: "connected",
      chainId: row.chainId,
      address: row.walletAddress,
      approvedMethods: parseCanonicalArray(row.approvedMethodsJson as string),
      approvedEvents: parseCanonicalArray(row.approvedEventsJson as string),
      expiresAt: row.expiresAt,
    }),
  }),
} satisfies Record<WalletConnectionStatus, StorageVariant>);

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const variantList = Object.freeze(Object.values(storageVariants));
const statusDefinitionNames = Object.keys(walletConnectionStatusDefinitions).sort();
const storageVariantNames = Object.keys(storageVariants).sort();
if (JSON.stringify(statusDefinitionNames) !== JSON.stringify(storageVariantNames)) {
  throw new Error("Wallet connection storage status mapping is incomplete.");
}

export const walletConnectionFieldPresenceCheckSql = `CHECK (\n${variantList
  .map((variant) => {
    const present = new Set<StoredField>(variant.present);
    const fields = storedFields.map(({ field, column }) =>
      `${column} IS ${present.has(field) ? "NOT " : ""}NULL`);
    const reasonMembership = variant.reasons.length === 0
      ? []
      : [`reason IN (${variant.reasons.map(sqlString).join(", ")})`];
    return `    (status = ${sqlString(variant.status)} AND ${[...fields, ...reasonMembership].join(" AND ")})`;
  })
  .join(" OR\n")}\n  )`;

export const encodeWalletConnectionStorage = (
  connection: WalletConnectionData,
): WalletConnectionStorageValues => {
  const variant = storageVariants[connection.status];
  return variant.encode(connection);
};

export const decodeWalletConnectionStorage = (row: WalletConnectionStorageRow): unknown => {
  if (!Object.hasOwn(storageVariants, row.status)) {
    throw new Error("Stored wallet connection state is invalid.");
  }
  const variant = storageVariants[row.status as WalletConnectionStatus];
  const present = new Set<StoredField>(variant.present);
  if (storedFields.some(({ field }) => (row[field] !== null) !== present.has(field))) {
    throw new Error("Stored wallet connection field presence is invalid.");
  }
  const reasons: readonly string[] = variant.reasons;
  if (reasons.length > 0 && !reasons.includes(row.reason ?? "")) {
    throw new Error("Stored wallet connection reason is invalid.");
  }
  return variant.decode(row);
};
