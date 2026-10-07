export const walletConnectStorageLimits = Object.freeze({
  keys: 4_096,
  keyBytes: 4_096,
  valueBytes: 16 * 1024 * 1024,
  aggregateValueBytes: 128 * 1024 * 1024,
  revision: (1n << 63n) - 1n,
  busyTimeoutMilliseconds: 5_000,
});
