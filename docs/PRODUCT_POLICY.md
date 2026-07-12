# Product Policy

This document is the sole authority for Littlejohn's product identity, scope,
philosophy, responsibilities, support-level meanings, capability-availability
meanings, and public current-support presentation. Required behavior in this
document does not claim implementation.

The runtime support manifest is the sole machine authority for implemented
support values. `Current Support` is its deterministic public projection. Before
that manifest exists, the section states only verified absence of implementation
and repository-held official evidence; it never fabricates runtime availability.

## Product Scope

- The product is Littlejohn, a local Robinhood Chain MCP and transaction review
  application.
- Chain scope is Robinhood Chain only.
- The current wallet transport contract is WalletConnect.
- Users access one local runtime through MCP text interaction, a host-controlled
  local web interface, or an interactive CLI.
- Repository and public-dataset ownership are defined in
  `docs/ARCHITECTURE.md#repository-ownership`.

## Product Philosophy

- Local-first: user-specific data and review material stay on the user's device.
- User-controlled: only the user authorizes a wallet request and signature.
- Evidence-first: conclusions expose their source, freshness, and coverage under
  `docs/EVIDENCE_POLICY.md`.
- Independent verification: external proposals and SDK output are not trusted
  by default.
- Exact review: the wallet receives the same hard-bound request the user saw.
- Explicit choice: transaction-critical choices are never selected silently.
- Explicit uncertainty: unknown, stale, incomplete, and conflicting evidence
  remains visible.
- Fail closed: unresolved identity, meaning, or authorization cannot become an
  executable request.
- No safety theater: simulation, official identity, and reputation signals are
  scoped evidence, not guarantees.
- Receipt accountability: claimed execution results are checked against chain
  state and the reviewed request.

## Product Responsibilities

Littlejohn is responsible for:

- identifying canonical Robinhood Chain assets and protocol deployments;
- inspecting contracts, signatures, calldata, transactions, and receipts;
- showing wallet assets, price evidence, asset changes, and activity;
- building and independently verifying supported transaction requests locally;
- showing transaction meaning, risks, simulation coverage, and expected state
  changes;
- handing the exact reviewed request to WalletConnect after explicit user
  confirmation; and
- re-reading the broadcast transaction and producing a local evidence receipt.

The exact numeric contract is owned by `docs/NUMERIC_POLICY.md`. Transaction
authority and execution requirements are owned by
`docs/TRANSACTION_POLICY.md`.

## Current Support

- Runtime support manifest: unavailable. The values below state verified
  repository state directly and claim no implemented runtime support.
- Robinhood Chain: `L0 discovered`. The official network configuration identifies
  Robinhood Chain mainnet with chain ID `4663` in the
  [Robinhood Chain documentation](https://docs.robinhood.com/chain/connecting/).
  Source owner: Robinhood. Coverage: published network identity and chain ID;
  no endpoint availability, runtime availability, or safety conclusion.
- Implemented protocol support: none.
- Implemented wallet support: none.
- Implemented transaction actions: none.
- Available user-facing capabilities: none.
- Experiments and collected research do not establish product support.

## Support Levels

Assign one support level to each exact chain, protocol, and transaction action:

- `L0 discovered`: official existence is confirmed.
- `L1 analyzed`: deployed contracts and transactions can be decoded.
- `L2 reviewed`: a proposal can be decoded, simulated, and checked by policy.
- `L3 executable`: Littlejohn builds and verifies the request and can hand it to
  the supported wallet transport through an implemented confirmation interface.
- `L4 receipt_verified`: the actual transaction and state changes are verified
  against the reviewed request.

An ecosystem listing establishes at most `L0`. It is not execution support.

Do not claim `L0` without current official evidence for that exact identity.
Do not claim `L1` through `L4` without current code, tests, configuration, and
user-visible behavior for that exact identity. `L3 executable` requires:

- official deployment identity;
- exact address and deployed-code identity;
- exact ABI and decoder;
- local transaction builder;
- expected-state-change producer;
- simulation policy;
- receipt verifier;
- end-to-end verification; and
- verified capability for the supported wallet transport and confirmation
  interface.

## Capability Availability

Assign one availability state to every exact read, wallet, and review capability
and to each of its direct, HTTP, MCP, CLI, and web bindings:

- `unavailable`: no complete implementation is exposed to a user.
- `internal`: a complete internal dependency exists but no supported
  user-visible interface exposes it.
- `available`: current code, configuration, verification, and a user-visible
  interface expose the exact declared behavior and scope exclusions.

Capability availability never implies a higher chain, protocol, or transaction
support level. A support claim records both the applicable support level and the
availability of each capability used to establish it.
