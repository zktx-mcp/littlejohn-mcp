import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { deliveryUnknownCliExitCode } from "../../src/interfaces/delivery-exit.js";

describe("delivery-unknown CLI exit ownership", () => {
  it("has one neutral declaration shared by every delivery protocol", async () => {
    const root = resolve(import.meta.dirname, "../../src/interfaces");
    const files = (await readdir(root, { recursive: true }))
      .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
    const owners: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(
        file,
        await readFile(resolve(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) && node.name.text === "deliveryUnknownCliExitCode") owners.push(file);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(deliveryUnknownCliExitCode).toBe(8);
    expect(owners).toEqual(["delivery-exit.ts"]);
  });
});
