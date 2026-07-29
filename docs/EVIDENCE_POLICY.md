# Evidence Policy

This document is the sole authority for source authority, provenance,
observation time, freshness, coverage, inference, and public evidence claims.

## Source Authority

Use sources in this order:

1. Robinhood official sources for chain, asset, protocol-contract, Stock Token,
   and legal identity.
2. Pinned Robinhood Chain reads for code, storage, roles, state, logs,
   transactions, and receipts.
3. Official standards for data and transaction semantics.
4. A protocol or provider owner's official source for its deployment, API, SDK,
   feed, quote, or verification behavior.
5. Applicable government sources for jurisdiction-specific facts.
6. Local user policy for local allow and deny rules.

Lower-authority evidence cannot replace higher-authority identity evidence.
Official publication proves source ownership only; it does not prove safety,
correct deployment, current state, or transaction suitability.

## Evidence Record

Every external fact records:

- source owner and source class;
- exact source reference;
- coverage and explicit exclusions;
- the observed fact;
- supported and unsupported conclusions; and
- conflicts, uncertainty, and inference.

A fact whose value or validity can change with time or chain state additionally
records:

- observation time;
- chain anchor when applicable; and
- freshness status and the rule that produced it.

A source-defined identity or normative definition whose meaning does not depend
on observation time does not receive a timestamp or freshness claim merely to
satisfy a record format. It records the source version or revision when the
source owner publishes a stable one. Its conclusion remains limited to the
identity or definition and does not imply current availability or live state.

Every public evidence source records `recordDigest`, the SHA-256 digest of the
complete canonical public source record, excluding the digest field itself,
and the canonical ordered claims accepted for that observation. Public
validation derives the expected claims from the canonical request and result,
recomputes the digest from those claims and the public source record, and
rejects a changed, missing, or malformed digest.

`recordDigest` establishes only consistency between the public source record,
the public result, and the claims accepted by the local producer while the
digest remains unchanged. It is not a signature, message authentication code,
external attestation, safety conclusion, or proof that the local runtime is
uncompromised. A party able to replace the complete result can replace the
digest. Credentials, secret source identifiers, and provider-only values that
cannot be derived from the public source record, request, or result never enter
this digest.

A source-owner or standards link used only to define a normative policy term is
a citation, not runtime evidence and not a support claim. Any current support,
runtime observation, identity conclusion, or user-visible external fact requires
every applicable evidence field above.

An exact source reference never exposes a credential. A public source uses its
canonical public URI. A configured source whose URI contains user information,
path credentials, query credentials, or fragments uses a keyed endpoint
identifier that does not expose those values and contains:

- the normalized public origin;
- an HMAC-SHA-256 digest of the exact configured URI bytes using a
  runtime-owned, domain-separated local profile key; and
- a local source identifier bound to that digest.

The configured URI remains local configuration and never enters evidence,
responses, logs, or diagnostics. The key never enters the evidence module. The
digest establishes equality of the local configuration without publishing the
credential-bearing URI or enabling an unkeyed offline credential search.

Another secret-bearing source identifier, including a WalletConnect session
topic, uses the same pattern with a separate domain label: a local source ID and
keyed digest establish local equality while the raw identifier remains only in
its owning secret store.

An inference is labeled and remains separate from its source facts. Unknown,
stale, incomplete, and conflicting evidence is preserved rather than converted
into a positive conclusion.

## Robinhood Stock Token Classification

Current Robinhood Stock Token membership is owned by a complete successful
response from the canonical Robinhood source that passes the normalized
registry admission contract. `officialAssetSourceDefinition` in
`src/registry/official-asset-contract.ts` is the sole implementation owner of
the source URI, documentation source, product chain, and normalized member
limit. Runtime adapter, configuration, and composition ownership follow
`docs/ARCHITECTURE.md#external-integration-model`. Robinhood's
[official Token Contracts page](https://docs.robinhood.com/chain/contracts/)
establishes the source-owner contract table. A malformed, partial, oversized,
or failed response establishes neither membership nor absence. A stored
observation becomes stale whenever a required refresh fails.

Before Little John adds an API member to an account or publishes that member as
a verified account asset, the exact UID and token address require an independent
pinned Robinhood Chain read under `stockFactoryAdmissionManifest` in the same
contract module. That validated manifest is the sole exact implementation owner
of the admitted proxy, implementation slot and address, runtime-code hashes,
observation anchor, and source citations. The read verifies the admitted proxy
runtime code, its implementation in the
[EIP-1967 implementation slot](https://eips.ethereum.org/EIPS/eip-1967), the
implementation runtime code, `tokenAddress(uid)`, and nonempty runtime code at
the returned token address at one canonical block. A mismatch makes that exact
asset unavailable for selection or verified presentation; it does not rewrite
or invalidate other members of a complete API observation.

The API determines current membership; StockFactory proves the admitted
UID-to-address deployment identity. Factory mappings and deployment events do
not establish current membership because they have no current-member or removal
state. API names, symbols, logos, multipliers, and trading capabilities do not
establish token identity, current onchain metadata, price, availability, safety,
or legal meaning. Bounded API names and symbols may label an unselected
official candidate; verified account results use current onchain metadata.

An accepted API observation records the exact source, observation time, exact
response digest, normalized member-set digest, normalized candidate-list digest,
configured chain, and complete member set. `Robinhood Stock Token` in an account
result requires membership in that observation plus the exact per-asset
StockFactory verification at the result's chain block. `Custom ERC-20` requires
proved absence from the complete current API observation. When the API
observation is unavailable or stale, or the required per-asset verification
fails, classification remains unknown.

## Reference Market Feed Mapping

The validated `referenceMarketManifest` in `src/core/reference-market.ts` is the
sole exact owner of each supported mapping, its official source URI, source
owner and class, source observation time, freshness rule, coverage, exclusions,
supported conclusions, and unsupported conclusions. Policy and presentation
surfaces do not copy its addresses, decimals, heartbeat values, or observation
time.

The runtime does not fetch or revalidate that directory. Mapping freshness is
therefore the manifest's declared non-runtime-revalidation outcome. Public
results project the manifest-owned mapping evidence once and do not infer a
new source observation from an onchain read.

Each runtime reference-price observation separately reads the fixed proxy at one
canonical Robinhood Chain block and validates deployed code, description,
decimals, round identity, answer, answer time, and freshness. That onchain
observation establishes only the reported reference value and its exact source
position. It remains distinct from directory freshness, execution price, trade
volume, valuation, safety, recommendation, and transaction support.

A feed round's `updatedAt` is a source fact, not Little John's observation time.
Round read evidence records the actual canonical-clock read time, the configured
RPC's safe source reference, and the exact block used for that read. The cache
preserves the first admitted read evidence for an equal immutable round fact.
A later read of the same round does not replace that evidence, and a different
immutable fact for the same round creates an integrity conflict. Cached evidence
records its original read anchor; it does not claim later re-observation,
finality, reorganization survival, or independent-provider agreement.

Local history retention is not source evidence. Its inclusive composite-round
cutoff identifies only identities that the local cache will never read or admit
again. It establishes no source update time, source absence, exhaustive round
coverage, finality, or reorganization survival.

Reference history is always a bounded observation result. It reports
`observed_rounds` as its coverage basis and always states that source history is
not exhaustive. A returned candle proves only the admitted observations used
for its exact open, high, low, and close. An empty bucket proves only that the
bounded result contains no admitted point in that represented UTC bucket.
Missing, reverting, malformed, unperformed, retained-out, or otherwise
unresolved round identities never become evidence of source absence. A history
result is `partial` when it contains at least one observed-point candle and
`unavailable` when it contains none; no history result can claim complete
source coverage.

## Identity And Trust

- Asset identity is defined only in `docs/NUMERIC_POLICY.md#token-identity-and-decimals`.
- Third-party token lists cannot establish a canonical Robinhood Chain asset.
- SDK constants do not override official deployment records or observed code.
- Protocol SDK output is an untrusted proposal until the owning product boundary
  independently validates it.
- A WalletConnect SDK-store observation establishes only the locally observed
  session record, namespaces, accounts, methods, events, and expiry described by
  the [official WalletConnect session model](https://docs.walletconnect.network/wallet-sdk/web/usage).
  It does not establish address ownership, present connectivity, or approval of
  a Little John wallet request.
- Threat and reputation signals are advisory facts, not identity or safety
  decisions.
- Absence from an allowlist, denylist, or threat registry is an observation, not
  proof of safety.
- Provider disagreement is conflicting evidence. It fails closed when it affects
  identity, transaction meaning, numeric interpretation, or authorization.

## Contract Source And Control Evidence

Contract source verification binds one provider record to one exact chain,
address, and observed runtime bytecode. Only an exact runtime-bytecode match
may supply an ABI for declared-function or control analysis. A non-exact match,
missing record, unavailable lookup, malformed response, conflicting identity,
or runtime-bytecode mismatch establishes no ABI-dependent conclusion.

Proxy analysis records only the supported standard form that the pinned chain
reads establish. Absence of a supported proxy marker does not establish that a
contract is direct. An unresolved implementation prevents ABI-dependent
control conclusions.

An admitted exact ABI may establish its complete declared function signatures
and whether the fixed owner, pause, and default-administrator interfaces are
declared. A positive control result additionally requires the applicable
pinned chain read at the same canonical block. A missing, non-exact, or
unavailable ABI never establishes that a control is absent.

Source unavailability, unsupported proxy forms, unrecognized contract-specific
controls, and non-enumerable roles remain explicit limitations. Contract
source, proxy, declared-function, owner, pause, administrator, and
unavailability observations are evidence. They are not a safety score,
malicious-contract classification, honeypot decision, transaction approval, or
investment recommendation.

## Uniswap V2 Quote Evidence

The `uniswap_v2` package owns two immutable official-source records: the
Uniswap deployment record for the admitted Robinhood Chain V2 factory and pair
init-code hash, and the Robinhood route-asset record for WETH and USDG. These
records establish only the identities stated by their exact source revisions.
They do not establish current code, pair existence, liquidity, quote quality,
execution, or safety.

Each quote separately binds the configured chain, canonical block, admitted
factory runtime code and contract analysis, token-decimals reads, and every
pair fact actually read for each candidate. A candidate stops at its first
terminal hop; an unperformed later hop has no fabricated observation. Pair
address, runtime code, token order, reserves, and decimals are checked by
evidence replay. The canonical V2 result validator independently checks the
declared paths, hop order, arithmetic outputs, prices, and SDK comparison.
Public result validation rejects a substitution in either class.

The Uniswap SDK result is not source authority. It is an untrusted calculation
checked against the package's independent integer arithmetic. A quote reports
only the declared candidates at the observed block. It is not a best-route
recommendation, transaction result, universal sellability conclusion, honeypot
decision, or safety conclusion.

## Public Claims

- Public documentation cites source-owner official pages only.
- A source citation never expands the source's actual coverage.
- Do not claim safest, guaranteed, rug-free, scam-free, or investment-suitable
  behavior from evidence signals.
- Do not create a universal safety or rug score.
- A Stock Token is not described as ownership of its legal underlying share.
