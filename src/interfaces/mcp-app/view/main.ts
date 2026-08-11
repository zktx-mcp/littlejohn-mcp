import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { admitPresentationToolResult } from "./lifecycle.js";
import {
  renderPresentation,
  renderPresentationFailure,
  renderPresentationPending,
} from "./renderers.js";
import "./visual-tokens.css";

const root = document.getElementById("app");
if (root === null) throw new TypeError("MCP App root is unavailable.");

const app = new App(
  { name: "littlejohn-read-view", version: "1.0.0" },
  {},
  { autoResize: true, strict: true },
);
const controller = new AbortController();
let connected = false;
let pending: CallToolResult | undefined;
let received = false;
let settled = false;
let processing = false;

const replace = (node: HTMLElement): void => { root.replaceChildren(node); };

const fail = (error: unknown): void => {
  settled = true;
  replace(renderPresentationFailure(
    error instanceof Error ? error.message : "The presentation result is invalid.",
  ));
};

const drain = async (): Promise<void> => {
  if (!connected || pending === undefined || settled || processing) return;
  processing = true;
  const result = pending;
  pending = undefined;
  try {
    const admitted = await admitPresentationToolResult(app, result, controller.signal);
    if (controller.signal.aborted || settled) return;
    replace(renderPresentation(admitted.entry, admitted.result));
    settled = true;
  } catch (error) {
    if (!controller.signal.aborted && !settled) fail(error);
  }
  finally { processing = false; }
};

app.addEventListener("toolresult", (result) => {
  if (received) {
    fail(new TypeError("The immutable View received more than one creating result."));
    return;
  }
  received = true;
  pending = result;
  void drain();
});

app.onteardown = async () => {
  controller.abort();
  return {};
};

replace(renderPresentationPending());
try {
  await app.connect();
  connected = true;
  await drain();
} catch (error) { fail(error); }
