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

This section defines required evidence and does not claim that Stock Token
classification is currently implemented.

Current Robinhood Stock Token membership is owned by the complete successful
response from Robinhood's public asset endpoint,
`https://api.robinhood.com/rhj/assets`, which supplies the Stock Token table on
the [official Token Contracts page](https://docs.robinhood.com/chain/contracts/).
Only an entry with status `ASSET_STATUS_ACTIVE` and exactly one deployment for
Robinhood Chain ID 4663 enters the current member set. A malformed, partial,
oversized, or failed response establishes neither membership nor absence. A
stored observation becomes stale whenever a required refresh fails.

Before Little John adds an API member to an account or publishes that member as
a verified account asset, the exact UID and token address require an independent
pinned Robinhood Chain read against the StockFactory proxy
`0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046`. The read verifies the proxy runtime
code, its implementation stored in EIP-1967 slot
`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`, the
implementation runtime code, `tokenAddress(uid)`, and nonempty runtime code at
the returned token address at one canonical block. The accepted implementation
identity is
`0xEe351E53BCe6AAF106428358838197C91e36EE0E`; the proxy runtime-code Keccak-256 is
`0x394c3517e9331e7c88ef8af388c0cb63c720af1b1b4d5a5cace212f7df0b045a`, and the
implementation runtime-code Keccak-256 is
`0x3bfd5841605b9931c9dbb0f9f54a28b4038918ceb74d6d1081bc7f963fe528b4`.
These identities were observed on 2026-07-20 at block 14660943, hash
`0x94d90a8691fc4fc7a4fb48a86755f948f2a1110325d6c8257dbfeaddaf8832b0`.
The verified [proxy](https://robinhoodchain.blockscout.com/address/0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046)
and [implementation](https://robinhoodchain.blockscout.com/address/0xEe351E53BCe6AAF106428358838197C91e36EE0E)
sources establish the lookup interface and proxy structure; the pinned chain
read establishes the accepted deployed bytes. A mismatch makes that exact
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

## Public Claims

- Public documentation cites source-owner official pages only.
- A source citation never expands the source's actual coverage.
- Do not claim safest, guaranteed, rug-free, scam-free, or investment-suitable
  behavior from evidence signals.
- Do not create a universal safety or rug score.
- A Stock Token is not described as ownership of its legal underlying share.

## Data Boundary

Repository and dataset ownership are defined only in
`docs/ARCHITECTURE.md#repository-ownership`. Evidence records never weaken that
privacy boundary. Live quotes, wallet-specific data, review material, and
signable transaction material are not public dataset content.
