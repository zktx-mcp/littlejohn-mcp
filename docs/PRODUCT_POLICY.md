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
- Users access one local runtime through MCP text and structured results,
  MCP App presentation and direct controls, or an interactive CLI.
- MCP App and CLI are independent user-selected interfaces over the same
  canonical backend. Neither is a fallback for, launcher for, or substitute
  for the other.
- The loopback HTTP owner is a native backend and compatible-process
  transport. It is not a separately navigable user interface.
- Repository ownership is defined in
  `docs/ARCHITECTURE.md#repository-ownership`.

## Product Philosophy

- Product-owned durable state stays on the user's device. MCP sends only the
  exact requested result, Review, operation, or App-private presentation data
  required by that interaction. The admitted MCP Host can observe the values
  it transports, including an active Wallet connection QR displayed by an
  App.
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

## Default Stock Tokens

<!-- Generated from defaultStockTokenManifest. Do not edit this section. -->

Little John attempts to include the following Robinhood Stock Tokens on an
account's first successful asset read. Inclusion occurs only while the exact
UID and contract address remain in the current official asset snapshot and pass
the required onchain verification. An existing account choice is never replaced.

Canonical source: `defaultStockTokenManifest` for `eip155:4663`.

1. UID `0x00000000000000000000000000000000c2425be3658540dd8e2424cbf3c5c649`; contract `0xaf3d76f1834a1d425780943c99ea8a608f8a93f9`.
2. UID `0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5`; contract `0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec`.
3. UID `0x00000000000000000000000000000000cfece3244ea34bb29414dd9488b32d9f`; contract `0x322f0929c4625ed5bad873c95208d54e1c003b2d`.
4. UID `0x0000000000000000000000000000000053b69e2076884cc9ae2ada9bc7095df3`; contract `0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3`.
5. UID `0x000000000000000000000000000000001c6f27a62789417d8ed359ed3c2d3da1`; contract `0x117cc2133c37b721f49de2a7a74833232b3b4c0c`.

## Current Support

<!-- Generated from the runtime support manifest. Do not edit this section. -->

- Runtime support manifest: implemented as the sole machine authority for the
  values in this section.
- Robinhood Chain: `L0 discovered`. The official network configuration identifies
  Robinhood Chain mainnet in the [Robinhood Chain documentation](https://docs.robinhood.com/chain/connecting/).
  Little John's canonical chain ID for that network is `eip155:4663`.
  Source owner: Robinhood. Coverage: Published Robinhood Chain network identity and chain ID.
  Unsupported conclusions: Endpoint availability. Runtime availability. Safety.
- Implemented protocol support: `uniswap_v2` (L0 discovered).
  Official identity source: [Uniswap](https://github.com/Uniswap/contracts/blob/f56eb0c6016361101d103ffd2754498c9893d107/deployments/4663.md) (`official_document`). Revision: `f56eb0c6016361101d103ffd2754498c9893d107`.
  Coverage: `robinhood_chain_uniswap_v2_factory_and_pair_init_code_hash_at_source_revision`.
  Supported conclusions: `factory_address_at_source_revision`, `pair_init_code_hash_at_source_revision`.
  Unsupported conclusions: `current_runtime_code`, `current_protocol_availability`, `pair_identity_or_liquidity`, `quote_or_execution_result`, `safety`.
  Exclusions: `all_other_deployments`, `runtime_code_and_state`, `pair_existence_and_liquidity`, `quote_and_execution_quality`, `safety`.
- Implemented wallet support: `wallet.cancel_operation` (MCP, CLI); `wallet.connect` (MCP, CLI); `wallet.connection` (HTTP, MCP, CLI); `wallet.connection_change_review` (MCP); `wallet.disconnect` (MCP, CLI); `wallet.operation` (MCP, CLI).
- Implemented transaction actions: none.
- Implemented MCP App presentation contracts: `account.assets@1`, `contract.inspect@1`, `market.reference_history@1`, `market.reference_price@1`, `market.stock_token_market@1`, `market.watchlist@1`, `market.watchlist_change_review@1`, `market.watchlist_operation@1`, `token.inspect@1`, `token.operation@1`, `token.selection@1`, `token.selection_change_review@1`, `token.selections@1`, `wallet.connection@1`, `wallet.connection_change_review@1`, `wallet.operation@1`.
- Available user-facing capabilities: `account.assets`, `account.balance`, `chain.status`, `contract.inspect`, `market.add_watchlist_pair`, `market.reference_history`, `market.reference_price`, `market.remove_watchlist_pair`, `market.reorder_watchlist_pairs`, `market.stock_token_market`, `market.watchlist`, `market.watchlist_change_review`, `market.watchlist_operation`, `token.add_selection`, `token.inspect`, `token.operation`, `token.remove_selection`, `token.selection`, `token.selection_change_review`, `token.selections`, `transaction.inspect`, `uniswap_v2.quote_exact_input`, `wallet.cancel_operation`, `wallet.connect`, `wallet.connection`, `wallet.connection_change_review`, `wallet.disconnect`, `wallet.operation`.
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
and to each of its direct, HTTP, MCP, and CLI bindings:

- `unavailable`: no complete implementation is exposed to a user.
- `internal`: a complete internal dependency exists but no supported
  user-visible interface exposes it.
- `available`: current code, configuration, verification, and a user-visible
  interface expose the exact declared behavior and scope exclusions.

Capability availability never implies a higher chain, protocol, or transaction
support level. A support claim records both the applicable support level and the
availability of each capability used to establish it.

MCP App presentation is not another capability-availability axis. Canonical
MCP read availability remains the same whether a particular connection can
display an App. App presentation and App-only controls are admitted for that
connection from the MCP Apps protocol capabilities and the exact registered
tool catalog. A connection without the required App transport keeps its
ordinary MCP text and structured results and receives no App or App-only
authority. CLI availability is evaluated independently.

`Current Support` continues to project the bindings implemented by the current
runtime. Its schema and values change only when the corresponding interface
implementation changes.
