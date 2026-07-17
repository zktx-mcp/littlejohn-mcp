# Product Policy

This document is the sole authority for Little John's product identity, scope,
philosophy, responsibilities, support-level meanings, capability-availability
meanings, and public current-support presentation. Required behavior in this
document does not claim implementation.

The runtime support manifest is the sole machine authority for implemented
support values. `Current Support` is its deterministic public projection.

## Product Name

- The human-facing product name is `Little John`.
- Human-readable UI, wallet metadata, errors, evidence labels, and prose use
  the exact human-facing name.
- The technical identifier stem is `littlejohn`. Package and server IDs, the
  executable, environment variables, URNs, HTTP headers, cookies, files,
  directories, cryptographic domain labels, and code identifiers keep the stem
  unspaced and apply the casing and delimiters required by their technical role.
- A technical identifier is never presented as an alternate product name.

## Product Scope

- Little John is a local Robinhood Chain MCP and transaction review application.
- Chain scope is Robinhood Chain only.
- The current wallet transport contract is WalletConnect.
- Users access one local runtime through MCP text interaction, a host-controlled
  local web interface, or an interactive CLI.
- Repository and public-dataset ownership are defined in
  `docs/ARCHITECTURE.md#repository-ownership`.

## Product Philosophy

- User-specific data and review material stay on the user's device.
- Only the user authorizes a wallet request and signature.
- Conclusions expose their source, freshness, and coverage under
  `docs/EVIDENCE_POLICY.md`.
- External proposals and SDK output require independent verification and are
  not trusted by default.
- The wallet receives the exact request the user reviewed.
- Transaction-critical choices are never selected silently.
- Unknown, stale, incomplete, and conflicting evidence
  remains visible.
- Unresolved identity, meaning, or authorization cannot become an
  executable request.
- Simulation, official identity, and reputation signals are
  scoped evidence, not guarantees.
- Claimed execution results are checked against chain
  state and the reviewed request.

## Product Responsibilities

Little John is responsible for:

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

<!-- Generated from the runtime support manifest. Do not edit this section. -->

- Runtime support manifest: implemented as the sole machine authority for the
  values in this section.
- Robinhood Chain: `L0 discovered`. The official network configuration identifies
  Robinhood Chain mainnet with chain ID `4663` in the
  [Robinhood Chain documentation](https://docs.robinhood.com/chain/connecting/).
  Source owner: Robinhood. Coverage: Published Robinhood Chain network identity and chain ID.
  Unsupported conclusions: Endpoint availability. Runtime availability. Safety.
- Implemented protocol support: none.
- Implemented wallet support: `wallet.cancel_operation` (MCP, CLI, web); `wallet.connect` (MCP, CLI, web); `wallet.connection` (HTTP, MCP, CLI); `wallet.current_operation` (web); `wallet.disconnect` (MCP, CLI, web); `wallet.operation` (MCP, CLI, web).
- Implemented transaction actions: none.
- Available user-facing capabilities: `account.balance`, `chain.status`, `contract.inspect`, `transaction.inspect`, `wallet.cancel_operation`, `wallet.connect`, `wallet.connection`, `wallet.current_operation`, `wallet.disconnect`, `wallet.operation`.
- Experiments and collected research do not establish product support.

## Support Levels

Assign one support level to each exact chain, protocol, and transaction action:

- `L0 discovered`: official existence is confirmed.
- `L1 analyzed`: deployed contracts and transactions can be decoded.
- `L2 reviewed`: a proposal can be decoded, simulated, and checked by policy.
- `L3 executable`: Little John builds and verifies the request and can hand it to
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
