import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CopyableIdentifier,
  writeClipboardText,
} from "../../../src/interfaces/web/copyable-identifier.js";

describe("copyable exact identifier", () => {
  it("renders the complete value beside an explicit copy control", () => {
    const value = `0x${"ab".repeat(32)}`;
    const markup = renderToStaticMarkup(createElement(CopyableIdentifier, {
      label: "canonical block hash",
      value,
    }));

    expect(markup).toContain(
      `<code class="copyable-identifier-value" title="${value}">${value}</code>`,
    );
    expect(markup).toContain('aria-label="Copy canonical block hash"');
    expect(markup).toContain('title="Copy canonical block hash"');
    expect(markup).toContain('class="copy-identifier secondary icon-button"');
    expect(markup).toContain('class="lucide lucide-copy"');
    expect(markup).not.toContain(">Copy</button>");
    expect(markup).not.toContain("…");
    expect(markup).not.toContain("...");
  });

  it("passes the exact value once to the supplied clipboard boundary", async () => {
    const value = "eip155:4663:0x1234567890abcdef";
    const writer = vi.fn(async () => undefined);

    await writeClipboardText(value, writer);

    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith(value);
  });

  it("does not report a failed write as successful", async () => {
    const failure = new Error("clipboard unavailable");
    const writer = vi.fn(async () => { throw failure; });

    await expect(writeClipboardText("exact-value", writer)).rejects.toBe(failure);
  });
});
