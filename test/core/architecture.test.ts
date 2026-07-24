import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as publicCore from "../../src/core/index.js";
import {
  collectSourceFiles,
  inspectSource,
  inspectSourceFile,
} from "../runtime/import-audit.js";

const coreDirectory = resolve("src/core");
const sourceDirectory = resolve("src");
const capabilityDefinitionConstructor = "defineReadCapability";
const capabilityDefinitionModules = new Set([
  resolve("src/core/capability.js"),
  resolve("src/core/index.js"),
]);
const capabilityDefinitionOwners = new Set([
  resolve("src/core/capabilities.ts"),
  resolve("src/token-catalog/contracts.ts"),
]);
const capabilityDefinitionReexporter = resolve("src/core/index.ts");
const evidenceReplayModule = resolve("src/core/evidence-replay.js");
const semanticEvidenceAuthoringSymbols = new Set([
  "createEvidenceClaimRoleDeclaration",
  "createEvidenceDeclarationScope",
  "createEvidenceFactIdentityDeclaration",
  "createEvidenceFactIdentityForConclusion",
  "createEvidenceObservationTargetDeclaration",
  "createEvidenceReplayDefinition",
  "createEvmAddressConclusionIdentity",
  "createEvmAddressConclusionIdentityDeclaration",
  "createExactConclusionIdentityDeclaration",
]);
const semanticEvidenceAuthoringModules = new Set([
  evidenceReplayModule,
  resolve("src/core/browser.js"),
]);
const semanticEvidenceAuthoringOwners = new Set([
  resolve("src/core/capability-evidence.ts"),
  resolve("src/token-catalog/contract-schema.ts"),
]);
const semanticEvidenceAuthoringReexporter = resolve("src/core/browser.ts");
const evidenceReplayFacadeModules = new Set([
  evidenceReplayModule,
  resolve("src/core/browser.js"),
]);
const evidenceObservationConsumer = resolve("src/core/capability.ts");
const evidenceReplayConsumers = new Set([
  resolve("src/core/capability.ts"),
  resolve("src/token-catalog/contract-schema.ts"),
]);
const accountBalanceConclusionIdentityOwner =
  resolve("src/core/capability-evidence.ts");
const nobleHashImportsByOwner = new Map([
  [resolve("src/core/canonical-json.ts"), new Set([
    "@noble/hashes/sha2.js",
    "@noble/hashes/utils.js",
  ])],
  [resolve("src/core/keccak256.ts"), new Set([
    "@noble/hashes/sha3.js",
    "@noble/hashes/utils.js",
  ])],
]);

const resolveModule = (importingFile: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  try { return fileURLToPath(new URL(specifier, pathToFileURL(importingFile))); }
  catch { return undefined; }
};

const capabilityDefinitionAuthorityViolations = (
  source: string,
  importingFile: string,
): string[] => {
  const file = resolve(importingFile);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX
      : file.endsWith(".jsx") ? ts.ScriptKind.JSX
        : file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const report = (kind: string): void => {
    violations.push(`${relative(sourceDirectory, file).split(sep).join("/")}:${kind}`);
  };
  const isAuthorityModule = (specifier: ts.Expression | undefined): boolean =>
    specifier !== undefined && ts.isStringLiteralLike(specifier) &&
    capabilityDefinitionModules.has(resolveModule(file, specifier.text) ?? "");

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isAuthorityModule(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        if (!capabilityDefinitionOwners.has(file)) report("namespace_import");
      } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
        const importsConstructor = bindings.elements.some(
          (element) => (element.propertyName ?? element.name).text === capabilityDefinitionConstructor,
        );
        if (importsConstructor && !capabilityDefinitionOwners.has(file)) report("named_import");
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isAuthorityModule(node.moduleReference.expression) &&
      !capabilityDefinitionOwners.has(file)
    ) {
      report("import_equals");
    } else if (ts.isExportDeclaration(node) && isAuthorityModule(node.moduleSpecifier)) {
      const exposesConstructor = node.exportClause === undefined ||
        ts.isNamespaceExport(node.exportClause) ||
        node.exportClause.elements.some(
          (element) => (element.propertyName ?? element.name).text === capabilityDefinitionConstructor,
        );
      if (exposesConstructor && (
        file !== capabilityDefinitionReexporter ||
        node.exportClause === undefined ||
        ts.isNamespaceExport(node.exportClause)
      )) report("reexport");
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      isAuthorityModule(node.arguments[0]) &&
      !capabilityDefinitionOwners.has(file)
    ) {
      report("dynamic_import");
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      isAuthorityModule(node.arguments[0]) &&
      !capabilityDefinitionOwners.has(file)
    ) {
      report("require");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
};

const semanticEvidenceAuthoringViolations = (
  source: string,
  importingFile: string,
): string[] => {
  const file = resolve(importingFile);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX
      : file.endsWith(".jsx") ? ts.ScriptKind.JSX
        : file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const report = (kind: string): void => {
    violations.push(`${relative(sourceDirectory, file).split(sep).join("/")}:${kind}`);
  };
  const isAuthoringModule = (specifier: ts.Expression | undefined): boolean =>
    specifier !== undefined && ts.isStringLiteralLike(specifier) &&
    semanticEvidenceAuthoringModules.has(resolveModule(file, specifier.text) ?? "");
  const includesAuthoringSymbol = (
    elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>,
  ): boolean => elements.some((element) =>
    semanticEvidenceAuthoringSymbols.has((element.propertyName ?? element.name).text));

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isAuthoringModule(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (
        bindings !== undefined &&
        ts.isNamespaceImport(bindings) &&
        !semanticEvidenceAuthoringOwners.has(file)
      ) {
        report("namespace_import");
      } else if (
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        includesAuthoringSymbol(bindings.elements) &&
        !semanticEvidenceAuthoringOwners.has(file)
      ) {
        report("named_import");
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isAuthoringModule(node.moduleReference.expression) &&
      !semanticEvidenceAuthoringOwners.has(file)
    ) {
      report("import_equals");
    } else if (ts.isExportDeclaration(node) && isAuthoringModule(node.moduleSpecifier)) {
      const exposesAuthoring = node.exportClause === undefined ||
        ts.isNamespaceExport(node.exportClause) ||
        includesAuthoringSymbol(node.exportClause.elements);
      if (
        exposesAuthoring &&
        (
          file !== semanticEvidenceAuthoringReexporter ||
          node.exportClause === undefined ||
          ts.isNamespaceExport(node.exportClause)
        )
      ) {
        report("reexport");
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      isAuthoringModule(node.arguments[0]) &&
      !semanticEvidenceAuthoringOwners.has(file)
    ) {
      report("dynamic_import");
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      isAuthoringModule(node.arguments[0]) &&
      !semanticEvidenceAuthoringOwners.has(file)
    ) {
      report("require");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
};

const unwrapEvidenceExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const isLiteralEvidenceIdentity = (expression: ts.Expression): boolean => {
  const value = unwrapEvidenceExpression(expression);
  return ts.isStringLiteralLike(value) || ts.isTemplateExpression(value);
};

const containsRawClaimRole = (node: ts.Node): boolean => {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (
      ts.isPropertyAssignment(candidate) &&
      (
        ts.isIdentifier(candidate.name) ||
        ts.isStringLiteralLike(candidate.name)
      ) &&
      candidate.name.text === "role" &&
      isLiteralEvidenceIdentity(candidate.initializer)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
};

const rawEvidenceRecordingViolations = (
  source: string,
  sourcePath: string,
): string[] => {
  const file = resolve(sourcePath);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX
      : file.endsWith(".jsx") ? ts.ScriptKind.JSX
        : file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const report = (kind: string): void => {
    violations.push(`${relative(sourceDirectory, file).split(sep).join("/")}:${kind}`);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "record" &&
      node.arguments[0] !== undefined &&
      isLiteralEvidenceIdentity(node.arguments[0])
    ) {
      report("raw_record_slot");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "record" &&
      node.arguments[1] !== undefined &&
      containsRawClaimRole(node.arguments[1])
    ) {
      report("raw_claim_role");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
};

const evidenceReplayAuthorityViolations = (
  source: string,
  importingFile: string,
): string[] => {
  const file = resolve(importingFile);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const localBindings = new Map<string, "observation" | "replay">();
  const namespaces = new Set<string>();
  const violations: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const importedModule = resolveModule(file, statement.moduleSpecifier.text);
    if (!evidenceReplayFacadeModules.has(importedModule ?? "")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === "createEvidenceObservationId" && importedModule === evidenceReplayModule) {
        localBindings.set(element.name.text, "observation");
      }
      if (imported === "replayPublicEvidence") localBindings.set(element.name.text, "replay");
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = ts.isIdentifier(node.expression)
        ? localBindings.get(node.expression.text)
        : ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            namespaces.has(node.expression.expression.text)
          ? node.expression.name.text === "createEvidenceObservationId"
            ? "observation"
            : node.expression.name.text === "replayPublicEvidence"
              ? "replay"
              : undefined
          : undefined;
      if (kind === "observation" && file !== evidenceObservationConsumer) {
        violations.push(`${relative(sourceDirectory, file).split(sep).join("/")}:observation_id`);
      }
      if (kind === "replay" && !evidenceReplayConsumers.has(file)) {
        violations.push(`${relative(sourceDirectory, file).split(sep).join("/")}:public_replay`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
};

const tokenBalanceConclusionPrefixOccurrences = (
  source: string,
  sourcePath: string,
): number => {
  const file = resolve(sourcePath);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let occurrences = 0;
  const visit = (node: ts.Node): void => {
    const literalText = ts.isStringLiteralLike(node)
      ? node.text
      : node.kind === ts.SyntaxKind.TemplateHead ||
          node.kind === ts.SyntaxKind.TemplateMiddle ||
          node.kind === ts.SyntaxKind.TemplateTail
        ? (node as ts.TemplateLiteralToken).text
        : undefined;
    if (literalText?.includes("token_balance:") === true) occurrences += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return occurrences;
};

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
  specifier === "zod" ||
  specifier === "node:crypto" ||
  nobleHashImportsByOwner.get(resolve(importingFile))?.has(specifier) === true ||
  resolvesInsideCore(importingFile, specifier);

const auditImports = (source: string, importingFile = resolve("src/core/audit.ts")): string[] => {
  const audit = inspectSource(source, importingFile);
  const violations: string[] = [];
  for (const reference of audit.moduleImports) {
    if (reference.kind === "parse_error") violations.push("parse_error");
    else if (reference.specifier === undefined) violations.push(`${reference.kind}:non_literal`);
    else if (!allowed(importingFile, reference.specifier)) {
      violations.push(`${reference.kind}:${reference.specifier}`);
    }
  }
  const executionLabels = {
    global_eval: "eval",
    global_function: "Function",
    process_loader: "getBuiltinModule",
  } as const;
  for (const reference of audit.directCodeExecutions) {
    violations.push(`loader:${executionLabels[reference.kind as keyof typeof executionLabels] ?? reference.kind}`);
  }
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
      "deriveCoverage",
      "factOutcomeDefinitions",
      "freshnessRuleDefinitions",
      "keccak256FromUtf8",
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
    expect(Object.hasOwn(publicCore, "defineReadCapability")).toBe(true);
  });

  it("limits capability definition authoring to the two canonical contract owners", async () => {
    const violations: string[] = [];
    for (const file of await collectSourceFiles(sourceDirectory)) {
      violations.push(...capabilityDefinitionAuthorityViolations(await readFile(file, "utf8"), file));
    }
    expect(violations).toEqual([]);

    const outsideOwner = resolve("src/chain/unauthorized-capability.ts");
    expect(capabilityDefinitionAuthorityViolations(
      'import { defineReadCapability } from "../core/index.js";',
      outsideOwner,
    )).toEqual(["chain/unauthorized-capability.ts:named_import"]);
    expect(capabilityDefinitionAuthorityViolations(
      'import { defineReadCapability as defineCapability } from "../core/index.js";',
      outsideOwner,
    )).toEqual(["chain/unauthorized-capability.ts:named_import"]);
    expect(capabilityDefinitionAuthorityViolations(
      'import * as core from "../core/index.js"; core.defineReadCapability({});',
      outsideOwner,
    )).toEqual(["chain/unauthorized-capability.ts:namespace_import"]);
    expect(capabilityDefinitionAuthorityViolations(
      'export { defineReadCapability as defineCapability } from "../core/index.js";',
      outsideOwner,
    )).toEqual(["chain/unauthorized-capability.ts:reexport"]);
    expect(capabilityDefinitionAuthorityViolations(
      'void import("../core/index.js");',
      outsideOwner,
    )).toEqual(["chain/unauthorized-capability.ts:dynamic_import"]);
    expect(capabilityDefinitionAuthorityViolations(
      'const core = require("../core/index.js"); core.defineReadCapability({});',
      outsideOwner,
    )).toEqual(["chain/unauthorized-capability.ts:require"]);
    expect(capabilityDefinitionAuthorityViolations(
      'import core = require("../core/index.js"); core.defineReadCapability({});',
      outsideOwner,
    )).toEqual(["chain/unauthorized-capability.ts:import_equals"]);
  });

  it("limits semantic evidence identity authoring to the two definition owners", async () => {
    const violations: string[] = [];
    for (const file of await collectSourceFiles(sourceDirectory)) {
      violations.push(...semanticEvidenceAuthoringViolations(
        await readFile(file, "utf8"),
        file,
      ));
    }
    expect(violations).toEqual([]);

    const outsideOwner = resolve("src/chain/unauthorized-evidence.ts");
    expect(semanticEvidenceAuthoringViolations(
      'import { createEvidenceReplayDefinition } from "../core/evidence-replay.js";',
      outsideOwner,
    )).toEqual(["chain/unauthorized-evidence.ts:named_import"]);
    expect(semanticEvidenceAuthoringViolations(
      'import { createEvidenceReplayDefinition as defineEvidence } from "../core/browser.js";',
      outsideOwner,
    )).toEqual(["chain/unauthorized-evidence.ts:named_import"]);
    expect(semanticEvidenceAuthoringViolations(
      'import * as replay from "../core/evidence-replay.js"; replay.createEvidenceReplayDefinition({});',
      outsideOwner,
    )).toEqual(["chain/unauthorized-evidence.ts:namespace_import"]);
    expect(semanticEvidenceAuthoringViolations(
      'export { createEvidenceReplayDefinition as defineEvidence } from "../core/browser.js";',
      outsideOwner,
    )).toEqual(["chain/unauthorized-evidence.ts:reexport"]);
    expect(semanticEvidenceAuthoringViolations(
      'void import("../core/evidence-replay.js");',
      outsideOwner,
    )).toEqual(["chain/unauthorized-evidence.ts:dynamic_import"]);
    expect(semanticEvidenceAuthoringViolations(
      'const replay = require("../core/evidence-replay.js");',
      outsideOwner,
    )).toEqual(["chain/unauthorized-evidence.ts:require"]);
    expect(semanticEvidenceAuthoringViolations(
      'import replay = require("../core/evidence-replay.js");',
      outsideOwner,
    )).toEqual(["chain/unauthorized-evidence.ts:import_equals"]);
  });

  it("rejects raw semantic slot and role literals at production recording sites", async () => {
    const violations: string[] = [];
    for (const file of await collectSourceFiles(sourceDirectory)) {
      violations.push(...rawEvidenceRecordingViolations(await readFile(file, "utf8"), file));
    }
    expect(violations).toEqual([]);

    const outsideOwner = resolve("src/chain/unauthorized-evidence.ts");
    expect(rawEvidenceRecordingViolations(
      'observations.record("latest_block" as never, { source, claims: [] });',
      outsideOwner,
    )).toEqual(["chain/unauthorized-evidence.ts:raw_record_slot"]);
    expect(rawEvidenceRecordingViolations(
      "observations.record(slot, { source, claims: [{ role: (`block` as never), value: block }] });",
      outsideOwner,
    )).toEqual(["chain/unauthorized-evidence.ts:raw_claim_role"]);
  });

  it("allows only the declared narrow hash utilities, zod, node:crypto, and sibling core modules", async () => {
    const directory = resolve("src/core");
    const violations: string[] = [];
    for (const file of await collectSourceFiles(directory)) {
      violations.push(...auditImports(await readFile(file, "utf8"), file));
    }
    expect(violations).toEqual([]);
  });

  it("keeps each Noble hash primitive behind its exact core owner", async () => {
    const importsByOwner: Record<string, string[]> = {};
    for (const file of await collectSourceFiles(coreDirectory)) {
      const audit = await inspectSourceFile(file);
      const imports = audit.moduleImports
        .flatMap((reference) => reference.specifier?.startsWith("@noble/hashes/")
          ? [reference.specifier]
          : [])
        .sort();
      if (imports.length !== 0) importsByOwner[relative(coreDirectory, file)] = imports;
    }
    expect(importsByOwner).toEqual({
      "canonical-json.ts": ["@noble/hashes/sha2.js", "@noble/hashes/utils.js"],
      "keccak256.ts": ["@noble/hashes/sha3.js", "@noble/hashes/utils.js"],
    });
  });

  it("keeps observation identity and complete replay behind their declared consumers", async () => {
    const violations: string[] = [];
    for (const file of await collectSourceFiles(sourceDirectory)) {
      violations.push(...evidenceReplayAuthorityViolations(await readFile(file, "utf8"), file));
    }
    expect(violations).toEqual([]);
    expect(evidenceReplayAuthorityViolations(
      'import { createEvidenceObservationId as makeId } from "../core/evidence-replay.js"; makeId({});',
      resolve("src/chain/unauthorized-replay.ts"),
    )).toEqual(["chain/unauthorized-replay.ts:observation_id"]);
    expect(evidenceReplayAuthorityViolations(
      'import { replayPublicEvidence as replay } from "../core/evidence-replay.js"; replay({});',
      resolve("src/chain/unauthorized-replay.ts"),
    )).toEqual(["chain/unauthorized-replay.ts:public_replay"]);
    expect(evidenceReplayAuthorityViolations(
      'import * as core from "../core/browser.js"; core.replayPublicEvidence({});',
      resolve("src/chain/unauthorized-replay.ts"),
    )).toEqual(["chain/unauthorized-replay.ts:public_replay"]);
    expect(evidenceReplayAuthorityViolations(
      'import { replayPublicEvidence as replay } from "../core/browser.js"; replay({});',
      resolve("src/chain/unauthorized-replay.ts"),
    )).toEqual(["chain/unauthorized-replay.ts:public_replay"]);
    expect(Object.hasOwn(publicCore, "createEvidenceObservationId")).toBe(false);
    expect(await readFile(resolve("src/core/index.ts"), "utf8")).not.toMatch(/\bObservedFact\b/u);
    expect(await readFile(resolve("src/core/browser.ts"), "utf8")).not.toMatch(/\bObservedFact\b/u);
  });

  it("keeps the dynamic token-balance conclusion prefix at its declaration owner", async () => {
    const violations: string[] = [];
    let ownerOccurrences = 0;
    for (const file of await collectSourceFiles(sourceDirectory)) {
      const occurrences = tokenBalanceConclusionPrefixOccurrences(await readFile(file, "utf8"), file);
      if (file === accountBalanceConclusionIdentityOwner) {
        ownerOccurrences += occurrences;
      } else if (occurrences !== 0) {
        violations.push(relative(sourceDirectory, file).split(sep).join("/"));
      }
    }
    expect(ownerOccurrences).toBe(1);
    expect(violations).toEqual([]);
    expect(tokenBalanceConclusionPrefixOccurrences(
      "const id = `token_balance:${address}`;",
      resolve("src/chain/unauthorized-token-balance.ts"),
    )).toBe(1);
  });

  it("detects literal and computed forbidden imports", () => {
    expect(auditImports('import "node:http";')).toEqual(["module:node:http"]);
    expect(auditImports('import("better-sqlite3");')).toEqual(["dynamic_import:better-sqlite3"]);
    expect(auditImports("const target = 'node:http'; import(target);")).toEqual(["dynamic_import:non_literal"]);
    expect(auditImports('require("react");')).toEqual(["require:react"]);
    expect(auditImports('import "@noble/hashes";')).toEqual(["module:@noble/hashes"]);
    expect(auditImports('import "@noble/hashes/sha2.js";')).toEqual(["module:@noble/hashes/sha2.js"]);
    expect(auditImports(
      'import { sha256 } from "@noble/hashes/sha2.js";',
      resolve("src/core/canonical-json.ts"),
    )).toEqual([]);
    expect(auditImports(
      'import { keccak_256 } from "@noble/hashes/sha3.js";',
      resolve("src/core/canonical-json.ts"),
    )).toEqual(["module:@noble/hashes/sha3.js"]);
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
