import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import type { Plugin } from "vite";

import { browserAssetContentViolation } from "../src/interfaces/browser-asset-policy.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const nodeModulesRoot = resolve(repositoryRoot, "node_modules");
const webSourceRoot = resolve(repositoryRoot, "src/interfaces/web");
const webEntrySource = resolve(webSourceRoot, "main.tsx");
const webApplicationSource = resolve(webSourceRoot, "app.tsx");
const walletClientSource = resolve(webSourceRoot, "wallet-client.ts");
const browserClientSource = resolve(webSourceRoot, "browser-client.ts");
const browserOperationIdSource = resolve(webSourceRoot, "operation-id.ts");
const referenceMarketViewSource = resolve(webSourceRoot, "reference-market-view.tsx");
const canonicalJsonSource = resolve(repositoryRoot, "src/core/canonical-json.ts");
const evidenceSource = resolve(repositoryRoot, "src/core/evidence.ts");
const keccak256Source = resolve(repositoryRoot, "src/core/keccak256.ts");
const canonicalJsonValueSource = resolve(repositoryRoot, "src/core/canonical-json-value.ts");
const jsonObjectSource = resolve(repositoryRoot, "src/core/json-object.ts");
const immutabilitySource = resolve(repositoryRoot, "src/core/immutability.ts");
const sharedContractSources = new Set([
  "src/interfaces/browser-contract.ts",
  "src/interfaces/browser-error-response.ts",
  "src/interfaces/operation-delivery.ts",
  "src/interfaces/reference-market-delivery.ts",
  "src/core/application-contract.ts",
  "src/core/account-balance-contract.ts",
  "src/core/canonical-json-value.ts",
  "src/core/canonical-json.ts",
  "src/core/capability-contract.ts",
  "src/core/capability-evidence.ts",
  "src/core/amounts.ts",
  "src/core/browser.ts",
  "src/core/contract.ts",
  "src/core/digests.ts",
  "src/core/error-definitions.ts",
  "src/core/errors.ts",
  "src/core/evm-address-input.ts",
  "src/core/evidence.ts",
  "src/core/evidence-replay.ts",
  "src/core/identities.ts",
  "src/core/immutability.ts",
  "src/core/invocation.ts",
  "src/core/json-object.ts",
  "src/core/keccak256.ts",
  "src/core/primitives.ts",
  "src/core/operation-id.ts",
  "src/core/product-identity.ts",
  "src/core/reference-market.ts",
  "src/core/token-standards.ts",
  "src/core/wallet-connection.ts",
  "src/chain/error-definitions.ts",
  "src/runtime/error-definitions.ts",
  "src/token-catalog/browser.ts",
  "src/token-catalog/contract-schema.ts",
  "src/token-catalog/error-definitions.ts",
  "src/token-catalog/http-contract.ts",
  "src/token-catalog/state.ts",
  "src/market-portfolio/contracts.ts",
  "src/market-portfolio/error-definitions.ts",
  "src/account-assets/browser.ts",
  "src/account-assets/contracts.ts",
  "src/account-assets/error-registry.ts",
  "src/account-assets/http-contract.ts",
  "src/account-assets/view.ts",
  "src/wallet/error-definitions.ts",
  "src/wallet/management-contracts.ts",
  "src/wallet/operation-contract.ts",
  "src/wallet/operation-state.ts",
].map((path) => resolve(repositoryRoot, path)));

const allowedRuntimePackages = new Set(["@noble/hashes", "lucide-react", "react", "react-dom", "scheduler", "zod"]);
const allowedWebPackageImports = new Map([
  ["react", new Set(["ReactNode", "StrictMode", "useCallback", "useEffect", "useRef", "useState"])],
  ["react-dom/client", new Set(["createRoot"])],
  ["lucide-react", new Set([
    "ChevronLeft", "ChevronRight", "EllipsisVertical", "Plus", "RefreshCw", "Trash2",
  ])],
]);
const allowedWebConstructorsBySource = new Map([
  [webEntrySource, new Set(["Error"])],
  [webApplicationSource, new Set(["Error", "Set"])],
  [browserClientSource, new Set(["AbortController", "BrowserResponseError", "Promise", "TypeError"])],
  [browserOperationIdSource, new Set(["Uint8Array"])],
  [referenceMarketViewSource, new Set(["AbortController", "Map", "Set"])],
  [resolve(webSourceRoot, "request-authority.ts"), new Set(["AbortController"])],
]);
const allowedVirtualModules = new Set([
  "\0commonjsHelpers.js",
  "\0rolldown/runtime.js",
  "\0vite/modulepreload-polyfill.js",
]);
const codeSourceExtensions = new Set([".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const allowedIntrinsicElements = new Set([
  "a", "article", "button", "code", "dd", "details", "dialog", "div", "dl", "dt", "h1", "h2", "header",
  "footer", "input", "label", "li", "main", "nav", "option", "p", "polyline", "rect", "section", "select", "span", "strong", "summary", "svg", "ul",
]);
const allowedIntrinsicAttributes = new Set([
  "aria-current", "aria-expanded", "aria-hidden", "aria-label", "aria-labelledby", "aria-modal", "autoComplete", "className", "disabled",
  "fill", "height", "href", "key", "onBlur", "onCancel", "onChange", "onClick", "onFocus", "onKeyDown", "points",
  "onMouseDown", "onMouseEnter", "onMouseLeave", "ref", "role",
  "id", "shapeRendering", "spellCheck", "stroke", "strokeWidth", "tabIndex", "title", "type", "value", "vectorEffect", "viewBox", "width", "x", "y",
]);
const forbiddenGlobalIdentifiers = new Set([
  "Audio", "BroadcastChannel", "DOMParser", "EventSource", "Function", "Image", "SharedWorker",
  "WebSocket", "Worker", "XMLHttpRequest", "clearInterval", "clearTimeout", "eval", "fetch", "frames",
  "history", "indexedDB", "localStorage", "location", "navigator", "open", "parent", "postMessage",
  "self", "sessionStorage", "setInterval", "setTimeout", "top",
]);
const browserGlobalRoots = new Set(["document", "globalThis", "navigator", "Object", "Reflect", "window"]);
const allowedGlobalMembers = new Set([
  "document.getElementById",
  "document.querySelector",
  "document.title",
  "globalThis.atob",
  "globalThis.btoa",
  "globalThis.clearTimeout",
  "globalThis.crypto.getRandomValues",
  "globalThis.fetch",
  "globalThis.setTimeout",
  "Object.create",
  "Object.freeze",
  "Object.getOwnPropertyDescriptors",
  "Object.hasOwn",
  "Object.is",
  "Object.isFrozen",
  "Object.keys",
  "Object.prototype",
  "Object.values",
  "Reflect.getPrototypeOf",
  "Reflect.ownKeys",
  "window.clearTimeout",
  "window.location.reload",
  "window.location.pathname",
  "window.sessionStorage.getItem",
  "window.sessionStorage.removeItem",
  "window.sessionStorage.setItem",
  "window.setTimeout",
]);
const callableGlobalMembers = new Set([
  "document.getElementById",
  "document.querySelector",
  "globalThis.atob",
  "globalThis.btoa",
  "globalThis.clearTimeout",
  "globalThis.crypto.getRandomValues",
  "globalThis.fetch",
  "globalThis.setTimeout",
  "Object.create",
  "Object.freeze",
  "Object.getOwnPropertyDescriptors",
  "Object.hasOwn",
  "Object.is",
  "Object.isFrozen",
  "Object.keys",
  "Object.values",
  "Reflect.getPrototypeOf",
  "Reflect.ownKeys",
  "window.clearTimeout",
  "window.location.reload",
  "window.sessionStorage.getItem",
  "window.sessionStorage.removeItem",
  "window.sessionStorage.setItem",
  "window.setTimeout",
]);
const sensitiveGlobalMemberSources = new Map([
  ["globalThis.crypto.getRandomValues", new Set([browserOperationIdSource])],
  ["Object.getOwnPropertyDescriptors", new Set([
    canonicalJsonValueSource,
    jsonObjectSource,
    immutabilitySource,
  ])],
  ["Reflect.getPrototypeOf", new Set([canonicalJsonValueSource])],
  ["Reflect.ownKeys", new Set([canonicalJsonValueSource, jsonObjectSource])],
  ["window.location.reload", new Set([webApplicationSource])],
  ["window.location.pathname", new Set([webApplicationSource])],
  ["window.sessionStorage.getItem", new Set([webApplicationSource])],
  ["window.sessionStorage.removeItem", new Set([webApplicationSource])],
  ["window.sessionStorage.setItem", new Set([webApplicationSource])],
]);
const allowedDomRuntimeIdentifiers = new Set(["AbortController", "document", "window"]);
const protectedRuntimeBindings = new Set([
  "AbortController", "Array", "Date", "Error", "globalThis", "JSON", "Map", "Math", "Number",
  "Object", "Promise", "Reflect", "RegExp", "Set", "String", "Symbol", "TypeError", "WeakSet",
  "document", "window",
]);
const forbiddenJsxAttributes = new Set([
  "action", "dangerouslySetInnerHTML", "formAction", "poster", "src", "srcDoc", "style",
]);
const forbiddenAssignedMembers = new Set([
  "action", "formAction", "href", "innerHTML", "outerHTML", "poster", "src", "srcdoc",
]);
const forbiddenDomCallMembers = new Set([
  "createElement", "insertAdjacentHTML", "setAttributeNS",
]);
const restrictedAuthorityCallMembers = new Set([
  "constructor", "fetch", "open", "postMessage", "sendBeacon", "setInterval", "setTimeout",
]);
const forbiddenDerivedAuthorityMembers = new Set([
  "contentDocument", "contentWindow", "defaultView", "ownerDocument",
]);

const browserAuditCompilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  jsx: ts.JsxEmit.ReactJSX,
  noResolve: true,
  skipLibCheck: true,
};
const compilerSourceCache = new Map<string, ts.SourceFile>();

const isWithin = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
};

const withoutQuery = (moduleId: string): string => {
  const query = moduleId.indexOf("?");
  return query === -1 ? moduleId : moduleId.slice(0, query);
};

const packageRootFromPath = (path: string): string | undefined => {
  if (!isWithin(nodeModulesRoot, path)) return undefined;
  const segments = relative(nodeModulesRoot, path).split(sep);
  const first = segments[0];
  if (first === undefined || first.length === 0) return undefined;
  if (!first.startsWith("@")) return segments.slice(1).includes("node_modules") ? undefined : first;
  const second = segments[1];
  if (second === undefined || second.length === 0 || segments.slice(2).includes("node_modules")) return undefined;
  return `${first}/${second}`;
};

export const browserModulePolicyViolation = (moduleId: string): string | undefined => {
  if (allowedVirtualModules.has(moduleId)) return undefined;
  const path = withoutQuery(moduleId.startsWith("\0") ? moduleId.slice(1) : moduleId);
  if (!isAbsolute(path)) return moduleId;
  const packageRoot = packageRootFromPath(path);
  if (packageRoot !== undefined) return allowedRuntimePackages.has(packageRoot) ? undefined : moduleId;
  return isWithin(webSourceRoot, path) || sharedContractSources.has(path) ? undefined : moduleId;
};

const unwrap = (input: ts.Expression): ts.Expression => {
  if (ts.isParenthesizedExpression(input) || ts.isAsExpression(input) ||
    ts.isTypeAssertionExpression(input) || ts.isNonNullExpression(input) ||
    ts.isSatisfiesExpression(input)) return unwrap(input.expression);
  return input;
};

interface MemberPath {
  readonly parts: readonly string[];
  readonly computed: boolean;
}

const memberPath = (input: ts.Expression): MemberPath | undefined => {
  const expression = unwrap(input);
  if (ts.isIdentifier(expression)) return { parts: [expression.text], computed: false };
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = memberPath(expression.expression);
    return parent === undefined
      ? undefined
      : { parts: [...parent.parts, expression.name.text], computed: parent.computed };
  }
  if (ts.isElementAccessExpression(expression)) {
    const parent = memberPath(expression.expression);
    const argument = expression.argumentExpression === undefined
      ? undefined
      : unwrap(expression.argumentExpression);
    return parent === undefined
      ? undefined
      : {
          parts: [...parent.parts,
            argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : "*"],
          computed: true,
        };
  }
  return undefined;
};

const memberSuffix = (input: ts.Expression): MemberPath | undefined => {
  const expression = unwrap(input);
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = memberSuffix(expression.expression);
    return {
      parts: [...(parent?.parts ?? []), expression.name.text],
      computed: parent?.computed ?? false,
    };
  }
  if (ts.isElementAccessExpression(expression)) {
    const parent = memberSuffix(expression.expression);
    const argument = expression.argumentExpression === undefined
      ? undefined
      : unwrap(expression.argumentExpression);
    return {
      parts: [...(parent?.parts ?? []),
        argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : "*"],
      computed: true,
    };
  }
  return undefined;
};

const isMemberExpression = (node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);

const isMemberPrefix = (node: ts.Node): boolean =>
  isMemberExpression(node.parent) && unwrap(node.parent.expression) === node;

const isPropertyName = (node: ts.Identifier): boolean =>
  (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
  (ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
  (ts.isPropertySignature(node.parent) && node.parent.name === node) ||
  (ts.isMethodDeclaration(node.parent) && node.parent.name === node);

const isBindingIdentifier = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  return (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) || ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent)) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isImportEqualsDeclaration(parent) && parent.name === node);
};

const isWithinTypePosition = (node: ts.Node): boolean => {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isExpression(current) || ts.isStatement(current) || ts.isJsxAttribute(current)) return false;
    current = current.parent;
  }
  return false;
};

const isAssignmentTarget = (node: ts.Node): boolean =>
  ts.isBinaryExpression(node.parent) && node.parent.left === node &&
  node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
  node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

const scriptKind = (path: string): ts.ScriptKind => {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

const createAuditedSource = (
  path: string,
  source: string,
): { readonly checker: ts.TypeChecker; readonly sourceFile: ts.SourceFile } => {
  const targetSource = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const host = ts.createCompilerHost(browserAuditCompilerOptions, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readSource = host.readFile.bind(host);
  host.fileExists = (fileName): boolean => resolve(fileName) === path || fileExists(fileName);
  host.readFile = (fileName): string | undefined => resolve(fileName) === path ? source : readSource(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile): ts.SourceFile | undefined => {
    if (resolve(fileName) === path) return targetSource;
    if (!shouldCreateNewSourceFile) {
      const cached = compilerSourceCache.get(fileName);
      if (cached !== undefined) return cached;
    }
    const loaded = getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    if (loaded !== undefined && !shouldCreateNewSourceFile) compilerSourceCache.set(fileName, loaded);
    return loaded;
  };
  const program = ts.createProgram({
    rootNames: [path],
    options: browserAuditCompilerOptions,
    host,
  });
  const sourceFile = program.getSourceFile(path);
  if (sourceFile === undefined) throw new TypeError(`Browser source could not be audited: ${path}`);
  return { checker: program.getTypeChecker(), sourceFile };
};

const symbolIsDeclaredIn = (
  checker: ts.TypeChecker,
  node: ts.Identifier,
  fileName: string,
): boolean => checker.getSymbolAtLocation(node)?.declarations?.some((declaration) =>
  declaration.getSourceFile().fileName.endsWith(fileName)) === true;

const approvedConstructorBinding = (
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
): boolean => {
  if (!ts.isIdentifier(expression) ||
    allowedWebConstructorsBySource.get(resolve(sourceFile.fileName))?.has(expression.text) !== true) return false;
  if (expression.text === "Error" || expression.text === "TypeError") {
    return symbolIsDeclaredIn(checker, expression, "lib.es5.d.ts");
  }
  if (expression.text === "Uint8Array") {
    return symbolIsDeclaredIn(checker, expression, "lib.es5.d.ts");
  }
  if (expression.text === "Promise") {
    return symbolIsDeclaredIn(checker, expression, "lib.es2015.promise.d.ts");
  }
  if (expression.text === "Map" || expression.text === "Set") {
    return symbolIsDeclaredIn(checker, expression, "lib.es2015.collection.d.ts");
  }
  if (expression.text === "AbortController") return symbolIsDeclaredIn(checker, expression, "lib.dom.d.ts");
  if (expression.text !== "BrowserResponseError") return false;
  return checker.getSymbolAtLocation(expression)?.declarations?.some((declaration) =>
    ts.isClassDeclaration(declaration) && declaration.getSourceFile() === sourceFile &&
    declaration.name?.text === "BrowserResponseError") === true;
};

const sourceLocation = (sourceFile: ts.SourceFile, node: ts.Node): string => {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`;
};

const approvedFetch = (node: ts.CallExpression, sourceFile: ts.SourceFile): boolean => {
  if (resolve(sourceFile.fileName) !== browserClientSource || node.arguments.length !== 2) return false;
  const arrow = node.parent;
  if (!ts.isArrowFunction(arrow) || arrow.body !== node || arrow.modifiers !== undefined ||
    arrow.parameters.length !== 2) return false;
  const [inputParameter, initParameter] = arrow.parameters;
  if (inputParameter === undefined || initParameter === undefined ||
    !ts.isIdentifier(inputParameter.name) || inputParameter.name.text !== "input" ||
    inputParameter.initializer !== undefined || inputParameter.dotDotDotToken !== undefined ||
    inputParameter.questionToken !== undefined ||
    !ts.isIdentifier(initParameter.name) || initParameter.name.text !== "init" ||
    initParameter.initializer !== undefined || initParameter.dotDotDotToken !== undefined ||
    initParameter.questionToken !== undefined) return false;
  const [inputArgument, initArgument] = node.arguments;
  const canonicalInputArgument = inputArgument === undefined ? undefined : unwrap(inputArgument);
  const canonicalInitArgument = initArgument === undefined ? undefined : unwrap(initArgument);
  if (inputArgument === undefined || initArgument === undefined ||
    canonicalInputArgument === undefined || canonicalInitArgument === undefined ||
    !ts.isIdentifier(canonicalInputArgument) || canonicalInputArgument.text !== inputParameter.name.text ||
    !ts.isIdentifier(canonicalInitArgument) || canonicalInitArgument.text !== initParameter.name.text) return false;
  const declaration = arrow.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== arrow ||
    !ts.isIdentifier(declaration.name) || declaration.name.text !== "defaultBrowserFetch" ||
    declaration.type?.getText(sourceFile) !== "BrowserFetch") return false;
  const declarationList = declaration.parent;
  const statement = declarationList.parent;
  return ts.isVariableDeclarationList(declarationList) && declarationList.declarations.length === 1 &&
    (declarationList.flags & ts.NodeFlags.Const) !== 0 && ts.isVariableStatement(statement) &&
    statement.parent === sourceFile &&
    ts.isIdentifier(declaration.name) && declaration.name.text === "defaultBrowserFetch" &&
    declaration.type?.getText(sourceFile) === "BrowserFetch";
};

const approvedTimerCallback = (node: ts.CallExpression): boolean => {
  const callback = node.arguments[0];
  return callback !== undefined && ts.isArrowFunction(unwrap(callback));
};

const csrfSelectorArgument = (node: ts.Expression | undefined): boolean => {
  const expression = node === undefined ? undefined : unwrap(node);
  if (expression === undefined || !ts.isTemplateExpression(expression) ||
    expression.head.text !== "meta[name=\"" || expression.templateSpans.length !== 1) return false;
  const span = expression.templateSpans[0];
  return span !== undefined && ts.isIdentifier(span.expression) &&
    span.expression.text === "browserCsrfMetaName" && span.literal.text === "\"]";
};

const approvedSelectorCall = (node: ts.CallExpression, sourceFile: ts.SourceFile): boolean => {
  const key = memberPath(unwrap(node.expression))?.parts.join(".");
  const path = resolve(sourceFile.fileName);
  if (key === "document.getElementById") {
    const declaration = node.parent;
    const argument = node.arguments[0];
    return path === webEntrySource && node.arguments.length === 1 &&
      argument !== undefined && ts.isStringLiteral(argument) && argument.text === "root" &&
      ts.isVariableDeclaration(declaration) && declaration.initializer === node &&
      ts.isIdentifier(declaration.name) && declaration.name.text === "root";
  }
  if (key === "document.querySelector") {
    const access = node.parent;
    return path === webApplicationSource && node.arguments.length === 1 &&
      csrfSelectorArgument(node.arguments[0]) && ts.isPropertyAccessExpression(access) &&
      access.expression === node && access.questionDotToken !== undefined && access.name.text === "content";
  }
  return false;
};

const approvedApplicationRootUse = (node: ts.Identifier, sourceFile: ts.SourceFile): boolean => {
  if (resolve(sourceFile.fileName) !== webEntrySource || node.text !== "root") return false;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.name === node &&
    parent.initializer !== undefined && ts.isCallExpression(unwrap(parent.initializer))) {
    return approvedSelectorCall(unwrap(parent.initializer) as ts.CallExpression, sourceFile);
  }
  if (ts.isBinaryExpression(parent) && parent.left === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    parent.right.kind === ts.SyntaxKind.NullKeyword) return true;
  if (!ts.isCallExpression(parent) || parent.arguments.length !== 1 || parent.arguments[0] !== node) return false;
  const callee = unwrap(parent.expression);
  return ts.isIdentifier(callee) && callee.text === "createRoot";
};

const browserPackageImportViolation = (node: ts.ImportDeclaration, sourceFile: ts.SourceFile): boolean => {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return false;
  const specifier = node.moduleSpecifier.text;
  if (specifier.startsWith(".")) return false;
  const sourcePath = resolve(sourceFile.fileName);
  const allowed = isWithin(webSourceRoot, sourcePath)
    ? allowedWebPackageImports.get(specifier)
    : sharedContractSources.has(sourcePath) && specifier === "zod"
      ? new Set(["ZodRawShape", "ZodType", "z"])
      : sourcePath === canonicalJsonSource && specifier === "@noble/hashes/sha2.js"
        ? new Set(["sha256"])
        : (sourcePath === canonicalJsonSource || sourcePath === keccak256Source) &&
            specifier === "@noble/hashes/utils.js"
          ? new Set(["bytesToHex", "hexToBytes", "utf8ToBytes"])
          : sourcePath === keccak256Source && specifier === "@noble/hashes/sha3.js"
            ? new Set(["keccak_256"])
      : undefined;
  const clause = node.importClause;
  if (allowed === undefined || clause === undefined || clause.name !== undefined ||
    clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => {
    const imported = element.propertyName?.text ?? element.name.text;
    return element.name.text !== imported || !allowed.has(imported);
  });
};

const approvedNavigationHref = (
  checker: ts.TypeChecker,
  attribute: ts.JsxAttribute,
  sourceFile: ts.SourceFile,
): boolean => {
  if (resolve(sourceFile.fileName) !== webApplicationSource ||
    attribute.name.getText(sourceFile) !== "href" ||
    attribute.initializer === undefined || !ts.isJsxExpression(attribute.initializer) ||
    attribute.initializer.expression === undefined) return false;
  const expression = unwrap(attribute.initializer.expression);
  if (!ts.isPropertyAccessExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "browserPagePaths" ||
    (expression.name.text !== "root" && expression.name.text !== "tokens")) return false;
  const declaration = checker.getSymbolAtLocation(expression.expression)?.declarations?.find(ts.isImportSpecifier);
  if (declaration === undefined || declaration.name.text !== "browserPagePaths" ||
    declaration.propertyName !== undefined) return false;
  const imported = declaration.parent.parent.parent;
  return ts.isImportDeclaration(imported) && ts.isStringLiteral(imported.moduleSpecifier) &&
    imported.moduleSpecifier.text === "../browser-contract.js";
};

const approvedObservationStorageCall = (
  checker: ts.TypeChecker,
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): boolean => {
  if (resolve(sourceFile.fileName) !== webApplicationSource) return false;
  const path = memberPath(node.expression)?.parts.join(".");
  const key = node.arguments[0];
  if (key === undefined || ts.isSpreadElement(key)) return false;
  const canonicalKey = unwrap(key);
  if (!ts.isIdentifier(canonicalKey) || canonicalKey.text !== "walletObservationStorageKey") return false;
  const keyDeclaration = checker.getSymbolAtLocation(canonicalKey)?.declarations?.find(ts.isImportSpecifier);
  if (keyDeclaration === undefined || keyDeclaration.name.text !== "walletObservationStorageKey" ||
    keyDeclaration.propertyName !== undefined) return false;
  const keyImport = keyDeclaration.parent.parent.parent;
  if (!ts.isImportDeclaration(keyImport) || !ts.isStringLiteral(keyImport.moduleSpecifier) ||
    keyImport.moduleSpecifier.text !== "./wallet-observation.js") return false;
  if (path === "window.sessionStorage.getItem" || path === "window.sessionStorage.removeItem") {
    return node.arguments.length === 1;
  }
  if (path !== "window.sessionStorage.setItem" || node.arguments.length !== 2) return false;
  const operationId = node.arguments[1];
  if (operationId === undefined || ts.isSpreadElement(operationId)) return false;
  const canonicalOperationId = unwrap(operationId);
  if (!ts.isIdentifier(canonicalOperationId) || canonicalOperationId.text !== "operationId") return false;
  return checker.getSymbolAtLocation(canonicalOperationId)?.declarations?.some((declaration) => {
    if (!ts.isParameter(declaration) || !ts.isIdentifier(declaration.name) ||
      declaration.name.text !== "operationId" || !ts.isArrowFunction(declaration.parent)) return false;
    const property = declaration.parent.parent;
    return ts.isPropertyAssignment(property) && property.initializer === declaration.parent &&
      property.name.getText(sourceFile) === "write";
  }) === true;
};

export const auditBrowserSourceModule = (source: string, pathInput: string): readonly string[] => {
  const path = resolve(pathInput);
  if (path.endsWith(".css")) {
    return browserAssetContentViolation(path, source) !== undefined
      ? Object.freeze([`${path}:unsafe CSS asset content`])
      : Object.freeze([]);
  }
  const { checker, sourceFile } = createAuditedSource(path, source);
  const violations: string[] = [];
  let approvedFetchCount = 0;
  const reject = (node: ts.Node, reason: string): void => {
    violations.push(`${sourceLocation(sourceFile, node)}:${reason}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      if (expression.kind === ts.SyntaxKind.ImportKeyword) reject(node, "dynamic import");
      const pathValue = memberPath(expression);
      const key = pathValue?.parts.join(".");
      const suffix = memberSuffix(expression);
      const member = suffix?.parts.at(-1);
      const fetchApproved = key === "globalThis.fetch" && approvedFetch(node, sourceFile);
      if (fetchApproved) approvedFetchCount += 1;
      if ((key === "document.getElementById" || key === "document.querySelector") &&
        !approvedSelectorCall(node, sourceFile)) reject(node, "unapproved DOM selection");
      if (key === "globalThis.fetch" && !fetchApproved) reject(node, "unapproved fetch");
      if ((key === "window.setTimeout" || key === "globalThis.setTimeout") &&
        !approvedTimerCallback(node)) {
        reject(node, "non-function timer callback");
      }
      if (key === "window.location.reload" && node.arguments.length !== 0) {
        reject(node, "invalid browser bootstrap reload");
      }
      if (key?.startsWith("window.sessionStorage.") === true &&
        !approvedObservationStorageCall(checker, node, sourceFile)) {
        reject(node, "browser storage outside its observation owner");
      }
      if (member !== undefined && restrictedAuthorityCallMembers.has(member) &&
        !fetchApproved &&
        !((key === "window.setTimeout" || key === "globalThis.setTimeout") &&
          approvedTimerCallback(node))) {
        reject(node, "unapproved browser authority call");
      }
      if (member === "setAttribute") {
        const attribute = node.arguments[0];
        const canonicalAttribute = attribute === undefined ? undefined : unwrap(attribute);
        if (canonicalAttribute === undefined || !ts.isStringLiteralLike(canonicalAttribute) ||
          forbiddenJsxAttributes.has(canonicalAttribute.text)) reject(node, "dynamic resource attribute");
      }
      if (member !== undefined && forbiddenDomCallMembers.has(member)) reject(node, "imperative DOM sink");
      if (suffix?.parts.includes("style") === true) reject(node, "imperative style sink");
    }

    if (isMemberExpression(node) && !isMemberPrefix(node)) {
      if (ts.isElementAccessExpression(node) && isWithin(webSourceRoot, path)) {
        reject(node, "computed web member access");
      }
      const value = memberPath(node);
      const root = value?.parts[0];
      const key = value?.parts.join(".");
      if (root !== undefined && browserGlobalRoots.has(root)) {
        if (value?.computed === true || key === undefined || !allowedGlobalMembers.has(key)) {
          reject(node, "unapproved browser global member");
        } else {
          const permittedSources = sensitiveGlobalMemberSources.get(key);
          if (permittedSources !== undefined && !permittedSources.has(path)) {
            reject(node, "browser reflection outside its canonical source");
          }
          const parentIsCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
          if (callableGlobalMembers.has(key) && !parentIsCall) {
            reject(node, "unapproved browser global reference");
          }
          if (isAssignmentTarget(node) && key !== "document.title") reject(node, "browser global mutation");
        }
      }
      const suffix = memberSuffix(node);
      const name = suffix?.parts.at(-1);
      if (suffix?.parts.includes("constructor") === true) {
        reject(node, "dynamic code authority reference");
      }
      if (suffix?.parts.some((part) => forbiddenDerivedAuthorityMembers.has(part)) === true) {
        reject(node, "derived browser authority");
      }
      if (isAssignmentTarget(node) && (
        suffix?.parts.includes("style") === true ||
        name !== undefined && forbiddenAssignedMembers.has(name)
      )) {
        reject(node, "resource, markup, or computed assignment");
      }
      if (name === "createElement") reject(node, "imperative element reference");
    }

    if (ts.isStringLiteralLike(node) && node.text === "constructor" &&
      (ts.isElementAccessExpression(node.parent) || ts.isBindingElement(node.parent))) {
      reject(node, "dynamic code authority name");
    }

    if (ts.isIdentifier(node)) {
      if (node.text === "constructor") reject(node, "dynamic code authority name");
      if (isBindingIdentifier(node) && protectedRuntimeBindings.has(node.text)) {
        reject(node, `protected runtime binding ${node.text}`);
      }
      if (!isPropertyName(node) && !isWithinTypePosition(node)) {
        if (symbolIsDeclaredIn(checker, node, "lib.dom.d.ts") &&
          !allowedDomRuntimeIdentifiers.has(node.text) &&
          !(path === evidenceSource && node.text === "URL")) {
          reject(node, `unapproved DOM runtime global ${node.text}`);
        }
        if (node.text === "root" && resolve(sourceFile.fileName) === webEntrySource &&
          !approvedApplicationRootUse(node, sourceFile)) reject(node, "unapproved application root use");
        if (forbiddenGlobalIdentifiers.has(node.text)) reject(node, `forbidden browser global ${node.text}`);
        if (browserGlobalRoots.has(node.text) && !isMemberExpression(node.parent)) {
          reject(node, `unapproved browser global ${node.text}`);
        }
      }
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === "react/jsx-runtime" ||
        node.moduleSpecifier.text === "react/jsx-dev-runtime") reject(node, "direct JSX runtime import");
      if (browserPackageImportViolation(node, sourceFile)) reject(node, "unapproved browser package import");
    }

    if (ts.isNewExpression(node) && isWithin(webSourceRoot, path)) {
      const expression = unwrap(node.expression);
      if (!approvedConstructorBinding(checker, sourceFile, expression)) {
        reject(node, "unapproved browser constructor");
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      const intrinsic = tag[0] === tag[0]?.toLowerCase();
      if (intrinsic && !allowedIntrinsicElements.has(tag)) {
        reject(node, `unapproved intrinsic element ${tag}`);
      }
      for (const property of intrinsic ? node.attributes.properties : []) {
        if (ts.isJsxSpreadAttribute(property)) reject(property, "spread intrinsic attributes");
        else {
          const attributeName = property.name.getText(sourceFile);
          if (!allowedIntrinsicAttributes.has(attributeName)) {
            reject(property, `unapproved intrinsic attribute ${attributeName}`);
          } else if (attributeName === "href" && !approvedNavigationHref(checker, property, sourceFile)) {
            reject(property, "unapproved navigation target");
          } else if (forbiddenJsxAttributes.has(attributeName)) {
            reject(property, `resource attribute ${attributeName}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (path === browserClientSource && approvedFetchCount !== 1) {
    violations.push(`${path}:expected one canonical browser fetch bridge`);
  }
  return Object.freeze(violations);
};

export const browserBuildPolicyPlugin = (): Plugin => ({
  name: "littlejohn-browser-build-policy",
  enforce: "pre",
  async generateBundle(_options, bundle) {
    const moduleIds = new Set<string>();
    for (const output of Object.values(bundle)) {
      if (output.type === "chunk") {
        for (const moduleId of Object.keys(output.modules)) moduleIds.add(moduleId);
      }
    }
    for (const moduleId of moduleIds) {
      const violation = browserModulePolicyViolation(moduleId);
      if (violation !== undefined) this.error(`Browser module is outside the build policy: ${violation}`);
      const path = withoutQuery(moduleId);
      const extension = extname(path);
      if (!isAbsolute(path) || isWithin(nodeModulesRoot, path) ||
        (!codeSourceExtensions.has(extension) && extension !== ".css")) continue;
      const violations = auditBrowserSourceModule(await readFile(path, "utf8"), path);
      if (violations.length !== 0) this.error(`Browser source violates the build policy: ${violations[0]}`);
    }
  },
});
