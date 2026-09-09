import { describe, expect, it } from "vitest";

import type { WalletQrMatrix } from "../../src/wallet/contracts.js";
import * as terminalQr from "../../src/wallet/terminal-qr.js";

const colorEnd = "\u001b[0m";

const matrix = (rows: readonly string[]): WalletQrMatrix => ({
  size: rows.length,
  rows: [...rows],
});

const filledMatrix = (size: number, module: "0" | "1"): WalletQrMatrix =>
  matrix(Array.from({ length: size }, () => module.repeat(size)));

type Color = "black" | "white";

// Interpret terminal SGR and glyph coverage, independently of the QR encoder.
// These pairs name the top and bottom halves of a terminal character cell.
const glyphCoverage: Readonly<Record<string, readonly [boolean, boolean]>> = {
  " ": [false, false], "▀": [true, false], "▄": [false, true], "█": [true, true],
};
const paintedCells = (line: string): readonly (readonly [Color, Color])[] => {
  expect(line.startsWith("\u001b[0m")).toBe(true);
  expect(line.endsWith(colorEnd)).toBe(true);
  let background: Color | undefined;
  let foreground: Color | undefined;
  const cells: (readonly [Color, Color])[] = [];
  for (const token of line.match(/\u001b\[[0-9;]*m|./gu) ?? []) {
    if (token === "\u001b[0m") { background = undefined; foreground = undefined; }
    else if (token === "\u001b[48;2;0;0;0m") background = "black";
    else if (token === "\u001b[48;2;255;255;255m") background = "white";
    else if (token === "\u001b[38;2;0;0;0m") foreground = "black";
    else if (token === "\u001b[38;2;255;255;255m") foreground = "white";
    else {
      const coverage = glyphCoverage[token];
      if (coverage === undefined || background === undefined || foreground === undefined) {
        throw new Error("Cell has unknown coverage or lacks explicit RGB colors.");
      }
      cells.push([coverage[0] ? foreground : background, coverage[1] ? foreground : background]);
    }
  }
  expect(background).toBeUndefined();
  expect(foreground).toBeUndefined();
  return cells;
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
    expect(rendering.lines.every((line) => paintedCells(line).length === rasterColumns)).toBe(true);
    expect(Object.isFrozen(rendering)).toBe(true);
    expect(Object.isFrozen(rendering.raster)).toBe(true);
    expect(Object.isFrozen(rendering.minimum)).toBe(true);
    expect(Object.isFrozen(rendering.lines)).toBe(true);
  });

  it("preserves every source module and the complete quiet zone in compact RGB cells", () => {
    const sourceRows = Array.from({ length: 21 }, (_unused, y) =>
      Array.from({ length: 21 }, (_other, x) => ((x * 3) + (y * 5)) % 7 < 3 ? "1" : "0").join(""));
    const rendering = terminalQr.renderTerminalQr(matrix(sourceRows));
    const decoded = rendering.lines.map(paintedCells).flatMap((row) => [
      row.map(([top]) => top), row.map(([, bottom]) => bottom),
    ]);
    expect(decoded).toHaveLength(30);
    for (let y = 0; y < 30; y += 1) {
      expect(decoded[y]).toHaveLength(29);
      for (let x = 0; x < 29; x += 1) {
        const sourceX = x - 4;
        const sourceY = y - 4;
        const expected = sourceX >= 0 && sourceX < 21 && sourceY >= 0 && sourceY < 21 &&
          sourceRows[sourceY]?.[sourceX] === "1" ? "black" : "white";
        expect(decoded[y]?.[x], `module ${x},${y}`).toBe(expected);
      }
    }
  });

  it("paints solid regions with backgrounds and resets inherited rendition on every row", () => {
    const rendering = terminalQr.renderTerminalQr(filledMatrix(21, "1"));
    expect(paintedCells(rendering.lines[0]!)).toEqual(Array(29).fill(["white", "white"]));
    expect(paintedCells(rendering.lines[2]!)).toEqual([
      ...Array(4).fill(["white", "white"]), ...Array(21).fill(["black", "black"]), ...Array(4).fill(["white", "white"]),
    ]);
    expect(rendering.lines[2]!.replace(/\u001b\[[0-9;]*m/gu, "")).toBe(" ".repeat(29));
    expect(rendering.lines.join("")).not.toMatch(/[█▄]/u);
    for (const line of rendering.lines) paintedCells(line);
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
    expect(output[0]).toMatch(/^\u001b\[0m\u001b\[\?1049h\u001b\[\?25l\u001b\[2J\u001b\[H/);
    expect(output[0]?.split("\r\n")).toHaveLength(rendering.lines.length);
    expect(output[1]).toMatch(/^\u001b\[0m\u001b\[2J\u001b\[H/);
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
