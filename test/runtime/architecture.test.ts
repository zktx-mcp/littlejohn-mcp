import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as runtimePublic from "../../src/runtime/index.js";
import {
  collectProductCodeSourceFiles,
  collectProductSourceFiles,
  collectSourceFiles,
  createIsolatedProductSourceProgram,
  createProductSourceProgram,
  createPackageImportPolicy,
  directCodeExecutionViolations,
  inspectModuleImports,
  inspectSourceFile,
  loadPackageManifest,
  moduleImportPolicyViolations,
  programModuleExportSymbol as moduleExportSymbol,
  protectedModuleAccessViolations,
  resolveProgramSymbol as resolvedSymbol,
  uniswapV2SdkLoadBoundaryViolations,
} from "./import-audit.js";

const repositoryRoot = resolve(".");
const sourceRoot = resolve(repositoryRoot, "src");
const uniswapV2SdkFile = resolve(sourceRoot, "protocols/uniswap-v2/sdk.ts");
const testRoot = resolve(repositoryRoot, "test");
const coreRoot = resolve("src/core");
const tokenCatalogRoot = resolve(sourceRoot, "token-catalog");
const interfaceConsumerRoots = Object.freeze([
  resolve(sourceRoot, "interfaces"),
  resolve(repositoryRoot, "scripts/release"),
]);
const interfaceConsumerEntryPoints = new Set([
  resolve(sourceRoot, "cli.ts"),
]);
const clientCoreConsumers = new Set([
  "account-assets/balance-capability.ts", "account-assets/balance-contract.ts", "account-assets/balance-evidence.ts",
  "chain/read-contracts.ts", "chain/evidence.ts", "chain/evidence-fragments.ts",
  "evm/address-input.ts", "evm/address-target.ts", "evm/amounts.ts", "evm/capability.ts", "evm/erc20-events.ts",
  "evm/evidence-replay.ts", "evm/evidence.ts", "evm/identities.ts", "evm/numeric-display.ts", "evm/primitives.ts",
  "evm/read-evidence.ts", "evm/token-standards.ts", "evm/transaction-request.ts",
  "intelligence/analysis-contract.ts", "intelligence/analysis-evidence.ts",
  "registry/product-assets.ts", "registry/validated-input-evidence.ts",
  "wallet/connection-capability.ts", "wallet/connection-contract.ts", "wallet/connection-evidence.ts",
  "interfaces/stock-token-price-presentation.ts",
  "stock-token-prices/contracts.ts",
  "stock-token-prices/capability-evidence.ts",
  "stock-token-prices/result.ts",
  "stock-token-prices/source-contract.ts",
  "stock-token-prices/numeric.ts",
  "protocols/pool-price-contract.ts",
  "protocols/uniswap-v3/deployment.ts",
  "interfaces/signing-presentation.ts",
  "interfaces/mcp-app/view/signing-lifecycle.ts",
  "interfaces/mcp-app/view/card-lifecycle.ts",
  "interfaces/mcp-app/view/tool-result.ts",
  "review/request-context.ts",
  "review/request-errors.ts",
  "review/signing-application-contracts.ts",
  "review/signing-contracts.ts",
  "review/signing-errors.ts",
  "review/signing-payload.ts",
  "intelligence/transaction-contracts.ts",
  "interfaces/exchange-presentation.ts",
  "interfaces/mcp-app/view/transaction-lifecycle.ts",
  "protocols/uniswap-v4/catalog.ts",
  "protocols/uniswap-v4/contract-profile.ts",
  "protocols/uniswap-v4/deployment.ts",
  "protocols/uniswap-v4/effects.ts",
  "protocols/uniswap-v4/event-contract.ts",
  "protocols/uniswap-v4/identity.ts",
  "protocols/uniswap-v4/parameters.ts",
  "protocols/uniswap-v4/pools.ts",
  "protocols/uniswap-v4/values.ts",
  "receipt-activity/admission.ts",
  "receipt-activity/application-contracts.ts",
  "receipt-activity/contracts.ts",
  "receipt-activity/data.ts",
  "registry/native-asset.ts",
  "review/action-contracts.ts",
  "review/application-contracts.ts",
  "review/contracts.ts",
  "review/errors.ts",
  "review/evidence.ts",
  "review/exchange.ts",
  "review/material-port.ts",
  "review/observation-contract.ts",
  "review/observation.ts",
  "review/pending-contract.ts",
  "review/presentation-contract.ts",
  "review/replacement-contract.ts",
  "review/request-reference.ts",
  "review/response-contract.ts",
  "wallet/request-contract.ts",

  "account-assets/client.ts",
  "account-assets/contracts.ts",
  "account-assets/view.ts",
  "chain/error-registry.ts",
  "interfaces/mcp-app/contracts.ts",
  "interfaces/mcp-app/card-contract.ts",
  "interfaces/mcp-app/registry.ts",
  "interfaces/mcp-app/view/codex-operation-result-adapter.ts",
  "interfaces/mcp-app/view/creating-tool-error.ts",
  "interfaces/mcp-app/view/lifecycle.ts",
  "interfaces/mcp-app/view/operation-lifecycle.ts",
  "interfaces/mcp-app/view/renderers.ts",
  "interfaces/operation-delivery.ts",
  "stock-token-trade-history/contracts.ts",
  "stock-token-trade-history/capability-evidence.ts",
  "stock-token-trade-history/period-contract.ts",
  "stock-token-trade-history/result.ts",
  "stock-token-trade-history/source-semantics.ts",
  "protocols/contracts.ts",
  "protocols/registry.ts",
  "protocols/uniswap-v2/contracts.ts",
  "protocols/uniswap-v2/deployment.ts",
  "protocols/uniswap-v2/evidence.ts",
  "protocols/uniswap-v2/quote.ts",
  "registry/official-asset-contract.ts",
  "registry/error-registry.ts",
  "wallet/session-requirements.ts",
  "registry/default-stock-tokens.ts",
  "runtime/error-definitions.ts",
  "runtime/error-registry.ts",
  "runtime/http-limits.ts",
  "runtime/presentation-snapshot.ts",
  "token-catalog/contract-schema.ts",
  "token-catalog/error-registry.ts",
  "wallet/error-registry.ts",
  "wallet/management-contracts.ts",
  "wallet/operation-contract.ts",
]);
const clientTokenCatalogConsumers = new Set([
  resolve(sourceRoot, "interfaces/mcp-app/registry.ts"),
  resolve(sourceRoot, "interfaces/mcp-app/view/operation-lifecycle.ts"),
  resolve(sourceRoot, "interfaces/mcp-app/view/renderers.ts"),
]);
const directTokenCatalogContractConsumers = new Set([
  resolve(sourceRoot, "interfaces/operation-tool-contracts.ts"),
]);
const runtimeEntryPoint = resolve(sourceRoot, "runtime/index.ts");
const runtimeComposition = resolve(sourceRoot, "runtime/composition.ts");

const loadPackagePolicy = async () => {
  const [manifest, sourceFiles] = await Promise.all([
    loadPackageManifest(),
    collectProductSourceFiles(repositoryRoot),
  ]);
  return createPackageImportPolicy(manifest, repositoryRoot, sourceFiles);
};

const resolvesInsideCore = (file: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  let target: string;
  try { target = fileURLToPath(new URL(specifier, pathToFileURL(file))); }
  catch { return "invalid"; }
  const fromCore = relative(coreRoot, target);
  const inside = fromCore === "" || (!isAbsolute(fromCore) && fromCore !== ".." && !fromCore.startsWith(`..${sep}`));
  return inside ? fromCore.split(sep).join("/") : undefined;
};

const isWithin = (file: string, directory: string): boolean => {
  const fromDirectory = relative(directory, file);
  return fromDirectory === "" || (!isAbsolute(fromDirectory) && fromDirectory !== ".." &&
    !fromDirectory.startsWith(`..${sep}`));
};

const resolveSourceModule = (file: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  try {
    const target = fileURLToPath(new URL(specifier, pathToFileURL(file)));
    return target.endsWith(".js") ? `${target.slice(0, -3)}.ts` : target;
  } catch {
    return undefined;
  }
};

const sourceDescendants = (root: ts.Node): readonly ts.Node[] => {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
};

const parseSource = async (path: string): Promise<ts.SourceFile> =>
  ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);

const addressTargetHandoffViolations = (
  application: string,
  handlers: string,
  composition: string,
): readonly string[] => {
  const parse = (source: string): readonly ts.Node[] => sourceDescendants(
    ts.createSourceFile("owner.ts", source, ts.ScriptTarget.Latest, true),
  );
  const path = (node: ts.Node | undefined, names: readonly string[]): boolean => {
    if (node === undefined) return false;
    if (names.length === 1) return ts.isIdentifier(node) && node.text === names[0];
    return ts.isPropertyAccessExpression(node) && node.name.text === names.at(-1) &&
      path(node.expression, names.slice(0, -1));
  };
  const property = (node: ts.Node | undefined, name: string): ts.Expression | undefined => {
    if (node === undefined || !ts.isObjectLiteralExpression(node)) return undefined;
    const matches = node.properties.filter((entry) =>
      (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) &&
      ts.isIdentifier(entry.name) && entry.name.text === name);
    if (matches.length !== 1 || node.properties.some(ts.isSpreadAssignment)) return undefined;
    const entry = matches[0]!;
    return ts.isPropertyAssignment(entry) ? entry.initializer :
      ts.isShorthandPropertyAssignment(entry) ? entry.name : undefined;
  };
  const calls = (nodes: readonly ts.Node[], names: readonly string[]): ts.CallExpression[] =>
    nodes.filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && path(node.expression, names));
  const ownsProperty = (nodes: readonly ts.Node[], key: string, names: readonly string[]): boolean => {
    const objects = nodes.filter((node) => property(node, key) !== undefined);
    return objects.length !== 0 && objects.every((node) => path(property(node, key), names));
  };
  const app = parse(application);
  const handler = parse(handlers);
  const runtime = parse(composition);
  const violations: string[] = [];
  const constructions = calls(app, ["createAddressTargetResolver"]);
  const assignments = app.filter((node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) && path(node.left, ["addressTargets"]) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken);
  if (constructions.length !== 1 || assignments.length !== 1 ||
    assignments[0]?.right !== constructions[0]) violations.push("resolver_construction");
  const services = calls(app, ["createChainReadService"]);
  if (services.length !== 1 ||
    !path(property(services[0]?.arguments[0], "addressTargets"), ["addressTargets"])) {
    violations.push("handler_handoff");
  }
  const returns = app.filter(ts.isReturnStatement).flatMap((node) =>
    node.expression !== undefined && ts.isCallExpression(node.expression) &&
      path(node.expression.expression, ["Object", "freeze"])
      ? [node.expression.arguments[0]!] : []);
  if (!ownsProperty(returns, "addressTargets", ["addressTargets"])) {
    violations.push("application_handoff");
  }
  const resolutions = calls(handler, ["input", "addressTargets", "resolve"]);
  const resolvedObjects = handler.filter((node) => {
    const target = property(node, "addressTarget");
    if (target === undefined) return false;
    const rawStatus = ts.isCallExpression(target) && path(target.expression, ["Object", "freeze"])
      ? property(target.arguments[0], "status") : undefined;
    const status = rawStatus === undefined ? undefined : unwrapStaticStringExpression(rawStatus);
    return status === undefined || !ts.isStringLiteral(status) || status.text !== "not_required";
  });
  if (resolutions.length !== 1 || resolutions[0]?.arguments.length !== 1 ||
    !path(resolutions[0]?.arguments[0], ["target"]) ||
    !ownsProperty(resolvedObjects, "addressTarget", ["resolution"])) {
    violations.push("handler_resolution");
  }
  if (handler.some((node) => path(node, ["input", "context", "activeWallet"]))) {
    violations.push("handler_wallet_bypass");
  }
  const runtimeBindings = runtime.filter((node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && path(node.name, ["addressTargets"]));
  const handoffBody = runtimeBindings[0]?.parent.parent.parent;
  if (runtimeBindings.length !== 1 ||
    !path(runtimeBindings[0]?.initializer, ["application", "addressTargets"]) ||
    handoffBody === undefined || !ts.isBlock(handoffBody) ||
    !ownsProperty(sourceDescendants(handoffBody), "addressTargets", ["addressTargets"])) {
    violations.push("runtime_handoff");
  }
  return violations;
};


const addressTargetConsumptionViolations = (program: ts.Program): readonly string[] => {
  const checker = program.getTypeChecker();
  const ownerFile = resolve(sourceRoot, "chain/address-target.ts");
  const available = moduleExportSymbol(program, checker, ownerFile, "requireAvailableAddressTarget");
  const equality = moduleExportSymbol(program, checker, ownerFile, "sameResolvedAddressTarget");
  const factory = moduleExportSymbol(program, checker, ownerFile, "createAddressTargetResolver");
  if (available === undefined || equality === undefined || factory === undefined) {
    return ["address_target_exports"];
  }
  const symbol = (node: ts.Node): ts.Symbol | undefined => resolvedSymbol(
    checker,
    ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node),
  );
  const called = (node: ts.CallExpression, expected: ts.Symbol): boolean =>
    symbol(unwrapStaticStringExpression(node.expression)) === expected;
  const enclosingFunction = (node: ts.Node): ts.FunctionLikeDeclaration | undefined => {
    for (let current = node.parent; current !== undefined; current = current.parent) {
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current) ||
        ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) return current;
    }
    return undefined;
  };
  const functionName = (node: ts.FunctionLikeDeclaration | undefined): string => {
    if (node === undefined) return "<missing>";
    if (node.name !== undefined) return node.name.getText();
    return ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : "<anonymous>";
  };
  const outerExpression = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (ts.isExpression(current.parent) &&
      unwrapStaticStringExpression(current.parent) === current) current = current.parent;
    return current;
  };
  const resolverCall = (call: ts.CallExpression): boolean => {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    return declaration !== undefined && ts.isMethodSignature(declaration) &&
      declaration.name.getText() === "resolve" &&
      resolve(declaration.getSourceFile().fileName) === ownerFile &&
      ts.isInterfaceDeclaration(declaration.parent) &&
      declaration.parent.name.text === "AddressTargetResolverPort";
  };
  const consumed = (call: ts.CallExpression): boolean => {
    const outer = outerExpression(call);
    const parent = outer.parent;
    if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === outer)) return true;
    if (!ts.isVariableDeclaration(parent) || parent.initializer !== outer) return false;
    const bindings = sourceDescendants(parent.name).filter(ts.isIdentifier);
    const bindingSymbols = new Set(bindings.map(symbol).filter((value) => value !== undefined));
    const scope = enclosingFunction(call)?.body;
    return scope !== undefined && sourceDescendants(scope).some((node) => {
      if (!ts.isIdentifier(node) || node.pos <= parent.end) return false;
      const reference = symbol(node);
      if (reference === undefined || !bindingSymbols.has(reference)) return false;
      const use = node.parent;
      return ts.isReturnStatement(use) || ts.isShorthandPropertyAssignment(use) ||
        (ts.isPropertyAssignment(use) && use.initializer === node) ||
        (ts.isCallExpression(use) && called(use, equality) && use.arguments.includes(node));
    });
  };
  const controlsRejection = (call: ts.CallExpression): boolean => {
    let current: ts.Node = outerExpression(call);
    if (!ts.isPrefixUnaryExpression(current.parent) ||
      current.parent.operator !== ts.SyntaxKind.ExclamationToken) return false;
    current = current.parent;
    while (ts.isParenthesizedExpression(current.parent) || ts.isBinaryExpression(current.parent)) {
      current = current.parent;
    }
    return ts.isIfStatement(current.parent) && current.parent.expression === current &&
      sourceDescendants(current.parent.thenStatement).some(ts.isThrowStatement);
  };
  const requiredAvailability = new Set([
    "chain/handlers.ts:requireInvocationAddressTarget",
    "account-assets/application.ts:resolveTarget",
    "account-assets/application.ts:assertTargetContinuity",
    "token-catalog/application.ts:requireAccountAsset",
    "token-catalog/application.ts:listSelections",
    "token-catalog/coordinator.ts:#resolveTarget",
  ]);
  const requiredComparisons = new Set([
    "account-assets/application.ts:assertTargetContinuity",
    "token-catalog/coordinator.ts:#assertAccountTargetPrecondition",
    "token-catalog/coordinator.ts:#assertReviewPrecondition",
  ]);
  const violations: string[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !isWithin(file.fileName, sourceRoot) ||
      resolve(file.fileName) === ownerFile) continue;
    const name = relative(sourceRoot, file.fileName).split(sep).join("/");
    for (const node of sourceDescendants(file)) {
      if (!ts.isCallExpression(node)) continue;
      const container = enclosingFunction(node);
      const role = `${name}:${functionName(container)}`;
      if (called(node, factory) && name !== "chain/application.ts") {
        violations.push(`${role}:resolver_construction`);
      }
      if (resolverCall(node)) {
        const outer = outerExpression(node);
        const parent = outer.parent;
        const deferredChainCapture = role === "chain/handlers.ts:addressTargetPorts";
        if (!deferredChainCapture && (!ts.isCallExpression(parent) ||
          !called(parent, available) || parent.arguments[0] !== outer)) {
          violations.push(`${role}:resolution_without_admission`);
        }
      }
      if (called(node, available)) {
        requiredAvailability.delete(role);
        const input = node.arguments[0] === undefined
          ? undefined : unwrapStaticStringExpression(node.arguments[0]);
        const chainOutcome = role === "chain/handlers.ts:requireInvocationAddressTarget";
        const parameter = container?.parameters[0]?.name;
        const validInput = node.arguments.length === 1 && input !== undefined &&
          (chainOutcome
            ? parameter !== undefined && symbol(input) === symbol(parameter)
            : ts.isCallExpression(input) && resolverCall(input));
        if (!validInput) violations.push(`${role}:shared_input`);
        if (!consumed(node)) violations.push(`${role}:shared_result_discarded`);
        if (chainOutcome) {
          const body = container?.body;
          const gate = body !== undefined && ts.isBlock(body) ? body.statements[0] : undefined;
          const condition = gate !== undefined && ts.isIfStatement(gate) ? gate.expression : undefined;
          const left = condition !== undefined && ts.isBinaryExpression(condition)
            ? unwrapStaticStringExpression(condition.left) : undefined;
          const right = condition !== undefined && ts.isBinaryExpression(condition)
            ? unwrapStaticStringExpression(condition.right) : undefined;
          if (body === undefined || !ts.isBlock(body) || body.statements.length !== 2 ||
            gate === undefined || !ts.isIfStatement(gate) || gate.elseStatement !== undefined ||
            condition === undefined || !ts.isBinaryExpression(condition) ||
            condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
            left === undefined || !ts.isPropertyAccessExpression(left) ||
            left.name.text !== "status" || parameter === undefined ||
            symbol(left.expression) !== symbol(parameter) ||
            right === undefined || !ts.isStringLiteral(right) || right.text !== "not_required" ||
            !ts.isReturnStatement(body.statements[1]!) ||
            body.statements[1].expression !== outerExpression(node)) {
            violations.push(`${role}:local_interpretation`);
          }
        }
      }
      if (called(node, equality)) {
        requiredComparisons.delete(role);
        const initialIndex = role.endsWith(":#assertReviewPrecondition") ? 0 : 1;
        const initial = container?.parameters[initialIndex]?.name;
        const fresh = container?.body === undefined ? [] : sourceDescendants(container.body)
          .filter((entry): entry is ts.VariableDeclaration => {
            if (!ts.isVariableDeclaration(entry) || entry.initializer === undefined) return false;
            const expression = unwrapStaticStringExpression(entry.initializer);
            if (!ts.isCallExpression(expression)) return false;
            if (called(expression, available)) return true;
            const declaration = checker.getResolvedSignature(expression)?.declaration;
            return declaration !== undefined && ts.isMethodDeclaration(declaration) &&
              declaration.name.getText() === "#resolveTarget" &&
              ts.isClassDeclaration(declaration.parent) &&
              declaration.parent.name?.text === "TokenCatalogCoordinator" &&
              resolve(declaration.getSourceFile().fileName) ===
                resolve(sourceRoot, "token-catalog/coordinator.ts");
          });
        const left = node.arguments[0];
        const right = node.arguments[1];
        if (initial === undefined || fresh.length !== 1 || left === undefined || right === undefined ||
          symbol(unwrapStaticStringExpression(left)) !== symbol(initial) ||
          symbol(unwrapStaticStringExpression(right)) !== symbol(fresh[0]!.name)) {
          violations.push(`${role}:comparison_input`);
        }
        if (node.arguments.length !== 2 || !controlsRejection(node)) {
          violations.push(`${role}:comparison_not_consumed`);
        }
      }
    }
  }
  for (const role of requiredAvailability) violations.push(`${role}:missing_available_owner`);
  for (const role of requiredComparisons) violations.push(`${role}:missing_comparison_owner`);
  return violations.sort();
};

const accountCollectionLifecycleViolations = (source: string): readonly string[] => {
  const parsed = ts.createSourceFile("account-assets/application.ts", source, ts.ScriptTarget.Latest, true);
  const nodes = sourceDescendants(parsed);
  const violations: string[] = [];
  const calls = (root: ts.Node, name: string): ts.CallExpression[] => sourceDescendants(root)
    .filter((node): node is ts.CallExpression => ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) && node.expression.text === name);
  const preparation = calls(parsed, "prepareCollection");
  const awaited = preparation[0]?.parent;
  const declaration = awaited?.parent;
  const statement = declaration?.parent.parent;
  const block = statement?.parent;
  if (preparation.length !== 1 || awaited === undefined || !ts.isAwaitExpression(awaited) ||
    declaration === undefined || !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) || declaration.name.text !== "prepared" ||
    statement === undefined || !ts.isVariableStatement(statement) ||
    block === undefined || !ts.isBlock(block)) {
    violations.push("preparation_order");
  } else {
    const index = block.statements.indexOf(statement);
    const gate = block.statements[index + 1];
    const publication = block.statements[index + 2];
    const stop = gate !== undefined && ts.isExpressionStatement(gate) ? gate.expression : undefined;
    if (stop === undefined || !ts.isCallExpression(stop) ||
      !ts.isIdentifier(stop.expression) || stop.expression.text !== "ensureNotAborted" ||
      stop.arguments.length !== 2 || !ts.isIdentifier(stop.arguments[0]!) ||
      stop.arguments[0].text !== "caller" ||
      !ts.isPropertyAccessExpression(stop.arguments[1]!) ||
      !ts.isIdentifier(stop.arguments[1].expression) ||
      stop.arguments[1].expression.text !== "ownerAbort" || stop.arguments[1].name.text !== "signal") {
      violations.push("final_abort_gate");
    }
    if (publication === undefined || !ts.isReturnStatement(publication) ||
      publication.expression === undefined || !ts.isCallExpression(publication.expression) ||
      !ts.isIdentifier(publication.expression.expression) ||
      publication.expression.expression.text !== "finalizeCollection" ||
      publication !== block.statements.at(-1)) violations.push("synchronous_publication");
  }
  const finalizers = nodes.filter((node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "finalizeCollection");
  const initializer = finalizers[0]?.initializer;
  if (finalizers.length !== 1 || initializer === undefined || !ts.isArrowFunction(initializer)) {
    violations.push("finalization_owner");
  } else {
    const finalNodes = sourceDescendants(initializer.body);
    if (finalNodes.some(ts.isAwaitExpression) || calls(initializer.body, "ensureNotAborted").length !== 0) {
      violations.push("post_effect_stop");
    }
    const commits = finalNodes.filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "initializeDefaults");
    if (commits.length !== 1) violations.push("default_commit_owner");
    const commit = commits[0];
    if (commit !== undefined) {
      const rootIdentifier = (expression: ts.Expression): ts.Expression =>
        ts.isPropertyAccessExpression(expression) ? rootIdentifier(expression.expression) : expression;
      const afterCommit = finalNodes.filter((node): node is ts.CallExpression =>
        ts.isCallExpression(node) && node.pos >= commit.end);
      if (afterCommit.some((node) => {
        const root = rootIdentifier(node.expression);
        return ts.isIdentifier(root) && root.text === "dependencies";
      })) violations.push("post_commit_dependency");
    }
  }
  return violations;
};

const runtimeResetCreatorName = "createRuntimeStateResetRequiredError";
const runtimeResetSourceErrorName = "RuntimeStateResetRequiredSourceError";
const runtimeSqliteSchemaPath = resolve(sourceRoot, "runtime/sqlite-schema.ts");
const runtimeDatabasePath = resolve(sourceRoot, "runtime/database.ts");
const mcpAppContractsPath = resolve(sourceRoot, "interfaces/mcp-app/contracts.ts");
const walletOperationContractPath = resolve(sourceRoot, "wallet/operation-contract.ts");
const tokenCatalogContractPath = resolve(sourceRoot, "token-catalog/contract-schema.ts");

const unwrapStaticStringExpression = (expression: ts.Expression): ts.Expression => {
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

const staticStringValue = (
  expression: ts.Expression,
  checker: ts.TypeChecker,
  resolving: ReadonlySet<ts.Symbol> = new Set(),
): string | undefined => {
  const current = unwrapStaticStringExpression(expression);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isNumericLiteral(current)) return String(Number(current.text));
  if (ts.isPropertyAccessExpression(current)) {
    const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(current.name));
    const roots = symbol === undefined ? [] : checker.getRootSymbols(symbol);
    const declaration = roots.length === 1 ? roots[0]?.valueDeclaration : undefined;
    if (declaration !== undefined && ts.isPropertyAssignment(declaration)) {
      return staticStringValue(declaration.initializer, checker, resolving);
    }
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(current.left, checker, resolving);
    const right = staticStringValue(current.right, checker, resolving);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    for (const span of current.templateSpans) {
      const resolved = staticStringValue(span.expression, checker, resolving);
      if (resolved === undefined) return undefined;
      value += resolved + span.literal.text;
    }
    return value;
  }
  if (!ts.isIdentifier(current)) return undefined;
  const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(current));
  if (symbol === undefined || resolving.has(symbol)) return undefined;
  const declaration = symbol.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) return undefined;
  return staticStringValue(
    declaration.initializer,
    checker,
    new Set([...resolving, symbol]),
  );
};

// This audit classifies statement effects and order. Scalar byte admission is
// independently exercised against native SQL in storage tests.
const staticSqlStatement = (
  expression: ts.Expression,
  checker: ts.TypeChecker,
  resolving: ReadonlySet<ts.Symbol> = new Set(),
): string | undefined => {
  const literal = staticStringValue(expression, checker);
  if (literal !== undefined) return literal;
  const current = unwrapStaticStringExpression(expression);
  if (ts.isIdentifier(current)) {
    const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(current));
    const declaration = symbol?.valueDeclaration;
    if (symbol === undefined || resolving.has(symbol) || declaration === undefined ||
      !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
    return staticSqlStatement(declaration.initializer, checker, new Set([...resolving, symbol]));
  }
  if (ts.isTemplateExpression(current)) {
    let sql = current.head.text;
    for (const span of current.templateSpans) {
      const part = staticSqlStatement(span.expression, checker, resolving);
      if (part === undefined) return undefined;
      sql += part + span.literal.text;
    }
    return sql;
  }
  if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) &&
    current.expression.name.text === "projection") {
    const declaration = resolvedSymbol(checker,
      checker.getSymbolAtLocation(current.expression.expression))?.valueDeclaration;
    if (declaration === undefined || declaration.getSourceFile().fileName !== runtimeDatabasePath ||
      !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined ||
      !ts.isCallExpression(declaration.initializer)) return undefined;
    const factory = declaration.initializer;
    if (!ts.isIdentifier(factory.expression) ||
      !["boundedSqlText", "boundedSqlBlob", "sqlInteger"].includes(factory.expression.text)) return undefined;
    const column = factory.arguments[0] === undefined ? undefined : staticStringValue(factory.arguments[0], checker);
    const alias = factory.arguments[1] === undefined ? undefined : staticStringValue(factory.arguments[1], checker);
    const qualifier = current.arguments[0] === undefined ? "" : staticStringValue(current.arguments[0], checker);
    if (column === undefined || !/^[a-z][a-z0-9_]*$/u.test(column) ||
      alias === undefined || !/^[a-z][a-zA-Z0-9]*$/u.test(alias) ||
      qualifier === undefined || (qualifier !== "" && !/^[a-z][a-z0-9_]*$/u.test(qualifier))) return undefined;
    return `${qualifier === "" ? "" : `${qualifier}.`}${column} AS ${alias}`;
  }
  return undefined;
};

const tokenSelectionWriteOrderViolations = (program: ts.Program): readonly string[] => {
  const source = program.getSourceFile(runtimeDatabasePath);
  if (source === undefined) return ["selection_writer_missing"];
  const methods = sourceDescendants(source).filter((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "applyTokenSelectionChange");
  if (methods.length !== 1 || methods[0]!.body === undefined) return ["selection_writer_missing"];
  const method = methods[0]!;
  const nodes = sourceDescendants(method.body!);
  const checker = program.getTypeChecker();
  const violations = new Set<string>();
  const contains = (outer: ts.Node, inner: ts.Node): boolean => outer.pos <= inner.pos && inner.end <= outer.end;
  const addCondition = (expression: ts.Expression): boolean | undefined => {
    const value = unwrapStaticStringExpression(expression);
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (!ts.isBinaryExpression(value) || value.left.getText(source) !== "action.review.kind" ||
      !ts.isStringLiteral(value.right) || !["add", "remove"].includes(value.right.text)) return undefined;
    const equal = value.right.text === "add";
    return value.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal :
      value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ? !equal : undefined;
  };
  const appliesToAdd = (node: ts.Node, dependent?: ts.Node): boolean => {
    for (let parent = node.parent; parent !== undefined && parent !== method; parent = parent.parent) {
      if (ts.isIfStatement(parent)) {
        const thenBranch = contains(parent.thenStatement, node);
        const known = addCondition(parent.expression);
        if (known !== undefined && thenBranch !== known) return false;
        const branch = thenBranch ? parent.thenStatement : parent.elseStatement;
        if (known === undefined && dependent !== undefined &&
          (branch === undefined || !contains(branch, dependent))) return false;
      } else if (dependent !== undefined && (
        ts.isForStatement(parent) || ts.isForOfStatement(parent) || ts.isForInStatement(parent) ||
        ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isCaseClause(parent) ||
        ts.isDefaultClause(parent) || ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)
      ) && !contains(parent, dependent)) return false;
    }
    return true;
  };
  const preparedSql = (expression: ts.Expression, seen = new Set<ts.Symbol>()): string | undefined => {
    const value = unwrapStaticStringExpression(expression);
    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) &&
      value.expression.name.text === "prepare" && value.arguments[0] !== undefined) {
      return staticSqlStatement(value.arguments[0], checker);
    }
    if (!ts.isIdentifier(value)) return undefined;
    const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(value));
    const declaration = symbol?.valueDeclaration;
    if (symbol === undefined || seen.has(symbol) || declaration === undefined ||
      !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined;
    return preparedSql(declaration.initializer, new Set([...seen, symbol]));
  };
  const guardsFor = (bytes: string, limit: string): readonly ts.IfStatement[] => {
    const checksLimit = (expression: ts.Expression): boolean => {
      const value = unwrapStaticStringExpression(expression);
      if (!ts.isBinaryExpression(value)) return false;
      if (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return (addCondition(value.left) === true && checksLimit(value.right)) ||
          (checksLimit(value.left) && addCondition(value.right) === true);
      }
      return value.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
        value.left.getText(source) === `${bytes}.length` && value.right.getText(source) === limit;
    };
    return nodes.filter((node): node is ts.IfStatement => {
      if (!ts.isIfStatement(node) || !checksLimit(node.expression)) return false;
      const statements = ts.isBlock(node.thenStatement) ? node.thenStatement.statements : [node.thenStatement];
      const thrown = statements.length === 1 && ts.isThrowStatement(statements[0]!) ? statements[0]!.expression : undefined;
      return thrown !== undefined && ts.isNewExpression(thrown) &&
        thrown.expression.getText(source) === "TokenCatalogOperationError" &&
        thrown.arguments?.[0] !== undefined && staticStringValue(thrown.arguments[0], checker) === "result_too_large";
    });
  };
  const cacheGuards = guardsFor("bytes", "tokenInspectionPersistenceLimits.resultBytes");
  const operationGuards = guardsFor("operationBytes", "persistedOperationJsonLimits.tokenSelectionBytes");
  const writes: ts.CallExpression[] = [];
  const reads: Array<Readonly<{ node: ts.CallExpression; sql: string }>> = [];
  for (const node of nodes) {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !appliesToAdd(node)) continue;
    const operation = node.expression.name.text;
    if (!["run", "all", "get", "exec"].includes(operation)) continue;
    const sql = operation === "exec" && node.arguments[0] !== undefined
      ? staticStringValue(node.arguments[0], checker) : preparedSql(node.expression.expression);
    if (sql === undefined || /;\s*\S/u.test(sql)) { violations.add("selection_sql_unclassified"); continue; }
    if (/^\s*SELECT\b/iu.test(sql)) reads.push({ node, sql });
    else if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql)) writes.push(node);
    else violations.add("selection_sql_unclassified");
  }
  if (writes.length === 0) violations.add("selection_writes_missing");
  for (const [name, guards] of [["cache", cacheGuards], ["operation", operationGuards]] as const) {
    if (writes.some((write) => !guards.some((guard) => guard.end < write.pos && appliesToAdd(guard, write)))) {
      violations.add(`${name}_size_before_write`);
    }
  }
  const duplicate = reads.find(({ sql }) => /FROM token_selection_operation\b/iu.test(sql));
  const activeState = nodes.find((node) => ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "assertCurrentWalletConnection");
  const firstGuard = [...cacheGuards, ...operationGuards].sort((a, b) => a.pos - b.pos)[0];
  if (duplicate === undefined || activeState === undefined || firstGuard === undefined ||
    !(duplicate.node.end < activeState.pos && activeState.end < firstGuard.pos)) {
    violations.add("selection_admission_precedence");
  }
  return [...violations].sort();
};

interface SqlitePragmaAudit {
  readonly commands: readonly Readonly<{ file: string; command: string }>[];
  readonly userVersionExpressions: readonly Readonly<{
    file: string;
    kind: ts.SyntaxKind;
    value: string;
  }>[];
  readonly violations: readonly string[];
}

const sqlitePragmaAudit = (program: ts.Program): SqlitePragmaAudit => {
  const checker = program.getTypeChecker();
  const databaseSource = program.getSourceFile(runtimeDatabasePath);
  const canonicalCall = databaseSource === undefined
    ? undefined
    : sourceDescendants(databaseSource).find((node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "pragma" &&
      node.getText(databaseSource) === 'database.pragma("user_version = 1")');
  const pragmaSymbol = canonicalCall === undefined || !ts.isPropertyAccessExpression(canonicalCall.expression)
    ? undefined
    : resolvedSymbol(checker, checker.getSymbolAtLocation(canonicalCall.expression.name));
  if (databaseSource === undefined || canonicalCall === undefined || pragmaSymbol === undefined) {
    return Object.freeze({
      commands: Object.freeze([]),
      userVersionExpressions: Object.freeze([]),
      violations: Object.freeze(["sqlite_pragma_authority_unavailable"]),
    });
  }

  const commands: Array<Readonly<{ file: string; command: string }>> = [];
  const userVersionExpressions: Array<Readonly<{
    file: string;
    kind: ts.SyntaxKind;
    value: string;
  }>> = [];
  const violations: string[] = [];
  const report = (sourceFile: ts.SourceFile, kind: string): void => {
    violations.push(`${relative(repositoryRoot, sourceFile.fileName).split(sep).join("/")}:${kind}`);
  };
  const accessPragmaSymbol = (
    access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): ts.Symbol | undefined => {
    const accessedName = ts.isPropertyAccessExpression(access)
      ? access.name.text
      : access.argumentExpression === undefined
        ? undefined
        : staticStringValue(access.argumentExpression, checker);
    if (accessedName !== "pragma") return undefined;
    const direct = ts.isPropertyAccessExpression(access)
      ? checker.getSymbolAtLocation(access.name)
      : access.argumentExpression === undefined
        ? undefined
        : checker.getSymbolAtLocation(access.argumentExpression);
    const resolved = resolvedSymbol(checker, direct);
    if (resolved === pragmaSymbol) return resolved;
    const property = checker.getTypeAtLocation(access.expression).getProperty("pragma");
    return resolvedSymbol(checker, property) === pragmaSymbol ? pragmaSymbol : undefined;
  };
  const pragmaDeclarations = new Set(pragmaSymbol.declarations ?? []);
  const invokesPragma = (call: ts.CallExpression): boolean => {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    return declaration !== undefined && pragmaDeclarations.has(declaration);
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
    return current.parent !== undefined && ts.isCallExpression(current.parent) &&
      current.parent.expression === current;
  };
  const inspectPragmaCall = (sourceFile: ts.SourceFile, call: ts.CallExpression): void => {
    const argument = call.arguments[0];
    const command = argument === undefined ? undefined : staticStringValue(argument, checker);
    if (command === undefined) {
      report(sourceFile, "sqlite_pragma_command_unresolved");
      return;
    }
    const file = relative(repositoryRoot, sourceFile.fileName).split(sep).join("/");
    commands.push(Object.freeze({ file, command }));
    if (command.toLowerCase().includes("user_version") && call !== canonicalCall) {
      report(sourceFile, "sqlite_user_version_operation");
    }
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (!isWithin(sourceFile.fileName, sourceRoot)) continue;
    const file = relative(repositoryRoot, sourceFile.fileName).split(sep).join("/");
    const visit = (node: ts.Node): void => {
      if (ts.isExpression(node)) {
        const value = staticStringValue(node, checker);
        if (value?.toLowerCase().includes("user_version") === true) {
          userVersionExpressions.push(Object.freeze({ file, kind: node.kind, value }));
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrapStaticStringExpression(node.expression);
        if (
          (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
          accessPragmaSymbol(callee) === pragmaSymbol
        ) inspectPragmaCall(sourceFile, node);
        else if (invokesPragma(node)) report(sourceFile, "sqlite_pragma_indirect_call");
      } else if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        accessPragmaSymbol(node) === pragmaSymbol &&
        !isDirectCalleeAccess(node)
      ) {
        report(sourceFile, "sqlite_pragma_method_escape");
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return Object.freeze({
    commands: Object.freeze(commands),
    userVersionExpressions: Object.freeze(userVersionExpressions),
    violations: Object.freeze(violations.sort()),
  });
};

const runtimeResetCreatorViolations = (program: ts.Program): readonly string[] => {
  const checker = program.getTypeChecker();
  const factorySymbol = moduleExportSymbol(
    program,
    checker,
    runtimeSqliteSchemaPath,
    runtimeResetCreatorName,
  );
  const ownerSource = program.getSourceFile(runtimeSqliteSchemaPath);
  const sourceErrorDeclaration = ownerSource?.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === runtimeResetSourceErrorName,
  );
  const sourceErrorSymbol = sourceErrorDeclaration?.name === undefined
    ? undefined
    : checker.getSymbolAtLocation(sourceErrorDeclaration.name);
  if (factorySymbol === undefined || ownerSource === undefined || sourceErrorSymbol === undefined) {
    return ["runtime_reset_owner_unavailable"];
  }

  const violations: string[] = [];
  let factoryDefinitions = 0;
  let factoryCalls = 0;
  let sourceErrorConstructions = 0;
  const report = (sourceFile: ts.SourceFile, kind: string): void => {
    violations.push(`${relative(repositoryRoot, sourceFile.fileName).split(sep).join("/")}:${kind}`);
  };
  const exportsFactory = (symbol: ts.Symbol | undefined): boolean =>
    symbol !== undefined && checker.getExportsOfModule(symbol)
      .some((entry) => resolvedSymbol(checker, entry) === factorySymbol);

  for (const sourceFile of program.getSourceFiles()) {
    if (!isWithin(sourceFile.fileName, sourceRoot)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isExportDeclaration(node) && node.exportClause === undefined &&
        node.moduleSpecifier !== undefined) {
        const moduleSymbol = resolvedSymbol(checker, checker.getSymbolAtLocation(node.moduleSpecifier));
        if (exportsFactory(moduleSymbol)) {
          report(sourceFile, "runtime_reset_factory_wildcard_export");
        }
      }

      if (ts.isNamespaceImport(node)) {
        if (ts.isImportClause(node.parent) && node.parent.isTypeOnly) return;
        const moduleSymbol = resolvedSymbol(checker, checker.getSymbolAtLocation(node.name));
        if (exportsFactory(moduleSymbol)) {
          report(sourceFile, "runtime_reset_factory_namespace_import");
        }
        return;
      }

      if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
        const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(node.name));
        if (symbol === factorySymbol) {
          const importedName = (node.propertyName ?? node.name).text;
          const allowedImport = ts.isImportSpecifier(node) &&
            resolve(sourceFile.fileName) === runtimeDatabasePath &&
            importedName === runtimeResetCreatorName &&
            node.name.text === runtimeResetCreatorName;
          if (!allowedImport) report(sourceFile, "runtime_reset_factory_import_or_export");
        }
        return;
      }

      if (ts.isIdentifier(node)) {
        const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(node));
        if (symbol === factorySymbol) {
          const definition = resolve(sourceFile.fileName) === runtimeSqliteSchemaPath &&
            ts.isVariableDeclaration(node.parent) && node.parent.name === node;
          const directCall = resolve(sourceFile.fileName) === runtimeDatabasePath &&
            ts.isCallExpression(node.parent) && node.parent.expression === node;
          if (definition) factoryDefinitions += 1;
          else if (directCall) factoryCalls += 1;
          else report(sourceFile, "runtime_reset_factory_escape");
        }
        if (symbol === sourceErrorSymbol) {
          const definition = sourceErrorDeclaration !== undefined &&
            sourceErrorDeclaration.name === node;
          const directConstruction = ts.isNewExpression(node.parent) && node.parent.expression === node;
          if (directConstruction) {
            sourceErrorConstructions += 1;
            let current: ts.Node | undefined = node.parent;
            while (current !== undefined && !ts.isVariableDeclaration(current)) current = current.parent;
            if (
              current === undefined ||
              !ts.isVariableDeclaration(current) ||
              !ts.isIdentifier(current.name) ||
              current.name.text !== runtimeResetCreatorName
            ) report(sourceFile, "runtime_reset_source_error_construction");
          } else if (!definition) {
            report(sourceFile, "runtime_reset_source_error_escape");
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  if (factoryDefinitions !== 1) violations.push(`runtime_reset_factory_definitions:${factoryDefinitions}`);
  if (factoryCalls !== 1) violations.push(`runtime_reset_factory_calls:${factoryCalls}`);
  if (sourceErrorConstructions !== 1) {
    violations.push(`runtime_reset_source_error_constructions:${sourceErrorConstructions}`);
  }
  return violations.sort();
};

const runtimeDatabaseAdmissionAuthorityViolations = (
  sourceFile: ts.SourceFile,
): readonly string[] => {
  const violations: string[] = [];
  const descendants = (node: ts.Node): readonly ts.Node[] => sourceDescendants(node);
  const variable = (name: string): ts.VariableDeclaration | undefined =>
    descendants(sourceFile).find((node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
  const callable = (
    declaration: ts.VariableDeclaration | undefined,
  ): ts.ArrowFunction | ts.FunctionExpression | undefined =>
    declaration !== undefined && declaration.initializer !== undefined &&
      (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
      ? declaration.initializer
      : undefined;
  const exactParameters = (
    parameters: readonly ts.ParameterDeclaration[],
    names: readonly string[],
  ): boolean => parameters.length === names.length && parameters.every((parameter, index) =>
    ts.isIdentifier(parameter.name) && parameter.name.text === names[index] &&
    parameter.dotDotDotToken === undefined && parameter.questionToken === undefined &&
    parameter.initializer === undefined);
  const directCalls = (root: ts.Node, name: string): readonly ts.CallExpression[] =>
    descendants(root).filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name);
  const isIdentifierArgument = (
    call: ts.CallExpression,
    index: number,
    name: string,
  ): boolean => call.arguments.length > index && ts.isIdentifier(call.arguments[index]!) &&
    call.arguments[index]!.text === name;
  const leaseAssertions = (root: ts.Node): readonly ts.CallExpression[] =>
    descendants(root).filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.arguments.length === 0 &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "mainLease" &&
      node.expression.name.text === "assertCurrent");
  const isShorthand = (node: ts.ObjectLiteralExpression, name: string): boolean =>
    node.properties.some((property) =>
      ts.isShorthandPropertyAssignment(property) && property.name.text === name);
  const isFrozenObject = (
    expression: ts.Expression | undefined,
    required: readonly string[],
  ): boolean => expression !== undefined && ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "Object" &&
    expression.expression.name.text === "freeze" && expression.arguments.length === 1 &&
    ts.isObjectLiteralExpression(expression.arguments[0]!) &&
    required.every((name) => isShorthand(expression.arguments[0] as ts.ObjectLiteralExpression, name));

  const productDatabase = sourceFile.statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === "ProductDatabase");
  const pathImportSpecifiers = sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "./paths.js" ||
      statement.importClause?.isTypeOnly === true ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) return [];
    return [...statement.importClause.namedBindings.elements];
  });
  const exactLeaseOwnerImports = sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "./paths.js" ||
      statement.importClause?.isTypeOnly === true ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) return [];
    return statement.importClause.namedBindings.elements.filter((element) =>
      !element.isTypeOnly &&
      (element.propertyName?.text ?? element.name.text) === "acquireOwnerOnlyStateFileLease" &&
      element.name.text === "acquireOwnerOnlyStateFileLease");
  });
  if (exactLeaseOwnerImports.length !== 1) {
    violations.push("sqlite_main_lease_owner_import");
  }
  const exactIdentityEqualityImports = pathImportSpecifiers.filter((element) =>
    !element.isTypeOnly &&
    (element.propertyName?.text ?? element.name.text) === "sameOwnerOnlyStateFileIdentity" &&
    element.name.text === "sameOwnerOnlyStateFileIdentity");
  const exactObservationTypeImports = pathImportSpecifiers.filter((element) =>
    element.isTypeOnly &&
    (element.propertyName?.text ?? element.name.text) === "OwnerOnlyStateFileObservation" &&
    element.name.text === "OwnerOnlyStateFileObservation");
  if (exactIdentityEqualityImports.length !== 1 || exactObservationTypeImports.length !== 1) {
    violations.push("sqlite_artifact_identity_owner_import");
  }
  const localIdentityOwners = descendants(sourceFile).filter((node) =>
    (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
      ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
    node.name !== undefined && ts.isIdentifier(node.name) &&
    (node.name.text === "SqliteArtifactIdentity" || node.name.text === "sameArtifactIdentity"));
  if (localIdentityOwners.length !== 0) {
    violations.push("sqlite_artifact_identity_duplicate_owner");
  }
  const lossyIdentityCoercions = descendants(sourceFile).filter((node): node is ts.CallExpression =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Number" &&
    node.arguments.some((argument) => /\.(?:dev|device|ino|inode)\b/u.test(argument.getText(sourceFile))));
  if (lossyIdentityCoercions.length !== 0) {
    violations.push("sqlite_artifact_identity_numeric_coercion");
  }
  const openMethod = productDatabase?.members.find((member): member is ts.MethodDeclaration =>
    ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === "open");
  if (openMethod === undefined) {
    violations.push("product_database_open_missing");
  } else {
    if (!exactParameters(openMethod.parameters, ["path", "nowInput"])) {
      violations.push("product_database_open_signature");
    }
    if (openMethod.parameters.length > 2) {
      violations.push("product_database_caller_selected_authority_parameter");
    }
    const ownedOpenCalls = directCalls(openMethod, "openCurrentDatabase");
    const allOpenCalls = directCalls(sourceFile, "openCurrentDatabase");
    if (ownedOpenCalls.length === 0 || ownedOpenCalls.length !== allOpenCalls.length ||
      ownedOpenCalls.some((call) => call.arguments.length !== 1 ||
        !isIdentifierArgument(call, 0, "path"))) {
      violations.push("product_database_open_current_binding");
    }
  }

  const admissionDeclaration = variable("admitExistingSqliteStructure");
  const admission = callable(admissionDeclaration);
  if (admission === undefined) {
    violations.push("sqlite_admission_owner_missing");
  } else {
    if (!exactParameters(admission.parameters, ["path"])) {
      violations.push("sqlite_admission_signature");
    }
    if (admission.parameters.length > 1) {
      violations.push("sqlite_admission_caller_selected_lease_parameter");
    }
    const nodes = descendants(admission);
    const leaseDeclarations = nodes.filter((node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "mainLease");
    if (leaseDeclarations.length !== 1) {
      violations.push(`sqlite_main_lease_declarations:${leaseDeclarations.length}`);
    }
    const leaseDeclaration = leaseDeclarations[0];
    const directAcquisitions = directCalls(admission, "acquireOwnerOnlyStateFileLease");
    if (directAcquisitions.length !== 1) {
      violations.push(`sqlite_main_lease_direct_acquisitions:${directAcquisitions.length}`);
    }
    const leaseInitializer = leaseDeclaration?.initializer;
    if (
      leaseDeclaration === undefined ||
      leaseDeclaration.parent === undefined ||
      !ts.isVariableDeclarationList(leaseDeclaration.parent) ||
      (leaseDeclaration.parent.flags & ts.NodeFlags.Const) === 0 ||
      leaseInitializer === undefined ||
      !ts.isCallExpression(leaseInitializer) ||
      !ts.isIdentifier(leaseInitializer.expression) ||
      leaseInitializer.expression.text !== "acquireOwnerOnlyStateFileLease" ||
      leaseInitializer.arguments.length !== 1 ||
      !isIdentifierArgument(leaseInitializer, 0, "path")
    ) {
      violations.push("sqlite_main_lease_alternate_acquisition");
    }

    const readonlyOpens = nodes.filter((node): node is ts.NewExpression =>
      ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Database" &&
      node.arguments?.length === 2 && isIdentifierArgument(node as unknown as ts.CallExpression, 0, "path"));
    const captures = directCalls(admission, "captureExistingSqliteArtifacts");
    const structureReads = directCalls(admission, "hasExactCurrentSqliteStructure");
    const postconditions = directCalls(admission, "assertReadOnlyArtifactTransition");
    if (captures.length !== 1 || captures[0]!.arguments.length !== 2 ||
      !isIdentifierArgument(captures[0]!, 0, "path") ||
      !isIdentifierArgument(captures[0]!, 1, "mainLease")) {
      violations.push("sqlite_artifact_capture_lease_binding");
    }
    if (structureReads.length !== 1 || structureReads[0]!.arguments.length !== 1 ||
      !isIdentifierArgument(structureReads[0]!, 0, "database")) {
      violations.push("sqlite_read_only_structure_read");
    }
    if (postconditions.length !== 1 || postconditions[0]!.arguments.length !== 3 ||
      !isIdentifierArgument(postconditions[0]!, 0, "path") ||
      !isIdentifierArgument(postconditions[0]!, 1, "mainLease") ||
      !isIdentifierArgument(postconditions[0]!, 2, "before")) {
      violations.push("sqlite_artifact_postcondition_lease_binding");
    }

    const assertions = leaseAssertions(admission);
    const readonlyOpen = readonlyOpens[0];
    const structureRead = structureReads[0];
    if (readonlyOpen === undefined || structureRead === undefined || !assertions.some((assertion) =>
      assertion.getStart(sourceFile) > readonlyOpen.getEnd() &&
      assertion.getEnd() < structureRead.getStart(sourceFile))) {
      violations.push("sqlite_read_only_structure_preassert_missing");
    }
    const closeAfterRead = structureRead === undefined ? undefined : nodes.find((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "database" &&
      node.expression.name.text === "close" && node.getStart(sourceFile) > structureRead.getEnd());
    if (structureRead === undefined || closeAfterRead === undefined || !assertions.some((assertion) =>
      assertion.getStart(sourceFile) > structureRead.getEnd() &&
      assertion.getEnd() < closeAfterRead.getStart(sourceFile))) {
      violations.push("sqlite_read_only_structure_postassert_missing");
    }

    const successfulReturns = nodes.filter((node): node is ts.ReturnStatement =>
      ts.isReturnStatement(node) && isFrozenObject(node.expression, ["mainLease"]));
    if (successfulReturns.length !== 1) {
      violations.push("sqlite_admission_main_lease_handoff");
    }
    const ordered = [
      leaseDeclaration?.getStart(sourceFile),
      captures[0]?.getStart(sourceFile),
      readonlyOpen?.getStart(sourceFile),
      structureRead?.getStart(sourceFile),
      closeAfterRead?.getStart(sourceFile),
      postconditions[0]?.getStart(sourceFile),
      successfulReturns[0]?.getStart(sourceFile),
    ];
    if (ordered.some((position) => position === undefined) || ordered.some((position, index) =>
      index > 0 && (position as number) <= (ordered[index - 1] as number))) {
      violations.push("sqlite_admission_order");
    }
  }

  const artifactPostcondition = callable(variable("assertReadOnlyArtifactTransition"));
  if (artifactPostcondition === undefined ||
    !exactParameters(artifactPostcondition.parameters, ["path", "mainLease", "before"])) {
    violations.push("sqlite_artifact_postcondition_signature");
  } else {
    const captures = directCalls(artifactPostcondition, "captureExistingSqliteArtifacts");
    const assertions = leaseAssertions(artifactPostcondition);
    if (captures.length !== 1 || captures[0]!.arguments.length !== 2 ||
      !isIdentifierArgument(captures[0]!, 0, "path") ||
      !isIdentifierArgument(captures[0]!, 1, "mainLease")) {
      violations.push("sqlite_artifact_postcondition_capture_binding");
    }
    if (captures[0] === undefined || !assertions.some((assertion) =>
      assertion.getEnd() < captures[0]!.getStart(sourceFile))) {
      violations.push("sqlite_artifact_postcondition_preassert_missing");
    }
    if (captures[0] === undefined || !assertions.some((assertion) =>
      assertion.getStart(sourceFile) > captures[0]!.getEnd())) {
      violations.push("sqlite_artifact_postcondition_postassert_missing");
    }
    const identityComparisons = directCalls(
      artifactPostcondition,
      "sameOwnerOnlyStateFileIdentity",
    );
    if (identityComparisons.length !== 1 || identityComparisons[0]!.arguments.length !== 2) {
      violations.push("sqlite_artifact_identity_comparison_binding");
    }
  }

  const artifactCapture = callable(variable("captureOwnerOnlyArtifact"));
  if (artifactCapture === undefined) {
    violations.push("sqlite_artifact_observation_owner_missing");
  } else {
    const observations = descendants(artifactCapture).filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.arguments.length === 0 &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "lease" &&
      node.expression.name.text === "observe");
    if (observations.length !== 1) violations.push("sqlite_artifact_observation_binding");
  }

  const opening = callable(variable("openCurrentDatabase"));
  if (opening === undefined) {
    violations.push("sqlite_open_current_owner_missing");
  } else {
    if (!exactParameters(opening.parameters, ["path"])) violations.push("sqlite_open_current_signature");
    if (opening.parameters.length > 1) {
      violations.push("sqlite_open_current_caller_selected_lease_parameter");
    }
    const admissionCalls = directCalls(opening, "admitExistingSqliteStructure");
    if (admissionCalls.length !== 1 || admissionCalls[0]!.arguments.length !== 1 ||
      !isIdentifierArgument(admissionCalls[0]!, 0, "path")) {
      violations.push("sqlite_open_current_admission_binding");
    }
    if (directCalls(opening, "acquireOwnerOnlyStateFileLease").length !== 0) {
      violations.push("sqlite_open_current_alternate_acquisition");
    }
    const leaseBindings = descendants(opening).filter((node): node is ts.BindingElement =>
      ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === "mainLease" &&
      ts.isObjectBindingPattern(node.parent) && ts.isVariableDeclaration(node.parent.parent) &&
      node.parent.parent.initializer !== undefined && ts.isIdentifier(node.parent.parent.initializer) &&
      node.parent.parent.initializer.text === "admission");
    if (leaseBindings.length !== 1) violations.push("sqlite_open_current_admitted_lease_binding");
    const handoffs = descendants(opening).filter((node): node is ts.ReturnStatement =>
      ts.isReturnStatement(node) && isFrozenObject(node.expression, ["database", "mainLease"]));
    if (handoffs.length !== 1) violations.push("sqlite_open_current_main_lease_handoff");
  }

  const constructor = productDatabase?.members.find((member): member is ts.ConstructorDeclaration =>
    ts.isConstructorDeclaration(member));
  const constructorLeaseAssignments = constructor === undefined ? [] : descendants(constructor).filter(
    (node): node is ts.BinaryExpression => ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isPrivateIdentifier(node.left.name) && node.left.name.text === "#mainLease" &&
      ts.isPropertyAccessExpression(node.right) && ts.isIdentifier(node.right.expression) &&
      node.right.expression.text === "opened" && node.right.name.text === "mainLease",
  );
  if (constructorLeaseAssignments.length !== 1) {
    violations.push("product_database_main_lease_handoff");
  }

  return violations.sort();
};

type LiteralVocabulary =
  | Readonly<{ kind: "number"; values: readonly string[] }>
  | Readonly<{ kind: "string"; values: readonly string[] }>;

const literalVocabulary = (node: ts.Node): LiteralVocabulary | undefined => {
  const nodes = ts.isArrayLiteralExpression(node)
    ? node.elements
    : ts.isUnionTypeNode(node)
      ? node.types
      : undefined;
  if (nodes === undefined || nodes.length === 0) return undefined;

  const values: string[] = [];
  let kind: LiteralVocabulary["kind"] | undefined;
  for (const member of nodes) {
    const literal = ts.isLiteralTypeNode(member) ? member.literal : member;
    if (ts.isStringLiteralLike(literal)) {
      if (kind !== undefined && kind !== "string") return undefined;
      kind = "string";
      values.push(literal.text);
      continue;
    }
    if (ts.isNumericLiteral(literal)) {
      if (kind !== undefined && kind !== "number") return undefined;
      kind = "number";
      values.push(literal.text);
      continue;
    }
    return undefined;
  }
  return kind === undefined ? undefined : { kind, values };
};

const comparisonVocabulary = (node: ts.Node): LiteralVocabulary | undefined => {
  if (!ts.isBinaryExpression(node) ||
    (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken &&
      node.operatorToken.kind !== ts.SyntaxKind.BarBarToken)) return undefined;

  const comparisons: Array<Readonly<{
    kind: LiteralVocabulary["kind"];
    subject: string;
    value: string;
  }>> = [];
  const literal = (expression: ts.Expression): Readonly<{
    kind: LiteralVocabulary["kind"];
    value: string;
  }> | undefined => {
    if (ts.isStringLiteralLike(expression)) return { kind: "string", value: expression.text };
    if (ts.isNumericLiteral(expression)) return { kind: "number", value: expression.text };
    return undefined;
  };
  const collect = (expression: ts.Expression): boolean => {
    if (ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return collect(expression.left) && collect(expression.right);
    }
    if (!ts.isBinaryExpression(expression) || ![
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(expression.operatorToken.kind)) return false;
    const left = literal(expression.left);
    const right = literal(expression.right);
    if ((left === undefined) === (right === undefined)) return false;
    const member = left ?? right;
    const subject = left === undefined ? expression.left : expression.right;
    if (member === undefined) return false;
    comparisons.push({
      kind: member.kind,
      subject: subject.getText(node.getSourceFile()),
      value: member.value,
    });
    return true;
  };
  if (!collect(node) || comparisons.length < 2) return undefined;
  const first = comparisons[0];
  if (first === undefined ||
    comparisons.some((comparison) =>
      comparison.kind !== first.kind || comparison.subject !== first.subject)) return undefined;
  return { kind: first.kind, values: comparisons.map((comparison) => comparison.value) };
};

const hasExactMembers = (
  actual: readonly string[],
  expected: readonly string[],
): boolean => {
  const actualMembers = new Set(actual);
  const expectedMembers = new Set(expected);
  return actualMembers.size === expectedMembers.size &&
    [...expectedMembers].every((member) => actualMembers.has(member));
};

const isInterfaceConsumer = (file: string): boolean =>
  interfaceConsumerEntryPoints.has(file) ||
  interfaceConsumerRoots.some((root) => isWithin(file, root));

const resolvesInsideTokenCatalog = (file: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  let target: string;
  try { target = fileURLToPath(new URL(specifier, pathToFileURL(file))); }
  catch { return undefined; }
  const fromCatalog = relative(tokenCatalogRoot, target);
  const inside = fromCatalog === "" || (!isAbsolute(fromCatalog) && fromCatalog !== ".." &&
    !fromCatalog.startsWith(`..${sep}`));
  return inside ? fromCatalog.split(sep).join("/") : undefined;
};

const walletConnectConfigurationModule =
  resolve(sourceRoot, "wallet/walletconnect-configuration.ts");
const rpcTransportTargetModule =
  resolve(sourceRoot, "chain/rpc-transport-target.ts");
const walletConnectClientModule =
  resolve(sourceRoot, "wallet/walletconnect-client.ts");
const walletApplicationModule =
  resolve(sourceRoot, "wallet/application.ts");
const walletExternalModulesSourceModule =
  resolve(sourceRoot, "wallet/external-modules.cts");
const walletExternalModulesRuntimeModule =
  resolve(sourceRoot, "wallet/external-modules.cjs");
const robinhoodOfficialAssetSemanticContractModule =
  resolve(sourceRoot, "registry/official-asset-contract.ts");
const robinhoodOfficialAssetSourceContractModule =
  resolve(sourceRoot, "registry/official-asset-source-contract.ts");
const robinhoodOfficialAssetAdapterModule =
  resolve(sourceRoot, "registry/official-assets.ts");
const sourcifyAdapterModule =
  resolve(sourceRoot, "intelligence/sourcify.ts");
const registryServerEntryModule =
  resolve(sourceRoot, "registry/index.ts");
const registryClientEntryModule =
  resolve(sourceRoot, "registry/client.ts");
const defaultStockTokenContractModule =
  resolve(sourceRoot, "registry/default-stock-token-contract.ts");
const defaultStockTokenManifestModule =
  resolve(sourceRoot, "registry/default-stock-tokens.ts");
const accountAssetContractsModule =
  resolve(sourceRoot, "account-assets/contracts.ts");
const accountAssetApplicationModule =
  resolve(sourceRoot, "account-assets/application.ts");
const mcpAppViewEntryModule =
  resolve(sourceRoot, "interfaces/mcp-app/view/main.ts");
const httpBoundaryModule = resolve(sourceRoot, "runtime/http-boundary.ts");
const httpLimitsModule = resolve(sourceRoot, "runtime/http-limits.ts");
const presentationSnapshotModule = resolve(sourceRoot, "runtime/presentation-snapshot.ts");

interface ExternalIntegrationAuthorityRule {
  readonly module: string;
  readonly symbol: string;
  readonly importers: ReadonlySet<string>;
  readonly reexporters: ReadonlySet<string>;
}

interface ExternalIntegrationResultEdge {
  readonly file: string;
  readonly exportName: string;
  readonly sourceModule: string;
  readonly sourceSymbol: string;
}

const externalIntegrationAuthorityRules: readonly ExternalIntegrationAuthorityRule[] =
  Object.freeze([
    {
      module: rpcTransportTargetModule,
      symbol: "admitRpcTransportTarget",
      importers: new Set([
        resolve(sourceRoot, "chain/rpc.ts"),
        resolve(sourceRoot, "runtime/configuration.ts"),
      ]),
      reexporters: new Set<string>(),
    },
    {
      module: walletConnectConfigurationModule,
      symbol: "createWalletConnectConfiguration",
      importers: new Set([resolve(sourceRoot, "runtime/configuration.ts")]),
      reexporters: new Set<string>(),
    },
    {
      module: walletConnectConfigurationModule,
      symbol: "readWalletConnectConfiguration",
      importers: new Set([walletConnectClientModule]),
      reexporters: new Set<string>(),
    },
    {
      module: walletConnectConfigurationModule,
      symbol: "readWalletConnectSessionRequirements",
      importers: new Set([resolve(sourceRoot, "wallet/coordinator.ts")]),
      reexporters: new Set<string>(),
    },
    {
      module: walletConnectConfigurationModule,
      symbol: "readWalletConnectConfigurationIdentity",
      importers: new Set([resolve(sourceRoot, "runtime/control-credential.ts")]),
      reexporters: new Set<string>(),
    },
    {
      module: walletConnectClientModule,
      symbol: "createWalletConnectClient",
      importers: new Set([resolve(sourceRoot, "wallet/application.ts")]),
      reexporters: new Set<string>(),
    },
    {
      module: robinhoodOfficialAssetSemanticContractModule,
      symbol: "assertOfficialAssetSourceMember",
      importers: new Set([
        resolve(sourceRoot, "chain/official-assets.ts"),
        robinhoodOfficialAssetAdapterModule,
        resolve(sourceRoot, "registry/stock-factory.ts"),
      ]),
      reexporters: new Set([registryServerEntryModule]),
    },
    {
      module: robinhoodOfficialAssetSemanticContractModule,
      symbol: "unavailableStockFactoryResultSchema",
      importers: new Set<string>(),
      reexporters: new Set([registryClientEntryModule]),
    },
    {
      module: registryClientEntryModule,
      symbol: "unavailableStockFactoryResultSchema",
      importers: new Set([
        resolve(sourceRoot, "stock-token-trade-history/result.ts"),
      ]),
      reexporters: new Set<string>(),
    },
    {
      module: robinhoodOfficialAssetSemanticContractModule,
      symbol: "assertOfficialAssetSourceSnapshot",
      importers: new Set([robinhoodOfficialAssetSourceContractModule]),
      reexporters: new Set<string>(),
    },
    {
      module: robinhoodOfficialAssetSemanticContractModule,
      symbol: "assertCommittedOfficialAssetSnapshot",
      importers: new Set<string>(),
      reexporters: new Set([registryServerEntryModule]),
    },
    {
      module: robinhoodOfficialAssetSemanticContractModule,
      symbol: "findOfficialAssetMember",
      importers: new Set<string>(),
      reexporters: new Set([registryServerEntryModule]),
    },
    {
      module: robinhoodOfficialAssetSemanticContractModule,
      symbol: "officialAssetMemberSetDigest",
      importers: new Set([
        robinhoodOfficialAssetAdapterModule,
        resolve(sourceRoot, "stock-token-prices/contracts.ts"),
      ]),
      reexporters: new Set<string>(),
    },
    {
      module: robinhoodOfficialAssetSemanticContractModule,
      symbol: "officialAssetCandidateListDigest",
      importers: new Set([
        robinhoodOfficialAssetAdapterModule,
        resolve(sourceRoot, "stock-token-prices/contracts.ts"),
      ]),
      reexporters: new Set<string>(),
    },
    {
      module: robinhoodOfficialAssetSemanticContractModule,
      symbol: "projectOfficialAssetSnapshotEvidence",
      importers: new Set<string>(),
      reexporters: new Set([registryServerEntryModule]),
    },
    {
      module: robinhoodOfficialAssetSourceContractModule,
      symbol: "admitRobinhoodOfficialAssetSourceObservation",
      importers: new Set([robinhoodOfficialAssetAdapterModule]),
      reexporters: new Set<string>(),
    },
    {
      module: robinhoodOfficialAssetSourceContractModule,
      symbol: "assertRobinhoodOfficialAssetSourceObservation",
      importers: new Set<string>(),
      reexporters: new Set([registryServerEntryModule]),
    },
    {
      module: robinhoodOfficialAssetSourceContractModule,
      symbol: "officialAssetSourceObserved",
      importers: new Set([robinhoodOfficialAssetAdapterModule]),
      reexporters: new Set<string>(),
    },
    {
      module: robinhoodOfficialAssetSourceContractModule,
      symbol: "officialAssetSourceUnavailable",
      importers: new Set([robinhoodOfficialAssetAdapterModule]),
      reexporters: new Set<string>(),
    },
    {
      module: robinhoodOfficialAssetSourceContractModule,
      symbol: "RobinhoodOfficialAssetSourceClient",
      importers: new Set([
        robinhoodOfficialAssetAdapterModule,
        resolve(sourceRoot, "registry/synchronization.ts"),
        resolve(sourceRoot, "registry/application-factory.ts"),
      ]),
      reexporters: new Set([registryServerEntryModule]),
    },
    {
      module: robinhoodOfficialAssetSourceContractModule,
      symbol: "RobinhoodOfficialAssetSourceObservation",
      importers: new Set<string>(),
      reexporters: new Set<string>(),
    },
    {
      module: robinhoodOfficialAssetSourceContractModule,
      symbol: "OfficialAssetSnapshotStore",
      importers: new Set([resolve(sourceRoot, "registry/synchronization.ts"), resolve(sourceRoot, "registry/application-factory.ts")]),
      reexporters: new Set([registryServerEntryModule]),
    },
    {
      module: robinhoodOfficialAssetSemanticContractModule,
      symbol: "assertStockFactoryVerificationResult",
      importers: new Set([
        resolve(sourceRoot, "chain/official-assets.ts"),
        resolve(sourceRoot, "registry/stock-factory.ts"),
      ]),
      reexporters: new Set<string>(),
    },
    {
      module: robinhoodOfficialAssetAdapterModule,
      symbol: "createRobinhoodOfficialAssetSourceClient",
      importers: new Set<string>(),
      reexporters: new Set([registryServerEntryModule]),
    },
    {
      module: registryServerEntryModule,
      symbol: "createRobinhoodOfficialAssetSourceClient",
      importers: new Set([resolve(sourceRoot, "runtime/composition.ts")]),
      reexporters: new Set<string>(),
    },
    {
      module: registryServerEntryModule,
      symbol: "assertOfficialAssetSourceMember",
      importers: new Set([resolve(sourceRoot, "runtime/database.ts")]),
      reexporters: new Set<string>(),
    },
    {
      module: registryServerEntryModule,
      symbol: "assertCommittedOfficialAssetSnapshot",
      importers: new Set([resolve(sourceRoot, "runtime/database.ts")]),
      reexporters: new Set<string>(),
    },
    {
      module: registryServerEntryModule,
      symbol: "findOfficialAssetMember",
      importers: new Set([
        resolve(sourceRoot, "protocols/uniswap-v4/application.ts"),
        resolve(sourceRoot, "review/fee-replacement.ts"),
        resolve(sourceRoot, "review/preparation.ts"),
        resolve(sourceRoot, "account-assets/application.ts"),
        resolve(sourceRoot, "runtime/database.ts"),
        resolve(sourceRoot, "token-catalog/coordinator.ts"),
      ]),
      reexporters: new Set<string>(),
    },
    {
      module: registryServerEntryModule,
      symbol: "projectOfficialAssetSnapshotEvidence",
      importers: new Set([
        resolve(sourceRoot, "protocols/uniswap-v4/application.ts"),
        resolve(sourceRoot, "review/fee-replacement.ts"),
        resolve(sourceRoot, "review/preparation.ts"),
        resolve(sourceRoot, "account-assets/application.ts"),
        resolve(sourceRoot, "stock-token-trade-history/result-builder.ts"),
        resolve(sourceRoot, "stock-token-prices/application.ts"),
      ]),
      reexporters: new Set<string>(),
    },
    {
      module: registryServerEntryModule,
      symbol: "assertRobinhoodOfficialAssetSourceObservation",
      importers: new Set([resolve(sourceRoot, "runtime/database.ts")]),
      reexporters: new Set<string>(),
    },
    {
      module: registryServerEntryModule,
      symbol: "RobinhoodOfficialAssetSourceClient",
      importers: new Set([resolve(sourceRoot, "runtime/composition.ts")]),
      reexporters: new Set<string>(),
    },
    {
      module: registryServerEntryModule,
      symbol: "OfficialAssetSnapshotStore",
      importers: new Set([resolve(sourceRoot, "runtime/database.ts")]),
      reexporters: new Set<string>(),
    },
    {
      module: sourcifyAdapterModule,
      symbol: "createSourcifyContractSourceVerification",
      importers: new Set([resolve(sourceRoot, "runtime/composition.ts")]),
      reexporters: new Set<string>(),
    },
  ]);

const externalIntegrationRulesByModule = new Map<string, ReadonlyMap<
  string,
  ExternalIntegrationAuthorityRule
>>();
for (const rule of externalIntegrationAuthorityRules) {
  const current = new Map(externalIntegrationRulesByModule.get(rule.module) ?? []);
  current.set(rule.symbol, rule);
  externalIntegrationRulesByModule.set(rule.module, current);
}

const externalIntegrationResultEdges: readonly ExternalIntegrationResultEdge[] =
  Object.freeze([
    {
      file: robinhoodOfficialAssetSourceContractModule,
      exportName: "assertRobinhoodOfficialAssetSourceObservation",
      sourceModule: robinhoodOfficialAssetSemanticContractModule,
      sourceSymbol: "assertOfficialAssetSourceSnapshot",
    },
    {
      file: robinhoodOfficialAssetAdapterModule,
      exportName: "createRobinhoodOfficialAssetSourceClient",
      sourceModule: robinhoodOfficialAssetSourceContractModule,
      sourceSymbol: "admitRobinhoodOfficialAssetSourceObservation",
    },
    {
      file: robinhoodOfficialAssetAdapterModule,
      exportName: "createRobinhoodOfficialAssetSourceClient",
      sourceModule: robinhoodOfficialAssetSourceContractModule,
      sourceSymbol: "officialAssetSourceObserved",
    },
    {
      file: robinhoodOfficialAssetAdapterModule,
      exportName: "createRobinhoodOfficialAssetSourceClient",
      sourceModule: robinhoodOfficialAssetSourceContractModule,
      sourceSymbol: "officialAssetSourceUnavailable",
    },
    {
      file: resolve(sourceRoot, "registry/stock-factory.ts"),
      exportName: "createStockFactoryVerifier",
      sourceModule: robinhoodOfficialAssetSemanticContractModule,
      sourceSymbol: "assertStockFactoryVerificationResult",
    },
    {
      file: resolve(sourceRoot, "chain/official-assets.ts"),
      exportName: "createOfficialAssetChainReadPort",
      sourceModule: robinhoodOfficialAssetSemanticContractModule,
      sourceSymbol: "assertStockFactoryVerificationResult",
    },
    {
      file: resolve(sourceRoot, "stock-token-trade-history/result.ts"),
      exportName: "stockTokenTradeHistoryDataSchema",
      sourceModule: registryClientEntryModule,
      sourceSymbol: "unavailableStockFactoryResultSchema",
    },
    {
      file: resolve(sourceRoot, "stock-token-trade-history/result-builder.ts"),
      exportName: "resolveStockTokenTradeHistoryOfficialAsset",
      sourceModule: registryServerEntryModule,
      sourceSymbol: "projectOfficialAssetSnapshotEvidence",
    },
  ]);

const sourceName = (file: string): string =>
  relative(sourceRoot, file).split(sep).join("/");

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;

const isPrivateClassElement = (node: ts.ClassElement): boolean =>
  (node.name !== undefined && ts.isPrivateIdentifier(node.name)) ||
  (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
    ) === true
  );

const exportedDeclarationNames = (source: ts.SourceFile): readonly string[] => {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
      continue;
    }
    if (
      (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)
      ) &&
      statement.name !== undefined &&
      hasExportModifier(statement)
    ) {
      names.push(statement.name.text);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      names.push("default");
      continue;
    }
    if (!ts.isExportDeclaration(statement)) continue;
    if (statement.exportClause === undefined) {
      names.push("*");
    } else if (ts.isNamespaceExport(statement.exportClause)) {
      names.push(`* as ${statement.exportClause.name.text}`);
    } else {
      names.push(...statement.exportClause.elements.map((element) => element.name.text));
    }
  }
  return names;
};

const walletConnectConfigurationExports = Object.freeze([
  "WalletConnectConfiguration",
  "WalletConnectSessionRequirements",
  "createWalletConnectConfiguration",
  "readWalletConnectConfiguration",
  "readWalletConnectConfigurationIdentity",
  "readWalletConnectSessionRequirements",
] as const);

const robinhoodOfficialAssetSemanticContractExports = Object.freeze([
  "CommittedOfficialAssetSnapshot",
  "OfficialAssetCandidate",
  "OfficialAssetSnapshotEvidence",
  "OfficialAssetSnapshotRevision",
  "OfficialAssetSourceClassificationUnavailableReason",
  "OfficialAssetSourceMember",
  "OfficialAssetSourceSnapshot",
  "OfficialAssetSourceUnavailableReason",
  "StockFactoryClassificationUnavailableReason",
  "StockFactoryVerification",
  "StockFactoryVerificationResult",
  "assertCommittedOfficialAssetSnapshot",
  "assertOfficialAssetSourceMember",
  "assertOfficialAssetSourceSnapshot",
  "assertStockFactoryVerificationResult",
  "committedOfficialAssetSnapshotSchema",
  "findOfficialAssetMember",
  "officialAssetCandidateListDigest",
  "officialAssetCandidateSchema",
  "officialAssetMemberSetDigest",
  "officialAssetSnapshotEvidenceSchema",
  "officialAssetSnapshotRevisionByteLength",
  "officialAssetSnapshotRevisionSchema",
  "officialAssetSourceClassificationUnavailableReasonSchema",
  "officialAssetSourceClassificationUnavailableReasons",
  "officialAssetSourceDefinition",
  "officialAssetSourceFailureDefinitions",
  "officialAssetSourceLabelSchema",
  "officialAssetSourceMemberSchema",
  "officialAssetSourceSnapshotSchema",
  "officialAssetSourceUnavailableReasonSchema",
  "officialAssetSourceUnavailableReasons",
  "projectOfficialAssetSnapshotEvidence",
  "stockFactoryAdmissionManifest",
  "stockFactoryClassificationUnavailableReasonSchema",
  "stockFactoryClassificationUnavailableReasons",
  "stockFactoryVerificationResultSchema",
  "stockFactoryVerificationSchema",
  "unavailableStockFactoryResultSchema",
] as const);

const robinhoodOfficialAssetSourceContractExports = Object.freeze([
  "OfficialAssetSnapshotStore",
  "RobinhoodOfficialAssetSourceClient",
  "RobinhoodOfficialAssetSourceObservation",
  "RobinhoodOfficialAssetSourceObservedResult",
  "RobinhoodOfficialAssetSourceReadResult",
  "RobinhoodOfficialAssetSourceUnavailableResult",
  "admitRobinhoodOfficialAssetSourceObservation",
  "assertRobinhoodOfficialAssetSourceObservation",
  "officialAssetSourceObserved",
  "officialAssetSourceUnavailable",
] as const);

const robinhoodOfficialAssetAdapterExports = Object.freeze([
  "createRobinhoodOfficialAssetSourceClient",
] as const);

const sourcifyAdapterExports = Object.freeze([
  "createSourcifyContractSourceVerification",
] as const);

const defaultStockTokenContractExports = Object.freeze([
  "defaultStockTokenCount",
  "defaultStockTokenRankSchema",
] as const);

const registryServerEntryExports = Object.freeze([
  "OfficialAssetReadPort", "RegistryOwnerApplication", "createRegistryOwnerApplication",
  "productChainId", "productChainNumericId", "productDisplayName", "productUsdgAsset",
  "ValidatedInputEvidenceFragment", "createValidatedInputEvidenceFragment",
  "CommittedOfficialAssetSnapshot",
  "DefaultStockTokenManifest",
  "OfficialAssetCandidate",
  "OfficialAssetSnapshotEvidence",
  "OfficialAssetSnapshotRevision",
  "OfficialAssetSnapshotStore",
  "OfficialAssetSourceClassificationUnavailableReason",
  "OfficialAssetSourceMember",
  "OfficialAssetSourceSnapshot",
  "OfficialAssetSourceUnavailableReason",
  "OfficialAssetSynchronizationDependencies",
  "OfficialAssetSynchronizationPort",
  "OfficialAssetSynchronizationResult",
  "RobinhoodOfficialAssetSourceClient",
  "RobinhoodOfficialAssetSourceReadResult",
  "StockFactoryClassificationUnavailableReason",
  "StockFactoryVerification",
  "StockFactoryVerificationResult",
  "StockFactoryVerifier",
  "StockFactoryVerifierInitializationResult",
  "StockFactoryVerifierInput",
  "assertCommittedOfficialAssetSnapshot",
  "assertOfficialAssetSourceMember",
  "assertRobinhoodOfficialAssetSourceObservation",
  "committedOfficialAssetSnapshotSchema",
  "createOfficialAssetSynchronization",
  "createRobinhoodOfficialAssetSourceClient",
  "createStockFactoryVerifier",
  "defaultStockTokenManifest",
  "defaultStockTokenRank",
  "findOfficialAssetMember",
  "officialAssetCandidateSchema",
  "officialAssetSnapshotEvidenceSchema",
  "officialAssetSnapshotRevisionByteLength",
  "officialAssetSnapshotRevisionSchema",
  "officialAssetSourceClassificationUnavailableReasonSchema",
  "officialAssetSourceClassificationUnavailableReasons",
  "officialAssetSourceDefinition",
  "officialAssetSourceFailureDefinitions",
  "officialAssetSourceLabelSchema",
  "officialAssetSourceMemberSchema",
  "officialAssetSourceSnapshotSchema",
  "officialAssetSourceUnavailableReasonSchema",
  "officialAssetSourceUnavailableReasons",
  "projectOfficialAssetSnapshotEvidence",
  "stockFactoryAdmissionManifest",
  "stockFactoryClassificationUnavailableReasonSchema",
  "stockFactoryClassificationUnavailableReasons",
  "stockFactoryVerificationResultSchema",
  "stockFactoryVerificationSchema",
] as const);

const registryClientEntryExports = Object.freeze([
  "productChainId", "productChainNumericId", "productDisplayName", "productUsdgAsset",
  "ValidatedInputEvidenceFragment", "createValidatedInputEvidenceFragment",
  "CommittedOfficialAssetSnapshot",
  "OfficialAssetCandidate",
  "OfficialAssetSnapshotEvidence",
  "OfficialAssetSnapshotRevision",
  "OfficialAssetSourceClassificationUnavailableReason",
  "OfficialAssetSourceMember",
  "OfficialAssetSourceSnapshot",
  "OfficialAssetSourceUnavailableReason",
  "StockFactoryClassificationUnavailableReason",
  "StockFactoryVerification",
  "committedOfficialAssetSnapshotSchema",
  "defaultStockTokenRank",
  "defaultStockTokenRankSchema",
  "officialAssetCandidateSchema",
  "officialAssetSnapshotEvidenceSchema",
  "officialAssetSnapshotRevisionSchema",
  "officialAssetSourceClassificationUnavailableReasonSchema",
  "officialAssetSourceClassificationUnavailableReasons",
  "officialAssetSourceDefinition",
  "officialAssetSourceLabelSchema",
  "officialAssetSourceMemberSchema",
  "officialAssetSourceSnapshotSchema",
  "stockFactoryAdmissionManifest",
  "stockFactoryClassificationUnavailableReasonSchema",
  "stockFactoryClassificationUnavailableReasons",
  "stockFactoryVerificationSchema",
  "unavailableStockFactoryResultSchema",
] as const);

const exactModuleExportViolations = (
  source: string,
  module: string,
  expected: readonly string[],
  allowExternalReexports: boolean,
): readonly string[] => {
  const parsed = ts.createSourceFile(
    module,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const actual = exportedDeclarationNames(parsed);
  const violations: string[] = [];
  for (const statement of parsed.statements) {
    if (
      !allowExternalReexports &&
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined
    ) {
      violations.push(`external_reexport:${statement.moduleSpecifier.getText(parsed)}`);
    }
  }
  for (const name of expected) {
    if (!actual.includes(name)) violations.push(`missing_export:${name}`);
  }
  for (const name of actual) {
    if (!expected.includes(name)) {
      violations.push(`unexpected_export:${name}`);
    }
  }
  if (new Set(actual).size !== actual.length) violations.push("duplicate_export");
  return violations;
};

const productCodeSourcePattern = /\.[cm]?[jt]sx?$/u;

interface ProductModuleGraph {
  readonly visited: ReadonlySet<string>;
  readonly violations: readonly string[];
}

const productModuleGraph = (
  program: ts.Program,
  productFiles: ReadonlySet<string>,
  root: string,
): ProductModuleGraph => {
  const normalizedRoot = resolve(root);
  const violations: string[] = [];
  const visited = new Set<string>();
  const pending = [normalizedRoot];
  const resolutionHost: ts.ModuleResolutionHost = {
    directoryExists: ts.sys.directoryExists,
    fileExists: (file) => {
      const normalized = resolve(file);
      return productFiles.has(normalized) || program.getSourceFile(normalized) !== undefined ||
        ts.sys.fileExists(file);
    },
    getCurrentDirectory: () => repositoryRoot,
    getDirectories: ts.sys.getDirectories,
    readFile: (file) => program.getSourceFile(resolve(file))?.text ?? ts.sys.readFile(file),
    ...(ts.sys.realpath === undefined ? {} : { realpath: ts.sys.realpath }),
  };

  while (pending.length > 0) {
    const file = pending.shift();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    if (!productCodeSourcePattern.test(file)) continue;
    const sourceFile = program.getSourceFile(file);
    if (sourceFile === undefined) {
      violations.push(`${sourceName(normalizedRoot)}:missing_source:${sourceName(file)}`);
      continue;
    }
    for (const reference of inspectModuleImports(sourceFile.text, file)) {
      if (!reference.runtime) continue;
      if (reference.specifier === undefined) {
        violations.push(`${sourceName(file)}:nonliteral_runtime_load`);
        continue;
      }
      if (!reference.specifier.startsWith(".")) continue;
      const directTarget = resolve(fileURLToPath(new URL(reference.specifier, pathToFileURL(file))));
      const target = reference.specifier.endsWith(".css")
        ? directTarget
        : ts.resolveModuleName(
            reference.specifier,
            file,
            program.getCompilerOptions(),
            resolutionHost,
          ).resolvedModule?.resolvedFileName;
      const normalizedTarget = target === undefined ? undefined : resolve(target);
      if (normalizedTarget === undefined || !productFiles.has(normalizedTarget)) {
        violations.push(`${sourceName(file)}:unresolved_runtime_load:${reference.specifier}`);
        continue;
      }
      if (!visited.has(normalizedTarget)) pending.push(normalizedTarget);
    }
  }

  return Object.freeze({
    visited,
    violations: Object.freeze(violations.sort()),
  });
};

const defaultStockTokenClientGraphViolations = (
  program: ts.Program,
  productFiles: ReadonlySet<string>,
  root: string,
): readonly string[] => {
  const normalizedRoot = resolve(root);
  const graph = productModuleGraph(program, productFiles, normalizedRoot);
  const violations = [...graph.violations];

  if (!graph.visited.has(defaultStockTokenContractModule)) {
    violations.push(`${sourceName(normalizedRoot)}:missing_default_contract`);
  }
  if (!graph.visited.has(defaultStockTokenManifestModule)) {
    violations.push(`${sourceName(normalizedRoot)}:missing_default_lookup`);
  }
  for (const entry of [resolve(sourceRoot, "core/index.ts"), registryServerEntryModule]) {
    if (graph.visited.has(entry)) violations.push(`${sourceName(normalizedRoot)}:server_entry:${sourceName(entry)}`);
  }
  for (const file of graph.visited) {
    const source = program.getSourceFile(file);
    if (source === undefined) continue;
    for (const reference of inspectModuleImports(source.text, file)) {
      if (reference.runtime && reference.specifier !== undefined && isBuiltin(reference.specifier)) {
        violations.push(`${sourceName(file)}:node_builtin:${reference.specifier}`);
      }
    }
  }
  const manifest = program.getSourceFile(defaultStockTokenManifestModule);
  const dependencies = manifest === undefined ? [] : inspectModuleImports(manifest.text, manifest.fileName)
    .filter((reference) => reference.runtime).map((reference) => reference.specifier).sort();
  if (JSON.stringify(dependencies) !== JSON.stringify([
    "../core/client.js", "../evm/identities.js", "./default-stock-token-contract.js", "./product-identity.js", "zod",
  ])) violations.push("registry/default-stock-tokens.ts:unexpected_runtime_dependencies");
  const checker = program.getTypeChecker();
  const lookup = moduleExportSymbol(program, checker, defaultStockTokenManifestModule, "defaultStockTokenRank");
  if (lookup === undefined ||
    moduleExportSymbol(program, checker, registryClientEntryModule, "defaultStockTokenRank") !== lookup) {
    violations.push("registry/client.ts:default_lookup_owner");
  }
  return violations.sort();
};

const mcpAppHttpLimitGraphViolations = (
  program: ts.Program,
  productFiles: ReadonlySet<string>,
): readonly string[] => {
  const graph = productModuleGraph(program, productFiles, mcpAppViewEntryModule);
  const violations = [...graph.violations];
  if (!graph.visited.has(httpLimitsModule)) {
    violations.push(`${sourceName(mcpAppViewEntryModule)}:http_limits_unreachable`);
  }
  if (graph.visited.has(httpBoundaryModule)) {
    violations.push(`${sourceName(mcpAppViewEntryModule)}:http_boundary_reachable`);
  }
  return violations.sort();
};

const topLevelVariableDeclaration = (
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | undefined => {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration;
      }
    }
  }
  return undefined;
};

const defaultStockTokenSymbolViolations = (
  program: ts.Program,
  productCodeFiles: ReadonlySet<string>,
): readonly string[] => {
  const checker = program.getTypeChecker();
  const countSymbol = moduleExportSymbol(
    program,
    checker,
    defaultStockTokenContractModule,
    "defaultStockTokenCount",
  );
  const rankSymbol = moduleExportSymbol(
    program,
    checker,
    defaultStockTokenContractModule,
    "defaultStockTokenRankSchema",
  );
  const manifestSchemaSymbol = moduleExportSymbol(
    program,
    checker,
    defaultStockTokenManifestModule,
    "defaultStockTokenManifestSchema",
  );
  const contractSource = program.getSourceFile(defaultStockTokenContractModule);
  const manifestSource = program.getSourceFile(defaultStockTokenManifestModule);
  const accountSource = program.getSourceFile(accountAssetContractsModule);
  const rankDeclaration = contractSource === undefined
    ? undefined
    : topLevelVariableDeclaration(contractSource, "defaultStockTokenRankSchema");
  const manifestDeclaration = manifestSource === undefined
    ? undefined
    : topLevelVariableDeclaration(manifestSource, "defaultStockTokenManifestSchema");
  const cursorShapeDeclaration = accountSource === undefined
    ? undefined
    : topLevelVariableDeclaration(accountSource, "defaultCursorShape");
  const declarationSymbol = (declaration: ts.VariableDeclaration | undefined) =>
    declaration === undefined || !ts.isIdentifier(declaration.name)
      ? undefined
      : resolvedSymbol(checker, checker.getSymbolAtLocation(declaration.name));
  const rankDeclarationSymbol = declarationSymbol(rankDeclaration);
  const manifestDeclarationSymbol = declarationSymbol(manifestDeclaration);
  const cursorShapeSymbol = declarationSymbol(cursorShapeDeclaration);
  if (
    countSymbol === undefined || rankSymbol === undefined ||
    manifestSchemaSymbol === undefined || cursorShapeSymbol === undefined ||
    rankDeclarationSymbol !== rankSymbol || manifestDeclarationSymbol !== manifestSchemaSymbol
  ) {
    return ["default_stock_token_contract_symbols_missing"];
  }

  const rankMaximumCountNode = (() => {
    const initializer = rankDeclaration?.initializer;
    if (
      initializer === undefined || !ts.isCallExpression(initializer) ||
      !ts.isPropertyAccessExpression(initializer.expression) ||
      initializer.expression.name.text !== "max" || initializer.arguments.length !== 1
    ) return undefined;
    const maximum = initializer.arguments[0];
    return maximum !== undefined && ts.isBinaryExpression(maximum) &&
      maximum.operatorToken.kind === ts.SyntaxKind.MinusToken &&
      ts.isIdentifier(maximum.left) && ts.isNumericLiteral(maximum.right) &&
      maximum.right.text === "1"
      ? maximum.left
      : undefined;
  })();
  const manifestLengthCountNode = (() => {
    const initializer = manifestDeclaration?.initializer;
    if (
      initializer === undefined || !ts.isCallExpression(initializer) ||
      !ts.isPropertyAccessExpression(initializer.expression) ||
      initializer.expression.name.text !== "superRefine"
    ) return undefined;
    const strictCall = initializer.expression.expression;
    if (
      !ts.isCallExpression(strictCall) ||
      !ts.isPropertyAccessExpression(strictCall.expression) ||
      strictCall.expression.name.text !== "strict"
    ) return undefined;
    const objectCall = strictCall.expression.expression;
    if (
      !ts.isCallExpression(objectCall) ||
      !ts.isPropertyAccessExpression(objectCall.expression) ||
      objectCall.expression.getText(manifestSource) !== "z.object"
    ) return undefined;
    const shape = objectCall.arguments[0];
    if (shape === undefined || !ts.isObjectLiteralExpression(shape)) return undefined;
    const assets = shape.properties.filter((property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) &&
      property.name.text === "assets");
    if (assets.length !== 1) return undefined;
    const lengthCall = assets[0]!.initializer;
    if (
      !ts.isCallExpression(lengthCall) ||
      !ts.isPropertyAccessExpression(lengthCall.expression) ||
      lengthCall.expression.name.text !== "length" || lengthCall.arguments.length !== 1
    ) return undefined;
    const length = lengthCall.arguments[0];
    return length !== undefined && ts.isIdentifier(length) ? length : undefined;
  })();
  const cursorRankNode = (() => {
    const initializer = cursorShapeDeclaration?.initializer;
    if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) return undefined;
    const ranks = initializer.properties.filter((property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) &&
      property.name.text === "rank");
    if (ranks.length !== 1) return undefined;
    const rank = ranks[0]!.initializer;
    return ts.isIdentifier(rank) ? rank : undefined;
  })();

  const violations: string[] = [];
  const countFiles = new Set<string>();
  const rankFiles = new Set<string>();
  let manifestLengthUses = 0;
  let rankMaximumUses = 0;
  let cursorRankUses = 0;

  for (const sourceFile of program.getSourceFiles()) {
    const file = resolve(sourceFile.fileName);
    if (!productCodeFiles.has(file)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const symbol = resolvedSymbol(checker, checker.getSymbolAtLocation(node));
        if (symbol === countSymbol) {
          countFiles.add(file);
          if (file === defaultStockTokenContractModule) {
            if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) {
              // The exported owner declaration.
            } else if (node === rankMaximumCountNode) rankMaximumUses += 1;
            else violations.push(`${sourceName(file)}:unexpected_count_use`);
          } else if (file === defaultStockTokenManifestModule) {
            if (
              ts.isImportSpecifier(node.parent) &&
              node.parent.name === node &&
              node.parent.propertyName === undefined &&
              node.text === "defaultStockTokenCount"
            ) {
              // The exact import binding.
            } else if (node === manifestLengthCountNode) manifestLengthUses += 1;
            else violations.push(`${sourceName(file)}:unexpected_count_use`);
          } else violations.push(`${sourceName(file)}:count_reference`);
        }
        if (symbol === rankSymbol) {
          rankFiles.add(file);
          if (file === defaultStockTokenContractModule) {
            if (!(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
              violations.push(`${sourceName(file)}:unexpected_rank_use`);
            }
          } else if (file === registryClientEntryModule) {
            if (!ts.isExportSpecifier(node.parent)) {
              violations.push(`${sourceName(file)}:unexpected_rank_use`);
            }
          } else if (file === accountAssetContractsModule) {
            if (ts.isImportSpecifier(node.parent)) {
              // The exact client-entry import binding.
            } else if (node === cursorRankNode) cursorRankUses += 1;
            else violations.push(`${sourceName(file)}:unexpected_rank_use`);
          } else violations.push(`${sourceName(file)}:rank_reference`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const exactFiles = (actual: ReadonlySet<string>, expected: readonly string[]): boolean =>
    actual.size === expected.length && expected.every((file) => actual.has(file));
  if (!exactFiles(countFiles, [defaultStockTokenContractModule, defaultStockTokenManifestModule])) {
    violations.push(`count_files:${[...countFiles].map(sourceName).sort().join(",")}`);
  }
  if (!exactFiles(rankFiles, [
    accountAssetContractsModule,
    defaultStockTokenContractModule,
    registryClientEntryModule,
  ])) violations.push(`rank_files:${[...rankFiles].map(sourceName).sort().join(",")}`);
  if (manifestLengthUses !== 1) violations.push(`manifest_length_uses:${manifestLengthUses}`);
  if (rankMaximumUses !== 1) violations.push(`rank_maximum_uses:${rankMaximumUses}`);
  if (cursorRankUses !== 1) violations.push(`cursor_rank_uses:${cursorRankUses}`);
  return violations.sort();
};

const defaultCursorStructureViolations = (program: ts.Program): readonly string[] => {
  const parsed = program.getSourceFile(accountAssetContractsModule);
  if (parsed === undefined) return ["account_asset_contracts_source_missing"];
  const checker = program.getTypeChecker();
  const declaration = (name: string): ts.VariableDeclaration | undefined =>
    topLevelVariableDeclaration(parsed, name);
  const declarationSymbol = (name: string): ts.Symbol | undefined => {
    const owner = declaration(name);
    return owner === undefined || !ts.isIdentifier(owner.name)
      ? undefined
      : resolvedSymbol(checker, checker.getSymbolAtLocation(owner.name));
  };
  const spreadNames = new Map<ts.Symbol, string>();
  for (const [name, label] of [
    ["defaultCursorShape", "...defaultCursorShape"],
    ["currentOfficialSnapshotRevisionShape", "...currentOfficialSnapshotRevisionShape"],
    ["unavailableOfficialSnapshotRevisionShape", "...unavailableOfficialSnapshotRevisionShape"],
    ["cursorIdentityShape", "...cursorIdentityShape"],
  ] as const) {
    const symbol = declarationSymbol(name);
    if (symbol === undefined) return [`${name}:owner_missing`];
    spreadNames.set(symbol, label);
  }
  const rankSymbol = moduleExportSymbol(
    program,
    checker,
    defaultStockTokenContractModule,
    "defaultStockTokenRankSchema",
  );
  const propertyName = (property: ts.ObjectLiteralElementLike): string => {
    if (ts.isSpreadAssignment(property)) {
      const symbol = ts.isIdentifier(property.expression)
        ? resolvedSymbol(checker, checker.getSymbolAtLocation(property.expression))
        : undefined;
      return symbol === undefined ? "...invalid" : spreadNames.get(symbol) ?? "...invalid";
    }
    if (
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
    ) return property.name.text;
    return "invalid";
  };
  const strictJsonObject = (node: ts.Expression): ts.ObjectLiteralExpression | undefined => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "strict" ||
      !ts.isCallExpression(node.expression.expression) ||
      !ts.isIdentifier(node.expression.expression.expression) ||
      node.expression.expression.expression.text !== "jsonObject"
    ) return undefined;
    const input = node.expression.expression.arguments[0];
    return input !== undefined && ts.isObjectLiteralExpression(input) ? input : undefined;
  };

  const violations: string[] = [];
  const base = declaration("defaultCursorShape")?.initializer;
  if (base === undefined || !ts.isObjectLiteralExpression(base)) {
    violations.push("default_cursor_shape_missing");
  } else {
    if (base.properties.map(propertyName).join(",") !== "group,rank") {
      violations.push("default_cursor_shape_members");
    }
    const [group, rank] = base.properties;
    if (
      group === undefined || !ts.isPropertyAssignment(group) ||
      !ts.isCallExpression(group.initializer) ||
      !ts.isPropertyAccessExpression(group.initializer.expression) ||
      group.initializer.expression.getText(parsed) !== "z.literal" ||
      group.initializer.arguments[0]?.getText(parsed) !== '"default"'
    ) violations.push("default_cursor_group");
    if (
      rank === undefined || !ts.isPropertyAssignment(rank) ||
      !ts.isIdentifier(rank.initializer) ||
      resolvedSymbol(checker, checker.getSymbolAtLocation(rank.initializer)) !== rankSymbol
    ) violations.push("default_cursor_rank");
  }

  const cursor = declaration("accountAssetCursorSchema")?.initializer;
  const branches = cursor !== undefined && ts.isCallExpression(cursor) &&
    ts.isPropertyAccessExpression(cursor.expression) &&
    cursor.expression.getText(parsed) === "z.union" &&
    cursor.arguments[0] !== undefined && ts.isArrayLiteralExpression(cursor.arguments[0])
    ? cursor.arguments[0].elements
    : undefined;
  if (branches === undefined || branches.length !== 4) {
    violations.push("account_asset_cursor_union");
  } else {
    const expected = [
      "...defaultCursorShape,...currentOfficialSnapshotRevisionShape,...cursorIdentityShape",
      "...defaultCursorShape,...unavailableOfficialSnapshotRevisionShape,...cursorIdentityShape",
    ].sort();
    const actual = branches.flatMap((branch) => {
      const object = strictJsonObject(branch);
      if (object === undefined) return [];
      const names = object.properties.map(propertyName);
      return names.includes("...defaultCursorShape") ? [names.join(",")] : [];
    }).sort();
    if (actual.length !== expected.length ||
      expected.some((signature, index) => actual[index] !== signature)) {
      violations.push("default_cursor_branches");
    }
  }
  return violations.sort();
};

interface DefaultStockTokenArchitectureFixture {
  readonly canonicalProgram: ts.Program;
  readonly productCodeFiles: ReadonlySet<string>;
  readonly productFiles: ReadonlySet<string>;
}

let defaultStockTokenArchitectureFixture:
  Promise<DefaultStockTokenArchitectureFixture> | undefined;

const loadDefaultStockTokenArchitectureFixture = () => {
  defaultStockTokenArchitectureFixture ??= (async () => {
    const productFiles = new Set(
      (await collectProductSourceFiles(repositoryRoot)).map((file) => resolve(file)),
    );
    const productCodeFiles = new Set(
      [...productFiles].filter((file) => productCodeSourcePattern.test(file)),
    );
    return Object.freeze({
      canonicalProgram: createProductSourceProgram([...productCodeFiles]),
      productCodeFiles,
      productFiles,
    });
  })();
  return defaultStockTokenArchitectureFixture;
};

const requiredProgramSource = (program: ts.Program, file: string): string => {
  const sourceFile = program.getSourceFile(file);
  if (sourceFile === undefined) {
    throw new TypeError(`Product TypeScript program is missing ${sourceName(file)}.`);
  }
  return sourceFile.text;
};

const exactExternalIntegrationExportRules = new Map<string, Readonly<{
  expected: readonly string[];
  allowExternalReexports: boolean;
}>>([
  [walletConnectConfigurationModule, {
    expected: walletConnectConfigurationExports,
    allowExternalReexports: false,
  }],
  [robinhoodOfficialAssetSemanticContractModule, {
    expected: robinhoodOfficialAssetSemanticContractExports,
    allowExternalReexports: false,
  }],
  [robinhoodOfficialAssetSourceContractModule, {
    expected: robinhoodOfficialAssetSourceContractExports,
    allowExternalReexports: false,
  }],
  [robinhoodOfficialAssetAdapterModule, {
    expected: robinhoodOfficialAssetAdapterExports,
    allowExternalReexports: false,
  }],
  [sourcifyAdapterModule, {
    expected: sourcifyAdapterExports,
    allowExternalReexports: false,
  }],
  [registryServerEntryModule, {
    expected: registryServerEntryExports,
    allowExternalReexports: true,
  }],
  [registryClientEntryModule, {
    expected: registryClientEntryExports,
    allowExternalReexports: true,
  }],
]);

const externalIntegrationAuthorityViolations = (
  source: string,
  file: string,
  observedEdges?: Set<string>,
): readonly string[] => {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const localBindings =
    new Map<string, ReadonlySet<ExternalIntegrationAuthorityRule>>();
  const report = (kind: string, detail: string): void => {
    violations.push(`${sourceName(file)}:${kind}:${detail}`);
  };
  const targetRules = (
    specifier: ts.Expression | undefined,
  ): ReadonlyMap<string, ExternalIntegrationAuthorityRule> | undefined => {
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return undefined;
    const target = resolveSourceModule(file, specifier.text);
    return target === undefined ? undefined : externalIntegrationRulesByModule.get(target);
  };
  const directlyExposedRules = (
    expression: ts.Expression,
  ): ReadonlySet<ExternalIntegrationAuthorityRule> => {
    const exposed = new Set<ExternalIntegrationAuthorityRule>();
    const include = (
      rules: ReadonlySet<ExternalIntegrationAuthorityRule> | undefined,
    ): void => {
      if (rules === undefined) return;
      for (const rule of rules) exposed.add(rule);
    };
    const visitReturns = (body: ts.ConciseBody | undefined): void => {
      if (body === undefined) return;
      if (!ts.isBlock(body)) {
        visitValue(body);
        return;
      }
      const visit = (node: ts.Node): void => {
        if (node !== body && (
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isGetAccessorDeclaration(node) ||
          ts.isSetAccessorDeclaration(node) ||
          ts.isConstructorDeclaration(node)
        )) return;
        if (ts.isReturnStatement(node)) {
          if (node.expression !== undefined) visitValue(node.expression);
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(body);
    };
    const visitClassMembers = (
      members: ts.NodeArray<ts.ClassElement>,
    ): void => {
      for (const member of members) {
        if (isPrivateClassElement(member)) continue;
        if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
          visitValue(member.initializer);
        } else if (
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member) ||
          ts.isConstructorDeclaration(member)
        ) {
          visitReturns(member.body);
        }
      }
    };
    const visitValue = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        include(localBindings.get(node.text));
        return;
      }
      if (ts.isCallExpression(node)) {
        visitValue(node.expression);
        for (const argument of node.arguments) visitValue(argument);
        return;
      }
      if (ts.isNewExpression(node)) {
        visitValue(node.expression);
        for (const argument of node.arguments ?? []) visitValue(argument);
        return;
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        visitReturns(node.body);
        return;
      }
      if (
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        visitReturns(node.body);
        return;
      }
      if (ts.isClassExpression(node)) {
        visitClassMembers(node.members);
        return;
      }
      ts.forEachChild(node, visitValue);
    };
    visitValue(expression);
    return exposed;
  };
  const isPermittedResultEdge = (
    exportName: string,
    rule: ExternalIntegrationAuthorityRule,
  ): boolean =>
    externalIntegrationResultEdges.some((edge) =>
      edge.file === file &&
      edge.exportName === exportName &&
      edge.sourceModule === rule.module &&
      edge.sourceSymbol === rule.symbol);
  const isPermittedWalletApplicationComposition = (
    declaration: ts.VariableDeclaration,
    rules: ReadonlySet<ExternalIntegrationAuthorityRule>,
  ): boolean => {
    if (
      file !== walletApplicationModule ||
      !ts.isIdentifier(declaration.name) ||
      declaration.name.text !== "createWalletOwnerApplication" ||
      declaration.initializer === undefined ||
      !ts.isCallExpression(declaration.initializer) ||
      !ts.isIdentifier(declaration.initializer.expression) ||
      declaration.initializer.expression.text !==
        "createWalletOwnerApplicationFactory" ||
      declaration.initializer.arguments.length !== 1
    ) return false;
    const argument = declaration.initializer.arguments[0];
    if (argument === undefined || !ts.isIdentifier(argument)) return false;
    const argumentRules = localBindings.get(argument.text);
    return argumentRules !== undefined &&
      rules.size === 1 &&
      argumentRules.size === 1 &&
      [...rules][0]?.symbol === "createWalletConnectClient" &&
      [...argumentRules][0]?.symbol === "createWalletConnectClient";
  };

  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      const rules = targetRules(statement.moduleSpecifier);
      if (rules === undefined) continue;
      const bindings = statement.importClause?.namedBindings;
      if (statement.importClause?.name !== undefined) {
        report("default_import", statement.moduleSpecifier.getText(parsed));
      }
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        report("namespace_import", statement.moduleSpecifier.getText(parsed));
      } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          const rule = rules.get(imported);
          if (rule === undefined) continue;
          localBindings.set(element.name.text, new Set([rule]));
          observedEdges?.add(`import:${rule.module}:${rule.symbol}:${file}`);
          if (!rule.importers.has(file)) report("named_import", imported);
        }
      }
      continue;
    }

    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      const rules = targetRules(statement.moduleReference.expression);
      if (rules !== undefined) {
        report("import_equals", statement.moduleReference.expression?.getText(parsed) ?? "unknown");
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const rules = targetRules(statement.moduleSpecifier);
      if (rules !== undefined) {
        if (
          statement.exportClause === undefined ||
          ts.isNamespaceExport(statement.exportClause)
        ) {
          report("wildcard_reexport", statement.moduleSpecifier?.getText(parsed) ?? "local");
        } else {
          for (const element of statement.exportClause.elements) {
            const imported = (element.propertyName ?? element.name).text;
            const rule = rules.get(imported);
            if (rule === undefined) continue;
            observedEdges?.add(`reexport:${rule.module}:${rule.symbol}:${file}`);
            if (!rule.reexporters.has(file) || element.name.text !== imported) {
              report("reexport", imported);
            }
          }
        }
      } else if (
        statement.moduleSpecifier === undefined &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          const local = (element.propertyName ?? element.name).text;
          const rules = localBindings.get(local);
          if (rules !== undefined) {
            for (const rule of rules) report("local_reexport", rule.symbol);
          }
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      for (const rule of directlyExposedRules(statement.expression)) {
        report("default_reexport", rule.symbol);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          declaration.initializer === undefined ||
          !ts.isIdentifier(declaration.name)
        ) continue;
        const rules = directlyExposedRules(declaration.initializer);
        if (rules.size > 0) localBindings.set(declaration.name.text, rules);
        if (
          hasExportModifier(statement) &&
          !isPermittedWalletApplicationComposition(declaration, rules)
        ) {
          for (const rule of rules) {
            if (!isPermittedResultEdge(declaration.name.text, rule)) {
              report("exported_binding", rule.symbol);
            }
          }
        }
      }
      continue;
    }

    if (ts.isClassDeclaration(statement) && hasExportModifier(statement)) {
      for (const member of statement.members) {
        if (isPrivateClassElement(member)) continue;
        if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
          for (const rule of directlyExposedRules(member.initializer)) {
            report("exported_binding", rule.symbol);
          }
        } else if (
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)
        ) {
          const method = ts.factory.createArrowFunction(
            undefined,
            undefined,
            [],
            undefined,
            undefined,
            member.body ?? ts.factory.createBlock([]),
          );
          for (const rule of directlyExposedRules(method)) {
            report("exported_binding", rule.symbol);
          }
        }
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) &&
      hasExportModifier(statement) &&
      statement.body !== undefined
    ) {
      const functionValue = ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        undefined,
        statement.body,
      );
      for (const rule of directlyExposedRules(functionValue)) {
        report("exported_binding", rule.symbol);
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const rules = targetRules(node.arguments[0]);
        if (rules !== undefined) {
          report(isDynamicImport ? "dynamic_import" : "require", node.arguments[0]?.getText(parsed) ?? "unknown");
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (
        (
          ts.isPropertyAccessExpression(node.left) &&
          (
            (
              ts.isIdentifier(node.left.expression) &&
              node.left.expression.text === "exports"
            ) ||
            (
              ts.isPropertyAccessExpression(node.left.expression) &&
              ts.isIdentifier(node.left.expression.expression) &&
              node.left.expression.expression.text === "module" &&
              node.left.expression.name.text === "exports"
            )
          )
        ) ||
        (
          ts.isPropertyAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === "module" &&
          node.left.name.text === "exports"
        )
      )
    ) {
      for (const rule of directlyExposedRules(node.right)) {
        report("commonjs_reexport", rule.symbol);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);

  const exportRule = exactExternalIntegrationExportRules.get(file);
  if (exportRule !== undefined) {
    violations.push(...exactModuleExportViolations(
      source,
      file,
      exportRule.expected,
      exportRule.allowExternalReexports,
    )
      .map((violation) => `${sourceName(file)}:${violation}`));
  }
  return violations;
};

describe("runtime architecture boundary", () => {
  it("keeps operation handoff owners separate from immutable snapshot capacity", async () => {
    const [appContracts, sqliteSchema, walletContract, tokenContract, database] =
      await Promise.all([
        readFile(mcpAppContractsPath, "utf8"),
        readFile(runtimeSqliteSchemaPath, "utf8"),
        readFile(walletOperationContractPath, "utf8"),
        readFile(tokenCatalogContractPath, "utf8"),
        readFile(runtimeDatabasePath, "utf8"),
      ]);

    const operationDescriptorStart = appContracts.indexOf(
      "export const operationToolResultLimits",
    );
    const snapshotDescriptorStart = appContracts.indexOf(
      "export const presentationSnapshotDescriptorSchema",
    );
    expect(operationDescriptorStart).toBeGreaterThan(-1);
    expect(snapshotDescriptorStart).toBeGreaterThan(operationDescriptorStart);
    const operationDescriptorSource = appContracts.slice(
      operationDescriptorStart,
      snapshotDescriptorStart,
    );
    expect(operationDescriptorSource).toContain("inputBytes: requestBodyLimitBytes");
    expect(operationDescriptorSource)
      .toContain("resultBytes: internalCanonicalJsonResponseLimitBytes");
    expect(operationDescriptorSource).not.toContain("presentationSnapshotLimits");

    expect(sqliteSchema).toContain(
      "length(operation_json) BETWEEN 2 AND ${persistedOperationJsonLimits.walletBytes}",
    );
    expect(sqliteSchema).toContain(
      "length(operation_json) BETWEEN 2 AND ${persistedOperationJsonLimits.tokenSelectionBytes}",
    );
    expect(walletContract).not.toContain("walletDirectActionMaximumBytes");
    expect(walletContract.match(/superRefine\(validateWalletOperationActionBytes\)/gu))
      .toHaveLength(2);
    expect(tokenContract).toContain("historicalInspection: z.null()");

    // Runtime storage tests execute each actual SQL projection with otherwise
    // valid oversize bytes and observe the driver result before canonical parsing.
    const operationReadStart = database.indexOf("const readOperationRows");
    const operationReadEnd = database.indexOf("interface TokenSelectionStorageRecord", operationReadStart);
    const operationRead = database.slice(operationReadStart, operationReadEnd);
    expect(operationRead).toContain("${walletOperationSelect}");
    expect(operationRead).toContain("${tokenSelectionOperationSelect}");
    expect(operationRead.match(/\.iterate\(\)/gu)).toHaveLength(2);
    expect(operationRead).not.toContain(".all()");
    expect(database).not.toContain("preflightOperationJsonRows");
  });

  it("owns Token inspection cache admission before payload reads and mutations", async () => {
    const [sqliteSchema, database] = await Promise.all([
      readFile(runtimeSqliteSchemaPath, "utf8"),
      readFile(runtimeDatabasePath, "utf8"),
    ]);
    expect(sqliteSchema.match(/export const tokenInspectionPersistenceLimits/gu))
      .toHaveLength(1);
    expect(sqliteSchema).toContain("resultBytes: 65_536");
    expect(sqliteSchema).toContain("rows: 4_096");
    expect(sqliteSchema).toContain("aggregateResultBytes: 67_108_864");
    for (const relationship of [
      "Object.values(tokenInspectionPersistenceLimits).some",
      "!Number.isSafeInteger(maximumTokenInspectionResultBytes)",
      "tokenInspectionPersistenceLimits.resultBytes < 2",
      "tokenInspectionPersistenceLimits.rows < 1",
      "tokenInspectionPersistenceLimits.aggregateResultBytes < tokenInspectionPersistenceLimits.resultBytes",
      "tokenInspectionPersistenceLimits.aggregateResultBytes >= maximumTokenInspectionResultBytes",
    ]) expect(sqliteSchema).toContain(relationship);
    expect(sqliteSchema).toContain(
      "length(result_bytes) BETWEEN 2 AND ${tokenInspectionPersistenceLimits.resultBytes}",
    );
    expect(sqliteSchema).not.toContain("canonicalJsonObjectSqlCheck");
    expect(sqliteSchema).not.toContain("result_json");

    const preflightStart = database.indexOf("const preflightTokenInspectionRows");
    const retentionReadStart = database.indexOf(
      "const readTokenInspectionRetentionEntries",
      preflightStart,
    );
    expect(preflightStart).toBeGreaterThan(-1);
    expect(retentionReadStart).toBeGreaterThan(preflightStart);
    const preflight = database.slice(preflightStart, retentionReadStart);
    expect(preflight).toContain("SELECT count(*) AS rowCount FROM token_contract_inspection");
    expect(preflight).toContain("typeof(result_bytes) AS storageClass");
    expect(preflight).toContain("octet_length(result_bytes) AS byteLength");
    expect(preflight).not.toContain("result_bytes AS resultBytes");

    const inspectionReadStart = database.indexOf("const readTokenInspectionRows");
    const catalogReadStart = database.indexOf("const readTokenCatalogRows", inspectionReadStart);
    const catalogReadEnd = database.indexOf("const validateDatabaseState", catalogReadStart);
    expect(inspectionReadStart).toBeGreaterThan(retentionReadStart);
    expect(catalogReadStart).toBeGreaterThan(inspectionReadStart);
    const inspectionRead = database.slice(inspectionReadStart, catalogReadStart);
    const preflightCall = inspectionRead.indexOf("preflightTokenInspectionRows(database)");
    const payloadRead = inspectionRead.indexOf("${tokenInspectionSelect}");
    expect(preflightCall).toBeGreaterThan(-1);
    expect(payloadRead).toBeGreaterThan(preflightCall);
    expect(inspectionRead).toContain(
      "rowCount !== capacity.rowCount || aggregateResultBytes !== capacity.aggregateResultBytes",
    );
    expect(inspectionRead).not.toContain("tokenSelectionRecordSelect");
    const catalogRead = database.slice(catalogReadStart, catalogReadEnd);
    const transaction = catalogRead.indexOf(
      "database.transaction(() => readTokenInspectionRows(database)).deferred()",
    );
    const selectionRead = catalogRead.indexOf("${tokenSelectionRecordSelect}");
    expect(transaction).toBeGreaterThan(-1);
    expect(selectionRead).toBeGreaterThan(transaction);
    expect(catalogRead).not.toContain("database.inTransaction");

    const { canonicalProgram } = await loadDefaultStockTokenArchitectureFixture();
    expect(tokenSelectionWriteOrderViolations(canonicalProgram)).toEqual([]);
  });

  it("detects account insertion before the produced-size checks even when rollback hides it", async () => {
    const { canonicalProgram, productCodeFiles } = await loadDefaultStockTokenArchitectureFixture();
    const source = requiredProgramSource(canonicalProgram, runtimeDatabasePath);
    const start = source.indexOf("          this.#database.prepare(`INSERT INTO account(", source.indexOf("private applyTokenSelectionChange"));
    const endMarker = "          decodeStoredAccountRecordKey(accountRows[0]);";
    const end = source.indexOf(endMarker, start) + endMarker.length;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const insertion = source.slice(start, end);
    const moved = source.replace(insertion, "").replace(
      "        let preparedInspection: Readonly<{",
      `        if (action.review.kind === "add") {\n${insertion}\n        }\n        let preparedInspection: Readonly<{`,
    );
    const program = createProductSourceProgram([...productCodeFiles], new Map([[runtimeDatabasePath, moved]]), canonicalProgram);
    expect(tokenSelectionWriteOrderViolations(program)).toEqual([
      "cache_size_before_write", "operation_size_before_write",
    ]);
  }, 20_000);

  it("keeps Local HTTP transport identities out of the MCP App graph", async () => {
    const { canonicalProgram, productCodeFiles, productFiles } =
      await loadDefaultStockTokenArchitectureFixture();
    expect(mcpAppHttpLimitGraphViolations(canonicalProgram, productFiles)).toEqual([]);

    const presentationSource = requiredProgramSource(
      canonicalProgram,
      presentationSnapshotModule,
    );
    const adversarialProgram = createProductSourceProgram(
      [...productCodeFiles],
      new Map([[
        presentationSnapshotModule,
        `${presentationSource}\nimport "./http-boundary.js";\n`,
      ]]),
      canonicalProgram,
    );
    expect(mcpAppHttpLimitGraphViolations(adversarialProgram, productFiles))
      .toContain("interfaces/mcp-app/view/main.ts:http_boundary_reachable");
  }, 20_000);

  it("keeps one client-safe default Stock Token count and rank contract", async () => {
    const { canonicalProgram: program, productCodeFiles, productFiles } =
      await loadDefaultStockTokenArchitectureFixture();
    const contractSource = requiredProgramSource(program, defaultStockTokenContractModule);
    const registryServerSource = requiredProgramSource(program, registryServerEntryModule);
    const registryClientSource = requiredProgramSource(program, registryClientEntryModule);

    expect(exactModuleExportViolations(
      contractSource,
      defaultStockTokenContractModule,
      defaultStockTokenContractExports,
      false,
    )).toEqual([]);
    expect(exactModuleExportViolations(
      registryServerSource,
      registryServerEntryModule,
      registryServerEntryExports,
      true,
    )).toEqual([]);
    expect(exactModuleExportViolations(
      registryClientSource,
      registryClientEntryModule,
      registryClientEntryExports,
      true,
    )).toEqual([]);
    expect(defaultStockTokenSymbolViolations(program, productCodeFiles)).toEqual([]);
    expect(defaultCursorStructureViolations(program)).toEqual([]);
    expect(defaultStockTokenClientGraphViolations(
      program,
      productFiles,
      registryClientEntryModule,
    )).toEqual([]);
    expect(defaultStockTokenClientGraphViolations(
      program,
      productFiles,
      mcpAppViewEntryModule,
    )).toEqual([]);
  }, 20_000);

  it("rejects default Stock Token ownership and client-graph bypasses", async () => {
    const { canonicalProgram, productCodeFiles, productFiles } =
      await loadDefaultStockTokenArchitectureFixture();
    const contractSource = requiredProgramSource(
      canonicalProgram,
      defaultStockTokenContractModule,
    );
    const manifestSource = requiredProgramSource(
      canonicalProgram,
      defaultStockTokenManifestModule,
    );
    const registryClientSource = requiredProgramSource(canonicalProgram, registryClientEntryModule);
    const accountSource = requiredProgramSource(canonicalProgram, accountAssetContractsModule);
    const applicationSource = requiredProgramSource(canonicalProgram, accountAssetApplicationModule);
    const replaceUnique = (
      source: string,
      target: string,
      replacement: string,
      label: string,
    ): string => {
      if (source.split(target).length !== 2) {
        throw new TypeError(`Default Stock Token ${label} mutation target is not unique.`);
      }
      return source.replace(target, replacement);
    };

    const cursorMarker = [
      "    ...defaultCursorShape,",
      "    ...currentOfficialSnapshotRevisionShape,",
    ].join("\n");
    const rankOwner = [
      "export const defaultStockTokenRankSchema = z.number()",
      "  .int()",
      "  .min(0)",
      "  .max(defaultStockTokenCount - 1);",
    ].join("\n");
    const duplicateRankOwner = [
      "if (false) {",
      "  const defaultStockTokenRankSchema = z.number()",
      "    .int()",
      "    .min(0)",
      "    .max(defaultStockTokenCount - 1);",
      "  void defaultStockTokenRankSchema;",
      "}",
      "",
      "export const defaultStockTokenRankSchema = z.number()",
      "  .int()",
      "  .min(0)",
      "  .max(4);",
    ].join("\n");
    const literalManifestLength = replaceUnique(
      manifestSource,
      "  assets: z.array(defaultStockTokenEntrySchema).length(defaultStockTokenCount),",
      "  assets: z.array(defaultStockTokenEntrySchema).length(5),",
      "manifest length",
    );
    const duplicateManifestOwner = replaceUnique(
      literalManifestLength,
      "export const defaultStockTokenManifestSchema = z.object({",
      [
        "if (false) {",
        "  const defaultStockTokenManifestSchema = z.object({",
        "    assets: z.array(defaultStockTokenEntrySchema).length(defaultStockTokenCount),",
        "  });",
        "  void defaultStockTokenManifestSchema;",
        "}",
        "",
        "export const defaultStockTokenManifestSchema = z.object({",
      ].join("\n"),
      "manifest owner",
    );
    const cursorOwner = [
      "const defaultCursorShape = {",
      '  group: z.literal("default"),',
      "  rank: defaultStockTokenRankSchema,",
      "};",
    ].join("\n");
    const duplicateCursorOwner = [
      "if (false) {",
      "  const defaultCursorShape = {",
      '    group: z.literal("default"),',
      "    rank: defaultStockTokenRankSchema,",
      "  };",
      "  void defaultCursorShape;",
      "}",
      "",
      "const defaultCursorShape = {",
      '  group: z.literal("default"),',
      "  rank: z.number().int().min(0).max(4),",
      "};",
    ].join("\n");
    const duplicateCursorOwnerSource = replaceUnique(
      accountSource,
      cursorOwner,
      duplicateCursorOwner,
      "cursor owner",
    );
    // Avoid satisfying the duplicate-owner rank diagnostic with the branch mutation.
    const adversarialAccountSource = replaceUnique(duplicateCursorOwnerSource, cursorMarker, [
      "    ...defaultCursorShape,",
      "    rank: defaultCursorShape.rank,",
      "    ...currentOfficialSnapshotRevisionShape,",
    ].join("\n"), "cursor override");
    const adversarialProgram = createProductSourceProgram(
      [...productCodeFiles],
      new Map([
        [defaultStockTokenContractModule, replaceUnique(
          contractSource,
          rankOwner,
          duplicateRankOwner,
          "rank owner",
        )],
        [defaultStockTokenManifestModule, duplicateManifestOwner],
        [accountAssetContractsModule, adversarialAccountSource],
        [accountAssetApplicationModule, `${applicationSource}
import { defaultStockTokenCount } from "../registry/default-stock-token-contract.js";
void defaultStockTokenCount;
`],
        [registryClientEntryModule, `${registryClientSource}
export { defaultStockTokenManifest } from "./default-stock-tokens.js";
void import("./" + "default-stock-tokens.js");
`],
      ]),
      canonicalProgram,
    );
    const adversarialOwnerViolations = defaultStockTokenSymbolViolations(
      adversarialProgram,
      productCodeFiles,
    );
    expect(adversarialOwnerViolations)
      .toContain("account-assets/application.ts:count_reference");
    expect(adversarialOwnerViolations)
      .toContain("registry/default-stock-token-contract.ts:unexpected_count_use");
    expect(adversarialOwnerViolations)
      .toContain("registry/default-stock-tokens.ts:unexpected_count_use");
    expect(adversarialOwnerViolations)
      .toContain("account-assets/contracts.ts:unexpected_rank_use");
    const adversarialCursorViolations = defaultCursorStructureViolations(adversarialProgram);
    expect(adversarialCursorViolations)
      .toContain("default_cursor_rank");
    expect(adversarialCursorViolations)
      .toContain("default_cursor_branches");
    const clientLeak = defaultStockTokenClientGraphViolations(
      adversarialProgram,
      productFiles,
      registryClientEntryModule,
    );
    expect(clientLeak).toContain("registry/client.ts:nonliteral_runtime_load");
    expect(exactModuleExportViolations(
      requiredProgramSource(adversarialProgram, registryClientEntryModule),
      registryClientEntryModule, registryClientEntryExports, true,
    )).toContain("unexpected_export:defaultStockTokenManifest");
    expect(defaultStockTokenClientGraphViolations(
      adversarialProgram,
      productFiles,
      mcpAppViewEntryModule,
    )).toContain("registry/client.ts:nonliteral_runtime_load");
  }, 20_000);

  it("allows the shared default lookup but rejects server, Node and replacement owners", async () => {
    const { canonicalProgram, productCodeFiles, productFiles } = await loadDefaultStockTokenArchitectureFixture();
    const manifest = requiredProgramSource(canonicalProgram, defaultStockTokenManifestModule);
    const contract = requiredProgramSource(canonicalProgram, defaultStockTokenContractModule);
    const client = requiredProgramSource(canonicalProgram, registryClientEntryModule);
    const variants = [
      [defaultStockTokenManifestModule, manifest.replace('"../core/client.js"', '"../core/index.js"'),
        "registry/default-stock-tokens.ts:unexpected_runtime_dependencies", "server_entry:core/index.ts"],
      [defaultStockTokenContractModule, `${contract}\nimport "node:fs";\n`,
        "registry/default-stock-token-contract.ts:node_builtin:node:fs"],
      [defaultStockTokenContractModule, `${contract}\nimport "fs";\n`,
        "registry/default-stock-token-contract.ts:node_builtin:fs"],
      [defaultStockTokenManifestModule, `${manifest}\nimport "./official-assets.js";\n`,
        "registry/default-stock-tokens.ts:unexpected_runtime_dependencies"],
      [registryClientEntryModule, client.replace(
        'export { defaultStockTokenRank } from "./default-stock-tokens.js";',
        "export const defaultStockTokenRank = (_address: string): number | undefined => undefined;",
      ), "registry/client.ts:default_lookup_owner"],
    ] as const;
    for (const [file, source, expected, serverEntry] of variants) {
      const program = createProductSourceProgram([...productCodeFiles], new Map([[file, source]]), canonicalProgram);
      for (const root of [registryClientEntryModule, mcpAppViewEntryModule]) {
        const violations = defaultStockTokenClientGraphViolations(program, productFiles, root);
        expect(violations).toContain(expected);
        if (serverEntry !== undefined) expect(violations).toContain(`${sourceName(root)}:${serverEntry}`);
      }
    }
  }, 30_000);

  it("enforces current package and exact dynamic-execution owners", async () => {
    const policy = await loadPackagePolicy();
    const violations: string[] = [];
    for (const file of await collectProductSourceFiles(repositoryRoot)) {
      const audit = await inspectSourceFile(file);
      violations.push(...moduleImportPolicyViolations(file, audit.moduleImports, policy));
      violations.push(...directCodeExecutionViolations(
        file,
        audit.directCodeExecutions,
        repositoryRoot,
      ));
    }
    const productProgram = createIsolatedProductSourceProgram(uniswapV2SdkFile);
    violations.push(...uniswapV2SdkLoadBoundaryViolations(productProgram, policy));
    expect(violations).toEqual([]);
  }, 15_000);

  it("requires every non-core product consumer to use its exact curated core entry point", async () => {
    const violations: string[] = [];
    for (const file of await collectSourceFiles(sourceRoot)) {
      if (file.startsWith(`${coreRoot}${sep}`)) continue;
      for (const reference of (await inspectSourceFile(file)).moduleImports) {
        if (reference.specifier === undefined) continue;
        const target = resolvesInsideCore(file, reference.specifier);
        if (target !== undefined) {
          const consumer = relative(sourceRoot, file).split(sep).join("/");
          const allowed = clientCoreConsumers.has(consumer)
            ? target === "client.js"
            : target === "index.js";
          if (!allowed) violations.push(`${consumer}:${reference.specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps feature modules out of the runtime entry point and composition implementation", async () => {
    const violations: string[] = [];
    for (const file of await collectSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      for (const reference of (await inspectSourceFile(file)).moduleImports) {
        if (reference.specifier === undefined) continue;
        const target = resolveSourceModule(file, reference.specifier);
        if (target === runtimeEntryPoint && file !== resolve(sourceRoot, "cli.ts")) {
          violations.push(`${name}:runtime-entry`);
        }
        if (target === runtimeComposition && file !== runtimeEntryPoint) {
          violations.push(`${name}:runtime-composition`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the product chain literal in its single code owner and derives its numeric form", async () => {
    const productChainLiteralOwners: string[] = [];
    const productChainNumericLiteralOwners: string[] = [];
    for (const file of await collectSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      const source = await readFile(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && node.text === "eip155:4663") {
          productChainLiteralOwners.push(name);
        }
        if (ts.isNumericLiteral(node) && node.text === "4663") {
          productChainNumericLiteralOwners.push(name);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect([...new Set(productChainLiteralOwners)]).toEqual(["registry/product-identity.ts"]);
    expect(productChainNumericLiteralOwners).toEqual([]);
  });

  it("keeps Wallet operation vocabulary and transport binding in their final owners", async () => {
    const [
      operationState,
      operationContract,
      toolContracts,
      operationBindings,
      mcp,
    ] = await Promise.all([
      parseSource(resolve(sourceRoot, "wallet/operation-state.ts")),
      parseSource(resolve(sourceRoot, "wallet/operation-contract.ts")),
      parseSource(resolve(sourceRoot, "interfaces/operation-tool-contracts.ts")),
      parseSource(resolve(sourceRoot, "interfaces/operation-bindings.ts")),
      parseSource(resolve(sourceRoot, "interfaces/mcp.ts")),
    ]);
    const declaration = (source: ts.SourceFile, name: string): ts.VariableDeclaration => {
      const found = sourceDescendants(source).find((node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
      if (found === undefined) throw new TypeError(`Missing declaration: ${name}`);
      return found;
    };
    const identifierNames = (node: ts.Node): readonly string[] =>
      sourceDescendants(node)
        .filter((descendant): descendant is ts.Identifier => ts.isIdentifier(descendant))
        .map((identifier) => identifier.text);
    const initiators = declaration(operationState, "walletInitiators");
    expect(sourceDescendants(initiators)
      .filter((node): node is ts.StringLiteralLike => ts.isStringLiteralLike(node))
      .map((node) => node.text)).toEqual(["cli", "mcp_app"]);

    const initiatorSchema = declaration(operationContract, "walletInitiatorSchema");
    expect(identifierNames(initiatorSchema)).toContain("walletInitiators");
    const directActionSchema = declaration(operationContract, "walletDirectActionSchema");
    expect(identifierNames(directActionSchema)).toContain("walletInitiatorSchema");

    const declaredTools = declaration(toolContracts, "operationToolContracts");
    expect(identifierNames(declaredTools)).toContain("walletManagementContracts");
    expect(identifierNames(declaredTools)).not.toContain("operationControlResources");

    const resources = declaration(operationBindings, "operationControlResources");
    expect(identifierNames(resources)).not.toContain("walletManagementContracts");
    const bindings = declaration(operationBindings, "operationInterfaceBindings");
    expect(identifierNames(bindings)).toContain("operationToolContracts");
    expect(identifierNames(bindings)).not.toContain("RouteMethod");

    const mcpOperationTool = declaration(mcp, "operationTool");
    expect(identifierNames(mcpOperationTool)).toContain("resolveLocalOperationIdentity");
    expect(sourceDescendants(mcpOperationTool)
      .filter((node): node is ts.StringLiteralLike => ts.isStringLiteralLike(node))
      .map((node) => node.text)
      .filter((value) => ["GET", "POST", "DELETE"].includes(value))).toEqual([]);
  });

  it("keeps runtime finite vocabularies and reserved paths in their exact owners", async () => {
    const finiteOwners = {
      routeMethods: [] as string[],
      routeMutations: [] as string[],
      routeStatuses: [] as string[],
      requestBodies: [] as string[],
      availability: [] as string[],
      supportLevels: [] as string[],
      interactionInterfaces: [] as string[],
      rpcSourceOwners: [] as string[],
    };
    const pathOwners = {
      runtimeIdentityPath: [] as string[],
      publicApiPrefix: [] as string[],
      internalApiPrefix: [] as string[],
      localControlApiPrefix: [] as string[],
    };
    const records: ReadonlyArray<Readonly<{
      expected: readonly string[];
      key: keyof typeof finiteOwners;
      kind: LiteralVocabulary["kind"];
    }>> = [
      { expected: ["GET", "POST", "DELETE"], key: "routeMethods", kind: "string" },
      { expected: ["none", "declared_control"], key: "routeMutations", kind: "string" },
      { expected: ["200", "201"], key: "routeStatuses", kind: "number" },
      { expected: ["none", "route_json"], key: "requestBodies", kind: "string" },
      { expected: ["unavailable", "internal", "available"], key: "availability", kind: "string" },
      {
        expected: ["L0_discovered", "L1_analyzed", "L2_reviewed", "L3_executable", "L4_receipt_verified"],
        key: "supportLevels",
        kind: "string",
      },
      { expected: ["cli", "mcp_app"], key: "interactionInterfaces", kind: "string" },
      { expected: ["Robinhood", "user_configured"], key: "rpcSourceOwners", kind: "string" },
    ];
    const finiteVocabularyMatches = (root: ts.Node): readonly (keyof typeof finiteOwners)[] => {
      const matches: (keyof typeof finiteOwners)[] = [];
      const visit = (node: ts.Node): void => {
        for (const vocabulary of [literalVocabulary(node), comparisonVocabulary(node)]) {
          if (vocabulary === undefined) continue;
          for (const record of records) {
            if (vocabulary.kind === record.kind &&
              hasExactMembers(vocabulary.values, record.expected)) {
              matches.push(record.key);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(root);
      return matches;
    };

    const counterexample = ts.createSourceFile(
      "finite-vocabulary-counterexample.ts",
      [
        'const reorderedMethods = ["DELETE", "GET", "POST"] as const;',
        'type RepeatedMethods = "POST" | "DELETE" | "GET";',
        "type ReorderedStatuses = 201 | 200;",
        'type ReorderedInteractions = "mcp_app" | "cli";',
        'type ReorderedRpcOwners = "user_configured" | "Robinhood";',
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
    );
    expect([...finiteVocabularyMatches(counterexample)].sort()).toEqual([
      "interactionInterfaces",
      "routeMethods",
      "routeMethods",
      "routeStatuses",
      "rpcSourceOwners",
    ]);

    const comparisonCounterexample = ts.createSourceFile(
      "finite-vocabulary-comparison-counterexample.ts",
      'method !== "GET" && method !== "POST" && method !== "DELETE";',
      ts.ScriptTarget.Latest,
      true,
    );
    expect(finiteVocabularyMatches(comparisonCounterexample)).toEqual(["routeMethods"]);

    const httpOwner = await parseSource(resolve(sourceRoot, "runtime/http-owner.ts"));
    const dispatchValidator = sourceDescendants(httpOwner).find((node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "validateRuntimeDispatchRequest");
    if (dispatchValidator === undefined) throw new TypeError("Missing runtime dispatch validator.");
    expect(sourceDescendants(dispatchValidator)
      .filter((node): node is ts.Identifier => ts.isIdentifier(node))
      .map((node) => node.text)).toContain("routeMethods");
    expect(finiteVocabularyMatches(dispatchValidator)).not.toContain("routeMethods");

    for (const file of await collectSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      const parsed = await parseSource(file);
      for (const key of finiteVocabularyMatches(parsed)) finiteOwners[key].push(name);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node)) {
          if (node.text === "/api/v1/runtime-identity") pathOwners.runtimeIdentityPath.push(name);
          if (node.text === "/api/v1/") pathOwners.publicApiPrefix.push(name);
          if (node.text === "/api/v1/internal/") pathOwners.internalApiPrefix.push(name);
          if (node.text === "/api/v1/internal/control/") pathOwners.localControlApiPrefix.push(name);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    const sorted = (values: readonly string[]): readonly string[] => [...values].sort();
    expect(sorted(finiteOwners.routeMethods)).toEqual(["runtime/http-boundary.ts"]);
    expect(sorted(finiteOwners.routeMutations)).toEqual(["runtime/http-boundary.ts"]);
    expect(sorted(finiteOwners.routeStatuses)).toEqual(["runtime/http-boundary.ts"]);
    expect(sorted(finiteOwners.requestBodies)).toEqual(["runtime/request-security.ts"]);
    expect(sorted(finiteOwners.availability)).toEqual(["runtime/support-manifest.ts"]);
    expect(sorted(finiteOwners.supportLevels)).toEqual(["core/support-level.ts"]);
    expect(sorted(finiteOwners.interactionInterfaces)).toEqual([
      "review/direct-decision.ts",
      "token-catalog/state.ts",
      "wallet/operation-state.ts",
    ]);
    expect(sorted(finiteOwners.rpcSourceOwners)).toEqual(["runtime/configuration.ts"]);
    expect(sorted(pathOwners.runtimeIdentityPath)).toEqual(["runtime/http-boundary.ts"]);
    expect(sorted(pathOwners.publicApiPrefix)).toEqual(["runtime/http-boundary.ts"]);
    expect(sorted(pathOwners.internalApiPrefix)).toEqual(["runtime/http-boundary.ts"]);
    expect(sorted(pathOwners.localControlApiPrefix)).toEqual(["runtime/http-boundary.ts"]);
  });

  it("keeps fixed official-asset semantic and provider literals in their separate owners", async () => {
    const fixedTextLiterals = new Map([
      ["https://api.robinhood.com/rhj/assets", "registry/official-asset-contract.ts"],
      ["https://docs.robinhood.com/chain/contracts/", "registry/official-asset-contract.ts"],
      ["ASSET_STATUS_ACTIVE", "registry/official-assets.ts"],
      ["2026-07-20", "registry/official-asset-contract.ts"],
      ["14660943", "registry/official-asset-contract.ts"],
      [
        "https://robinhoodchain.blockscout.com/address/0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046",
        "registry/official-asset-contract.ts",
      ],
      [
        "https://robinhoodchain.blockscout.com/address/0xEe351E53BCe6AAF106428358838197C91e36EE0E",
        "registry/official-asset-contract.ts",
      ],
    ]);
    const fixedHexLiterals = new Map([
      ["0x4783c67b63de2b358ac5951a7d41f47a38f3c046", "registry/official-asset-contract.ts"],
      ["0xee351e53bce6aaf106428358838197c91e36ee0e", "registry/official-asset-contract.ts"],
      ["0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", "registry/official-asset-contract.ts"],
      ["0x394c3517e9331e7c88ef8af388c0cb63c720af1b1b4d5a5cace212f7df0b045a", "registry/official-asset-contract.ts"],
      ["0x3bfd5841605b9931c9dbb0f9f54a28b4038918ceb74d6d1081bc7f963fe528b4", "registry/official-asset-contract.ts"],
      ["0x94d90a8691fc4fc7a4fb48a86755f948f2a1110325d6c8257dbfeaddaf8832b0", "registry/official-asset-contract.ts"],
    ]);
    const owners = new Map(
      [...fixedTextLiterals.keys(), ...fixedHexLiterals.keys()]
        .map((literal) => [literal, new Set<string>()]),
    );
    for (const file of await collectSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      const source = await readFile(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node)) {
          const key = fixedTextLiterals.has(node.text)
            ? node.text
            : fixedHexLiterals.has(node.text.toLowerCase())
              ? node.text.toLowerCase()
              : undefined;
          if (key !== undefined) owners.get(key)?.add(name);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    for (const [literal, files] of owners) {
      expect([...files], literal).toEqual([
        fixedTextLiterals.get(literal) ?? fixedHexLiterals.get(literal),
      ]);
    }
  });

  it("keeps current external-integration configuration and construction in their exact owners", async () => {
    const authorityViolations: string[] = [];
    const observedEdges = new Set<string>();

    for (const file of await collectSourceFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      authorityViolations.push(...externalIntegrationAuthorityViolations(
        source,
        file,
        observedEdges,
      ));
    }

    expect(authorityViolations).toEqual([]);
    const expectedEdges = externalIntegrationAuthorityRules.flatMap((rule) => [
      ...[...rule.importers]
        .map((file) => `import:${rule.module}:${rule.symbol}:${file}`),
      ...[...rule.reexporters]
        .map((file) => `reexport:${rule.module}:${rule.symbol}:${file}`),
    ]);
    expect([...observedEdges].sort()).toEqual(expectedEdges.sort());
    const walletConfiguration = await parseSource(
      resolve(sourceRoot, "wallet/walletconnect-configuration.ts"),
    );
    const robinhoodAdapter = await parseSource(
      resolve(sourceRoot, "registry/official-assets.ts"),
    );
    const declarationNames = (source: ts.SourceFile): readonly string[] =>
      sourceDescendants(source)
        .flatMap((node) =>
          ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
            ? [node.name.text]
            : []);
    expect(declarationNames(walletConfiguration)).toContain(
      "defaultWalletConnectProjectId",
    );
    expect(declarationNames(robinhoodAdapter)).toContain(
      "robinhoodOfficialAssetSourceSettings",
    );

    const sourceContract = await readFile(
      robinhoodOfficialAssetSourceContractModule,
      "utf8",
    );
    const providerOnlyIdentifiers = new Set([
      "fetch",
      "Response",
      "responseByteLimit",
      "responseDeadlineMs",
      "responseDeploymentSchema",
      "responseAssetSchema",
      "sourceResponseSchema",
      "robinhoodOfficialAssetSourceSettings",
    ]);
    const sourceContractProviderIdentifiers = new Set<string>();
    const parsedSourceContract = ts.createSourceFile(
      robinhoodOfficialAssetSourceContractModule,
      sourceContract,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visitSourceContract = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && providerOnlyIdentifiers.has(node.text)) {
        sourceContractProviderIdentifiers.add(node.text);
      }
      ts.forEachChild(node, visitSourceContract);
    };
    visitSourceContract(parsedSourceContract);
    expect([...sourceContractProviderIdentifiers]).toEqual([]);

    const testConfigurationReaderViolations: string[] = [];
    for (const testFile of await collectSourceFiles(testRoot)) {
      const parsed = await parseSource(testFile);
      const testName = relative(testRoot, testFile).split(sep).join("/");
      const isWalletConfigurationTarget = (
        expression: ts.Expression | undefined,
      ): boolean =>
        expression !== undefined &&
        ts.isStringLiteralLike(expression) &&
        resolveSourceModule(testFile, expression.text) === walletConnectConfigurationModule;
      for (const node of sourceDescendants(parsed)) {
        if (
          ts.isImportDeclaration(node) &&
          isWalletConfigurationTarget(node.moduleSpecifier)
        ) {
          const clause = node.importClause;
          if (clause?.name !== undefined || (
            clause?.namedBindings !== undefined &&
            ts.isNamespaceImport(clause.namedBindings)
          )) {
            testConfigurationReaderViolations.push(
              `${testName}:broad_configuration_import`,
            );
          } else if (
            clause?.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.some(
              (element) =>
                (element.propertyName ?? element.name).text ===
                  "readWalletConnectConfiguration",
            )
          ) {
            testConfigurationReaderViolations.push(
              `${testName}:full_configuration_reader`,
            );
          }
        }
        if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          isWalletConfigurationTarget(node.moduleReference.expression)
        ) {
          testConfigurationReaderViolations.push(
            `${testName}:configuration_import_equals`,
          );
        }
        if (
          ts.isCallExpression(node) &&
          (
            node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")
          ) &&
          isWalletConfigurationTarget(node.arguments[0])
        ) {
          testConfigurationReaderViolations.push(
            `${testName}:dynamic_configuration_import`,
          );
        }
      }
    }
    expect(testConfigurationReaderViolations).toEqual([]);

    const sdkPackageImporters = new Map<string, string[]>([
      ["@walletconnect/sign-client", []],
      ["qrcode", []],
    ]);
    const walletExternalModuleConsumers: string[] = [];
    const importsWalletExternalModules = (
      file: string,
      specifier: string | undefined,
    ): boolean => {
      if (specifier === undefined || !specifier.startsWith(".")) return false;
      try {
        return fileURLToPath(new URL(specifier, pathToFileURL(file))) ===
          walletExternalModulesRuntimeModule;
      } catch {
        return false;
      }
    };
    for (const file of await collectSourceFiles(sourceRoot)) {
      for (const reference of (await inspectSourceFile(file)).moduleImports) {
        if (!reference.runtime) continue;
        const packageImporters = reference.packageRoot === undefined
          ? undefined
          : sdkPackageImporters.get(reference.packageRoot);
        if (packageImporters !== undefined) packageImporters.push(sourceName(file));
        if (importsWalletExternalModules(file, reference.specifier)) {
          walletExternalModuleConsumers.push(sourceName(file));
        }
      }
    }
    expect(sdkPackageImporters).toEqual(new Map([
      ["@walletconnect/sign-client", [sourceName(walletExternalModulesSourceModule)]],
      ["qrcode", [sourceName(walletExternalModulesSourceModule)]],
    ]));
    expect(walletExternalModuleConsumers).toEqual(["wallet/walletconnect-client.ts"]);

    const verificationExternalModuleConsumers: string[] = [];
    const verificationSdkPackageImporters: string[] = [];
    for (const file of await collectSourceFiles(testRoot)) {
      for (const reference of (await inspectSourceFile(file)).moduleImports) {
        if (!reference.runtime) continue;
        if (
          reference.packageRoot === "@walletconnect/sign-client" ||
          reference.packageRoot === "qrcode"
        ) verificationSdkPackageImporters.push(relative(testRoot, file).split(sep).join("/"));
        if (importsWalletExternalModules(file, reference.specifier)) {
          verificationExternalModuleConsumers.push(
            relative(testRoot, file).split(sep).join("/"),
          );
        }
      }
    }
    expect(verificationSdkPackageImporters).toEqual([]);
    expect(verificationExternalModuleConsumers).toEqual([]);

    const clientExports = new Set<string>(registryClientEntryExports);
    for (const forbidden of [
      ...robinhoodOfficialAssetSourceContractExports,
      ...robinhoodOfficialAssetAdapterExports,
    ]) {
      expect(clientExports.has(forbidden), forbidden).toBe(false);
    }
  }, 15_000);

  it("rejects syntax that bypasses external-integration symbol ownership", () => {
    const unauthorized = resolve(sourceRoot, "chain/unauthorized-integration.ts");
    const violationKinds = (source: string, file: string = unauthorized): readonly string[] =>
      externalIntegrationAuthorityViolations(source, file)
        .map((violation) => violation.split(":").slice(1, 3).join(":"));

    expect(externalIntegrationAuthorityViolations(
      'import { createWalletConnectConfiguration as createConfiguration } from "../wallet/walletconnect-configuration.js";',
      resolve(sourceRoot, "runtime/configuration.ts"),
    )).toEqual([]);
    expect(externalIntegrationAuthorityViolations(
      'export { createRobinhoodOfficialAssetSourceClient } from "./official-assets.js";',
      registryServerEntryModule,
    ).filter((violation) => violation.includes(":reexport:"))).toEqual([]);
    expect(violationKinds(
      'import { readWalletConnectConfiguration as readConfiguration } from "../wallet/walletconnect-configuration.js";',
    )).toContain("named_import:readWalletConnectConfiguration");
    expect(violationKinds(
      'import * as configuration from "../wallet/walletconnect-configuration.js";',
    )).toContain("namespace_import:\"../wallet/walletconnect-configuration.js\"");
    expect(violationKinds(
      'export { readWalletConnectConfiguration as readConfiguration } from "../wallet/walletconnect-configuration.js";',
    )).toContain("reexport:readWalletConnectConfiguration");
    expect(violationKinds(
      'export * from "../wallet/walletconnect-configuration.js";',
    )).toContain("wildcard_reexport:\"../wallet/walletconnect-configuration.js\"");
    expect(violationKinds(
      'void import("../wallet/walletconnect-configuration.js");',
    )).toContain("dynamic_import:\"../wallet/walletconnect-configuration.js\"");
    expect(violationKinds(
      'const configuration = require("../wallet/walletconnect-configuration.js");',
    )).toContain("require:\"../wallet/walletconnect-configuration.js\"");
    expect(violationKinds(
      'import configuration = require("../wallet/walletconnect-configuration.js");',
    )).toContain("import_equals:\"../wallet/walletconnect-configuration.js\"");
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export default { configuration };
    `, walletConnectClientModule)).toContain(
      "default_reexport:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export default Object.freeze({ configuration });
    `, walletConnectClientModule)).toContain(
      "default_reexport:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export const leakedConfiguration = Object.freeze({ configuration });
    `, walletConnectClientModule)).toContain(
      "exported_binding:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export const leakedConfiguration = () => configuration;
    `, walletConnectClientModule)).toContain(
      "exported_binding:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export default function leakedConfiguration() {
        return configuration;
      }
    `, walletConnectClientModule)).toContain(
      "exported_binding:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export const LeakedConfiguration = class {
        static readonly value = configuration;
      };
    `, walletConnectClientModule)).toContain(
      "exported_binding:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export default new Wrapper(configuration);
    `, walletConnectClientModule)).toContain(
      "default_reexport:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      const leakedConfiguration = Object.freeze({ configuration });
      export { leakedConfiguration };
    `, walletConnectClientModule)).toContain(
      "local_reexport:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {
        readWalletConnectConfiguration as configuration,
      } from "./walletconnect-configuration.js";
      module.exports = { configuration };
    `, walletConnectClientModule)).toContain(
      "commonjs_reexport:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export const leakedConfiguration = configuration;
    `, walletConnectClientModule)).toContain(
      "exported_binding:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export class LeakedConfiguration {
        static readonly value = configuration;
      }
    `, walletConnectClientModule)).toContain(
      "exported_binding:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export const consumeConfiguration = (input: unknown) =>
        configuration(input as never);
    `, walletConnectClientModule)).toContain(
      "exported_binding:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export default configuration(undefined as never);
    `, walletConnectClientModule)).toContain(
      "default_reexport:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export class LeakedConfiguration {
        read(input: unknown) {
          return configuration(input as never);
        }
      }
    `, walletConnectClientModule)).toContain(
      "exported_binding:readWalletConnectConfiguration",
    );
    expect(violationKinds(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      module.exports = configuration(undefined as never);
    `, walletConnectClientModule)).toContain(
      "commonjs_reexport:readWalletConnectConfiguration",
    );
    expect(externalIntegrationAuthorityViolations(`
      import {readWalletConnectConfiguration as configuration} from "./walletconnect-configuration.js";
      export const consumeConfiguration = (input: unknown) => {
        configuration(input as never);
        return true;
      };
    `, walletConnectClientModule)).toEqual([]);
    expect(externalIntegrationAuthorityViolations(`
      import {
        createWalletConnectClient,
      } from "./walletconnect-client.js";
      const createWalletOwnerApplicationFactory = (
        createClient: unknown,
      ) => createClient;
      export const createWalletOwnerApplication =
        createWalletOwnerApplicationFactory(createWalletConnectClient);
    `, walletApplicationModule)).toEqual([]);
    expect(violationKinds(
      'const robinhoodOfficialAssetSourceSettings = {}; export { robinhoodOfficialAssetSourceSettings as settings };',
      robinhoodOfficialAssetAdapterModule,
    )).toContain("unexpected_export:settings");

    const leakedConfigurationModule = `
      export interface WalletConnectConfiguration {}
      export interface WalletConnectSessionRequirements {}
      export const createWalletConnectConfiguration = () => undefined;
      export const readWalletConnectConfiguration = () => undefined;
      export const readWalletConnectConfigurationIdentity = () => undefined;
      export const readWalletConnectSessionRequirements = () => undefined;
      export const walletConnectProjectIdSchema = {};
    `;
    expect(exactModuleExportViolations(
      leakedConfigurationModule,
      walletConnectConfigurationModule,
      walletConnectConfigurationExports,
      false,
    ))
      .toContain("unexpected_export:walletConnectProjectIdSchema");
    expect(exactModuleExportViolations(`
      export type { WalletConnectConfiguration } from "./other-owner.js";
      export interface WalletConnectSessionRequirements {}
      export const createWalletConnectConfiguration = () => undefined;
      export const readWalletConnectConfiguration = () => undefined;
      export const readWalletConnectConfigurationIdentity = () => undefined;
      export const readWalletConnectSessionRequirements = () => undefined;
    `, walletConnectConfigurationModule, walletConnectConfigurationExports, false))
      .toContain('external_reexport:"./other-owner.js"');

    const leakedProvider = `
      export const createRobinhoodOfficialAssetSourceClient = () => undefined;
      const providerSettings = {};
      export { providerSettings as derivedConfiguration };
    `;
    expect(exactModuleExportViolations(
      leakedProvider,
      robinhoodOfficialAssetAdapterModule,
      robinhoodOfficialAssetAdapterExports,
      false,
    )).toContain("unexpected_export:derivedConfiguration");
    expect(exactModuleExportViolations(`
      export const createSourcifyContractSourceVerification = () => undefined;
      export const sourcifyOrigin = "https://sourcify.dev";
    `, sourcifyAdapterModule, sourcifyAdapterExports, false))
      .toContain("unexpected_export:sourcifyOrigin");

    expect(violationKinds(
      'import { admitRobinhoodOfficialAssetSourceObservation as admit } from "../registry/official-asset-source-contract.js";',
    )).toContain("named_import:admitRobinhoodOfficialAssetSourceObservation");
  });

  it("keeps the Stock Token trade-history capability identifier in its contract owner", async () => {
    const owners = new Set<string>();
    for (const file of await collectSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      const parsed = await parseSource(file);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && node.text === "market.stock_token_trade_history") {
          owners.add(name);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect([...owners]).toEqual(["stock-token-trade-history/contracts.ts"]);
  });

  it("keeps trade-history admission, aggregation, provider, and application entry points in their exact owners", async () => {
    const expectedOwners = new Map<string, string>([
      ["stockTokenTradeHistoryCapability", "stock-token-trade-history/contracts.ts"],
      ["selectStockTokenTradeHistoryResolution", "stock-token-trade-history/source-semantics.ts"],
      ["createStockTokenTradeHistoryArchiveResult", "stock-token-trade-history/result-builder.ts"],
      ["createGitHubStockTokenTradeHistoryTransport", "stock-token-trade-history/github-source.ts"],
      ["createStockTokenTradeHistoryApplication", "stock-token-trade-history/application.ts"],
      ["createStockTokenTradeHistorySource", "stock-token-trade-history/source.ts"],
    ]);
    const observedOwners = new Map(
      [...expectedOwners.keys()].map((name) => [name, new Set<string>()]),
    );

    for (const file of await collectSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      const parsed = await parseSource(file);
      const visit = (node: ts.Node): void => {
        const declarationName =
          (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node)) && node.name !== undefined &&
            ts.isIdentifier(node.name)
            ? node.name.text
            : undefined;
        if (declarationName !== undefined) observedOwners.get(declarationName)?.add(name);
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }

    for (const [name, owner] of expectedOwners) {
      expect([...observedOwners.get(name)!], name).toEqual([owner]);
    }
  });
  it("requires interface and package consumers to enter the token catalog through their exact public handoff", async () => {
    const violations: string[] = [];
    for (const file of await collectProductSourceFiles(repositoryRoot)) {
      if (!isInterfaceConsumer(file)) continue;
      for (const reference of (await inspectSourceFile(file)).moduleImports) {
        if (reference.specifier === undefined) continue;
        const target = resolvesInsideTokenCatalog(file, reference.specifier);
        const entries = clientTokenCatalogConsumers.has(file)
          ? ["client.js"]
          : directTokenCatalogContractConsumers.has(file)
            ? ["contract-schema.js"]
            : file.startsWith(resolve(sourceRoot, "interfaces") + sep) &&
              file !== resolve(sourceRoot, "interfaces/application.ts")
              ? ["client.js", "errors.js", "operation-error.js", ...(!reference.runtime ? ["ports.js"] : [])]
              : ["index.js"];
        if (target !== undefined && !entries.includes(target)) {
          violations.push(`${relative(repositoryRoot, file).split(sep).join("/")}:${reference.specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps contract delivery imports outside application and adapter construction", async () => {
    const forbidden = new Set([
      "runtime/database.ts", "runtime/composition.ts", "chain/application.ts",
      "wallet/application.ts", "wallet/walletconnect-client.ts", "wallet/walletconnect-storage.ts",
      "token-catalog/application-factory.ts", "account-assets/application-factory.ts",
      "stock-token-trade-history/application-factory.ts", "stock-token-trade-history/github-source.ts",
      "stock-token-trade-history/source.ts", "registry/official-assets.ts", "registry/stock-factory.ts",
      "stock-token-prices/application.ts", "stock-token-prices/application-factory.ts", "stock-token-prices/dexscreener-source.ts",
      "protocols/pool-price-reads.ts", "protocols/uniswap-v3/pool-price.ts", "protocols/uniswap-v4/pool-price.ts",
      "intelligence/sourcify.ts", "protocols/uniswap-v2/application.ts", "protocols/uniswap-v2/sdk.ts",
    ].map((file) => resolve(sourceRoot, file)));
    const walk = async (root: string, extraImport?: string): Promise<string[]> => {
      const pending = [root];
      const seen = new Set<string>();
      const violations: string[] = [];
      for (let index = 0; index < pending.length; index += 1) {
        const file = pending[index]!;
        if (seen.has(file)) continue;
        seen.add(file);
        if (forbidden.has(file)) { violations.push(relative(sourceRoot, file)); continue; }
        const source = await readFile(file, "utf8");
        const imports = inspectModuleImports(source + (file === root ? extraImport ?? "" : ""), file);
        for (const entry of imports) {
          if (!entry.runtime || entry.specifier === undefined) continue;
          const target = resolveSourceModule(file, entry.specifier);
          if (target !== undefined) pending.push(target.replace(/\.cjs$/u, ".cts"));
        }
      }
      return violations;
    };
    for (const file of ["interfaces/identities.ts", "interfaces/cli-read.ts", "interfaces/cli-token.ts",
      "interfaces/operation-tool-contracts.ts", "interfaces/mcp-app/contracts.ts", "interfaces/mcp-app/card-contract.ts", "interfaces/mcp-app/registry.ts"]) {
      expect(await walk(resolve(sourceRoot, file)), file).toEqual([]);
    }
    expect(await walk(resolve(sourceRoot, "interfaces/identities.ts"),
      '\nimport "../protocols/uniswap-v2/index.js";')).toContain("protocols/uniswap-v2/application.ts");
  });

  it("confines local operation bindings and catalog resolution to their process owner", async () => {
    const allowed = new Set([
      resolve(sourceRoot, "interfaces/local-operation.ts"),
      resolve(sourceRoot, "interfaces/mcp.ts"),
      resolve(sourceRoot, "interfaces/operation-client.ts"),
    ]);
    const violations: string[] = [];
    for (const file of await collectSourceFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      if (!allowed.has(file) && source.includes("resolveLocalOperationIdentity")) {
        violations.push(relative(sourceRoot, file).split(sep).join("/"));
      }
    }
    expect(violations).toEqual([]);

    const publicInterface = await readFile(resolve(sourceRoot, "interfaces/index.ts"), "utf8");
    expect(publicInterface).not.toContain("LocalOperationBinding");
    expect(publicInterface).not.toContain("LocalOperationContract");
  });

  it("keeps credential, database, owner, and route construction out of the public runtime entry point", async () => {
    const index = await readFile(resolve("src/runtime/index.ts"), "utf8");
    const parsed = ts.createSourceFile("index.ts", index, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const wildcards: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isExportDeclaration(node) && node.exportClause === undefined) {
        wildcards.push(node.moduleSpecifier?.getText(parsed) ?? "local");
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(wildcards).toEqual([]);
    for (const forbidden of [
      "ProductDatabase",
      "FixedHttpOwner",
      "loadOrCreateControlCredential",
      "createRuntimeRouteRegistry",
      "createRuntimeStateResetRequiredError",
      "LocalControlCredentialAuthority",
      "ControlCredentialVerifier",
    ]) expect(Object.hasOwn(runtimePublic, forbidden)).toBe(false);
  });

  it("keeps process termination in the direct CLI entry and host output behind its owner", async () => {
    const exitCalls: string[] = [];
    const directOutputWrites: string[] = [];
    for (const file of await collectProductCodeSourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file).split(sep).join("/");
      const parsed = ts.createSourceFile(
        file,
        await readFile(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const target = node.expression.expression.getText(parsed);
          const member = node.expression.name.text;
          if (member === "exit" && (target === "process" || target === "globalThis.process")) {
            exitCalls.push(`${name}:${node.getStart(parsed)}`);
          }
          if (
            member === "write" &&
            ["process.stdout", "process.stderr", "globalThis.process.stdout", "globalThis.process.stderr"]
              .includes(target)
          ) directOutputWrites.push(`${name}:${node.getStart(parsed)}`);
          if (
            (target === "console" || target === "globalThis.console") &&
            ["debug", "error", "info", "log", "warn"].includes(member)
          ) directOutputWrites.push(`${name}:${node.getStart(parsed)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect(exitCalls).toHaveLength(1);
    expect(exitCalls[0]?.startsWith("cli.ts:")).toBe(true);
    expect(directOutputWrites).toEqual([]);
  });

  it("confines startup-reset creation and the read-only SQLite admission order to their owners", async () => {
    const productSources = await collectProductCodeSourceFiles(sourceRoot);
    const canonicalProgram = createProductSourceProgram(productSources);
    expect(runtimeResetCreatorViolations(canonicalProgram)).toEqual([]);
    expect(sqlitePragmaAudit(canonicalProgram).violations).toEqual([]);
    const importedAliasPath = resolve(sourceRoot, "runtime/reset-import-alias.ts");
    const literalComputedPath = resolve(sourceRoot, "runtime/reset-literal-computed.ts");
    const keyedComputedPath = resolve(sourceRoot, "runtime/reset-keyed-computed.ts");
    const dynamicImportPath = resolve(sourceRoot, "runtime/reset-dynamic-import.ts");
    const namespaceExportPath = resolve(sourceRoot, "runtime/reset-namespace-export.ts");
    const typeOnlyImportEqualsPath = resolve(sourceRoot, "runtime/reset-type-import-equals.cts");
    const typeOnlyNamespaceImportPath = resolve(sourceRoot, "runtime/reset-type-namespace-import.ts");
    const typeOnlyNamespaceExportPath = resolve(sourceRoot, "runtime/reset-type-namespace-export.ts");
    const topLevelRequireShadowPath = resolve(sourceRoot, "runtime/reset-local-require.cts");
    const parameterRequireShadowPath = resolve(sourceRoot, "runtime/reset-parameter-require.cts");
    const valueImportEqualsPath = resolve(sourceRoot, "runtime/reset-import-equals.cts");
    const ambientRequirePath = resolve(sourceRoot, "runtime/reset-ambient-require.cts");
    const declaredAmbientRequirePath = resolve(sourceRoot, "runtime/reset-declared-require.cts");
    const typeOnlyRequireThenAmbientPath = resolve(
      sourceRoot,
      "runtime/reset-type-require-then-ambient.cts",
    );
    const nonliteralRequirePath = resolve(sourceRoot, "runtime/reset-nonliteral-require.cts");
    const sqliteSchemaSource = await readFile(runtimeSqliteSchemaPath, "utf8");
    const databaseSource = await readFile(runtimeDatabasePath, "utf8");
    const userVersionAssignment = '    database.pragma("user_version = 1");';
    if (databaseSource.split(userVersionAssignment).length !== 2) {
      throw new TypeError("SQLite user-version mutation target is not unique.");
    }
    const composedVersionReadSource = databaseSource.replace(
      userVersionAssignment,
      `    const inspectedMetadata = "user_" + "version";
    database.pragma(inspectedMetadata, { simple: true });
${userVersionAssignment}`,
    );
    const adversarialProgram = createProductSourceProgram(
      productSources,
      new Map([
        [importedAliasPath, `
import { createRuntimeStateResetRequiredError as createReset } from "./sqlite-schema.js";
export const bypassResetOwner = () => createReset();
`],
        [literalComputedPath, `
import * as sqliteSchema from "./sqlite-schema.js";
const createReset = sqliteSchema["createRuntimeStateResetRequiredError"];
export const bypassResetOwner = () => createReset();
`],
        [keyedComputedPath, `
import * as sqliteSchema from "./sqlite-schema.js";
const resetKey = "createRuntimeStateResetRequiredError" as const;
const createReset = sqliteSchema[resetKey];
export const bypassResetOwner = () => createReset();
`],
        [dynamicImportPath, `
export const bypassResetOwner = async () =>
  ((await import("./sqlite-schema.js")) as any)["createRuntimeStateResetRequiredError"]();
`],
        [namespaceExportPath, `
export * as resetFactory from "./sqlite-schema.js";
`],
        [typeOnlyImportEqualsPath, `
import type ResetSchema = require("./sqlite-schema.js");
export type ResetSchemaType = typeof ResetSchema;
`],
        [typeOnlyNamespaceImportPath, `
import type * as resetSchema from "./sqlite-schema.js";
export type ResetSchemaType = typeof resetSchema;
`],
        [typeOnlyNamespaceExportPath, `
export type * as resetSchema from "./sqlite-schema.js";
`],
        [topLevelRequireShadowPath, `
const require = (_specifier: string): object => ({});
void require("./sqlite-schema.js");
`],
        [parameterRequireShadowPath, `
export const useLocalLoader = (require: (specifier: string) => object): void => {
  void require("./sqlite-schema.js");
};
`],
        [valueImportEqualsPath, `
import resetSchema = require("./sqlite-schema.js");
void resetSchema;
`],
        [ambientRequirePath, `
void require("./sqlite-schema.js");
`],
        [declaredAmbientRequirePath, `
declare const require: (specifier: string) => object;
void require("./sqlite-schema.js");
`],
        [typeOnlyRequireThenAmbientPath, `
import type require = require("types");
void require("./sqlite-schema.js");
`],
        [nonliteralRequirePath, `
declare const target: string;
void require(target);
`],
        [runtimeSqliteSchemaPath, `${sqliteSchemaSource}
const EscapedRuntimeStateResetRequiredSourceError = RuntimeStateResetRequiredSourceError;
const createEscapedRuntimeStateResetRequiredError = () =>
  new EscapedRuntimeStateResetRequiredSourceError();
void createEscapedRuntimeStateResetRequiredError;
`],
        [runtimeDatabasePath, composedVersionReadSource],
      ]),
      canonicalProgram,
    );
    const adversarialViolations = runtimeResetCreatorViolations(adversarialProgram);
    const sourceErrorEscapeViolation =
      "src/runtime/sqlite-schema.ts:runtime_reset_source_error_escape";
    expect(adversarialViolations.filter((violation) =>
      !violation.startsWith("src/runtime/reset-import-alias.ts:") &&
      !violation.startsWith("src/runtime/reset-literal-computed.ts:") &&
      !violation.startsWith("src/runtime/reset-keyed-computed.ts:") &&
      violation !== sourceErrorEscapeViolation))
      .toEqual([]);
    expect(adversarialViolations.some((violation) =>
      violation.startsWith("src/runtime/reset-import-alias.ts:"))).toBe(true);
    expect(adversarialViolations.some((violation) =>
      violation.startsWith("src/runtime/reset-literal-computed.ts:"))).toBe(true);
    expect(adversarialViolations.some((violation) =>
      violation.startsWith("src/runtime/reset-keyed-computed.ts:"))).toBe(true);
    expect(adversarialViolations.filter((violation) =>
      violation === sourceErrorEscapeViolation)).toEqual([sourceErrorEscapeViolation]);
    const resetFactorySymbol = moduleExportSymbol(
      adversarialProgram,
      adversarialProgram.getTypeChecker(),
      runtimeSqliteSchemaPath,
      runtimeResetCreatorName,
    );
    if (resetFactorySymbol === undefined) {
      throw new TypeError("Runtime reset factory authority is unavailable.");
    }
    const moduleViolations = protectedModuleAccessViolations(
      adversarialProgram,
      new Set([resetFactorySymbol]),
      sourceRoot,
    );
    const fixturePrefixes = [
      "runtime/reset-literal-computed.ts:",
      "runtime/reset-keyed-computed.ts:",
      "runtime/reset-dynamic-import.ts:",
      "runtime/reset-namespace-export.ts:",
      "runtime/reset-import-equals.cts:",
      "runtime/reset-ambient-require.cts:",
      "runtime/reset-declared-require.cts:",
      "runtime/reset-type-require-then-ambient.cts:",
      "runtime/reset-nonliteral-require.cts:",
    ];
    expect(moduleViolations.filter((violation) =>
      !fixturePrefixes.some((prefix) => violation.startsWith(prefix)))).toEqual([]);
    expect(moduleViolations).toContain(
      "runtime/reset-literal-computed.ts:2:protected_module_namespace_import",
    );
    expect(moduleViolations).toContain(
      "runtime/reset-keyed-computed.ts:2:protected_module_namespace_import",
    );
    expect(moduleViolations).toContain(
      "runtime/reset-dynamic-import.ts:3:protected_module_dynamic_import",
    );
    expect(moduleViolations).toContain(
      "runtime/reset-namespace-export.ts:2:protected_module_namespace_export",
    );
    expect(moduleViolations).toContain(
      "runtime/reset-import-equals.cts:2:protected_module_import_equals",
    );
    expect(moduleViolations).toContain(
      "runtime/reset-ambient-require.cts:2:protected_module_require",
    );
    expect(moduleViolations).toContain(
      "runtime/reset-declared-require.cts:3:protected_module_require",
    );
    expect(moduleViolations).toContain(
      "runtime/reset-type-require-then-ambient.cts:3:protected_module_require",
    );
    expect(moduleViolations).toContain(
      "runtime/reset-nonliteral-require.cts:3:unresolved_runtime_module_load",
    );

    const databasePath = resolve(sourceRoot, "runtime/database.ts");
    const database = await parseSource(databasePath);
    expect(runtimeDatabaseAdmissionAuthorityViolations(database)).toEqual([]);
    const mutatedDatabase = (needle: string, replacement: string): ts.SourceFile => {
      const first = database.text.indexOf(needle);
      if (first < 0 || database.text.indexOf(needle, first + needle.length) >= 0) {
        throw new TypeError(`SQLite authority mutation target is not unique: ${needle}`);
      }
      return ts.createSourceFile(
        databasePath,
        `${database.text.slice(0, first)}${replacement}${database.text.slice(first + needle.length)}`,
        ts.ScriptTarget.Latest,
        true,
      );
    };
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      `  static async open(\n    path: string,\n    nowInput: UtcTimestamp,\n`,
      `  static async open(\n    path: string,\n    nowInput: UtcTimestamp,\n    stateFileAuthority: unknown,\n`,
    ))).toContain("product_database_caller_selected_authority_parameter");
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      `const admitExistingSqliteStructure = async (\n  path: string,\n`,
      `const admitExistingSqliteStructure = async (\n  path: string,\n  leaseFactory: unknown,\n`,
    ))).toContain("sqlite_admission_caller_selected_lease_parameter");
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      `} from "./paths.js";`,
      `} from "./alternate-paths.js";`,
    ))).toContain("sqlite_main_lease_owner_import");
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      "  acquireOwnerOnlyStateFileLease,\n",
      "  alternateLease as acquireOwnerOnlyStateFileLease,\n",
    ))).toContain("sqlite_main_lease_owner_import");
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      "  sameOwnerOnlyStateFileIdentity,\n",
      "  sameIdentity as sameOwnerOnlyStateFileIdentity,\n",
    ))).toContain("sqlite_artifact_identity_owner_import");
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      "  type OwnerOnlyStateFileObservation,\n",
      "  type OwnerOnlyStateFileIdentity as OwnerOnlyStateFileObservation,\n",
    ))).toContain("sqlite_artifact_identity_owner_import");
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      "interface ExistingSqliteArtifactSnapshot {",
      "interface SqliteArtifactIdentity { device: number; inode: number; }\n\ninterface ExistingSqliteArtifactSnapshot {",
    ))).toContain("sqlite_artifact_identity_duplicate_owner");
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      "    return lease.observe();",
      "    const observation = lease.observe();\n    Number(observation.inode);\n    return observation;",
    ))).toContain("sqlite_artifact_identity_numeric_coercion");
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      "    !sameOwnerOnlyStateFileIdentity(before.wal, after.wal)",
      "    !alternateArtifactIdentityEquality(before.wal, after.wal)",
    ))).toContain("sqlite_artifact_identity_comparison_binding");
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      "  const mainLease = acquireOwnerOnlyStateFileLease(path);",
      "  const mainLease = alternateLeaseFactory(path);",
    ))).toContain("sqlite_main_lease_alternate_acquisition");
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      `      database = new Database(path, { readonly: true, fileMustExist: true, timeout: sqliteOperationalLimits.busyTimeoutMilliseconds });\n      mainLease.assertCurrent();\n      current = hasExactCurrentSqliteStructure(database);`,
      `      database = new Database(path, { readonly: true, fileMustExist: true, timeout: sqliteOperationalLimits.busyTimeoutMilliseconds });\n      current = hasExactCurrentSqliteStructure(database);`,
    ))).toContain("sqlite_read_only_structure_preassert_missing");
    expect(runtimeDatabaseAdmissionAuthorityViolations(mutatedDatabase(
      `  mainLease.assertCurrent();\n};\n\nconst inspectSqliteArtifactSet`,
      `};\n\nconst inspectSqliteArtifactSet`,
    ))).toContain("sqlite_artifact_postcondition_postassert_missing");
    const declaration = (name: string): ts.VariableDeclaration => {
      const match = sourceDescendants(database).find((node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name);
      if (match === undefined) throw new TypeError(`Runtime database declaration is unavailable: ${name}`);
      return match;
    };
    const admission = declaration("admitExistingSqliteStructure");
    const admissionNodes = sourceDescendants(admission);
    const admissionDatabaseOpens = admissionNodes.filter((node): node is ts.NewExpression =>
      ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Database");
    expect(admissionDatabaseOpens).toHaveLength(1);
    expect(admissionDatabaseOpens[0]?.getText(database)).toContain("readonly: true");
    expect(admissionDatabaseOpens[0]?.getText(database)).toContain("fileMustExist: true");
    const admissionCalls = (name: string): ts.CallExpression[] => admissionNodes.filter(
      (node): node is ts.CallExpression => ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) && node.expression.text === name,
    );
    const artifactCaptures = admissionCalls("captureExistingSqliteArtifacts");
    const structureReads = admissionCalls("hasExactCurrentSqliteStructure");
    const artifactPostconditions = admissionCalls("assertReadOnlyArtifactTransition");
    expect(artifactCaptures).toHaveLength(1);
    expect(structureReads).toHaveLength(1);
    expect(artifactPostconditions).toHaveLength(1);
    const artifactPostconditionStart = artifactPostconditions[0]?.getStart(database) as number;
    const databaseClosesBeforePostcondition = admissionNodes.filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "database" &&
      node.expression.name.text === "close" &&
      node.getStart(database) < artifactPostconditionStart);
    expect(databaseClosesBeforePostcondition).toHaveLength(1);
    const admissionReturns = admissionNodes.filter((node): node is ts.ReturnStatement => ts.isReturnStatement(node));
    expect(admissionReturns).toHaveLength(2);
    expect([
      artifactCaptures[0]?.getStart(database),
      admissionDatabaseOpens[0]?.getStart(database),
      structureReads[0]?.getStart(database),
      databaseClosesBeforePostcondition[0]?.getStart(database),
      artifactPostconditionStart,
      ...admissionReturns.map((statement) => statement.getStart(database)),
    ]).toEqual([...[
      artifactCaptures[0]?.getStart(database),
      admissionDatabaseOpens[0]?.getStart(database),
      structureReads[0]?.getStart(database),
      databaseClosesBeforePostcondition[0]?.getStart(database),
      artifactPostconditionStart,
      ...admissionReturns.map((statement) => statement.getStart(database)),
    ]].sort((left, right) => (left as number) - (right as number)));

    const pragmaAudit = sqlitePragmaAudit(canonicalProgram);
    expect(pragmaAudit.userVersionExpressions).toEqual([{
      file: "src/runtime/database.ts",
      kind: ts.SyntaxKind.StringLiteral,
      value: "user_version = 1",
    }]);
    const comparePragmaCommand = (
      left: { readonly file: string; readonly command: string },
      right: { readonly file: string; readonly command: string },
    ): number => left.file.localeCompare(right.file) || left.command.localeCompare(right.command);
    const expectedPragmaCommands = [
      { file: "src/runtime/database.ts", command: "foreign_keys = ON" },
      { file: "src/runtime/database.ts", command: "foreign_keys" },
      { file: "src/runtime/database.ts", command: "busy_timeout = 5000" },
      { file: "src/runtime/database.ts", command: "busy_timeout" },
      { file: "src/runtime/database.ts", command: "journal_mode" },
      { file: "src/runtime/database.ts", command: "journal_mode = WAL" },
      { file: "src/runtime/database.ts", command: "user_version = 1" },
      { file: "src/runtime/database.ts", command: "wal_checkpoint(TRUNCATE)" },
      { file: "src/wallet/walletconnect-storage.ts", command: "busy_timeout = 5000" },
      { file: "src/wallet/walletconnect-storage.ts", command: "busy_timeout" },
      { file: "src/wallet/walletconnect-storage.ts", command: "locking_mode = EXCLUSIVE" },
      { file: "src/wallet/walletconnect-storage.ts", command: "locking_mode" },
      { file: "src/wallet/walletconnect-storage.ts", command: "synchronous = FULL" },
      { file: "src/wallet/walletconnect-storage.ts", command: "synchronous" },
      { file: "src/wallet/walletconnect-storage.ts", command: "fullfsync = ON" },
      { file: "src/wallet/walletconnect-storage.ts", command: "fullfsync" },
      { file: "src/wallet/walletconnect-storage.ts", command: "journal_mode = WAL" },
      { file: "src/wallet/walletconnect-storage.ts", command: "journal_mode" },
      { file: "src/wallet/walletconnect-storage.ts", command: "journal_mode" },
    ];
    expect([...pragmaAudit.commands].sort(comparePragmaCommand)).toEqual(
      expectedPragmaCommands.sort(comparePragmaCommand),
    );
    const bootstrap = declaration("bootstrapFreshDatabase");
    const userVersionCalls = sourceDescendants(database).filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "pragma" &&
      node.arguments.some((argument) =>
        ts.isStringLiteralLike(argument) && argument.text.toLowerCase().includes("user_version")));
    expect(userVersionCalls).toHaveLength(1);
    expect(userVersionCalls[0]?.getText(database)).toBe('database.pragma("user_version = 1")');
    expect(userVersionCalls[0]?.getStart(database)).toBeGreaterThan(bootstrap.getStart(database));
    expect(userVersionCalls[0]?.getEnd()).toBeLessThan(bootstrap.getEnd());

    expect(sqlitePragmaAudit(adversarialProgram).violations).toContain(
      "src/runtime/database.ts:sqlite_user_version_operation",
    );

    const opening = declaration("openCurrentDatabase");
    const openingNodes = sourceDescendants(opening);
    const startOf = (predicate: (node: ts.Node) => boolean): number => {
      const match = openingNodes.find(predicate);
      if (match === undefined) throw new TypeError("Current SQLite opening step is unavailable.");
      return match.getStart(database);
    };
    const admissionStart = startOf((node) => ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) && node.expression.text === "admitExistingSqliteStructure");
    const writableOpenStart = startOf((node) => ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) && node.expression.text === "Database");
    const configureStart = startOf((node) => ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) && node.expression.text === "configureExistingDatabase");
    const structureRecheckStart = startOf((node) => ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) && node.expression.text === "hasExactCurrentSqliteStructure");
    const productReadStart = startOf((node) => ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) && node.expression.text === "validateDatabaseState");
    expect([
      admissionStart,
      writableOpenStart,
      configureStart,
      structureRecheckStart,
      productReadStart,
    ]).toEqual([...[
      admissionStart,
      writableOpenStart,
      configureStart,
      structureRecheckStart,
      productReadStart,
    ]].sort((left, right) => left - right));
  }, 15_000);

  it("keeps complete WalletConnect SQLite scopes inside the owner-only artifact boundary", async () => {
    const storagePath = resolve(sourceRoot, "wallet/walletconnect-storage.ts");
    const storage = await parseSource(storagePath);
    const declaration = (
      source: ts.SourceFile,
      name: string,
    ): ts.VariableDeclaration | undefined => sourceDescendants(source).find(
      (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) && node.name.text === name,
    );
    const directArtifactBoundary = (
      owner: ts.VariableDeclaration | undefined,
    ): ts.ArrowFunction | undefined => {
      if (owner?.initializer === undefined || !ts.isArrowFunction(owner.initializer)) return undefined;
      const body = owner.initializer.body;
      if (
        !ts.isCallExpression(body) || !ts.isIdentifier(body.expression) ||
        body.expression.text !== "withOwnerOnlySqliteArtifacts"
      ) return undefined;
      const callback = body.arguments[0];
      if (
        callback === undefined || !ts.isArrowFunction(callback) ||
        callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true
      ) return undefined;
      return callback;
    };

    const boundaries = [
      directArtifactBoundary(declaration(storage, "inspectExistingWithoutMutation")),
      directArtifactBoundary(declaration(storage, "openConfiguredDatabase")),
    ];
    expect(boundaries.every((boundary) => boundary !== undefined)).toBe(true);
    const opens = sourceDescendants(storage).filter((node): node is ts.NewExpression =>
      ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "Database");
    expect(opens).toHaveLength(2);
    for (const boundary of boundaries) {
      if (boundary === undefined) throw new TypeError("WalletConnect SQLite boundary is unavailable.");
      expect(sourceDescendants(boundary).filter((node): node is ts.NewExpression =>
        ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === "Database")).toHaveLength(1);
    }

    const escapedInspection = ts.createSourceFile(
      "escaped-walletconnect-storage.ts",
      `const inspectExistingWithoutMutation = (path: string): void => {
  const database = withOwnerOnlySqliteArtifacts(() => new Database(path));
  database.pragma("journal_mode", { simple: true });
  inspectCurrentStructure(database);
  database.close();
};`,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(directArtifactBoundary(
      declaration(escapedInspection, "inspectExistingWithoutMutation"),
    )).toBeUndefined();
  });

  it("opens and admits SQLite before constructing or publishing the HTTP owner", async () => {
    const compositionPath = resolve(sourceRoot, "runtime/composition.ts");
    const composition = await parseSource(compositionPath);
    const runtimeClass = sourceDescendants(composition).find((node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === "LocalRuntime");
    if (runtimeClass === undefined) throw new TypeError("LocalRuntime is unavailable.");
    const method = (name: string): ts.MethodDeclaration => {
      const match = runtimeClass.members.find((member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name);
      if (match === undefined) throw new TypeError(`LocalRuntime method is unavailable: ${name}`);
      return match;
    };
    const create = method("create");
    const start = method("start");
    const createNodes = sourceDescendants(create);
    const createHttpOwner = createNodes.find((node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "createHttpOwner");
    if (createHttpOwner === undefined) throw new TypeError("HTTP owner factory is unavailable.");
    const fixedOwnerConstructions = createNodes.filter((node): node is ts.NewExpression =>
      ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "FixedHttpOwner");
    expect(fixedOwnerConstructions).toHaveLength(1);
    expect(fixedOwnerConstructions[0]?.getStart(composition)).toBeGreaterThan(createHttpOwner.getStart(composition));
    expect(fixedOwnerConstructions[0]?.getEnd()).toBeLessThan(createHttpOwner.getEnd());
    const prematureFactoryCalls = createNodes.filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createHttpOwner");
    expect(prematureFactoryCalls).toEqual([]);
    const databaseOpen = createNodes.find((node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "ProductDatabase" &&
      node.expression.name.text === "open");
    const runtimeReturn = createNodes.find((node): node is ts.ReturnStatement =>
      ts.isReturnStatement(node) && node.expression !== undefined &&
      ts.isNewExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "LocalRuntime");
    if (databaseOpen === undefined || runtimeReturn === undefined) {
      throw new TypeError("LocalRuntime database admission sequence is unavailable.");
    }
    expect(databaseOpen.getStart(composition)).toBeLessThan(runtimeReturn.getStart(composition));
    const startFactoryCalls = sourceDescendants(start).filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isPrivateIdentifier(node.expression.name) &&
      node.expression.name.text === "#createHttpOwner");
    expect(startFactoryCalls).toHaveLength(1);
  });

  it("limits raw authority imports to their declared runtime owners", async () => {
    const allowedCredentialConsumers = new Set([
      "composition.ts",
      "http-owner.ts",
      "http-routing.ts",
      "request-security.ts",
      "source-identity.ts",
    ]);
    const violations: string[] = [];
    for (const file of await collectSourceFiles(resolve("src/runtime"))) {
      const name = relative(resolve("src/runtime"), file).split(sep).join("/");
      for (const reference of (await inspectSourceFile(file)).moduleImports) {
        if (reference.specifier?.endsWith("/control-credential.js") && !allowedCredentialConsumers.has(name)) {
          violations.push(`${name}:control-credential`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps unavailable support values and broad owner bootstrap ports out of the runtime foundation", async () => {
    const support = await readFile(resolve("src/runtime/support-manifest.ts"), "utf8");
    const composition = await readFile(resolve("src/runtime/composition.ts"), "utf8");
    expect(support).not.toContain("walletAvailable");
    expect(support).not.toContain("readAvailable");
    expect(support).not.toContain("extendRuntimeSupportManifest");
    expect(composition).not.toContain("ownerApplicationFactory");
    expect(composition).not.toContain("sdkStoreDirectory");
    for (const scopedAuthority of [
      "extendWalletRuntimeSupportManifest",
      "extendChainRuntimeSupportManifest",
      "extendInterfaceRuntimeSupportManifest",
    ]) expect(Object.hasOwn(runtimePublic, scopedAuthority)).toBe(true);
  });

  it("makes runtime composition consume the complete token catalog application", async () => {
    const composition = await readFile(resolve("src/runtime/composition.ts"), "utf8");
    expect(composition).toContain("createTokenCatalogApplicationFactory");
    expect(composition).not.toContain("new TokenCatalogCoordinator");
    expect(composition).not.toContain("createTokenCatalogApplication({");
    expect(composition).not.toContain("createTokenCatalogConsumerPorts(");
  });

  it("passes actual Chain and Registry ports into the Stock Token trade-history stage", async () => {
    const file = resolve("src/runtime/composition.ts");
    const source = await readFile(file, "utf8");
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let stageType: ts.TypeAliasDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === "StockTokenTradeHistoryOwnerApplicationStage") {
        stageType = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(stageType).toBeDefined();
    if (stageType === undefined || !ts.isFunctionTypeNode(stageType.type)) return;
    expect(stageType.type.parameters.map(parameter => parameter.type?.getText(parsed)))
      .toEqual(["ApplicationStageContext", "ChainOwnerHandoff", "RegistryOwnerHandoff"]);
    expect(stageType.getText(parsed)).not.toContain("AccountAssetOwnerHandoff");
  });

  it("removes Chainlink, mixed-market, and obsolete trade-history names from product code", async () => {
    const productSources = await collectProductSourceFiles(repositoryRoot);
    const sources = await Promise.all(productSources.map(async (file) => ({
      file,
      source: await readFile(file, "utf8"),
    })));
    const chainlinkOccurrences = sources.filter((entry) =>
      entry.source.toLowerCase().includes("chainlink"));
    expect(chainlinkOccurrences.map((entry) =>
      relative(repositoryRoot, entry.file).split(sep).join("/"))).toEqual([
      "scripts/release/packaged-integration.mjs",
    ]);
    expect(chainlinkOccurrences[0]?.source.match(/chainlink/giu)).toHaveLength(1);
    expect(chainlinkOccurrences[0]?.source).toContain(
      'independentCanonicalJson(stockTokenContent).toLowerCase().includes("chainlink")',
    );
    for (const obsolete of [
      "ReferenceMarketApplication",
      "ReferenceMarketApplicationPort",
      "ReferenceMarketApplicationDependencies",
      "ReferenceMarketOwnerApplication",
      "ReferenceMarketOperationError",
      "referenceMarketApplicationContracts",
      "referenceMarketErrorRegistry",
      "reportReferenceMarketFailure",
      "market.stock_token_market",
      "market.reference_price",
      "market.reference_history",
      "market.watchlist",
      "MarketPortfolio",
      "marketPortfolio",
      "StockTokenMarket",
      "stockTokenMarket",
      "ExecutionIndex",
      "executionIndex",
      "canonicalStockTokenTradeHistoryJson",
      "encodeExecutionArtifact",
      "executionArtifactReference",
      "Release execution fixture",
      "readStockTokenAtBlock",
      "StockTokenChainRead",
      "resolveStockTokenMarketAsset",
      "stockTokenHistoryInterval",
      "stale_index",
      "maximumMarketTimeWindowMilliseconds",
      "stockTokenTradeHistoryApplicationContract",
    ]) {
      expect(sources.filter((entry) => entry.source.includes(obsolete)), obsolete).toEqual([]);
    }
    const productPaths = productSources.map((file) =>
      relative(sourceRoot, file).split(sep).join("/"));
    for (const obsoletePath of [
      "chain/reference-market.ts",
      "core/reference-market.ts",
      "interfaces/reference-market-cli.ts",
      "interfaces/reference-market-http.ts",
      "interfaces/market-portfolio-cli.ts",
      "interfaces/market-portfolio-http.ts",
      "interfaces/mcp-app/view/execution-chart.ts",
      "core/market-time-window.ts",
      "stock-token-trade-history/github-stock-token-trade-history.ts",
      "stock-token-trade-history/stock-token-trade-history-data.ts",
      "stock-token-trade-history/stock-token-trade-history-file.ts",
      "stock-token-trade-history/stock-token-trade-history-registry.generated.ts",
      "stock-token-trade-history/stock-token-trade-history-registry.json",
      "stock-token-trade-history/stock-token-trade-history.ts",
    ]) expect(productPaths).not.toContain(obsoletePath);
    expect(productPaths.some((path) => path.startsWith("market-portfolio/"))).toBe(false);
  });

  it("keeps chain invocation, opaque-block, observation, and token-inspection authority in their exact owners", async () => {
    const lifecycleOwners = new Set([
      resolve(sourceRoot, "chain/application.ts"),
      resolve(sourceRoot, "chain/index.ts"),
      resolve(sourceRoot, "chain/invocation-lifecycle.ts"),
    ]);
    const deadlineOwners = new Set([...lifecycleOwners, resolve(sourceRoot, "chain/invocation-limits.ts"),
      resolve(sourceRoot, "interfaces/exchange-bindings.ts"), resolve(sourceRoot, "interfaces/mcp-app/view/card-lifecycle.ts")]);
    const lifecycleViolations: string[] = [];
    for (const file of await collectSourceFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      if (
        (!lifecycleOwners.has(file) && source.includes("createChainInvocationLifecycle")) ||
        (!deadlineOwners.has(file) && source.includes("chainInvocationDeadlineMs"))
      ) {
        lifecycleViolations.push(relative(sourceRoot, file).split(sep).join("/"));
      }
    }
    expect(lifecycleViolations).toEqual([]);

    const privateFailureInspectorOwners = new Map([
      ["getChainInvocationStopReason", new Set([
        resolve(sourceRoot, "chain/errors.ts"),
      ])],
      ["getChainRpcErrorCode", new Set([
        resolve(sourceRoot, "chain/errors.ts"),
        resolve(sourceRoot, "chain/rpc.ts"),
      ])],
    ] as const);
    const failureInspectorViolations: string[] = [];
    for (const file of await collectSourceFiles(sourceRoot)) {
      const source = await readFile(file, "utf8");
      for (const [name, owners] of privateFailureInspectorOwners) {
        if (source.includes(name) && !owners.has(file)) {
          failureInspectorViolations.push(
            `${relative(sourceRoot, file).split(sep).join("/")}:${name}`,
          );
        }
      }
    }
    expect(failureInspectorViolations).toEqual([]);

    const atBlockPorts = [
      [resolve(sourceRoot, "chain/account-assets.ts"), "AccountAssetChainReadPort"],
      [resolve(sourceRoot, "chain/official-assets.ts"), "OfficialAssetChainReadPort"],
    ] as const;
    const blockPortViolations: string[] = [];
    for (const [file, interfaceName] of atBlockPorts) {
      const source = await readFile(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
          for (const member of node.members) {
            if (!ts.isMethodSignature(member)) continue;
            const text = member.getText(parsed);
            const hasBlockParameter = member.parameters.some((parameter) =>
              ts.isIdentifier(parameter.name) && parameter.name.text === "block") ||
              text.includes("block: CanonicalBlock");
            if (hasBlockParameter && (!text.includes("CanonicalBlock") || !text.includes("ChainInvocationContext"))) {
              blockPortViolations.push(`${relative(sourceRoot, file)}:${member.name.getText(parsed)}`);
            }
            if (hasBlockParameter && text.includes("block: ChainAnchor")) {
              blockPortViolations.push(`${relative(sourceRoot, file)}:${member.name.getText(parsed)}:raw-anchor`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect(blockPortViolations).toEqual([]);

    const coordinator = await readFile(resolve(sourceRoot, "token-catalog/coordinator.ts"), "utf8");
    for (const forbidden of [
      "CapabilityBindingRegistry",
      "CapabilityRegistry",
      "createTokenInspectionService",
      "tokenInspectCapability",
    ]) expect(coordinator).not.toContain(forbidden);
  });

  it("keeps Address target resolution in one Chain owner and one unchanged handoff", async () => {
    const [handlers, application, composition] = await Promise.all([
      readFile(resolve(sourceRoot, "chain/handlers.ts"), "utf8"),
      readFile(resolve(sourceRoot, "chain/application.ts"), "utf8"),
      readFile(resolve(sourceRoot, "runtime/composition.ts"), "utf8"),
    ]);
    expect(addressTargetHandoffViolations(application, handlers, composition)).toEqual([]);
    const replace = (source: string, before: string, after: string): string => {
      if (source.split(before).length !== 2) throw new TypeError("Handoff mutation is not unique.");
      return source.replace(before, after);
    };
    for (const [before, after, violation] of [
      ["addressTargets = createAddressTargetResolver({", "addressTargets = missingResolver({", "resolver_construction"],
      ["\n        addressTargets,", "\n        addressTargets: { ...addressTargets },", "handler_handoff"],
      ["\n      addressTargets,", "\n      addressTargets: { ...addressTargets },", "application_handoff"],
    ] as const) {
      expect(addressTargetHandoffViolations(
        replace(application, before, after), handlers, composition,
      )).toContain(violation);
    }
    expect(addressTargetHandoffViolations(application, replace(
      handlers, "input.addressTargets.resolve(target)", "input.addressTargets.resolve(otherTarget)",
    ), composition)).toContain("handler_resolution");
    expect(addressTargetHandoffViolations(application, replace(
      handlers, "input.addressTargets.resolve(target)", "input.context.activeWallet.capture()",
    ), composition)).toContain("handler_wallet_bypass");
    expect(addressTargetHandoffViolations(application, handlers, replace(
      composition, "const addressTargets = application.addressTargets;",
      "const addressTargets = { ...chainApplication.addressTargets };",
    ))).toContain("runtime_handoff");
  });


  it("binds target outcomes and comparisons to the actual shared Chain exports", async () => {
    const { canonicalProgram, productCodeFiles } = await loadDefaultStockTokenArchitectureFixture();
    expect(addressTargetConsumptionViolations(canonicalProgram)).toEqual([]);
    const file = resolve(sourceRoot, "chain/handlers.ts");
    const source = requiredProgramSource(canonicalProgram, file);
    const aliased = source
      .replace("  requireAvailableAddressTarget,\n", "  requireAvailableAddressTarget as admitTarget,\n")
      .replace("return requireAvailableAddressTarget(target);", "return admitTarget(target);");
    expect(aliased).not.toBe(source);
    const program = createProductSourceProgram(
      [...productCodeFiles], new Map([[file, aliased]]), canonicalProgram,
    );
    expect(addressTargetConsumptionViolations(program)).toEqual([]);
  }, 20_000);

  it("rejects copied, shadowed and discarded target-outcome admission", async () => {
    const { canonicalProgram, productCodeFiles } = await loadDefaultStockTokenArchitectureFixture();
    const file = resolve(sourceRoot, "chain/handlers.ts");
    const source = requiredProgramSource(canonicalProgram, file);
    const expectedReturn = "  return requireAvailableAddressTarget(target);";
    expect(source.split(expectedReturn)).toHaveLength(2);
    const localBody = [
      '  if (target.status === "unavailable") {',
      "    throw new ChainOperationError(target.failure);",
      "  }",
      "  return target;",
    ].join("\n");
    const variants = [
      [
        source.replace(expectedReturn, localBody).replace("  requireAvailableAddressTarget,\n", ""),
        "missing_available_owner",
      ],
      [
        source.replace("  requireAvailableAddressTarget,\n", "") +
          "\nconst requireAvailableAddressTarget = (target: AddressTargetResolution) => {\n" +
          localBody + "\n};\n",
        "missing_available_owner",
      ],
      [
        source.replace(expectedReturn,
          "  requireAvailableAddressTarget(target);\n  return target as ReturnType<typeof requireAvailableAddressTarget>;"),
        "shared_result_discarded",
      ],
      [
        source.replace(expectedReturn, "  return requireAvailableAddressTarget({ ...target });"),
        "shared_input",
      ],
    ] as const;
    for (const [variant, violation] of variants) {
      const program = createProductSourceProgram(
        [...productCodeFiles], new Map([[file, variant]]), canonicalProgram,
      );
      expect(addressTargetConsumptionViolations(program))
        .toContain(`chain/handlers.ts:requireInvocationAddressTarget:${violation}`);
    }
  }, 20_000);

  it("rejects unconsumed or locally replaced active-target comparisons", async () => {
    const { canonicalProgram, productCodeFiles } = await loadDefaultStockTokenArchitectureFixture();
    const file = resolve(sourceRoot, "account-assets/application.ts");
    const source = requiredProgramSource(canonicalProgram, file);
    const condition = [
      "if (!sameResolvedAddressTarget(initial, current)) {",
      '      throw new AccountAssetOperationError("state_conflict");',
      "    }",
    ].join("\n");
    expect(source.split(condition)).toHaveLength(2);
    const discarded = source.replace(condition, "sameResolvedAddressTarget(initial, current);");
    const shadowed = source.replace("  sameResolvedAddressTarget,\n", "") + [
      "",
      "const sameResolvedAddressTarget = (left: ResolvedAddressTarget, right: ResolvedAddressTarget) => {",
      "  if (left.target.kind !== right.target.kind || left.account.chainId !== right.account.chainId ||",
      "    left.account.address !== right.account.address) return false;",
      "  if (!left.active || !right.active) return !left.active && !right.active;",
      "  return left.connectionRevision === right.connectionRevision &&",
      "    left.sessionSource.sourceId === right.sessionSource.sourceId;",
      "};",
    ].join("\n");
    for (const [variant, violation] of [
      [discarded, "comparison_not_consumed"],
      [shadowed, "missing_comparison_owner"],
      [source.replace("sameResolvedAddressTarget(initial, current)",
        "sameResolvedAddressTarget(initial, initial)"), "comparison_input"],
    ]) {
      const program = createProductSourceProgram(
        [...productCodeFiles], new Map([[file, variant!]]), canonicalProgram,
      );
      expect(addressTargetConsumptionViolations(program))
        .toContain(`account-assets/application.ts:assertTargetContinuity:${violation}`);
    }
  }, 20_000);

  it("keeps neutral account retention and selected-account reads in their exact owners", async () => {
    const [accountAssets, tokenApplication, tokenCoordinator, database, schema, runtimeEntry] =
      await Promise.all([
        readFile(resolve(sourceRoot, "account-assets/application.ts"), "utf8"),
        readFile(resolve(sourceRoot, "token-catalog/application.ts"), "utf8"),
        readFile(resolve(sourceRoot, "token-catalog/coordinator.ts"), "utf8"),
        readFile(resolve(sourceRoot, "runtime/database.ts"), "utf8"),
        readFile(resolve(sourceRoot, "runtime/sqlite-schema.ts"), "utf8"),
        readFile(resolve(sourceRoot, "runtime/index.ts"), "utf8"),
      ]);

    for (const consumer of [accountAssets, tokenApplication, tokenCoordinator]) {
      expect(consumer).not.toContain("ActiveWalletReadPort");
      expect(consumer).not.toContain("activeWallet.capture");
      expect(consumer).not.toContain("captureConnectedWalletSession");
    }

    expect(database.match(/INSERT INTO account\(profile_id, chain_id, account_address\)/gu))
      .toHaveLength(2);
    const defaultWriter = database.slice(
      database.indexOf("private initializeDefaultTokenSelections"),
      database.indexOf("private assertCurrentWalletConnection"),
    );
    expect(defaultWriter).not.toMatch(/INSERT INTO account\(/u);
    expect(defaultWriter).not.toContain("current_wallet_connection");

    for (const owner of [database, schema, runtimeEntry]) {
      expect(owner).not.toContain("wallet_account");
      expect(owner).not.toContain("wallet_token_selection");
      expect(owner).not.toContain("WalletAccount");
      expect(owner).not.toContain("decodeWalletAccount");
    }
  });

  it("owns the final account-collection abort gate and synchronous commit publication", async () => {
    const source = await readFile(resolve(sourceRoot, "account-assets/application.ts"), "utf8");
    expect(accountCollectionLifecycleViolations(source)).toEqual([]);
    const preparationAndGate = [
      "const prepared = await prepareCollection(request, signal);",
      "        ensureNotAborted(caller, ownerAbort.signal);",
    ].join("\n");
    for (const [before, after, expected] of [
      [preparationAndGate, "const prepared = await prepareCollection(request, signal);", "final_abort_gate"],
      [preparationAndGate, [
        "ensureNotAborted(caller, ownerAbort.signal);",
        "        const prepared = await prepareCollection(request, signal);",
      ].join("\n"), "final_abort_gate"],
      ["return finalizeCollection(contract, request, prepared);",
        "return await finalizeCollection(contract, request, prepared);", "synchronous_publication"],
      ["const revision = committed !== undefined", [
        "dependencies.selections.getState(prepared.target.account);",
        "    const revision = committed !== undefined",
      ].join("\n"), "post_commit_dependency"],
      ["const revision = committed !== undefined", [
        "ensureNotAborted(caller, ownerAbort.signal);",
        "    const revision = committed !== undefined",
      ].join("\n"), "post_effect_stop"],
    ] as const) {
      if (source.split(before).length !== 2) throw new TypeError("Lifecycle mutation is not unique.");
      expect(accountCollectionLifecycleViolations(source.replace(before, after))).toContain(expected);
    }
  });

  it("confines SQLite snake-case row names to SQL aliases at the database adapter", async () => {
    const files = [resolve("src/runtime/database.ts"), resolve("src/runtime/wallet-connection-storage.ts")];
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        const record = (name: ts.PropertyName | undefined): void => {
          if (name !== undefined && ts.isIdentifier(name) && /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(name.text)) {
            violations.push(`${relative(sourceRoot, file)}:${name.text}`);
          }
        };
        if (ts.isPropertySignature(node) || ts.isPropertyAssignment(node) || ts.isMethodSignature(node)) {
          record(node.name);
        } else if (ts.isPropertyAccessExpression(node) && /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(node.name.text)) {
          violations.push(`${relative(sourceRoot, file)}:${node.name.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    expect(violations).toEqual([]);

  });
});
