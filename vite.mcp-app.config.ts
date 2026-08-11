import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { mcpAppBuildPolicyPlugin } from "./scripts/mcp-app-build-policy.js";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  publicDir: false,
  plugins: [mcpAppBuildPolicyPlugin()],
  build: {
    outDir: resolve(repositoryRoot, "dist/mcp-app"),
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: resolve(repositoryRoot, "src/interfaces/mcp-app/view/main.ts"),
      output: {
        entryFileNames: "view.js",
        codeSplitting: false,
      },
    },
  },
});
