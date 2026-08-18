import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CapabilityBindingRegistry,
  CapabilityRegistry,
  ObservationAuthorityRegistry,
  accountBalanceEvidence,
  accountBalanceCapability,
  accountTokenEvidenceIdentity,
  assertContractAnalysisForTarget,
  bindCapability,
  canonicalJsonStringify,
  chainAnchorSchema,
  chainStatusEvidence,
  chainStatusCapability,
  contractAnalysisSchema,
  contractInspectEvidence,
  contractInspectCapability,
  coreErrorRegistry,
  createCanonicalClock,
  createCapabilityInvocationAuthority,
  createContractAnalysisChainClaims,
  createContractAnalysisSourceClaim,
  createObservationAuthority,
  createObservationAuthorityIssuer,
  evmAddressSchema,
  evmChainIdSchema,
  getCapabilityDefinitionSnapshot,
  keccak256FromHex,
  observationIdSchema,
  parseCapabilitySuccess,
  productDisplayName,
  safeParseCapabilityInput,
  safeParseCapabilityData,
  sourceReferenceSchema,
  walletConnectionEvidence,
  walletConnectionCapability,
  type CanonicalJson,
  type ContractAnalysis,
  type ObservationClaim,
  type EvidenceSource,
  type ObservationAuthority,
  type ObservationWriter,
} from "../../src/core/index.js";
import {
  createValidatedInputEvidenceFragment,
} from "../../src/core/capability-evidence.js";
import {
  createEvidenceDeclarationScope,
  createEvidenceFactIdentityDeclaration,
  createEvidenceFactIdentityForConclusion,
  createEvidenceObservationTargetDeclaration,
  createEvidenceReplayDefinition,
  createEvmAddressConclusionIdentity,
  createEvmAddressConclusionIdentityDeclaration,
  createExactConclusionIdentityDeclaration,
} from "../../src/core/evidence-replay.js";
import { defineReadCapability } from "../../src/core/capability.js";
import { chainErrorRegistry } from "../../src/chain/errors.js";
import {
  bindForHarness,
  configuredChainId,
  createCapabilityHarness,
  fixedEvaluationTime,
  invokeBinding,
} from "./capability-harness.js";
import {
  changeUnavailableOwnerReason,
  createExactResolvedAnalysis,
  createTerminalityUnresolvedAnalysis,
  reversedDeclaredFunctions,
  validContractAnalysisClaimMutations,
} from "./contract-analysis-fixtures.js";

const execFileAsync = promisify(execFile);

const runInvocationRngChild = async (mode: "success" | "failure") => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", resolve("test/core/invocation-rng-child.ts"), mode],
    { cwd: resolve("."), encoding: "utf8" },
  );
  expect(stderr).toBe("");
  return JSON.parse(stdout) as {
    readonly randomByteCalls: number;
    readonly handlerCalls: number;
    readonly block: typeof block;
    readonly result: Awaited<ReturnType<typeof invokeBinding<typeof chainStatusCapability>>>;
  };
};

const block = chainAnchorSchema.parse({
  chainId: configuredChainId,
  blockNumber: "10",
  blockHash: `0x${"a".repeat(64)}`,
  blockTimestamp: fixedEvaluationTime,
});

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

const independentObservationId = (
  source: {
    readonly reference: { readonly sourceId: string };
    readonly purpose: string;
    readonly observedAt: string;
    readonly chainAnchor?: unknown;
    readonly invocationId: string;
  },
  ordinal: string,
): EvidenceSource["observationId"] => `obs:${createHash("sha256").update(independentCanonicalJson([
  source.reference.sourceId,
  source.purpose,
  source.observedAt,
  source.chainAnchor ?? null,
  source.invocationId,
  ordinal,
]), "utf8").digest("base64url")}` as EvidenceSource["observationId"];

const independentRecordDigest = (
  source: Omit<EvidenceSource, "recordDigest">,
  claims: readonly CanonicalJson[],
): EvidenceSource["recordDigest"] =>
  createHash("sha256").update(independentCanonicalJson({
    claims,
    digestKind: "evidence_source_record",
    source,
  }), "utf8").digest("base64url") as EvidenceSource["recordDigest"];

const canonicalSourceOrder = <Source extends { readonly observationId: string }>(
  sources: readonly Source[],
): readonly Source[] =>
  [...sources].sort((left, right) =>
    left.observationId < right.observationId ? -1 : left.observationId > right.observationId ? 1 : 0);

const recordRpc = (
  context: Parameters<Parameters<typeof bindForHarness>[2]>[1],
  observations: ObservationWriter,
  slot: Parameters<ObservationWriter["record"]>[0],
  claims: readonly ObservationClaim[],
) => observations.record(slot, {
  source: context.ports.observations.get("chain_rpc"),
  claims,
});

const successfulHandler = (
  context: Parameters<Parameters<typeof bindForHarness>[2]>[1],
  observations: ObservationWriter,
) => {
  const chain = observations.bind(chainStatusEvidence.configuredChain.target);
  const latest = observations.bind(chainStatusEvidence.targets.latestBlock);
  recordRpc(context, observations, chain.slot, [{
    role: chain.roles.chainId,
    value: configuredChainId,
  }]);
  recordRpc(context, observations, latest.slot, [{
    role: latest.roles.block,
    value: block,
    chainAnchor: block,
  }]);
  return {
    status: "success",
    data: { chainId: configuredChainId, latestBlock: block },
  };
};

const recordContractEvidence = (
  context: Parameters<Parameters<typeof bindForHarness>[2]>[1],
  observations: ObservationWriter,
  address: string,
  source: ObservationAuthority,
) => {
  const runtimeCode = "0x6000";
  const analysis = contractAnalysisSchema.parse({
    chainId: configuredChainId,
    target: address,
    block,
    targetRuntimeCode: {
      byteLength: "2",
      codeHash: keccak256FromHex(runtimeCode),
    },
    proxy: { status: "no_supported_proxy_observed" },
    sources: [{ role: "target", address, status: "no_record_observed" }],
    declaredFunctions: { status: "unavailable", reason: "exact_abi_unavailable" },
    controls: {
      owner: { status: "unavailable", reason: "exact_abi_unavailable" },
      paused: { status: "unavailable", reason: "exact_abi_unavailable" },
      defaultAdmins: { status: "unavailable", reason: "exact_abi_unavailable" },
    },
  });
  return recordContractAnalysisFixture(
    context,
    observations,
    analysis,
    runtimeCode,
    () => source,
  );
};

const recordContractAnalysisFixture = (
  context: Parameters<Parameters<typeof bindForHarness>[2]>[1],
  observations: ObservationWriter,
  analysis: ContractAnalysis,
  runtimeCode: string,
  sourceFor: (address: string) => ObservationAuthority,
) => {
  const chain = observations.bind(contractInspectEvidence.configuredChain.target);
  const account = observations.bind(contractInspectEvidence.targets.block);
  const deployment = observations.bind(contractInspectEvidence.analysis.targets.deployment);
  const controls = observations.bind(contractInspectEvidence.analysis.targets.controls);
  const targetSource = observations.bind(contractInspectEvidence.analysis.targets.targetSource);
  const implementationSource = observations.bind(
    contractInspectEvidence.analysis.targets.implementationSource,
  );
  const chainClaims = createContractAnalysisChainClaims(analysis);
  recordRpc(context, observations, chain.slot, [{
    role: chain.roles.chainId,
    value: configuredChainId,
  }]);
  recordRpc(context, observations, account.slot, [{
    role: account.roles.block,
    value: { address: analysis.target, block: analysis.block },
    chainAnchor: block,
  }]);
  recordRpc(context, observations, deployment.slot, [{
    role: deployment.roles.value,
    value: chainClaims.deployment,
    chainAnchor: block,
  }]);
  if (chainClaims.controlResults !== undefined) {
    recordRpc(context, observations, controls.slot, [{
      role: controls.roles.value,
      value: chainClaims.controlResults,
      chainAnchor: block,
    }]);
  }
  for (const source of analysis.sources) {
    const target = source.role === "target" ? targetSource : implementationSource;
    observations.record(target.slot, {
      source: sourceFor(source.address),
      claims: [{
        role: target.roles.value,
        value: createContractAnalysisSourceClaim(analysis, source.role),
        chainAnchor: block,
      }],
    });
  }
  return { analysis, runtimeCode };
};

describe("capability binding authority", () => {
  it("keeps single-reference authorities fixed and admits registered same-owner references", () => {
    const clock = createCanonicalClock(() => fixedEvaluationTime);
    const firstRpc = createObservationAuthority({
      clock,
      sourceClass: "chain_rpc",
      owner: "user_configured",
      reference: sourceReferenceSchema.parse({
        kind: "public",
        sourceId: "rpc-test",
        uri: "https://rpc-one.example/",
      }),
    });
    const secondRpc = createObservationAuthority({
      clock,
      sourceClass: "chain_rpc",
      owner: "user_configured",
      reference: sourceReferenceSchema.parse({
        kind: "public",
        sourceId: "rpc-test",
        uri: "https://rpc-two.example/",
      }),
    });
    expect(() => new ObservationAuthorityRegistry(clock, [firstRpc, secondRpc]))
      .toThrow("Duplicate observation source class");

    const configured = createObservationAuthorityIssuer({
      clock,
      sourceClass: "contract_verification_service",
      owner: "Sourcify",
      referenceKind: "public",
      sourceId: "sourcify-v2",
    });
    const foreign = createObservationAuthorityIssuer({
      clock,
      sourceClass: "contract_verification_service",
      owner: "Sourcify",
      referenceKind: "public",
      sourceId: "sourcify-v2",
    });
    const firstReference = sourceReferenceSchema.parse({
      kind: "public",
      sourceId: "sourcify-v2",
      uri: "https://sourcify.example/contract/one",
    });
    const secondReference = sourceReferenceSchema.parse({
      kind: "public",
      sourceId: "sourcify-v2",
      uri: "https://sourcify.example/contract/two",
    });
    const registry = new ObservationAuthorityRegistry(clock, [configured.registration]);
    expect(registry.owns(
      "contract_verification_service",
      configured.issue(firstReference),
    )).toBe(true);
    expect(registry.owns(
      "contract_verification_service",
      configured.issue(secondReference),
    )).toBe(true);
    expect(registry.owns(
      "contract_verification_service",
      foreign.issue(firstReference),
    )).toBe(false);
    const differentOwner = createObservationAuthorityIssuer({
      clock,
      sourceClass: "contract_verification_service",
      owner: "another_owner",
      referenceKind: "public",
      sourceId: "sourcify-v2",
    });
    expect(registry.owns(
      "contract_verification_service",
      differentOwner.issue(firstReference),
    )).toBe(false);
    expect(registry.owns(
      "contract_verification_service",
      {} as ObservationAuthority,
    )).toBe(false);
    const rpcConfigurationDigest = "A".repeat(43);
    expect(() => configured.issue(sourceReferenceSchema.parse({
      kind: "configured_rpc",
      sourceId: `rpc:${rpcConfigurationDigest}`,
      publicOrigin: "https://sourcify.example",
      configurationDigest: rpcConfigurationDigest,
    }))).toThrow("does not match its registration");
    expect(() => configured.issue(sourceReferenceSchema.parse({
      kind: "public",
      sourceId: "another-source",
      uri: "https://sourcify.example/contract/one",
    }))).toThrow("does not match its registration");
    expect(() => createObservationAuthorityIssuer({
      clock,
      sourceClass: "contract_verification_service",
      owner: "Sourcify",
      referenceKind: "configured_rpc",
      sourceId: "sourcify-v2",
    })).toThrow("reference kind is invalid");
    expect(() => createObservationAuthorityIssuer({
      clock,
      sourceClass: "contract_verification_service",
      owner: "Sourcify",
      referenceKind: "public",
      sourceId: "" as never,
    })).toThrow();
  });

  it("rejects every contract-analysis claim change while retaining the original evidence", async () => {
    const address = evmAddressSchema.parse(`0x${"7".repeat(40)}`);
    const input = { address, block: { kind: "latest" as const } };
    const createSuccess = async (analysis: ContractAnalysis) => {
      const harness = createCapabilityHarness();
      const binding = bindForHarness(
        contractInspectCapability,
        harness,
        async (_input, context, observations) => ({
          status: "success",
          data: recordContractAnalysisFixture(
            context,
            observations,
            analysis,
            "0x6000",
            (sourceAddress) => harness.contractVerificationSource(sourceAddress),
          ),
        }),
      );
      const result = await invokeBinding(contractInspectCapability, binding, input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("Contract analysis claim fixture did not succeed.");
      return result;
    };

    const originalAnalysis = createExactResolvedAnalysis(address, block);
    const original = await createSuccess(originalAnalysis);
    const target = {
      chainId: configuredChainId,
      address,
      block,
      runtimeCode: originalAnalysis.targetRuntimeCode,
    };
    for (const mutation of validContractAnalysisClaimMutations(originalAnalysis)) {
      expect(() => assertContractAnalysisForTarget(target, mutation.analysis), mutation.label)
        .not.toThrow();
      expect(() => parseCapabilitySuccess(contractInspectCapability, input, {
        ...original,
        data: { ...original.data, analysis: mutation.analysis },
      }), mutation.label).toThrow();
    }

    const reordered = reversedDeclaredFunctions(originalAnalysis);
    expect(() => parseCapabilitySuccess(contractInspectCapability, input, {
      ...original,
      data: { ...original.data, analysis: reordered },
    }), "declared-function order").toThrow();

    const unavailableAnalysis = createExactResolvedAnalysis(address, block, {
      status: "unavailable",
      reason: "call_reverted",
    });
    const unavailable = await createSuccess(unavailableAnalysis);
    const changedReason = changeUnavailableOwnerReason(unavailableAnalysis);
    expect(() => assertContractAnalysisForTarget(target, changedReason)).not.toThrow();
    expect(() => parseCapabilitySuccess(contractInspectCapability, input, {
      ...unavailable,
      data: { ...unavailable.data, analysis: changedReason },
    }), "unavailable reason").toThrow();
  });

  it("keeps every contract-control conclusion explicit with branch-owned support", async () => {
    const address = evmAddressSchema.parse(`0x${"6".repeat(40)}`);
    const invokeAnalysis = async (analysis: ContractAnalysis) => {
      const harness = createCapabilityHarness();
      const binding = bindForHarness(
        contractInspectCapability,
        harness,
        async (_input, context, observations) => ({
          status: "success",
          data: recordContractAnalysisFixture(
            context,
            observations,
            analysis,
            "0x6000",
            (sourceAddress) => harness.contractVerificationSource(sourceAddress),
          ),
        }),
      );
      const result = await invokeBinding(
        contractInspectCapability,
        binding,
        { address, block: { kind: "latest" } },
      );
      if (!result.ok) throw new TypeError("Contract analysis evidence fixture failed.");
      return result;
    };
    const directBase = {
      chainId: configuredChainId,
      target: address,
      block,
      targetRuntimeCode: {
        byteLength: "2",
        codeHash: keccak256FromHex("0x6000"),
      },
    } as const;
    const exactAbsent = contractAnalysisSchema.parse({
      ...directBase,
      proxy: { status: "no_supported_proxy_observed" },
      sources: [{ role: "target", address, status: "exact_match" }],
      declaredFunctions: { status: "observed", signatures: [] },
      controls: {
        owner: { status: "not_declared" },
        paused: { status: "not_declared" },
        defaultAdmins: { status: "not_declared" },
      },
    });
    const unavailableSource = contractAnalysisSchema.parse({
      ...directBase,
      proxy: { status: "no_supported_proxy_observed" },
      sources: [{ role: "target", address, status: "no_record_observed" }],
      declaredFunctions: { status: "unavailable", reason: "exact_abi_unavailable" },
      controls: {
        owner: { status: "unavailable", reason: "exact_abi_unavailable" },
        paused: { status: "unavailable", reason: "exact_abi_unavailable" },
        defaultAdmins: { status: "unavailable", reason: "exact_abi_unavailable" },
      },
    });
    const unresolved = createTerminalityUnresolvedAnalysis(address, block);
    for (const [analysis, expected] of [
      [createExactResolvedAnalysis(address, block), {
        status: "established",
        reason: "observed",
        supportPurpose: "contract_controls",
        freshnessRuleId: "chain_anchor_exact",
        coverage: "complete",
        hasControlObservation: true,
      }],
      [exactAbsent, {
        status: "not_applicable",
        reason: "not_present",
        supportPurpose: "contract_source_target",
        freshnessRuleId: "contract_source_at_chain_anchor",
        coverage: "complete",
        hasControlObservation: false,
      }],
      [unavailableSource, {
        status: "unavailable",
        reason: "not_observed",
        supportPurpose: "contract_source_target",
        freshnessRuleId: "contract_source_at_chain_anchor",
        coverage: "partial",
        hasControlObservation: false,
      }],
      [unresolved, {
        status: "unavailable",
        reason: "not_observed",
        supportPurpose: "contract_deployment",
        freshnessRuleId: "chain_anchor_exact",
        coverage: "partial",
        hasControlObservation: false,
      }],
    ] as const) {
      const result = await invokeAnalysis(analysis);
      const controls = result.evidence.conclusions.find(
        ({ id }) => id === "contract_controls_observed",
      );
      const support = result.evidence.sources.find(
        ({ purpose }) => purpose === expected.supportPurpose,
      );
      expect(support).toBeDefined();
      expect(controls).toMatchObject({
        status: expected.status,
        reason: expected.reason,
        observationIds: support === undefined ? [] : [support.observationId],
        freshness: { ruleId: expected.freshnessRuleId },
      });
      expect(result.evidence.coverage.status).toBe(expected.coverage);
      expect(result.evidence.sources.some(({ purpose }) => purpose === "contract_controls"))
        .toBe(expected.hasControlObservation);
    }
  });

  it("derives canonical conclusions, coverage, and deterministic observation identity", async () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) =>
      successfulHandler(context, observations));
    const result = await invokeBinding(chainStatusCapability, binding, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.coverage.status).toBe("complete");
    expect(result.meta.chainId).toBe(configuredChainId);
    expect(result.evidence.conclusions.map((item) => item.id)).toEqual([
      "latest_block_observed",
      "rpc_chain_id_matches_scope",
    ]);
    const chainIdSource = result.evidence.sources.find((item) => item.purpose === "chain_id");
    const latestBlockSource = result.evidence.sources.find((item) => item.purpose === "latest_block");
    expect(chainIdSource).toBeDefined();
    expect(latestBlockSource).toBeDefined();
    if (chainIdSource === undefined || latestBlockSource === undefined) {
      throw new Error("Expected chain evidence sources.");
    }
    expect(result.evidence.sources.every((source) =>
      /^[A-Za-z0-9_-]{43}$/u.test(source.recordDigest))).toBe(true);
    const expected = `obs:${createHash("sha256").update(canonicalJsonStringify([
      "rpc_test",
      "chain_id",
      fixedEvaluationTime,
      null,
      chainIdSource?.invocationId ?? "",
      "0",
    ])).digest("base64url")}`;
    expect(chainIdSource?.observationId).toBe(expected);
    const { recordDigest: _chainIdDigest, ...chainIdRecord } = chainIdSource;
    const { recordDigest: _latestBlockDigest, ...latestBlockRecord } = latestBlockSource;
    expect(independentRecordDigest(chainIdRecord, [{
      role: "chain_id",
      value: configuredChainId,
    }])).toBe(chainIdSource.recordDigest);
    expect(chainIdSource?.recordDigest)
      .toBe(independentRecordDigest(chainIdRecord, [{
        role: "chain_id",
        value: configuredChainId,
      }]));
    expect(latestBlockSource?.recordDigest).toBe(independentRecordDigest(latestBlockRecord, [{
      chainAnchor: block,
      role: "latest_block",
      value: block,
    } as unknown as CanonicalJson]));
    expect(result.evidence.sources.every((source) => source.invocationId === chainIdSource?.invocationId)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("binds a public source record through one generic production and replay path", async () => {
    const conclusion = createExactConclusionIdentityDeclaration("record_observed");
    const replay = createEvidenceReplayDefinition({
      capabilityId: "test.public_record_digest",
      conclusions: [conclusion],
      warningCodes: [],
    });
    const fact = createEvidenceFactIdentityDeclaration(replay, "claims");
    const valueTarget = createEvidenceObservationTargetDeclaration(replay, {
      slotId: "claims",
      fact,
      kind: "source",
      purpose: "claims",
      sourceClass: "chain_rpc",
      roles: {
        balance: "token_balance",
        metadata: "token_metadata",
      },
    });
    const dataSchema = z.object({
      balance: z.object({
        raw: z.string(),
        source: z.object({ kind: z.literal("rpc"), valid: z.literal(true) }).strict(),
      }).strict(),
      metadata: z.object({
        name: z.string(),
        tags: z.array(z.string()),
      }).strict(),
    }).strict();
    const digestBlock = chainAnchorSchema.parse({
      chainId: configuredChainId,
      blockNumber: "42",
      blockHash: `0x${"a".repeat(64)}`,
      blockTimestamp: "2026-07-26T00:00:00.000Z",
    });
    const digestAsset = {
      kind: "erc20" as const,
      chainId: configuredChainId,
      address: evmAddressSchema.parse(`0x${"1".repeat(40)}`),
    };
    const data = dataSchema.parse({
      balance: { raw: "123456789", source: { kind: "rpc", valid: true } },
      metadata: { name: "Example", tags: ["stock", "verified"] },
    });
    const definition = defineReadCapability<{}, z.infer<typeof dataSchema>>({
      capabilityId: "test.public_record_digest",
      contractVersion: "1",
      inputSchema: z.object({}).strict(),
      dataSchema,
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      evidence: {
        definition: replay,
        observationTargets: () => [valueTarget],
        declaration: (_input, data, binder) => {
          const value = binder.bind(valueTarget);
          return {
            observationExpectations: [{
              slot: value.slot,
              claims: [
                {
                  role: value.roles.balance,
                  value: data.balance,
                  asset: digestAsset,
                  chainAnchor: digestBlock,
                },
                {
                  role: value.roles.metadata,
                  value: data.metadata,
                },
              ],
            }],
            observationReferences: [],
            factRequirements: [{
              fact,
              observationSlots: [value.slot],
              requiredObservationSlots: [value.slot],
              minimumObservationCount: 1,
              outcome: "observed",
            }],
            conclusionDrafts: [{
              conclusion,
              outcomeFact: fact,
              evidenceFacts: [fact],
              freshnessRuleId: "chain_anchor_exact",
            }],
            warningRequirements: [],
          };
        },
        staticScopeExclusions: [],
      },
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async (_input, context, observations) => {
      const value = observations.bind(valueTarget);
      recordRpc(context, observations, value.slot, [
        {
          role: value.roles.metadata,
          value: data.metadata,
        },
        {
          role: value.roles.balance,
          value: data.balance,
          asset: digestAsset,
          chainAnchor: digestBlock,
        },
      ]);
      return { status: "success", data };
    });
    const result = await invokeBinding(definition, binding, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.sources.every((source) =>
      /^[A-Za-z0-9_-]{43}$/u.test(source.recordDigest))).toBe(true);
    expect(result.evidence.sources).toHaveLength(1);
    const source = result.evidence.sources[0];
    if (source === undefined) throw new Error("Expected one evidence source.");
    const { recordDigest: _recordDigest, ...sourceRecord } = source;
    expect(source.recordDigest).toBe(independentRecordDigest(sourceRecord, [
      {
        asset: digestAsset,
        chainAnchor: digestBlock,
        role: "token_balance",
        value: data.balance,
      },
      {
        role: "token_metadata",
        value: data.metadata,
      },
    ] as unknown as CanonicalJson[]));
    expect(() => parseCapabilitySuccess(definition, {}, result)).not.toThrow();
    expect(() => parseCapabilitySuccess(definition, {}, {
      ...result,
      data: {
        ...result.data,
        metadata: { ...result.data.metadata, name: "Changed" },
      },
    })).toThrow("record");
    expect(() => parseCapabilitySuccess(definition, {}, {
      ...result,
      evidence: {
        ...result.evidence,
        sources: [{
          ...source,
          owner: "changed_owner",
        }],
      },
    })).toThrow("record");
    if (source.reference.kind !== "public") {
      throw new Error("Expected the test RPC authority to use a public reference.");
    }
    expect(() => parseCapabilitySuccess(definition, {}, {
      ...result,
      evidence: {
        ...result.evidence,
        sources: [{
          ...source,
          reference: {
            ...source.reference,
            uri: "https://changed.example/",
          },
        }],
      },
    })).toThrow("record");
    expect(() => parseCapabilitySuccess(definition, {}, {
      ...result,
      evidence: {
        ...result.evidence,
        sources: result.evidence.sources.map((source) => ({
          ...source,
          recordDigest: "A".repeat(43) as EvidenceSource["recordDigest"],
        })),
      },
    })).toThrow("record");
  });

  it("separates concurrent invocations that observe the same millisecond", async () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) =>
      successfulHandler(context, observations));
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      invokeBinding(chainStatusCapability, binding, {})));
    expect(results.every((result) => result.ok)).toBe(true);
    const invocationIds = results.map((result) => result.ok ? result.evidence.sources[0]?.invocationId : undefined);
    const observationIds = results.flatMap((result) => result.ok
      ? result.evidence.sources.map((source) => source.observationId)
      : []);
    expect(invocationIds.every((value) => value?.startsWith("inv:") === true)).toBe(true);
    expect(new Set(invocationIds).size).toBe(invocationIds.length);
    expect(new Set(observationIds).size).toBe(observationIds.length);
  });

  it("uses one CSPRNG draw and binds anchored and unanchored ordinals independently", async () => {
    const child = await runInvocationRngChild("success");
    expect(child.randomByteCalls).toBe(1);
    expect(child.handlerCalls).toBe(1);
    expect(child.result.ok).toBe(true);
    if (!child.result.ok) return;
    const invocationId = `inv:${Buffer.alloc(32, 7).toString("base64url")}`;
    expect(child.result.evidence.sources.every((source) => source.invocationId === invocationId)).toBe(true);
    const chainId = child.result.evidence.sources.find((source) => source.purpose === "chain_id");
    const latestBlock = child.result.evidence.sources.find((source) => source.purpose === "latest_block");
    expect(chainId?.observationId).toBe(`obs:${createHash("sha256").update(canonicalJsonStringify([
      "rpc_test", "chain_id", fixedEvaluationTime, null, invocationId, "0",
    ])).digest("base64url")}`);
    expect(latestBlock?.observationId).toBe(`obs:${createHash("sha256").update(canonicalJsonStringify([
      "rpc_test", "latest_block", fixedEvaluationTime, child.block, invocationId, "1",
    ])).digest("base64url")}`);
  });

  it("fails closed before the handler when CSPRNG generation fails", async () => {
    const child = await runInvocationRngChild("failure");
    expect(child.randomByteCalls).toBe(1);
    expect(child.handlerCalls).toBe(0);
    expect(child.result.ok).toBe(false);
    if (child.result.ok) return;
    expect(child.result.error.code).toBe("internal_error");
    expect(JSON.stringify(child)).not.toContain("secret-rng-provider-detail");
  });

  it("rejects data that differs from definition-owned source claims", async () => {
    const otherBlock = chainAnchorSchema.parse({
      ...block,
      blockNumber: "11",
      blockHash: `0x${"b".repeat(64)}`,
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) => {
      const result = successfulHandler(context, observations);
      return { ...result, data: { ...result.data, latestBlock: otherBlock } };
    });
    const result = await invokeBinding(chainStatusCapability, binding, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("internal_error");
  });

  it("rejects internally consistent data from a different invocation chain", async () => {
    const otherChainId = evmChainIdSchema.parse("eip155:1");
    const otherBlock = chainAnchorSchema.parse({ ...block, chainId: otherChainId });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) => {
      const chain = observations.bind(chainStatusEvidence.configuredChain.target);
      const latest = observations.bind(chainStatusEvidence.targets.latestBlock);
      recordRpc(context, observations, chain.slot, [{
        role: chain.roles.chainId,
        value: otherChainId,
      }]);
      recordRpc(context, observations, latest.slot, [{
        role: latest.roles.block,
        value: otherBlock,
        chainAnchor: otherBlock,
      }]);
      return { status: "success", data: { chainId: otherChainId, latestBlock: otherBlock } };
    });
    const result = await invokeBinding(chainStatusCapability, binding, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("internal_error");
  });

  it("contains hostile handler wrappers without reading getters or disclosing values", async () => {
    const harness = createCapabilityHarness();
    const extra = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) => ({
      ...successfulHandler(context, observations),
      unexpected: "secret-provider-payload",
    }));
    const extraFailure = await invokeBinding(chainStatusCapability, extra, {});
    expect(extraFailure.ok).toBe(false);
    expect(JSON.stringify(extraFailure)).not.toContain("secret-provider-payload");

    let getterInvoked = false;
    const getterResult = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error("secret-provider-payload");
      },
    });
    const getter = bindForHarness(chainStatusCapability, harness, async () => getterResult);
    const getterFailure = await invokeBinding(chainStatusCapability, getter, {});
    expect(getterInvoked).toBe(false);
    expect(getterFailure.ok).toBe(false);

    const proxy = bindForHarness(chainStatusCapability, harness, async () => new Proxy({}, {
      ownKeys() {
        throw new Error("secret-provider-payload");
      },
    }));
    const proxyFailure = await invokeBinding(chainStatusCapability, proxy, {});
    expect(proxyFailure.ok).toBe(false);
    expect(JSON.stringify(proxyFailure)).not.toContain("secret-provider-payload");

    let nestedGetterInvoked = false;
    const hostileArray: unknown[] = [];
    Object.defineProperty(hostileArray, "0", {
      enumerable: true,
      get() {
        nestedGetterInvoked = true;
        return "secret-provider-payload";
      },
    });
    Object.defineProperty(hostileArray, "length", { value: 1 });
    const nested = bindForHarness(chainStatusCapability, harness, async () => ({
      status: "failure",
      code: "internal_error",
      issues: hostileArray,
    }));
    const nestedFailure = await invokeBinding(chainStatusCapability, nested, {});
    expect(nestedGetterInvoked).toBe(false);
    expect(nestedFailure.ok).toBe(false);

    let lengthRead = false;
    const proxiedIssues = new Proxy([], {
      get(target, key, receiver) {
        if (key === "length") lengthRead = true;
        return Reflect.get(target, key, receiver);
      },
    });
    const arrayProxy = bindForHarness(chainStatusCapability, harness, async () => ({
      status: "failure",
      code: "internal_error",
      issues: proxiedIssues,
    }));
    expect((await invokeBinding(chainStatusCapability, arrayProxy, {})).ok).toBe(false);
    expect(lengthRead).toBe(false);

    const prototypeData = bindForHarness(chainStatusCapability, harness, async () => JSON.parse(`{
      "status":"success",
      "data":{
        "chainId":"eip155:4663",
        "latestBlock":{
          "chainId":"eip155:4663",
          "blockNumber":"10",
          "blockHash":"0x${"a".repeat(64)}",
          "blockTimestamp":"${fixedEvaluationTime}"
        },
        "__proto__":[]
      }
    }`));
    expect((await invokeBinding(chainStatusCapability, prototypeData, {})).ok).toBe(false);
  });

  it("rejects forged observation tokens and a non-monotonic authority clock", async () => {
    const harness = createCapabilityHarness();
    const forged = bindForHarness(chainStatusCapability, harness, async (_input, _context, observations) => {
      observations.record("rpc_chain_id" as never, {} as never);
      return { status: "success", data: { chainId: configuredChainId, latestBlock: block } };
    });
    expect((await invokeBinding(chainStatusCapability, forged, {})).ok).toBe(false);

    const unregistered = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) => {
      const source = createObservationAuthority({
        clock: context.clock,
        sourceClass: "chain_rpc",
        owner: "forged_provider",
        reference: sourceReferenceSchema.parse({
          kind: "public",
          sourceId: "rpc_forged",
          uri: "https://forged.example/",
        }),
      });
      const chain = observations.bind(chainStatusEvidence.configuredChain.target);
      observations.record(chain.slot, {
        source,
        claims: [{ role: chain.roles.chainId, value: configuredChainId }],
      });
      return { status: "success", data: { chainId: configuredChainId, latestBlock: block } };
    });
    expect((await invokeBinding(chainStatusCapability, unregistered, {})).ok).toBe(false);

    let reads = 0;
    const nonMonotonic = createCapabilityHarness(() => {
      reads += 1;
      return reads <= 2 ? "2099-01-01T00:00:00.000Z" : fixedEvaluationTime;
    });
    const future = bindForHarness(chainStatusCapability, nonMonotonic, async (_input, context, observations) =>
      successfulHandler(context, observations));
    expect((await invokeBinding(chainStatusCapability, future, {})).ok).toBe(false);
  });

  it("normalizes invalid input and handler exceptions without rejected data", async () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async () => {
      throw new Error("secret-provider-payload");
    });
    const inputFailure = await invokeBinding(chainStatusCapability, binding, { unexpected: "private-address" });
    expect(inputFailure.ok).toBe(false);
    expect(JSON.stringify(inputFailure)).not.toContain("private-address");
    const handlerFailure = await invokeBinding(chainStatusCapability, binding, {});
    expect(handlerFailure.ok).toBe(false);
    expect(JSON.stringify(handlerFailure)).not.toContain("secret-provider-payload");
  });

  it("fixes definition slot order before input-dependent invocation ports perform work", async () => {
    const events: string[] = [];
    const inputConclusion = createExactConclusionIdentityDeclaration("input_validated");
    const inputReplay = createEvidenceReplayDefinition({
      capabilityId: "test.portlifecycle",
      conclusions: [inputConclusion],
      warningCodes: [],
    });
    const inputEvidence = createValidatedInputEvidenceFragment(inputReplay);
    const definition = defineReadCapability<{ values: string[] }, { values: string[] }>({
      capabilityId: "test.portlifecycle",
      contractVersion: "1",
      inputSchema: z.object({ values: z.array(z.string()).min(1) }).strict(),
      dataSchema: z.object({ values: z.array(z.string()).min(1) }).strict(),
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      normalizeInput: (input) => ({ values: [...input.values].sort() }),
      evidence: {
        definition: inputReplay,
        observationTargets: (input) => {
          events.push(`slots:${input.values.join(",")}`);
          return [inputEvidence.target];
        },
        declaration: (input, _data, binder) => {
          events.push(`declaration:${input.values.join(",")}`);
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
              outcome: "validated_input",
            }],
            conclusionDrafts: [{
              conclusion: inputConclusion,
              outcomeFact: inputEvidence.fact,
              evidenceFacts: [inputEvidence.fact],
              freshnessRuleId: "validated_input_current",
            }],
            warningRequirements: [],
          };
        },
        staticScopeExclusions: [],
      },
      validateRequest: (input, data) => {
        if (input.values.join("\0") !== data.values.join("\0")) throw new TypeError("Input mismatch.");
      },
    });
    const harness = createCapabilityHarness();
    const binding = bindCapability({
      definition,
      errorRegistry: chainErrorRegistry,
      invocationAuthority: harness.invocationAuthority,
      createInvocationPorts: (input) => {
        events.push(`ports:${input.values.join(",")}`);
        return harness.ports;
      },
      handler: async (input) => {
        events.push(`handler:${input.values.join(",")}`);
        return { status: "success", data: input };
      },
    });

    expect((await invokeBinding(definition, binding, { values: ["b", "a"] })).ok).toBe(true);
    expect(events).toEqual(["slots:a,b", "ports:a,b", "handler:a,b", "declaration:a,b"]);

    events.length = 0;
    expect((await invokeBinding(definition, binding, { values: [] })).ok).toBe(false);
    expect(events).toEqual([]);

    const duplicateConclusion =
      createExactConclusionIdentityDeclaration("value_observed");
    const duplicateReplay = createEvidenceReplayDefinition({
      capabilityId: "test.duplicateportlayout",
      conclusions: [duplicateConclusion],
      warningCodes: [],
    });
    const duplicateFact =
      createEvidenceFactIdentityDeclaration(duplicateReplay, "value");
    const duplicateTarget = createEvidenceObservationTargetDeclaration(
      duplicateReplay,
      {
        slotId: "value",
        fact: duplicateFact,
        kind: "source",
        purpose: "value",
        sourceClass: "chain_rpc",
        roles: { value: "value" },
      },
    );
    const duplicateDefinition = defineReadCapability<{}, { value: string }>({
      capabilityId: "test.duplicateportlayout",
      contractVersion: "1",
      inputSchema: z.object({}).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      evidence: {
        definition: duplicateReplay,
        observationTargets: () => [duplicateTarget, duplicateTarget],
        declaration: () => {
          throw new Error("The duplicate layout must fail before evidence replay.");
        },
        staticScopeExclusions: [],
      },
    });
    const duplicateBinding = bindCapability({
      definition: duplicateDefinition,
      errorRegistry: chainErrorRegistry,
      invocationAuthority: harness.invocationAuthority,
      createInvocationPorts: () => {
        events.push("duplicate:ports");
        return harness.ports;
      },
      handler: async () => {
        events.push("duplicate:handler");
        return { status: "success", data: { value: "safe" } };
      },
    });
    expect((await invokeBinding(duplicateDefinition, duplicateBinding, {})).ok).toBe(false);
    expect(events).toEqual([]);
  });

  it("does not accept handler-controlled issue messages or value-derived paths", async () => {
    const harness = createCapabilityHarness();
    const message = bindForHarness(chainStatusCapability, harness, async () => ({
      status: "failure",
      code: "invalid_input",
      issues: [{ path: "", code: "invalid_value", message: "secret-provider-payload" }],
    }));
    const messageFailure = await invokeBinding(chainStatusCapability, message, {});
    expect(messageFailure.ok).toBe(false);
    expect(JSON.stringify(messageFailure)).not.toContain("secret-provider-payload");

    const path = bindForHarness(chainStatusCapability, harness, async () => ({
      status: "failure",
      code: "invalid_input",
      issues: [{
        path: "/0x1111111111111111111111111111111111111111",
        code: "invalid_value",
        message: "The field value is invalid.",
      }],
    }));
    const pathFailure = await invokeBinding(chainStatusCapability, path, {});
    expect(pathFailure.ok).toBe(false);
    expect(JSON.stringify(pathFailure)).not.toContain("0x1111111111111111111111111111111111111111");

    const arrayProperty = bindForHarness(accountBalanceCapability, harness, async () => ({
      status: "failure",
      code: "invalid_input",
      issues: [{
        path: "/tokens/length",
        code: "invalid_value",
        message: "The field value is invalid.",
      }],
    }));
    const arrayPropertyFailure = await invokeBinding(accountBalanceCapability, arrayProperty, {
      account: { kind: "address", address: `0x${"1".repeat(40)}` },
      includeNative: false,
      tokens: [`0x${"2".repeat(40)}`],
      block: { kind: "latest" },
    });
    expect(arrayPropertyFailure.ok).toBe(false);
    if (!arrayPropertyFailure.ok) expect(arrayPropertyFailure.error.code).toBe("internal_error");
  });

  it("exposes only failures declared by the exact capability", async () => {
    const harness = createCapabilityHarness();
    const declared = bindForHarness(chainStatusCapability, harness, async () => ({
      status: "failure",
      code: "source_unavailable",
      issues: [],
    }));
    const undeclared = bindForHarness(chainStatusCapability, harness, async () => ({
      status: "failure",
      code: "not_found",
      issues: [],
    }));

    const declaredResult = await invokeBinding(chainStatusCapability, declared, {});
    const undeclaredResult = await invokeBinding(chainStatusCapability, undeclared, {});
    expect(declaredResult.ok).toBe(false);
    if (!declaredResult.ok) expect(declaredResult.error.code).toBe("source_unavailable");
    expect(undeclaredResult.ok).toBe(false);
    if (!undeclaredResult.ok) expect(undeclaredResult.error.code).toBe("internal_error");
  });

  it("admits raw handler issues only through the canonical array boundary", async () => {
    const harness = createCapabilityHarness();
    const issue = {
      path: "",
      code: "invalid_value",
      message: "The field value is invalid.",
    } as const;
    const invokeWithIssueCount = (count: number) => invokeBinding(
      chainStatusCapability,
      bindForHarness(chainStatusCapability, harness, async () => ({
        status: "failure",
        code: "invalid_input",
        issues: Array.from({ length: count }, () => issue),
      })),
      {},
    );

    const admitted = await invokeWithIssueCount(64);
    expect(admitted.ok).toBe(false);
    if (!admitted.ok) {
      expect(admitted.error.code).toBe("invalid_input");
      expect(admitted.error.issues).toEqual([issue]);
    }

    const oversized = await invokeWithIssueCount(65);
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error.code).toBe("internal_error");
      expect(oversized.error.issues).toEqual([]);
    }
  });

  it("bounds high-cardinality input issues without rejecting the invocation promise", async () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(accountBalanceCapability, harness, async () => {
      throw new Error("Handler must not run for invalid input.");
    });
    const result = await invokeBinding(accountBalanceCapability, binding, {
      account: { kind: "address", address: `0x${"1".repeat(40)}` },
      includeNative: false,
      tokens: Array.from({ length: 100 }, () => "not-an-address"),
      block: { kind: "latest" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.length).toBeLessThanOrEqual(64);
  });

  it("keeps raw schemas and callbacks private behind an opaque definition handle", () => {
    expect(Reflect.ownKeys(chainStatusCapability)).toEqual([]);
    const snapshot = getCapabilityDefinitionSnapshot(chainStatusCapability);
    expect(snapshot.capabilityId).toBe("chain.status");
    expect(snapshot.maximumSuccessUtf8Bytes).toBe(8_388_607);
    expect(snapshot.failureCodes).toEqual([
      "chain_response_unavailable",
      "internal_error",
      "invalid_input",
      "port_conflict",
      "rate_limited",
      "request_aborted",
      "result_too_large",
      "runtime_busy",
      "runtime_state_unavailable",
      "source_inconsistent",
      "source_unavailable",
    ]);
    expect(Object.isFrozen(snapshot.failureCodes)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.values(snapshot).some((value) => typeof value === "function")).toBe(false);
    expect(getCapabilityDefinitionSnapshot(accountBalanceCapability).conclusionIds).toEqual([
      "account_bound",
      "native_balance_observed",
      "token_balance:<address>",
    ]);
    expect(() => new CapabilityRegistry([{} as never])).toThrow("provenance");
  });

  it("keeps official private schemas independent from a caller-mutated public helper", () => {
    const runtime = (evmAddressSchema as unknown as { _zod: { run: unknown } })._zod;
    const original = runtime.run;
    try {
      runtime.run = () => ({ value: `0x${"1".repeat(40)}`, issues: [] });
      expect(safeParseCapabilityInput(contractInspectCapability, {
        address: "not-an-address",
        block: { kind: "latest" },
      }).success).toBe(false);
    } finally {
      runtime.run = original;
    }
  });

  it("captures one hostile input descriptor snapshot and rejects its unknown field", () => {
    let ownKeyReads = 0;
    const input = new Proxy({ unexpected: true }, {
      ownKeys() {
        ownKeyReads += 1;
        return ownKeyReads === 1 ? ["unexpected"] : [];
      },
      getOwnPropertyDescriptor(_target, key) {
        if (key === "unexpected") {
          return { configurable: true, enumerable: true, writable: true, value: true };
        }
        return undefined;
      },
    });
    expect(safeParseCapabilityInput(chainStatusCapability, input).success).toBe(false);
    expect(ownKeyReads).toBe(1);
  });

  it("freezes validated input before the handler receives it", async () => {
    const harness = createCapabilityHarness();
    let mutationRejected = false;
    const binding = bindForHarness(contractInspectCapability, harness, async (input, context, observations) => {
      try {
        (input as { address: string }).address = `0x${"9".repeat(40)}`;
      } catch {
        mutationRejected = true;
      }
      const data = recordContractEvidence(
        context,
        observations,
        input.address,
        harness.contractVerificationSource(input.address),
      );
      return {
        status: "success",
        data,
      };
    });
    const result = await invokeBinding(contractInspectCapability, binding, {
      address: `0x${"1".repeat(40)}`,
      block: { kind: "latest" },
    });
    expect(mutationRejected).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("binds one opaque binding to one exact registered definition", () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) =>
      successfulHandler(context, observations));
    expect(() => new CapabilityBindingRegistry(
      new CapabilityRegistry([contractInspectCapability]),
      [binding as never],
    )).toThrow("provenance");
    expect(() => new CapabilityBindingRegistry(
      new CapabilityRegistry([chainStatusCapability]),
      [{} as never],
    )).toThrow("provenance");
    expect(() => new CapabilityRegistry([{ ...chainStatusCapability } as never])).toThrow("provenance");
    expect(() => new CapabilityRegistry([new Proxy(chainStatusCapability, {}) as never])).toThrow("provenance");
    expect(() => new CapabilityBindingRegistry(
      new CapabilityRegistry([chainStatusCapability]),
      [{ ...binding } as never],
    )).toThrow("provenance");
    expect(() => new CapabilityBindingRegistry(
      new CapabilityRegistry([chainStatusCapability]),
      [new Proxy(binding, {}) as never],
    )).toThrow("provenance");
  });

  it("rejects an error registry without core registry lineage at the bind boundary", () => {
    const harness = createCapabilityHarness();
    const forgedRegistry = Object.create(Object.getPrototypeOf(coreErrorRegistry)) as typeof coreErrorRegistry;
    expect(() => bindCapability({
      definition: chainStatusCapability,
      errorRegistry: forgedRegistry,
      invocationAuthority: harness.invocationAuthority,
      createInvocationPorts: () => harness.ports,
      handler: async () => ({ status: "failure", code: "internal_error", issues: [] }),
    })).toThrow("provenance");
  });

  it("rejects a registry that does not cover the capability failure contract", () => {
    const harness = createCapabilityHarness();
    expect(() => bindCapability({
      definition: chainStatusCapability,
      errorRegistry: coreErrorRegistry,
      invocationAuthority: harness.invocationAuthority,
      createInvocationPorts: () => harness.ports,
      handler: async () => ({ status: "failure", code: "internal_error", issues: [] }),
    })).toThrow("does not cover");
  });

  it("creates and captures invocation ports exactly once after input validation", async () => {
    const base = createCapabilityHarness();
    let calls = 0;
    const binding = bindCapability({
      definition: chainStatusCapability,
      errorRegistry: chainErrorRegistry,
      invocationAuthority: base.invocationAuthority,
      createInvocationPorts: () => {
        calls += 1;
        return { observations: base.ports.observations };
      },
      handler: async (_input, context, observations) => successfulHandler(context, observations),
    });

    const invalid = await invokeBinding(chainStatusCapability, binding, { unexpected: true });
    expect(invalid.ok).toBe(false);
    expect(calls).toBe(0);
    expect((await invokeBinding(chainStatusCapability, binding, {})).ok).toBe(true);
    expect(calls).toBe(1);
    expect((await invokeBinding(chainStatusCapability, binding, {})).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("fails closed on hostile invocation-port factories without running the handler", async () => {
    const base = createCapabilityHarness();
    const wrongClock = createCapabilityHarness();
    let getterReads = 0;
    const accessorPorts = Object.defineProperty({}, "observations", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("secret accessor value");
      },
    });
    const factories: readonly (() => unknown)[] = [
      () => { throw new Error("secret factory value"); },
      () => new Proxy({}, {
        getPrototypeOf() { throw new Error("secret proxy value"); },
      }),
      () => accessorPorts,
      () => Promise.resolve(base.ports),
      () => Object.create({ observations: base.ports.observations }),
      () => wrongClock.ports,
    ];

    for (const createInvocationPorts of factories) {
      let handlerCalls = 0;
      const binding = bindCapability({
        definition: chainStatusCapability,
        errorRegistry: chainErrorRegistry,
        invocationAuthority: base.invocationAuthority,
        createInvocationPorts: createInvocationPorts as () => typeof base.ports,
        handler: async (_input, context, observations) => {
          handlerCalls += 1;
          return successfulHandler(context, observations);
        },
      });
      const result = await invokeBinding(chainStatusCapability, binding, {});
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected an internal failure.");
      expect(result.error.code).toBe("internal_error");
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(handlerCalls).toBe(0);
    }
    expect(getterReads).toBe(0);
  });

  it("keeps each invocation on the one captured authority snapshot", async () => {
    const clock = createCanonicalClock(() => fixedEvaluationTime);
    const invocationAuthority = createCapabilityInvocationAuthority(clock, configuredChainId);
    const registry = (label: string) => new ObservationAuthorityRegistry(clock, [
      createObservationAuthority({
        clock,
        sourceClass: "chain_rpc",
        owner: "user_configured",
        reference: sourceReferenceSchema.parse({
          kind: "public",
          sourceId: `rpc_${label}`,
          uri: `https://${label}.example/`,
        }),
      }),
    ]);
    const firstRegistry = registry("first");
    const secondRegistry = registry("second");
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const mutablePorts = { observations: firstRegistry };
    const binding = bindCapability({
      definition: chainStatusCapability,
      errorRegistry: chainErrorRegistry,
      invocationAuthority,
      createInvocationPorts: () => mutablePorts,
      handler: async (_input, context, observations) => {
        await gate;
        return successfulHandler(context, observations);
      },
    });

    const first = invokeBinding(chainStatusCapability, binding, {});
    mutablePorts.observations = secondRegistry;
    const second = invokeBinding(chainStatusCapability, binding, {});
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    if (!firstResult.ok || !secondResult.ok) return;
    expect(firstResult.evidence.sources.find(({ purpose }) => purpose === "chain_id")?.reference)
      .toMatchObject({ uri: "https://first.example/" });
    expect(secondResult.evidence.sources.find(({ purpose }) => purpose === "chain_id")?.reference)
      .toMatchObject({ uri: "https://second.example/" });
  });

  it("parses a strict transport success with definition-owned data invariants", async () => {
    const harness = createCapabilityHarness(() => "2026-07-12T10:16:02.000Z");
    const connected = {
      status: "connected" as const,
      address: "0x1111111111111111111111111111111111111111",
      chainId: "eip155:4663" as const,
      approvedMethods: ["eth_sendTransaction"],
      approvedEvents: ["accountsChanged", "chainChanged"],
      expiresAt: "2026-07-13T10:16:02.000Z",
    };
    const binding = bindForHarness(walletConnectionCapability, harness, async (_input, context, observations) => {
      const sdk = observations.bind(walletConnectionEvidence.targets.sdk);
      const session = observations.bind(walletConnectionEvidence.targets.session);
      observations.record(sdk.slot, {
        source: context.ports.observations.get("wallet_sdk"),
        claims: [{ role: sdk.roles.state, value: connected }],
      });
      observations.record(session.slot, {
        source: context.ports.observations.get("wallet_session"),
        claims: [{ role: session.roles.state, value: connected }],
      });
      return { status: "success", data: connected };
    });
    const result = await invokeBinding(walletConnectionCapability, binding, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.sources.every((source) =>
      /^[A-Za-z0-9_-]{43}$/u.test(source.recordDigest))).toBe(true);

    const parsed = parseCapabilitySuccess(walletConnectionCapability, {}, result);
    expect(parsed).toEqual(result);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.data)).toBe(true);

    expect(() => parseCapabilitySuccess(walletConnectionCapability, {}, {
      ...result,
      unexpected: true,
    })).toThrow();
    expect(() => parseCapabilitySuccess(walletConnectionCapability, {}, {
      ...result,
      meta: { ...result.meta, capabilityId: "chain.status" },
    })).toThrow();
    expect(() => parseCapabilitySuccess(walletConnectionCapability, {}, {
      ...result,
      data: { ...result.data, account: `eip155:4663:0x${"2".repeat(40)}` },
    })).toThrow();
    expect(() => parseCapabilitySuccess(walletConnectionCapability, {}, {
      ...result,
      meta: { ...result.meta, evaluatedAt: connected.expiresAt },
    })).toThrow();
    expect(() => parseCapabilitySuccess(walletConnectionCapability, {}, {
      ...result,
      data: { ...result.data, expiresAt: "2026-07-13T10:17:02.000Z" },
    })).toThrow("record");
    for (const source of result.evidence.sources) {
      expect(() => parseCapabilitySuccess(walletConnectionCapability, {}, {
        ...result,
        evidence: {
          ...result.evidence,
          sources: result.evidence.sources.map((candidate) => candidate === source
            ? { ...candidate, recordDigest: "A".repeat(43) as EvidenceSource["recordDigest"] }
            : candidate),
        },
      })).toThrow();
    }

    let getterReads = 0;
    const hostile = Object.defineProperty({}, "ok", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("secret transport value");
      },
    });
    expect(() => parseCapabilitySuccess(walletConnectionCapability, {}, hostile)).toThrow();
    expect(getterReads).toBe(0);
    expect(() => parseCapabilitySuccess(walletConnectionCapability, {}, new Proxy({}, {
      ownKeys(): never { throw new Error("secret transport proxy"); },
    }))).toThrow();
  });

  it("replays required source slots and canonical evidence from production definitions", async () => {
    const harness = createCapabilityHarness();
    const binding = bindForHarness(chainStatusCapability, harness, async (_input, context, observations) =>
      successfulHandler(context, observations));
    const result = await invokeBinding(chainStatusCapability, binding, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const chainIdSource = result.evidence.sources.find((source) => source.purpose === "chain_id");
    const blockSource = result.evidence.sources.find((source) => source.purpose === "latest_block");
    expect(chainIdSource).toBeDefined();
    expect(blockSource).toBeDefined();
    if (chainIdSource === undefined || blockSource === undefined) return;

    const sourceCounterexamples = [
      {
        label: "missing required source",
        sources: [blockSource],
      },
      {
        label: "duplicate source",
        sources: canonicalSourceOrder([...result.evidence.sources, chainIdSource]),
      },
      {
        label: "noncanonical source order",
        sources: [...result.evidence.sources].reverse(),
      },
      {
        label: "wrong purpose",
        sources: canonicalSourceOrder(result.evidence.sources.map((source) => {
          if (source !== chainIdSource) return source;
          const changed = { ...source, purpose: "wrong_purpose" };
          return { ...changed, observationId: independentObservationId(changed, "0") };
        })),
      },
      {
        label: "wrong source class",
        sources: result.evidence.sources.map((source) => source === chainIdSource
          ? { ...source, sourceClass: "official_document" as const }
          : source),
      },
      {
        label: "missing record digest",
        sources: result.evidence.sources.map((source) => {
          if (source !== chainIdSource) return source;
          const { recordDigest: _recordDigest, ...withoutRecordDigest } = source;
          return withoutRecordDigest as EvidenceSource;
        }),
      },
      {
        label: "malformed record digest",
        sources: result.evidence.sources.map((source) => source === chainIdSource
          ? { ...source, recordDigest: "not-a-digest" as EvidenceSource["recordDigest"] }
          : source),
      },
      {
        label: "different valid record digest",
        sources: result.evidence.sources.map((source) => source === chainIdSource
          ? { ...source, recordDigest: "A".repeat(43) as EvidenceSource["recordDigest"] }
          : source),
      },
      {
        label: "wrong chain anchor",
        sources: canonicalSourceOrder(result.evidence.sources.map((source) => {
          if (source !== blockSource) return source;
          const changed = {
            ...source,
            chainAnchor: chainAnchorSchema.parse({ ...block, blockHash: `0x${"b".repeat(64)}` }),
          };
          return { ...changed, observationId: independentObservationId(changed, "1") };
        })),
      },
      {
        label: "wrong invocation",
        sources: canonicalSourceOrder(result.evidence.sources.map((source) => {
          if (source !== chainIdSource) return source;
          const changed = {
            ...source,
            invocationId: `inv:${"A".repeat(43)}` as EvidenceSource["invocationId"],
          };
          return { ...changed, observationId: independentObservationId(changed, "0") };
        })),
      },
      {
        label: "wrong observation identifier",
        sources: result.evidence.sources.map((source) => source === chainIdSource
          ? { ...source, observationId: `obs:${"A".repeat(43)}` }
          : source),
      },
      {
        label: "conflicting authority identity",
        sources: result.evidence.sources.map((source) => source === chainIdSource
          ? { ...source, owner: "different_owner" }
          : source),
      },
      {
        label: "observation after evaluation",
        sources: canonicalSourceOrder(result.evidence.sources.map((source) => {
          if (source !== chainIdSource) return source;
          const changed = { ...source, observedAt: "2026-07-12T10:16:03.000Z" as const };
          return { ...changed, observationId: independentObservationId(changed, "0") };
        })),
      },
      {
        label: "additional undeclared source",
        sources: canonicalSourceOrder([...result.evidence.sources, (() => {
          const changed = {
            ...chainIdSource,
            purpose: "undeclared_source",
          };
          return { ...changed, observationId: independentObservationId(changed, "9") };
        })()]),
      },
    ] as const;
    for (const counterexample of sourceCounterexamples) {
      expect(
        () => parseCapabilitySuccess(chainStatusCapability, {}, {
          ...result,
          evidence: { ...result.evidence, sources: counterexample.sources },
        }),
        counterexample.label,
      ).toThrow();
    }
    for (const source of result.evidence.sources) {
      expect(() => parseCapabilitySuccess(chainStatusCapability, {}, {
        ...result,
        evidence: {
          ...result.evidence,
          sources: result.evidence.sources.map((candidate) => candidate === source
            ? { ...candidate, recordDigest: "A".repeat(43) as EvidenceSource["recordDigest"] }
            : candidate),
        },
      })).toThrow();
    }

    const conclusionCounterexamples = [
      {
        label: "missing conclusion",
        evidence: { ...result.evidence, conclusions: result.evidence.conclusions.slice(1) },
        warnings: result.warnings,
      },
      {
        label: "duplicate conclusion",
        evidence: {
          ...result.evidence,
          conclusions: [...result.evidence.conclusions, result.evidence.conclusions[0]],
        },
        warnings: result.warnings,
      },
      {
        label: "additional undeclared conclusion",
        evidence: {
          ...result.evidence,
          conclusions: [...result.evidence.conclusions, {
            ...result.evidence.conclusions[0],
            id: "undeclared_conclusion",
          }],
        },
        warnings: result.warnings,
      },
      {
        label: "noncanonical conclusion order",
        evidence: { ...result.evidence, conclusions: [...result.evidence.conclusions].reverse() },
        warnings: result.warnings,
      },
      {
        label: "dangling conclusion evidence",
        evidence: {
          ...result.evidence,
          conclusions: result.evidence.conclusions.map((conclusion, index) => index === 0
            ? {
                ...conclusion,
                observationIds: [`obs:${"A".repeat(43)}`],
                freshness: {
                  ...conclusion.freshness,
                  observationIds: [`obs:${"A".repeat(43)}`],
                },
              }
            : conclusion),
        },
        warnings: result.warnings,
      },
      {
        label: "coverage omits a conclusion",
        evidence: {
          ...result.evidence,
          coverage: {
            ...result.evidence.coverage,
            established: result.evidence.coverage.established.slice(1),
          },
        },
        warnings: result.warnings,
      },
      {
        label: "undeclared warning",
        evidence: result.evidence,
        warnings: [{
          code: "partial_result",
          message: "Some requested results are unavailable.",
          observationIds: [chainIdSource.observationId],
        }],
      },
    ] as const;
    for (const counterexample of conclusionCounterexamples) {
      expect(
        () => parseCapabilitySuccess(chainStatusCapability, {}, {
          ...result,
          evidence: counterexample.evidence,
          warnings: counterexample.warnings,
        }),
        counterexample.label,
      ).toThrow();
    }

    const address = `0x${"3".repeat(40)}`;
    const contractHarness = createCapabilityHarness();
    const contractBinding = bindForHarness(
      contractInspectCapability,
      contractHarness,
      async (_input, context, observations) => {
        const data = recordContractEvidence(
          context,
          observations,
          address,
          contractHarness.contractVerificationSource(address),
        );
        return {
          status: "success",
          data,
        };
      },
    );
    const contractResult = await invokeBinding(
      contractInspectCapability,
      contractBinding,
      { address, block: { kind: "latest" } },
    );
    expect(contractResult.ok).toBe(true);
    if (!contractResult.ok) return;
    const unreferencedRequiredSource = contractResult.evidence.sources.find(
      (source) => source.purpose === "chain_id",
    );
    expect(unreferencedRequiredSource).toBeDefined();
    expect(() => parseCapabilitySuccess(
      contractInspectCapability,
      { address, block: { kind: "latest" } },
      {
        ...contractResult,
        evidence: {
          ...contractResult.evidence,
          sources: contractResult.evidence.sources.filter(
            (source) => source !== unreferencedRequiredSource,
          ),
        },
      },
    )).toThrow();
  });

  it("preserves valid optional evidence and rejects a definition-owned warning omission", async () => {
    const disconnected = { status: "disconnected" as const, reason: "no_session" as const };
    const walletHarness = createCapabilityHarness();
    const walletBinding = bindForHarness(
      walletConnectionCapability,
      walletHarness,
      async (_input, context, observations) => {
        const sdk = observations.bind(walletConnectionEvidence.targets.sdk);
        observations.record(sdk.slot, {
          source: context.ports.observations.get("wallet_sdk"),
          claims: [{ role: sdk.roles.state, value: disconnected }],
        });
        return { status: "success", data: disconnected };
      },
    );
    const walletResult = await invokeBinding(walletConnectionCapability, walletBinding, {});
    expect(walletResult.ok).toBe(true);
    if (!walletResult.ok) return;
    expect(walletResult.evidence.sources.map((source) => source.purpose)).toEqual(["wallet_sdk_sessions"]);
    expect(() => parseCapabilitySuccess(walletConnectionCapability, {}, walletResult)).not.toThrow();

    const account = `0x${"4".repeat(40)}`;
    const unavailableToken = evmAddressSchema.parse(`0x${"5".repeat(40)}`);
    const accountInput = {
      account: { kind: "address" as const, address: account },
      includeNative: true as const,
      tokens: [unavailableToken],
      block: { kind: "latest" as const },
    };
    const accountHarness = createCapabilityHarness();
    const accountBinding = bindForHarness(
      accountBalanceCapability,
      accountHarness,
      async (input, context, observations) => {
        const chain = observations.bind(accountBalanceEvidence.configuredChain.target);
        const blockTarget = observations.bind(accountBalanceEvidence.targets.block);
        const native = observations.bind(accountBalanceEvidence.targets.nativeBalance);
        const identity = accountTokenEvidenceIdentity(input, unavailableToken);
        const tokenBalance = observations.bind(identity.balanceTarget);
        const tokenDecimals = observations.bind(identity.decimalsTarget);
        recordRpc(context, observations, chain.slot, [{
          role: chain.roles.chainId,
          value: configuredChainId,
        }]);
        recordRpc(context, observations, blockTarget.slot, [{
          role: blockTarget.roles.block,
          value: block,
          chainAnchor: block,
        }]);
        const asset = { kind: "native" as const, chainId: configuredChainId };
        const quantityObservationId = recordRpc(context, observations, native.slot, [{
          role: native.roles.balance,
          value: "1",
          asset,
          chainAnchor: block,
        }]);
        const tokenAsset = {
          kind: "erc20" as const,
          chainId: configuredChainId,
          address: unavailableToken,
        };
        const unavailable = { status: "unavailable" as const, errorCode: "source_unavailable" as const };
        recordRpc(context, observations, tokenBalance.slot, [{
          role: tokenBalance.roles.balance,
          value: unavailable,
          asset: tokenAsset,
          chainAnchor: block,
        }]);
        recordRpc(context, observations, tokenDecimals.slot, [{
          role: tokenDecimals.roles.decimals,
          value: unavailable,
          asset: tokenAsset,
          chainAnchor: block,
        }]);
        return {
          status: "success",
          data: {
            account,
            block,
            native: {
              status: "available" as const,
              amount: {
                asset,
                raw: "1",
                decimals: {
                  status: "not_observed" as const,
                  scopeExclusionId: "account_native_decimals_not_observed",
                },
                quantityObservationId,
              },
            },
            tokens: [{ asset: tokenAsset, result: unavailable }],
          },
        };
      },
    );
    const accountResult = await invokeBinding(accountBalanceCapability, accountBinding, accountInput);
    expect(accountResult.ok).toBe(true);
    if (!accountResult.ok) return;
    expect(accountResult.evidence.sources.every((source) =>
      /^[A-Za-z0-9_-]{43}$/u.test(source.recordDigest))).toBe(true);
    expect(accountResult.warnings.map((warning) => warning.code)).toEqual([
      "decimals_unavailable",
      "partial_result",
    ]);
    expect(() => parseCapabilitySuccess(accountBalanceCapability, accountInput, accountResult)).not.toThrow();
    const balanceBlockSource = accountResult.evidence.sources.find(
      (source) => source.purpose === "balance_block",
    );
    expect(balanceBlockSource).toBeDefined();
    const native = accountResult.data.native;
    if (balanceBlockSource === undefined || native.status !== "available") return;
    expect(() => parseCapabilitySuccess(accountBalanceCapability, accountInput, {
      ...accountResult,
      data: {
        ...accountResult.data,
        native: {
          status: "available",
          amount: {
            ...native.amount,
            quantityObservationId: balanceBlockSource.observationId,
          },
        },
      },
    })).toThrow();
    expect(() => parseCapabilitySuccess(accountBalanceCapability, accountInput, {
      ...accountResult,
      warnings: [],
    })).toThrow();
    expect(() => parseCapabilitySuccess(accountBalanceCapability, accountInput, {
      ...accountResult,
      warnings: accountResult.warnings.map((warning) => ({
        ...warning,
        observationIds: [`obs:${"A".repeat(43)}`],
      })),
    })).toThrow();
    expect(() => parseCapabilitySuccess(accountBalanceCapability, accountInput, {
      ...accountResult,
      warnings: [...accountResult.warnings].reverse(),
    })).toThrow();
    expect(() => parseCapabilitySuccess(accountBalanceCapability, accountInput, {
      ...accountResult,
      warnings: accountResult.warnings.map((warning, index) => index === 0
        ? { ...warning, message: "Forged warning text." }
        : warning),
    })).toThrow();
    expect(() => parseCapabilitySuccess(accountBalanceCapability, accountInput, {
      ...accountResult,
      warnings: accountResult.warnings.map((warning, index) => index === 0
        ? {
            ...warning,
            code: "unsupported_transaction_type" as const,
            message: "The transaction type is not interpreted.",
          }
        : warning),
    })).toThrow();
    expect(() => parseCapabilitySuccess(accountBalanceCapability, accountInput, {
      ...accountResult,
      data: {
        ...accountResult.data,
        native: {
          ...accountResult.data.native,
          amount: {
            ...native.amount,
            raw: "2",
          },
        },
      },
    })).toThrow("record");
    for (const source of accountResult.evidence.sources) {
      expect(() => parseCapabilitySuccess(accountBalanceCapability, accountInput, {
        ...accountResult,
        evidence: {
          ...accountResult.evidence,
          sources: accountResult.evidence.sources.map((candidate) => candidate === source
            ? { ...candidate, recordDigest: "A".repeat(43) as EvidenceSource["recordDigest"] }
            : candidate),
        },
      })).toThrow();
    }
  });

  it("binds a transport success to its chain scope, evidence anchors, and request", async () => {
    const chainHarness = createCapabilityHarness();
    const chainBinding = bindForHarness(chainStatusCapability, chainHarness, async (_input, context, observations) =>
      successfulHandler(context, observations));
    const chainResult = await invokeBinding(chainStatusCapability, chainBinding, {});
    expect(chainResult.ok).toBe(true);
    if (!chainResult.ok) return;

    const otherChainId = "eip155:1";
    expect(() => parseCapabilitySuccess(chainStatusCapability, {}, {
      ...chainResult,
      data: {
        chainId: otherChainId,
        latestBlock: { ...chainResult.data.latestBlock, chainId: otherChainId },
      },
    })).toThrow("scope");
    expect(() => parseCapabilitySuccess(chainStatusCapability, {}, {
      ...chainResult,
      evidence: {
        ...chainResult.evidence,
        sources: chainResult.evidence.sources.map((source) => source.chainAnchor === undefined
          ? source
          : { ...source, chainAnchor: { ...source.chainAnchor, chainId: otherChainId } }),
      },
    })).toThrow("Evidence chain scope");

    const address = `0x${"1".repeat(40)}`;
    const otherAddress = `0x${"2".repeat(40)}`;
    const contractHarness = createCapabilityHarness();
    const contractBinding = bindForHarness(contractInspectCapability, contractHarness,
      async (_input, context, observations) => {
        const data = recordContractEvidence(
          context,
          observations,
          address,
          contractHarness.contractVerificationSource(address),
        );
        return {
          status: "success",
          data,
        };
      });
    const contractResult = await invokeBinding(
      contractInspectCapability,
      contractBinding,
      { address, block: { kind: "latest" } },
    );
    expect(contractResult.ok).toBe(true);
    if (!contractResult.ok) return;
    expect(() => parseCapabilitySuccess(
      contractInspectCapability,
      { address: otherAddress, block: { kind: "latest" } },
      contractResult,
    )).toThrow("target");
  });

  it("rejects a capability target that differs from its validated request", async () => {
    const inputAddress = `0x${"1".repeat(40)}`;
    const outputAddress = `0x${"2".repeat(40)}`;
    const harness = createCapabilityHarness();
    const binding = bindForHarness(contractInspectCapability, harness, async (_input, context, observations) => {
      const data = recordContractEvidence(
        context,
        observations,
        outputAddress,
        harness.contractVerificationSource(outputAddress),
      );
      return {
        status: "success",
        data,
      };
    });
    const result = await invokeBinding(
      contractInspectCapability,
      binding,
      { address: inputAddress, block: { kind: "latest" } },
    );
    expect(result.ok).toBe(false);
  });

  it("makes validated-input fact support binder-owned", async () => {
    let dataMutationRejected = false;
    const conclusion = createExactConclusionIdentityDeclaration("input_validated");
    const replay = createEvidenceReplayDefinition({
      capabilityId: "test.validated",
      conclusions: [conclusion],
      warningCodes: [],
    });
    const inputEvidence = createValidatedInputEvidenceFragment(replay);
    const definition = defineReadCapability<{ value: string }, { value: string }>({
      capabilityId: "test.validated",
      contractVersion: "1",
      inputSchema: z.object({ value: z.string() }).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      evidence: {
        definition: replay,
        observationTargets: () => [inputEvidence.target],
        declaration: (input, data, binder) => {
          try {
            data.value = "mutated";
          } catch {
            dataMutationRejected = true;
          }
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
              outcome: "validated_input",
            }],
            conclusionDrafts: [{
              conclusion,
              outcomeFact: inputEvidence.fact,
              evidenceFacts: [inputEvidence.fact],
              freshnessRuleId: "validated_input_current",
            }],
            warningRequirements: [],
          };
        },
        staticScopeExclusions: [],
      },
      validateRequest: (input, data) => {
        if (input.value !== data.value) throw new TypeError("Input mismatch.");
      },
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async (input) => ({
      status: "success",
      data: input,
    }));
    const result = await invokeBinding(definition, binding, { value: "safe" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.value).toBe("safe");
      expect(result.evidence.sources.find((source) => source.sourceClass === "validated_input")?.owner)
        .toBe(`${productDisplayName} validated input`);
    }
    expect(dataMutationRejected).toBe(true);
  });

  it("binds dynamic conclusion identities to one typed address declaration", async () => {
    const address = evmAddressSchema.parse(`0x${"3".repeat(40)}`);
    const conclusionIdentity =
      createEvmAddressConclusionIdentityDeclaration("address_observed:");
    const replay = createEvidenceReplayDefinition({
      capabilityId: "test.dynamicconclusion",
      conclusions: [conclusionIdentity],
      warningCodes: [],
    });
    const scope = createEvidenceDeclarationScope(replay);
    const conclusion = createEvmAddressConclusionIdentity(conclusionIdentity, address);
    const fact = createEvidenceFactIdentityForConclusion(replay, conclusion, scope);
    const target = createEvidenceObservationTargetDeclaration(replay, {
      slotId: "address_input",
      fact,
      kind: "validated_input",
      owner: `${productDisplayName} validated input`,
      sourceId: "input:test.dynamicconclusion",
      purpose: "validated_input",
      roles: { input: conclusion },
    });
    let omitDraft = false;
    const definition = defineReadCapability<{ address: string }, { address: string }>({
      capabilityId: "test.dynamicconclusion",
      contractVersion: "1",
      inputSchema: z.object({ address: z.string().regex(/^0x[0-9a-f]{40}$/) }).strict(),
      dataSchema: z.object({ address: z.string().regex(/^0x[0-9a-f]{40}$/) }).strict(),
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      evidence: {
        definition: replay,
        observationTargets: (input) => {
          if (input.address !== address) throw new TypeError("Address scope mismatch.");
          return [target];
        },
        declaration: (input, _data, binder) => {
          if (input.address !== address) throw new TypeError("Address scope mismatch.");
          const boundTarget = binder.bind(target);
          return {
            observationExpectations: [{
              slot: boundTarget.slot,
              claims: [{ role: boundTarget.roles.input, value: input as never }],
            }],
            observationReferences: [],
            factRequirements: [{
              fact,
              observationSlots: [boundTarget.slot],
              requiredObservationSlots: [boundTarget.slot],
              minimumObservationCount: 1,
              outcome: "validated_input",
            }],
            conclusionDrafts: omitDraft
              ? []
              : [{
                  conclusion,
                  outcomeFact: fact,
                  evidenceFacts: [fact],
                  freshnessRuleId: "validated_input_current",
                }],
            warningRequirements: [],
          };
        },
        staticScopeExclusions: [],
      },
      validateRequest: (input, data) => {
        if (input.address !== data.address) throw new TypeError("Address mismatch.");
      },
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async (input) => ({ status: "success", data: input }));
    const result = await invokeBinding(definition, binding, { address });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.conclusions[0]?.id).toBe(`address_observed:${address}`);
    }
    omitDraft = true;
    const omitted = await invokeBinding(definition, binding, { address });
    expect(omitted).toMatchObject({ ok: false, error: { code: "internal_error" } });
  });

  it("rejects data meaning that references an exclusion absent from its descriptor", () => {
    const conclusion = createExactConclusionIdentityDeclaration("value_observed");
    const replay = createEvidenceReplayDefinition({
      capabilityId: "test.scopeexclusion",
      conclusions: [conclusion],
      warningCodes: [],
    });
    const inputEvidence = createValidatedInputEvidenceFragment(replay);
    const definition = defineReadCapability<{}, { value: string }>({
      capabilityId: "test.scopeexclusion",
      contractVersion: "1",
      inputSchema: z.object({}).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      evidence: {
        definition: replay,
        observationTargets: () => [inputEvidence.target],
        declaration: () => {
          throw new Error("Intrinsic validation must reject before replay.");
        },
        staticScopeExclusions: [],
      },
      validateIntrinsicData: (_data, context) => context.assertDeclaredScopeExclusion({
        id: "missing_exclusion" as never,
        message: "This exclusion is not declared.",
      }),
    });
    expect(safeParseCapabilityData(definition, { value: "safe" }).success).toBe(false);
  });

  it("requires every observation slot to be owned by its exact fact requirement", async () => {
    const conclusion = createExactConclusionIdentityDeclaration("value_observed");
    const replay = createEvidenceReplayDefinition({
      capabilityId: "test.slotownership",
      conclusions: [conclusion],
      warningCodes: [],
    });
    const fact = createEvidenceFactIdentityDeclaration(replay, "value");
    const usedTarget = createEvidenceObservationTargetDeclaration(replay, {
      slotId: "used",
      fact,
      kind: "source",
      purpose: "used",
      sourceClass: "chain_rpc",
      roles: { value: "used" },
    });
    const orphanTarget = createEvidenceObservationTargetDeclaration(replay, {
      slotId: "orphan",
      fact,
      kind: "source",
      purpose: "orphan",
      sourceClass: "chain_rpc",
      roles: { value: "orphan" },
    });
    const definition = defineReadCapability<{}, { value: string }>({
      capabilityId: "test.slotownership",
      contractVersion: "1",
      inputSchema: z.object({}).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      evidence: {
        definition: replay,
        observationTargets: () => [usedTarget, orphanTarget],
        declaration: (_input, _data, binder) => {
          const used = binder.bind(usedTarget);
          const orphan = binder.bind(orphanTarget);
          return {
            observationExpectations: [
              {
                slot: used.slot,
                claims: [{ role: used.roles.value, value: "safe", chainAnchor: block }],
              },
              {
                slot: orphan.slot,
                claims: [{ role: orphan.roles.value, value: "safe", chainAnchor: block }],
              },
            ],
            observationReferences: [],
            factRequirements: [{
              fact,
              observationSlots: [used.slot],
              requiredObservationSlots: [used.slot],
              minimumObservationCount: 1,
              outcome: "observed",
            }],
            conclusionDrafts: [{
              conclusion,
              outcomeFact: fact,
              evidenceFacts: [fact],
              freshnessRuleId: "chain_anchor_exact",
            }],
            warningRequirements: [],
          };
        },
        staticScopeExclusions: [],
      },
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async (_input, context, observations) => {
      const used = observations.bind(usedTarget);
      const orphan = observations.bind(orphanTarget);
      recordRpc(context, observations, used.slot, [{
        role: used.roles.value,
        value: "safe",
        chainAnchor: block,
      }]);
      recordRpc(context, observations, orphan.slot, [{
        role: orphan.roles.value,
        value: "safe",
        chainAnchor: block,
      }]);
      return { status: "success", data: { value: "safe" } };
    });
    expect((await invokeBinding(definition, binding, {})).ok).toBe(false);
  });

  it("rejects a forged public observation reference role before projection", async () => {
    const dataSchema = z.object({ observationId: observationIdSchema }).strict();
    const conclusion = createExactConclusionIdentityDeclaration("value_observed");
    const replay = createEvidenceReplayDefinition({
      capabilityId: "test.reference_role",
      conclusions: [conclusion],
      warningCodes: [],
    });
    const fact = createEvidenceFactIdentityDeclaration(replay, "value");
    const valueTarget = createEvidenceObservationTargetDeclaration(replay, {
      slotId: "value",
      fact,
      kind: "source",
      purpose: "value",
      sourceClass: "chain_rpc",
      roles: { value: "expected_role" },
    });
    const definition = defineReadCapability<{}, z.infer<typeof dataSchema>>({
      capabilityId: "test.reference_role",
      contractVersion: "1",
      inputSchema: z.object({}).strict(),
      dataSchema,
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      evidence: {
        definition: replay,
        observationTargets: () => [valueTarget],
        declaration: (_input, data, binder) => {
          const value = binder.bind(valueTarget);
          return {
            observationExpectations: [{
              slot: value.slot,
              claims: [{ role: value.roles.value, value: "safe", chainAnchor: block }],
            }],
            observationReferences: [{
              observationId: data.observationId,
              slot: value.slot,
              role: {} as never,
            }],
            factRequirements: [{
              fact,
              observationSlots: [value.slot],
              requiredObservationSlots: [value.slot],
              minimumObservationCount: 1,
              outcome: "observed",
            }],
            conclusionDrafts: [{
              conclusion,
              outcomeFact: fact,
              evidenceFacts: [fact],
              freshnessRuleId: "chain_anchor_exact",
            }],
            warningRequirements: [],
          };
        },
        staticScopeExclusions: [],
      },
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async (_input, context, observations) => ({
      status: "success",
      data: {
        observationId: (() => {
          const value = observations.bind(valueTarget);
          return recordRpc(context, observations, value.slot, [{
          role: value.roles.value,
          value: "safe",
          chainAnchor: block,
          }]);
        })(),
      },
    }));
    expect((await invokeBinding(definition, binding, {})).ok).toBe(false);
  });

  it("requires each fact requirement to declare one observation authority", async () => {
    const conclusion = createExactConclusionIdentityDeclaration("input_validated");
    const replay = createEvidenceReplayDefinition({
      capabilityId: "test.factauthority",
      conclusions: [conclusion],
      warningCodes: [],
    });
    const inputEvidence = createValidatedInputEvidenceFragment(replay);
    const sourceTarget = createEvidenceObservationTargetDeclaration(replay, {
      slotId: "source",
      fact: inputEvidence.fact,
      kind: "source",
      purpose: "source",
      sourceClass: "chain_rpc",
      roles: { value: "source" },
    });
    const definition = defineReadCapability<{}, { value: string }>({
      capabilityId: "test.factauthority",
      contractVersion: "1",
      inputSchema: z.object({}).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      evidence: {
        definition: replay,
        observationTargets: () => [inputEvidence.target, sourceTarget],
        declaration: (input, _data, binder) => {
          const validated = binder.bind(inputEvidence.target);
          const source = binder.bind(sourceTarget);
          return {
            observationExpectations: [{
              slot: validated.slot,
              claims: [{ role: validated.roles.input, value: input as never }],
            }],
            observationReferences: [],
            factRequirements: [{
              fact: inputEvidence.fact,
              observationSlots: [validated.slot, source.slot],
              requiredObservationSlots: [validated.slot],
              minimumObservationCount: 1,
              outcome: "validated_input",
            }],
            conclusionDrafts: [{
              conclusion,
              outcomeFact: inputEvidence.fact,
              evidenceFacts: [inputEvidence.fact],
              freshnessRuleId: "validated_input_current",
            }],
            warningRequirements: [],
          };
        },
        staticScopeExclusions: [],
      },
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async () => ({
      status: "success",
      data: { value: "safe" },
    }));
    expect((await invokeBinding(definition, binding, {})).ok).toBe(false);
  });

  it("does not construct freshness from a fact with no evidence", async () => {
    const conclusion = createExactConclusionIdentityDeclaration("value_not_present");
    const replay = createEvidenceReplayDefinition({
      capabilityId: "test.emptyevidence",
      conclusions: [conclusion],
      warningCodes: [],
    });
    const fact = createEvidenceFactIdentityDeclaration(replay, "value");
    const valueTarget = createEvidenceObservationTargetDeclaration(replay, {
      slotId: "value",
      fact,
      kind: "source",
      purpose: "value",
      sourceClass: "chain_rpc",
      roles: { value: "value" },
    });
    const definition = defineReadCapability<{}, { value: string }>({
      capabilityId: "test.emptyevidence",
      contractVersion: "1",
      inputSchema: z.object({}).strict(),
      dataSchema: z.object({ value: z.string() }).strict(),
      failureCodes: ["internal_error", "invalid_input", "result_too_large"],
      evidence: {
        definition: replay,
        observationTargets: () => [valueTarget],
        declaration: (_input, _data, binder) => {
          const value = binder.bind(valueTarget);
          return {
            observationExpectations: [],
            observationReferences: [],
            factRequirements: [{
              fact,
              observationSlots: [value.slot],
              requiredObservationSlots: [],
              minimumObservationCount: 0,
              outcome: "not_present",
            }],
            conclusionDrafts: [{
              conclusion,
              outcomeFact: fact,
              evidenceFacts: [fact],
              freshnessRuleId: "chain_anchor_exact",
            }],
            warningRequirements: [],
          };
        },
        staticScopeExclusions: [],
      },
    });
    const harness = createCapabilityHarness();
    const binding = bindForHarness(definition, harness, async () => ({
      status: "success",
      data: { value: "safe" },
    }));
    expect((await invokeBinding(definition, binding, {})).ok).toBe(false);
  });
});
