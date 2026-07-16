import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { browserBuildPolicyPlugin } from "./scripts/browser-build-policy.js";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(repositoryRoot, "src/interfaces/web"),
  base: "/",
  publicDir: false,
  plugins: [react(), browserBuildPolicyPlugin()],
  build: {
    outDir: resolve(repositoryRoot, "dist/web"),
    emptyOutDir: true,
    assetsDir: "assets",
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: {
      input: resolve(repositoryRoot, "src/interfaces/web/index.html"),
    },
  },
});
