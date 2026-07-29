import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StockTokenAddDialog } from "../../../src/interfaces/web/stock-token-add-dialog.js";
import { StockTokenInformationDialog } from "../../../src/interfaces/web/stock-token-information-dialog.js";
import { StockTokenRemoveDialog } from "../../../src/interfaces/web/stock-token-remove-dialog.js";
import {
  stockTokenCandidate as candidate,
  stockTokenExactResult as exactResult,
  stockTokenSelection as selection,
} from "./stock-token-fixtures.js";
import { createTokenOperation } from "../../token-catalog/harness.js";
const callbacks = Object.freeze({
  onClose: vi.fn(),
  onAdd: vi.fn(),
  onRetry: vi.fn(),
});

describe("Stock Token dialogs", () => {
  it("presents one searchable official-token picker without exposing raw addresses", () => {
    const markup = renderToStaticMarkup(createElement(StockTokenAddDialog, {
      presentation: {
        candidates: [candidate],
        addStatus: { status: "idle" },
        inputsLocked: false,
        dismissible: true,
      },
      ...callbacks,
    }));

    expect(markup.match(/<dialog\b/gu)).toHaveLength(1);
    expect(markup).toContain(">Add Stock Token<");
    expect(markup).toContain(">Search<");
    expect(markup).not.toContain(">Stock Tokens<");
    expect(markup).toContain(">Example Stock Token<");
    expect(markup).toContain(">EXT<");
    expect(markup).toContain('aria-label="Add Example Stock Token"');
    expect(markup).toContain("lucide-plus");
    expect(markup).not.toContain(">Add<");
    expect(markup).not.toContain("candidate-action");
    expect(markup).not.toContain(">Continue<");
    expect(markup).not.toContain(">Review<");
    expect(markup).not.toContain(candidate.contractAddress);
    expect(markup).not.toContain("Remove");
  });

  it("locks the information dialog while an exact token read is in progress", () => {
    const markup = renderToStaticMarkup(createElement(StockTokenInformationDialog, {
      presentation: { status: "loading", selection },
      onClose: vi.fn(),
      onRemove: vi.fn(),
      onRetry: vi.fn(),
      recoverSession: () => false,
    }));

    expect(markup.match(/<dialog\b/gu)).toHaveLength(1);
    expect(markup).toContain("Loading token details");
    expect(markup).toContain(">Token information<");
    expect(markup).not.toContain('aria-label="Close Token information"');
    expect(markup).not.toContain("Remove Stock Token");
  });

  it("leads token information with exact facts and the exact target", () => {
    const markup = renderToStaticMarkup(createElement(StockTokenInformationDialog, {
      presentation: { status: "available", result: exactResult },
      onClose: vi.fn(),
      onRemove: vi.fn(),
      onRetry: vi.fn(),
      recoverSession: () => false,
    }));

    expect(markup).toContain(">Token facts<");
    expect(markup).toContain(">Example Stock Token<");
    expect(markup).toContain(">EXT<");
    expect(markup).toContain(">Originating token target<");
    expect(markup).toContain(candidate.contractAddress);
    expect(markup).toContain(">Control summary<");
    expect(markup.indexOf("Token facts")).toBeLessThan(
      markup.indexOf("Originating token target"),
    );
    expect(markup.indexOf("Originating token target")).toBeLessThan(
      markup.indexOf("Control summary"),
    );
    expect(markup).toContain("Reading control summary");
    expect(markup).not.toContain("Scam status");
    expect(markup).not.toContain("What this analysis cannot establish");
    expect(markup).not.toContain("Requested block");
    expect(markup).toContain(">Close<");
    expect(markup).toContain(">Remove<");
    expect(markup).not.toContain("Remove from Assets");
  });

  it("keeps removal in a dedicated token-bound dialog", () => {
    const markup = renderToStaticMarkup(createElement(StockTokenRemoveDialog, {
      presentation: {
        status: "preparing",
        subject: { selection, name: "Tesla" },
      },
      onClose: vi.fn(),
      onConfirm: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(markup.match(/<dialog\b/gu)).toHaveLength(1);
    expect(markup).toContain(">Remove Tesla<");
    expect(markup).toContain("Preparing removal of Tesla");
    expect(markup).not.toContain("Token standards");
    expect(markup).not.toContain("Analyze token");
    expect(markup).not.toContain("Add Stock Token");
  });

  it("uses concise actions for a ready removal decision", async () => {
    const operation = await createTokenOperation({
      kind: "remove",
      state: "awaiting_confirmation",
    });
    if (operation.kind !== "remove") {
      throw new TypeError("Expected a removal operation.");
    }
    const markup = renderToStaticMarkup(createElement(StockTokenRemoveDialog, {
      presentation: {
        status: "ready",
        subject: { selection, name: "Example Stock Token" },
        operation,
      },
      onClose: vi.fn(),
      onConfirm: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(markup).toContain(">Cancel<");
    expect(markup).toContain(">Remove<");
    expect(markup).not.toMatch(/<button[^>]*>Keep Example Stock Token<\/button>/u);
    expect(markup).not.toMatch(/<button[^>]*>Remove Example Stock Token<\/button>/u);
  });
});
