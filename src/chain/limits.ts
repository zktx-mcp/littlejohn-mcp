export const rpcResponseByteLimit = 8 * 1_024 * 1_024;

export const maximumBlockTransactionHashes = Math.floor(
  (rpcResponseByteLimit - 1) / 69,
);
