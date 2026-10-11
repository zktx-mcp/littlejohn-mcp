import { defineConfig } from "vitest/config";

// Fixed-port cases remain exclusive. Every execution group has a nonzero
// order so Vitest does not move a single-worker order-zero group to the end.
const fixedPortTests = ["test/runtime/management.test.ts", "test/runtime/backend-lifecycle.test.ts", "test/runtime/http-owner.test.ts", "test/interfaces/exchange-flow.test.ts"];
const releaseToolTests = ["test/release/**/*.test.ts"];
// These checks read the source tree or use in-memory canonical fixtures.
// Keep their CPU work separate from process, storage and elapsed-time checks.
const parallelTests = [
  "test/core/address-target.test.ts",
  "test/core/amounts.test.ts",
  "test/core/architecture.test.ts",
  "test/core/capability-evidence.test.ts",
  "test/core/capability-schemas.test.ts",
  "test/core/capability-semantics.test.ts",
  "test/core/contract-analysis.test.ts",
  "test/core/erc20-events.test.ts",
  "test/core/errors.test.ts",
  "test/core/evidence-consumer-boundaries.test.ts",
  "test/core/evidence-record-digest-vectors.test.ts",
  "test/core/evidence-replay.test.ts",
  "test/core/evidence.test.ts",
  "test/core/keccak256.test.ts",
  "test/core/native-boundary.test.ts",
  "test/core/numeric-display.test.ts",
  "test/core/primitives.test.ts",
  "test/core/product-identity.test.ts",
  "test/core/schema-projection.test.ts",
  "test/core/shared-values.test.ts",
  "test/core/token-metadata.test.ts",
  "test/core/token-standards.test.ts",
  "test/core/transaction-request.test.ts",
  "test/runtime/architecture.test.ts",
  "test/protocols/architecture.test.ts",
];
const common = { environment: "node", clearMocks: true, restoreMocks: true, isolate: true, fileParallelism: false } as const;
export default defineConfig({ test: {
  maxWorkers: 1,
  projects: [
  { test: { ...common, name: "release-tools", include: releaseToolTests, sequence: { groupOrder: 1 } } },
  { test: { ...common, name: "parallel", include: parallelTests, maxWorkers: 2, fileParallelism: true, sequence: { groupOrder: 2 } } },
  { test: { ...common, name: "independent", include: ["test/**/*.test.{ts,tsx}"], exclude: [...parallelTests, ...fixedPortTests, ...releaseToolTests], sequence: { groupOrder: 3 } } },
  { test: { ...common, name: "fixed-port", include: fixedPortTests, sequence: { groupOrder: 4 } } },
] } });
