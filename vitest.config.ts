import { defineConfig } from "vitest/config";

// These files own the same fixed product port, including deliberate foreign
// listeners. They cannot run together. CI also runs one worker: the whole-source
// TypeScript audits and large SQLite fixtures otherwise compete with deadline-
// bounded checks. Local independent files keep normal parallelism.
const fixedPortTests = ["test/runtime/http-owner.test.ts", "test/interfaces/exchange-flow.test.ts"];
const common = { environment: "node", clearMocks: true, restoreMocks: true } as const;
export default defineConfig({ test: {
  ...(process.env["CI"] === "true" ? { maxWorkers: 1 } : {}),
  projects: [
  { test: { ...common, name: "independent", include: ["test/**/*.test.{ts,tsx}"], exclude: fixedPortTests, sequence: { groupOrder: 0 } } },
  { test: { ...common, name: "fixed-port", include: fixedPortTests, fileParallelism: false, sequence: { groupOrder: 1 } } },
] } });
