import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { build } from "vite";
import { describe, expect, it } from "vitest";

import { productDisplayName } from "../../src/core/index.js";
import {
  auditBrowserSourceModule,
  browserModulePolicyViolation,
} from "../../scripts/browser-build-policy.js";
import { loadBrowserAssetBundle } from "../../src/interfaces/browser-assets.js";

interface EmittedAsset {
  readonly fileName: string;
  readonly type: "asset";
}

interface EmittedChunk {
  readonly code: string;
  readonly dynamicImports: readonly string[];
  readonly fileName: string;
  readonly imports: readonly string[];
  readonly modules: Readonly<Record<string, unknown>>;
  readonly type: "chunk";
}

type EmittedOutput = EmittedAsset | EmittedChunk;

interface BuildOutput {
  readonly output: readonly EmittedOutput[];
}

const repositoryRoot = resolve(".");
const nodeModulesRoot = resolve(repositoryRoot, "node_modules");
const webSourceRoot = resolve(repositoryRoot, "src/interfaces/web");
const browserContractSource = resolve(repositoryRoot, "src/interfaces/browser-contract.ts");
const webApplicationSource = resolve(webSourceRoot, "app.tsx");
const walletClientSource = resolve(webSourceRoot, "wallet-client.ts");
const browserClientSource = resolve(webSourceRoot, "browser-client.ts");
const tokenCatalogClientSource = resolve(webSourceRoot, "token-catalog-client.ts");
const tokenCatalogPageSource = resolve(webSourceRoot, "token-catalog-page.tsx");
const operationStateSource = resolve(repositoryRoot, "src/wallet/operation-state.ts");
const chainErrorDefinitionsSource = resolve(repositoryRoot, "src/chain/error-definitions.ts");
const tokenCatalogBrowserSource = resolve(repositoryRoot, "src/token-catalog/browser.ts");
const tokenCatalogContractSchemaSource = resolve(
  repositoryRoot,
  "src/token-catalog/contract-schema.ts",
);
const tokenCatalogErrorDefinitionsSource = resolve(
  repositoryRoot,
  "src/token-catalog/error-definitions.ts",
);
const tokenCatalogHttpContractSource = resolve(
  repositoryRoot,
  "src/token-catalog/http-contract.ts",
);
const allowedVirtualModules = new Set([
  "\0commonjsHelpers.js",
  "\0rolldown/runtime.js",
  "\0vite/modulepreload-polyfill.js",
]);

const parseBuildOutputs = (value: unknown): readonly BuildOutput[] => {
  const candidates = Array.isArray(value) ? value : [value];
  if (candidates.some((candidate) => (
    typeof candidate !== "object" ||
    candidate === null ||
    !("output" in candidate) ||
    !Array.isArray(candidate.output)
  ))) throw new TypeError("The browser build did not return a static output graph.");
  return candidates as readonly BuildOutput[];
};

const hashedJavaScriptChunk = /^assets\/[a-z0-9][a-z0-9_-]*-[A-Za-z0-9_-]{8,}\.js$/u;

describe("browser runtime dependency boundary", () => {
  it("keeps the allowlist closed against server and foreign runtime families", () => {
    const allowed = [
      resolve(webSourceRoot, "main.tsx"),
      operationStateSource,
      resolve(repositoryRoot, "src/wallet/operation-contract.ts"),
      resolve(repositoryRoot, "src/core/wallet-connection.ts"),
      chainErrorDefinitionsSource,
      tokenCatalogBrowserSource,
      tokenCatalogContractSchemaSource,
      tokenCatalogErrorDefinitionsSource,
      tokenCatalogHttpContractSource,
      resolve(nodeModulesRoot, "react/index.js"),
      resolve(nodeModulesRoot, "react-dom/client.js"),
      resolve(nodeModulesRoot, "scheduler/index.js"),
      resolve(nodeModulesRoot, "zod/index.js"),
      ...allowedVirtualModules,
    ];
    expect(allowed.map(browserModulePolicyViolation)).toEqual(allowed.map(() => undefined));

    const forbidden = [
      "node:fs",
      resolve(repositoryRoot, "src/runtime/composition.ts"),
      resolve(repositoryRoot, "src/runtime/control-credential.ts"),
      resolve(repositoryRoot, "src/runtime/database.ts"),
      resolve(repositoryRoot, "src/chain/rpc.ts"),
      resolve(repositoryRoot, "src/token-catalog/contracts.ts"),
      resolve(repositoryRoot, "src/token-catalog/errors.ts"),
      resolve(repositoryRoot, "src/token-catalog/index.ts"),
      resolve(repositoryRoot, "src/wallet/contracts.ts"),
      resolve(repositoryRoot, "src/wallet/coordinator.ts"),
      resolve(nodeModulesRoot, "@modelcontextprotocol/sdk/dist/esm/index.js"),
      resolve(nodeModulesRoot, "@walletconnect/sign-client/dist/index.js"),
      resolve(nodeModulesRoot, "better-sqlite3/lib/index.js"),
      resolve(nodeModulesRoot, "react-dom/node_modules/better-sqlite3/lib/index.js"),
      resolve(nodeModulesRoot, "viem/index.js"),
      resolve(nodeModulesRoot, "evil/node_modules/react/index.js"),
    ];
    expect(forbidden.map(browserModulePolicyViolation)).toEqual(forbidden);
  });

  it("rejects semantic loading and navigation sinks while permitting inert URI text", async () => {
    const hostile = [
      `globalThis["fetch"]("/outside", {});`,
      `const send = globalThis.fetch; send("/outside", {});`,
      `window["open"]("https://example.invalid");`,
      `window.close();`,
      `window.location.reload();`,
      `document.createElement("img");`,
      `const image = <img src="/outside" />;`,
      `const link = <a href="/outside">outside</a>;`,
      `window.location["href"] = "https://example.invalid";`,
      `const storage = window.sessionStorage; storage.setItem("outside", "value");`,
      `window.sessionStorage.setItem("outside", "value");`,
      `const worker = new Worker("/worker.js");`,
      `node.setAttribute("src", "/outside");`,
      `open("https://example.invalid");`,
      `location = "https://example.invalid";`,
      `const g = globalThis; g.fetch("/outside");`,
      `const image = React.createElement("img", { src: "/outside" });`,
      `const markup = <div dangerouslySetInnerHTML={{ __html: "<img src=/outside>" }} />;`,
      `const styled = <div style={{ backgroundImage: "url(/outside)" }} />;`,
      `const refresh = <meta httpEquiv="refresh" content="0;url=/outside" />;`,
      `const image = <svg><image href="/outside" /></svg>;`,
      `document.querySelector("#root")!.innerHTML = "<img src=/outside>";`,
      `document.querySelector("#root")!.setAttribute("src", "/outside");`,
      `document.querySelector("#root")!.style.setProperty("background", "url(/outside)");`,
      `document.querySelector("#root")!.insertAdjacentHTML("beforeend", "<img src=/outside>");`,
      `const m = document.querySelector("meta"); m.setAttribute("http-equiv", "refresh");`,
      `const r = document.getElementById("root"); Object.assign(r, { innerHTML: "<meta http-equiv=refresh>" });`,
      `import { createElement as c } from "react"; c("meta", { httpEquiv: "refresh" });`,
      `new DOMParser().parseFromString("<meta http-equiv=refresh>", "text/html");`,
      `new Audio("https://example.invalid/audio.mp3");`,
      `setTimeout("fetch('https://example.invalid')", 0);`,
      `setInterval("open('https://example.invalid')", 0);`,
      `(() => undefined).constructor("fetch('https://example.invalid')")();`,
      `const C = (() => undefined).constructor; C("location.href='https://example.invalid'")();`,
      `const C = (() => undefined)["constructor"]; C("location.href='https://example.invalid'")();`,
      `const key = "constructor"; const C = (() => undefined)[key]; C("location.href='https://example.invalid'")();`,
      `const key = "con" + "structor"; const C = (() => undefined)[key]; C("location.href='https://example.invalid'")();`,
      `const key = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); ` +
        `const C = (() => undefined)[key]; C("location.href='https://example.invalid'")();`,
      `const { constructor: C } = (() => undefined); C("location.href='https://example.invalid'")();`,
      `(() => undefined).constructor.call(null, "location.href='https://example.invalid'")();`,
      `Reflect.get(() => undefined, "constructor")("location.href='https://example.invalid'")();`,
      `Object.getOwnPropertyDescriptor(Reflect.getPrototypeOf(() => undefined), "constructor")?.value(` +
        `"location.href='https://example.invalid'")();`,
      `Object.getOwnPropertyNames(() => undefined)[0];`,
      `Object.values(Object.getOwnPropertyDescriptors(() => undefined))[0]?.value;`,
      `Notification.requestPermission();`,
      `const page = <button ref={node => Object.assign(node, { innerHTML: "<meta http-equiv=refresh>" })}>x</button>;`,
      `const page = <button onClick={event => event.currentTarget.ownerDocument.defaultView.fetch("/outside")}>x</button>;`,
    ];
    for (const [index, source] of hostile.entries()) {
      expect(
        auditBrowserSourceModule(source, resolve(webSourceRoot, `hostile-${index}.tsx`)),
        source,
      ).not.toEqual([]);
    }
    expect(auditBrowserSourceModule(
      `const diagnostic = "https://react.dev/errors/1";\n` +
      `const namespace = "http://www.w3.org/2000/svg";`,
      resolve(webSourceRoot, "inert-text.ts"),
    )).toEqual([]);
    expect(auditBrowserSourceModule(
      await readFile(walletClientSource, "utf8"),
      walletClientSource,
    )).toEqual([]);
    expect(auditBrowserSourceModule(
      `export const requestCurrentPageClose = (): void => { window.close(); };`,
      resolve(webSourceRoot, "forged-lifecycle.ts"),
    )).not.toEqual([]);
    expect(auditBrowserSourceModule(
      `export const reloadOutsideBootstrapOwner = (): void => { window.location.reload(); };`,
      resolve(webSourceRoot, "forged-reload.ts"),
    )).not.toEqual([]);
    expect(auditBrowserSourceModule(
      `export const readStorageOutsideOwner = (): Storage => window.sessionStorage;`,
      resolve(webSourceRoot, "forged-storage.ts"),
    )).not.toEqual([]);
    expect(auditBrowserSourceModule(
      await readFile(webApplicationSource, "utf8"),
      webApplicationSource,
    )).toEqual([]);
    const webApplication = await readFile(webApplicationSource, "utf8");
    const shadowedObservationKey = webApplication.replace(
      "read: (): string | null => window.sessionStorage.getItem(walletObservationStorageKey),",
      "read: (): string | null => {\n" +
      "    const walletObservationStorageKey = \"outside\";\n" +
      "    return window.sessionStorage.getItem(walletObservationStorageKey);\n" +
      "  },",
    );
    expect(shadowedObservationKey).not.toBe(webApplication);
    expect(auditBrowserSourceModule(shadowedObservationKey, webApplicationSource)).not.toEqual([]);
    const shadowedObservationValue = webApplication.replace(
      "window.sessionStorage.setItem(walletObservationStorageKey, operationId);",
      "{ const operationId = \"outside\"; " +
      "window.sessionStorage.setItem(walletObservationStorageKey, operationId); }",
    );
    expect(shadowedObservationValue).not.toBe(webApplication);
    expect(auditBrowserSourceModule(shadowedObservationValue, webApplicationSource)).not.toEqual([]);
    const browserClient = await readFile(browserClientSource, "utf8");
    const substitutedFetchInputs = browserClient.replace(
      "const defaultBrowserFetch: BrowserFetch = (input, init) => globalThis.fetch(input, init);",
      "const input = \"https://example.invalid\";\n" +
      "const init = { method: \"GET\", credentials: \"same-origin\", cache: \"no-store\" } as const;\n" +
      "const defaultBrowserFetch: BrowserFetch = (_input, _init) => globalThis.fetch(input, init);",
    );
    expect(substitutedFetchInputs).not.toBe(browserClient);
    expect(auditBrowserSourceModule(substitutedFetchInputs, browserClientSource)).not.toEqual([]);
    for (const declaration of [
      "let defaultBrowserFetch: BrowserFetch = (input, init) => globalThis.fetch(input, init);",
      "{ const defaultBrowserFetch: BrowserFetch = (input, init) => globalThis.fetch(input, init); }",
      "const defaultBrowserFetch: BrowserFetch = " +
        "(input = \"https://example.invalid\", init) => globalThis.fetch(input, init);",
      "const defaultBrowserFetch: BrowserFetch = (input, init) => globalThis.fetch(input, init);\n" +
        "const duplicateBrowserFetch: BrowserFetch = (input, init) => globalThis.fetch(input, init);",
    ]) {
      const mutated = browserClient.replace(
        "const defaultBrowserFetch: BrowserFetch = (input, init) => globalThis.fetch(input, init);",
        declaration,
      );
      expect(mutated).not.toBe(browserClient);
      expect(auditBrowserSourceModule(mutated, browserClientSource), declaration).not.toEqual([]);
    }
    expect(auditBrowserSourceModule(
      "export {}; const Error = RTCPeerConnection; new Error();",
      resolve(webSourceRoot, "main.tsx"),
    )).not.toEqual([]);
    expect(auditBrowserSourceModule(
      "export {}; const AbortController = class {}; new AbortController();",
      resolve(webSourceRoot, "request-authority.ts"),
    )).not.toEqual([]);
    expect(auditBrowserSourceModule(
      "export {}; const status = 200; void status;",
      resolve(webSourceRoot, "local-binding.ts"),
    )).toEqual([]);
    expect(auditBrowserSourceModule(
      "export {}; void status;",
      resolve(webSourceRoot, "dom-global.ts"),
    )).not.toEqual([]);
    expect(auditBrowserSourceModule(
      `import { createElement as c } from "react"; c("meta", { httpEquiv: "refresh" });`,
      resolve(repositoryRoot, "src/core/browser.ts"),
    )).not.toEqual([]);
    const styleSource = resolve(webSourceRoot, "styles.css");
    expect(auditBrowserSourceModule(
      `.panel { background: url("https://example.invalid/image.png"); }`,
      styleSource,
    )).not.toEqual([]);
    expect(auditBrowserSourceModule(String.raw`.panel { background: u\72l(/outside); }`, styleSource))
      .not.toEqual([]);
    expect(auditBrowserSourceModule(String.raw`@\69mport "/outside.css";`, styleSource))
      .not.toEqual([]);
    expect(auditBrowserSourceModule(`.panel { background: u/**/rl(/outside); }`, styleSource))
      .not.toEqual([]);
    expect(auditBrowserSourceModule(await readFile(styleSource, "utf8"), styleSource)).toEqual([]);
  });

  it("bundles only browser-owned source, canonical contract leaves, and approved browser packages", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "littlejohn-browser-dependency-"));
    try {
      const outputs = parseBuildOutputs(await build({
        configFile: resolve(repositoryRoot, "vite.config.ts"),
        logLevel: "silent",
        mode: "production",
        build: {
          emptyOutDir: true,
          outDir: outputRoot,
          sourcemap: false,
          write: true,
        },
      }));

      const emitted = outputs.flatMap((output) => output.output);
      const chunks = emitted.filter((item): item is EmittedChunk => item.type === "chunk");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map((chunk) => chunk.code).join("\n")).toContain(productDisplayName);
      for (const match of chunks.flatMap((chunk) => [...chunk.code.matchAll(/\blittle\s+john\b/giu)])) {
        expect(match[0]).toBe(productDisplayName);
      }
      const emittedNames = new Set(emitted.map((item) => item.fileName));
      for (const reference of chunks.flatMap((chunk) => [...chunk.imports, ...chunk.dynamicImports])) {
        expect(reference).toMatch(hashedJavaScriptChunk);
        expect(emittedNames.has(reference)).toBe(true);
      }

      const moduleIds = chunks.flatMap((chunk) => Object.keys(chunk.modules)).sort();
      expect(moduleIds).toContain(browserContractSource);
      expect(moduleIds).toContain(browserClientSource);
      expect(moduleIds).toContain(walletClientSource);
      expect(moduleIds).toContain(tokenCatalogClientSource);
      expect(moduleIds).toContain(tokenCatalogPageSource);
      expect(moduleIds).toContain(webApplicationSource);
      expect(moduleIds).toContain(resolve(webSourceRoot, "wallet-dialog-view.ts"));
      expect(moduleIds).toContain(operationStateSource);
      expect(moduleIds).toContain(resolve(repositoryRoot, "src/wallet/operation-contract.ts"));
      expect(moduleIds).toContain(resolve(repositoryRoot, "src/core/wallet-connection.ts"));
      expect(moduleIds).toContain(chainErrorDefinitionsSource);
      expect(moduleIds).toContain(tokenCatalogBrowserSource);
      expect(moduleIds).toContain(tokenCatalogContractSchemaSource);
      expect(moduleIds).toContain(tokenCatalogErrorDefinitionsSource);
      const zodRoot = resolve(nodeModulesRoot, "zod");
      expect(moduleIds.some((moduleId) =>
        moduleId === zodRoot || moduleId.startsWith(`${zodRoot}${sep}`))).toBe(true);
      expect(moduleIds.flatMap((moduleId) => {
        const violation = browserModulePolicyViolation(moduleId);
        return violation === undefined ? [] : [violation];
      })).toEqual([]);

      await expect(loadBrowserAssetBundle(outputRoot)).resolves.toBeDefined();
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });
});
