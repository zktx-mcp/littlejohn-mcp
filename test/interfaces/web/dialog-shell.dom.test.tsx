// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DialogShell } from "../../../src/interfaces/web/dialog-shell.js";

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function showModal(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function close(this: HTMLDialogElement): void {
      this.removeAttribute("open");
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("dialog shell lifecycle", () => {
  it("opens modally and leaves task-sequence focus restoration to the application", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const restoreFocus = vi.spyOn(trigger, "focus");
    const onClose = vi.fn();
    const rendered = render(
      <DialogShell
        titleId="review-title"
        title="Review"
        dismissible
        onClose={onClose}
      >
        <button type="button">Inside</button>
      </DialogShell>,
    );
    const dialog = screen.getByRole("dialog");

    expect(dialog.hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(dialog);

    fireEvent.mouseDown(screen.getByRole("button", { name: "Inside" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);

    const cancel = new Event("cancel", { bubbles: true, cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(2);

    rendered.unmount();
    act(() => {
      vi.runAllTimers();
    });
    expect(restoreFocus).not.toHaveBeenCalled();
  });

  it("rejects backdrop and cancel dismissal while the owned action is pending", () => {
    const onClose = vi.fn();
    render(
      <DialogShell
        titleId="pending-title"
        title="Pending"
        dismissible={false}
        onClose={onClose}
      >
        <p>Waiting</p>
      </DialogShell>,
    );
    const dialog = screen.getByRole("dialog");

    fireEvent.mouseDown(dialog);
    const cancel = new Event("cancel", { bubbles: true, cancelable: true });
    dialog.dispatchEvent(cancel);

    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close Pending" })).toBeNull();
  });
});
