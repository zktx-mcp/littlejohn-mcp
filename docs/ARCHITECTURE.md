# Architecture

## Current State

Littlejohn has a Node.js `>=22.12.0` ESM TypeScript package, canonical core contracts, five
semantic read-capability definitions, generated JSON Schema and descriptor
projections, deterministic runtime build identity, product tests, owner-only
POSIX application-data permissions, SQLite product state, local control
credentials, secret-safe source identity, a runtime support manifest, and one
authenticated fixed-port HTTP owner with compatible peer deferral and
demand-driven takeover. The owner identity resource is
`GET /api/v1/runtime-identity`; authenticated process control is confined to
`/api/v1/internal/control/*`. SQLite row adapters alias SQL snake-case names to
lower-camel TypeScript fields. Immutable request-policy, resource-path, route,
support-manifest, and interface-mapping registries accept only complete
first-consumer extensions. Route responses are either canonical JSON or bounded
browser text with fixed CSP, content-type, opener, referrer, and no-store
headers; no route can supply arbitrary response headers. The initial support
manifest contains only the five canonical read capabilities. The default
composition initializes neither a WalletConnect consumer nor an RPC consumer.
It has no MCP tool, CLI, React interface, WalletConnect client, RPC provider,
capability handler, or chain read.

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
and the WalletConnect session boundary defined here. A task may implement a
dependency-complete subset of this architecture. An absent surface remains
unavailable and is not replaced by a different process, store, transport, or
authority model.

## Repository Ownership

This repository owns:

- local runtime and configuration;
- MCP tools and resources;
- loopback HTTP API and React pages;
- local SQLite state;
- dataset release verification;
- live chain reads;
- asset and deployment registries;
- contract, calldata, transaction, and receipt analysis;
- simulation and policy;
- prices, candles, portfolio, and activity views;
- protocol adapters;
- WalletConnect handoff; and
- receipt verification.

The separate dataset repository owns public versioned network, asset,
deployment, legal, contract-control, oracle-mapping, and observation records.
It never receives wallet addresses, balances, activity, review sessions,
transaction material, WalletConnect state, or private settings.

## Logical Modules

| Module | Responsibility |
| --- | --- |
| `core` | Schemas, exact numeric types, evidence, commitments, and errors |
| `chain` | RPC, pinned reads, simulation, broadcast, and receipt ports |
| `data` | Dataset schema and release verification |
| `registry` | Canonical asset, deployment, and source-authority records |
| `intelligence` | ABI, source, contract, calldata, signature, and transaction analysis |
| `security` | Deterministic policy, simulation coverage, warnings, blocks, and state deltas |
| `market-portfolio` | Balances, price evidence, candles, valuation coverage, and wallet net flow |
| `protocols` | Protocol package contract and protocol-specific capabilities and action adapters |
| `review` | Intent, account binding, commitments, freshness, and review state |
| `wallet` | WalletConnect sessions and exact reviewed-request handoff |
| `receipt-activity` | Transactions, receipts, traces, finality, and actual state deltas |
| `interfaces` | MCP, loopback HTTP API, React read models, and interactive CLI |
| `runtime` | Composition root, SQLite, configuration, HTTP ownership, and feature gates |

## Dependency Rules

- `core` imports no provider, protocol SDK, wallet SDK, React, HTTP, or SQLite
  implementation.
- Concrete SDK, database, HTTP, and adapter implementations enter through
  `runtime` composition.
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

## Local Process Model

- Codex and Claude may each start a local Littlejohn stdio MCP process through
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

## HTTP Owner Authentication

The operating-system port binding is the sole live-listener authority. SQLite
owner state is a revisioned projection and never authorizes takeover by itself.
The current operating-system user is the local trust boundary. Local credentials
separate that user from other users and unrelated listeners; they do not claim
to contain a malicious process already running with the same user authority.

- The local control credential contains 256 random bits, is encoded as
  unpadded base64url, and remains stable across compatible owner takeover.
- The runtime protocol version is `1`. Profile ID and owner instance ID each
  contain 128 random bits encoded as unpadded base64url. Owner revision is an
  unsigned base-10 integer string.
- A process first attempts to bind `127.0.0.1:46630`.
- After a successful bind, the process transactionally publishes its profile ID,
  owner instance ID, runtime protocol version, process ID, and owner revision to
  SQLite.
- On `EADDRINUSE`, a peer sends a fresh 256-bit base64url challenge in the
  `Littlejohn-Identity-Challenge` header of
  `GET /api/v1/runtime-identity`.
- The owner returns the strict fields `profileId`, `ownerInstanceId`,
  `runtimeProtocolVersion`, `runtimeBuildDigest`, echoed `challenge`,
  `ownerRevision`, and `proof`. The proof is HMAC-SHA-256 over the version-1
  length-prefixed UTF-8 encoding of those preceding fields in that order using
  the local control credential. Each length prefix is the unsigned 32-bit
  big-endian byte length of the following UTF-8 field.
- The peer verifies the challenge, proof, profile ID, protocol version, and exact
  runtime build digest before deferring ownership or sending any authenticated
  control request.
- A credential-bearing owner operation is assigned only to the exact socket
  that completed identity verification. A replacement socket receives no
  credential until it completes a new identity verification.
- Connection, identity verification, and exact-socket request dispatch have a
  finite transport deadline. After dispatch, the owning route and runtime
  lifecycle own operation completion and cancellation. An operation is never
  resent after delivery becomes uncertain.
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
- Store and wallet-coordinator transitions own lifecycle rules. MCP, HTTP,
  React, and CLI map those transitions and do not reimplement them.
- One wallet coordinator owns the WalletConnect Sign Client, relay connection,
  session lifecycle, wallet-management-operation lifecycle, and request
  lifecycle.
- A local Littlejohn profile has zero or one live WalletConnect session and zero
  or one nonterminal wallet management operation. A pending pairing proposal is
  operation state and is not a WalletConnect session.
- MCP, web, and CLI send commands to the coordinator and consume its connection
  and operation read models. They never copy session topics, keys, or signing
  authority into interface state.
- The WalletConnect SDK's private storage is authoritative for pairings,
  sessions, topics, namespaces, expiry, and session key material.
- The selected Robinhood Chain account is a CAIP-10 account reference bound to
  the active session topic under the
  [CAIP-10 account identifier specification](https://standards.chainagnostic.org/CAIPs/caip-10).
  An address stored without its active session is not a connected account.
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

1. The product SQLite database stores shared Littlejohn state.
2. The WalletConnect SDK private store contains WalletConnect protocol state
   and secrets.

The SQLite main database and WAL are the durable product-state authority. The
SQLite shared-memory file is owner-only transient coordination state. SQLite
may create or reconstruct it from the WAL after a crash; Littlejohn never uses
its presence or bytes as product-state evidence.

Fresh-database publication staging is never product state or a recovery input.
The runtime validates and leases the final database before removing exact
owner-only staging artifacts. An unsafe artifact in the reserved staging
namespace fails startup without changing the final database. Concurrent
creators converge on the validated final database rather than choosing or
repairing a staging database.

The product SQLite database stores:

- the local profile identity;
- HTTP-owner identity, compatibility version, and liveness state;
- the selected CAIP-10 account reference;
- the normalized wallet connection state and revision;
- derived chain, account, approved-method, approved-event, and expiry display
  facts after coordinator validation; and
- product-owned settings, read models, review state, and evidence that are
  independently permitted by their owning modules.

The current wallet management operation is owner-memory coordination state. It
contains its opaque identifier, kind, state, starting connection revision,
expiry, and secret-free terminal result. It never enters SQLite or the
WalletConnect SDK store. A nonterminal operation has a fixed user-action
deadline. A terminal operation has a fixed bounded retention period and is then
removed. Pairing URI and QR material remain separate owner-memory secret state
and never enter the operation read model.

The WalletConnect SDK private store is authoritative for:

- client identity and keychain material;
- pairing and session topics;
- pairing and session records;
- approved namespaces, accounts, methods, events, and expiry;
- relay subscription and protocol state; and
- WalletConnect JSON-RPC history required by the SDK.

Littlejohn never copies a pairing URI, session topic, symmetric key, relay
credential, raw WalletConnect session record, raw signature, or raw signed
transaction into SQLite. SQLite does not implement, inspect, migrate, or repair
the WalletConnect SDK's private schema.

Only the HTTP-owner process opens the WalletConnect SDK private store. Other
Littlejohn processes consume the owner-provided connection read model and do
not open or copy that store.

SQLite connection state is a derived projection and never proves that a wallet
is currently connected. On startup or ownership takeover, the coordinator:

1. initializes the WalletConnect SDK against its private store;
2. reads sessions through the SDK API;
3. validates expiry, `eip155:4663`, approved account, required methods, and
   current session usability;
4. subscribes to session lifecycle events; and
5. transactionally replaces the SQLite connection projection.

No valid session produces a disconnected projection. More than one live
session violates the single-session invariant and produces an unresolved state;
Littlejohn never chooses one, exposes session selection as a normal operation,
or silently revokes sessions. The user must explicitly confirm disconnection or
replacement of every stored session. Until reconciliation completes, the shared
projection is unknown and cannot authorize a wallet request.

A wallet-originated deletion, expiry, account removal, chain removal, or
unusable SDK store invalidates the SQLite projection. Historical connection
events are not retained merely as an activity log.

Both stores live under the Littlejohn application-data directory rather than
the repository or browser storage. Littlejohn restricts their filesystem
access to the current operating-system user and excludes their contents from
application logs, exports, and diagnostic bundles.

## Browser Surfaces

- A desktop AI host uses MCP for text interaction and opens a Littlejohn local
  URL in its controlled built-in browser when the user requests a visual page
  or an intent requires review.
- Littlejohn owns the local page state and URL. The desktop host owns browser
  display, focus, and navigation to that URL.
- An intent review page contains the wallet connection and contract-execution
  flow for one review session and contains no links to other product pages.
- A wallet management operation page shows only the requested connection,
  replacement, disconnection, or cancellation flow and contains no links to
  other product pages. Opening the page does not confirm its action.
- A user-requested information page may use the shared navigation bar to move
  between information pages.
- Opening any page does not connect a wallet, request a signature, or execute a
  transaction.
- Transaction authorization requirements are defined in
  `docs/TRANSACTION_POLICY.md`.
- Host integrations open the local URL in their controlled browser when that
  capability is available and otherwise present the same URL as a clickable
  link.

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
- Before wallet handoff, an explicit interface transfer revokes any existing
  confirmation grant. Transfer never authorizes the new interface; a new
  explicit user action is required under
  `docs/TRANSACTION_POLICY.md#confirmation-authority`.
- Interface transfer is blocked while a wallet request is pending or after the
  review reaches a terminal result.
- MCP stdio remains a transport and session gateway. It is not a wallet
  confirmation interface.
- An MCP wallet-management tool may create an operation and return its local
  management-page URL. The tool call does not confirm the operation, and its
  response never contains a pairing URI, QR matrix, session topic, or wallet
  secret.

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
- The CLI renders a WalletConnect pairing URI as a terminal QR code and does not
  print the raw URI by default.
- Pairing URIs and terminal QR output never enter MCP responses, logs, redirected
  stdout, shell history, durable evidence, or activity records.
- The CLI removes the QR after pairing, rejection, cancellation, or expiry.
- The CLI verifies terminal dimensions before rendering a QR code.
- CLI transaction authorization is defined in `docs/TRANSACTION_POLICY.md`.

## Wallet Connection Lifecycle

- Wallet connection creates or restores the profile's only server-owned live
  WalletConnect session.
- Starting a wallet management operation, locally confirming a destructive
  transition, and approving a WalletConnect proposal in the wallet are separate
  actions. The operation's interaction interface selects where Littlejohn shows
  status, warnings, confirmation controls, and QR material; it does not grant
  confirmation or wallet authority.
- The wallet coordinator owns one operation state machine for connection,
  replacement, disconnection, and cancellation. Operation kinds are `connect`
  and `disconnect`. Nonterminal states are `awaiting_confirmation`,
  `awaiting_wallet_approval`, `disconnecting`, and `validating_session`.
  Terminal states are `completed`, `cancelled`, `rejected`, `failed`, and
  `expired`.
- A connection instruction with no live session starts pairing. A connection
  instruction with one or more live sessions first shows the current
  connection or conflicting-session count and the consequence that a failed
  new approval leaves the profile disconnected. Cancellation before
  confirmation preserves every existing session. Confirmation disconnects
  every existing session, waits for SDK deletion, and only then starts a new
  pairing. Failed deletion starts no pairing. A rejected, cancelled, failed, or
  expired new pairing never restores a deleted session silently.
- A disconnection instruction with no live session completes successfully with
  the `already_disconnected` outcome and performs no session mutation. With one
  live session, a direct interactive CLI instruction may start disconnection;
  an MCP-created operation requires direct confirmation in its local web page.
  With multiple live sessions, every interface requires explicit confirmation
  before disconnecting every session. A confirmed disconnection waits for SDK
  deletion before completing.
- Every confirmation binds the operation identifier and the connection revision
  shown to the user. A changed revision makes the confirmation stale and causes
  no session mutation.
- One target-chain account is required in an approved session. Zero or multiple
  `eip155:4663` accounts fail validation; Littlejohn never selects an account
  silently.
- The coordinator derives accounts, chains, methods, and events from the
  approved session namespaces as defined by the
  [WalletConnect session model](https://docs.walletconnect.network/wallet-sdk/web/usage).
- The selected account remains usable only while its session exists, is not
  expired, and still contains `eip155:4663`, the account, and the required
  method. Robinhood documents `4663` as the mainnet chain ID in its
  [official network configuration](https://docs.robinhood.com/chain/connecting/).
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

- A `local control credential` authenticates a native Littlejohn process or CLI
  to the HTTP owner. It permits only the control route's declared operation and
  never proves the direct user action required for wallet connection and never
  authorizes signature or transaction execution. Its persisted representation
  is an owner-only file in the application-data directory.
- A `browser request credential` authenticates a browser instance to the fixed
  local origin for operation-scoped browser reads and state changes. It is
  bound to the browser session and one wallet management operation through an
  `HttpOnly`, `SameSite=Strict` cookie, works with Host, Origin, and CSRF
  validation, and expires no later than that operation's bounded retention. It
  never authorizes a wallet action by itself.
- A `wallet management operation identifier` selects owner-memory operation
  state for status, cancellation, and confirmation. It is not a credential and
  cannot authorize a state change without the applicable browser or direct CLI
  user action.
- A `confirmation grant` is transaction-authority state owned only by
  `docs/TRANSACTION_POLICY.md#confirmation-authority`. The authoritative record
  remains server-side and an interface receives only an opaque reference for
  the selected flow.
- A `WalletConnect session` is SDK-owned protocol state for approved namespaces,
  accounts, methods, events, and expiry. It is neither local HTTP authentication
  nor explicit confirmation of a Littlejohn wallet operation.

Local control credentials, browser request credentials, confirmation grants,
and grant references are unguessable and scope-limited. They are excluded from
URLs, logs, durable product evidence, browser local storage, browser session
storage, and WalletConnect storage. A non-authorizing wallet management
operation identifier may appear as a local path segment. The browser request
credential exists only in its session cookie. WalletConnect secrets remain only
in the SDK-owned store.

## HTTP Boundary

- The server binds only to `127.0.0.1:46630`.
- Host and Origin are validated but are not authentication.
- Compatible-process and CLI state changes require a valid local control
  credential. The credential authenticates the caller but does not prove user
  confirmation.
- Browser state changes require a valid browser request credential, exact Host
  and Origin validation, and CSRF validation.
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
| Browser bootstrap | Exact fixed Host | Must be absent | None; validates the operation identifier before issuing a scoped browser request credential | No |
| Browser session read | Exact fixed Host | Absent or exact fixed Origin | Scoped browser request credential | No |
| Browser state change | Exact fixed Host | Exact fixed Origin | Browser request credential and CSRF validation | Only the declared browser transition |

An Origin value other than the exact fixed origin always fails. A request never
changes class because it omits a credential or Origin. Each route has exactly
one request class.

## Verification

Implementation verification covers module dependency direction, fixed-port
ownership and takeover, foreign-process conflict, store separation, the
single-session invariant, wallet-operation serialization and expiry, stale
confirmation, replacement failure, session restoration and invalidation,
shared MCP, web, and CLI state, credential separation, Host and Origin
validation, CSRF, request limits, and secret-leak boundaries.
