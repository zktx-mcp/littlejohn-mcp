import {z} from "zod";
import {defineEvmReadCapability} from "../evm/capability.js";
import {type ReadCapabilityEvidence} from "../core/client.js";
import {type EvidenceReplayBinder} from "../core/client.js";
import {walletConnectionEvidence} from "./connection-evidence.js";
import {assertCanonicalWalletConnection, walletConnectionDataSchema, type WalletConnectionData} from "./connection-contract.js";
import {semanticReadFailureCodes, noInputSchema, requirement, claim, expectation, asJson, conclusionFromFact} from "../core/client.js";

const walletConnectionInputSchema = noInputSchema;

export type WalletConnectionInput = z.infer<typeof walletConnectionInputSchema>;

const walletConnectionCapabilityEvidence: ReadCapabilityEvidence<
  WalletConnectionInput,
  WalletConnectionData
> = Object.freeze({
  definition: walletConnectionEvidence.definition,
  observationTargets: () => [
    walletConnectionEvidence.targets.sdk,
    walletConnectionEvidence.targets.session,
  ],
  declaration: (
    _input: WalletConnectionInput,
    data: WalletConnectionData,
    binder: EvidenceReplayBinder,
  ) => {
    const sdk = binder.bind(walletConnectionEvidence.targets.sdk);
    const session = binder.bind(walletConnectionEvidence.targets.session);
    return {
      observationExpectations: [
        expectation(sdk.slot, [claim(sdk.roles.state, asJson(data))]),
        ...(data.status === "connected"
          ? [expectation(session.slot, [claim(session.roles.state, asJson(data))])]
          : []),
      ],
      observationReferences: [],
      factRequirements: [requirement(
        walletConnectionEvidence.facts.connection,
        "observed",
        [sdk.slot, session.slot],
        data.status === "connected" ? [sdk.slot, session.slot] : [sdk.slot],
        data.status === "connected" ? 2 : 1,
      )],
      conclusionDrafts: [
        conclusionFromFact(
          walletConnectionEvidence.conclusions.connectionState,
          walletConnectionEvidence.facts.connection,
          "wallet_session_current",
        ),
      ],
      warningRequirements: [],
    };
  },
  staticScopeExclusions: walletConnectionEvidence.staticScopeExclusions,
});

export const walletConnectionCapability = defineEvmReadCapability<WalletConnectionInput, WalletConnectionData>({
  capabilityId: "wallet.connection",
  contractVersion: "1",
  inputSchema: walletConnectionInputSchema,
  dataSchema: walletConnectionDataSchema,
  failureCodes: semanticReadFailureCodes,
  evidence: walletConnectionCapabilityEvidence,
  validateIntrinsicData: assertCanonicalWalletConnection,
  validateDataContext: (data, context) => {
    if (data.status === "connected" && Date.parse(data.expiresAt) <= Date.parse(context.evaluatedAt)) {
        throw new TypeError("A connected wallet session must expire after evaluation.");
    }
  },
  validateSuccess: (data, context) => {
    if (data.status === "connected" && data.chainId !== context.chainId) {
      throw new TypeError("Wallet connection chain scope mismatch.");
    }
  },
});
