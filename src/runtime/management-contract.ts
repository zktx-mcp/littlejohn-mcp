import { z } from "zod";
import { runtimePackageIdentity } from "./package-identity.js";
import { canonicalBase64UrlSchema, fixedIdentifierSchema, unsignedDecimalSchema } from "../core/client.js";
import { localControlApiPathPrefix, type RuntimeHttpRequest } from "./http-boundary.js";
import { internalCanonicalJsonResponseLimitBytes } from "./http-limits.js";
import { runtimeControlProtocolVersion, runtimeLifecyclePhaseSchema } from "./runtime-identity.js";

export const runtimeCliCommandIdentities = Object.freeze({
  status: Object.freeze({ domain: "runtime", command: "status", argumentSyntax: "[--shutdown <owner-instance-id>] [--json]" }),
  stop: Object.freeze({ domain: "runtime", command: "stop", argumentSyntax: "[--json]" }),
} as const);

export const runtimeManagementResources = Object.freeze({
  status: { method: "GET", mutation: "none", path: `${localControlApiPathPrefix}runtime/status` },
  shutdown: { method: "POST", mutation: "declared_control", path: `${localControlApiPathPrefix}runtime/shutdown` },
} as const);

export const isRuntimeManagementRequest = (request: Pick<RuntimeHttpRequest, "method" | "path">): boolean =>
  Object.values(runtimeManagementResources).some(resource => resource.method === request.method && resource.path === request.path);

export const runtimeShutdownTargetSchema = z.object({
  profileId: canonicalBase64UrlSchema(16),
  ownerInstanceId: canonicalBase64UrlSchema(16),
  ownerRevision: unsignedDecimalSchema,
}).strict();
export type RuntimeShutdownTarget = z.infer<typeof runtimeShutdownTargetSchema>;

export const runtimeStatusSchema = z.object({
  phase: runtimeLifecyclePhaseSchema,
  target: runtimeShutdownTargetSchema,
  packageName: z.literal(runtimePackageIdentity.name),
  packageVersion: z.literal(runtimePackageIdentity.version),
  controlProtocolVersion: z.literal(runtimeControlProtocolVersion),
}).strict();
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

export const runtimeStopAcceptedSchema = z.object({
  status: z.literal("stopping"), target: runtimeShutdownTargetSchema,
}).strict();

export const runtimeShutdownRecordSchema = runtimeShutdownTargetSchema.extend({
  configurationMac: canonicalBase64UrlSchema(32),
  packageName: fixedIdentifierSchema,
  packageVersion: fixedIdentifierSchema,
  controlProtocolVersion: z.literal(runtimeControlProtocolVersion),
  outcome: z.literal("released"),
  proof: canonicalBase64UrlSchema(32),
}).strict();
export type RuntimeShutdownRecord = z.infer<typeof runtimeShutdownRecordSchema>;

export const runtimeShutdownObservationSchema = z.union([
  z.object({ status: z.literal("released"), target: runtimeShutdownTargetSchema }).strict(),
  z.object({ status: z.literal("shutdown_unconfirmed"), target: runtimeShutdownTargetSchema.pick({ profileId: true, ownerInstanceId: true }).extend({ ownerRevision: unsignedDecimalSchema.optional() }) }).strict(),
  z.object({ status: z.literal("not_running") }).strict(),
]);
export type RuntimeShutdownObservation = z.infer<typeof runtimeShutdownObservationSchema>;

// The record removes the challenge/role/phase from the identity envelope and
// adds only the released outcome. It fits its existing canonical carrier.
export const runtimeShutdownRecordMaximumBytes = internalCanonicalJsonResponseLimitBytes;
// Runtime operating choices are independent of SDK approval/settlement clocks.
// See NUMERIC_POLICY: startup aligns with the pinned MCP default request window;
// shutdown observation retains one local-control maximum wait across carriers.
export const runtimeBackendStartupMilliseconds = 60_000;
export const runtimeShutdownObservationMilliseconds = 300_000;
