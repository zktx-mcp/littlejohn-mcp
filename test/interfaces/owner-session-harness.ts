import {
  canonicalJsonStringify,
  parseUnsignedDecimal,
} from "../../src/core/index.js";
import type { RuntimeDispatchPort } from "../../src/interfaces/http-client.js";
import {
  jsonContentType,
  noStoreCacheControl,
  type RuntimeOwnerSession,
  type RuntimeOwnerSessionRequest,
  type RuntimeOwnerSendResult,
  runtimeProtocolVersion,
} from "../../src/runtime/index.js";
import {
  parseOwnerInstanceId,
  parseProfileId,
  parseRuntimeConfigurationMac,
} from "../../src/runtime/runtime-identity.js";

const identity = Object.freeze({
  profileId: parseProfileId(Buffer.alloc(16, 1).toString("base64url")),
  ownerInstanceId: parseOwnerInstanceId(Buffer.alloc(16, 2).toString("base64url")),
  runtimeProtocolVersion,
  configurationMac: parseRuntimeConfigurationMac(Buffer.alloc(32, 3).toString("base64url")),
  ownerRevision: parseUnsignedDecimal("1"),
});

export const openTestOwnerSession = async (
  runtime: RuntimeDispatchPort,
  lifecycleSignal?: AbortSignal,
): Promise<RuntimeOwnerSession> => {
  let closed = false;
  const closeController = new AbortController();
  const close = (): void => {
    if (closed) return;
    closed = true;
    closeController.abort();
  };
  lifecycleSignal?.addEventListener("abort", close, { once: true });
  return Object.freeze({
    identity,
    get usable(): boolean { return !closed; },
    async send(
      request: RuntimeOwnerSessionRequest,
      callerSignal?: AbortSignal,
    ): Promise<RuntimeOwnerSendResult> {
      if (closed) return Object.freeze({
        status: "request_not_sent" as const,
        reason: "owner_unavailable" as const,
      });
      if (callerSignal?.aborted === true || lifecycleSignal?.aborted === true) return Object.freeze({
        status: "request_not_sent" as const,
        reason: "request_aborted" as const,
      });
      const signal = callerSignal === undefined
        ? closeController.signal
        : AbortSignal.any([closeController.signal, callerSignal]);
      const aborted = new Promise<"aborted">((resolve) => {
        signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      const response = runtime.dispatchRuntimeRequest(Object.freeze({
        requestClass: "local_control",
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal,
      })).then((value) => ({ status: "response" as const, value }), () => ({ status: "failed" as const }));
      const result = await Promise.race([response, aborted]);
      if (result === "aborted" || result.status === "failed") {
        return Object.freeze({ status: "response_unavailable_after_send_began" as const });
      }
      return Object.freeze({
        status: "response_received" as const,
        response: Object.freeze({
          statusCode: result.value.status,
          contentType: jsonContentType,
          cacheControl: noStoreCacheControl,
          bytes: new TextEncoder().encode(`${canonicalJsonStringify(result.value.body)}\n`),
        }),
      });
    },
    close,
  });
};
