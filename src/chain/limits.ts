export const rpcTransportTargetByteLimit = 4_096;
export const rpcRequestTimeoutMs = 10_000;
export const rpcResponseByteLimit = 8 * 1_024 * 1_024;
export const rpcConcurrencyLimit = 16;
export const rpcBatchCallLimit = 32;

export const maximumBlockTransactionHashes = Math.floor(
  (rpcResponseByteLimit - 1) / 69,
);
