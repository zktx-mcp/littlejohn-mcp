import {
  captureCanonicalJson,
  type CanonicalJson,
} from "../core/browser.js";
import {
  parseWalletManagementOperation,
  parseWalletOperationId,
  parseWalletOperationPresentationAccess,
  parseWalletQrMatrix,
  type WalletManagementOperation,
  type WalletOperationPresentationAccess,
  type WalletQrMatrix,
} from "../wallet/operation-contract.js";

export interface OperationReadResponse {
  readonly operation: WalletManagementOperation;
  readonly access: WalletOperationPresentationAccess;
}

export interface OperationControlResponse {
  readonly operation: WalletManagementOperation;
}

export interface QrResponse {
  readonly qr: WalletQrMatrix;
}

const canonicalObject = (
  value: CanonicalJson,
): value is { readonly [key: string]: CanonicalJson } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
  value: { readonly [key: string]: CanonicalJson },
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

const parseExpectedOperation = (
  value: unknown,
  expectedOperationId?: string,
): WalletManagementOperation => {
  const operation = parseWalletManagementOperation(value);
  if (
    expectedOperationId !== undefined &&
    operation.operationId !== parseWalletOperationId(expectedOperationId)
  ) {
    throw new Error("The wallet operation response does not match the requested operation.");
  }
  return operation;
};

export const createOperationReadResponse = (
  operationInput: unknown,
  accessInput: unknown,
): OperationReadResponse => Object.freeze({
  operation: parseExpectedOperation(operationInput),
  access: parseWalletOperationPresentationAccess(accessInput),
});

export const createOperationControlResponse = (
  operationInput: unknown,
): OperationControlResponse => Object.freeze({
  operation: parseExpectedOperation(operationInput),
});

export const createQrResponse = (qrInput: unknown): QrResponse => Object.freeze({
  qr: parseWalletQrMatrix(qrInput),
});

export const parseOperationReadResponse = (
  value: unknown,
  expectedOperationId: string,
): OperationReadResponse => {
  const captured = captureCanonicalJson(value);
  if (!canonicalObject(captured) || !exactKeys(captured, ["access", "operation"])) {
    throw new Error("The wallet operation response is invalid.");
  }
  const response = createOperationReadResponse(
    captured["operation"],
    captured["access"],
  );
  parseExpectedOperation(response.operation, expectedOperationId);
  return response;
};

export const parseOperationControlResponse = (
  value: unknown,
  expectedOperationId: string,
): OperationControlResponse => {
  const captured = captureCanonicalJson(value);
  if (!canonicalObject(captured) || !exactKeys(captured, ["operation"])) {
    throw new Error("The wallet operation control response is invalid.");
  }
  const response = createOperationControlResponse(captured["operation"]);
  parseExpectedOperation(response.operation, expectedOperationId);
  return response;
};

export const parseQrResponse = (value: unknown): QrResponse => {
  const captured = captureCanonicalJson(value);
  if (!canonicalObject(captured) || !exactKeys(captured, ["qr"])) {
    throw new Error("The wallet pairing code response is invalid.");
  }
  return createQrResponse(captured["qr"]);
};
