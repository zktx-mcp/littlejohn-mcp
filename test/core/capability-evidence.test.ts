import { describe, expect, expectTypeOf, it } from "vitest";

import {accountBalanceEvidence, accountNativeDecimalsExclusion, accountTokenEvidenceIdentity} from "../../src/account-assets/balance-evidence.js";
import {chainStatusEvidence, addressInspectEvidence, receiptLogAmountRole, transactionEventDecimalsExclusion, transactionInspectEvidence, transactionNativeDecimalsExclusion} from "../../src/chain/evidence.js";
import {createConfiguredChainEvidenceFragment} from "../../src/chain/evidence-fragments.js";
import {createValidatedInputEvidenceFragment} from "../../src/registry/validated-input-evidence.js";
import {walletConnectionEvidence} from "../../src/wallet/connection-evidence.js";
import { createEvidenceReplayBinder, readBoundEvidenceObservationSlot } from "../../src/core/client.js";
import { type BoundEvidenceClaimRoleDeclaration, type BoundEvidenceObservationSlotDeclaration } from "../../src/core/index.js";
import { createEvidenceReplayLayout, createExactConclusionIdentityDeclaration, readEvidenceReplayConclusionIds, readEvidenceReplaySlots } from "../../src/core/client.js";
import { createEvmEvidenceReplayDefinition } from "../../src/evm/evidence-replay.js";
import { readCapabilityLimits } from "../../src/evm/read-limits.js";
import {evmAddressSchema} from "../../src/evm/identities.js";

describe("capability evidence identity authority", () => {
  it("does not type raw strings as bound recording declarations", () => {
    expectTypeOf<string>().not.toMatchTypeOf<BoundEvidenceObservationSlotDeclaration>();
    expectTypeOf<string>().not.toMatchTypeOf<BoundEvidenceClaimRoleDeclaration>();
  });

  it("binds the configured-chain fragment independently for each capability", () => {
    const chainLayout = createEvidenceReplayLayout(chainStatusEvidence.definition, [
      chainStatusEvidence.configuredChain.target,
      chainStatusEvidence.targets.latestBlock,
    ]);
    expect(readEvidenceReplaySlots(chainStatusEvidence.definition, chainLayout)).toEqual([
      {
        slotId: "rpc_chain_id",
        factId: "rpc_chain_id",
        kind: "source",
        purpose: "chain_id",
        sourceClass: "chain_rpc",
      },
      {
        slotId: "latest_block",
        factId: "latest_block",
        kind: "source",
        purpose: "latest_block",
        sourceClass: "chain_rpc",
      },
    ]);

    const addressLayout = createEvidenceReplayLayout(addressInspectEvidence.definition, [
      addressInspectEvidence.configuredChain.target,
      addressInspectEvidence.validatedInput.target,
      addressInspectEvidence.targets.runtimeCode,
      ...Object.values(addressInspectEvidence.analysis.targets),
    ]);
    expect(() => createEvidenceReplayBinder(
      chainStatusEvidence.definition,
      chainLayout,
    ).bind(addressInspectEvidence.configuredChain.target)).toThrow("provenance");
    expect(readEvidenceReplaySlots(addressInspectEvidence.definition, addressLayout)[0])
      .toEqual(readEvidenceReplaySlots(chainStatusEvidence.definition, chainLayout)[0]);
  });

  it("owns the complete validated-input identity in one fragment", () => {
    const layout = createEvidenceReplayLayout(accountBalanceEvidence.definition, [
      accountBalanceEvidence.configuredChain.target,
      accountBalanceEvidence.targets.block,
      accountBalanceEvidence.validatedInput.target,
    ]);
    const bound = createEvidenceReplayBinder(
      accountBalanceEvidence.definition,
      layout,
    ).bind(accountBalanceEvidence.validatedInput.target);
    expect(readBoundEvidenceObservationSlot(
      accountBalanceEvidence.definition,
      layout,
      bound.slot,
    )).toEqual({
      purpose: "account_input",
      sourceClass: "validated_input",
      validatedInputIdentity: {
        owner: "Little John validated input",
        sourceId: "input:account.balance",
      },
    });
    expect(readEvidenceReplaySlots(accountBalanceEvidence.definition, layout)[2]).toEqual({
      slotId: "account",
      factId: "account",
      kind: "validated_input",
      purpose: "account_input",
    });

    const addressLayout = createEvidenceReplayLayout(addressInspectEvidence.definition, [
      addressInspectEvidence.validatedInput.target,
      addressInspectEvidence.targets.runtimeCode,
    ]);
    const addressInput = createEvidenceReplayBinder(
      addressInspectEvidence.definition,
      addressLayout,
    ).bind(addressInspectEvidence.validatedInput.target);
    expect(readBoundEvidenceObservationSlot(
      addressInspectEvidence.definition,
      addressLayout,
      addressInput.slot,
    )).toEqual({
      purpose: "address_target",
      sourceClass: "validated_input",
      validatedInputIdentity: {
        owner: "Little John validated input",
        sourceId: "input:address.inspect",
      },
    });
    expect(readEvidenceReplaySlots(addressInspectEvidence.definition, addressLayout)).toEqual([
      {
        slotId: "address_target",
        factId: "address_target",
        kind: "validated_input",
        purpose: "address_target",
      },
      {
        slotId: "address_runtime_code",
        factId: "runtime_code",
        kind: "source",
        purpose: "address_runtime_code",
        sourceClass: "chain_rpc",
      },
    ]);
  });

  it("requires valid semantic identities without delegating authority metadata", () => {
    const invalidInputs = [
      { factId: "not valid", slotId: "input", purpose: "input", roleId: "input" },
      { factId: "input", slotId: "not valid", purpose: "input", roleId: "input" },
      { factId: "input", slotId: "input", purpose: "not-valid", roleId: "input" },
      { factId: "input", slotId: "input", purpose: "input", roleId: "not valid" },
    ];
    for (const [index, semanticIds] of invalidInputs.entries()) {
      const definition = createEvmEvidenceReplayDefinition({
        capabilityId: `test.validated_input_${index}`,
        conclusions: [createExactConclusionIdentityDeclaration(`validated_${index}`)],
        warningCodes: [],
      });
      expect(() => createValidatedInputEvidenceFragment(definition, semanticIds)).toThrow();
    }
  });

  it("creates one typed account-token identity without a placeholder authoring path", () => {
    const address = evmAddressSchema.parse(`0x${"1".repeat(40)}`);
    const otherAddress = evmAddressSchema.parse(`0x${"2".repeat(40)}`);
    const input = Object.freeze({ tokens: Object.freeze([address]) });
    const token = accountTokenEvidenceIdentity(input, address);
    expect(accountTokenEvidenceIdentity(input, address)).toBe(token);
    const layout = createEvidenceReplayLayout(accountBalanceEvidence.definition, [
      accountBalanceEvidence.configuredChain.target,
      accountBalanceEvidence.targets.block,
      accountBalanceEvidence.targets.walletAccount,
      token.balanceTarget,
      token.decimalsTarget,
    ]);
    expect(readEvidenceReplaySlots(accountBalanceEvidence.definition, layout).slice(-2))
      .toEqual([
        {
          slotId: `token:${address}:balance`,
          factId: `token_balance:${address}`,
          kind: "source",
          purpose: "token_balance",
          sourceClass: "chain_rpc",
        },
        {
          slotId: `token:${address}:decimals`,
          factId: `token_balance:${address}`,
          kind: "source",
          purpose: "token_decimals",
          sourceClass: "chain_rpc",
        },
      ]);
    expect(readEvidenceReplayConclusionIds(accountBalanceEvidence.definition)).toEqual([
      "account_bound",
      "native_balance_observed",
      "token_balance:<address>",
    ]);
    expect(() => accountTokenEvidenceIdentity(
      input,
      `0x${"A".repeat(40)}` as never,
    )).toThrow();
    expect(() => accountTokenEvidenceIdentity(input, otherAddress))
      .toThrow("outside its input scope");

    const otherInput = Object.freeze({ tokens: Object.freeze([otherAddress]) });
    const otherToken = accountTokenEvidenceIdentity(otherInput, otherAddress);
    expect(() => createEvidenceReplayLayout(accountBalanceEvidence.definition, [
      token.balanceTarget,
      otherToken.decimalsTarget,
    ])).toThrow("mixes declaration scopes");
  });

  it("bounds receipt-log roles to the current receipt limit and one declaration", () => {
    const first = receiptLogAmountRole(0);
    expect(receiptLogAmountRole(0)).toBe(first);
    expect(() => receiptLogAmountRole(-1)).toThrow("index");
    expect(() => receiptLogAmountRole(0.5)).toThrow("index");
    expect(() => receiptLogAmountRole(readCapabilityLimits.transactionReceiptLogs))
      .toThrow("index");
    const layout = createEvidenceReplayLayout(transactionInspectEvidence.definition, [
      transactionInspectEvidence.configuredChain.target,
      transactionInspectEvidence.targets.transaction,
      transactionInspectEvidence.targets.receipt,
      transactionInspectEvidence.targets.block,
    ]);
    expect(() => createEvidenceReplayBinder(
      walletConnectionEvidence.definition,
      createEvidenceReplayLayout(walletConnectionEvidence.definition, [
        walletConnectionEvidence.targets.sdk,
        walletConnectionEvidence.targets.session,
      ]),
    ).bindRole(first)).toThrow("provenance");
    expect(createEvidenceReplayBinder(
      transactionInspectEvidence.definition,
      layout,
    ).bindRole(first)).toBeTypeOf("object");
  });

  it("keeps the three producer-consumed exclusions on their exact definitions", () => {
    expect(transactionInspectEvidence.staticScopeExclusions).toContain(
      transactionEventDecimalsExclusion,
    );
    expect(transactionInspectEvidence.staticScopeExclusions).toContain(
      transactionNativeDecimalsExclusion,
    );
    expect(accountBalanceEvidence.staticScopeExclusions).toContain(
      accountNativeDecimalsExclusion,
    );
    expect(transactionEventDecimalsExclusion.id)
      .toBe("transaction_event_decimals_not_observed");
    expect(transactionNativeDecimalsExclusion.id)
      .toBe("transaction_native_decimals_not_observed");
    expect(accountNativeDecimalsExclusion.id)
      .toBe("account_native_decimals_not_observed");
  });

  it("exposes five disjoint core definitions and no shared global slot object", () => {
    expect([
      chainStatusEvidence,
      addressInspectEvidence,
      transactionInspectEvidence,
      accountBalanceEvidence,
      walletConnectionEvidence,
    ].map((evidence) => readEvidenceReplayConclusionIds(evidence.definition))).toEqual([
      ["latest_block_observed", "rpc_chain_id_matches_scope"],
      [
        "address_target_bound",
        "contract_controls_observed",
        "contract_deployment_observed",
        "contract_source_checked",
        "no_runtime_code_observed",
        "runtime_code_observed",
      ],
      [
        "inclusion_observed",
        "receipt_observed",
        "standard_events_decoded",
        "transaction_observed",
      ],
      ["account_bound", "native_balance_observed", "token_balance:<address>"],
      ["wallet_connection_state"],
    ]);

    const conclusion = createExactConclusionIdentityDeclaration("test");
    const definition = createEvmEvidenceReplayDefinition({
      capabilityId: "test.fragment",
      conclusions: [conclusion],
      warningCodes: [],
    });
    const chain = createConfiguredChainEvidenceFragment(definition);
    const input = createValidatedInputEvidenceFragment(definition, {
      factId: "account",
      slotId: "account",
      purpose: "account_input",
      roleId: "validated_input",
    });
    expect(chain.target.slot).not.toBe(chainStatusEvidence.configuredChain.target.slot);
    expect(input.target.slot).not.toBe(accountBalanceEvidence.validatedInput.target.slot);
  });
});
