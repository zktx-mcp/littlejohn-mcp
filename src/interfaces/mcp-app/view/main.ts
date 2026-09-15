import { mountCard, createCardOpenRequestId } from "./card-lifecycle.js";
import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { admitPresentationToolResult } from "./lifecycle.js";
import { operationToolResultEvidence } from "../contracts.js";
import {
  renderPresentation,
  renderPresentationFailure,
  renderApplicationFailure,
  renderViewIssue,
  renderPresentationPending,
  replaceOperationRegion,
  renderOperationMessage,
} from "./renderers.js";
import { createPresentationLifecycle } from "./presentation-lifecycle.js";
import "./visual-tokens.css";

const root = document.getElementById("app");
if (root === null) throw new TypeError("MCP App root is unavailable.");

const app = new App(
  { name: "littlejohn-view", version: "1.0.0" },
  {},
  { autoResize: true, strict: true },
);
const controller = new AbortController();
const presentation = createPresentationLifecycle(root, app);
let connected = false;
let pending: CallToolResult | undefined;
let receivedDigest: string | undefined;
let settled = false;
let processing = false;

const fail = (_error: unknown): void => {
  if (controller.signal.aborted) return;
  settled = true;
  controller.abort();
  presentation.replaceStatic(renderPresentationFailure(
    "Little John could not verify the data required to display this result.",
  ));
};

const drain = async (): Promise<void> => {
  if (!connected || pending === undefined || settled || processing) return;
  processing = true;
  const result = pending;
  pending = undefined;
  try {
    const outcome = await admitPresentationToolResult(app, result, controller.signal);
    if (controller.signal.aborted || settled) return;
    if (outcome.status === "tool_error") {
      settled = true;
      presentation.replaceStatic(outcome.failure === undefined ? renderPresentationFailure(outcome.message) : renderApplicationFailure(outcome.failure));
      return;
    }
    if (outcome.status === "read_error") {
      settled = true;
      presentation.replaceStatic(renderViewIssue(outcome.issue));
      return;
    }
    if (outcome.status === "card") {
      await mountCard(app, outcome.card, result, outcome.card.entry === "decision" ? createCardOpenRequestId() : undefined, root, controller.signal);
      settled = true;
      return;
    }
    const admitted = outcome.presentation;
    if (admitted.entry.presentationKind === "operation") {
      throw new TypeError("An operation cannot create a top-level presentation.");
    }
    const rendered = renderPresentation(admitted.entry, admitted.result);
    presentation.replace(rendered);
    if (admitted.entry.presentationKind === "review") {
      replaceOperationRegion(rendered.node, renderOperationMessage("No decision required", "This fixed result requires no state change.", "unavailable"));
    }
    settled = true;
  } catch (error) {
    if (!controller.signal.aborted && !settled) fail(error);
  }
  finally { processing = false; }
};

app.addEventListener("toolresult", (result) => {
  let digest: string;
  try { digest = operationToolResultEvidence(result).sha256; }
  catch (error) { fail(error); return; }
  if (receivedDigest !== undefined) {
    if (receivedDigest !== digest) fail(new TypeError("The View received a different creating result."));
    return;
  }
  receivedDigest = digest;
  pending = result;
  void drain();
});

app.onteardown = async () => {
  controller.abort();
  presentation.dispose();
  return {};
};

presentation.replaceStatic(renderPresentationPending());
try {
  await app.connect();
  connected = true;
  await drain();
} catch (error) { fail(error); }
