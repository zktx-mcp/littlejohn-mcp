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

## Conclusion Completeness And Coverage

An evidence definition owns every conclusion required for its capability. Its
fixed conclusions apply to every invocation, and its declared dynamic families
have only the exact members admitted by that invocation's validated scope. A
producer supplies facts and conclusion drafts; it does not choose or repeat the
required conclusion set. Every required conclusion remains explicit as
established, not applicable, or unavailable.

A not-applicable conclusion is a complete non-positive answer only when
admitted supporting facts establish the validated exclusion, completed absence
check, or unsupported boundary. A conclusion is unavailable when the required
observation or proof of non-applicability is missing, failed, or inconsistent.
In particular, `not_observed` is unavailable; `not_requested`, `not_present`,
and `unsupported` are not applicable only within the exact scope established by
their supporting facts.

An outcome fact with no evidence authority has no observation of its own. Its
public conclusion still cites separate admitted observations that support the
outcome and satisfy one existing freshness rule. A conclusion without such
support is not published as a successful evidence result, and no synthetic
source or observation is created to make it publishable.

Coverage is complete when every required conclusion is established or proved
not applicable, partial when at least one but not all required conclusions are
unavailable, and unavailable when all required conclusions are unavailable.
Coverage derives only from these three conclusion-status partitions and never
from capability identities or reason-specific exceptions.

## ERC-8056 Balance Relation Evidence

The ERC-8056 balance relation compares the independently admitted onchain
`balanceOfUi` value and locally calculated adjusted raw amount for the same
token, account, and canonical block. Two available equal operands establish a
`supported` relation; two available unequal operands establish an
`inconsistent` relation. An unavailable balance call or unavailable bounded
local calculation makes the relation `unknown`. A reverted declared balance
call or malformed balance response is inconsistent source evidence rather than
an unavailable comparison.

The relation outcome never removes an independently admitted operand. The
numeric construction and meaning of the locally calculated operand remain
owned by `docs/NUMERIC_POLICY.md`.

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

An official-asset unavailable result is supported only by an admitted caller
abort, rate limit, non-success response, incomplete transport response,
response that exceeds the bounded adapter limit, or malformed provider
response. A local dependency contract, clock, digest, canonical construction,
storage, or unknown runtime failure is not official-source evidence. It
terminates the request as its admitted local or internal failure and cannot
establish membership absence, source inconsistency, or source unavailability.

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

A StockFactory unavailable result is supported only by an admitted pinned
Chain source or response failure, a verified deployment or UID-to-address
mismatch, missing token runtime code, a reverted required call, or malformed
provider-returned code, storage, or ABI return data. Caller cancellation, local
request capacity, owner closure, call encoding, dependency contracts,
canonical construction, and unknown local runtime failures are not
StockFactory evidence. They terminate the whole request without creating a
classification cause.

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

## Stock Token Trade History

A Stock Token trade-history result first consumes the registry owner's complete
current official-asset observation. Symbol is only a selector. The selected
member is verified through StockFactory at one canonical result block before
trade-history data is admitted. An absent or ambiguous official member, or a
member that StockFactory cannot verify at that block, prevents an available
trade-history result.

The admitted PoolManager deployment, complete PoolKey, exact Pool ID, and
finalized `Swap` event positions identify the trade source. The generated
`stockTokenTradeHistoryRegistry` is the sole runtime owner of those identities
for supported Stock Token/USDG pools. One exact one-minute candle establishes
only the qualifying executions in its registered pool during that minute,
quoted in USDG. A missing candle inside admitted continuous block coverage
establishes only that no admitted `Swap` with two non-zero, opposite-sign pool
balance deltas contributed a trade price during that minute. Continuous
coverage may still contain a validated `Swap` with a zero balance delta, which
supplies no exchange ratio and contributes no candle. A missing candle does not
establish underlying-equity activity, another pool's activity, liquidity, or
future trade availability.

The versioned pair-state, pair-month, and pair-day files retain finalized source
coverage, exact candle values, raw Stock Token and USDG volumes, trade count,
first and last contributing `Swap` positions, and byte digests. The canonical
result's `sourceFiles` member identifies the admitted pair state by generation
and digest and the selected month and day files by period and digest. Selected
day identities and coverage intervals are one-to-one projections of those same
admitted files. Each interval stays within its named UTC day, intersects the
requested interval, and ends no later than the pair state's published coverage.
A stale available result therefore also has the `after_published_coverage`
source-coverage limitation; this implication does not merge the separately
derived freshness and coverage states.

GitHub Releases currently carries these files but has no trade-fact authority.
Repository, release, asset, URL, and credential fields do not enter the
canonical result. The read path never reconstructs a candle from a chart or a
provider response. Provider unavailability, stale publication, retention,
integrity failure, and result capacity remain explicit outcomes and never
create a trade fact.

An available result contains one fixed chart position for every natural UTC
interval that intersects the exact requested interval. A position is
`complete` only when its whole represented half-open interval is inside
continuous admitted trade-history coverage and both represented bounds are
source-minute boundaries. It is `unavailable` only when that represented
interval has no overlap with admitted coverage. Every other position is
`partial`. A position without an aggregate establishes no admitted qualifying
`Swap` only when its coverage is `complete`; an empty `partial` or
`unavailable` position does not establish trade absence. An aggregate and its
price, Stock Token volume, USDG volume, trade count, observed bounds, and source
bounds all derive from the same admitted one-minute candle set. Source
one-minute candles do not leave the trade-history data owner as a second public
result.

### Internal Archive Source

The internal archive source consumes provider revision
[`db2a56433a39701307353375217998373b50e02d`](https://github.com/stelis-dev/robinhood-stock-token-index/tree/db2a56433a39701307353375217998373b50e02d).
It selects the greatest uploaded root and binds every selected state, month and
resolution member to its physical membership, exact Range and content digests.
Those three roles and their coverage remain distinct. Stored candles and their
PoolId provenance pass through unchanged; an older root, packed-asset fallback,
base-day member, `1m` reconstruction or cross-Pool join is never substituted.
Provider transport facts do not enter the result.

## Identity And Trust

- Asset identity is defined only in `docs/NUMERIC_POLICY.md#token-identity-and-decimals`.
- Third-party token lists cannot establish a canonical Robinhood Chain asset.
- SDK constants do not override official deployment records or observed code.
- Protocol SDK output is an untrusted proposal until the owning product boundary
  independently validates it.
- A stable WalletConnect observation brackets public SDK proposal and session
  reads with one unchanged healthy opaque-storage revision. It establishes only
  those locally observed proposals and the session namespaces, accounts,
  methods, events, and expiry described by the
  [official WalletConnect session model](https://docs.walletconnect.network/wallet-sdk/web/usage).
  It does not establish address ownership, present connectivity, approval of a
  Little John wallet request, or absence when either storage bracket is
  unavailable or changes.
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
contract is direct. A supported one-hop result becomes resolved only after the
observed first-hop implementation's runtime code and EIP-1967 storage show no
supported, conflicting, malformed, or administrator-only proxy marker state at
the same canonical block. The analysis does not follow a second marker. An
unresolved terminality result retains the observed first-hop method, address,
runtime-code identity, administrator observation, and exact terminality
category, but none of those facts admits an effective implementation or an ABI
for control analysis. Any unresolved implementation prevents ABI-dependent
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
