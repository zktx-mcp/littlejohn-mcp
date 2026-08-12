import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPackageSourceRoots,
  classifyModuleSpecifier,
  collectProductCodeSourceFiles,
  collectProductSourceFiles,
  createIsolatedProductSourceProgram,
  createProductSourceProgram,
  createPackageImportPolicy,
  directCodeExecutionViolations,
  inspectDirectCodeExecution,
  inspectModuleImports,
  inspectSource,
  loadPackageManifest,
  moduleImportPolicyViolations,
  packageRoot,
  programModuleExportSymbol,
  protectedModuleAccessViolations,
  runtimePackageSourceRoots,
  uniswapV2SdkLoadBoundaryViolations,
  type PackageImportPolicy,
} from "./import-audit.js";

const testPolicy = (
  runtimePackageOwners: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  toolPackages: ReadonlySet<string> = new Set(),
  repositoryRoot = resolve("src"),
  auditedSourceFiles: readonly string[] = [],
  buildPackageOwners: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): PackageImportPolicy => ({
  auditedSourceFiles: new Set(auditedSourceFiles.map((path) => resolve(path))),
  buildPackageOwners,
  repositoryRoot,
  runtimePackageOwners,
  toolPackages,
});

const moduleViolations = (
  source: string,
  file: string,
  policy: PackageImportPolicy,
): readonly string[] => moduleImportPolicyViolations(file, inspectModuleImports(source, file), policy);

const executionKinds = (source: string, file: string): readonly string[] =>
  inspectDirectCodeExecution(source, file).map((reference) => reference.kind);

const replaceExact = (source: string, target: string, replacement: string): string => {
  const first = source.indexOf(target);
  if (first < 0 || source.indexOf(target, first + target.length) >= 0) {
    throw new TypeError(`Import-audit mutation target is not unique: ${target}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + target.length)}`;
};

const uniswapSdkViolationKinds = (violations: readonly string[]): readonly string[] =>
  violations.map((violation) => violation.replace(
    /^src\/protocols\/uniswap-v2\/sdk\.ts(?::\d+)?:/,
    "",
  ));

describe("module import audit", () => {
  it("normalizes package roots and rejects path, scheme, and malformed scoped forms", () => {
    expect(packageRoot("@walletconnect/sign-client")).toBe("@walletconnect/sign-client");
    expect(packageRoot("@walletconnect/sign-client/dist/index.js")).toBe("@walletconnect/sign-client");
    expect(packageRoot("react-dom/client")).toBe("react-dom");
    expect(packageRoot("reactive")).toBe("reactive");
    expect(packageRoot("qrcode-extra/path")).toBe("qrcode-extra");
    for (const nonPackage of [
      "",
      ".",
      "../wallet/client.js",
      "/absolute/module.js",
      "\\\\server\\module.js",
      "#internal",
      "node:crypto",
      "file:///module.js",
      "https://example.com/module.js",
      "C:/module.js",
      "@scope",
      "@scope//module",
      "@scope/name/../module",
      "@scope/name?query",
    ]) expect(packageRoot(nonPackage)).toBeUndefined();

    expect(classifyModuleSpecifier("@walletconnect/sign-client/dist/index.js")).toBe("package");
    expect(classifyModuleSpecifier("../wallet/client.js")).toBe("relative");
    expect(classifyModuleSpecifier("node:crypto")).toBe("node_builtin");
    for (const forbidden of [
      "data:text/javascript,export default 1",
      "file:///module.js",
      "https://example.com/module.js",
      "/absolute/module.js",
      "C:/module.js",
      "../../node_modules/qrcode",
      "./node_modules/qrcode",
      "#internal",
      "node:../module",
    ]) expect(classifyModuleSpecifier(forbidden)).toBe("forbidden");
  });

  it("derives every current package classification from package.json and one ownership map", async () => {
    const manifest = await loadPackageManifest();
    const policy = createPackageImportPolicy(manifest);
    expect(Object.keys(runtimePackageSourceRoots).sort()).toEqual(Object.keys(manifest.dependencies).sort());
    expect(Object.keys(buildPackageSourceRoots)).toEqual(["@modelcontextprotocol/ext-apps"]);
    expect(policy.buildPackageOwners.get("@modelcontextprotocol/ext-apps")).toEqual(new Set([
      resolve("scripts/release/packaged-integration.mjs"),
      resolve("src/interfaces/mcp-app/view/main.ts"),
    ]));
    expect(policy.runtimePackageOwners.get("zod")).toEqual(new Set([resolve("src")]));
    expect(policy.runtimePackageOwners.get("@noble/hashes")).toEqual(new Set([resolve("src/core")]));
    expect(policy.runtimePackageOwners.get("@uniswap/sdk-core"))
      .toEqual(new Set([resolve("src/protocols/uniswap-v2/sdk.ts")]));
    expect(policy.runtimePackageOwners.get("@uniswap/v2-sdk"))
      .toEqual(new Set([resolve("src/protocols/uniswap-v2/sdk.ts")]));
    expect(policy.runtimePackageOwners.get("better-sqlite3")).toEqual(new Set([
      resolve("src/runtime"),
      resolve("src/wallet/walletconnect-storage.ts"),
    ]));
    expect(policy.runtimePackageOwners.get("@walletconnect/sign-client"))
      .toEqual(new Set([resolve("src/wallet")]));
    expect(policy.runtimePackageOwners.get("qrcode")).toEqual(new Set([resolve("src/wallet")]));
    expect(policy.runtimePackageOwners.get("viem")).toEqual(new Set([
      resolve("src/chain"),
      resolve("src/intelligence"),
    ]));
    expect(policy.toolPackages.has("typescript")).toBe(true);
    expect(moduleViolations(
      `import { App } from "@modelcontextprotocol/ext-apps"; void App;`,
      resolve("src/interfaces/mcp-app/view/main.ts"),
      policy,
    )).toEqual([]);
    expect(moduleViolations(
      `import { App } from "@modelcontextprotocol/ext-apps"; void App;`,
      resolve("src/interfaces/mcp-app/view/lifecycle.ts"),
      policy,
    )).toEqual([
      "src/interfaces/mcp-app/view/lifecycle.ts:@modelcontextprotocol/ext-apps:" +
        "src/interfaces/mcp-app/view/main.ts|scripts/release/packaged-integration.mjs",
    ]);

    const missingQrcode = { ...manifest.dependencies };
    delete missingQrcode["qrcode"];
    expect(() => createPackageImportPolicy({ ...manifest, dependencies: missingQrcode }))
      .toThrow("Runtime package owner is undeclared: qrcode");
    expect(() => createPackageImportPolicy({
      ...manifest,
      dependencies: { ...manifest.dependencies, "qrcode-extra": "1.0.0" },
    })).toThrow("Runtime package has no source owner: qrcode-extra");
    expect(() => createPackageImportPolicy({
      ...manifest,
      devDependencies: { ...manifest.devDependencies, qrcode: manifest.dependencies["qrcode"] as string },
    })).toThrow("Package is both runtime and development dependency: qrcode");
  });

  it("collects literal imports, exports, import types, import-equals, dynamic imports, and direct require", () => {
    const sources = [
      ["consumer.ts", `
        import SignClient from "@walletconnect/sign-client";
        export { toString } from "qrcode";
        type PublicClient = import("viem").PublicClient;
        void import("react");
      `],
      ["consumer.tsx", `import { createRoot } from "react-dom/client"; export const view = <main />;`],
      ["consumer.mts", `export { createPublicClient } from "viem";`],
      ["consumer.cts", `import QRCode = require("qrcode"); void QRCode;`],
      ["consumer.cjs", `module.exports = require("qrcode");`],
    ] as const;
    const roots = sources.flatMap(([path, source]) => inspectModuleImports(source, path)
      .flatMap((reference) => reference.packageRoot === undefined ? [] : [reference.packageRoot]));
    expect(roots).toEqual([
      "@walletconnect/sign-client",
      "qrcode",
      "viem",
      "react",
      "react-dom",
      "viem",
      "qrcode",
      "qrcode",
    ]);

    const typeOnly = inspectModuleImports(`
      import type { PublicClient } from "viem";
      import { type Address } from "viem";
      export type { Hash } from "viem";
      type Client = import("viem").PublicClient;
    `, "types.ts").filter((reference) => reference.packageRoot === "viem");
    expect(typeOnly).toHaveLength(4);
    expect(typeOnly.every((reference) => !reference.runtime)).toBe(true);
    expect(inspectModuleImports('import "viem";', "runtime.ts")[0]?.runtime).toBe(true);
    for (const declarationPath of ["consumer.d.ts", "consumer.d.mts", "consumer.d.cts"]) {
      expect(inspectModuleImports('import SignClient from "@walletconnect/sign-client";', declarationPath)[0])
        .toMatchObject({ packageRoot: "@walletconnect/sign-client", runtime: false });
    }
  });

  it("classifies erased and runtime module forms without hiding an ambient require", () => {
    const references = inspectModuleImports(`
      import type TypeEqual = require("qrcode");
      import RuntimeEqual = require("qrcode");
      import type * as TypeNamespace from "viem";
      import * as RuntimeNamespace from "viem";
      export type * as TypeExports from "viem";
      export * as RuntimeExports from "viem";
      void [RuntimeEqual, RuntimeNamespace];
    `, "forms.cts");
    expect(references.map(({ kind, runtime, specifier }) => ({ kind, runtime, specifier })))
      .toEqual([
        { kind: "import_equals", runtime: false, specifier: "qrcode" },
        { kind: "import_equals", runtime: true, specifier: "qrcode" },
        { kind: "module", runtime: false, specifier: "viem" },
        { kind: "module", runtime: true, specifier: "viem" },
        { kind: "module", runtime: false, specifier: "viem" },
        { kind: "module", runtime: true, specifier: "viem" },
      ]);

    const typeOnlyRequire = inspectModuleImports(`
      import type require = require("./types.js");
      require("qrcode");
    `, "ambient-require.cts");
    expect(typeOnlyRequire.map(({ kind, runtime, specifier }) => ({ kind, runtime, specifier })))
      .toEqual([
        { kind: "import_equals", runtime: false, specifier: "./types.js" },
        { kind: "require", runtime: true, specifier: "qrcode" },
      ]);

    const typeOnlyNamespaceRequire = inspectModuleImports(`
      import type * as require from "./types.js";
      require("qrcode");
    `, "ambient-namespace-require.cts");
    expect(typeOnlyNamespaceRequire.map(({ kind, runtime, specifier }) => ({
      kind,
      runtime,
      specifier,
    }))).toEqual([
      { kind: "module", runtime: false, specifier: "./types.js" },
      { kind: "require", runtime: true, specifier: "qrcode" },
    ]);
  });

  it("rejects undeclared, misplaced, and development-only packages", async () => {
    const sourceRoot = resolve("src");
    const policy = createPackageImportPolicy(await loadPackageManifest());
    expect(moduleViolations(`
      import SignClient from "@walletconnect/sign-client";
      import QRCode from "qrcode";
      import { z } from "zod";
      void SignClient; void QRCode; void z;
    `, resolve("src/wallet/client.ts"), policy)).toEqual([]);
    expect(moduleViolations(
      `import extra from "qrcode-extra"; void extra;`,
      resolve("src/wallet/client.ts"),
      policy,
    )).toEqual(["src/wallet/client.ts:qrcode-extra:undeclared"]);
    expect(moduleViolations(
      `import type { PublicClient } from "viem";`,
      resolve("src/chain/client.ts"),
      policy,
    )).toEqual([]);
    expect(moduleViolations(
      `import { formatAbiItem } from "viem/utils";`,
      resolve("src/intelligence/source-adapter.ts"),
      policy,
    )).toEqual([]);
    for (const packageName of ["@uniswap/sdk-core", "@uniswap/v2-sdk"]) {
      expect(moduleViolations(
        `import type { Token } from ${JSON.stringify(packageName)};`,
        resolve("src/protocols/uniswap-v2/contracts.ts"),
        policy,
      )).toEqual([
        `src/protocols/uniswap-v2/contracts.ts:${packageName}:` +
        "src/protocols/uniswap-v2/sdk.ts",
      ]);
    }
    expect(moduleViolations(`
      import SignClient from "@walletconnect/sign-client";
      import QRCode from "qrcode";
    `, resolve("src/runtime/bypass.ts"), policy)).toEqual([
      "src/runtime/bypass.ts:@walletconnect/sign-client:src/wallet",
      "src/runtime/bypass.ts:qrcode:src/wallet",
    ]);
    expect(moduleViolations(
      `import ts from "typescript"; void ts;`,
      resolve("src/runtime/bypass.ts"),
      policy,
    )).toEqual(["src/runtime/bypass.ts:typescript:development_only"]);
    expect(policy.repositoryRoot).toBe(resolve("."));
    expect(sourceRoot).toBe(resolve("src"));
  });

  it("rejects nonliteral and forbidden module specifiers without claiming indirect execution coverage", () => {
    const sourceRoot = resolve("src");
    const file = resolve("src/wallet/loader.cts");
    const policy = testPolicy(new Map(), new Set(), sourceRoot);
    const source = `
      void import(target);
      require(name);
      type Dynamic = import(target).Value;
      void import("data:text/javascript,export default 1");
      require("/absolute/qrcode.cjs");
    `;
    expect(moduleViolations(source, file, policy)).toEqual(expect.arrayContaining([
      "wallet/loader.cts:dynamic_import:non_literal",
      "wallet/loader.cts:require:non_literal",
      "wallet/loader.cts:import_type:non_literal",
      "wallet/loader.cts:dynamic_import:forbidden_specifier",
      "wallet/loader.cts:require:forbidden_specifier",
    ]));
    expect(moduleViolations("import {", file, policy)).toContain("wallet/loader.cts:parse_error");
  });

  it("collects only unshadowed direct lexical require and restricts it to CommonJS source forms", () => {
    const sourceRoot = resolve("src");
    const policy = testPolicy(
      new Map([["qrcode", new Set([resolve("src/wallet")])]]),
      new Set(),
      sourceRoot,
    );
    const cjsFile = resolve("src/wallet/loader.cjs");
    expect(moduleViolations('require("qrcode");', cjsFile, policy)).toEqual([]);
    for (const source of [
      'const require = loader; require("qrcode");',
      'function load(require) { return require("qrcode"); }',
      'function require() { return {}; } require("qrcode");',
      'import { load as require } from "qrcode"; require("qrcode");',
    ]) {
      expect(inspectModuleImports(source, cjsFile).filter((reference) => reference.kind === "require"))
        .toEqual([]);
    }
    for (const extension of [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"]) {
      const file = resolve(`src/wallet/loader${extension}`);
      expect(moduleViolations('require("qrcode");', file, policy))
        .toContain(`wallet/loader${extension}:require:commonjs_only`);
    }
    expect(moduleViolations('import QRCode from "qrcode";', cjsFile, policy))
      .toContain("wallet/loader.cjs:module:esm_module_reference_in_commonjs");
  });

  it("closes every relative module reference over the audited source set", () => {
    const repositoryRoot = resolve(".");
    const allowed = [
      ["src/wallet/client.ts", "../runtime/index.js"],
      ["scripts/release-check.mjs", "../src/core/index.js"],
      ["vite.mcp-app.config.ts", "./vitest.config.ts"],
      ["src/interfaces/mcp-app/view/main.ts", "./lifecycle.js"],
      ["src/interfaces/mcp-app/view/main.ts", "./visual-tokens.css"],
      ["src/runtime/esm-consumer.mts", "./esm-target.mjs"],
      ["src/runtime/cjs-consumer.cts", "./cjs-target.cjs"],
    ] as const;
    const auditedFiles = [
      ...allowed.map(([fileName]) => resolve(fileName)),
      resolve("src/runtime/index.ts"),
      resolve("src/core/index.ts"),
      resolve("vitest.config.ts"),
      resolve("src/interfaces/mcp-app/view/lifecycle.ts"),
      resolve("src/interfaces/mcp-app/view/visual-tokens.css"),
      resolve("src/runtime/esm-target.mts"),
      resolve("src/runtime/cjs-target.cts"),
    ];
    const policy = testPolicy(new Map(), new Set(), repositoryRoot, auditedFiles);
    for (const [fileName, specifier] of allowed) {
      expect(moduleViolations(
        `import ${JSON.stringify(specifier)};`,
        resolve(fileName),
        policy,
      )).toEqual([]);
    }
    for (const [fileName, specifier] of [
      ["src/wallet/client.ts", "../../../outside-loader.mjs"],
      ["scripts/release-check.mjs", "../../outside-loader.mjs"],
      ["vite.mcp-app.config.ts", "../outside-loader.mjs"],
      ["vite.mcp-app.config.ts", "./config/loader.ts"],
      ["src/wallet/client.ts", "../../vitest.config.ts"],
      ["src/wallet/client.ts", "./native.node"],
      ["src/wallet/client.ts", "./local.js?variant=1"],
      ["src/wallet/client.ts", "./does-not-exist.js"],
    ] as const) {
      expect(moduleViolations(
        `import ${JSON.stringify(specifier)};`,
        resolve(fileName),
        policy,
      )).toContain(`${fileName}:module:relative_outside_audit`);
    }

    const ambiguousPolicy = testPolicy(new Map(), new Set(), repositoryRoot, [
      resolve("src/interfaces/consumer.ts"),
      resolve("src/interfaces/target.ts"),
      resolve("src/interfaces/target.tsx"),
    ]);
    expect(moduleViolations(
      'import "./target.js";',
      resolve("src/interfaces/consumer.ts"),
      ambiguousPolicy,
    )).toContain("src/interfaces/consumer.ts:module:relative_outside_audit");
  });

  it("collects product sources without generated or ignored work material", async () => {
    const files = await collectProductSourceFiles(resolve("."));
    expect(files).toContain(resolve("src/cli.ts"));
    expect(files).toContain(resolve("src/interfaces/mcp-app/view/visual-tokens.css"));
    expect(files).toContain(resolve("scripts/clean.mjs"));
    expect(files).toContain(resolve("vitest.config.ts"));
    expect(files.some((file) => file.includes("/dist/"))).toBe(false);
    expect(files.some((file) => file.includes("/.WORK/"))).toBe(false);

    const codeFiles = await collectProductCodeSourceFiles(resolve("src"));
    expect(codeFiles).toContain(resolve("src/cli.ts"));
    expect(codeFiles).not.toContain(resolve("src/interfaces/mcp-app/view/visual-tokens.css"));
    expect(() => createProductSourceProgram([
      resolve("src/interfaces/mcp-app/view/visual-tokens.css"),
    ])).toThrow("Product TypeScript program received an unsupported source");
  });

  it("uses the same runtime classification for protected module acquisitions", async () => {
    const sourceRoot = resolve("src");
    const protectedFile = resolve(sourceRoot, "runtime/sqlite-schema.ts");
    const admittedFile = resolve(sourceRoot, "runtime/import-audit-erased-consumer.cts");
    const shadowedFile = resolve(sourceRoot, "runtime/import-audit-shadowed-consumer.cts");
    const ambientRequireFile = resolve(
      sourceRoot,
      "runtime/import-audit-ambient-require-consumer.cts",
    );
    const namespaceImportFile = resolve(
      sourceRoot,
      "runtime/import-audit-namespace-import-consumer.ts",
    );
    const namespaceExportFile = resolve(
      sourceRoot,
      "runtime/import-audit-namespace-export-consumer.ts",
    );
    const importEqualsFile = resolve(
      sourceRoot,
      "runtime/import-audit-import-equals-consumer.cts",
    );
    const dynamicImportFile = resolve(
      sourceRoot,
      "runtime/import-audit-dynamic-import-consumer.ts",
    );
    const unresolvedFile = resolve(sourceRoot, "runtime/import-audit-unresolved-consumer.cts");
    const overrides = new Map([
      [admittedFile, `
import type TypeEqual = require("./sqlite-schema.js");
import type * as TypeNamespace from "./sqlite-schema.js";
export type * as TypeExports from "./sqlite-schema.js";
`],
      [shadowedFile, `
const require = (_specifier: string) => undefined;
require("./sqlite-schema.js");
`],
      [ambientRequireFile, `
import type require = require("./sqlite-schema.js");
require("./sqlite-schema.js");
`],
      [namespaceImportFile, `import * as Protected from "./sqlite-schema.js"; void Protected;`],
      [namespaceExportFile, `export * as Protected from "./sqlite-schema.js";`],
      [importEqualsFile, `import Protected = require("./sqlite-schema.js"); void Protected;`],
      [dynamicImportFile, `void import("./sqlite-schema.js");`],
      [unresolvedFile, `declare const target: string; require(target);`],
    ]);
    const program = createProductSourceProgram(
      await collectProductCodeSourceFiles(sourceRoot),
      overrides,
    );
    const protectedSymbol = programModuleExportSymbol(
      program,
      program.getTypeChecker(),
      protectedFile,
      "createRuntimeStateResetRequiredError",
    );
    if (protectedSymbol === undefined) throw new TypeError("Protected fixture symbol is unavailable.");
    const violations = protectedModuleAccessViolations(
      program,
      new Set([protectedSymbol]),
      sourceRoot,
    );

    expect(violations.some((violation) => violation.startsWith(
      "runtime/import-audit-erased-consumer.cts:",
    ))).toBe(false);
    expect(violations.some((violation) => violation.startsWith(
      "runtime/import-audit-shadowed-consumer.cts:",
    ))).toBe(false);
    for (const [file, kind] of [
      ["import-audit-ambient-require-consumer.cts", "protected_module_require"],
      ["import-audit-namespace-import-consumer.ts", "protected_module_namespace_import"],
      ["import-audit-namespace-export-consumer.ts", "protected_module_namespace_export"],
      ["import-audit-import-equals-consumer.cts", "protected_module_import_equals"],
      ["import-audit-dynamic-import-consumer.ts", "protected_module_dynamic_import"],
      ["import-audit-unresolved-consumer.cts", "unresolved_runtime_module_load"],
    ] as const) {
      expect(violations.some((violation) =>
        violation.startsWith(`runtime/${file}:`) && violation.endsWith(`:${kind}`)),
      `${file}:${kind}`).toBe(true);
    }
    expect(violations).toHaveLength(6);
  });
});

describe("direct code execution audit", () => {
  it("separates direct execution findings from module ownership findings", () => {
    const source = `import fs from "node:fs"; const compile = Function; compile(source);`;
    const file = resolve("src/runtime/example.ts");
    const audit = inspectSource(source, file);
    expect(audit.moduleImports.map((reference) => reference.specifier)).toEqual(["node:fs"]);
    expect(audit.directCodeExecutions).toEqual([{ kind: "global_function" }]);
    expect(moduleImportPolicyViolations(
      file,
      audit.moduleImports,
      testPolicy(new Map(), new Set(), resolve("src")),
    )).toEqual([]);
    expect(directCodeExecutionViolations(file, audit.directCodeExecutions, resolve("src")))
      .toEqual(["runtime/example.ts:direct_code_execution:global_function"]);
  });

  it("keeps direct-execution policy as the generic createRequire category guard", () => {
    const root = resolve(".");
    const sdkFile = resolve("src/protocols/uniswap-v2/sdk.ts");
    const walletFile = resolve("src/wallet/execution.ts");
    const references = [
      { kind: "node_module" as const },
      { kind: "create_require" as const },
    ];
    expect(directCodeExecutionViolations(sdkFile, references, root)).toEqual([]);
    expect(directCodeExecutionViolations(walletFile, references, root)).toEqual([
      "src/wallet/execution.ts:direct_code_execution:node_module",
      "src/wallet/execution.ts:direct_code_execution:create_require",
    ]);
    expect(directCodeExecutionViolations(
      sdkFile,
      [...references, { kind: "global_eval" }],
      root,
    )).toEqual([
      "src/protocols/uniswap-v2/sdk.ts:direct_code_execution:global_eval",
    ]);
  });

  it("proves the exact V2 SDK loader use graph with symbol-bound mutations", async () => {
    const root = resolve(".");
    const sdkFile = resolve("src/protocols/uniswap-v2/sdk.ts");
    const sourceFiles = await collectProductCodeSourceFiles(resolve("src"));
    const canonicalSource = await readFile(sdkFile, "utf8");
    const policy = createPackageImportPolicy(
      await loadPackageManifest(resolve(root, "package.json")),
      root,
      sourceFiles,
    );
    const canonicalProgram = createIsolatedProductSourceProgram(sdkFile);
    expect(uniswapV2SdkLoadBoundaryViolations(canonicalProgram, policy)).toEqual([]);

    const afterLoader = (addition: string): string => replaceExact(
      canonicalSource,
      "const require = createRequire(import.meta.url);",
      `const require = createRequire(import.meta.url);\n${addition}`,
    );
    const mutationCases = [
      {
        name: "loader alias with hidden relative target",
        source: afterLoader(`
const escapedRequire = require;
escapedRequire("../../runtime/sqlite-schema.js");`),
        kind: "loader_escape",
      },
      {
        name: "additional package load",
        source: afterLoader(`const extraPackage = require("qrcode");`),
        kind: "unexpected_package_load",
      },
      {
        name: "additional relative load",
        source: afterLoader(`const relativeModule = require("../../runtime/sqlite-schema.js");`),
        kind: "unexpected_package_load",
      },
      {
        name: "additional builtin load",
        source: afterLoader(`const builtinModule = require("node:fs");`),
        kind: "unexpected_package_load",
      },
      {
        name: "alternate static SDK package load",
        source: replaceExact(
          canonicalSource,
          `import { createRequire } from "node:module";`,
          `import { createRequire } from "node:module";\n` +
          `import * as AlternateSdk from "@uniswap/sdk-core";\nvoid AlternateSdk;`,
        ),
        kind: "alternate_sdk_package_load",
      },
      {
        name: "alternate dynamic SDK package load",
        source: afterLoader(`void import("@uniswap/v2-sdk");`),
        kind: "alternate_sdk_package_load",
      },
      {
        name: "additional static Node builtin access",
        source: replaceExact(
          canonicalSource,
          `import { createRequire } from "node:module";`,
          `import { createRequire } from "node:module";\nimport fs from "node:fs";\nvoid fs;`,
        ),
        kind: "unexpected_node_builtin_access",
      },
      {
        name: "duplicate exact package load",
        source: afterLoader(`const duplicateCore = require("@uniswap/sdk-core");`),
        kind: "duplicate_package_load:@uniswap/sdk-core",
      },
      {
        name: "nonliteral package load",
        source: afterLoader(`
const packageName = "@uniswap/sdk-core";
const dynamicPackage = require(packageName);`),
        kind: "nonliteral_package_load",
      },
      {
        name: "alternate createRequire argument",
        source: replaceExact(
          canonicalSource,
          "const require = createRequire(import.meta.url);",
          `const require = createRequire(new URL(".", import.meta.url));`,
        ),
        kind: "create_require_factory_escape",
      },
      {
        name: "factory escape",
        source: replaceExact(
          canonicalSource,
          `import { createRequire } from "node:module";`,
          `import { createRequire } from "node:module";\nconst escapedFactory = createRequire;`,
        ),
        kind: "create_require_factory_escape",
      },
      {
        name: "factory property storage",
        source: replaceExact(
          canonicalSource,
          `import { createRequire } from "node:module";`,
          `import { createRequire } from "node:module";\nconst storedFactory = { createRequire };`,
        ),
        kind: "create_require_factory_escape",
      },
      {
        name: "factory named export",
        source: replaceExact(
          canonicalSource,
          `import { createRequire } from "node:module";`,
          `import { createRequire } from "node:module";\nexport { createRequire };`,
        ),
        kind: "create_require_factory_escape",
      },
      {
        name: "duplicate createRequire import",
        source: replaceExact(
          canonicalSource,
          `import { createRequire } from "node:module";`,
          `import { createRequire } from "node:module";\n` +
          `import { createRequire } from "node:module";`,
        ),
        kind: "duplicate_create_require_import",
      },
      {
        name: "duplicate loader construction",
        source: afterLoader(`const secondRequire = createRequire(import.meta.url);`),
        kind: "duplicate_loader_construction",
      },
      {
        name: "loader argument escape",
        source: afterLoader(`Object.freeze(require);`),
        kind: "loader_escape",
      },
      {
        name: "loader return escape",
        source: afterLoader(`const exposeLoader = () => require;`),
        kind: "loader_escape",
      },
      {
        name: "exported loader construction",
        source: replaceExact(
          canonicalSource,
          "const require = createRequire(import.meta.url);",
          "export const require = createRequire(import.meta.url);",
        ),
        kind: "create_require_factory_escape",
      },
      {
        name: "loader named export",
        source: afterLoader(`export { require };`),
        kind: "loader_escape",
      },
      {
        name: "loader property storage",
        source: afterLoader(`const storedLoader = { require };`),
        kind: "loader_escape",
      },
      {
        name: "loader property access",
        source: afterLoader(`void require.resolve;`),
        kind: "loader_escape",
      },
      {
        name: "optional loader call",
        source: afterLoader(`void require?.("@uniswap/sdk-core");`),
        kind: "loader_escape",
      },
      {
        name: "aliased factory import",
        source: replaceExact(
          replaceExact(
            canonicalSource,
            `import { createRequire } from "node:module";`,
            `import { createRequire as makeRequire } from "node:module";`,
          ),
          "const require = createRequire(import.meta.url);",
          "const require = makeRequire(import.meta.url);",
        ),
        kind: "unexpected_node_builtin_access",
      },
      {
        name: "missing exact package load",
        source: replaceExact(
          canonicalSource,
          `const v2 = exactRecord(require("@uniswap/v2-sdk"), "Uniswap V2");`,
          `const v2 = exactRecord({}, "Uniswap V2");`,
        ),
        kind: "missing_package_load:@uniswap/v2-sdk",
      },
    ] as const;

    for (const mutation of mutationCases) {
      const program = createIsolatedProductSourceProgram(
        sdkFile,
        mutation.source,
        canonicalProgram,
      );
      const kinds = uniswapSdkViolationKinds(
        uniswapV2SdkLoadBoundaryViolations(program, policy),
      );
      expect(kinds, mutation.name).toContain(mutation.kind);
    }

    const inertSource = afterLoader(`
const inertAuditText =
  'createRequire(import.meta.url); require("@uniswap/sdk-core"); require("node:fs");';
void inertAuditText;`);
    const inertProgram = createIsolatedProductSourceProgram(
      sdkFile,
      inertSource,
      canonicalProgram,
    );
    expect(uniswapV2SdkLoadBoundaryViolations(inertProgram, policy)).toEqual([]);
  }, 15_000);

  it("uses bound symbols to distinguish global eval and Function from local shadows", () => {
    const file = resolve("src/wallet/execution.ts");
    expect(executionKinds(`
      const indirectEval = eval;
      (0, eval)(source);
      const Constructor = Function;
      new Function(source);
      globalThis.eval(source);
      global["Function"](source);
      globalThis.globalThis.eval(source);
      global.globalThis.global.Function(source);
    `, file)).toEqual(["global_eval", "global_function"]);

    for (const source of [
      `const eval = localEval; const Function = LocalFunction; eval(source); new Function(source);`,
      `function run(eval, Function) { eval(source); return new Function(source); }`,
      `import { eval, Function } from "safe-library"; eval(source); new Function(source);`,
      `const globalThis = localHost; globalThis.eval(source);`,
      `const global = localHost; global.Function(source);`,
      `const values = { eval: false, Function: false }; class Names { eval() {}; Function() {} }`,
      `type EvalType = typeof eval; type FunctionType = typeof Function;`,
      `const name = value.constructor.name; void name;`,
    ]) expect(executionKinds(source, file), source).toEqual([]);
    expect(executionKinds(`declare const eval: (source: string) => unknown; eval(source);`, file))
      .toEqual(["global_eval"]);
    expect(executionKinds(`declare const Function: FunctionConstructor; new Function(source);`, file))
      .toEqual(["global_function"]);
    expect(executionKinds(`import type { eval } from "types"; eval(source);`, file))
      .toEqual(["global_eval"]);
  });

  it("blocks explicit node:module, createRequire, and process.getBuiltinModule acquisition", () => {
    const file = resolve("src/wallet/execution.ts");
    expect(executionKinds(`
      import { createRequire as makeRequire } from "node:module";
      const getBuiltin = process.getBuiltinModule;
      void makeRequire; void getBuiltin;
    `, file)).toEqual(["node_module", "create_require", "process_loader"]);
    expect(executionKinds(`export { createRequire } from "node:module";`, file))
      .toEqual(["node_module", "create_require"]);
    expect(executionKinds(`type NodeModule = import("node:module").Module;`, file)).toEqual([]);
    expect(executionKinds(`import type { createRequire } from "node:module";`, file)).toEqual([]);
    expect(executionKinds(`
      const process = { getBuiltinModule: localLoader };
      process.getBuiltinModule("node:fs");
      const createRequire = localLoader;
      createRequire(url);
    `, file)).toEqual([]);
  });

  it("blocks escaping sensitive loader hosts through aliases or destructuring", () => {
    const esmFile = resolve("src/wallet/execution.ts");
    expect(executionKinds(`
      const host = globalThis;
      host.eval(source);
      new host.Function(source);
    `, esmFile)).toEqual(["global_eval", "global_function"]);
    expect(executionKinds(`
      const runtimeProcess = process;
      runtimeProcess.getBuiltinModule(name);
    `, esmFile)).toEqual(["process_loader"]);
    expect(executionKinds(`
      const { eval: evaluate } = globalThis;
      const { getBuiltinModule } = process;
      evaluate(source);
      getBuiltinModule(name);
    `, esmFile)).toEqual(["global_eval", "global_function", "process_loader"]);
    expect(executionKinds(`
      globalThis[member](source);
      process[member](name);
    `, esmFile)).toEqual(["global_eval", "global_function", "process_loader"]);

    const commonJsFile = resolve("src/wallet/execution.cjs");
    expect(executionKinds(`
      const commonJsModule = module;
      commonJsModule.require(name);
    `, commonJsFile)).toEqual(["cjs_module_loader"]);
    expect(executionKinds(`module[member](name);`, commonJsFile))
      .toEqual(["cjs_module_loader"]);

    expect(executionKinds(`
      process.platform;
      process.stdout.write("safe");
      globalThis.process.platform;
      globalThis.process.stdout.write("safe");
      globalThis.crypto.getRandomValues(buffer);
    `, esmFile)).toEqual([]);
    expect(executionKinds(`
      globalThis.module.id;
      globalThis.module.filename;
    `, commonJsFile)).toEqual([]);
  });

  it("blocks CommonJS wrapper arguments and module.require but allows owned local bindings", () => {
    const file = resolve("src/wallet/execution.cjs");
    expect(executionKinds(`
      arguments[1]("qrcode");
      const load = () => arguments[1]("qrcode");
      module.require("qrcode");
    `, file)).toEqual(["cjs_arguments", "cjs_module_loader"]);
    expect(executionKinds(`
      function local() { return arguments[0]; }
      function load(module) { return module.require("qrcode"); }
      const owned = { require() {} }; owned.require("qrcode");
    `, file)).toEqual([]);
    expect(executionKinds(`const module = owned; module.require("qrcode");`, file)).toEqual([]);
    expect(executionKinds(`const arguments = owned; arguments[1]("qrcode");`, file)).toEqual([]);
  });

  it("permits only direct unshadowed require calls as module acquisition", () => {
    const file = resolve("src/wallet/execution.cjs");
    expect(executionKinds(`require("qrcode");`, file)).toEqual([]);
    for (const source of [
      `const load = require; load("qrcode");`,
      `require.resolve("qrcode");`,
      `require?.("qrcode");`,
    ]) expect(executionKinds(source, file)).toContain("cjs_require_reference");
    for (const source of [
      `const require = localLoader; require("qrcode");`,
      `function load(require) { return require("qrcode"); }`,
      `declare const require: (name: string) => unknown; require("qrcode");`,
    ]) expect(executionKinds(source, file)).toEqual([]);
  });

  it("blocks nested CommonJS and process loader paths while respecting local shadows", () => {
    const commonJsFile = resolve("src/wallet/execution.cjs");
    for (const source of [
      `module.constructor._load("qrcode");`,
      `const Module = module.constructor; Module._load("qrcode");`,
      `module.parent.require("qrcode");`,
      `module.children[0].require("qrcode");`,
      `globalThis.module.constructor._load("qrcode");`,
    ]) expect(executionKinds(source, commonJsFile), source).toEqual(["cjs_module_loader"]);

    const esmFile = resolve("src/wallet/execution.ts");
    for (const source of [
      `process.mainModule.require("qrcode");`,
      `process.binding(name);`,
      `process._linkedBinding(name);`,
      `process.dlopen(module, path);`,
      `globalThis.process.mainModule.require("qrcode");`,
      `globalThis.globalThis.process.mainModule.require("qrcode");`,
    ]) expect(executionKinds(source, esmFile), source).toEqual(["process_loader"]);

    expect(executionKinds(
      `globalThis.globalThis.module.constructor._load("qrcode");`,
      commonJsFile,
    )).toEqual(["cjs_module_loader"]);

    expect(executionKinds(`
      function load(module, process) {
        module.constructor._load("qrcode");
        process.mainModule.require("qrcode");
      }
    `, commonJsFile)).toEqual([]);
  });

  it("blocks sensitive host escape without claiming general constructor dispatch coverage", () => {
    const file = resolve("src/wallet/execution.ts");
    expect(executionKinds(`Reflect.get(globalThis, key)(source);`, file))
      .toEqual(["global_eval", "global_function"]);
    expect(executionKinds(`
      const key = "constructor";
      (() => {})[key](source)();
      import type { Context } from "node:vm";
    `, file)).toEqual([]);
    expect(inspectModuleImports(`import type { Context } from "node:vm";`, file))
      .toEqual([expect.objectContaining({ runtime: false, specifier: "node:vm" })]);
  });
});
