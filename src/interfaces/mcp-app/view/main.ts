import { statusCopy } from "../../presentation-copy.js";
import { mountCard, createCardOpenRequestId, cardViewInvalidated } from "./card-lifecycle.js";
import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { admitPresentationToolResult, sameCreatingResult, type PresentationToolResultAdmission } from "./lifecycle.js";
import {
  renderPresentationFailure,
  renderApplicationFailure,
  renderPresentationPending,
  renderStatus,
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
let received: PresentationToolResultAdmission | undefined;
let started = false;
let mounted = false;
let displayedError: HTMLElement | undefined;

const fail = (): void => {
  if (controller.signal.aborted) return;
  // The card owner disposes controls/private material and retains admitted
  // public facts. A failed bootstrap has no such facts to preserve.
  controller.abort(cardViewInvalidated);
  if (displayedError !== undefined) displayedError.append(renderStatus(statusCopy.detailsUnavailable));
  else if (!mounted) presentation.replaceStatic(renderPresentationFailure());
};

const drain = async (): Promise<void> => {
  if (!connected || received === undefined || started || controller.signal.aborted) return;
  started = true;
  try {
    if (received.status === "tool_error") {
      displayedError = received.failure === undefined
        ? renderPresentationFailure() : renderApplicationFailure(received.failure);
      presentation.replaceStatic(displayedError);
      return;
    }
    const openingId = createCardOpenRequestId();
    mounted = true;
    await mountCard(app, received.card, openingId, root, controller.signal);
  } catch { fail(); }
};

const receive = async (result: CallToolResult): Promise<void> => {
  if (controller.signal.aborted) return;
  try {
    if (app.getHostVersion() === undefined) throw new TypeError("The View is not initialized.");
    const next = await admitPresentationToolResult(app, result, controller.signal);
    if (controller.signal.aborted) return;
    if (received !== undefined) {
      if (!sameCreatingResult(received, next)) fail();
      return;
    }
    received = next;
    await drain();
  } catch { fail(); }
};
app.addEventListener("toolresult", result => { void receive(result); });

app.onteardown = async () => {
  controller.abort();
  presentation.dispose();
  received = undefined;
  displayedError = undefined;
  return {};
};

presentation.replaceStatic(renderPresentationPending());
try {
  await app.connect();
  connected = true;
  await drain();
} catch { fail(); }
