import {
  validateControlCredential,
  type ControlCredentialVerifier,
} from "./control-credential.js";
import {
  fixedHostHeader,
  fixedOrigin,
  jsonContentType,
  requestBodyLimitBytes,
} from "./http-boundary.js";

export type RequestClass = "owner_identity" | "public_read" | "native_control";
export type SecurityFailureCode =
  | "invalid_host"
  | "invalid_origin"
  | "unauthorized"
  | "query_not_supported"
  | "payload_too_large"
  | "content_type_unsupported";

export interface RequestSecurityInput {
  readonly requestClass: RequestClass;
  readonly host: readonly string[];
  readonly origin: readonly string[];
  readonly authorization: readonly string[];
  readonly contentType: readonly string[];
  readonly query: string;
  readonly bodyLength: number;
  readonly acceptsBody: boolean;
  readonly controlVerifier?: ControlCredentialVerifier;
}

export type RequestSecurityResult = { readonly ok: true } | { readonly ok: false; readonly code: SecurityFailureCode };

export interface RequestEnvelopeSecurityInput {
  readonly host: readonly string[];
  readonly query: string;
  readonly bodyLength: number;
}

export interface RequestClassSecurityInput {
  readonly requestClass: RequestClass;
  readonly origin: readonly string[];
  readonly authorization: readonly string[];
  readonly controlVerifier?: ControlCredentialVerifier;
}

const exactOne = (values: readonly string[], expected: string): boolean =>
  values.length === 1 && values[0] === expected;

export const validateRequestTargetSecurity = (
  host: readonly string[],
  query: string,
): RequestSecurityResult => {
  if (!exactOne(host, fixedHostHeader)) return { ok: false, code: "invalid_host" };
  if (query !== "") return { ok: false, code: "query_not_supported" };
  return { ok: true };
};

export const validateRequestEnvelopeSecurity = (
  input: RequestEnvelopeSecurityInput,
): RequestSecurityResult => {
  const targetSecurity = validateRequestTargetSecurity(input.host, input.query);
  if (!targetSecurity.ok) return targetSecurity;
  if (!Number.isSafeInteger(input.bodyLength) || input.bodyLength < 0 || input.bodyLength > requestBodyLimitBytes) {
    return { ok: false, code: "payload_too_large" };
  }
  return { ok: true };
};

export const validateRequestClassSecurity = (
  input: RequestClassSecurityInput,
): RequestSecurityResult => {
  if (input.requestClass === "owner_identity" || input.requestClass === "native_control") {
    if (input.origin.length !== 0) return { ok: false, code: "invalid_origin" };
  } else if (input.origin.length > 1 || (input.origin.length === 1 && input.origin[0] !== fixedOrigin)) {
    return { ok: false, code: "invalid_origin" };
  }

  if (input.requestClass === "owner_identity" || input.requestClass === "public_read") {
    if (input.authorization.length !== 0) return { ok: false, code: "unauthorized" };
    return { ok: true };
  }
  if (input.controlVerifier === undefined || input.authorization.length !== 1) {
    return { ok: false, code: "unauthorized" };
  }
  const authorization = input.authorization[0] as string;
  if (!authorization.startsWith("Bearer ") ||
    !validateControlCredential(input.controlVerifier, authorization.slice(7))) {
    return { ok: false, code: "unauthorized" };
  }
  return { ok: true };
};

export const validateRequestSecurity = (input: RequestSecurityInput): RequestSecurityResult => {
  const envelopeSecurity = validateRequestEnvelopeSecurity(input);
  if (!envelopeSecurity.ok) return envelopeSecurity;
  if (!input.acceptsBody && input.bodyLength !== 0) return { ok: false, code: "payload_too_large" };
  if (input.acceptsBody && !exactOne(input.contentType, jsonContentType)) {
    return { ok: false, code: "content_type_unsupported" };
  }
  return validateRequestClassSecurity(input);
};
