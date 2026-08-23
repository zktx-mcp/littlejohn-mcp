import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { admitPresentationToolResult } from "./lifecycle.js";
import { mountOperationReview } from "./operation-lifecycle.js";
import {
  renderPresentation,
  renderPresentationFailure,
  renderPresentationPending,
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
let received = false;
let settled = false;
let processing = false;

const fail = (_error: unknown): void => {
  if (controller.signal.aborted) return;
  settled = true;
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
      presentation.replaceStatic(renderPresentationFailure(outcome.message));
      return;
    }
    const admitted = outcome.presentation;
    if (admitted.entry.presentationKind === "operation") {
      throw new TypeError("An operation cannot create a top-level presentation.");
    }
    const rendered = renderPresentation(admitted.entry, admitted.result);
    presentation.replace(rendered);
    if (admitted.entry.presentationKind === "review") {
      const mounted = await mountOperationReview(app, admitted, rendered.node, controller.signal);
      if (!mounted) throw new TypeError("Review lifecycle was not mounted.");
    }
    settled = true;
  } catch (error) {
    if (!controller.signal.aborted && !settled) fail(error);
  }
  finally { processing = false; }
};

app.addEventListener("toolresult", (result) => {
  if (received) {
    fail(new TypeError("The View received more than one creating result."));
    return;
  }
  received = true;
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
