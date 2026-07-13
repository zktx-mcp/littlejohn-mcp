import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as publicCore from "../../src/core/index.js";

const coreDirectory = resolve("src/core");

const resolvesInsideCore = (importingFile: string, specifier: string): boolean => {
  if (!specifier.startsWith("./")) return false;
  let target: string;
  try {
    target = fileURLToPath(new URL(specifier, pathToFileURL(importingFile)));
  } catch {
    return false;
  }
  const fromCore = relative(coreDirectory, target);
  return fromCore === "" || (!isAbsolute(fromCore) && fromCore !== ".." && !fromCore.startsWith(`..${sep}`));
};

const allowed = (importingFile: string, specifier: string): boolean =>
  specifier === "zod" || specifier === "node:crypto" || resolvesInsideCore(importingFile, specifier);

const auditImports = (source: string, importingFile = resolve("src/core/audit.ts")): string[] => {
  const sourceFile = ts.createSourceFile("audit.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const checkSpecifier = (node: ts.Expression | undefined, kind: string): void => {
    if (node === undefined || !ts.isStringLiteralLike(node)) {
      violations.push(`${kind}:non_literal`);
      return;
    }
    if (!allowed(importingFile, node.text)) violations.push(`${kind}:${node.text}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) checkSpecifier(node.moduleSpecifier, "module");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) checkSpecifier(node.arguments[0], "dynamic_import");
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") checkSpecifier(node.arguments[0], "require");
      if (ts.isIdentifier(node.expression) && (node.expression.text === "eval" || node.expression.text === "Function")) {
        violations.push(`loader:${node.expression.text}`);
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "getBuiltinModule") {
        violations.push("loader:getBuiltinModule");
      }
      if (ts.isElementAccessExpression(node.expression) && ts.isStringLiteralLike(node.expression.argumentExpression) &&
        node.expression.argumentExpression.text === "getBuiltinModule") {
        violations.push("loader:getBuiltinModule");
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      violations.push("loader:Function");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
};

const collectTypeScriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
};

const importsTrustedConstructor = (source: string): boolean => {
  const sourceFile = ts.createSourceFile("audit.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let violation = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text.endsWith("/capability.js")) {
      const bindings = node.importClause?.namedBindings;
      if (bindings === undefined || ts.isNamespaceImport(bindings) ||
        bindings.elements.some((element) => (element.propertyName ?? element.name).text === "defineReadCapability")) {
        violation = true;
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith("/capability.js")) {
      if (node.exportClause === undefined || (ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.some((element) => (element.propertyName ?? element.name).text === "defineReadCapability"))) {
        violation = true;
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier === undefined || !ts.isStringLiteralLike(specifier) || specifier.text.endsWith("/capability.js")) {
        violation = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violation;
};

const coreConsumerImportViolations = (source: string, importingFile: string): readonly string[] => {
  const sourceFile = ts.createSourceFile(importingFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const check = (specifier: ts.Expression | undefined): void => {
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return;
    let target: string;
    try {
      target = fileURLToPath(new URL(specifier.text, pathToFileURL(importingFile)));
    } catch {
      return;
    }
    const fromCore = relative(coreDirectory, target);
    const insideCore = fromCore === "" || (!isAbsolute(fromCore) && fromCore !== ".." && !fromCore.startsWith(`..${sep}`));
    if (insideCore && fromCore.split(sep).join("/") !== "index.js") violations.push(specifier.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node.moduleSpecifier);
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) check(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") check(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
};

describe("core dependency boundary", () => {
  it("exposes only explicit public core symbols", async () => {
    const indexSource = await readFile(resolve("src/core/index.ts"), "utf8");
    const sourceFile = ts.createSourceFile("index.ts", indexSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const wildcardExports: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isExportDeclaration(node) && node.exportClause === undefined) {
        wildcardExports.push(node.moduleSpecifier?.getText(sourceFile) ?? "local");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(wildcardExports).toEqual([]);
    for (const internalName of [
      "assertApplicationErrorRegistry",
      "createAmountSchemaSet",
      "createEvidenceSchemaSet",
      "createFieldIssue",
      "createPrimitiveSchemaSet",
      "createWarning",
      "createCapabilityInvocationId",
      "createHandlerInvocationContext",
      "defineReadCapability",
      "deriveCoverage",
      "factOutcomeDefinitions",
      "freshnessRuleDefinitions",
      "parseInvocationId",
      "readObservationAuthority",
      "sourceClassDefinitions",
    ]) expect(Object.hasOwn(publicCore, internalName)).toBe(false);
    for (const compositionName of [
      "coreContractVersion",
      "createCanonicalClock",
      "createCapabilityInvocationAuthority",
      "createObservationAuthority",
      "ObservationAuthorityRegistry",
    ]) expect(Object.hasOwn(publicCore, compositionName)).toBe(true);
  });

  it("requires build consumers to use the curated core entry point", async () => {
    const violations: string[] = [];
    for (const file of await collectTypeScriptFiles(resolve("src/build"))) {
      violations.push(...coreConsumerImportViolations(await readFile(file, "utf8"), file));
    }
    expect(violations).toEqual([]);
    const synthetic = resolve("src/build/synthetic.ts");
    expect(coreConsumerImportViolations('import "../core/index.js";', synthetic)).toEqual([]);
    expect(coreConsumerImportViolations('import "../core/capability.js";', synthetic))
      .toEqual(["../core/capability.js"]);
  });

  it("reserves the trusted capability-definition constructor for the five built-in definitions", async () => {
    const allowedOwner = resolve("src/core/capabilities.ts");
    const violations: string[] = [];
    for (const file of await collectTypeScriptFiles(resolve("src"))) {
      if (file !== allowedOwner && importsTrustedConstructor(await readFile(file, "utf8"))) violations.push(file);
    }
    expect(violations).toEqual([]);
    expect(importsTrustedConstructor(await readFile(allowedOwner, "utf8"))).toBe(true);
  });

  it("allows only zod, node:crypto, and sibling core modules", async () => {
    const directory = resolve("src/core");
    const violations: string[] = [];
    for (const file of await collectTypeScriptFiles(directory)) {
      violations.push(...auditImports(await readFile(file, "utf8"), file));
    }
    expect(violations).toEqual([]);
  });

  it("detects literal and computed forbidden imports", () => {
    expect(auditImports('import "node:http";')).toEqual(["module:node:http"]);
    expect(auditImports('import("better-sqlite3");')).toEqual(["dynamic_import:better-sqlite3"]);
    expect(auditImports("const target = 'node:http'; import(target);")).toEqual(["dynamic_import:non_literal"]);
    expect(auditImports('require("react");')).toEqual(["require:react"]);
    expect(auditImports('import "../runtime/database.js";')).toEqual(["module:../runtime/database.js"]);
    expect(auditImports('import "./../runtime/database.js";')).toEqual(["module:./../runtime/database.js"]);
    expect(auditImports('import "./sub/../../runtime/database.js";')).toEqual(["module:./sub/../../runtime/database.js"]);
    expect(auditImports('import "./%2e%2e/runtime/database.js";')).toEqual(["module:./%2e%2e/runtime/database.js"]);
    expect(auditImports('import "./..\\\\runtime/database.js";')).toEqual(["module:./..\\runtime/database.js"]);
    expect(auditImports('process.getBuiltinModule("node:http");')).toEqual(["loader:getBuiltinModule"]);
    expect(auditImports('process["getBuiltinModule"]("node:http");')).toEqual(["loader:getBuiltinModule"]);
    expect(auditImports('eval("require(\\"node:http\\")");')).toEqual(["loader:eval"]);
    expect(auditImports('new Function("return process")')).toEqual(["loader:Function"]);
  });
});
