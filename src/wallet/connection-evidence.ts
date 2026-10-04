import { createEvidenceFactIdentityDeclaration, createEvidenceObservationTargetDeclaration } from "../core/client.js";
import { createEvmEvidenceReplayDefinition } from "../evm/evidence-replay.js";
import {exclusion, exactConclusion} from "../core/client.js";

const walletConnectionConclusion = exactConclusion("wallet_connection_state");

const walletReplay = createEvmEvidenceReplayDefinition({
  capabilityId: "wallet.connection",
  conclusions: [walletConnectionConclusion],
  warningCodes: [],
});

const walletConnectionFact =
  createEvidenceFactIdentityDeclaration(walletReplay, "wallet_connection");

const walletSdkTarget = createEvidenceObservationTargetDeclaration(walletReplay, {
  slotId: "wallet_sdk",
  fact: walletConnectionFact,
  kind: "source",
  purpose: "wallet_sdk_sessions",
  sourceClass: "wallet_sdk",
  roles: { state: "wallet_sdk_state" },
});

const walletSessionTarget = createEvidenceObservationTargetDeclaration(walletReplay, {
  slotId: "wallet_session",
  fact: walletConnectionFact,
  kind: "source",
  purpose: "wallet_session",
  sourceClass: "wallet_session",
  roles: { state: "wallet_session_state" },
});

export const walletConnectionEvidence = Object.freeze({
  definition: walletReplay,
  facts: Object.freeze({
    connection: walletConnectionFact,
  }),
  targets: Object.freeze({
    sdk: walletSdkTarget,
    session: walletSessionTarget,
  }),
  conclusions: Object.freeze({
    connectionState: walletConnectionConclusion,
  }),
  warningCodes: Object.freeze([]),
  staticScopeExclusions: Object.freeze([
    exclusion("address_ownership", "Connection state does not prove address ownership."),
    exclusion(
      "future_session_usability",
      "Connection state does not guarantee future session usability.",
    ),
    exclusion("signing_authority", "Connection state does not grant signing authority."),
    exclusion(
      "transaction_approval",
      "Connection state does not approve a transaction.",
    ),
    exclusion("wallet_safety", "Connection state does not establish wallet safety."),
  ]),
});
