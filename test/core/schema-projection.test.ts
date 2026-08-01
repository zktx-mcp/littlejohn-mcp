import { createHash } from "node:crypto";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z, type ZodType } from "zod";

import {
  CapabilityRegistry,
  canonicalSha256,
  capabilitySchemaProjectionSchema,
  defineReadCapability,
  getCapabilityDefinitionSnapshot,
  projectCapabilities,
  readCapabilityRegistry,
  safeParseCapabilityData,
  safeParseCapabilityInput,
} from "../../src/core/index.js";
import { createValidatedInputEvidenceFragment } from "../../src/core/capability-evidence.js";
import {
  createEvidenceReplayDefinition,
  createExactConclusionIdentityDeclaration,
} from "../../src/core/evidence-replay.js";

const independentCanonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${independentCanonicalJson(entry)}`).join(",")}}`;
  }
  throw new TypeError("Unsupported test canonical JSON value.");
};

const independentSha256 = (value: unknown): string =>
  createHash("sha256").update(independentCanonicalJson(value), "utf8").digest("hex");

const defineProjectionTestCapability = <Data extends { readonly value: string }>(
  dataSchema: ZodType<Data>,
) => {
  const conclusion = createExactConclusionIdentityDeclaration("projection_input_validated");
  const replay = createEvidenceReplayDefinition({
    capabilityId: "test.projection",
    conclusions: [conclusion],
    warningCodes: [],
  });
  const inputEvidence = createValidatedInputEvidenceFragment(replay);
  return defineReadCapability<{ value: string }, Data>({
    capabilityId: "test.projection",
    contractVersion: "1",
    inputSchema: z.object({ value: z.string() }).strict(),
    dataSchema,
    failureCodes: ["internal_error", "invalid_input", "result_too_large"],
    evidence: {
      definition: replay,
      observationTargets: () => [inputEvidence.target],
      declaration: (input, _data, binder) => {
        const target = binder.bind(inputEvidence.target);
        return {
          observationExpectations: [{
            slot: target.slot,
            claims: [{ role: target.roles.input, value: input as never }],
          }],
          observationReferences: [],
          factRequirements: [{
            fact: inputEvidence.fact,
            observationSlots: [target.slot],
            requiredObservationSlots: [target.slot],
            minimumObservationCount: 1,
            outcome: inputEvidence.outcome,
          }],
          expectedConclusions: [conclusion],
          conclusionDrafts: [{
            conclusion,
            outcomeFact: inputEvidence.fact,
            evidenceFacts: [inputEvidence.fact],
            freshnessRuleId: inputEvidence.freshnessRuleId,
          }],
          warningRequirements: [],
        };
      },
      staticScopeExclusions: [],
    },
    validateRequest: (input, data) => {
      if (input.value !== data.value) throw new TypeError("Test projection input mismatch.");
    },
  });
};

describe("generated capability projections", () => {
  const golden = {
    "account.balance": [
      "9bc55be852eea73f596c30b47c57e56ccbf63736a7693a85d1f5bf094f54670e",
      "2dcb72396d6c6c26a00f716040137cb53e5888d3a6a6224ff6126121a784f072",
      "3b7ce2e8225ab4a530c2b21755b6b937e85b53bfef563d4845748715ab5b7a24",
    ],
    "chain.status": [
      "e26cb5e8480ef708cd739ac63103c97908c1c9469d32ca96bfa7a51184490bcd",
      "6fb26fe20929c508a38ba2678e667715f7496d213047466779f9656f36908175",
      "42288c45ba463dfe7c4f272431edba4c90fd8dfc572a2856ad33297501358d9b",
    ],
    "contract.inspect": [
      "5839724d847eafb35975597756e5b2443d3745160d33128356bd763653669566",
      "04e1a03acba90917efd53a71e2b9a3fe22455868524029e110f437a0cbcb82bf",
      "e2e967639eeef57ec225e54b0cf45aff09f5c4a132815d43399b81d0a799a327",
    ],
    "transaction.inspect": [
      "c229b4dfb207cbec37d109faa9fbdb95084fd4f43a9dba7ea2c1c9c8b80936f7",
      "48723ff69ba8bcaac0e0023a5169ef59ad659d691f13e5afdfa6e09f4d796d2f",
      "d660614aa6d850bce76e00eb3de7be05f10993a3cf68296efad3d6120a09594f",
    ],
    "wallet.connection": [
      "3c5e10f6236f85d6270dcca3742df813ab1d9a9e7fc575f025dc5f0a96679d4e",
      "6b7cd0d32d5ce40896d42d48c6abae3b22fcc798d1d6513b5a95335bd7de6266",
      "38f141282ddf372d2ba62fe5bd30cb390280751bc89fb75aac27dd894e5c8c84",
    ],
  } as const;

  it("projects one unique schema identity and digest from each canonical definition", () => {
    const projections = projectCapabilities(readCapabilityRegistry);
    const ids = projections.flatMap((projection) => [
      projection.input.schemaId,
      projection.data.schemaId,
      projection.success.schemaId,
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const projection of projections) {
      const definition = readCapabilityRegistry.get(projection.capabilityId);
      expect(projection.input.schemaId).toBe(
        `urn:littlejohn:capability:${projection.capabilityId}:input:v${projection.contractVersion}`,
      );
      expect(projection.data.schemaId).toBe(
        `urn:littlejohn:capability:${projection.capabilityId}:data:v${projection.contractVersion}`,
      );
      expect(projection.success.schemaId).toBe(
        `urn:littlejohn:capability:${projection.capabilityId}:success:v${projection.contractVersion}`,
      );
      expect(projection.contractVersion).toBe(
        getCapabilityDefinitionSnapshot(definition).contractVersion,
      );
      expect(projection.maximumSuccessUtf8Bytes).toBe(8_388_607);
      expect(canonicalSha256(projection.input.schema)).toBe(projection.input.digest);
      expect(canonicalSha256(projection.data.schema)).toBe(projection.data.digest);
      expect(canonicalSha256(projection.success.schema)).toBe(projection.success.digest);
      expect(projection.failureCodes).toEqual(
        getCapabilityDefinitionSnapshot(definition).failureCodes,
      );
      expect(projection.failureCodes.filter((code) => code === "result_too_large")).toHaveLength(1);
      expect(Object.isFrozen(projection.failureCodes)).toBe(true);
    }
  });

  it("matches fixed schema digests that cannot be regenerated by the assertion", () => {
    const actual = Object.fromEntries(
      projectCapabilities(readCapabilityRegistry).map((projection) => [
        projection.capabilityId,
        [
        independentSha256(projection.input.schema),
        independentSha256(projection.data.schema),
        independentSha256(projection.success.schema),
        ],
      ]),
    );
    expect(actual).toEqual(golden);
    for (const projection of projectCapabilities(readCapabilityRegistry)) {
      const expected = golden[projection.capabilityId as keyof typeof golden];
      expect([projection.input.digest, projection.data.digest, projection.success.digest])
        .toEqual(expected);
    }
  });

  it("keeps unrelated projections stable when one explicit owner changes its schema", () => {
    const unchangedDefinition = readCapabilityRegistry.get("chain.status");
    const beforeDefinition = defineProjectionTestCapability(
      z.object({ value: z.string() }).strict(),
    );
    const afterDefinition = defineProjectionTestCapability(
      z.object({ value: z.string(), detail: z.string() }).strict(),
    );
    const before = Object.fromEntries(projectCapabilities(new CapabilityRegistry([
      unchangedDefinition,
      beforeDefinition,
    ])).map((projection) => [projection.capabilityId, projection]));
    const after = Object.fromEntries(projectCapabilities(new CapabilityRegistry([
      unchangedDefinition,
      afterDefinition,
    ])).map((projection) => [projection.capabilityId, projection]));
    const unchangedBefore = before["chain.status"];
    const unchangedAfter = after["chain.status"];
    const changedBefore = before["test.projection"];
    const changedAfter = after["test.projection"];
    expect(unchangedBefore).toBeDefined();
    expect(unchangedAfter).toEqual(unchangedBefore);
    expect(independentSha256(unchangedAfter)).toBe(independentSha256(unchangedBefore));
    expect(changedBefore).toBeDefined();
    expect(changedAfter).toBeDefined();
    expect(changedAfter?.capabilityId).toBe(changedBefore?.capabilityId);
    expect(changedAfter?.contractVersion).toBe(changedBefore?.contractVersion);
    expect(changedAfter?.input.schemaId).toBe(changedBefore?.input.schemaId);
    expect(changedAfter?.input.digest).toBe(changedBefore?.input.digest);
    expect(changedAfter?.data.schemaId).toBe(changedBefore?.data.schemaId);
    expect(changedAfter?.success.schemaId).toBe(changedBefore?.success.schemaId);
    expect(changedAfter?.data.digest).not.toBe(changedBefore?.data.digest);
    expect(changedAfter?.success.digest).not.toBe(changedBefore?.success.digest);
    expect(independentSha256(changedAfter)).not.toBe(independentSha256(changedBefore));
  });

  it("makes the aggregate success budget part of every canonical projection", () => {
    for (const projection of projectCapabilities(readCapabilityRegistry)) {
      expect(capabilitySchemaProjectionSchema.safeParse(projection).success).toBe(true);
      const { maximumSuccessUtf8Bytes: _omitted, ...missing } = projection;
      expect(capabilitySchemaProjectionSchema.safeParse(missing).success).toBe(false);
      expect(capabilitySchemaProjectionSchema.safeParse({
        ...projection,
        maximumSuccessUtf8Bytes: 8_388_608,
      }).success).toBe(false);
    }
  });

  it("emits JSON Schemas that independently reject unknown input fields", () => {
    const projection = projectCapabilities(readCapabilityRegistry)
      .find((candidate) => candidate.capabilityId === "contract.inspect");
    expect(projection).toBeDefined();
    const ajv = new Ajv2020({ strict: true });
    const validate = ajv.compile(projection?.input.schema as object);
    expect(validate({ address: `0x${"1".repeat(40)}`, block: { kind: "latest" } })).toBe(true);
    expect(validate({ address: `0x${"1".repeat(40)}`, block: { kind: "latest" }, extra: true })).toBe(false);
    expect(validate({
      address: "0x52908400098527886E0F7030069857D2E4169EE7",
      block: { kind: "latest" },
    })).toBe(true);
  });

  it("keeps Zod and JSON Schema aligned for the JavaScript prototype key", () => {
    const projections = projectCapabilities(readCapabilityRegistry);
    const ajv = new Ajv2020({ strict: true });
    const noInput = JSON.parse('{"__proto__":[]}') as unknown;
    const chain = readCapabilityRegistry.get("chain.status");
    const chainProjection = projections.find((candidate) => candidate.capabilityId === "chain.status");
    const validateChain = ajv.compile(chainProjection?.input.schema as object);
    expect(validateChain(noInput)).toBe(false);
    expect(safeParseCapabilityInput(chain, noInput).success).toBe(false);

    const nested = JSON.parse(`{
      "address":"0x${"1".repeat(40)}",
      "block":{"kind":"latest","__proto__":[]}
    }`) as unknown;
    const contract = readCapabilityRegistry.get("contract.inspect");
    const contractProjection = projections.find((candidate) => candidate.capabilityId === "contract.inspect");
    const validateContract = ajv.compile(contractProjection?.input.schema as object);
    expect(validateContract(nested)).toBe(false);
    expect(safeParseCapabilityInput(contract, nested).success).toBe(false);
  });

  it("preserves account input acceptance for cross-field and set constraints", () => {
    const projection = projectCapabilities(readCapabilityRegistry)
      .find((candidate) => candidate.capabilityId === "account.balance");
    expect(projection).toBeDefined();
    const validate = new Ajv2020({ strict: true }).compile(projection?.input.schema as object);
    const addressA = `0x${"1".repeat(40)}`;
    const addressB = `0x${"2".repeat(40)}`;
    const base = {
      account: { kind: "address", address: addressA },
      includeNative: false,
      block: { kind: "latest" },
    };
    for (const candidate of [
      { ...base, tokens: [addressA] },
      { ...base, tokens: [addressB, addressA] },
      { ...base, tokens: [addressA, addressA] },
      { ...base, tokens: [] },
    ]) {
      const zodAccepted = safeParseCapabilityInput(
        readCapabilityRegistry.get("account.balance"),
        candidate,
      ).success;
      expect(validate(candidate)).toBe(zodAccepted);
    }
  });

  it("projects wallet structure while the canonical definition retains intrinsic meaning", () => {
    const projection = projectCapabilities(readCapabilityRegistry)
      .find((candidate) => candidate.capabilityId === "wallet.connection");
    const validate = new Ajv2020({ strict: true }).compile(projection?.data.schema as object);
    const address = `0x${"1".repeat(40)}`;
    const connected = {
      status: "connected",
      address,
      chainId: "eip155:4663",
      approvedMethods: ["eth_sendTransaction"],
      approvedEvents: ["accountsChanged", "chainChanged"],
      expiresAt: "2026-07-13T10:16:02.000Z",
    };
    expect(validate(connected)).toBe(true);
    expect(safeParseCapabilityData(readCapabilityRegistry.get("wallet.connection"), connected).success).toBe(true);
    expect(validate({ ...connected, unexpected: true })).toBe(false);
    expect(validate({ ...connected, address: `0x${"A".repeat(40)}` })).toBe(false);
    const missingMethod = { ...connected, approvedMethods: [] };
    expect(validate(missingMethod)).toBe(true);
    expect(safeParseCapabilityData(readCapabilityRegistry.get("wallet.connection"), missingMethod).success).toBe(true);
    expect(validate({ status: "unresolved", sessionCount: "2" })).toBe(true);
    expect(validate({ status: "unresolved", sessionCount: "1" })).toBe(false);
    expect(validate({ status: "unresolved" })).toBe(false);
  });

  it("contains only the current schema identity", () => {
    for (const projection of projectCapabilities(readCapabilityRegistry)) {
      const versions = JSON.stringify(projection).match(/:v[0-9]+/gu) ?? [];
      expect(new Set(versions)).toEqual(new Set([`:v${projection.contractVersion}`]));
    }
  });
});
