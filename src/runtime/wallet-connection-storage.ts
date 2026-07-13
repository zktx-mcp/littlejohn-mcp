import {
  canonicalJsonStringify,
  type CanonicalJson,
  type WalletConnectionData,
} from "../core/index.js";

export interface WalletConnectionStorageRow {
  readonly status: string;
  readonly reason: string | null;
  readonly account: string | null;
  readonly address: string | null;
  readonly chainId: string | null;
  readonly approvedMethodsJson: string | null;
  readonly approvedEventsJson: string | null;
  readonly expiresAt: string | null;
  readonly eligibleSessionCount: string | null;
}

export type WalletConnectionStorageValues = WalletConnectionStorageRow;

type StoredField = Exclude<keyof WalletConnectionStorageRow, "status">;

const storedFields = Object.freeze([
  { field: "reason", column: "reason" },
  { field: "account", column: "account" },
  { field: "address", column: "address" },
  { field: "chainId", column: "chain_id" },
  { field: "approvedMethodsJson", column: "approved_methods_json" },
  { field: "approvedEventsJson", column: "approved_events_json" },
  { field: "expiresAt", column: "expires_at" },
  { field: "eligibleSessionCount", column: "eligible_session_count" },
] as const satisfies readonly { readonly field: StoredField; readonly column: string }[]);

const emptyValues = (): Omit<WalletConnectionStorageValues, "status"> => ({
  reason: null,
  account: null,
  address: null,
  chainId: null,
  approvedMethodsJson: null,
  approvedEventsJson: null,
  expiresAt: null,
  eligibleSessionCount: null,
});

const parseCanonicalArray = (value: string): unknown => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || canonicalJsonStringify(parsed as unknown as CanonicalJson) !== value) {
    throw new Error("Stored canonical array is invalid.");
  }
  return parsed;
};

interface StorageVariant {
  readonly status: WalletConnectionData["status"];
  readonly present: readonly StoredField[];
  encode(connection: WalletConnectionData): WalletConnectionStorageValues;
  decode(row: WalletConnectionStorageRow): unknown;
}

const reasonVariant = (status: "unknown" | "disconnected"): StorageVariant => Object.freeze({
  status,
  present: Object.freeze(["reason"] as const),
  encode(connection: WalletConnectionData): WalletConnectionStorageValues {
    if (connection.status !== status) throw new TypeError("Wallet storage projection status is invalid.");
    return Object.freeze({ status, ...emptyValues(), reason: connection.reason });
  },
  decode: (row: WalletConnectionStorageRow) => ({ status, reason: row.reason }),
});

const storageVariants = Object.freeze([
  reasonVariant("unknown"),
  reasonVariant("disconnected"),
  Object.freeze({
    status: "unresolved",
    present: Object.freeze(["eligibleSessionCount"] as const),
    encode(connection: WalletConnectionData): WalletConnectionStorageValues {
      if (connection.status !== "unresolved") throw new TypeError("Wallet storage projection status is invalid.");
      return Object.freeze({
        status: "unresolved",
        ...emptyValues(),
        eligibleSessionCount: connection.eligibleSessionCount,
      });
    },
    decode: (row: WalletConnectionStorageRow) => ({
      status: "unresolved",
      eligibleSessionCount: row.eligibleSessionCount,
    }),
  }),
  Object.freeze({
    status: "connected",
    present: Object.freeze([
      "account",
      "address",
      "chainId",
      "approvedMethodsJson",
      "approvedEventsJson",
      "expiresAt",
    ] as const),
    encode(connection: WalletConnectionData): WalletConnectionStorageValues {
      if (connection.status !== "connected") throw new TypeError("Wallet storage projection status is invalid.");
      return Object.freeze({
        status: "connected",
        ...emptyValues(),
        account: connection.account,
        address: connection.address,
        chainId: connection.chainId,
        approvedMethodsJson: canonicalJsonStringify(connection.approvedMethods as unknown as CanonicalJson),
        approvedEventsJson: canonicalJsonStringify(connection.approvedEvents as unknown as CanonicalJson),
        expiresAt: connection.expiresAt,
      });
    },
    decode: (row: WalletConnectionStorageRow) => ({
      status: "connected",
      account: row.account,
      address: row.address,
      chainId: row.chainId,
      approvedMethods: parseCanonicalArray(row.approvedMethodsJson as string),
      approvedEvents: parseCanonicalArray(row.approvedEventsJson as string),
      expiresAt: row.expiresAt,
    }),
  }),
] satisfies readonly StorageVariant[]);

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const walletConnectionFieldPresenceCheckSql = `CHECK (\n${storageVariants
  .map((variant) => {
    const present = new Set<StoredField>(variant.present);
    const fields = storedFields.map(({ field, column }) =>
      `${column} IS ${present.has(field) ? "NOT " : ""}NULL`);
    return `    (status = ${sqlString(variant.status)} AND ${fields.join(" AND ")})`;
  })
  .join(" OR\n")}\n  )`;

export const encodeWalletConnectionStorage = (
  connection: WalletConnectionData,
): WalletConnectionStorageValues => {
  const variant = storageVariants.find((candidate) => candidate.status === connection.status);
  if (variant === undefined) throw new TypeError("Wallet storage projection status is invalid.");
  return variant.encode(connection);
};

export const decodeWalletConnectionStorage = (row: WalletConnectionStorageRow): unknown => {
  const variant = storageVariants.find((candidate) => candidate.status === row.status);
  if (variant === undefined) throw new Error("Stored wallet connection state is invalid.");
  const present = new Set<StoredField>(variant.present);
  if (storedFields.some(({ field }) => (row[field] !== null) !== present.has(field))) {
    throw new Error("Stored wallet connection field presence is invalid.");
  }
  return variant.decode(row);
};
