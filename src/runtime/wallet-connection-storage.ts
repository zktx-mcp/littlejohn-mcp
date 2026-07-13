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
  readonly chain_id: string | null;
  readonly approved_methods_json: string | null;
  readonly approved_events_json: string | null;
  readonly expires_at: string | null;
  readonly eligible_session_count: string | null;
}

export interface WalletConnectionStorageValues {
  readonly status: string;
  readonly reason: string | null;
  readonly account: string | null;
  readonly address: string | null;
  readonly chainId: string | null;
  readonly methods: string | null;
  readonly events: string | null;
  readonly expiresAt: string | null;
  readonly eligibleCount: string | null;
}

type StoredField = Exclude<keyof WalletConnectionStorageRow, "status">;

const storedFields = Object.freeze([
  "reason",
  "account",
  "address",
  "chain_id",
  "approved_methods_json",
  "approved_events_json",
  "expires_at",
  "eligible_session_count",
] as const satisfies readonly StoredField[]);

const emptyValues = (): Omit<WalletConnectionStorageValues, "status"> => ({
  reason: null,
  account: null,
  address: null,
  chainId: null,
  methods: null,
  events: null,
  expiresAt: null,
  eligibleCount: null,
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
    present: Object.freeze(["eligible_session_count"] as const),
    encode(connection: WalletConnectionData): WalletConnectionStorageValues {
      if (connection.status !== "unresolved") throw new TypeError("Wallet storage projection status is invalid.");
      return Object.freeze({
        status: "unresolved",
        ...emptyValues(),
        eligibleCount: connection.eligibleSessionCount,
      });
    },
    decode: (row: WalletConnectionStorageRow) => ({
      status: "unresolved",
      eligibleSessionCount: row.eligible_session_count,
    }),
  }),
  Object.freeze({
    status: "connected",
    present: Object.freeze([
      "account",
      "address",
      "chain_id",
      "approved_methods_json",
      "approved_events_json",
      "expires_at",
    ] as const),
    encode(connection: WalletConnectionData): WalletConnectionStorageValues {
      if (connection.status !== "connected") throw new TypeError("Wallet storage projection status is invalid.");
      return Object.freeze({
        status: "connected",
        ...emptyValues(),
        account: connection.account,
        address: connection.address,
        chainId: connection.chainId,
        methods: canonicalJsonStringify(connection.approvedMethods as unknown as CanonicalJson),
        events: canonicalJsonStringify(connection.approvedEvents as unknown as CanonicalJson),
        expiresAt: connection.expiresAt,
      });
    },
    decode: (row: WalletConnectionStorageRow) => ({
      status: "connected",
      account: row.account,
      address: row.address,
      chainId: row.chain_id,
      approvedMethods: parseCanonicalArray(row.approved_methods_json as string),
      approvedEvents: parseCanonicalArray(row.approved_events_json as string),
      expiresAt: row.expires_at,
    }),
  }),
] satisfies readonly StorageVariant[]);

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const walletConnectionFieldPresenceCheckSql = `CHECK (\n${storageVariants
  .map((variant) => {
    const present = new Set<StoredField>(variant.present);
    const fields = storedFields.map((field) => `${field} IS ${present.has(field) ? "NOT " : ""}NULL`);
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
  if (storedFields.some((field) => (row[field] !== null) !== present.has(field))) {
    throw new Error("Stored wallet connection field presence is invalid.");
  }
  return variant.decode(row);
};
