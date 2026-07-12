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
path credentials, query credentials, or fragments uses a secret-safe endpoint
identity containing:

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
  a Littlejohn wallet request.
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
