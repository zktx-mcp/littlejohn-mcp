// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  StockTokenAddDialog,
} from "../../../src/interfaces/web/stock-token-add-dialog.js";
import {
  stockTokenCandidate,
} from "./stock-token-fixtures.js";

beforeAll(() => {
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
  vi.restoreAllMocks();
});

afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

describe("Stock Token candidate action", () => {
  it("adds only through the candidate's explicit plus button", () => {
    const onAdd = vi.fn();
    render(
      <StockTokenAddDialog
        presentation={{
          candidates: [stockTokenCandidate],
          addStatus: { status: "idle" },
          inputsLocked: false,
          dismissible: true,
        }}
        onClose={vi.fn()}
        onAdd={onAdd}
        onRetry={vi.fn()}
      />,
    );

    const candidateName = screen.getByText("Example Stock Token");
    expect(candidateName.closest("button")).toBeNull();

    fireEvent.click(candidateName);
    expect(onAdd).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", {
      name: "Add Example Stock Token",
    }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(stockTokenCandidate);
  });
});
