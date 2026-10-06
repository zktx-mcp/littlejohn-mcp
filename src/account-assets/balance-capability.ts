import { addressTargetReadFailureCodes } from "../chain/read-failures.js";
import {accountBalanceDataSchema, accountBalanceInputSchema, assertAccountBalanceChainSemantics, assertAccountBalanceDataSemantics, assertAccountBalanceRequestSemantics, type AccountBalanceData, type AccountBalanceInput} from "./balance-contract.js";
import {defineEvmReadCapability} from "../evm/capability.js";
import {type ReadCapabilityEvidence} from "../core/client.js";
import {type EvidenceReplayBinder, type EvidenceReplayDeclaration, type FactRequirement, type ObservationExpectation, type ObservationReference, type WarningRequirement} from "../core/client.js";
import {accountBalanceEvidence, accountNativeDecimalsExclusion, accountTokenEvidenceIdentity} from "./balance-evidence.js";
import {compareCodePointSequences} from "../core/client.js";
import { requirement, claim, expectation, asJson, conclusionFromFact } from "../core/client.js";
import {amountObservationReferences} from "../evm/read-evidence.js";

const requiresAdditionalAccountRequestEvidence = (
  input: AccountBalanceInput,
): boolean => input.account.kind === "active_wallet" && !input.includeNative;

const accountObservationTargets = (input: AccountBalanceInput) => [
  accountBalanceEvidence.configuredChain.target,
  accountBalanceEvidence.targets.block,
  input.account.kind === "address"
    ? accountBalanceEvidence.validatedInput.target
    : accountBalanceEvidence.targets.walletAccount,
  ...(input.includeNative ? [accountBalanceEvidence.targets.nativeBalance] : []),
  ...input.tokens.flatMap((address) => {
    const identity = accountTokenEvidenceIdentity(input, address);
    return [identity.balanceTarget, identity.decimalsTarget];
  }),
  ...(requiresAdditionalAccountRequestEvidence(input)
    ? [accountBalanceEvidence.validatedInput.target]
    : []),
];

const accountObservationExpectations = (
  input: AccountBalanceInput,
  data: AccountBalanceData,
  binder: EvidenceReplayBinder,
): ObservationExpectation[] => {
  const chain = binder.bind(accountBalanceEvidence.configuredChain.target);
  const block = binder.bind(accountBalanceEvidence.targets.block);
  const expectations: ObservationExpectation[] = [
    expectation(chain.slot, [claim(chain.roles.chainId, data.block.chainId)]),
    expectation(block.slot, [
      claim(block.roles.block, asJson(data.block), { chainAnchor: data.block }),
    ]),
    ...(input.account.kind === "address"
      ? [expectation(
          binder.bind(accountBalanceEvidence.validatedInput.target).slot,
          [claim(
            binder.bind(accountBalanceEvidence.validatedInput.target).roles.input,
            asJson(input),
          )],
        )]
      : [expectation(
          binder.bind(accountBalanceEvidence.targets.walletAccount).slot,
          [claim(
            binder.bind(accountBalanceEvidence.targets.walletAccount).roles.account,
            data.account,
          )],
        )]),
    ...(requiresAdditionalAccountRequestEvidence(input)
      ? [expectation(
          binder.bind(accountBalanceEvidence.validatedInput.target).slot,
          [claim(
            binder.bind(accountBalanceEvidence.validatedInput.target).roles.input,
            asJson(input),
          )],
        )]
      : []),
  ];
  if (data.native.status === "available") {
    const nativeBalance = binder.bind(accountBalanceEvidence.targets.nativeBalance);
    expectations.push(expectation(nativeBalance.slot, [
      claim(nativeBalance.roles.balance, data.native.amount.raw, {
        asset: data.native.amount.asset,
        chainAnchor: data.block,
      }),
    ]));
  }
  for (const token of data.tokens) {
    const identity = accountTokenEvidenceIdentity(input, token.asset.address);
    const balance = binder.bind(identity.balanceTarget);
    const decimals = binder.bind(identity.decimalsTarget);
    if (token.result.status === "unavailable") {
      const failed = asJson({ status: "unavailable", errorCode: token.result.errorCode });
      expectations.push(
        expectation(balance.slot, [claim(balance.roles.balance, failed, {
          asset: token.asset,
          chainAnchor: data.block,
        })]),
        expectation(decimals.slot, [claim(decimals.roles.decimals, failed, {
          asset: token.asset,
          chainAnchor: data.block,
        })]),
      );
      continue;
    }
    const amount = token.result.amount;
    if (amount.decimals.status === "unavailable" && amount.decimals.reason === "conflicting") {
      throw new TypeError("One RPC decimals source cannot establish conflicting decimals values.");
    }
    const decimalsValue = amount.decimals.status === "available" ? amount.decimals.value : null;
    expectations.push(
      expectation(balance.slot, [claim(balance.roles.balance, amount.raw, {
        asset: amount.asset,
        chainAnchor: data.block,
      })]),
      expectation(decimals.slot, [claim(decimals.roles.decimals, decimalsValue, {
        asset: amount.asset,
        chainAnchor: data.block,
      })]),
    );
  }
  return expectations;
};

const accountBalanceEvidenceDeclaration = (
  input: AccountBalanceInput,
  data: AccountBalanceData,
  binder: EvidenceReplayBinder,
): EvidenceReplayDeclaration => {
  const chain = binder.bind(accountBalanceEvidence.configuredChain.target);
  const block = binder.bind(accountBalanceEvidence.targets.block);
  const account = input.account.kind === "address"
    ? binder.bind(accountBalanceEvidence.validatedInput.target)
    : binder.bind(accountBalanceEvidence.targets.walletAccount);
  const accountFact = input.account.kind === "address"
    ? accountBalanceEvidence.validatedInput.fact
    : accountBalanceEvidence.facts.walletAccount;
  const requestScope = input.account.kind === "address" || !input.includeNative
    ? binder.bind(accountBalanceEvidence.validatedInput.target)
    : undefined;
  const references: ObservationReference[] = [];
  if (data.native.status === "available") {
    const nativeBalance = binder.bind(accountBalanceEvidence.targets.nativeBalance);
    references.push(...amountObservationReferences(
      data.native.amount,
      { slot: nativeBalance.slot, role: nativeBalance.roles.balance },
    ));
  }
  for (const token of data.tokens) {
    if (token.result.status === "available") {
      const identity = accountTokenEvidenceIdentity(input, token.asset.address);
      const balance = binder.bind(identity.balanceTarget);
      const decimals = binder.bind(identity.decimalsTarget);
      references.push(...amountObservationReferences(
        token.result.amount,
        { slot: balance.slot, role: balance.roles.balance },
        { slot: decimals.slot, role: decimals.roles.decimals },
      ));
    }
  }

  const warningRequirements: WarningRequirement[] = [];
  if (data.native.status === "available") {
    warningRequirements.push({
      code: "decimals_unavailable",
      facts: [accountBalanceEvidence.facts.nativeBalance],
    });
  }
  for (const token of data.tokens) {
    const fact = accountTokenEvidenceIdentity(input, token.asset.address).fact;
    if (token.result.status === "unavailable") {
      warningRequirements.push({ code: "partial_result", facts: [fact] });
    } else if (token.result.amount.decimals.status !== "available") {
      warningRequirements.push({ code: "decimals_unavailable", facts: [fact] });
    }
  }
  const requestScopeRequirements: FactRequirement[] = [];
  if (requiresAdditionalAccountRequestEvidence(input)) {
    if (requestScope === undefined) {
      throw new TypeError("Account request-scope evidence is absent.");
    }
    requestScopeRequirements.push(requirement(
      accountBalanceEvidence.validatedInput.fact,
      accountBalanceEvidence.validatedInput.outcome,
      [requestScope.slot],
    ));
  }

  return {
    observationExpectations: accountObservationExpectations(input, data, binder),
    observationReferences: references,
    factRequirements: [
      requirement(
        accountFact,
        input.account.kind === "address"
          ? accountBalanceEvidence.validatedInput.outcome
          : "observed",
        [account.slot],
      ),
      ...requestScopeRequirements,
      requirement(accountBalanceEvidence.facts.block, "observed", [block.slot]),
      input.includeNative
        ? requirement(
            accountBalanceEvidence.facts.nativeBalance,
            "observed",
            [binder.bind(accountBalanceEvidence.targets.nativeBalance).slot],
          )
        : requirement(
            accountBalanceEvidence.facts.nativeBalance,
            "not_requested",
            [],
          ),
      requirement(
        accountBalanceEvidence.configuredChain.fact,
        accountBalanceEvidence.configuredChain.outcome,
        [chain.slot],
      ),
      ...data.tokens.map((token) => {
        const identity = accountTokenEvidenceIdentity(input, token.asset.address);
        const slots = [
          binder.bind(identity.balanceTarget).slot,
          binder.bind(identity.decimalsTarget).slot,
        ];
        if (token.result.status === "available") {
          return requirement(identity.fact, "observed", slots);
        }
        return requirement(
          identity.fact,
          token.result.errorCode === "source_inconsistent" ? "source_inconsistent" : "source_failed",
          slots,
          [],
          1,
        );
      }),
    ],
    conclusionDrafts: [
      conclusionFromFact(
        accountBalanceEvidence.conclusions.accountBound,
        accountFact,
        input.account.kind === "address"
          ? accountBalanceEvidence.validatedInput.freshnessRuleId
          : "wallet_session_current",
      ),
      input.includeNative
        ? conclusionFromFact(
            accountBalanceEvidence.conclusions.nativeBalanceObserved,
            accountBalanceEvidence.facts.nativeBalance,
            "chain_anchor_exact",
          )
        : conclusionFromFact(
            accountBalanceEvidence.conclusions.nativeBalanceObserved,
            accountBalanceEvidence.facts.nativeBalance,
            accountBalanceEvidence.validatedInput.freshnessRuleId,
            [accountBalanceEvidence.validatedInput.fact],
          ),
      ...input.tokens.map((address) => {
        const identity = accountTokenEvidenceIdentity(input, address);
        return conclusionFromFact(
          identity.conclusion,
          identity.fact,
          "chain_anchor_exact",
        );
      }),
    ],
    warningRequirements,
  };
};

const accountBalanceCapabilityEvidence: ReadCapabilityEvidence<
  AccountBalanceInput,
  AccountBalanceData
> = Object.freeze({
  definition: accountBalanceEvidence.definition,
  observationTargets: accountObservationTargets,
  declaration: accountBalanceEvidenceDeclaration,
  staticScopeExclusions: accountBalanceEvidence.staticScopeExclusions,
});

export const accountBalanceCapability = defineEvmReadCapability<AccountBalanceInput, AccountBalanceData>({
  capabilityId: "account.balance",
  contractVersion: "1",
  inputSchema: accountBalanceInputSchema,
  dataSchema: accountBalanceDataSchema,
  failureCodes: addressTargetReadFailureCodes,
  normalizeInput: (input) => {
    if (new Set(input.tokens).size !== input.tokens.length) {
      throw new TypeError("Token addresses must be unique.");
    }
    return { ...input, tokens: [...input.tokens].sort(compareCodePointSequences) };
  },
  evidence: accountBalanceCapabilityEvidence,
  validateIntrinsicData: (data, context) => {
    context.assertDeclaredScopeExclusion(accountNativeDecimalsExclusion);
    assertAccountBalanceDataSemantics(data);
  },
  validateSuccess: (data, context) => {
    assertAccountBalanceChainSemantics(data, context.chainId);
  },
  validateRequest: assertAccountBalanceRequestSemantics,
});
