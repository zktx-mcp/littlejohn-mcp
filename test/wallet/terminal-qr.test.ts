import { describe, expect, it } from "vitest";

import type { WalletQrMatrix } from "../../src/wallet/contracts.js";
import * as terminalQr from "../../src/wallet/terminal-qr.js";

const colorStart = "\u001b[47m\u001b[30m";
const colorEnd = "\u001b[0m";

const matrix = (rows: readonly string[]): WalletQrMatrix => ({
  size: rows.length,
  rows: [...rows],
});

const filledMatrix = (size: number, module: "0" | "1"): WalletQrMatrix =>
  matrix(Array.from({ length: size }, () => module.repeat(size)));

const visibleCells = (line: string): string => {
  expect(line.startsWith(colorStart)).toBe(true);
  expect(line.endsWith(colorEnd)).toBe(true);
  return line.slice(colorStart.length, -colorEnd.length);
};

const cellModules = (cell: string): readonly [boolean, boolean] => {
  switch (cell) {
    case " ": return [false, false];
    case "▀": return [true, false];
    case "▄": return [false, true];
    case "█": return [true, true];
    default: throw new TypeError("Unexpected terminal QR cell.");
  }
};

const assertNoPairingUriInput = (): void => {
  // @ts-expect-error Pairing URIs are not terminal renderer inputs.
  terminalQr.renderTerminalQr("wc:pairing-secret");
};
void assertNoPairingUriInput;

describe("terminal QR rendering", () => {
  it.each([
    [21, 29, 30, 15],
    [49, 57, 58, 29],
    [177, 185, 186, 93],
  ])("derives the complete four-module quiet-zone size for a %i-module matrix", (
    size,
    rasterColumns,
    minimumColumns,
    rows,
  ) => {
    const rendering = terminalQr.renderTerminalQr(filledMatrix(size, "0"));

    expect(rendering.raster).toEqual({ columns: rasterColumns, rows });
    expect(rendering.minimum).toEqual({ columns: minimumColumns, rows });
    expect(rendering.lines).toHaveLength(rows);
    expect(rendering.lines.every((line) => visibleCells(line).length === rasterColumns)).toBe(true);
    expect(Object.isFrozen(rendering)).toBe(true);
    expect(Object.isFrozen(rendering.raster)).toBe(true);
    expect(Object.isFrozen(rendering.minimum)).toBe(true);
    expect(Object.isFrozen(rendering.lines)).toBe(true);
  });

  it("preserves every source module and every quiet-zone module through half-block output", () => {
    const sourceRows = Array.from({ length: 21 }, (_unused, y) =>
      Array.from({ length: 21 }, (_other, x) => ((x * 3) + (y * 5)) % 7 < 3 ? "1" : "0").join(""));
    const rendering = terminalQr.renderTerminalQr(matrix(sourceRows));
    const decoded = rendering.lines.flatMap((line) => {
      const cells = [...visibleCells(line)].map(cellModules);
      return [
        cells.map(([top]) => top),
        cells.map(([_top, bottom]) => bottom),
      ];
    });

    for (let y = 0; y < 29; y += 1) {
      for (let x = 0; x < 29; x += 1) {
        const sourceX = x - 4;
        const sourceY = y - 4;
        const expected = sourceX >= 0 && sourceX < 21 && sourceY >= 0 && sourceY < 21
          ? sourceRows[sourceY]?.[sourceX] === "1"
          : false;
        expect(decoded[y]?.[x], `module ${x},${y}`).toBe(expected);
      }
    }
    expect(decoded[29]?.every((module) => module === false)).toBe(true);
    expect(new Set(rendering.lines.flatMap((line) => [...visibleCells(line)]))).toEqual(
      new Set([" ", "▀", "▄", "█"]),
    );
  });

  it("requests a black foreground on a white background without claiming terminal-theme control", () => {
    const rendering = terminalQr.renderTerminalQr(filledMatrix(21, "1"));

    expect(rendering.lines.every((line) => line.startsWith(colorStart))).toBe(true);
    expect(rendering.lines.every((line) => line.endsWith(colorEnd))).toBe(true);
    expect(visibleCells(rendering.lines[0] as string)).toBe(" ".repeat(29));
  });

  it("owns alternate-screen and cursor state without relying on rendered row counts", () => {
    const output: string[] = [];
    const rendering = terminalQr.renderTerminalQr(filledMatrix(21, "1"));
    const display = terminalQr.createTerminalQrDisplay((value) => output.push(value));

    display.show(rendering);
    display.show(rendering);
    display.hide();
    display.hide();

    expect(output).toHaveLength(3);
    expect(output[0]).toMatch(/^\u001b\[\?1049h\u001b\[\?25l\u001b\[2J\u001b\[H/);
    expect(output[0]?.split("\r\n")).toHaveLength(rendering.lines.length);
    expect(output[1]).toMatch(/^\u001b\[2J\u001b\[H/);
    expect(output[1]).not.toContain("\u001b[?1049h");
    expect(output[2]).toBe("\u001b[0m\u001b[?25h\u001b[?1049l");
    expect(output.join("")).not.toContain("\u001b[1A");
    expect(output.join("")).not.toContain("\u001b[2K");
    expect(Object.isFrozen(display)).toBe(true);
  });

  it("retains restoration authority when the first terminal write fails", () => {
    const output: string[] = [];
    let first = true;
    const display = terminalQr.createTerminalQrDisplay((value) => {
      if (first) {
        first = false;
        throw new Error("terminal write failed");
      }
      output.push(value);
    });

    expect(() => display.show(terminalQr.renderTerminalQr(filledMatrix(21, "1")))).toThrow(
      "terminal write failed",
    );
    display.hide();
    expect(output).toEqual(["\u001b[0m\u001b[?25h\u001b[?1049l"]);
    expect(() => terminalQr.createTerminalQrDisplay(undefined as never)).toThrow();
  });

  it("retains restoration authority after refresh and restoration writes fail", () => {
    const rendering = terminalQr.renderTerminalQr(filledMatrix(21, "1"));

    const refreshOutput: string[] = [];
    let refreshWrites = 0;
    const refreshDisplay = terminalQr.createTerminalQrDisplay((value) => {
      refreshWrites += 1;
      if (refreshWrites === 2) throw new Error("refresh failed");
      refreshOutput.push(value);
    });
    refreshDisplay.show(rendering);
    expect(() => refreshDisplay.show(rendering)).toThrow("refresh failed");
    refreshDisplay.hide();
    expect(refreshOutput.at(-1)).toBe("\u001b[0m\u001b[?25h\u001b[?1049l");

    const restorationOutput: string[] = [];
    let restorationWrites = 0;
    const restorationDisplay = terminalQr.createTerminalQrDisplay((value) => {
      restorationWrites += 1;
      if (restorationWrites === 2) throw new Error("restoration failed");
      restorationOutput.push(value);
    });
    restorationDisplay.show(rendering);
    expect(() => restorationDisplay.hide()).toThrow("restoration failed");
    restorationDisplay.hide();
    restorationDisplay.hide();
    expect(restorationOutput).toHaveLength(2);
    expect(restorationOutput.at(-1)).toBe("\u001b[0m\u001b[?25h\u001b[?1049l");
  });

  it("parses the matrix before rendering and keeps pairing URIs outside its API", () => {
    const malformed = {
      size: 21,
      rows: Array.from({ length: 21 }, () => "0".repeat(20)),
    } as WalletQrMatrix;

    expect(() => terminalQr.renderTerminalQr(malformed)).toThrow();
    expect(Object.keys(terminalQr).sort()).toEqual(["createTerminalQrDisplay", "renderTerminalQr"]);
    expect(terminalQr.renderTerminalQr.length).toBe(1);
  });
});
