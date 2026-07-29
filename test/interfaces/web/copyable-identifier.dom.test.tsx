// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyableIdentifier } from "../../../src/interfaces/web/copyable-identifier.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CopyableIdentifier attempt ownership", () => {
  it("ignores an old clipboard completion after the exact value changes", async () => {
    const pending: Array<Readonly<{
      value: string;
      resolve: () => void;
    }>> = [];
    const writeText = vi.fn((value: string) => new Promise<void>((resolve) => {
      pending.push(Object.freeze({ value, resolve }));
    }));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: Object.freeze({ writeText }),
    });

    const rendered = render(
      <CopyableIdentifier label="address" value="first-value" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    expect(writeText).toHaveBeenCalledWith("first-value");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Copy address" }).disabled,
    ).toBe(true);

    rendered.rerender(
      <CopyableIdentifier label="address" value="second-value" />,
    );
    const replacementButton = screen.getByRole("button", { name: "Copy address" });
    expect((replacementButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(replacementButton);
    expect(writeText).toHaveBeenLastCalledWith("second-value");

    pending[0]?.resolve();
    await Promise.resolve();
    expect(screen.queryByText("Copied.")).toBeNull();

    pending[1]?.resolve();
    await waitFor(() => {
      expect(screen.getByText("Copied.")).toBeTruthy();
    });
  });
});
