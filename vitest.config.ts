import { defineConfig } from "vitest/config";

// These files own the same fixed product port, including deliberate foreign
// listeners. Release tools run first; fixed-port files run last.
const fixedPortTests = ["test/runtime/http-owner.test.ts", "test/interfaces/exchange-flow.test.ts"];
const releaseToolTests = ["test/release/**/*.test.ts"];
const common = { environment: "node", clearMocks: true, restoreMocks: true, fileParallelism: false } as const;
export default defineConfig({ test: {
  maxWorkers: 1,
  projects: [
  { test: { ...common, name: "release-tools", include: releaseToolTests, sequence: { groupOrder: 0 } } },
  { test: { ...common, name: "independent", include: ["test/**/*.test.{ts,tsx}"], exclude: [...fixedPortTests, ...releaseToolTests], sequence: { groupOrder: 1 } } },
  { test: { ...common, name: "fixed-port", include: fixedPortTests, sequence: { groupOrder: 2 } } },
] } });
