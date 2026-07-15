import {
  parseWalletQrMatrix,
  type WalletQrMatrix,
} from "./contracts.js";

const quietZoneModules = 4;
const colorStart = "\u001b[47m\u001b[30m";
const colorEnd = "\u001b[0m";
const alternateScreenEnter = "\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H";
const alternateScreenRefresh = "\u001b[2J\u001b[H";
const alternateScreenExit = "\u001b[0m\u001b[?25h\u001b[?1049l";

export interface TerminalQrSize {
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalQrRendering {
  readonly lines: readonly string[];
  readonly raster: TerminalQrSize;
  readonly minimum: TerminalQrSize;
}

export interface TerminalQrDisplay {
  show(rendering: TerminalQrRendering): void;
  hide(): void;
}

const moduleAt = (matrix: WalletQrMatrix, x: number, y: number): boolean =>
  x >= 0 &&
  x < matrix.size &&
  y >= 0 &&
  y < matrix.size &&
  matrix.rows[y]?.[x] === "1";

const halfBlock = (top: boolean, bottom: boolean): string => {
  if (top) return bottom ? "█" : "▀";
  return bottom ? "▄" : " ";
};

/**
 * Renders a complete QR matrix with a four-module quiet zone. One terminal
 * cell represents one horizontal by two vertical QR modules.
 */
export const renderTerminalQr = (matrix: WalletQrMatrix): TerminalQrRendering => {
  const parsedMatrix = parseWalletQrMatrix(matrix);
  const paddedSize = parsedMatrix.size + (quietZoneModules * 2);
  const raster = Object.freeze({
    columns: paddedSize,
    rows: Math.ceil(paddedSize / 2),
  });
  const minimum = Object.freeze({
    columns: raster.columns + 1,
    rows: raster.rows,
  });
  const lines: string[] = [];

  for (let outputRow = 0; outputRow < raster.rows; outputRow += 1) {
    const topY = (outputRow * 2) - quietZoneModules;
    let modules = "";
    for (let outputColumn = 0; outputColumn < raster.columns; outputColumn += 1) {
      const x = outputColumn - quietZoneModules;
      modules += halfBlock(
        moduleAt(parsedMatrix, x, topY),
        moduleAt(parsedMatrix, x, topY + 1),
      );
    }
    lines.push(`${colorStart}${modules}${colorEnd}`);
  }

  Object.freeze(lines);
  return Object.freeze({ lines, raster, minimum });
};

export const createTerminalQrDisplay = (
  write: (value: string) => void,
): TerminalQrDisplay => {
  if (typeof write !== "function") throw new TypeError("Terminal QR output must be a function.");
  let visible = false;
  return Object.freeze({
    show(rendering: TerminalQrRendering): void {
      const prefix = visible ? alternateScreenRefresh : alternateScreenEnter;
      visible = true;
      write(`${prefix}${rendering.lines.join("\r\n")}`);
    },
    hide(): void {
      if (!visible) return;
      write(alternateScreenExit);
      visible = false;
    },
  });
};
