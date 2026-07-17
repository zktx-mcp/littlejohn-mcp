# Transaction Review And Execution Policy

This document is the sole authority for transaction construction, commitment,
review, simulation, wallet handoff, broadcast, receipt, explicit confirmation,
and transaction security claims.

## Authority Boundary

- Natural-language intent, AI output, external calldata, transaction requests,
  SDK output, quotes, simulations, and reputation signals follow the authority
  and trust rules in `docs/EVIDENCE_POLICY.md`.
- MCP and AI clients never sign, hold signing authority, or autonomously execute.
- Little John never stores private keys, seed phrases, mnemonics, or raw
  signatures.
- MCP responses and ordinary review responses never contain WalletConnect
  secrets, raw signed transactions, or a new transaction's signable request.
- A wallet transport never weakens explicit user confirmation, non-custodial
  authority, reviewed-request equality, or receipt verification.
- Wallet management operations, local wallet-management confirmation, and
  WalletConnect approval follow
  `docs/ARCHITECTURE.md#wallet-connection-lifecycle`. None creates transaction
  authority. Wallet approval remains separate from the transaction confirmation
  defined below.
- MCP, piped CLI input, redirected CLI input, environment variables, saved
  settings, and command flags never authorize a wallet request.

## Confirmation Authority

A `confirmation grant` is the only Little John authority to hand a reviewed
transaction to a wallet. It is separate from local HTTP authentication, direct
wallet-connection commands, and a WalletConnect session.

- The runtime creates a grant only after an explicit transaction-confirmation
  action in the review's selected local web interface or interactive CLI.
- A grant binds one review, the `transaction_handoff` operation, one
  confirmation interface, the selected chain and account, and a short expiry.
- A grant is single-use. Consumption, expiry, interface transfer, review
  invalidation, account change, chain change, rejection, cancellation, or
  terminal result revokes it.
- Grant storage and transport follow
  `docs/ARCHITECTURE.md#local-credential-taxonomy`.
- A local control credential or browser request credential authenticates the
  transport under `docs/ARCHITECTURE.md#local-credential-taxonomy`; neither can
  create or replace a confirmation grant.
- WalletConnect namespace approval permits the advertised protocol methods. It
  does not create or replace a confirmation grant and does not replace the
  wallet's approval of an individual request.
- An interface transfer revokes the old grant and never creates a grant for the
  new interface. The user performs a new explicit action in that interface.
- At most one unconsumed confirmation grant exists for a review.

## Transaction Construction

- Little John builds a supported transaction locally or independently verifies
  every transaction-critical field.
- Construction uses approved deployments, current chain state, exact deployed
  code and ABI identity, fresh execution inputs, exact numeric values, and
  explicit user choices.
- Little John never silently selects an asset, venue, route, bridge, spender,
  slippage, recipient, paymaster, delegate, or settlement token.
- Only protocol action adapters build protocol-specific requests.
- Module dependency restrictions are defined only in
  `docs/ARCHITECTURE.md#dependency-rules`.

## Contract And Transaction Analysis

- ABI and source data bind to exact deployed code.
- A selector candidate is not an exact decode.
- Analysis resolves proxy, implementation, beacon, admin, owner, role, pause,
  mint, burn, block, fee, oracle, and upgrade capabilities.
- A capability is evidence and is not automatic maliciousness.
- Every nested call and call target is decoded or remains explicitly unresolved.
- Provider disagreement is inconsistent evidence.
- Identity, meaning, or execution-critical inconsistency fails closed.
- Code identity, control state, pause state, allowance, nonce, execution inputs,
  and account are revalidated before wallet handoff.
- Persistent account and authorization state are re-read during receipt
  verification.

## Commitments

Little John maintains two versioned canonical commitments.

`semanticCommitment` binds:

- chain;
- sender;
- action;
- asset identities and exact limits;
- recipient;
- venue;
- router or spender;
- execution-input identity;
- expiry; and
- expected-effect policy.

`walletRequestCommitment` binds normalized:

- `chainId`;
- `from`;
- `to`;
- `value`;
- `data`; and
- every envelope field that can change reviewed meaning.

Before wallet handoff:

```text
review walletRequestCommitment
  == simulation walletRequestCommitment
  == wallet handoff walletRequestCommitment
```

After broadcast:

```text
actual transaction fields included in the commitment
  == reviewed wallet request fields included in the commitment
```

Canonical encodings are versioned. Commitments never hash presentation JSON,
localized values, unordered fields, or approximate numeric values.

## Review And Simulation

- The review binds one account, one transaction request, and one transaction
  commitment.
- The review UI shows target, recipient, spender, calldata meaning, asset
  identities, raw and display amounts, fees, limits, approvals, control facts,
  simulation coverage, expected deltas, warnings, blocks, and raw audit details.
- Simulation uses the exact transaction commitment shown in review.
- Simulation success is evidence only for its exact state, block, provider, and
  requested coverage.
- Missing simulation fields, provider disagreement, stale state, unresolved
  decoding, unexpected targets, unknown delegates, and unknown paymasters remain
  visible and block execution when they affect identity, meaning, or authority.
- The review states are `ready_for_wallet_review`, `refresh_required`, and
  `blocked`.
- Only the review module creates these states.

## Wallet Handoff

- A review session has at most one pending wallet request.
- Wallet coordinator, session, account-projection, persistence, and interface
  ownership are defined only in `docs/ARCHITECTURE.md`.
- Handoff consumes a valid confirmation grant for the exact review and
  `transaction_handoff` operation.
- The wallet receives the exact request identified by the reviewed
  `walletRequestCommitment`.
- The handoff recomputes the commitment immediately before calling
  WalletConnect.
- Account or chain changes, expired inputs, changed deployments, changed code,
  changed allowance or nonce, or commitment mismatch cancel the handoff and
  require refresh or block the request.
- When the active session already approves the selected account,
  `eip155:4663`, and the required method, the coordinator sends the request on
  that session without another QR pairing.
- Missing or expired session state, session deletion, missing chain, missing
  account, or missing method requires reconnection or new session approval and
  never falls back to an unapproved request.
- A wallet-originated session deletion invalidates the shared connection state.
  Any pending request becomes non-retriable and is never resent automatically.

## Broadcast And Receipt

- A wallet-returned transaction hash is not success evidence by itself.
- Little John re-reads the transaction and receipt from Robinhood Chain.
- The receipt path verifies transaction fields included in the commitment,
  status, block,
  finality state, logs, actual asset deltas, fees, allowances, and other
  persistent state affected by the supported action.
- Actual effects are compared with the reviewed request and expected effects.
- Each review session records one terminal execution result.
- Receipt evidence states its sources, observation block, freshness, coverage,
  mismatches, and unresolved facts.

## Security Claims

- Evidence and public safety claims are governed by
  `docs/EVIDENCE_POLICY.md#public-claims`.
- A successful simulation never establishes execution or finality beyond its
  exact observed state, block, provider, and coverage.
- A reviewed request never establishes that the wallet approved, broadcast, or
  executed the same request; the receipt path establishes those later facts.

## Verification

- Implementation verification covers commitment equality, explicit confirmation,
  stale and conflicting state, wallet rejection and disconnect, account and
  chain changes, receipt mismatch, finality transitions, and provider
  disagreement.
- Automated transaction verification follows
  `../AGENTS.md#test-and-verification-policy`.
