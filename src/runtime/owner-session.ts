import type { RuntimeHttpRequest } from "./http-boundary.js";
import type {
  OwnerInstanceId,
  ProfileId,
  RuntimeConfigurationMac,
  RuntimeRevision,
} from "./runtime-identity.js";

export interface RuntimeOwnerSessionIdentity {
  readonly profileId: ProfileId;
  readonly ownerInstanceId: OwnerInstanceId;
  readonly configurationMac: RuntimeConfigurationMac;
  readonly ownerRevision: RuntimeRevision;
}

export type RuntimeOwnerSessionRequest = RuntimeHttpRequest & Readonly<{
  maximumResponseBytes: number;
  responseDeadlineMilliseconds: number;
}>;

export interface RuntimeOwnerResponsePacket {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
  readonly bytes: Uint8Array;
}

export type RuntimeOwnerSendResult =
  | Readonly<{
      status: "request_not_sent";
      reason: "request_aborted" | "owner_unavailable";
    }>
  | Readonly<{
      status: "response_received";
      response: RuntimeOwnerResponsePacket;
    }>
  | Readonly<{ status: "response_unavailable_after_send_began" }>;

export interface RuntimeOwnerSession {
  readonly identity: RuntimeOwnerSessionIdentity;
  readonly usable: boolean;
  send(request: RuntimeOwnerSessionRequest, callerSignal?: AbortSignal): Promise<RuntimeOwnerSendResult>;
  close(): Promise<void> | void;
}

export interface RuntimeOwnerSessionPort {
  openOwnerSession(signal?: AbortSignal): Promise<RuntimeOwnerSession>;
}
