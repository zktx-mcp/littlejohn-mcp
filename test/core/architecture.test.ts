import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as publicCore from "../../src/core/index.js";
import {
  collectProductCodeSourceFiles,
  collectSourceFiles,
  createProductSourceProgram,
  inspectSource,
  inspectSourceFile,
  programModuleExportSymbol as moduleExportSymbol,
  protectedModuleAccessViolations,
  resolveProgramSymbol as resolvedSymbol,
} from "../runtime/import-audit.js";

const coreDirectory = resolve("src/core");
const sourceDirectory = resolve("src");
interface ReadCapabilityConstructionRule {
  readonly capabilityName: string;
  readonly ownerFile: string;
}

const readCapabilityConstructionRules = Object.freeze([
  { ownerFile: resolve("src/core/capabilities.ts"), capabilityName: "accountBalanceCapability" },
  { ownerFile: resolve("src/core/capabilities.ts"), capabilityName: "chainStatusCapability" },
  { ownerFile: resolve("src/core/capabilities.ts"), capabilityName: "addressInspectCapability" },
  { ownerFile: resolve("src/core/capabilities.ts"), capabilityName: "transactionInspectCapability" },
  { ownerFile: resolve("src/core/capabilities.ts"), capabilityName: "walletConnectionCapability" },
  { ownerFile: resolve("src/token-catalog/contract-schema.ts"), capabilityName: "tokenInspectCapability" },
  {
    ownerFile: resolve("src/protocols/uniswap-v2/contracts.ts"),
    capabilityName: "uniswapV2QuoteCapability",
  },
  {
    ownerFile: resolve("src/stock-token-trade-history/contracts.ts"),
    capabilityName: "stockTokenTradeHistoryCapability",
  },
] satisfies readonly ReadCapabilityConstructionRule[]);
interface ApplicationErrorRegistryConstructionRule {
  readonly definitionsFile: string;
  readonly definitionsName: string;
  readonly ownerFile: string;
  readonly parentFile: string;
  readonly parentName: string;
  readonly registryName: string;
}

const applicationErrorRegistryConstructionRules = Object.freeze([
  {
    ownerFile: resolve("src/runtime/error-registry.ts"),
    registryName: "runtimeErrorRegistry",
    parentFile: resolve("src/core/errors.ts"),
    parentName: "coreErrorRegistry",
    definitionsFile: resolve("src/runtime/error-definitions.ts"),
    definitionsName: "runtimeErrorDefinitions",
  },
  {
    ownerFile: resolve("src/wallet/error-registry.ts"),
    registryName: "walletErrorRegistry",
    parentFile: resolve("src/runtime/error-registry.ts"),
    parentName: "runtimeErrorRegistry",
    definitionsFile: resolve("src/wallet/error-definitions.ts"),
    definitionsName: "walletErrorDefinitions",
  },
  {
    ownerFile: resolve("src/chain/error-registry.ts"),
    registryName: "chainErrorRegistry",
    parentFile: resolve("src/wallet/error-registry.ts"),
    parentName: "walletErrorRegistry",
    definitionsFile: resolve("src/chain/error-definitions.ts"),
    definitionsName: "chainErrorDefinitions",
  },
  {
    ownerFile: resolve("src/registry/error-registry.ts"),
    registryName: "officialAssetErrorRegistry",
    parentFile: resolve("src/chain/error-registry.ts"),
    parentName: "chainErrorRegistry",
    definitionsFile: resolve("src/registry/error-definitions.ts"),
    definitionsName: "officialAssetErrorDefinitions",
  },
  {
    ownerFile: resolve("src/token-catalog/error-registry.ts"),
    registryName: "tokenCatalogErrorRegistry",
    parentFile: resolve("src/registry/error-registry.ts"),
    parentName: "officialAssetErrorRegistry",
    definitionsFile: resolve("src/token-catalog/error-definitions.ts"),
    definitionsName: "tokenCatalogErrorDefinitions",
  },
  {
    ownerFile: resolve("src/protocols/uniswap-v2/errors.ts"),
    registryName: "uniswapV2ErrorRegistry",
    parentFile: resolve("src/chain/error-registry.ts"),
    parentName: "chainErrorRegistry",
    definitionsFile: resolve("src/protocols/uniswap-v2/errors.ts"),
    definitionsName: "uniswapV2ErrorDefinitions",
  },
] satisfies readonly ApplicationErrorRegistryConstructionRule[]);
const pureRegistryParentImportFiles = new Map([
  [resolve("src/runtime/error-registry.ts"), resolve("src/core/client.ts")],
  [resolve("src/wallet/error-registry.ts"), resolve("src/runtime/error-registry.ts")],
  [resolve("src/chain/error-registry.ts"), resolve("src/wallet/error-registry.ts")],
  [resolve("src/registry/error-registry.ts"), resolve("src/chain/error-registry.ts")],
  [resolve("src/token-catalog/error-registry.ts"), resolve("src/registry/error-registry.ts")],
]);
const evidenceReplayModule = resolve("src/core/evidence-replay.js");
const semanticEvidenceAuthoringSymbols = new Set([
  "createEvidenceClaimRoleDeclaration",
  "createEvidenceConclusionSetDeclaration",
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
  resolve("src/core/client.js"),
]);
const semanticEvidenceAuthoringOwners = new Set([
  resolve("src/core/capability-evidence.ts"),
  resolve("src/token-catalog/contract-schema.ts"),
  resolve("src/protocols/uniswap-v2/evidence.ts"),
  resolve("src/stock-token-trade-history/capability-evidence.ts"),
]);
const semanticEvidenceAuthoringReexporter = resolve("src/core/client.ts");
const evidenceReplayFacadeModules = new Set([
  evidenceReplayModule,
  resolve("src/core/client.js"),
]);
const evidenceObservationConsumer = resolve("src/core/capability-execution.ts");
const evidenceReplayConsumers = new Set([
  resolve("src/core/capability.ts"),
  resolve("src/core/capability-execution.ts"),
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

const resolveSourceModule = (importingFile: string, specifier: string): string | undefined => {
  const target = resolveModule(importingFile, specifier);
  if (target === undefined) return undefined;
  if (target.endsWith(".js")) return `${target.slice(0, -3)}.ts`;
  if (target.endsWith(".jsx")) return `${target.slice(0, -4)}.tsx`;
  if (target.endsWith(".cjs")) return `${target.slice(0, -4)}.cts`;
  if (target.endsWith(".mjs")) return `${target.slice(0, -4)}.mts`;
  return target;
};

const unwrapTransparentExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) current = current.expression;
  return current;
};

const enclosingVariableDeclaration = (call: ts.CallExpression): ts.VariableDeclaration | undefined => {
  let current: ts.Node = call;
  while (
    current.parent !== undefined &&
    (
      ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isNonNullExpression(current.parent)
    ) &&
    current.parent.expression === current
  ) current = current.parent;
  return current.parent !== undefined &&
      ts.isVariableDeclaration(current.parent) &&
      current.parent.initializer === current
    ? current.parent
    : undefined;
};

const applicationErrorRegistryConstructionViolations = (program: ts.Program): readonly string[] => {
  const checker = program.getTypeChecker();
  const coreErrors = program.getSourceFile(resolve("src/core/errors.ts"));
  const registryClass = coreErrors?.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === "ApplicationErrorRegistry",
  );
  const extendMember = registryClass?.members.find(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === "extend",
  );
  const extendSymbol = extendMember === undefined
    ? undefined
    : resolvedSymbol(checker, checker.getSymbolAtLocation(extendMember.name));
  if (extendSymbol === undefined) throw new TypeError("ApplicationErrorRegistry.extend could not be resolved.");

  const rulesByOwner = new Map(
    applicationErrorRegistryConstructionRules.map((rule) => [rule.ownerFile, rule] as const),
  );
  const expectedSymbols = new Map(applicationErrorRegistryConstructionRules.map((rule) => [
    rule.ownerFile,
    {
      definitions: moduleExportSymbol(program, checker, rule.definitionsFile, rule.definitionsName),
      parent: moduleExportSymbol(program, checker, rule.parentFile, rule.parentName),
    },
  ] as const));
  const exactConstructionCounts = new Map<string, number>();
  const ownerInvocationCounts = new Map<string, number>();
  const violations: string[] = [];

  const exactNamedImportCount = (
    sourceFile: ts.SourceFile,
    localName: string,
    importedName: string,
    expectedFile: string,
  ): number => sourceFile.statements.filter((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
    resolveSourceModule(sourceFile.fileName, statement.moduleSpecifier.text) === resolve(expectedFile))
    .flatMap((statement) => {
      const bindings = statement.importClause?.namedBindings;
      return bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements : [];
    })
    .filter((element) =>
      element.name.text === localName && (element.propertyName ?? element.name).text === importedName)
    .length;

  const callableResolvesToExtend = (node: ts.Node): boolean =>
    checker.getTypeAtLocation(node).getCallSignatures().some(
      (signature) => signature.declaration !== undefined &&
        extendSymbol.declarations?.includes(signature.declaration) === true,
    );

  const report = (file: ts.SourceFile, node: ts.Node, kind: string, detail = ""): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    const path = relative(sourceDirectory, file.fileName).split(sep).join("/");
    violations.push(`${path}:${line}:${kind}${detail.length === 0 ? "" : `:${detail}`}`);
  };
  const accessExtendSymbol = (
    expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): ts.Symbol | undefined => {
    const namedSymbol = ts.isPropertyAccessExpression(expression)
      ? checker.getSymbolAtLocation(expression.name)
      : expression.argumentExpression === undefined
        ? undefined
        : checker.getSymbolAtLocation(expression.argumentExpression);
    const resolved = resolvedSymbol(checker, namedSymbol);
    if (resolved === extendSymbol) return resolved;
    const property = checker.getTypeAtLocation(expression.expression).getProperty("extend");
    if (resolvedSymbol(checker, property) === extendSymbol) return extendSymbol;
    return callableResolvesToExtend(expression) ? extendSymbol : undefined;
  };
  const invokesExtend = (call: ts.CallExpression): boolean => {
    const signatureDeclaration = checker.getResolvedSignature(call)?.declaration;
    return signatureDeclaration !== undefined && extendSymbol.declarations?.includes(signatureDeclaration) === true;
  };
  const isDirectCalleeAccess = (
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): boolean => {
    let current: ts.Node = access;
    while (
      current.parent !== undefined &&
      (
        ts.isParenthesizedExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent) ||
        ts.isNonNullExpression(current.parent)
      ) &&
      current.parent.expression === current
    ) current = current.parent;
    return current.parent !== undefined && ts.isCallExpression(current.parent) && current.parent.expression === current;
  };
  const exactIdentifier = (
    expression: ts.Expression | undefined,
    expectedName: string,
    expectedSymbol: ts.Symbol | undefined,
  ): boolean => expression !== undefined && ts.isIdentifier(expression) && expression.text === expectedName &&
    expectedSymbol !== undefined &&
    resolvedSymbol(checker, checker.getSymbolAtLocation(expression)) === expectedSymbol;

  const inspectDirectCall = (
    file: ts.SourceFile,
    call: ts.CallExpression,
    access: ts.PropertyAccessExpression,
  ): void => {
    const owner = resolve(file.fileName);
    const rule = rulesByOwner.get(owner);
    if (rule === undefined) {
      report(file, call, "unauthorized_registry_construction");
      return;
    }
    ownerInvocationCounts.set(owner, (ownerInvocationCounts.get(owner) ?? 0) + 1);
    const declaration = enclosingVariableDeclaration(call);
    const statement = declaration?.parent.parent;
    const exportedConst = declaration !== undefined && ts.isIdentifier(declaration.name) &&
      statement !== undefined && ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (!exportedConst || declaration?.name.text !== rule.registryName) {
      report(file, call, "invalid_registry_export", rule.registryName);
    } else {
      const declaredSymbol = resolvedSymbol(checker, checker.getSymbolAtLocation(declaration.name));
      const exportedSymbol = moduleExportSymbol(program, checker, owner, rule.registryName);
      if (declaredSymbol === undefined || declaredSymbol !== exportedSymbol) {
        report(file, call, "invalid_registry_export_symbol", rule.registryName);
      }
    }
    const expected = expectedSymbols.get(owner);
    const receiver = unwrapTransparentExpression(access.expression);
    if (!exactIdentifier(receiver, rule.parentName, expected?.parent)) {
      report(file, access.expression, "invalid_registry_parent", rule.parentName);
    }
    const definitions = call.arguments[0] === undefined
      ? undefined
      : unwrapTransparentExpression(call.arguments[0]);
    if (
      call.arguments.length !== 1 ||
      !exactIdentifier(definitions, rule.definitionsName, expected?.definitions)
    ) {
      report(file, call, "invalid_registry_definitions", rule.definitionsName);
    }
    if (
      exportedConst && declaration?.name.text === rule.registryName &&
      exactIdentifier(receiver, rule.parentName, expected?.parent) &&
      call.arguments.length === 1 &&
      exactIdentifier(definitions, rule.definitionsName, expected?.definitions)
    ) {
      exactConstructionCounts.set(owner, (exactConstructionCounts.get(owner) ?? 0) + 1);
    }
  };

  for (const file of program.getSourceFiles()) {
    const absoluteFile = resolve(file.fileName);
    const fromSource = relative(sourceDirectory, absoluteFile);
    if (
      file.isDeclarationFile ||
      fromSource === "" ||
      isAbsolute(fromSource) ||
      fromSource === ".." ||
      fromSource.startsWith(`..${sep}`)
    ) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapTransparentExpression(node.expression);
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "extend" &&
          accessExtendSymbol(callee) === extendSymbol
        ) {
          inspectDirectCall(file, node, callee);
        } else if (
          (ts.isElementAccessExpression(callee) && accessExtendSymbol(callee) === extendSymbol) ||
          invokesExtend(node)
        ) {
          const owner = resolve(file.fileName);
          if (rulesByOwner.has(owner)) {
            ownerInvocationCounts.set(owner, (ownerInvocationCounts.get(owner) ?? 0) + 1);
          }
          report(file, node, "indirect_registry_construction");
        }
      }
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        accessExtendSymbol(node) === extendSymbol &&
        !isDirectCalleeAccess(node)
      ) report(file, node, "registry_extend_method_escape");
      if (ts.isBindingElement(node) && callableResolvesToExtend(node.name)) {
        report(file, node, "registry_extend_method_escape");
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  for (const rule of applicationErrorRegistryConstructionRules) {
    const ownerSource = program.getSourceFile(rule.ownerFile);
    if (ownerSource === undefined) {
      violations.push(
        `${relative(sourceDirectory, rule.ownerFile).split(sep).join("/")}:registry_owner_unavailable`,
      );
      continue;
    }
    const parentImportFile = pureRegistryParentImportFiles.get(rule.ownerFile);
    if (parentImportFile !== undefined) {
      const parentImportCount = exactNamedImportCount(
        ownerSource,
        rule.parentName,
        rule.parentName,
        parentImportFile,
      );
      if (parentImportCount !== 1) {
        violations.push(
          `${relative(sourceDirectory, rule.ownerFile).split(sep).join("/")}:` +
          `invalid_registry_parent_import:${rule.parentName}:${parentImportCount}`,
        );
      }
      const definitionsImportCount = exactNamedImportCount(
        ownerSource,
        rule.definitionsName,
        rule.definitionsName,
        rule.definitionsFile,
      );
      if (definitionsImportCount !== 1) {
        violations.push(
          `${relative(sourceDirectory, rule.ownerFile).split(sep).join("/")}:` +
          `invalid_registry_definitions_import:${rule.definitionsName}:${definitionsImportCount}`,
        );
      }
    }
    const exactCount = exactConstructionCounts.get(rule.ownerFile) ?? 0;
    const invocationCount = ownerInvocationCounts.get(rule.ownerFile) ?? 0;
    if (exactCount !== 1) {
      violations.push(`${relative(sourceDirectory, rule.ownerFile).split(sep).join("/")}:exact_construction_count:${exactCount}`);
    }
    if (invocationCount !== 1) {
      violations.push(`${relative(sourceDirectory, rule.ownerFile).split(sep).join("/")}:registry_invocation_count:${invocationCount}`);
    }
  }
  return violations.sort();
};

const readCapabilityConstructionViolations = (program: ts.Program): readonly string[] => {
  const checker = program.getTypeChecker();
  const defineCapabilitySymbol = moduleExportSymbol(
    program,
    checker,
    resolve("src/core/capability.ts"),
    "defineReadCapability",
  );
  if (defineCapabilitySymbol === undefined) throw new TypeError("defineReadCapability could not be resolved.");
  const defineCapabilityDeclarations = new Set<ts.Node>(defineCapabilitySymbol.declarations ?? []);
  for (const declaration of defineCapabilitySymbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      defineCapabilityDeclarations.add(declaration.initializer);
    }
  }

  const rulesByOwner = new Map<string, ReadonlyMap<string, ReadCapabilityConstructionRule>>();
  for (const rule of readCapabilityConstructionRules) {
    const existing = new Map(rulesByOwner.get(rule.ownerFile) ?? []);
    existing.set(rule.capabilityName, rule);
    rulesByOwner.set(rule.ownerFile, existing);
  }
  const exactConstructionCounts = new Map<string, number>();
  const ownerInvocationCounts = new Map<string, number>();
  const violations: string[] = [];

  const report = (file: ts.SourceFile, node: ts.Node, kind: string, detail = ""): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    const path = relative(sourceDirectory, file.fileName).split(sep).join("/");
    violations.push(`${path}:${line}:${kind}${detail.length === 0 ? "" : `:${detail}`}`);
  };
  const expressionSymbol = (expression: ts.Expression): ts.Symbol | undefined => {
    if (ts.isIdentifier(expression)) {
      return resolvedSymbol(checker, checker.getSymbolAtLocation(expression));
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return resolvedSymbol(checker, checker.getSymbolAtLocation(expression.name));
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression !== undefined) {
      return resolvedSymbol(checker, checker.getSymbolAtLocation(expression.argumentExpression));
    }
    return resolvedSymbol(checker, checker.getSymbolAtLocation(expression));
  };
  const callResolvesToDefinition = (call: ts.CallExpression): boolean => {
    const callee = unwrapTransparentExpression(call.expression);
    if (expressionSymbol(callee) === defineCapabilitySymbol) return true;
    const declaration = checker.getResolvedSignature(call)?.declaration;
    return declaration !== undefined && defineCapabilityDeclarations.has(declaration);
  };
  const canonicalCallee = (call: ts.CallExpression): boolean => {
    const callee = unwrapTransparentExpression(call.expression);
    return ts.isIdentifier(callee) && callee.text === "defineReadCapability" &&
      expressionSymbol(callee) === defineCapabilitySymbol;
  };
  const hasDirectCurrentVersion = (call: ts.CallExpression): boolean => {
    if (call.arguments.length !== 1) return false;
    const options = call.arguments[0] === undefined
      ? undefined
      : unwrapTransparentExpression(call.arguments[0]);
    if (options === undefined || !ts.isObjectLiteralExpression(options)) return false;
    if (options.properties.some((property) =>
      ts.isSpreadAssignment(property) ||
      (property.name !== undefined && ts.isComputedPropertyName(property.name)))) return false;
    const versionMembers = options.properties.filter((property) => {
      const name = property.name;
      return name !== undefined &&
        (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
        name.text === "contractVersion";
    });
    const versionProperty = versionMembers[0];
    return versionMembers.length === 1 &&
      versionProperty !== undefined &&
      ts.isPropertyAssignment(versionProperty) &&
      ts.isStringLiteral(versionProperty.initializer) &&
      versionProperty.initializer.text === "1";
  };
  const inspectCall = (file: ts.SourceFile, call: ts.CallExpression): void => {
    const owner = resolve(file.fileName);
    const ownerRules = rulesByOwner.get(owner);
    if (ownerRules === undefined) {
      report(file, call, "unauthorized_capability_construction");
      if (!canonicalCallee(call)) report(file, call, "indirect_capability_constructor");
      return;
    }
    ownerInvocationCounts.set(owner, (ownerInvocationCounts.get(owner) ?? 0) + 1);
    if (!canonicalCallee(call)) report(file, call, "indirect_capability_constructor");

    const declaration = enclosingVariableDeclaration(call);
    const statement = declaration?.parent.parent;
    const exportedConst = declaration !== undefined && ts.isIdentifier(declaration.name) &&
      statement !== undefined && ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    const capabilityName = declaration !== undefined && ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : undefined;
    const rule = capabilityName === undefined ? undefined : ownerRules.get(capabilityName);
    if (!exportedConst || rule === undefined || capabilityName === undefined) {
      report(file, call, "invalid_capability_export");
    } else {
      const declaredSymbol = resolvedSymbol(checker, checker.getSymbolAtLocation(declaration.name));
      const exportedSymbol = moduleExportSymbol(program, checker, owner, capabilityName);
      if (declaredSymbol === undefined || declaredSymbol !== exportedSymbol) {
        report(file, call, "invalid_capability_export_symbol", capabilityName);
      }
    }
    if (!hasDirectCurrentVersion(call)) {
      report(file, call, "invalid_capability_contract_version", capabilityName ?? "unknown");
    }
    if (canonicalCallee(call) && exportedConst && rule !== undefined && hasDirectCurrentVersion(call)) {
      const key = `${owner}\0${rule.capabilityName}`;
      exactConstructionCounts.set(key, (exactConstructionCounts.get(key) ?? 0) + 1);
    }
  };
  const isModuleBinding = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node;
    while (current !== undefined && !ts.isSourceFile(current)) {
      if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
      current = current.parent;
    }
    return false;
  };
  const isCallCallee = (node: ts.Expression): boolean => {
    let current: ts.Node = node;
    while (
      current.parent !== undefined &&
      (
        ts.isParenthesizedExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent) ||
        ts.isNonNullExpression(current.parent)
      ) &&
      current.parent.expression === current
    ) current = current.parent;
    return current.parent !== undefined && ts.isCallExpression(current.parent) && current.parent.expression === current;
  };

  for (const file of program.getSourceFiles()) {
    const absoluteFile = resolve(file.fileName);
    const fromSource = relative(sourceDirectory, absoluteFile);
    if (
      file.isDeclarationFile ||
      fromSource === "" ||
      isAbsolute(fromSource) ||
      fromSource === ".." ||
      fromSource.startsWith(`..${sep}`)
    ) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && callResolvesToDefinition(node)) inspectCall(file, node);
      if (
        (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        expressionSymbol(node) === defineCapabilitySymbol &&
        !defineCapabilityDeclarations.has(node.parent) &&
        !isModuleBinding(node) &&
        !isCallCallee(node) &&
        !(ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !(ts.isIdentifier(node) && ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
      ) {
        report(file, node, "capability_constructor_escape");
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  for (const rule of readCapabilityConstructionRules) {
    const key = `${rule.ownerFile}\0${rule.capabilityName}`;
    const count = exactConstructionCounts.get(key) ?? 0;
    if (count !== 1) {
      violations.push(
        `${relative(sourceDirectory, rule.ownerFile).split(sep).join("/")}:` +
        `exact_capability_construction_count:${rule.capabilityName}:${count}`,
      );
    }
  }
  for (const [owner, rules] of rulesByOwner) {
    const count = ownerInvocationCounts.get(owner) ?? 0;
    if (count !== rules.size) {
      violations.push(
        `${relative(sourceDirectory, owner).split(sep).join("/")}:capability_invocation_count:${count}`,
      );
    }
  }
  return violations.sort();
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

const productSourceFiles = await collectProductCodeSourceFiles(sourceDirectory);
const canonicalProductSourceProgram = createProductSourceProgram(productSourceFiles);
const coreCapabilityOwner = resolve("src/core/capabilities.ts");
const runtimeRegistryOwner = resolve("src/runtime/error-registry.ts");
const coreCapabilitySource = await readFile(coreCapabilityOwner, "utf8");
const runtimeRegistrySource = await readFile(runtimeRegistryOwner, "utf8");
const tokenCapabilityOwner = resolve("src/token-catalog/contract-schema.ts");
const uniswapCapabilityOwner = resolve("src/protocols/uniswap-v2/contracts.ts");
const tokenCapabilitySource = await readFile(tokenCapabilityOwner, "utf8");
const uniswapCapabilitySource = await readFile(uniswapCapabilityOwner, "utf8");

const replaceExactAuditSource = (source: string, needle: string, replacement: string): string => {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new TypeError(`Architecture audit mutation target is not unique: ${needle}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + needle.length)}`;
};

const addressContractAnalysisTargetViolations = (source: string): readonly string[] => {
  const sourceFile = ts.createSourceFile(
    coreCapabilityOwner,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((candidate) => ts.isIdentifier(candidate.name) &&
      candidate.name.text === "addressInspectCapability");
  if (declaration?.initializer === undefined) return ["definition"];
  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (!ts.isCallExpression(initializer)) return ["definition"];
  const options = initializer.arguments[0] === undefined
    ? undefined
    : unwrapTransparentExpression(initializer.arguments[0]);
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return ["options"];
  const intrinsic = options.properties.find((property): property is ts.PropertyAssignment =>
    ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) &&
    property.name.text === "validateIntrinsicData");
  if (intrinsic === undefined) return ["validateIntrinsicData"];

  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "assertContractAnalysisForTarget"
    ) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(intrinsic.initializer);
  if (calls.length !== 1) return [`target_call_count:${calls.length}`];
  const call = calls[0] as ts.CallExpression;
  const target = call.arguments[0] === undefined
    ? undefined
    : unwrapTransparentExpression(call.arguments[0]);
  if (target === undefined || !ts.isObjectLiteralExpression(target)) return ["target"];

  const expected = new Map([
    ["chainId", "data.block.chainId"],
    ["address", "data.address"],
    ["block", "data.block"],
    ["runtimeCode", "runtimeCode"],
  ]);
  const violations: string[] = [];
  for (const [name, expression] of expected) {
    const property = target.properties.find((candidate) =>
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
      ts.isIdentifier(candidate.name) && candidate.name.text === name);
    const actual = property === undefined
      ? undefined
      : ts.isPropertyAssignment(property)
        ? property.initializer.getText(sourceFile)
        : ts.isShorthandPropertyAssignment(property)
          ? property.name.text
          : undefined;
    if (actual !== expression) violations.push(name);
  }
  if (call.arguments[1]?.getText(sourceFile) !== "data.analysis") violations.push("analysis");
  return violations;
};

const addressTargetContractViolations = (capabilitySource: string): readonly string[] => {
  const sourceFile = ts.createSourceFile(
    coreCapabilityOwner,
    capabilitySource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations);
  const violations: string[] = [];
  for (const capabilityName of ["addressInspectCapability", "accountBalanceCapability"]) {
    const declaration = declarations.find((candidate) =>
      ts.isIdentifier(candidate.name) && candidate.name.text === capabilityName);
    const initializer = declaration?.initializer === undefined
      ? undefined
      : unwrapTransparentExpression(declaration.initializer);
    const options = initializer !== undefined && ts.isCallExpression(initializer) &&
        initializer.arguments[0] !== undefined
      ? unwrapTransparentExpression(initializer.arguments[0])
      : undefined;
    const failureCodes = options !== undefined && ts.isObjectLiteralExpression(options)
      ? options.properties.find((property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) &&
          property.name.text === "failureCodes")
      : undefined;
    const owner = failureCodes === undefined
      ? undefined
      : unwrapTransparentExpression(failureCodes.initializer);
    if (owner === undefined || !ts.isIdentifier(owner) ||
        owner.text !== "addressTargetReadFailureCodes") {
      violations.push(`${capabilityName}:failureCodes`);
    }
  }

  return violations;
};

interface IndependentAuditMutation {
  readonly name: string;
  readonly overrides: ReadonlyMap<string, string>;
  readonly expected: readonly Readonly<{
    file: string;
    kind: string;
    detail?: string;
  }>[];
}

const capabilityAuditMutations = Object.freeze([
  {
    name: "a duplicate capability in a canonical owner",
    overrides: new Map([[coreCapabilityOwner, `${coreCapabilitySource}
export const duplicateCoreCapability = defineReadCapability({ contractVersion: "1" } as never);
`]]),
    expected: [
      { file: "core/capabilities.ts", kind: "invalid_capability_export" },
      { file: "core/capabilities.ts", kind: "capability_invocation_count", detail: "6" },
    ],
  },
  {
    name: "a capability contract version hidden behind a constant",
    overrides: new Map([[coreCapabilityOwner, `${coreCapabilitySource}
const hiddenCapabilityOptions = { contractVersion: "1" } as never;
export const hiddenVersionCapability = defineReadCapability(hiddenCapabilityOptions);
`]]),
    expected: [
      {
        file: "core/capabilities.ts",
        kind: "invalid_capability_contract_version",
        detail: "hiddenVersionCapability",
      },
      { file: "core/capabilities.ts", kind: "invalid_capability_export" },
      { file: "core/capabilities.ts", kind: "capability_invocation_count", detail: "6" },
    ],
  },
  {
    name: "a computed capability contract version",
    overrides: new Map([[coreCapabilityOwner, `${coreCapabilitySource}
const hiddenCapabilityVersion = "1" as const;
const hiddenCapabilityKey = "contractVersion" as const;
export const computedVersionCapability = defineReadCapability({
  contractVersion: "1",
  [hiddenCapabilityKey]: hiddenCapabilityVersion,
} as never);
`]]),
    expected: [
      {
        file: "core/capabilities.ts",
        kind: "invalid_capability_contract_version",
        detail: "computedVersionCapability",
      },
      { file: "core/capabilities.ts", kind: "invalid_capability_export" },
      { file: "core/capabilities.ts", kind: "capability_invocation_count", detail: "6" },
    ],
  },
  {
    name: "a capability constructor hidden in a factory",
    overrides: new Map([[coreCapabilityOwner, `${coreCapabilitySource}
const capabilityFactory = () => defineReadCapability({ contractVersion: "1" } as never);
void capabilityFactory;
`]]),
    expected: [
      { file: "core/capabilities.ts", kind: "invalid_capability_export" },
      { file: "core/capabilities.ts", kind: "capability_invocation_count", detail: "6" },
    ],
  },
  {
    name: "an escaped and indirectly called capability constructor",
    overrides: new Map([[coreCapabilityOwner, `${coreCapabilitySource}
const escapedCapabilityConstructor = defineReadCapability;
const indirectCapability = escapedCapabilityConstructor({ contractVersion: "1" } as never);
void indirectCapability;
`]]),
    expected: [
      { file: "core/capabilities.ts", kind: "capability_constructor_escape" },
      { file: "core/capabilities.ts", kind: "indirect_capability_constructor" },
      { file: "core/capabilities.ts", kind: "invalid_capability_export" },
      { file: "core/capabilities.ts", kind: "capability_invocation_count", detail: "6" },
    ],
  },
  {
    name: "a capability without an explicit current contract version",
    overrides: new Map([[coreCapabilityOwner, `${coreCapabilitySource}
const defaultVersionCapability = defineReadCapability({} as never);
void defaultVersionCapability;
`]]),
    expected: [
      {
        file: "core/capabilities.ts",
        kind: "invalid_capability_contract_version",
        detail: "defaultVersionCapability",
      },
      { file: "core/capabilities.ts", kind: "invalid_capability_export" },
      { file: "core/capabilities.ts", kind: "capability_invocation_count", detail: "6" },
    ],
  },
  {
    name: "a capability contract version supplied through object spread",
    overrides: new Map([[coreCapabilityOwner, `${coreCapabilitySource}
const hiddenCapabilityOptions = { contractVersion: "1" } as never;
const spreadVersionCapability = defineReadCapability({
  ...hiddenCapabilityOptions,
  contractVersion: "1",
} as never);
void spreadVersionCapability;
`]]),
    expected: [
      {
        file: "core/capabilities.ts",
        kind: "invalid_capability_contract_version",
        detail: "spreadVersionCapability",
      },
      { file: "core/capabilities.ts", kind: "invalid_capability_export" },
      { file: "core/capabilities.ts", kind: "capability_invocation_count", detail: "6" },
    ],
  },
  {
    name: "an imported alias of the capability constructor",
    overrides: new Map([[tokenCapabilityOwner, replaceExactAuditSource(
      replaceExactAuditSource(
        tokenCapabilitySource,
        "  defineReadCapability,\n",
        "  defineReadCapability as defineCapability,\n",
      ),
      "  defineReadCapability<TokenInspectionInput, TokenInspectionData>({",
      "  defineCapability<TokenInspectionInput, TokenInspectionData>({",
    )]]),
    expected: [
      { file: "token-catalog/contract-schema.ts", kind: "indirect_capability_constructor" },
      {
        file: "token-catalog/contract-schema.ts",
        kind: "exact_capability_construction_count",
        detail: "tokenInspectCapability:0",
      },
    ],
  },
  {
    name: "a namespace reference to the capability constructor",
    overrides: new Map([[uniswapCapabilityOwner, replaceExactAuditSource(
      `import * as capabilityCore from "../../core/client.js";\n${uniswapCapabilitySource}`,
      "export const uniswapV2QuoteCapability = defineReadCapability<",
      "export const uniswapV2QuoteCapability = capabilityCore.defineReadCapability<",
    )]]),
    expected: [
      { file: "protocols/uniswap-v2/contracts.ts", kind: "indirect_capability_constructor" },
      {
        file: "protocols/uniswap-v2/contracts.ts",
        kind: "exact_capability_construction_count",
        detail: "uniswapV2QuoteCapability:0",
      },
    ],
  },
  {
    name: "a direct capability construction outside a registered owner",
    overrides: new Map([[resolve("src/architecture-audit-fixtures/unreachable-capability.ts"), `
import { defineReadCapability } from "../core/client.js";
export const unreachableDirectCapability = defineReadCapability({ contractVersion: "1" } as never);
`]]),
    expected: [
      {
        file: "architecture-audit-fixtures/unreachable-capability.ts",
        kind: "unauthorized_capability_construction",
      },
    ],
  },
  {
    name: "an aliased capability construction outside a registered owner",
    overrides: new Map([[resolve("src/architecture-audit-fixtures/unreachable-capability.ts"), `
import { defineReadCapability as defineFromIndex } from "../core/index.js";
export const unreachableAliasCapability = defineFromIndex({ contractVersion: "1" } as never);
`]]),
    expected: [
      {
        file: "architecture-audit-fixtures/unreachable-capability.ts",
        kind: "unauthorized_capability_construction",
      },
      {
        file: "architecture-audit-fixtures/unreachable-capability.ts",
        kind: "indirect_capability_constructor",
      },
    ],
  },
  {
    name: "a namespace capability construction outside a registered owner",
    overrides: new Map([[resolve("src/architecture-audit-fixtures/unreachable-capability.ts"), `
import * as clientCore from "../core/client.js";
export const unreachableNamespaceCapability = clientCore.defineReadCapability({} as never);
`]]),
    expected: [
      {
        file: "architecture-audit-fixtures/unreachable-capability.ts",
        kind: "unauthorized_capability_construction",
      },
      {
        file: "architecture-audit-fixtures/unreachable-capability.ts",
        kind: "indirect_capability_constructor",
      },
    ],
  },
] satisfies readonly IndependentAuditMutation[]);

const registryAuditMutations = Object.freeze([
  {
    name: "a renamed registry parent import",
    overrides: new Map([[runtimeRegistryOwner, `
import {
  assertDirectApplicationErrorRegistryExtension,
  coreErrorRegistry as parentRegistry,
} from "../core/client.js";
import { runtimeErrorDefinitions } from "./error-definitions.js";
export const runtimeErrorRegistry = parentRegistry.extend(runtimeErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(parentRegistry, runtimeErrorRegistry);
`]]),
    expected: [
      {
        file: "runtime/error-registry.ts",
        kind: "invalid_registry_parent",
        detail: "coreErrorRegistry",
      },
      { file: "runtime/error-registry.ts", kind: "exact_construction_count", detail: "0" },
      {
        file: "runtime/error-registry.ts",
        kind: "invalid_registry_parent_import",
        detail: "coreErrorRegistry:0",
      },
    ],
  },
  {
    name: "a renamed registry definitions import",
    overrides: new Map([[runtimeRegistryOwner, `
import {
  assertDirectApplicationErrorRegistryExtension,
  coreErrorRegistry,
} from "../core/client.js";
import { runtimeErrorDefinitions as definitions } from "./error-definitions.js";
export const runtimeErrorRegistry = coreErrorRegistry.extend(definitions);
assertDirectApplicationErrorRegistryExtension(coreErrorRegistry, runtimeErrorRegistry);
`]]),
    expected: [
      {
        file: "runtime/error-registry.ts",
        kind: "invalid_registry_definitions",
        detail: "runtimeErrorDefinitions",
      },
      { file: "runtime/error-registry.ts", kind: "exact_construction_count", detail: "0" },
      {
        file: "runtime/error-registry.ts",
        kind: "invalid_registry_definitions_import",
        detail: "runtimeErrorDefinitions:0",
      },
    ],
  },
  {
    name: "an escaped registry extension method",
    overrides: new Map([[runtimeRegistryOwner, `${runtimeRegistrySource}
const escapedRegistryExtend = coreErrorRegistry.extend;
void escapedRegistryExtend;
`]]),
    expected: [{ file: "runtime/error-registry.ts", kind: "registry_extend_method_escape" }],
  },
  {
    name: "an indirect bracket registry construction",
    overrides: new Map([[runtimeRegistryOwner, `${runtimeRegistrySource}
const bracketRegistry = coreErrorRegistry["extend"](runtimeErrorDefinitions);
void bracketRegistry;
`]]),
    expected: [
      { file: "runtime/error-registry.ts", kind: "indirect_registry_construction" },
      { file: "runtime/error-registry.ts", kind: "registry_invocation_count", detail: "2" },
    ],
  },
  {
    name: "a registry construction hidden in a factory",
    overrides: new Map([[runtimeRegistryOwner, `${runtimeRegistrySource}
const registryFactory = () => coreErrorRegistry.extend(runtimeErrorDefinitions);
void registryFactory;
`]]),
    expected: [
      {
        file: "runtime/error-registry.ts",
        kind: "invalid_registry_export",
        detail: "runtimeErrorRegistry",
      },
      { file: "runtime/error-registry.ts", kind: "registry_invocation_count", detail: "2" },
    ],
  },
  {
    name: "a chained registry construction",
    overrides: new Map([[runtimeRegistryOwner, `${runtimeRegistrySource}
const chainedRegistry = coreErrorRegistry.extend(runtimeErrorDefinitions).extend(runtimeErrorDefinitions);
void chainedRegistry;
`]]),
    expected: [
      {
        file: "runtime/error-registry.ts",
        kind: "invalid_registry_export",
        detail: "runtimeErrorRegistry",
      },
      {
        file: "runtime/error-registry.ts",
        kind: "invalid_registry_export",
        detail: "runtimeErrorRegistry",
      },
      {
        file: "runtime/error-registry.ts",
        kind: "invalid_registry_parent",
        detail: "coreErrorRegistry",
      },
      { file: "runtime/error-registry.ts", kind: "registry_invocation_count", detail: "3" },
    ],
  },
  {
    name: "aliased registry parent and definitions",
    overrides: new Map([[runtimeRegistryOwner, `${runtimeRegistrySource}
const aliasedRegistryParent = coreErrorRegistry;
const aliasedRegistryDefinitions = runtimeErrorDefinitions;
export const duplicateRuntimeRegistry = aliasedRegistryParent.extend(aliasedRegistryDefinitions);
`]]),
    expected: [
      {
        file: "runtime/error-registry.ts",
        kind: "invalid_registry_parent",
        detail: "coreErrorRegistry",
      },
      {
        file: "runtime/error-registry.ts",
        kind: "invalid_registry_definitions",
        detail: "runtimeErrorDefinitions",
      },
      {
        file: "runtime/error-registry.ts",
        kind: "invalid_registry_export",
        detail: "runtimeErrorRegistry",
      },
      { file: "runtime/error-registry.ts", kind: "registry_invocation_count", detail: "2" },
    ],
  },
  {
    name: "a registry parent imported through a facade",
    overrides: new Map([[resolve("src/wallet/error-registry.ts"), `
import { assertDirectApplicationErrorRegistryExtension } from "../core/client.js";
import { runtimeErrorRegistry } from "../runtime/errors.js";
import { walletErrorDefinitions } from "./error-definitions.js";
export const walletErrorRegistry = runtimeErrorRegistry.extend(walletErrorDefinitions);
assertDirectApplicationErrorRegistryExtension(runtimeErrorRegistry, walletErrorRegistry);
`]]),
    expected: [{
      file: "wallet/error-registry.ts",
      kind: "invalid_registry_parent_import",
      detail: "runtimeErrorRegistry:0",
    }],
  },
  {
    name: "a semantically wrong registry parent",
    overrides: new Map([[resolve("src/chain/error-registry.ts"), `
import { runtimeErrorRegistry } from "../runtime/error-registry.js";
import { chainErrorDefinitions } from "./error-definitions.js";
export const chainErrorRegistry = runtimeErrorRegistry.extend(chainErrorDefinitions);
`]]),
    expected: [
      {
        file: "chain/error-registry.ts",
        kind: "invalid_registry_parent",
        detail: "walletErrorRegistry",
      },
      { file: "chain/error-registry.ts", kind: "exact_construction_count", detail: "0" },
      {
        file: "chain/error-registry.ts",
        kind: "invalid_registry_parent_import",
        detail: "walletErrorRegistry:0",
      },
    ],
  },
  {
    name: "semantically wrong registry definitions",
    overrides: new Map([[resolve("src/token-catalog/error-registry.ts"), `
import { officialAssetErrorRegistry } from "../registry/error-registry.js";
import { chainErrorDefinitions } from "../chain/error-definitions.js";
export const tokenCatalogErrorRegistry = officialAssetErrorRegistry.extend(chainErrorDefinitions);
`]]),
    expected: [
      {
        file: "token-catalog/error-registry.ts",
        kind: "invalid_registry_definitions",
        detail: "tokenCatalogErrorDefinitions",
      },
      { file: "token-catalog/error-registry.ts", kind: "exact_construction_count", detail: "0" },
      {
        file: "token-catalog/error-registry.ts",
        kind: "invalid_registry_definitions_import",
        detail: "tokenCatalogErrorDefinitions:0",
      },
    ],
  },
  {
    name: "a registry construction outside a registered owner",
    overrides: new Map([[resolve("src/architecture-audit-fixtures/unreachable-registry.ts"), `
import { chainErrorRegistry } from "../chain/error-registry.js";
import { tokenCatalogErrorDefinitions } from "../token-catalog/error-definitions.js";
export const unreachableRegistry = chainErrorRegistry.extend(tokenCatalogErrorDefinitions);
`]]),
    expected: [{
      file: "architecture-audit-fixtures/unreachable-registry.ts",
      kind: "unauthorized_registry_construction",
    }],
  },
  {
    name: "a destructured registry extension method",
    overrides: new Map([[resolve("src/architecture-audit-fixtures/unreachable-registry.ts"), `
import { chainErrorRegistry } from "../chain/error-registry.js";
const { extend: destructuredRegistryExtend } = chainErrorRegistry;
void destructuredRegistryExtend;
`]]),
    expected: [{
      file: "architecture-audit-fixtures/unreachable-registry.ts",
      kind: "registry_extend_method_escape",
    }],
  },
] satisfies readonly IndependentAuditMutation[]);

const protectedModuleAdversarialProgram = createProductSourceProgram(
  productSourceFiles,
  new Map([
    [resolve("src/architecture-audit-fixtures/dynamic-authority.ts"), `
export const bypassCapabilityAuthority = async () =>
  ((await import("../core/index.js")) as any)["defineReadCapability"]({ contractVersion: "1" });
`],
    [resolve("src/architecture-audit-fixtures/namespace-authority.ts"), `
export * as runtimeErrors from "../runtime/errors.js";
`],
  ]),
  canonicalProductSourceProgram,
);
const protectedAuthoritySymbols = (program: ts.Program): ReadonlySet<ts.Symbol> => {
  const checker = program.getTypeChecker();
  const symbols = [
    moduleExportSymbol(program, checker, resolve("src/core/capability.ts"), "defineReadCapability"),
    moduleExportSymbol(program, checker, resolve("src/core/errors.ts"), "coreErrorRegistry"),
    ...applicationErrorRegistryConstructionRules.map((rule) =>
      moduleExportSymbol(program, checker, rule.ownerFile, rule.registryName)),
  ];
  if (symbols.some((symbol) => symbol === undefined)) {
    throw new TypeError("Protected capability or registry authority is unavailable.");
  }
  return new Set(symbols as readonly ts.Symbol[]);
};
const canonicalReadCapabilityAuditViolations = readCapabilityConstructionViolations(
  canonicalProductSourceProgram,
);
const canonicalRegistryAuditViolations = applicationErrorRegistryConstructionViolations(
  canonicalProductSourceProgram,
);
const canonicalProtectedModuleViolations = protectedModuleAccessViolations(
  canonicalProductSourceProgram,
  protectedAuthoritySymbols(canonicalProductSourceProgram),
  sourceDirectory,
);
const adversarialProtectedModuleViolations = protectedModuleAccessViolations(
  protectedModuleAdversarialProgram,
  protectedAuthoritySymbols(protectedModuleAdversarialProgram),
  sourceDirectory,
);

const expectIndependentAuditMutation = (
  mutation: IndependentAuditMutation,
  audit: (program: ts.Program) => readonly string[],
): void => {
  const program = createProductSourceProgram(
    productSourceFiles,
    mutation.overrides,
    canonicalProductSourceProgram,
  );
  const normalize = (violation: string): string => {
    const segments = violation.split(":");
    return segments[1] !== undefined && /^\d+$/u.test(segments[1])
      ? [segments[0], ...segments.slice(2)].join(":")
      : violation;
  };
  const actual = audit(program).map(normalize).sort();
  const expected = mutation.expected.map((violation) =>
    `${violation.file}:${violation.kind}${
      violation.detail === undefined ? "" : `:${violation.detail}`
    }`).sort();
  expect(actual, mutation.name).toEqual(expected);
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
      "createCanonicalClock",
      "createCapabilityInvocationAuthority",
      "createObservationAuthority",
      "ObservationAuthorityRegistry",
    ]) expect(Object.hasOwn(publicCore, compositionName)).toBe(true);
    expect(Object.hasOwn(publicCore, "defineReadCapability")).toBe(true);
  });

  it("permits exactly the eight canonical read capability constructions", async () => {
    expect(canonicalReadCapabilityAuditViolations).toEqual([]);
    expect(canonicalProtectedModuleViolations).toEqual([]);
  });

  for (const mutation of capabilityAuditMutations) {
    it(`rejects ${mutation.name}`, () => {
      expectIndependentAuditMutation(mutation, readCapabilityConstructionViolations);
    }, 15_000);
  }

  it("permits exactly the canonical application error registry construction chain", async () => {
    expect(canonicalRegistryAuditViolations).toEqual([]);
  });

  for (const mutation of registryAuditMutations) {
    it(`rejects ${mutation.name}`, () => {
      expectIndependentAuditMutation(mutation, applicationErrorRegistryConstructionViolations);
    }, 15_000);
  }

  it("rejects untyped and namespace acquisition of protected capability and registry modules", () => {
    expect(adversarialProtectedModuleViolations).toContain(
      "architecture-audit-fixtures/dynamic-authority.ts:3:protected_module_dynamic_import",
    );
    expect(adversarialProtectedModuleViolations).toContain(
      "architecture-audit-fixtures/namespace-authority.ts:2:protected_module_namespace_export",
    );
  });

  it("limits semantic evidence identity authoring to canonical and registered protocol owners", async () => {
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
      'import { createEvidenceReplayDefinition as defineEvidence } from "../core/client.js";',
      outsideOwner,
    )).toEqual(["chain/unauthorized-evidence.ts:named_import"]);
    expect(semanticEvidenceAuthoringViolations(
      'import * as replay from "../core/evidence-replay.js"; replay.createEvidenceReplayDefinition({});',
      outsideOwner,
    )).toEqual(["chain/unauthorized-evidence.ts:namespace_import"]);
    expect(semanticEvidenceAuthoringViolations(
      'export { createEvidenceReplayDefinition as defineEvidence } from "../core/client.js";',
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

    const unregisteredProtocolOwner =
      resolve("src/protocols/unregistered-v3/evidence.ts");
    expect(semanticEvidenceAuthoringViolations(
      'import { createEvidenceReplayDefinition } from "../../core/client.js";',
      unregisteredProtocolOwner,
    )).toEqual(["protocols/unregistered-v3/evidence.ts:named_import"]);
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
      'import * as core from "../core/client.js"; core.replayPublicEvidence({});',
      resolve("src/chain/unauthorized-replay.ts"),
    )).toEqual(["chain/unauthorized-replay.ts:public_replay"]);
    expect(evidenceReplayAuthorityViolations(
      'import { replayPublicEvidence as replay } from "../core/client.js"; replay({});',
      resolve("src/chain/unauthorized-replay.ts"),
    )).toEqual(["chain/unauthorized-replay.ts:public_replay"]);
    expect(Object.hasOwn(publicCore, "createEvidenceObservationId")).toBe(false);
    expect(await readFile(resolve("src/core/index.ts"), "utf8")).not.toMatch(/\bObservedFact\b/u);
    expect(await readFile(resolve("src/core/client.ts"), "utf8")).not.toMatch(/\bObservedFact\b/u);
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

  it("keeps one Core Address target and failure contract for both consumers", async () => {
    const targetSource = await readFile(resolve("src/core/address-target.ts"), "utf8");
    const accountSource = await readFile(resolve("src/core/account-balance-contract.ts"), "utf8");
    const capabilitySource = await readFile(resolve("src/core/capabilities.ts"), "utf8");

    expect(targetSource.match(/z\.discriminatedUnion\("kind"/gu)).toHaveLength(1);
    expect(accountSource).toContain('import { addressTargetSchema } from "./address-target.js";');
    expect(accountSource.match(/account: addressTargetSchema/gu)).toHaveLength(2);
    expect(capabilitySource).toMatch(
      /import\s*\{\s*addressTargetSchema,?\s*\}\s*from "\.\/address-target\.js";/u,
    );
    expect(capabilitySource).toContain("target: addressTargetSchema");
    expect(accountSource).not.toMatch(/discriminatedUnion\("kind"/u);
    expect(addressTargetContractViolations(capabilitySource)).toEqual([]);
    expect(addressTargetContractViolations(
      replaceExactAuditSource(
        capabilitySource,
        "failureCodes: addressTargetReadFailureCodes,\n  normalizeInput:",
        "failureCodes: canonicalFailureCodes([...addressTargetReadFailureCodes, \"not_found\"]),\n  normalizeInput:",
      ),
    )).toEqual(["accountBalanceCapability:failureCodes"]);
  });

  it("derives the complete Address analysis target only from outer canonical data", () => {
    expect(addressContractAnalysisTargetViolations(coreCapabilitySource)).toEqual([]);
    expect(addressContractAnalysisTargetViolations(replaceExactAuditSource(
      coreCapabilitySource,
      "chainId: data.block.chainId",
      "chainId: data.analysis.chainId",
    ))).toEqual(["chainId"]);
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
