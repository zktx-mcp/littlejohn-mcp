import {
  operationIdByteLength,
  operationIdFromBytes,
  type OperationId,
} from "../../core/browser.js";

export const createBrowserOperationId = (): OperationId => {
  const bytes = new Uint8Array(operationIdByteLength);
  globalThis.crypto.getRandomValues(bytes);
  return operationIdFromBytes(bytes);
};
