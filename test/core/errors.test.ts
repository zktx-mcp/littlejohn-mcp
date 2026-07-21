import { describe, expect, it } from "vitest";

import {
  applicationErrorDefinitionSchema,
  applicationFailureSchema,
  applicationFailureSchemaFor,
  assertDirectApplicationErrorRegistryExtension,
  coreErrorRegistry,
  createApplicationFailure,
} from "../../src/core/index.js";

describe("application error authority", () => {
  it("keeps registry definitions independent from a caller-mutated public schema", () => {
    const runtime = (applicationErrorDefinitionSchema as unknown as { _zod: { run: unknown } })._zod;
    const original = runtime.run;
    const invalid = {
      code: "NOT_CANONICAL",
      category: "internal",
      message: "Unsafe definition.",
      retryable: false,
    };
    try {
      runtime.run = () => ({ value: invalid, issues: [] });
      const poisoned = applicationErrorDefinitionSchema.parse(invalid);
      expect(() => coreErrorRegistry.extend([poisoned])).toThrow();
    } finally {
      runtime.run = original;
    }
  });

  it("keeps failures registry-owned when the public failure schema is mutated", () => {
    const runtime = (applicationFailureSchema as unknown as { _zod: { run: unknown } })._zod;
    const original = runtime.run;
    try {
      runtime.run = () => ({
        value: { ok: false, error: { code: "forged", message: "secret", issues: [] } },
        issues: [],
      });
      const failure = createApplicationFailure(coreErrorRegistry, "internal_error");
      expect(failure.error.code).toBe("internal_error");
      expect(failure.error.message).toBe("The request could not be completed.");
      expect(Object.isFrozen(failure.error.issues)).toBe(true);
    } finally {
      runtime.run = original;
    }
  });

  it("preserves core definitions and canonical registry order across extensions", () => {
    expect(coreErrorRegistry.values().map((definition) => definition.code)).toEqual([
      "internal_error",
      "invalid_input",
      "result_too_large",
    ]);
    expect(() => coreErrorRegistry.extend([{
      code: "internal_error",
      category: "internal",
      message: "Secret provider payload.",
      retryable: false,
    }])).toThrow("Duplicate");
    const extended = coreErrorRegistry.extend([{
      code: "source_unavailable",
      category: "source",
      message: "The configured source is unavailable.",
      retryable: true,
    }]);
    expect(extended.values().map((definition) => definition.code)).toEqual([
      "internal_error",
      "invalid_input",
      "result_too_large",
      "source_unavailable",
    ]);
    expect(() => assertDirectApplicationErrorRegistryExtension(coreErrorRegistry, extended)).not.toThrow();
    const sibling = coreErrorRegistry.extend([{
      code: "source_unavailable",
      category: "internal",
      message: "A conflicting branch definition.",
      retryable: false,
    }]);
    expect(() => assertDirectApplicationErrorRegistryExtension(extended, sibling)).toThrow("ancestry");
    expect(() => coreErrorRegistry.extend([])).toThrow("empty");
  });

  it("projects selected registry definitions as exact failure variants", () => {
    const schema = applicationFailureSchemaFor(coreErrorRegistry, ["internal_error"]);
    const failure = createApplicationFailure(coreErrorRegistry, "internal_error");
    expect(schema.parse(failure)).toEqual(failure);
    expect(schema.safeParse({
      ...failure,
      error: { ...failure.error, message: "Forged failure meaning." },
    }).success).toBe(false);
    expect(() => applicationFailureSchemaFor(coreErrorRegistry, [])).toThrow("codes");
    expect(() => applicationFailureSchemaFor(
      coreErrorRegistry,
      ["internal_error", "internal_error"],
    )).toThrow("codes");
    expect(() => applicationFailureSchemaFor(coreErrorRegistry, ["unknown_error"])).toThrow("Unknown");
  });
});
