import { readFile, readdir } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const codeSourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const terminalModuleExtensions = new Set([".css"]);

const auditedModuleExtensions = new Set([
  ...codeSourceExtensions,
  ...terminalModuleExtensions,
]);

const commonJsSourceExtensions = new Set([".cjs", ".cts"]);

export type ModuleImportReferenceKind =
  | "dynamic_import"
  | "import_equals"
  | "import_type"
  | "module"
  | "parse_error"
  | "require";

export interface ModuleImportReference {
  readonly kind: ModuleImportReferenceKind;
  readonly runtime: boolean;
  readonly specifier?: string;
  readonly specifierClass?: ModuleSpecifierClass;
  readonly packageRoot?: string;
}

export type DirectCodeExecutionKind =
  | "cjs_arguments"
  | "cjs_module_loader"
  | "cjs_require_reference"
  | "create_require"
  | "global_eval"
  | "global_function"
  | "node_module"
  | "process_loader";

export interface DirectCodeExecutionReference {
  readonly kind: DirectCodeExecutionKind;
}

export interface SourceAudit {
  readonly moduleImports: readonly ModuleImportReference[];
  readonly directCodeExecutions: readonly DirectCodeExecutionReference[];
}

export type ModuleSpecifierClass = "forbidden" | "node_builtin" | "package" | "relative";

export interface PackageImportPolicy {
  readonly auditedSourceFiles: ReadonlySet<string>;
  readonly repositoryRoot: string;
  readonly runtimePackageOwners: ReadonlyMap<string, ReadonlySet<string>>;
  readonly toolPackages: ReadonlySet<string>;
}

export interface PackageManifest {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

export const runtimePackageSourceRoots = Object.freeze({
  "@modelcontextprotocol/sdk": ["src/interfaces"],
  "@noble/hashes": ["src/core"],
  "@uniswap/sdk-core": ["src/protocols/uniswap-v2/sdk.ts"],
  "@uniswap/v2-sdk": ["src/protocols/uniswap-v2/sdk.ts"],
  "@walletconnect/sign-client": ["src/wallet"],
  "better-sqlite3": ["src/runtime"],
  "lightweight-charts": ["src/interfaces/web/lightweight-charts-adapter.tsx"],
  "lucide-react": ["src/interfaces"],
  qrcode: ["src/wallet"],
  react: ["src/interfaces"],
  "react-dom": ["src/interfaces"],
  viem: ["src/chain", "src/intelligence"],
  zod: ["src"],
} satisfies Readonly<Record<string, readonly string[]>>);

interface SourceContext {
  readonly checker: ts.TypeChecker;
  readonly commonJsSource: boolean;
  readonly declarationFile: boolean;
  readonly sourceFile: ts.SourceFile;
}

type ModuleOccurrenceForm =
  | "dynamic_import"
  | "import_equals"
  | "import_type"
  | "require"
  | "static_export"
  | "static_import";

interface ModuleOccurrence {
  readonly form: ModuleOccurrenceForm;
  readonly kind: Exclude<ModuleImportReferenceKind, "parse_error">;
  readonly namespace: boolean;
  readonly node: ts.Node;
  readonly runtime: boolean;
  readonly specifierExpression: ts.Expression | undefined;
}

const scriptKind = (path: string): ts.ScriptKind => {
  switch (extname(path)) {
    case ".js":
    case ".cjs":
    case ".mjs": return ts.ScriptKind.JS;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".tsx": return ts.ScriptKind.TSX;
    default: return ts.ScriptKind.TS;
  }
};

const createSourceContext = (source: string, path: string): SourceContext => {
  const normalizedPath = resolve(path);
  const sourceFile = ts.createSourceFile(
    normalizedPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const options: ts.CompilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    checkJs: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.Preserve,
    moduleDetection: ts.ModuleDetectionKind.Force,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const defaultHost = ts.createCompilerHost(options, true);
  const matchesSource = (candidate: string): boolean => resolve(candidate) === normalizedPath;
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: matchesSource,
    getSourceFile: (candidate) => matchesSource(candidate) ? sourceFile : undefined,
    readFile: (candidate) => matchesSource(candidate) ? source : undefined,
  };
  const program = ts.createProgram({ host, options, rootNames: [normalizedPath] });
  const checkedSource = program.getSourceFile(normalizedPath);
  if (checkedSource === undefined) throw new TypeError(`Source audit could not bind ${path}`);
  return {
    checker: program.getTypeChecker(),
    commonJsSource: commonJsSourceExtensions.has(extname(path)),
    declarationFile: /(?:^|\.)d\.(?:cts|mts|ts)$/u.test(path),
    sourceFile: checkedSource,
  };
};

const forbiddenPackageSegmentCharacterPattern = /[\\\0@:#?%]/;
const externalPackageSchemePattern = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const validPackageSegment = (value: string): boolean =>
  value.length > 0 && value !== "." && value !== ".." &&
  !forbiddenPackageSegmentCharacterPattern.test(value);

const packageRootFromSpecifier = (specifier: string): string | undefined => {
  if (
    specifier.length === 0 ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\\") ||
    specifier.startsWith("#") ||
    externalPackageSchemePattern.test(specifier)
  ) return undefined;

  const parts = specifier.split("/");
  const first = parts[0];
  if (first === undefined) return undefined;
  if (first.startsWith("@")) {
    const name = parts[1];
    return first.length > 1 && name !== undefined && validPackageSegment(first.slice(1)) &&
      parts.slice(1).every(validPackageSegment)
      ? `${first}/${name}`
      : undefined;
  }
  return parts.every(validPackageSegment) ? first : undefined;
};

export const packageRoot = packageRootFromSpecifier;

const hasNodeModulesSegment = (specifier: string): boolean =>
  specifier.split(/[\\/]/).includes("node_modules");

export const classifyModuleSpecifier = (specifier: string): ModuleSpecifierClass => {
  if (
    specifier.length === 0 ||
    specifier.includes("\0") ||
    specifier.includes("\\") ||
    hasNodeModulesSegment(specifier)
  ) return "forbidden";
  if (specifier.startsWith("node:")) {
    const path = specifier.slice("node:".length);
    return path.length > 0 && !path.startsWith("@") && packageRootFromSpecifier(path) !== undefined
      ? "node_builtin"
      : "forbidden";
  }
  if (
    specifier === "." || specifier === ".." ||
    specifier.startsWith("./") || specifier.startsWith("../")
  ) return "relative";
  if (specifier.startsWith("/") || specifier.startsWith("#")) return "forbidden";
  return packageRoot(specifier) === undefined ? "forbidden" : "package";
};

const validatedSourceRoot = (
  packageName: string,
  sourceRoot: string,
  repositoryRoot = resolve("."),
): string => {
  const owner = resolve(repositoryRoot, sourceRoot);
  const fromRepository = relative(repositoryRoot, owner);
  if (
    isAbsolute(fromRepository) ||
    fromRepository === ".." ||
    fromRepository.startsWith(`..${sep}`)
  ) throw new TypeError(`Package source root is outside the repository: ${packageName}:${sourceRoot}`);
  return owner;
};

const packageSection = (value: unknown, section: "dependencies" | "devDependencies"):
Readonly<Record<string, string>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Package manifest must be an object");
  }
  const candidate = (value as Record<string, unknown>)[section];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new TypeError(`Package manifest ${section} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(candidate)) {
    if (packageRootFromSpecifier(name) !== name || typeof version !== "string" || version.length === 0) {
      throw new TypeError(`Invalid ${section} declaration: ${name}`);
    }
    result[name] = version;
  }
  return result;
};

const parsePackageManifest = (value: unknown): PackageManifest => ({
  dependencies: packageSection(value, "dependencies"),
  devDependencies: packageSection(value, "devDependencies"),
});

export const loadPackageManifest = async (
  path = "package.json",
): Promise<PackageManifest> => parsePackageManifest(JSON.parse(await readFile(path, "utf8")));

export const createPackageImportPolicy = (
  manifestValue: unknown,
  repositoryRoot = resolve("."),
  auditedSourceFiles: readonly string[] = [],
): PackageImportPolicy => {
  const manifest = parsePackageManifest(manifestValue);
  const runtimePackageOwners = new Map<string, ReadonlySet<string>>();
  for (const name of Object.keys(manifest.dependencies)) {
    const sourceRoots = runtimePackageSourceRoots[name as keyof typeof runtimePackageSourceRoots];
    if (sourceRoots === undefined || sourceRoots.length === 0) {
      throw new TypeError(`Runtime package has no source owner: ${name}`);
    }
    runtimePackageOwners.set(
      name,
      new Set(sourceRoots.map((sourceRoot) =>
        validatedSourceRoot(name, sourceRoot, repositoryRoot))),
    );
  }
  for (const name of Object.keys(runtimePackageSourceRoots)) {
    if (!Object.hasOwn(manifest.dependencies, name)) {
      throw new TypeError(`Runtime package owner is undeclared: ${name}`);
    }
  }
  for (const name of Object.keys(manifest.devDependencies)) {
    if (Object.hasOwn(manifest.dependencies, name)) {
      throw new TypeError(`Package is both runtime and development dependency: ${name}`);
    }
  }

  return {
    auditedSourceFiles: new Set(auditedSourceFiles.map((sourcePath) => resolve(sourcePath))),
    repositoryRoot,
    runtimePackageOwners,
    toolPackages: new Set(Object.keys(manifest.devDependencies)),
  };
};

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) return unwrapExpression(expression.expression);
  return expression;
};

const literalString = (expression: ts.Expression | undefined): string | undefined => {
  if (expression === undefined) return undefined;
  const unwrapped = unwrapExpression(expression);
  return ts.isStringLiteralLike(unwrapped) ? unwrapped.text : undefined;
};

interface MemberPath {
  readonly members: readonly (string | undefined)[];
  readonly root: ts.Expression;
}

const memberPath = (expression: ts.Expression): MemberPath => {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const parent = memberPath(unwrapped.expression);
    return { root: parent.root, members: [...parent.members, unwrapped.name.text] };
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const parent = memberPath(unwrapped.expression);
    return {
      root: parent.root,
      members: [...parent.members, literalString(unwrapped.argumentExpression)],
    };
  }
  return { root: unwrapped, members: [] };
};

const isDirectMemberHostExpression = (node: ts.Expression): boolean => {
  let expression = node;
  let parent = expression.parent;
  while (
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)) &&
    parent.expression === expression
  ) {
    expression = parent;
    parent = expression.parent;
  }
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === expression;
  return ts.isElementAccessExpression(parent) &&
    parent.expression === expression &&
    literalString(parent.argumentExpression) !== undefined;
};

const isDirectMemberHostReference = (node: ts.Identifier): boolean =>
  isDirectMemberHostExpression(node);

const isRuntimeIdentifierReference = (node: ts.Identifier): boolean => {
  if (ts.isPartOfTypeNode(node) || ts.isTypeQueryNode(node.parent)) return false;
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isJsxAttribute(parent) && parent.name === node) return false;
  if (
    (ts.isJsxOpeningElement(parent) || ts.isJsxClosingElement(parent) ||
      ts.isJsxSelfClosingElement(parent)) &&
    parent.tagName === node
  ) return false;
  if (
    (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
    parent.label === node
  ) return false;
  const namedParent = parent as ts.NamedDeclaration;
  if (namedParent.name === node) return false;
  return true;
};

const bindingDeclaresName = (binding: ts.BindingName, name: string): boolean => {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) =>
    !ts.isOmittedExpression(element) && bindingDeclaresName(element.name, name));
};

const isAmbientDeclaration = (node: ts.Node): boolean => {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isSourceFile(current)) return current.isDeclarationFile;
    if (ts.canHaveModifiers(current) && ts.getModifiers(current)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.DeclareKeyword) === true) return true;
  }
  return false;
};

const declarationCreatesRuntimeBinding = (declaration: ts.Declaration): boolean => {
  if (isAmbientDeclaration(declaration)) return false;
  if (ts.isImportEqualsDeclaration(declaration)) return !declaration.isTypeOnly;
  if (ts.isImportSpecifier(declaration) && declaration.isTypeOnly) return false;
  if (
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isTypeParameterDeclaration(declaration)
  ) return false;
  for (let current: ts.Node | undefined = declaration; current !== undefined; current = current.parent) {
    if (ts.isImportDeclaration(current)) return current.importClause?.isTypeOnly !== true;
    if (ts.isSourceFile(current)) break;
  }
  return true;
};

const sourceDeclaresTopLevelValue = (sourceFile: ts.SourceFile, name: string): boolean =>
  sourceFile.statements.some((statement) => {
    if (isAmbientDeclaration(statement)) return false;
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some((declaration) =>
        bindingDeclaresName(declaration.name, name));
    }
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === name
    ) return declarationCreatesRuntimeBinding(statement);
    if (ts.isImportEqualsDeclaration(statement)) {
      return statement.name.text === name && declarationCreatesRuntimeBinding(statement);
    }
    if (!ts.isImportDeclaration(statement)) return false;
    const clause = statement.importClause;
    if (clause === undefined) return false;
    if (clause.name?.text === name) return declarationCreatesRuntimeBinding(clause);
    const bindings = clause?.namedBindings;
    if (bindings === undefined) return false;
    if (ts.isNamespaceImport(bindings)) {
      return bindings.name.text === name && declarationCreatesRuntimeBinding(bindings);
    }
    return bindings.elements.some((element) =>
      element.name.text === name && declarationCreatesRuntimeBinding(element));
  });

const isUnshadowedIdentifier = (
  node: ts.Expression,
  name: string,
  context: SourceContext,
): node is ts.Identifier => {
  const unwrapped = unwrapExpression(node);
  if (!ts.isIdentifier(unwrapped) || unwrapped.text !== name) return false;
  const symbol = context.checker.getSymbolAtLocation(unwrapped) ??
    context.checker.getSymbolsInScope(unwrapped, ts.SymbolFlags.Value)
      .find((candidate) => candidate.name === name);
  if (sourceDeclaresTopLevelValue(context.sourceFile, name)) return false;
  return symbol === undefined || symbol.declarations?.some((declaration) =>
    declaration.getSourceFile() === context.sourceFile && declarationCreatesRuntimeBinding(declaration)) !== true;
};

const isDirectRequireCall = (node: ts.CallExpression, context: SourceContext): boolean =>
  node.questionDotToken === undefined && isUnshadowedIdentifier(node.expression, "require", context);

const importTypeSpecifier = (node: ts.ImportTypeNode): ts.Expression | undefined =>
  ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)
    ? node.argument.literal
    : undefined;

const importDeclarationLoadsRuntime = (node: ts.ImportDeclaration): boolean => {
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined || clause.namedBindings === undefined || ts.isNamespaceImport(clause.namedBindings)) {
    return true;
  }
  return clause.namedBindings.elements.length === 0 ||
    clause.namedBindings.elements.some((element) => !element.isTypeOnly);
};

const exportDeclarationLoadsRuntime = (node: ts.ExportDeclaration): boolean => {
  if (node.isTypeOnly) return false;
  if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) return true;
  return node.exportClause.elements.length === 0 ||
    node.exportClause.elements.some((element) => !element.isTypeOnly);
};

const classifyModuleOccurrence = (
  node: ts.Node,
  context: SourceContext,
): ModuleOccurrence | undefined => {
  const admittedRuntime = (runtime: boolean): boolean => runtime && !context.declarationFile;
  if (ts.isImportDeclaration(node)) {
    return {
      form: "static_import",
      kind: "module",
      namespace: node.importClause?.namedBindings !== undefined &&
        ts.isNamespaceImport(node.importClause.namedBindings),
      node,
      runtime: admittedRuntime(importDeclarationLoadsRuntime(node)),
      specifierExpression: node.moduleSpecifier,
    };
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
    return {
      form: "static_export",
      kind: "module",
      namespace: node.exportClause !== undefined && ts.isNamespaceExport(node.exportClause),
      node,
      runtime: admittedRuntime(exportDeclarationLoadsRuntime(node)),
      specifierExpression: node.moduleSpecifier,
    };
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    return {
      form: "import_equals",
      kind: "import_equals",
      namespace: false,
      node,
      runtime: admittedRuntime(!node.isTypeOnly),
      specifierExpression: node.moduleReference.expression,
    };
  }
  if (ts.isImportTypeNode(node)) {
    return {
      form: "import_type",
      kind: "import_type",
      namespace: false,
      node,
      runtime: false,
      specifierExpression: importTypeSpecifier(node),
    };
  }
  if (!ts.isCallExpression(node)) return undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return {
      form: "dynamic_import",
      kind: "dynamic_import",
      namespace: false,
      node,
      runtime: admittedRuntime(true),
      specifierExpression: node.arguments[0],
    };
  }
  if (!isDirectRequireCall(node, context)) return undefined;
  return {
    form: "require",
    kind: "require",
    namespace: false,
    node,
    runtime: admittedRuntime(true),
    specifierExpression: node.arguments[0],
  };
};

const moduleImportReferences = (context: SourceContext): readonly ModuleImportReference[] => {
  const references: ModuleImportReference[] = [];
  const record = (
    kind: ModuleImportReferenceKind,
    expression: ts.Expression | undefined,
    runtime: boolean,
  ): void => {
    const specifier = literalString(expression);
    if (specifier === undefined) {
      references.push({ kind, runtime });
      return;
    }
    const specifierClass = classifyModuleSpecifier(specifier);
    const root = specifierClass === "package" ? packageRoot(specifier) : undefined;
    const base = { kind, runtime, specifier, specifierClass } as const;
    references.push(root === undefined ? base : { ...base, packageRoot: root });
  };

  const parseDiagnostics = (context.sourceFile as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics;
  if (parseDiagnostics !== undefined && parseDiagnostics.length > 0) {
    references.push({ kind: "parse_error", runtime: false });
  }

  const visit = (node: ts.Node): void => {
    const occurrence = classifyModuleOccurrence(node, context);
    if (occurrence !== undefined) {
      record(
        occurrence.kind,
        occurrence.specifierExpression,
        occurrence.runtime,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(context.sourceFile);
  return references;
};

const isNodeModuleSpecifier = (specifier: string | undefined): boolean =>
  specifier === "node:module" || specifier?.startsWith("node:module/") === true;

const importsCreateRequire = (node: ts.ImportDeclaration, context: SourceContext): boolean => {
  const occurrence = classifyModuleOccurrence(node, context);
  if (
    occurrence?.runtime !== true ||
    !isNodeModuleSpecifier(literalString(occurrence.specifierExpression))
  ) return false;
  const bindings = node.importClause?.namedBindings;
  return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.some((element) =>
    !element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === "createRequire");
};

const exportsCreateRequire = (node: ts.ExportDeclaration, context: SourceContext): boolean => {
  const occurrence = classifyModuleOccurrence(node, context);
  if (
    occurrence?.runtime !== true ||
    !isNodeModuleSpecifier(literalString(occurrence.specifierExpression))
  ) return false;
  return node.exportClause !== undefined && ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.some((element) =>
      !element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === "createRequire");
};

const isArgumentsScope = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

const directCodeExecutionReferences = (
  context: SourceContext,
  moduleImports: readonly ModuleImportReference[],
): readonly DirectCodeExecutionReference[] => {
  if (context.declarationFile) return [];
  const kinds = new Set<DirectCodeExecutionKind>();
  if (moduleImports.some((reference) => reference.runtime && isNodeModuleSpecifier(reference.specifier))) {
    kinds.add("node_module");
  }

  const processLoaderMembers = new Set([
    "_linkedBinding",
    "binding",
    "dlopen",
    "getBuiltinModule",
    "mainModule",
  ]);
  const commonJsModuleLoaderMembers = new Set([
    "_compile",
    "children",
    "constructor",
    "load",
    "parent",
    "require",
  ]);

  const recordProcessPath = (members: readonly (string | undefined)[]): void => {
    const first = members[0];
    if (first === undefined || processLoaderMembers.has(first)) kinds.add("process_loader");
  };

  const recordCommonJsModulePath = (members: readonly (string | undefined)[]): void => {
    const first = members[0];
    if (first === undefined || commonJsModuleLoaderMembers.has(first)) {
      kinds.add("cjs_module_loader");
    }
  };

  const recordDirectMember = (expression: ts.Expression): void => {
    const path = memberPath(expression);
    if (path.members.length === 0) return;
    if (
      isUnshadowedIdentifier(path.root, "globalThis", context) ||
      isUnshadowedIdentifier(path.root, "global", context)
    ) {
      let members = path.members;
      while (members[0] === "globalThis" || members[0] === "global") {
        members = members.slice(1);
      }
      if (members.length === 0 && isDirectMemberHostExpression(expression)) return;
      const [first, ...rest] = members;
      if (first === undefined || first === "eval") kinds.add("global_eval");
      if (first === undefined || first === "Function") kinds.add("global_function");
      if (
        first === "process" &&
        !(rest.length === 0 && isDirectMemberHostExpression(expression))
      ) recordProcessPath(rest);
      if (
        context.commonJsSource && first === "module" &&
        !(rest.length === 0 && isDirectMemberHostExpression(expression))
      ) recordCommonJsModulePath(rest);
      if (context.commonJsSource && first === "require") kinds.add("cjs_require_reference");
      return;
    }
    if (isUnshadowedIdentifier(path.root, "process", context)) {
      recordProcessPath(path.members);
      return;
    }
    if (context.commonJsSource && isUnshadowedIdentifier(path.root, "module", context)) {
      recordCommonJsModulePath(path.members);
    }
  };

  const visit = (node: ts.Node, ownsArguments: boolean): void => {
    if (ts.isImportDeclaration(node) && importsCreateRequire(node, context)) kinds.add("create_require");
    if (ts.isExportDeclaration(node) && exportsCreateRequire(node, context)) kinds.add("create_require");

    if (ts.isIdentifier(node) && isRuntimeIdentifierReference(node)) {
      if (isUnshadowedIdentifier(node, "eval", context)) kinds.add("global_eval");
      if (isUnshadowedIdentifier(node, "Function", context)) kinds.add("global_function");
      if (!isDirectMemberHostReference(node)) {
        if (
          isUnshadowedIdentifier(node, "globalThis", context) ||
          isUnshadowedIdentifier(node, "global", context)
        ) {
          kinds.add("global_eval");
          kinds.add("global_function");
        }
        if (isUnshadowedIdentifier(node, "process", context)) {
          kinds.add("process_loader");
        }
        if (context.commonJsSource && isUnshadowedIdentifier(node, "module", context)) {
          kinds.add("cjs_module_loader");
        }
      }
      if (
        context.commonJsSource && !ownsArguments &&
        isUnshadowedIdentifier(node, "arguments", context)
      ) kinds.add("cjs_arguments");
      if (isUnshadowedIdentifier(node, "require", context)) {
        const call = ts.isCallExpression(node.parent) && node.parent.expression === node
          ? node.parent
          : undefined;
        if (call === undefined || !isDirectRequireCall(call, context)) {
          kinds.add("cjs_require_reference");
        }
      }
    }
    if (ts.isExpression(node)) recordDirectMember(node);

    const childOwnsArguments = ownsArguments || isArgumentsScope(node);
    ts.forEachChild(node, (child) => visit(child, childOwnsArguments));
  };
  visit(context.sourceFile, false);
  return [...kinds].map((kind) => ({ kind }));
};

export const inspectSource = (source: string, path: string): SourceAudit => {
  if (terminalModuleExtensions.has(extname(path))) {
    return { moduleImports: [], directCodeExecutions: [] };
  }
  const context = createSourceContext(source, path);
  const moduleImports = moduleImportReferences(context);
  return {
    moduleImports,
    directCodeExecutions: directCodeExecutionReferences(context, moduleImports),
  };
};

export const inspectModuleImports = (
  source: string,
  path: string,
): readonly ModuleImportReference[] => inspectSource(source, path).moduleImports;

export const inspectDirectCodeExecution = (
  source: string,
  path: string,
): readonly DirectCodeExecutionReference[] => inspectSource(source, path).directCodeExecutions;

export const collectSourceFiles = async (directory: string): Promise<readonly string[]> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectSourceFiles(path));
    else if (entry.isFile() && auditedModuleExtensions.has(extname(entry.name))) files.push(path);
    else if (entry.isSymbolicLink()) throw new TypeError(`Source audit does not follow symbolic links: ${path}`);
  }
  return files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
};

export const collectProductSourceFiles = async (
  repositoryRoot = resolve("."),
): Promise<readonly string[]> => {
  const files = [
    ...await collectSourceFiles(resolve(repositoryRoot, "src")),
    ...await collectSourceFiles(resolve(repositoryRoot, "scripts")),
  ];
  const rootEntries = await readdir(repositoryRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    const path = resolve(repositoryRoot, entry.name);
    if (entry.isFile() && auditedModuleExtensions.has(extname(entry.name))) files.push(path);
    else if (entry.isSymbolicLink() && auditedModuleExtensions.has(extname(entry.name))) {
      throw new TypeError(`Source audit does not follow symbolic links: ${path}`);
    }
  }
  return [...new Set(files)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
};

export const collectProductCodeSourceFiles = async (
  directory = resolve("src"),
): Promise<readonly string[]> => Object.freeze(
  (await collectSourceFiles(directory)).filter((file) => codeSourceExtensions.has(extname(file))),
);

export const resolveProgramSymbol = (
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined => {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while (current !== undefined && (current.flags & ts.SymbolFlags.Alias) !== 0) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
};

export const programModuleExportSymbol = (
  program: ts.Program,
  checker: ts.TypeChecker,
  file: string,
  name: string,
): ts.Symbol | undefined => {
  const sourceFile = program.getSourceFile(resolve(file));
  const moduleSymbol = sourceFile === undefined ? undefined : checker.getSymbolAtLocation(sourceFile);
  return moduleSymbol === undefined
    ? undefined
    : resolveProgramSymbol(
        checker,
        checker.getExportsOfModule(moduleSymbol).find((entry) => entry.name === name),
      );
};

export const protectedModuleAccessViolations = (
  program: ts.Program,
  protectedSymbols: ReadonlySet<ts.Symbol>,
  sourceRoot = resolve("src"),
): readonly string[] => {
  const checker = program.getTypeChecker();
  const protectedModules = new Set<string>();
  for (const sourceFile of program.getSourceFiles()) {
    const fromSource = relative(sourceRoot, sourceFile.fileName);
    if (
      sourceFile.isDeclarationFile || fromSource === "" || isAbsolute(fromSource) ||
      fromSource === ".." || fromSource.startsWith(`..${sep}`)
    ) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (moduleSymbol !== undefined && checker.getExportsOfModule(moduleSymbol).some((entry) => {
      const resolved = resolveProgramSymbol(checker, entry);
      return resolved !== undefined && protectedSymbols.has(resolved);
    })) protectedModules.add(resolve(sourceFile.fileName));
  }

  const resolvedTarget = (sourceFile: ts.SourceFile, specifier: string): string | undefined => {
    if (classifyModuleSpecifier(specifier) !== "relative") return undefined;
    const resolution = ts.resolveModuleName(
      specifier,
      sourceFile.fileName,
      program.getCompilerOptions(),
      ts.sys,
    ).resolvedModule;
    return resolution === undefined ? undefined : resolve(resolution.resolvedFileName);
  };
  const violations: string[] = [];
  const report = (sourceFile: ts.SourceFile, node: ts.Node, kind: string): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    violations.push(
      `${relative(sourceRoot, sourceFile.fileName).split(sep).join("/")}:${line}:${kind}`,
    );
  };
  const inspectRuntimeLoad = (
    sourceFile: ts.SourceFile,
    node: ts.Node,
    specifier: string | undefined,
    kind: string,
  ): void => {
    if (specifier === undefined) {
      report(sourceFile, node, "unresolved_runtime_module_load");
      return;
    }
    const target = resolvedTarget(sourceFile, specifier);
    if (target !== undefined && protectedModules.has(target)) {
      report(sourceFile, node, kind);
    }
  };

  for (const sourceFile of program.getSourceFiles()) {
    const fromSource = relative(sourceRoot, sourceFile.fileName);
    if (
      sourceFile.isDeclarationFile || fromSource === "" || isAbsolute(fromSource) ||
      fromSource === ".." || fromSource.startsWith(`..${sep}`)
    ) continue;
    const context: SourceContext = {
      checker,
      commonJsSource: commonJsSourceExtensions.has(extname(sourceFile.fileName)),
      declarationFile: sourceFile.isDeclarationFile,
      sourceFile,
    };
    const visit = (node: ts.Node): void => {
      const occurrence = classifyModuleOccurrence(node, context);
      if (occurrence?.runtime === true) {
        const violationKind = occurrence.form === "dynamic_import"
          ? "protected_module_dynamic_import"
          : occurrence.form === "require"
            ? "protected_module_require"
            : occurrence.form === "import_equals"
              ? "protected_module_import_equals"
              : occurrence.form === "static_import" && occurrence.namespace
                ? "protected_module_namespace_import"
                : occurrence.form === "static_export" && occurrence.namespace
                  ? "protected_module_namespace_export"
                  : undefined;
        if (violationKind !== undefined) {
          inspectRuntimeLoad(
            sourceFile,
            occurrence.node,
            literalString(occurrence.specifierExpression),
            violationKind,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations.sort();
};

const directImportMetaUrl = (expression: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(expression) &&
  expression.name.text === "url" &&
  ts.isMetaProperty(expression.expression) &&
  expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
  expression.expression.name.text === "meta";

const topLevelConstInitializer = (
  call: ts.CallExpression,
): ts.VariableDeclaration | undefined => {
  const declaration = call.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer !== call ||
    !ts.isIdentifier(declaration.name)
  ) return undefined;
  const declarationList = declaration.parent;
  const statement = declarationList.parent;
  return ts.isVariableDeclarationList(declarationList) &&
    (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    ts.isVariableStatement(statement) &&
    ts.isSourceFile(statement.parent) &&
    ts.getModifiers(statement)?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword ||
      modifier.kind === ts.SyntaxKind.DefaultKeyword) !== true
    ? declaration
    : undefined;
};

export const uniswapV2SdkLoadBoundaryViolations = (
  program: ts.Program,
  policy: PackageImportPolicy,
): readonly string[] => {
  const sdkFile = resolve(policy.repositoryRoot, "src/protocols/uniswap-v2/sdk.ts");
  const sdkName = relative(policy.repositoryRoot, sdkFile).split(sep).join("/");
  const violations: string[] = [];
  const report = (node: ts.Node | undefined, kind: string): void => {
    if (node === undefined) {
      violations.push(`${sdkName}:${kind}`);
      return;
    }
    const sourceFile = node.getSourceFile();
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    violations.push(`${sdkName}:${line}:${kind}`);
  };

  const expectedPackages = [...policy.runtimePackageOwners]
    .filter(([, owners]) => owners.size === 1 && owners.has(sdkFile))
    .map(([packageName]) => packageName)
    .sort();
  if (expectedPackages.length !== 2) {
    report(undefined, "invalid_exact_package_owner_count");
  }
  const expectedPackageSet = new Set(expectedPackages);

  const sourceFile = program.getSourceFile(sdkFile);
  if (sourceFile === undefined) {
    report(undefined, "missing_sdk_source");
    return violations.sort();
  }
  const checker = program.getTypeChecker();
  const context: SourceContext = {
    checker,
    commonJsSource: false,
    declarationFile: sourceFile.isDeclarationFile,
    sourceFile,
  };
  const runtimeReferenceSymbol = (node: ts.Identifier): ts.Symbol | undefined =>
    ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent) ??
        checker.getSymbolAtLocation(node)
      : checker.getSymbolAtLocation(node);
  const runtimeLocalExportReference = (node: ts.Identifier): boolean => {
    const specifier = node.parent;
    if (!ts.isExportSpecifier(specifier) || specifier.isTypeOnly) return false;
    const declaration = specifier.parent.parent;
    return ts.isExportDeclaration(declaration) &&
      !declaration.isTypeOnly &&
      declaration.moduleSpecifier === undefined &&
      (specifier.propertyName ?? specifier.name) === node;
  };
  const referencesSymbol = (node: ts.Identifier, symbol: ts.Symbol): boolean => {
    const reference = runtimeReferenceSymbol(node);
    if (reference === symbol) return true;
    return runtimeLocalExportReference(node) &&
      resolveProgramSymbol(checker, reference) === resolveProgramSymbol(checker, symbol);
  };

  const exactFactoryImports: ts.ImportSpecifier[] = [];
  const visitRuntimeModuleOccurrences = (node: ts.Node): void => {
    const occurrence = classifyModuleOccurrence(node, context);
    const specifier = occurrence?.runtime === true
      ? literalString(occurrence.specifierExpression)
      : undefined;
    if (occurrence?.runtime === true && specifier !== undefined &&
      classifyModuleSpecifier(specifier) === "node_builtin") {
      const declaration = ts.isImportDeclaration(node) ? node : undefined;
      const clause = declaration?.importClause;
      const bindings = clause?.namedBindings;
      const elements = bindings !== undefined && ts.isNamedImports(bindings)
        ? bindings.elements
        : undefined;
      const factoryImport =
        specifier === "node:module" &&
        clause?.name === undefined &&
        elements?.length === 1 &&
        elements[0]?.isTypeOnly === false &&
        elements[0]?.propertyName === undefined &&
        elements[0]?.name.text === "createRequire"
          ? elements[0]
          : undefined;
      if (factoryImport === undefined) report(occurrence.node, "unexpected_node_builtin_access");
      else exactFactoryImports.push(factoryImport);
    }
    if (
      occurrence?.runtime === true &&
      specifier !== undefined &&
      expectedPackageSet.has(packageRoot(specifier) ?? "")
    ) report(occurrence.node, "alternate_sdk_package_load");
    ts.forEachChild(node, visitRuntimeModuleOccurrences);
  };
  visitRuntimeModuleOccurrences(sourceFile);

  if (exactFactoryImports.length === 0) report(undefined, "missing_create_require_import");
  if (exactFactoryImports.length > 1) report(undefined, "duplicate_create_require_import");
  const factoryImport = exactFactoryImports.length === 1 ? exactFactoryImports[0] : undefined;
  const factorySymbol = factoryImport === undefined
    ? undefined
    : checker.getSymbolAtLocation(factoryImport.name);
  if (factoryImport !== undefined && factorySymbol === undefined) {
    report(factoryImport, "unbound_create_require_import");
  }

  const loaderDeclarations: ts.VariableDeclaration[] = [];
  if (factorySymbol !== undefined) {
    const visitFactoryReferences = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        (isRuntimeIdentifierReference(node) || runtimeLocalExportReference(node)) &&
        referencesSymbol(node, factorySymbol)
      ) {
        const call = ts.isCallExpression(node.parent) && node.parent.expression === node
          ? node.parent
          : undefined;
        const declaration = call === undefined ? undefined : topLevelConstInitializer(call);
        if (
          call?.questionDotToken === undefined &&
          call?.arguments.length === 1 &&
          directImportMetaUrl(call.arguments[0] as ts.Expression) &&
          declaration !== undefined
        ) {
          loaderDeclarations.push(declaration);
        } else {
          report(node, "create_require_factory_escape");
        }
      }
      ts.forEachChild(node, visitFactoryReferences);
    };
    visitFactoryReferences(sourceFile);
  }

  if (loaderDeclarations.length === 0) report(undefined, "missing_loader_construction");
  if (loaderDeclarations.length > 1) report(undefined, "duplicate_loader_construction");
  const loaderDeclaration = loaderDeclarations.length === 1 ? loaderDeclarations[0] : undefined;
  const loaderSymbol = loaderDeclaration === undefined || !ts.isIdentifier(loaderDeclaration.name)
    ? undefined
    : checker.getSymbolAtLocation(loaderDeclaration.name);
  if (loaderDeclaration !== undefined && loaderSymbol === undefined) {
    report(loaderDeclaration, "unbound_loader");
  }

  const packageCalls = new Map<string, ts.CallExpression[]>();
  if (loaderSymbol !== undefined) {
    const visitLoaderReferences = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        (isRuntimeIdentifierReference(node) || runtimeLocalExportReference(node)) &&
        referencesSymbol(node, loaderSymbol)
      ) {
        const call = ts.isCallExpression(node.parent) && node.parent.expression === node
          ? node.parent
          : undefined;
        if (call?.questionDotToken !== undefined || call?.arguments.length !== 1) {
          report(node, "loader_escape");
        } else {
          const argument = call.arguments[0];
          if (argument === undefined || !ts.isStringLiteralLike(argument)) {
            report(call, "nonliteral_package_load");
          } else if (!expectedPackageSet.has(argument.text)) {
            report(call, "unexpected_package_load");
          } else {
            const calls = packageCalls.get(argument.text) ?? [];
            calls.push(call);
            packageCalls.set(argument.text, calls);
          }
        }
      }
      ts.forEachChild(node, visitLoaderReferences);
    };
    visitLoaderReferences(sourceFile);
  }

  for (const packageName of expectedPackages) {
    const calls = packageCalls.get(packageName) ?? [];
    if (calls.length === 0) report(undefined, `missing_package_load:${packageName}`);
    for (const duplicate of calls.slice(1)) {
      report(duplicate, `duplicate_package_load:${packageName}`);
    }
  }
  return violations.sort();
};

export const createProductSourceProgram = (
  sourceFiles: readonly string[],
  overrides: ReadonlyMap<string, string> = new Map(),
  oldProgram?: ts.Program,
): ts.Program => {
  const configPath = resolve("tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new TypeError(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve("."), undefined, configPath);
  const options: ts.CompilerOptions = {
    ...parsed.options,
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
  };
  const normalizedSources = sourceFiles.map((file) => resolve(file));
  const normalizedOverrides = new Map(
    [...overrides].map(([path, source]) => [resolve(path), source] as const),
  );
  for (const path of [...normalizedSources, ...normalizedOverrides.keys()]) {
    if (!codeSourceExtensions.has(extname(path))) {
      throw new TypeError(`Product TypeScript program received an unsupported source: ${path}`);
    }
  }
  const rootNames = [...new Set([
    ...normalizedSources,
    ...normalizedOverrides.keys(),
  ])].sort();
  const defaultHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (path) => normalizedOverrides.has(resolve(path)) || defaultHost.fileExists(path),
    getSourceFile: (path, languageVersion, onError, shouldCreateNewSourceFile) => {
      const source = normalizedOverrides.get(resolve(path));
      return source === undefined
        ? defaultHost.getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(path, source, languageVersion, true, scriptKind(path));
    },
    readFile: (path) => normalizedOverrides.get(resolve(path)) ?? defaultHost.readFile(path),
  };
  return ts.createProgram({
    host,
    options,
    rootNames,
    ...(oldProgram === undefined ? {} : { oldProgram }),
  });
};

export const inspectSourceFile = async (path: string): Promise<SourceAudit> =>
  inspectSource(await readFile(path, "utf8"), path);

const isWithin = (path: string, directory: string): boolean => {
  const fromDirectory = relative(directory, path);
  return fromDirectory === "" || (!isAbsolute(fromDirectory) && fromDirectory !== ".." &&
    !fromDirectory.startsWith(`..${sep}`));
};

const isToolSource = (file: string, repositoryRoot: string): boolean => {
  const fromRepository = relative(repositoryRoot, file);
  if (
    isAbsolute(fromRepository) ||
    fromRepository === ".." ||
    fromRepository.startsWith(`..${sep}`)
  ) return false;
  return !fromRepository.includes(sep) ||
    fromRepository === "scripts" ||
    fromRepository.startsWith(`scripts${sep}`);
};

const auditedSourceCandidates = (target: string): readonly string[] => {
  const extension = extname(target);
  const stem = target.slice(0, target.length - extension.length);
  switch (extension) {
    case ".js": return [target, `${stem}.jsx`, `${stem}.ts`, `${stem}.tsx`];
    case ".jsx": return [target, `${stem}.tsx`];
    case ".mjs": return [target, `${stem}.mts`];
    case ".cjs": return [target, `${stem}.cts`];
    default: return [target];
  }
};

const isAuditedRelativeTarget = (
  file: string,
  specifier: string,
  policy: PackageImportPolicy,
): boolean => {
  const { repositoryRoot } = policy;
  let targetUrl: URL;
  let target: string;
  try {
    targetUrl = new URL(specifier, pathToFileURL(file));
    if (targetUrl.protocol !== "file:" || targetUrl.search !== "" || targetUrl.hash !== "") return false;
    target = fileURLToPath(targetUrl);
  } catch {
    return false;
  }
  if (!isWithin(target, repositoryRoot) || !auditedModuleExtensions.has(extname(target))) return false;
  const auditedTargets = auditedSourceCandidates(target)
    .filter((candidate) => policy.auditedSourceFiles.has(resolve(candidate)));
  if (auditedTargets.length !== 1) return false;
  const auditedTarget = auditedTargets[0] as string;
  const sourceRoot = resolve(repositoryRoot, "src");
  if (isWithin(file, sourceRoot) && !isWithin(auditedTarget, sourceRoot)) return false;
  const fromRepository = relative(repositoryRoot, auditedTarget);
  if (!fromRepository.includes(sep)) return true;
  return fromRepository.startsWith(`src${sep}`) || fromRepository.startsWith(`scripts${sep}`);
};

export const moduleImportPolicyViolations = (
  file: string,
  references: readonly ModuleImportReference[],
  policy: PackageImportPolicy,
): readonly string[] => {
  const name = relative(policy.repositoryRoot, file).split(sep).join("/");
  const violations: string[] = [];
  for (const reference of references) {
    if (reference.kind === "parse_error") {
      violations.push(`${name}:parse_error`);
    } else if (
      (reference.kind === "dynamic_import" || reference.kind === "import_equals" ||
        reference.kind === "import_type" || reference.kind === "require") &&
      reference.specifier === undefined
    ) {
      violations.push(`${name}:${reference.kind}:non_literal`);
    } else if (reference.specifierClass === "forbidden") {
      violations.push(`${name}:${reference.kind}:forbidden_specifier`);
    } else if (
      reference.specifierClass === "relative" &&
      reference.specifier !== undefined &&
      !isAuditedRelativeTarget(file, reference.specifier, policy)
    ) {
      violations.push(`${name}:${reference.kind}:relative_outside_audit`);
    }

    if (
      reference.runtime &&
      (reference.kind === "import_equals" || reference.kind === "require") &&
      !commonJsSourceExtensions.has(extname(file))
    ) violations.push(`${name}:${reference.kind}:commonjs_only`);
    if (reference.kind === "module" && extname(file) === ".cjs") {
      violations.push(`${name}:${reference.kind}:esm_module_reference_in_commonjs`);
    }

    if (reference.packageRoot !== undefined) {
      const owners = policy.runtimePackageOwners.get(reference.packageRoot);
      if (owners !== undefined) {
        if (![...owners].some((owner) => isWithin(file, owner))) {
          const ownerNames = [...owners]
            .map((owner) => relative(policy.repositoryRoot, owner).split(sep).join("/"))
            .join("|");
          violations.push(`${name}:${reference.packageRoot}:${ownerNames}`);
        }
      } else if (policy.toolPackages.has(reference.packageRoot)) {
        if (!isToolSource(file, policy.repositoryRoot)) {
          violations.push(`${name}:${reference.packageRoot}:development_only`);
        }
      } else {
        violations.push(`${name}:${reference.packageRoot}:undeclared`);
      }
    }
  }
  return violations;
};

export const directCodeExecutionViolations = (
  file: string,
  references: readonly DirectCodeExecutionReference[],
  repositoryRoot = resolve("."),
): readonly string[] => {
  const name = relative(repositoryRoot, file).split(sep).join("/");
  const exactOwner = name === "src/protocols/uniswap-v2/sdk.ts"
    ? new Set<DirectCodeExecutionKind>(["node_module", "create_require"])
    : undefined;
  const violations = references
    .filter((reference) => exactOwner?.has(reference.kind) !== true)
    .map((reference) => `${name}:direct_code_execution:${reference.kind}`);
  if (exactOwner !== undefined) {
    const actual = new Set(references.map((reference) => reference.kind));
    for (const kind of exactOwner) {
      if (!actual.has(kind)) {
        violations.push(`${name}:missing_direct_code_execution:${kind}`);
      }
    }
  }
  return violations;
};
