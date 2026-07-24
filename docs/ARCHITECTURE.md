# Architecture

## Current State

Little John has a Node.js `>=22.12.0` ESM TypeScript package, canonical core
contracts, six semantic read-capability definitions, registry-derived JSON
Schema and descriptor projections, owner-only POSIX
application-data permissions, SQLite product state, local control credentials,
source identifiers that do not expose credentials, a runtime support manifest,
and one authenticated fixed-port HTTP owner with compatible peer deferral and
demand-driven takeover.
The owner identity resource is `GET /api/v1/runtime-identity`; authenticated
process control is confined to `/api/v1/internal/control/*`. SQLite row adapters
alias SQL snake-case names to lower-camel TypeScript fields. Immutable
request-policy, resource-path, route, support-manifest, and interface-mapping
registries accept only complete declared extensions. Route responses are
either canonical JSON or bounded browser text with fixed CSP, content-type,
opener, referrer, and no-store headers; no route can supply arbitrary response
headers. Canonical JSON rejects ill-formed Unicode in both string values and
object keys before UTF-8 encoding.

Runtime creation returns a cleanup-capable handle after opening SQLite and
before constructing or starting the fixed-port owner. The implemented owner,
application composition, and CLI shutdown behavior follows
[`Runtime Lifecycle`](#runtime-lifecycle).

The `littlejohn` package binary composes the wallet and chain modules into the
fixed-port owner. The owner opens one WalletConnect Sign Client on the
owner-only SDK private store, reconciles SDK sessions into the SQLite
wallet-connection projection, and serves authenticated internal wallet
connection and operation resources. One coordinator enforces the single-session
and serialized wallet operation contracts defined below.

The owner also opens one bounded RPC reader for the configured Robinhood Chain
endpoint. `chain.status`, `contract.inspect`, `transaction.inspect`, and
`account.balance` are complete internal direct capabilities. Every contiguous
chain-dependent phase enters one chain lifecycle that owns caller abort,
application close, one 90-second whole-invocation deadline, listener cleanup,
and drain. A nested binding may join only the exact active invocation signal;
it does not create another deadline or active-call record. Configured-chain
validation and selector-based canonical-block resolution are separate
single-owner procedures used only by capabilities that need them. Resolution
issues an opaque block object whose private state binds the active invocation,
configured-chain proof, public anchor, and exact state reference. Dependent
state readers require that exact object and context; a plain anchor, clone,
foreign block, or settled context fails before RPC. Every applicable invocation
checks canonical chain ID `eip155:4663`; pins dependent state reads to one
observed canonical block hash using
[EIP-1898](https://eips.ethereum.org/EIPS/eip-1898); preserves
integers as base-10 strings; validates transaction, receipt, log, and block
identity; preserves the signed access-list sequence and multiplicity; and
records source-scoped evidence. The chain boundary uses viem for EVM Keccak and
ERC-20 ABI encoding and decoding, then applies exact word, topic, padding,
length, and range checks. Core independently verifies code hashes with
`@noble/hashes` and reconstructs claimed ERC-20 event words instead of reusing
the chain decoder. Explicit account reads do not consume wallet state. Only
`account.balance` with `active_wallet` captures the current validated
WalletConnect account.

The browser-safe core token-metadata contract owns display-text admission,
optional metadata outcomes, and their limits. One chain token-metadata process
reads ERC-20 `name`, `symbol`, and `decimals` at one supplied EIP-1898 block
reference for both token inspection and account assets. The standardized
`eth_call` execution-reverted response makes an optional method unavailable;
malformed, mismatched, transport, and source failures retain their own failure
meaning. The internal `token-catalog` module owns canonical token inspection,
account-specific token selection, operation, error, and downstream port
contracts. Its chain adapter composes the shared metadata process with deployed
code and ERC-20 `totalSupply`. A fatal inspection call aborts and drains its
sibling calls before the inspection returns or the owner closes.
The catalog runtime persists an inspection only when a confirmed addition
commits. The query application receives only exact-selection and bounded-list
storage methods. Exact get returns the selection and any historical inspection;
list returns selection rows without duplicating inspection evidence. One
owner-memory coordinator alone receives the mutation store, serializes additions
and removals, binds confirmation to the captured live wallet session and
connection revision through the canonical confirmation contract, and commits
each change through one SQLite transaction. The interface layer exposes token
inspection and the account-specific selection set through their declared HTTP,
MCP, and CLI bindings. The web surface starts and reviews changes through
operation resources and consumes account-assets for display. The browser-safe
registry official-asset contract owns the validated official source and
StockFactory admission manifests, source evidence schemas, fixed verification
identity, and failure language. Official Stock Token classification is
established only by a complete admitted registry source observation and
same-block StockFactory verification; no surface establishes safety, price,
valuation, or transaction support.

The `market-portfolio` module owns one closed reference-market application for
the fixed ETH/USD and USDG/USD Chainlink feeds and the derived ETH/USDG pair.
Each current result uses one canonical Robinhood Chain block. Direct prices bind
one validated round; the cross binds fresh rounds from both feeds at that same
block. Bounded history synchronization stores validated round evidence and
builds exact observed-point UTC candles without trade volume. History results
are always non-exhaustive: a result with candles is `partial`, and one without
candles is `unavailable`. One account-scoped watchlist stores only pairs
admitted by the fixed manifest and uses revisioned local mutations. Feed
synchronization and watchlist mutation have separate state and failure
boundaries.

The interactive CLI implements `wallet status`, `wallet connect`, `wallet
disconnect`, `wallet operation`, and `wallet cancel`, plus
`read assets`, `read chain-status`, `read contract`, `read transaction`,
`read balance`, the seven declared `token` commands, and `market price`,
`market history`, `market watchlist`, `market add-pair`, `market remove-pair`,
and `market reorder-pairs` under
[`CLI Surface`](#cli-surface). Read
commands expose the canonical result as human-readable text or exact JSON
without recomputing domain meaning. Token addition and removal
commands require an interactive terminal and one exact confirmation response.
Exact operation cancellation is confirmation-independent and remains available
to non-interactive callers.
`littlejohn --help` projects the same command identities consumed by the CLI
parsers and does not start the runtime.

Public loopback resources expose the eight chain, token, and reference-market
reads, the wallet
connection projection, and the registry-derived capability catalog. A
no-argument `littlejohn` process runs one stdio MCP connection while sharing or
taking over the same fixed-port owner. Its twenty-four convention-validated
tools expose the account-asset collection, four chain reads, the capability
catalog, five wallet-management bindings, seven token-catalog bindings, and six
reference-market bindings. MCP
start-operation tools return
the applicable fixed local page URL. Exact operation-read and cancellation
tools return the canonical operation without a display URL. No MCP tool
confirms an operation or receives QR, pairing, topic, browser request cookie,
CSRF token, local control credential, signing, or transaction material.

The fixed-origin React surface serves one application at `/`; `/tokens` is not
a page. The product identity remains at the left of the navigation bar and the
wallet control remains at the right. A disconnected account sees the product
description and connection action. A connected account sees one fresh bounded
asset page with native balance, included-token balances, refresh, pagination,
and contextual add and removal actions. The same root includes reference-market
starter or saved cards, one selected exact-price history chart, and the current
account's supported-pair watchlist controls. One modal host derives priority across
wallet operations, token operations, and the add form. A CLI-created catalog
operation is read-only in the browser. The modal acts only after a direct user
action, renders canonical states without inventing a second lifecycle, and
replaces a first terminal observation with one transient non-modal
notification.

The root bootstrap issues an `HttpOnly`, `SameSite=Strict` browser-session
cookie scoped to `/api/v1` and an independent CSRF token.
Neither credential contains an operation identifier or enters a URL. Neither
credential enters browser local storage or session storage; the browser request
credential is held only by the `HttpOnly` cookie store. Host, Origin,
credential, CSRF, operation identity, connection
revision or review digest, and expiry checks precede browser control. The
browser uses the declared wallet resources under `/api/v1/wallet` and catalog
resources under `/api/v1/token-catalog`. Reference-market price, history, and
watchlist queries are public reads. Browser watchlist changes use browser
credentials and CSRF; compatible-process watchlist changes use local-control
authentication. Both mutation paths send once and report an unproved response
as `delivery_unknown` without retrying. Public reads and compatible-process
control resources reject the browser credential instead of treating its wider
cookie path as authority. The wallet-operation resources are:

- `POST /api/v1/wallet/operations`;
- `GET /api/v1/wallet/current-operation`;
- `GET /api/v1/wallet/operations/{operationId}`;
- `POST /api/v1/wallet/operations/{operationId}/confirmation`; and
- `POST /api/v1/wallet/operations/{operationId}/cancellation`.

The catalog browser resources are inspection, operation creation,
current-operation and exact operation reads, and exact confirmation and
cancellation action resources. Selection and balance reads belong to
account-assets; the browser does not retain parallel catalog query resources. These resources
do not expose a second contract, error map, or operation state machine.

There is no human wallet-path namespace, separate QR resource, or browser
`DELETE` cancellation route. The compiled content-hashed
assets contain no inline executable or style content. The browser build accepts
only its closed first-party contract set and pinned browser runtime packages;
its first-party source uses a closed set of browser globals and intrinsic
elements. The fixed CSP remains the runtime boundary for dynamic code
execution, connections, resources, frames, and forms. A monotonic request
authority prevents an older poll or duplicate control action from replacing a
newer wallet dialog view.

The wallet, token-catalog, account-assets, and market-portfolio modules own their canonical application contracts,
including each identifier, version, input schema, success schema, failure-code
set, and state meaning. One canonical interface-binding catalog maps those
contracts to MCP, loopback HTTP, CLI, and web bindings. Transport adapters and
the runtime support manifest derive from these sources rather than maintaining
parallel tool, schema, route, or availability lists. The interface layer
projects the completed wallet, chain, token-catalog, account-assets, and reference-market ports
into HTTP, MCP, CLI, and the React application.
Read-result consumers revalidate the normalized request, result chain scope,
and evidence-anchor chain scope through the same definition-owned checks used
by the local producer. Observation-claim binding remains producer-only because
those claims do not cross the transport boundary.
The semantic-read result owner accepts a complete canonical success only when
its UTF-8 JSON representation is at most 8,388,607 bytes. Every generated read
projection exposes that aggregate limit and the `result_too_large` failure. The
HTTP public-read body limit is the canonical result limit plus its one-byte line
framing; transports do not reclassify an oversized semantic result.
The runtime support manifest remains the machine authority for binding
availability, and its public projection is
`docs/PRODUCT_POLICY.md#current-support`. No signature request, transaction
construction, broadcast, receipt verification, or protocol adapter is
implemented.

This document is the sole authority for repository ownership, module
dependencies, local processes, persistence, browser and CLI surfaces,
WalletConnect session ownership, local credentials, and the loopback HTTP
boundary. Sections after Current State define required architecture and do not
claim that it is implemented. Product availability is owned by
`docs/PRODUCT_POLICY.md#current-support`. Transaction and wallet-request
authority are owned by `docs/TRANSACTION_POLICY.md`.

## Runtime Shape

The complete product runtime is a modular monolith with MCP over stdio, local
HTTP and React over loopback, an interactive CLI, local SQLite product state,
and the WalletConnect session boundary defined here. An absent surface remains
unavailable and is not replaced by a different process, store, transport, or
authority model.

## Repository Ownership

This repository owns:

- local runtime and configuration;
- MCP tools and resources;
- loopback HTTP API and React pages;
- local SQLite state;
- live chain reads;
- asset and deployment registries;
- contract, calldata, transaction, and receipt analysis;
- simulation and policy;
- the fixed reference-feed manifest, exact reference prices and candles, and
  account-scoped reference-pair watchlists;
- protocol adapters;
- WalletConnect handoff; and
- receipt verification.

## Release Publication

A published GitHub Release is the only package-publication trigger. Its tag is
the package version with an optional `v` prefix. The workflow runs
`release:check`, publishes that exact verified tarball to the public npm
registry, and verifies its recorded integrity and distribution tag. Before a
stable npm commit it uses the fixed official MCP publisher to validate
`server.json`; after the npm commit is visible it registers and verifies the
same stable version in the official MCP Registry. Prereleases use npm tag
`next` and do not enter the MCP Registry.

The first npm publication requires the repository secret `NPM_TOKEN` to contain
a granular npm token authorized to publish `littlejohn-mcp`. After that package
exists, the maintainer configures npm Trusted Publisher for
`.github/workflows/publish.yml` and removes `NPM_TOKEN`; the unchanged workflow
then uses GitHub OIDC. The token is available only to the npm publication step
and is removed from the MCP publisher process environment. Publishing a GitHub
Release remains the maintainer's assertion that the release is ready; automated
package verification does not replace manual host and wallet gates.

## Logical Modules

| Module | Responsibility |
| --- | --- |
| `core` | Schemas, exact numeric types, evidence, commitments, and errors |
| `chain` | RPC, pinned reads, simulation, broadcast, and receipt ports |
| `data` | Dataset schema and release verification |
| `registry` | Official-asset source admission, StockFactory identity, and ordered default Stock Tokens |
| `intelligence` | ABI, source, contract, calldata, signature, and transaction analysis |
| `security` | Deterministic policy, simulation coverage, warnings, blocks, and state deltas |
| `market-portfolio` | Fixed-feed reference prices, bounded exact candles, and account-scoped pair watchlists |
| `protocols` | Protocol package contract and protocol-specific capabilities and action adapters |
| `review` | Intent, account binding, commitments, freshness, and review state |
| `wallet` | WalletConnect sessions and exact reviewed-request handoff |
| `token-catalog` | Token inspection and account-specific selection contracts |
| `account-assets` | Stable connected-account selection, classification, standard, and balance reads |
| `receipt-activity` | Transactions, receipts, traces, finality, and actual state deltas |
| `interfaces` | MCP, loopback HTTP API, React read models, and interactive CLI |
| `runtime` | Composition root, SQLite, configuration, HTTP ownership, and feature gates |

## Dependency Rules

- `core` imports no provider, protocol SDK, wallet SDK, React, HTTP, or SQLite
  implementation.
- Server modules consume the curated `core/index` entry point. Browser-safe
  error definitions, the shared wallet operation contract, and the React web
  surface consume the curated browser-safe `core/browser` entry point. No other
  module imports a core leaf directly.
- Concrete SDK, database, HTTP, and adapter implementations enter through
  `runtime` composition.
- Feature modules import runtime application contexts and transport contracts
  from their exact leaf owners. They do not import the runtime entry point or
  composition implementation. The top-level CLI alone enters the composed
  runtime through `runtime/index`.
- `package-lock.json` fixes repository clean installs only. It is not packaged,
  does not define consumer dependency resolution, and does not participate in
  process compatibility.
- React consumes server-created read models and never calls chain RPC, quote
  providers, protocol SDKs, or protocol adapters directly.
- React and CLI never initialize WalletConnect or own WalletConnect sessions.
- MCP never calls concrete protocol adapters directly.
- Protocol adapters never call WalletConnect.
- Only `wallet` owns WalletConnect sessions and secrets.
- Only `review` creates executable review states.
- Short-lived wallet request material remains separate from durable evidence
  and receipts.
- Cached and collected data never replaces execution-time chain verification.

## Interface Contract Model

- Canonical semantic contract ownership and projection follow
  `../AGENTS.md#interface-contract-policy`. This section owns only Little John's
  runtime binding, registry, transport, path, and correlation architecture.
- MCP uses the protocol's
  [JSON-RPC tool surface](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
  through the official SDK. Little John does not define a second agent JSON-RPC
  protocol or duplicate MCP tool catalog.
- The browser is not an MCP client. It uses same-origin HTTP resources that
  consume the same canonical contracts while retaining browser-specific Host,
  Origin, cookie, CSRF, content, and presentation boundaries.
- Compatible-process control resources are private owner IPC consumed by MCP and
  CLI adapters. They are not agent-facing URLs and do not redefine the MCP
  contract.
- One canonical binding catalog maps each canonical contract to its declared
  MCP, HTTP, CLI, and web bindings and availability. Role-specific registries
  own their exact names, paths, security classes, parsing, and presentation
  contracts while consuming that catalog. Tool-name sets, route coverage, CLI
  help, and support projections derive from the catalog and their owning
  registries rather than parallel lists.
- Page paths are owned separately from browser API and compatible-process
  control paths. A page path identifies human navigation; an API path identifies
  a backend resource; an MCP tool name identifies an agent operation.
- Each invocation may carry a transient local request identifier for diagnostic
  correlation. An asynchronous operation uses its canonical operation identifier
  for lifecycle tracking. Neither identifier grants user, wallet, or transaction
  authority.

## Local Process Model

- Codex and Claude may each start a local Little John stdio MCP process through
  `npx`.
- Every process uses the same local SQLite database and the fixed origin
  `http://127.0.0.1:46630`.
- Exactly one compatible process owns the HTTP listener.
- A later compatible process verifies the current owner and defers HTTP
  ownership while continuing its stdio MCP connection.
- A compatible deferred process acquires port `46630` only through the
  demand-driven fixed-bind race after an owner operation fails.
- No process selects, increments, or falls back to another port.
- A foreign or incompatible port owner causes a clear startup failure and is
  never stopped or replaced.

## Runtime Lifecycle

- Fixed-owner application initialization, composed application stages, and
  WalletConnect acquisition register each acquired long-lived resource with its
  current lifecycle owner before the next fallible initialization step.
- Replacing a registered resource requires and verifies the exact current
  resource, then changes the owned resource atomically. The replacement assumes
  the same remaining cleanup obligation. The previous owner transfers its
  registration only after the receiving owner has accepted the replacement.
- One scope owns each exact resource identity at most once. Reading a resource's
  cleanup operation cannot reenter or alter registration, replacement,
  transfer, or sealing.
- A producer seals its ownership scope after its lifecycle work finishes. A
  sealed scope rejects registration, replacement, and transfer; only cleanup
  and cleanup retry remain available.
- Concurrent cleanup shares one completion. A successful close removes only
  the exact resource proven closed; a failed close keeps that resource for the
  next attempt.
- Resources close in reverse acquisition order. Closing stops at the first
  failure so an earlier dependency remains open while its dependent consumer is
  unresolved. A replacement made during active cleanup remains owned for the
  next attempt.
- A resource cleanup operation does not await cleanup of the scope that owns
  that operation. Concurrent cleanup requested outside the owned operation
  shares the scope's existing completion.
- Each application stage owns a separate acquisition scope. A failed partial
  stage closes before completed earlier stages; a successful stage retains only
  its returned application before its scope is sealed.
- A stage failure followed by a cleanup failure preserves both errors in that
  order. Cleanup failure never replaces or hides the startup failure.
- The token-catalog application factory owns its official-asset synchronization,
  coordinator, application adapter, consumer ports, support extension, admission
  state, and retryable close/drain lifecycle. It closes the coordinator before
  the synchronization. The factory registers that complete lifecycle with the
  supplied application-stage owner before adopting either resource. Runtime
  composition supplies the stage owner and complete dependencies, consumes the
  complete application, and does not construct token-catalog internals.
- Fixed-owner shutdown blocks new work, aborts and drains active work, closes
  interface, reference-market, account-assets, token-catalog, chain, and wallet
  applications in
  that order, validates the
  WalletConnect private store, closes SQLite, releases the database lease, and
  then releases the fixed HTTP listener.
- The listener release requires the exact permit bound to the sealed and empty
  startup scope after application cleanup completes. Another permit or scope
  cannot share or trigger that release.
- A shutdown failure keeps the owner in `stopping` and preserves the fixed port
  and every unresolved dependency. A later graceful attempt uses the same
  retained resources and never reconstructs them from projections.
- A direct CLI process that cannot complete graceful shutdown reports the safe
  normalized failure and terminates. Operating-system process teardown is the
  final resource boundary; it is not a wallet disconnect and does not revoke an
  approved session.

## HTTP Owner Authentication

The operating-system port binding is the sole live-listener authority. SQLite
owner state is a revisioned projection and never authorizes takeover by itself.
The current operating-system user is the local trust boundary. Local credentials
separate that user from other users and unrelated listeners; they do not claim
to contain a malicious process already running with the same user authority.

- The local control credential contains 256 random bits, is encoded as
  unpadded base64url, and remains stable across compatible owner takeover.
- The runtime protocol version is `8`. It identifies the compatible local-owner
  wire contract; an incompatible change replaces this value. Profile ID and
  owner instance ID each
  contain 128 random bits encoded as unpadded base64url. Owner revision is an
  unsigned base-10 integer string.
- A process first attempts to bind `127.0.0.1:46630`.
- Runtime configuration contains one canonical chain identity, the exact RPC
  URI bytes, and the WalletConnect project ID. Each process derives a keyed
  HMAC-SHA-256 configuration identifier from those values and the local control
  credential. The identifier reveals none of its inputs.
- The configuration key is the 32-byte HKDF-SHA-256 output derived from the
  decoded control credential with an empty salt and exact UTF-8 information
  `littlejohn/runtime-configuration/v2`. The HMAC payload contains the
  canonical chain ID, exact RPC URI bytes, and WalletConnect project ID in that
  order, each preceded by its unsigned 32-bit big-endian byte length. The
  result is canonical unpadded base64url for 32 bytes.
- After a successful bind, the process transactionally publishes its profile
  ID, owner instance ID, runtime protocol version, configuration identifier,
  process ID, and owner revision to SQLite. It then inserts its trusted
  configured chain before application construction and before entering the
  owner phase. A chain-insertion failure closes the listener; the published row
  remains a projection and never proves liveness.
- On `EADDRINUSE`, a peer sends a fresh 256-bit base64url challenge in the
  `Littlejohn-Identity-Challenge` header of
  `GET /api/v1/runtime-identity`.
- The owner returns the strict fields `profileId`, `ownerInstanceId`,
  `runtimeProtocolVersion`, `configurationMac`, echoed `challenge`,
  `ownerRevision`, and `proof`. The proof is HMAC-SHA-256 over the
  length-prefixed UTF-8 encoding of those preceding fields in that order using
  the local control credential. Each length prefix is the unsigned 32-bit
  big-endian byte length of the following UTF-8 field.
- The peer verifies the challenge, proof, profile ID, protocol version, and
  configuration identifier before deferring ownership or sending any
  authenticated control request. A process with a different exact RPC URI,
  WalletConnect project ID, or chain configuration is incompatible and never
  shares the active fixed-port server.
- A credential-bearing owner operation is assigned only to the exact socket
  that completed identity verification. A replacement socket receives no
  credential until it completes a new identity verification.
- Connection, identity verification, and exact-socket request dispatch have a
  finite transport deadline. An authenticated owner session reports whether a
  request was not sent, received one complete response, or lost its response
  after sending began. Response observation has a separate five-minute bound.
- The local operation client allocates a 256-bit operation identifier before a
  start, sends each start, cancellation, or confirmation once, and validates
  the response through the binding catalog. Callers supply an opaque catalog
  identity and operation input; the catalog alone owns the method, path, body,
  parser, error mapping, recovery, and outcome rules. After an uncertain send,
  it may read that exact operation once only while the authenticated profile,
  owner instance, protocol version, configuration identifier, and owner
  revision are unchanged. An unproved outcome is `delivery_unknown` and forbids
  resend.
- After dispatch, the owning route and runtime lifecycle own operation
  completion and cancellation. Closing the client rejects new calls, aborts
  cancellable transport work, and waits for admitted calls to settle.
- A missing, malformed, invalid, foreign-profile, or incompatible identity
  response is a port conflict. The peer never sends its credential to that
  listener.
- After owner loss, deferred processes race only by binding the fixed port. The
  single successful binder becomes owner and publishes the next owner revision.
  Other processes authenticate and defer to that owner.
- Owner takeover is demand-driven. A deferred process attempts the fixed bind
  only when an operation needs the owner and a fresh authenticated identity or
  request to the recorded owner fails. It does not poll, use a lease, infer
  liveness from SQLite, or maintain a second coordinator. The successful owner
  reconciles authoritative stores before serving the triggering operation.
- Identity responses, challenges, and proofs contain no local control
  credential, WalletConnect secret, or transaction authority.
- The identity route validates Host `127.0.0.1:46630`, accepts no Origin or
  authorization credential, performs no durable mutation, and returns
  `Cache-Control: no-store`.

## State Ownership

- Shared product state lives in local SQLite.
- Browser cookies, local storage, and session storage are host-local UI state.
- Browser storage never contains wallet secrets, signing material, transaction
  authority, or the authoritative cross-host state.
- The root browser tab retains only the validated identifier of the operation it
  is observing in session storage. This non-authorizing cursor survives browser
  credential reload, selects the exact retained operation resource, and is
  removed when terminal observation or canonical retention expiry completes.
- Store and wallet-coordinator transitions own lifecycle rules. MCP, HTTP,
  React, and CLI map those transitions and do not reimplement them.
- One wallet coordinator owns the WalletConnect Sign Client, relay connection,
  session lifecycle, wallet-management-operation lifecycle, and request
  lifecycle.
- Its active-wallet read port captures connection state, account, chain,
  durable connection revision, stable session-source identity, and live
  evidence authority in one immutable observation. Consumers do not combine
  that observation with a later SQLite projection read or compare recreated
  source objects by reference.
- One operation-entry procedure converges expired operations before every
  public read or control action. A separate exact-session-revocation procedure
  deactivates affected evidence, disconnects the exact topic, and proves that
  topic absent from the SDK store before evidence can reactivate.
- A local Little John profile has zero or one live WalletConnect session and zero
  or one nonterminal wallet management operation. A pending pairing proposal is
  operation state and is not a WalletConnect session.
- MCP, web, and CLI send commands to the coordinator and consume its connection
  and operation read models. They never copy session topics, keys, or signing
  authority into interface state.
- The WalletConnect SDK's private storage is authoritative for pairings,
  sessions, topics, namespaces, expiry, and session key material.
- A connected wallet projection contains one canonical EIP-155 chain identity
  and one canonical lowercase EVM address. The coordinator derives their
  CAIP-10 account reference only at WalletConnect protocol and internal session
  continuity boundaries under the
  [CAIP-10 account identifier specification](https://standards.chainagnostic.org/CAIPs/caip-10).
  A persistent wallet-account row is local account identity only; it never
  proves a live session, address control, or wallet authority.
- The process that owns the fixed local HTTP origin owns the wallet coordinator.
- The owner keeps the coordinator and relay connection active while it serves
  wallet operations.
- Other local MCP processes access the owner through authenticated loopback
  requests and never create competing WalletConnect clients for shared state.
- Owner failover never resends an outstanding WalletConnect request
  automatically.
- Owner shutdown does not revoke an approved wallet session. A replacement
  owner restores the SDK session, revalidates its namespace and expiry, and
  publishes the resulting connection state before accepting wallet operations.
  A nonterminal wallet management operation is not restored or resumed.

## Local Persistence Boundary

Required runtime persistence uses two stores with different authority:

1. The product SQLite database stores shared Little John state.
2. The WalletConnect SDK private store contains WalletConnect protocol state
   and secrets.

The SQLite main database and WAL are the durable product-state authority. The
SQLite shared-memory file is owner-only transient coordination state. SQLite
may create or reconstruct it from the WAL after a crash; Little John never uses
its presence or bytes as product-state evidence.

Fresh-database publication staging is never product state or a recovery input.
The runtime leases the final database and reads its required current rows before
removing exact owner-only staging artifacts. An unsafe artifact in the reserved
staging namespace fails startup without changing the final database. Concurrent
creators converge on the final database rather than choosing or repairing a
staging database.

SQLite has one current schema definition. The SQLite schema module owns
`databaseSchemaVersion`, currently `7`, and standard SQLite `user_version`
equals that value. The exact current table set must also be present. A mismatch
fails closed and never invokes a migration, old-schema reader, conversion,
repair, or automatic replacement. A development schema change requires deleting
the isolated local data directory before starting the current runtime. The
database schema version and runtime protocol version have separate owners and
advance only when their respective contracts change.

The stored owner protocol version is a projection of the process that last
acquired the fixed port, not database schema identity. SQLite accepts a positive
safe integer in that field. A new fixed-port owner replaces it with the current
runtime protocol version before constructing the application. A deferred
process accepts a live owner only when the stored projection, signed live-owner
identity, and current runtime protocol version agree.

The current product SQLite schema contains exactly sixteen tables:

- `local_profile` stores the local profile identity;
- `runtime_owner` stores the HTTP-owner identity, compatibility version,
  configuration identifier, process projection, and owner revision;
- `chain` stores trusted canonical EIP-155 chain identities inserted only from
  runtime configuration after fixed-port ownership is acquired;
- `reference_feed_round` stores validated fixed-manifest Chainlink round
  facts and their first admitted configured-RPC read evidence by feed, proxy,
  phase, and aggregator-round identity;
- `reference_feed_sync_state` stores each feed's revision, phase-scoped bounded
  continuation, irreversible local composite-round retention cutoff, integrity
  conflict, and terminal malformed, phase, or retention boundary;
- `robinhood_asset_snapshot` and `robinhood_asset` store one complete admitted
  official-source snapshot and its chain-scoped members;
- `contract` and `token_contract` store chain-scoped contract identities
  inserted by a confirmed addition or verified default initialization;
- `token_contract_inspection` stores the exact canonical `token.inspect`
  success selected by its digest;
- `wallet_account` stores persistent `(profile, chain, address)` identities that
  survive disconnect, account change, session deletion, and owner takeover;
- `reference_pair_watchlist_state` stores one revision for each local profile,
  product chain, and wallet address;
- `reference_pair_watchlist_entry` stores that account's complete ordered set of
  supported fixed-manifest pairs;
- `wallet_token_selection_state` stores the account selection-set revision and
  whether the ordered defaults were initialized;
- `wallet_token_selection` stores the account-specific inclusion choice and
  selection revision independently from current official classification; and
- `current_wallet_connection` stores the secret-free current connection
  projection and revision.

The connection projection is not the durable owner of account identity. A
validated connected transition inserts or reuses its exact wallet-account row
and replaces the projection in one transaction. A nonconnected transition
changes only the projection and never deletes a wallet-account row.

The current wallet management operation is owner-memory coordination state. It
contains its opaque identifier, kind, state, starting connection revision,
expiry, and secret-free terminal result. It never enters SQLite or the
WalletConnect SDK store. A nonterminal operation has a fixed user-action
deadline. A terminal operation has a fixed bounded retention period and is then
removed. Pairing URI and QR material remain separate owner-memory secret state
and never enter the operation read model.

The current token-catalog operation is also owner-memory coordination state. A
profile has at most one nonterminal catalog operation. Addition inspects the
token before creating that operation; removal captures the exact current
selection revision. One start procedure owns slot reservation, atomic wallet
capture, the explicit addition or removal preparation branch, wallet recapture,
operation publication, and release. Confirmation
revalidates the same live wallet session, account, chain, and connection
revision before one database method executes the explicit branch in one
transaction. That transaction rereads the durable result and validates the
completed operation before commit. A failed postcondition rolls back the whole
branch. Application close rejects new calls, aborts cancellable inspection,
waits for every admitted asynchronous call, and then releases operation state.
Terminal operations have bounded memory retention and are not restored by a
successor owner.

The account-assets application is the sole owner of the connected-account asset
read. On a first-page read it atomically captures the active wallet and attempts
one bounded official-source synchronization before entering one chain
invocation. That invocation resolves one opaque canonical block, initializes
the exact ordered defaults once for that account after verifying them at that
block, and reads one bounded included-selection page at the same block. Later
pages preserve the admitted official-snapshot and selection-set revisions while
resolving a fresh block in their own invocation. Each visible official member
is verified against StockFactory before it is classified as a Robinhood Stock
Token; a source member without that proof is not displayed as official. The
application reads ERC-20 metadata, raw balance, required ERC-8056 observations,
and the native balance through the exact block authority, then rereads the
selection-set revision and recaptures the wallet. It accepts the result only
when the account, connection revision, stable session-source identity, official
snapshot revision, and selection-set revision remain unchanged. SQLite stores
no balance page, token standard observation, or read error. Exact reads and
official-candidate pages consume the same view revisions instead of
reconstructing the join in an interface. A failed official synchronization
preserves the last committed snapshot and never changes account choices.

The reference-market application is the sole owner of latest reference prices,
bounded history synchronization, exact cross construction, candle aggregation,
and account watchlists. Each latest or history read enters one chain invocation,
resolves one opaque canonical block, and performs every dependent feed read
through that exact authority and the fixed product manifest. History
synchronization serializes each feed, admits bounded callers, and commits
validated observations, the exact backfill phase and continuation, and
retention state in one transaction. Age eviction removes only a wholly expired
composite-identity prefix; capacity eviction retains at most the canonical
per-feed history-round limit owned by `referenceMarketLimits`. Both advance one
irreversible inclusive identity cutoff.
Reads never traverse or admit an identity at or below it, and that cutoff never
becomes source-time, source-absence, finality, or coverage evidence. The chain
reader consumes one nonoverlapping work plan derived from the durable
continuation, admitted identities, and cutoff. Synchronization derives the
request report from the committed snapshot through the same planner. Remaining
continuation, remaining gap, phase-boundary, malformed-round, and retention
facts become explicit history limitations rather than completeness claims.
Candles and empty-bucket starts partition only the represented UTC buckets and
never prove that the source had no other updates. Stored read evidence retains
its original block and read time instead of being rewritten under a later
request block. The synchronization owner rejects new work while closing,
removes queued work without an RPC or commit, and drains active settlement.
The application determines terminal cancellation once at the final projection:
caller abort precedes application close, which precedes the chain deadline and
other failures. Its composition stage consumes only the cumulative parent
support manifest; it does not receive or depend on the account-assets
application port. Watchlist reads capture and recapture the same live wallet
session. Add, remove, and reorder commit only when the captured account,
connection revision, and expected watchlist revision still match.
Neither the round cache nor the watchlist stores a formatted price, chart
coordinate, wallet balance, remote directory response, or arbitrary pair.

The WalletConnect SDK private store is authoritative for:

- client identity and keychain material;
- pairing and session topics;
- pairing and session records;
- approved namespaces, accounts, methods, events, and expiry;
- relay subscription and protocol state; and
- WalletConnect JSON-RPC history required by the SDK.

Little John never copies a pairing URI, session topic, symmetric key, relay
credential, raw WalletConnect session record, raw signature, or raw signed
transaction into SQLite. SQLite does not implement, inspect, migrate, or repair
the WalletConnect SDK's private schema.

Only the HTTP-owner process opens the WalletConnect SDK private store. Other
Little John processes consume the owner-provided connection read model and do
not open or copy that store.

SQLite connection state is a derived projection and never proves that a wallet
is currently connected. On startup or ownership takeover, the coordinator:

1. initializes the WalletConnect SDK against its private store;
2. reads sessions through the SDK API;
3. validates expiry, the configured canonical chain, approved account, required methods, and
   current session usability;
4. subscribes to session lifecycle events; and
5. transactionally replaces the SQLite connection projection.

No valid session produces a disconnected projection. More than one live
session violates the single-session invariant and produces an unresolved state;
Little John never chooses one, exposes session selection as a normal operation,
or silently revokes sessions. The user must explicitly confirm disconnection of
every stored session before starting a new connection. Until reconciliation
completes, the shared projection is unknown and cannot authorize a wallet
request.

A wallet-originated deletion, expiry, account removal, chain removal, or
unusable SDK store invalidates the SQLite projection. Historical connection
events are not retained merely as an activity log.

Both stores live under the Little John application-data directory rather than
the repository or browser storage. Little John restricts their filesystem
access to the current operating-system user and excludes their contents from
application logs, exports, and diagnostic bundles.

## Browser Surfaces

- A desktop AI host uses MCP for text interaction and opens a Little John local
  URL in its controlled built-in browser when the user requests a visual page
  or an intent requires review.
- A user may manually open the fixed local origin in another browser.
  Little John never asks a host integration to launch a separate system browser.
- Little John owns the local page state and URL. The desktop host owns browser
  display, focus, and navigation to that URL.
- The fixed root is the only human page. Wallet connection state, account
  assets, contextual token actions, reference prices, reference history, and
  account watchlist controls use one application shell and one modal host.
  Wallet connection, disconnection, and operation identifiers do not create
  human page-path namespaces.
- Opening the root or the wallet dialog does not connect, disconnect, or
  confirm a wallet operation. A direct user action in the dialog may request one
  permitted coordinator transition through browser-scoped authority.
- Wallet connection and wallet-operation state are independent canonical
  contracts. The root browser projection atomically composes their current
  values for presentation; it is not a third state and changes neither
  lifecycle.
- The dialog consumes that root projection. It never derives lifecycle meaning
  from page location and never creates a second nonterminal operation.
- The wallet dialog is a native modal dialog. Opening it moves keyboard focus
  into the dialog and makes the application behind it inert; closing it returns
  focus to the Wallet navigation control. Escape may close a connection-state
  view but never cancels or changes a wallet operation.
- The dialog offers Connect only while cleanly disconnected. A disconnected
  `unusable_store` state offers Disconnect so the coordinator can remove any
  remaining SDK session before another Connect. Connected and unresolved states
  also offer Disconnect; unknown state permits no mutation, and unresolved
  state never selects one session. The browser start request contains
  `connect` or `disconnect` plus the connection revision displayed to the user;
  the coordinator rejects a stale revision, reads the actual current state, and
  applies that direct action atomically. An ordinary Connect request returns the
  current valid connection when one exists. A direct browser Disconnect begins
  disconnection without a second confirmation view. Changing wallets requires a
  completed Disconnect followed by a new Connect action.
- A successful browser control request returns after the coordinator commits
  the operation's first canonical state. WalletConnect acquisition, approval,
  cancellation, validation, and session deletion continue under coordinator
  ownership while the browser observes those canonical states. The initiating
  browser never waits inside the control request for an SDK effect to finish.
- An MCP wallet-management tool returns the fixed root URL for browser display.
  The MCP operation identifier remains available to the agent for exact polling
  and cancellation but does not appear in the human page path.
- The browser reads the one current operation through the current-operation
  resource declared in Current State, then reads the exact retained operation
  by identifier until terminal so the root dialog can present the result without
  inferring it from disappearance. Confirmation and cancellation carry that
  operation identifier in their action-resource paths for exact identity,
  revision, and stale-tab checks. The identifier is not navigation state or
  browser authority.
- Browser actions allocate the same canonical operation identifier and send
  once, but do not use authenticated owner sessions. A missing or malformed
  action response therefore becomes `delivery_unknown` without a recovery
  read, retry, cancellation, reload, or owner inference. Wallet and token
  presentation retain separate state lifecycles. Locally established delivery
  uncertainty is carried separately from response JSON, so response data cannot
  claim its action, operation identifier, or resend policy.
- Exact-operation observation finishes before the browser adopts a successor
  operation. Canonical retention expiry clears the old observation without
  inventing a terminal result. Browser-session expiry or compatible-owner
  replacement reloads the root once to obtain a new browser request credential
  and CSRF token. A transport failure is not credential evidence and exposes no
  browser-generated error text.
- When the exact retained operation first reaches a terminal state, the browser
  presents at most one transient non-modal notification for that operation
  identifier. The notification preserves the canonical kind, state, result, and
  failure meaning. Its visual expiry is browser presentation only and never
  changes the operation, its retention, or the wallet connection.
- A background observation failure is not a wallet-operation result. Polling
  retries it without a notification. A failed direct browser control request
  produces an error notification without inventing a terminal operation.
- The asset page accepts only an account-assets result produced for the current
  connected account. Account or connection-revision change aborts older reads,
  clears their presentation, and starts a new first-page read. A manual refresh
  failure retains the last verified snapshot and marks it stale.
- The modal presents add, removal, information, and retained operation review as
  independent canonical views. Add inspects before the operation is admitted.
  Removal uses the current selection revision. The add view lists bounded
  official candidates from the account-assets view and also accepts one custom
  ERC-20 address; both routes enter the same addition operation.
  A web-owned operation exposes its declared confirmation or cancellation
  action; a CLI-owned operation is read-only in the browser. Closing a dialog
  never confirms, cancels, or changes domain state.
- The reference-market view reads current prices and selected history through
  public-read routes. It displays exact OHLC values beside the non-authoritative
  chart projection. Its semantic details preserve the canonical block, mapping
  evidence, safe configured-RPC reference, round identity, update and read
  times, partial or unavailable status, observed-round coverage basis, explicit
  limitations, warnings, and any unavailable reason without
  substituting display-derived facts. A disconnected user can read the two
  starter pairs and all fixed-manifest prices but cannot read or change an
  account watchlist. Add, remove, and reorder use one captured watchlist
  revision and never retry an uncertain send. Pointer and keyboard ordering
  submit the same canonical complete-order replacement.
- Catalog operation confirmation carries the exact operation identifier and
  review digest. The browser does not derive either value from the page URL or
  recompute the digest.
- An intent review page contains the wallet connection and contract-execution
  flow for one review session and contains no links to other product pages.
- A user-requested information page may use the shared navigation bar to move
  between information pages.
- Opening any page does not connect a wallet, request a signature, or execute a
  transaction.
- Transaction authorization requirements are defined in
  `docs/TRANSACTION_POLICY.md`.
- Host integrations open the local URL only in their controlled built-in
  browser and never launch a separate system browser. When the host cannot
  display its built-in browser, it returns the URL as text and the web surface
  remains unavailable in that host.

## Interface Selection

- Web and CLI are presentation and confirmation interfaces over one runtime;
  they are not separate wallet modes.
- A browser review request selects the `web` confirmation interface.
- A directly invoked interactive terminal review selects the `cli`
  confirmation interface.
- The interface selection is explicit and never inferred from wallet state,
  account state, terminal availability, or browser availability.
- Each review has one confirmation interface. The other interface may display
  the current review as read-only.
- Terminal capacity changes only QR presentation. It never changes the
  operation's interaction or confirmation interface.
- An authenticated browser may display the current QR for a CLI-owned operation
  as a read-only presentation. It cannot confirm, cancel, transfer, or
  disconnect that operation.
- The authenticated local-control cancellation resource cancels one exact
  cancellable operation independently of its presentation interface. This is a
  local user management authority, not browser control or confirmation, and it
  cannot interrupt an approved session transition.
- Before wallet handoff, an explicit interface transfer revokes any existing
  confirmation grant. Transfer never authorizes the new interface; a new
  explicit user action is required under
  `docs/TRANSACTION_POLICY.md#confirmation-authority`.
- Interface transfer is blocked while a wallet request is pending or after the
  review reaches a terminal result.
- MCP stdio remains a transport and session gateway. It is not a wallet
  confirmation interface.
- An MCP wallet-management tool may create an operation and return its local
  fixed-root display URL. The tool call does not confirm the operation, and its
  response never contains a pairing URI, QR matrix, session topic, or wallet
  secret.
- An MCP token-catalog start tool may create a web-confirmed operation and
  return the fixed root display URL. Separate MCP tools may read or cancel
  one exact operation but cannot confirm it.

## CLI Surface

- Read operations render structured text without requiring a browser.
- The CLI is a client of the shared local runtime and does not start a separate
  wallet coordinator or maintain separate product state.
- The CLI consumes the same server-owned review state, commitments,
  WalletConnect session, and receipt verification as the web interface.
- Wallet connection and transaction confirmation require an interactive TTY.
- CLI wallet commands consume the same coordinator-owned wallet management
  operations as MCP and web. A direct interactive CLI action may provide the
  operation confirmation owned by the CLI flow; piped or redirected input may
  not.
- CLI token reads expose canonical inspection, selection detail, and bounded
  selection pages. Token addition and removal require an
  interactive terminal, display the complete server-owned review, and accept
  only one exact case-insensitive `y` response. The CLI sends the server-owned
  review digest and never asks the user to transcribe it. Before confirmation
  is sent, decline, interruption, or presentation failure cancels the exact
  admitted operation before exit. Once an action send begins, an unproved
  response is reported as `delivery_unknown` with exit code `8`; the CLI names
  the exact operation and does not repeat or compensate for that action.
- `read assets` consumes the account-assets application and exposes its exact
  canonical collection or the shared human view, including raw balances,
  verified official classification, required token standards, and adjusted
  Stock Token amounts when the current multiplier is available. Both successful wallet-connect
  outcomes perform the same first-page read before return or owner wait. A read
  failure does not relabel or roll back connection success.
- `market price` and `market history` consume the public reference-market read
  contracts. Their human output preserves the canonical block, mapping
  evidence, source references, round identity and times, status, coverage,
  warnings, and unavailable reason; exact JSON remains the canonical result.
  `market watchlist` reads the connected account's exact ordered state.
  `market add-pair`, `market remove-pair`, and `market reorder-pairs` require an
  explicit expected revision and use the same send-once mutation owner as MCP.
  An uncertain response exits with code `8` and instructs the caller to read
  the watchlist before deciding whether to act again.
- The wallet owner converts a WalletConnect pairing URI to a QR matrix and
  discards the URI. The CLI renders only that matrix and never receives or
  prints the raw URI.
- Pairing URIs and terminal QR output never enter MCP responses, redirected
  stdout, product-controlled logs, shell command arguments, durable evidence,
  or activity records. An external terminal transcript can record terminal
  output and is outside Little John's control.
- The CLI confines QR output to an alternate terminal screen with the cursor
  hidden and restores the primary screen after pairing, rejection,
  cancellation, expiry, resize below the required dimensions, or controlled
  CLI exit.
- The CLI derives the exact required terminal rows and columns from the complete
  QR matrix and four-module quiet zone before rendering. The required width
  includes one unused terminal column so the raster never enters automatic
  right-margin wrapping.
- It renders only a complete, undistorted matrix when both terminal dimensions
  are known and sufficient. Otherwise it renders no QR, reports the current or
  unknown dimensions and the exact required dimensions, and continues observing
  the same operation. Terminal size alone does not authorize cancellation or a
  second operation.
- A catchable termination signal is latched before readline or terminal cleanup.
  Before operation admission it prevents a wallet command from starting and
  drains any acquired runtime. During a cancellable wallet operation it starts
  cancellation of that exact operation before removing the QR presentation.
- A terminal presentation, polling, or operation-observation failure uses the
  same exact cancellation transition while the operation remains cancellable.
  Failure to confirm cancellation is reported as unavailable runtime state and
  never authorizes another operation.
- After a connection operation completes, a catchable termination signal stops
  the direct CLI runtime without disconnecting or deleting the approved wallet
  session.
- Compact terminal rendering uses one-cell Unicode half-block glyphs. Actual
  scanability is claimed only for terminal profiles that pass the physical
  wallet check; ambiguous-width terminal configurations are not inferred from
  locale or static text width.
- The CLI prints the fixed-root browser URL only when the authenticated browser
  presentation binding is available. It never opens the URL automatically.
- CLI transaction authorization is defined in `docs/TRANSACTION_POLICY.md`.

## Wallet Connection Lifecycle

- Wallet connection creates or restores the profile's only server-owned live
  WalletConnect session.
- Starting a wallet management operation, locally confirming a destructive
  transition, and approving a WalletConnect proposal in the wallet are separate
  actions. The operation's interaction interface selects its confirmation
  controls. One atomic presentation snapshot contains its canonical operation,
  interface-relative control access, and QR material only while wallet approval
  is pending. A second interface receives `read_only`; presentation does not
  grant confirmation, cancellation, or wallet authority.
- The wallet coordinator owns one operation state machine for connection,
  disconnection, and cancellation. Operation kinds are `connect` and
  `disconnect`. Connect uses nonterminal `starting_connection`,
  `awaiting_wallet_approval`, `cancelling`, and `validating_session`, then
  terminal `completed`, `cancelled`, `rejected`, `failed`, or `expired`.
  Disconnect uses nonterminal
  `awaiting_confirmation` and `disconnecting`, then terminal `completed`,
  `cancelled`, `failed`, or `expired`.
- Each nonterminal state has one role. `starting_connection` acquires one exact
  SDK Connect attempt; `awaiting_wallet_approval` observes that acquired
  attempt; `cancelling` performs bounded cleanup of acquisition or that exact
  attempt; and `validating_session` owns approved-topic validation, persistence,
  and cleanup authority.
  `awaiting_confirmation` waits for direct authorization of Disconnect, and
  `disconnecting` performs its bounded SDK session deletion.
- A successful, cancelled, rejected, or expired terminal operation is published
  only after its exact SDK postcondition and authoritative reconciliation are
  known. An SDK failure or deadline may publish `failed` after invalidating
  connection evidence and fencing the still-running effect; that effect cannot
  authorize state, and any late success is cleaned up before evidence becomes
  available again. An approved topic is placed under revocation authority
  before validation or persistence, and every validation failure removes the
  topic before terminal publication.
- A connection instruction with no live session starts pairing. A connection
  instruction with one valid live session returns the current connection and
  creates no operation. A connection instruction while session state is
  unresolved performs no mutation and never selects or deletes a session.
- Changing wallets is two operations: Disconnect completes the existing-session
  removal, then Connect starts a new pairing. A failed disconnection starts no
  pairing, and Connect never removes or silently selects an existing session.
- A disconnection instruction with no live session completes successfully with
  the `already_disconnected` outcome and performs no session mutation. With one
  live session, a direct interactive CLI instruction may start disconnection;
  an MCP-created operation requires direct confirmation in the global browser
  dialog. A browser-originated disconnection requires the user's direct dialog
  action for that exact connection revision. With multiple live sessions, every
  interface requires explicit confirmation before disconnecting every session.
  A confirmed disconnection waits for SDK deletion before completing.
- Every confirmation binds the operation identifier and the connection revision
  shown to the user. A changed revision makes the confirmation stale and causes
  no session mutation. Cancellation binds the operation identifier and the
  connection revision captured by that operation; a later connection projection
  revision does not make the independent operation impossible to cancel.
- One target-chain account is required in an approved session. Zero or multiple
  `eip155:4663` accounts fail validation; Little John never selects an account
  silently.
- The coordinator derives accounts, chains, methods, and events from the
  approved session namespaces as defined by the
  [WalletConnect session model](https://docs.walletconnect.network/wallet-sdk/web/usage).
- The selected account remains usable only while its session exists, is not
  expired, and still contains `eip155:4663`, the account, and the required
  method. Robinhood documents `4663` as the mainnet chain ID in its
  [official network configuration](https://docs.robinhood.com/chain/connecting/).
- Connection expiry and evidence availability are evaluated by one coordinator
  transition before either agent reads or the browser composite projection is
  produced. Consumers do not apply separate freshness rules.
- A connected-address cache is display and lookup data only.
- An approved active session carries later transaction requests through the
  WalletConnect relay. A new QR is not created for each transaction.
- A new QR is required when no valid session or reusable pairing remains.
- A new session approval is required when the required chain, account, or method
  is outside the current approved namespaces.
- Session deletion, disconnect, expiry, unusable storage, or removal of the
  selected account clears the active connection.
- A wallet-originated `session_delete` invalidates the selected account and
  shared connection read model, cancels use of that session, and
  requires a new connection before another wallet request.

## Local Credential Taxonomy

These credentials have separate authority and are never interchangeable:

- A `local control credential` authenticates a native Little John process or CLI
  to the HTTP owner. It permits only the control route's declared operation and
  never proves the direct user action required for wallet connection and never
  authorizes signature or transaction execution. Its persisted representation
  is an owner-only file in the application-data directory.
- A `browser request credential` authenticates a browser instance to the fixed
  local origin for browser reads and declared state changes. It is bound to the
  browser session through an `HttpOnly`, `SameSite=Strict` cookie, works with
  Host, Origin, and CSRF validation, and has a bounded expiry. An operation
  mutation additionally binds the exact operation identifier and connection
  revision. The credential never authorizes a wallet action by itself.
- A `wallet management operation identifier` selects owner-memory operation
  state for status, cancellation, and confirmation. It is not a credential and
  cannot authorize a state change without the applicable browser or direct CLI
  user action.
- A `token catalog operation identifier` selects one owner-memory catalog
  operation for status, cancellation, and confirmation. It is not a credential;
  confirmation also requires the operation's exact review digest and the
  declared browser or direct CLI action.
- A `confirmation grant` is transaction-authority state owned only by
  `docs/TRANSACTION_POLICY.md#confirmation-authority`. The authoritative record
  remains server-side and an interface receives only an opaque reference for
  the selected flow.
- A `WalletConnect session` is SDK-owned protocol state for approved namespaces,
  accounts, methods, events, and expiry. It is neither local HTTP authentication
  nor explicit confirmation of a Little John wallet operation.

Local control credentials, browser request credentials, confirmation grants,
and grant references are unguessable and scope-limited. They are excluded from
URLs, logs, durable product evidence, browser local storage, browser session
storage, and WalletConnect storage. A non-authorizing wallet management
operation identifier may appear in an API resource or canonical payload but not
in a human page path. The browser request credential exists only in its session
cookie. WalletConnect secrets remain only in the SDK-owned store.

## HTTP Boundary

- The server binds only to `127.0.0.1:46630`.
- Host and Origin are validated but are not authentication.
- Compatible-process and CLI state changes require a valid local control
  credential. The credential authenticates the caller but does not prove user
  confirmation.
- Browser state changes require a valid browser request credential, exact Host
  and Origin validation, and CSRF validation.
- Request bodies accept standard UTF-8 JSON under RFC 8259 and are then captured
  and validated by the owning schema. Whitespace and object-member order carry
  no authority. Deterministic serialization is an output and narrow digest
  concern, not an HTTP input requirement.
- A transaction handoff additionally requires the confirmation grant defined by
  `docs/TRANSACTION_POLICY.md#confirmation-authority`.
- No local credential or confirmation-grant reference appears in a query string.
- CSP, CSRF protection, request limits, and the exact fixed origin apply.

Request-class security is fixed as follows:

| Request class | Host | Origin | Authentication | Durable mutation |
| --- | --- | --- | --- | --- |
| Owner identity | Exact fixed Host | Must be absent | None; challenge proof is the response | No |
| Public read | Exact fixed Host | Absent for native clients or exact fixed Origin for browser clients | None | No |
| Compatible-process control | Exact fixed Host | Must be absent | Local control credential | Only the declared control transition |
| Browser bootstrap | Exact fixed Host | Must be absent | None; issues one bounded browser-session request credential and independent CSRF authority | No |
| Browser session read | Exact fixed Host | Absent or exact fixed Origin | Scoped browser request credential | No |
| Browser session query | Exact fixed Host | Absent or exact fixed Origin | Scoped browser request credential; no CSRF authority accepted | No |
| Browser state change | Exact fixed Host | Exact fixed Origin | Browser request credential and CSRF validation | Only the declared browser transition |

An Origin value other than the exact fixed origin always fails. A request never
changes class because it omits a credential or Origin. Each route has exactly
one request class.

## Verification

Implementation verification covers module dependency direction, fixed-port
ownership and takeover, foreign-process conflict, store separation, the
single-session invariant, wallet-operation serialization and expiry, stale
confirmation, disconnection failure, session restoration and invalidation,
shared MCP, web, and CLI state, credential separation, Host and Origin
validation, CSRF, request limits, token-catalog account and operation binding,
account-assets wallet, official snapshot, and selection continuity,
reference-market manifest admission, same-block price evidence, history bounds,
non-exhaustive observed history, exact candles, local-cutoff work preservation,
caller-first cancellation, cache and watchlist transactions, send-once delivery,
installed-package catalog and reference-market persistence across owner
takeover, and secret-leak boundaries.
