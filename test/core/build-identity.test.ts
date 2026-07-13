import { describe, expect, it } from "vitest";

import {
  buildPathSchema,
  createRuntimeBuildIdentity,
  parseRuntimeBuildIdentity,
  runtimeBuildIdentitySchema,
} from "../../src/core/index.js";

describe("runtime build identity", () => {
  it("derives one canonical ordered identity from the file map", () => {
    const identity = createRuntimeBuildIdentity({
      "dist/z.js": "b".repeat(64),
      "dist/a.js": "a".repeat(64),
    });
    expect(Object.keys(identity.files)).toEqual(["dist/a.js", "dist/z.js"]);
    expect(runtimeBuildIdentitySchema.parse(identity)).toEqual(identity);
  });

  it("rejects a label whose digest is not bound to its file map", () => {
    const identity = createRuntimeBuildIdentity({ "dist/a.js": "a".repeat(64) });
    expect(runtimeBuildIdentitySchema.safeParse({ ...identity, digest: "b".repeat(64) }).success).toBe(false);
    expect(runtimeBuildIdentitySchema.safeParse({
      ...identity,
      files: { "dist/a.js": "b".repeat(64) },
    }).success).toBe(false);
  });

  it("keeps the authority parser independent from a caller-mutated public schema", () => {
    const runtime = (runtimeBuildIdentitySchema as unknown as { _zod: { run: unknown } })._zod;
    const original = runtime.run;
    const invalid = {
      algorithm: "sha256",
      digest: "b".repeat(64),
      files: { "dist/a.js": "a".repeat(64) },
    };
    try {
      runtime.run = () => ({ value: invalid, issues: [] });
      const poisoned = runtimeBuildIdentitySchema.parse(invalid);
      expect(() => parseRuntimeBuildIdentity(poisoned)).toThrow("digest");
    } finally {
      runtime.run = original;
    }
  });

  it("accepts only canonical relative package paths without traversal aliases", () => {
    for (const path of ["package.json", "dist/core/index.js", "LICENSES/dependency.txt", "10", "2"]) {
      expect(buildPathSchema.safeParse(path).success).toBe(true);
    }
    for (const path of ["", "/dist/a.js", "dist/", "dist//a.js", ".", "..", "dist/.", "dist/..", "dist/../a.js", "dist\\a.js"]) {
      expect(buildPathSchema.safeParse(path).success).toBe(false);
    }
  });

  it("canonicalizes numeric-looking map keys in digest bytes rather than object enumeration order", () => {
    const identity = createRuntimeBuildIdentity({
      "2": "b".repeat(64),
      "10": "a".repeat(64),
    });
    expect(parseRuntimeBuildIdentity(identity)).toEqual(identity);
  });
});
