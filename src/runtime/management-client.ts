import { canonicalJsonStringify, captureCanonicalJson } from "../core/index.js";
import { readRuntimeConfiguration } from "./configuration.js";
import { deriveRuntimeConfigurationMac, readControlCredential } from "./control-credential.js";
import { openRuntimeProfileReader } from "./database.js";
import { RuntimeOperationError, createRuntimeFailure, toProblemDetails } from "./errors.js";
import { resolveApplicationDataDirectory, runtimePaths } from "./paths.js";
import { connectPinnedAgent, openAuthenticatedOwnerChannel, createAuthenticatedOwnerSession,
  PeerIncompatibleError, PeerUnavailableError, parseHttpJson } from "./owner-transport.js";
import { jsonContentType, problemJsonContentType, noStoreCacheControl } from "./http-boundary.js";
import { internalResponseLimitBytes } from "./http-limits.js";
import { runtimeCliCommandIdentities, runtimeManagementResources, runtimeShutdownObservationMilliseconds,
  runtimeShutdownTargetSchema, runtimeStatusSchema, runtimeStopAcceptedSchema,
  type RuntimeStatus, type RuntimeShutdownObservation } from "./management-contract.js";
import { readRuntimeShutdownResult, waitForRuntimeShutdownResult } from "./shutdown-results.js";
import { parseOwnerInstanceId } from "./runtime-identity.js";

export type RuntimeManagementCommand =
  | Readonly<{ kind: "status" | "stop"; json: boolean }>
  | Readonly<{ kind: "shutdown_result"; ownerInstanceId: string; json: boolean }>;
export type RuntimeManagementResult = RuntimeStatus | RuntimeShutdownObservation;
export interface RuntimeManagementCall {
  readonly result: RuntimeManagementResult;
  close(): Promise<void>;
}

export const parseRuntimeManagementCommand = (args: readonly string[]): RuntimeManagementCommand => {
  const invalid = (): never => { throw new RuntimeOperationError("invalid_input"); };
  const { status, stop } = runtimeCliCommandIdentities;
  if (args[0] !== status.domain || (args[1] !== status.command && args[1] !== stop.command)) return invalid();
  const remaining = args.slice(2);
  const json = remaining.includes("--json");
  if (remaining.filter(value => value === "--json").length > 1) return invalid();
  const values = remaining.filter(value => value !== "--json");
  if (values.length === 0) return Object.freeze({ kind: args[1], json });
  if (args[1] !== status.command || values.length !== 2 || values[0] !== "--shutdown") return invalid();
  try { return Object.freeze({ kind: "shutdown_result", ownerInstanceId: parseOwnerInstanceId(values[1]), json }); }
  catch { return invalid(); }
};

export const runRuntimeManagement = async (
  command: RuntimeManagementCommand,
  signal?: AbortSignal,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RuntimeManagementCall> => {
  const configuration = command.kind === "shutdown_result" ? undefined : readRuntimeConfiguration(environment);
  const paths = runtimePaths(resolveApplicationDataDirectory(environment));
  if (command.kind !== "shutdown_result") {
    // Refusal is a direct observation, independent of missing profile files.
    // No credential is sent on this presence-only connection.
    try { const probe = await connectPinnedAgent(signal); await probe.close(); }
    catch (error) {
      if (error instanceof PeerUnavailableError && error.refused) return { result: { status: "not_running" }, close: async () => {} };
      throw error instanceof RuntimeOperationError ? error : new RuntimeOperationError("runtime_state_unavailable");
    }
  }
  const profile = await openRuntimeProfileReader(paths.database);
  let closed = false;
  const finish = (result: RuntimeManagementResult): RuntimeManagementCall => Object.freeze({ result,
    close: async () => { if (closed) return; profile.close(); closed = true; } });
  try {
    const credential = await readControlCredential(paths.controlCredential);
    if (command.kind === "shutdown_result") {
      return finish(await readRuntimeShutdownResult({ directory: paths.dataDirectory, credential,
        target: { profileId: profile.readProfile().profileId, ownerInstanceId: command.ownerInstanceId } }));
    }
    const configurationMac = deriveRuntimeConfigurationMac(credential, configuration!);
    let connection;
    try { connection = await openAuthenticatedOwnerChannel({ ownerStore: profile, credential, configurationMac }, signal); }
    catch (error) {
      if (error instanceof PeerIncompatibleError) throw new RuntimeOperationError("port_conflict");
      throw error instanceof RuntimeOperationError ? error : new RuntimeOperationError("runtime_state_unavailable");
    }
    const target = runtimeShutdownTargetSchema.parse({ profileId: connection.identity.profileId,
      ownerInstanceId: connection.identity.ownerInstanceId, ownerRevision: connection.identity.ownerRevision });
    const session = createAuthenticatedOwnerSession(connection, credential, signal ?? new AbortController().signal, () => {});
    const deadline = performance.now() + runtimeShutdownObservationMilliseconds;
    try {
      const resource = runtimeManagementResources[command.kind === "status" ? "status" : "shutdown"];
      const sent = await session.send({ ...resource,
        ...(command.kind === "stop" ? { method: "POST" as const, body: captureCanonicalJson(target) } : { method: "GET" as const }),
        maximumResponseBytes: internalResponseLimitBytes,
        responseDeadlineMilliseconds: runtimeShutdownObservationMilliseconds,
      }, signal);
      if (sent.status === "request_not_sent") throw new RuntimeOperationError(sent.reason === "request_aborted" ? "request_aborted" : "runtime_state_unavailable");
      const admittedCarrier = sent.status === "response_received" &&
        sent.response.contentType === jsonContentType && sent.response.cacheControl === noStoreCacheControl;
      if (command.kind === "status") {
        if (!admittedCarrier || sent.status !== "response_received" || sent.response.statusCode !== 200) throw new RuntimeOperationError("runtime_state_unavailable");
        let value: RuntimeStatus;
        try { value = runtimeStatusSchema.parse(parseHttpJson(sent.response.bytes)); }
        catch { throw new RuntimeOperationError("runtime_state_unavailable"); }
        if (canonicalJsonStringify(captureCanonicalJson(value.target)) !== canonicalJsonStringify(captureCanonicalJson(target))) throw new RuntimeOperationError("state_conflict");
        return finish(value);
      }
      if (sent.status === "response_received") {
        // A malformed/lost acknowledgement cannot erase the exact target of
        // an already-sent stop. Its immutable result remains authoritative.
        let body: unknown;
        try { body = parseHttpJson(sent.response.bytes); } catch { body = undefined; }
        if (sent.response.statusCode === 409 && sent.response.contentType === problemJsonContentType &&
            sent.response.cacheControl === noStoreCacheControl && body !== undefined &&
            canonicalJsonStringify(captureCanonicalJson(body)) === canonicalJsonStringify(captureCanonicalJson(toProblemDetails(createRuntimeFailure("state_conflict"))))) {
          throw new RuntimeOperationError("state_conflict");
        }
        if (admittedCarrier && sent.response.statusCode === 200) {
          const accepted = runtimeStopAcceptedSchema.safeParse(body);
          if (accepted.success && canonicalJsonStringify(captureCanonicalJson(accepted.data.target)) !== canonicalJsonStringify(captureCanonicalJson(target))) {
            throw new RuntimeOperationError("state_conflict");
          }
        }
      }
      await session.close();
      return finish(await waitForRuntimeShutdownResult({ directory: paths.dataDirectory, credential, target, deadline,
        ...(signal === undefined ? {} : { signal }) }));
    } finally { await session.close(); }
  } catch (error) {
    try { profile.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Runtime management and local cleanup failed."); }
    throw error;
  }
};
