import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { captureCanonicalJson, type ApplicationFailure, type CanonicalJson } from "../../../core/client.js";
import type { DeliveryUnknown } from "../../operation-delivery.js";
import { admitMcpToolResultDeliveryError } from "../../mcp-result.js";
import { cardControlContracts } from "../card-contract.js";
import type { PresentationUnavailable } from "../contracts.js";
import { presentationContractRegistry } from "../registry.js";
import { recoverCodexOperationToolResult } from "./codex-operation-result-adapter.js";

export type ViewIssue =
  | Readonly<{ kind: "application"; failure: ApplicationFailure }>
  | Readonly<{ kind: "presentation"; unavailable: PresentationUnavailable }>
  | Readonly<{ kind: "delivery"; message: string }>
  | Readonly<{ kind: "operation_delivery"; delivery: DeliveryUnknown }>;

export type ViewResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; issue: ViewIssue }>;

export const applicationIssue = (failure: ApplicationFailure): ViewIssue => ({ kind: "application", failure });

export const registeredFailure = (value: unknown): ApplicationFailure | undefined => {
  const failure = presentationContractRegistry.parseFailure(value);
  if (failure !== undefined) return failure;
  try { return cardControlContracts.read.parseFailure(value); }
  catch { return undefined; }
};

// The caller supplies its owning value admissions. This process alone selects
// standard carriage, the existing measured adapter, and received failure meaning.
// An admitted failure is a value; it never enters the transport-recovery catch.
export const admitToolReply = <T>(
  result: CallToolResult,
  context: Readonly<{
    hostName: string | undefined;
    toolName: string;
    inputEvidence: Readonly<{ utf8Bytes: number; sha256: string }>;
  }>,
  owner: Readonly<{
    success(value: CanonicalJson): T;
    failure(value: CanonicalJson): ViewIssue;
  }>,
): ViewResult<T> => {
  const delivery = admitMcpToolResultDeliveryError(result);
  if (delivery !== undefined) return { ok: false, issue: { kind: "delivery", message: delivery.message } };
  const admit = (value: CanonicalJson): ViewResult<T> => result.isError === true
    ? { ok: false, issue: owner.failure(value) }
    : { ok: true, value: owner.success(value) };
  try { return admit(captureCanonicalJson(result.structuredContent)); }
  catch {
    return admit(recoverCodexOperationToolResult({ ...context, result }));
  }
};
