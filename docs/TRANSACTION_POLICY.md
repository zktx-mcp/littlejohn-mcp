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
  signatures. Transient verification and direct delivery of a data signature
  follow [Data Signing](#data-signing); they do not permit durable retention.
- Model-visible MCP content and structured results, ordinary Review responses,
  presentation snapshots, and durable operations never contain WalletConnect
  pairing or session secrets, raw signed transactions, or a new transaction's
  signable request. Active QR presentation follows the ephemeral App-private
  and direct-TTY boundary in
  `docs/ARCHITECTURE.md#durable-operation-ownership`.
- Raw data signatures never enter model-visible fields, ordinary Review reads,
  presentation snapshots, product logs or diagnostics.
- A wallet transport never weakens explicit user confirmation, non-custodial
  authority, reviewed-request equality, or receipt verification.
- Wallet management operations, local wallet-management confirmation, and
  WalletConnect approval follow
  `docs/ARCHITECTURE.md#wallet-connection-lifecycle`. None creates transaction
  authority. Wallet approval remains separate from the transaction confirmation
  defined below.
- Model-visible MCP calls, piped or redirected CLI input, environment
  variables, saved settings, and command flags never authorize a wallet
  request.

## Confirmation Authority

A `confirmation grant` is the only Little John authority to hand a reviewed
transaction to a wallet. It is server-owned, single-use state created only by
one direct user decision in an admitted MCP App or interactive CLI. It is
separate from MCP transport, local-process authentication, wallet-management
operations, and a WalletConnect session.

- An MCP App decision enters only through an App-only control after the View
  reports the required standard tool capability. A model-visible tool may
  construct or read an immutable Review but cannot create a grant or issue a
  WalletConnect request.
- An interactive CLI decision requires a live TTY and one exact affirmative
  response to the complete server-owned Review.
- The direct decision carries the complete admitted canonical Review. The
  runtime re-admits it, recomputes its commitment, recaptures its current
  closed preconditions, and independently revalidates its fixed evidence
  anchors before creating a grant.
- A grant binds one Review, the `transaction_handoff` operation, selected
  chain and account, exact wallet-request commitment, and short server-owned
  expiry. Its interface is recorded as provenance and is not an authority
  lock.
- The runtime creates and consumes the grant inside the same admitted handoff
  operation. No opaque grant reference is returned to an App, CLI, model, URL,
  or local transport client.
- Consumption, expiry, Review invalidation, account change, chain change,
  rejection, cancellation, or terminal result revokes it. At most one
  unconsumed grant exists for a Review.
- WalletConnect namespace approval permits the advertised protocol methods. It
  does not create or replace a grant and does not replace the wallet's
  approval of the individual request.
- The external wallet is the private-key and signature owner. Little John and
  its Host may request the exact reviewed transaction only after the grant is
  consumed; they cannot produce the signature or complete the spend without
  the wallet's separate approval.

## Transaction Material And Result Lifetime

- Complete transaction Review, unsigned request and confirmation grant exist
  only in bounded active memory. Consumption, rejection, cancellation, expiry or
  loss of the owner releases them; none is persisted for a subsequent attempt.
- Before handoff, Review fixes the versioned `walletRequestCommitment` and the
  original account/chain correlation. The response continuation retains only
  that comparison reference for its bounded lifetime, without an executable
  request or grant. Runtime/SDK storage ownership is defined by
  `ARCHITECTURE.md#transaction-request-ownership`.
- Durable transaction accounting starts only when a hash is actually received.
  The hash and its pre-send comparison reference are recorded atomically. No
  complete Review, raw request, signature or signed serialization is recorded.
- Bounded App card identity, dispatch classification and admitted outcome status
  may be retained under Architecture's card-state contract. This is presentation
  state, not transaction accounting, proof of sending, executable authority or
  request recovery. It does not extend any material lifetime.
- A normal hash response permits the original command's bounded receipt lookup.
  A late hash received after local waiting ends is recorded without starting
  another lookup. Subsequent reconciliation requires an explicit result-query
  command or the user's next transaction command.
- Local timeout, disconnect or stopping the display does not establish Wallet
  rejection, absence of a signature, cancellation or absence of broadcast.
  Without an observed hash/response the result remains unknown. Restart never
  reconstructs an unanswered request or claims recovery of a lost reference.
- Another transaction attempt, approval step or same-nonce replacement requires
  a new explicit user command, new Review, direct confirmation and Wallet
  approval. No timer, AI action, restored state or receipt outcome resends a
  financial request. Receipt reads within one bounded user-started lookup do
  not authorize a new transaction.
- The current confirmed and source-reported pending nonce govern new-request
  admission. Ledger order and elapsed time never derive a nonce. An included
  revert consumes nonce; a Wallet rejection does not establish nonce use.
- A same-nonce replacement is explicit new authority for either the same call
  with selected higher fees or a newly selected supported call. Its original
  transaction and nonce must be independently observed; there is no saved-request
  replay or silent nonce increment. Fees-only replacement cannot reconstruct
  missing calldata from an activity summary.

## Data Signing

Data signing uses the same direct App/interactive TTY authority boundary as a
transaction. Review binds the complete exact payload, selected account and
session, exact method, standard message hash and local expiry. The server
re-admits the live Review and current permission, then creates and consumes one
short-lived grant binding that hash, account and method before Wallet handoff.
Wallet independently recomputes the hash and rechecks the session and permission.
A signature never authorizes Little John to submit it to another service.

`personal_sign` signs explicitly selected UTF-8 or hex bytes using
[ERC-191 version 0x45](https://eips.ethereum.org/EIPS/eip-191).
`eth_signTypedData_v4` signs the exact declared types, domain and values using
[EIP-712](https://eips.ethereum.org/EIPS/eip-712). No chain, verifier, nonce or
expiry is silently inserted. A supplied domain chain must be the product chain;
an absent chain remains unbound. This command performs no transaction broadcast,
nonce reconciliation, receipt read, ledger insertion or automatic external use.

The verification profile recovers a 65-byte secp256k1 signature to the original
account against the standard hash fixed before sending. It establishes neither
enduring account type nor contract-account signature validity. A matching result
may be delivered directly. A mismatched signature is verification failure; an
unsupported signature format remains unsupported, without a usable value.

Review, payload and grant remain one-time bounded memory. After handoff, only
account, method, operation correlation and the pre-send hash continue into
verification. Explicit Wallet rejection, proved not-sent failure and unknown
delivery remain distinct. Timeout, disconnect or shutdown cannot prove remote
cancellation or absence of signing. Late responses are discarded without new
verification or storage; verification already running must recheck local wait
and owner state before publishing a result. Another request requires a new
direct decision. Local expiry or disposal does not revoke a signature.

Successful delivery permits only response-scoped product retention and the
current direct result panel or interactive CLI invocation. Architecture owns
the exact carriers and their correlation. Product-controlled storage, caches,
logs, snapshots and restart recovery retain no raw signature. The Host, terminal
scrollback and user-controlled copies are outside product disposal control.

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
- The canonical review owns the decoded action meaning and every applicable
  transaction fact required to authorize it, including target, recipient,
  spender, asset identities, exact outflows and expected inflows, fees, limits,
  approvals or eligibility, control facts, simulation coverage, expected
  deltas, warnings, and blocks. It omits a fact that does not apply and records
  an unestablished required fact as unavailable; it never substitutes raw
  calldata, hashes, digests, or source records for a missing conclusion.
- Human information priority and presentation of the admitted canonical Review
  are owned only by `docs/USER_INTERFACE_POLICY.md`.
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
- When the active session already approves the selected account, the canonical
  product chain identified by `docs/PRODUCT_POLICY.md`, and the required
  method, the coordinator sends the request on that session without another QR
  pairing.
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
- The independently normalized chain transaction is hashed through the same
  EVM request-commitment contract and compared with the immutable pre-send
  reference. A missing reference is unavailable comparison, never reconstructed
  from the transaction being checked. Request mismatch remains visible even
  when chain execution succeeded.
- For a supported native profile, pre-send admission proves that its encoded
  conditions equal the reviewed conditions. After complete request equality,
  the owning decoder recovers those conditions from the actual call and compares
  them with independently observed receipt effects. Calldata cannot supply both
  the expected and actual effect. Missing native coverage or effects prevents a
  positive verification; a digest alone establishes neither execution nor effects.
- The semantic commitment remains part of active Review admission. Persisting
  an unused second digest or a complete Review is not required for this proof.
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
