# Architecture

## Current State

Little John is a Node.js `>=22.13.0` ESM TypeScript modular monolith. One
runtime composition root opens the owner-only SQLite product store, the
WalletConnect SDK store, one bounded Robinhood Chain RPC reader, the implemented
feature applications, and the final interface support manifest. Runtime creation
returns a cleanup-capable handle before it starts or defers to the fixed
loopback HTTP owner. The owner, compatible peer, takeover, and shutdown behavior
follows [Runtime Lifecycle](#runtime-lifecycle).

The current runtime composes wallet connection and operation ownership, pinned
chain reads, contract analysis with the current source-verification provider,
official-asset synchronization and StockFactory admission, account token
selection, account assets, reference prices and local reference history,
account-scoped reference-pair state, and the statically registered protocol
packages. Each feature owns its canonical application contracts and persistence
ports. This document records the current external-integration classification in
[External Integration Model](#external-integration-model); exact support,
evidence, numeric, and protocol meanings remain in their owning sources.

One authenticated fixed-port HTTP owner serves the owner-identity handshake,
compatible-process controls, public reads, browser-session resources, and
browser content under the request classes in [HTTP Boundary](#http-boundary).
Public wallet reads, browser wallet controls, and compatible-process wallet
controls remain separate route registries and authority classes. They share
canonical wallet contracts without treating their methods, credentials, or
mutation authority as interchangeable.

A no-argument package process exposes one stdio MCP connection while sharing or
taking over that HTTP owner. The interactive CLI and React application consume
the same runtime-owned applications and state. Canonical binding catalogs and
their role registries own exact MCP names, HTTP paths, CLI commands, browser
locations, parsing, and availability. Help text, route coverage, capability
catalogs, and the generated public support projection derive from those owners;
this document does not maintain a second interface catalog.

The React application currently uses one persistent shell for Assets, Prices,
and a selected reference-price detail, plus one shared modal host for explicit
wallet, token-selection, token-information, and contract-analysis tasks. The
browser location registry owns the exact paths and admitted query values.
Opening an information page performs no wallet mutation or transaction action.

Owner-only application-data permissions separate the SQLite product store,
WalletConnect private store, and local control credential. Browser request
credentials, compatible-process credentials, and WalletConnect session state
remain distinct. The current runtime exposes no transaction confirmation
authority. Route responses use the declared canonical-JSON or bounded
browser-content policies, and canonical JSON rejects ill-formed Unicode before
UTF-8 encoding.

The runtime support manifest is the sole machine authority for implemented
binding availability. Its deterministic public projection is
`docs/PRODUCT_POLICY.md#current-support`. Exact chain, protocol, evidence,
numeric, transaction, and presentation meaning remains in each owning binding
document rather than being restated in this Current State section.

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

## External Integration Model

Every external integration declares one of three identities:

- a binding product transport, source authority, or protocol identity whose
  external owner is part of the accepted product or evidence meaning;
- a replaceable implementation provider that satisfies a provider-neutral
  product role; or
- an Ethereum JSON-RPC endpoint implementing the standard chain transport.

The classification determines ownership and replacement:

| External integration class | Semantic SoT | Operational configuration SoT | Runtime representation | Replacement boundary |
| --- | --- | --- | --- | --- |
| Binding product transport, source authority, or protocol identity | Its owning product, evidence, or protocol contract names the external identity and exact supported meaning | The owning adapter module owns endpoints, SDK settings, request and response admission, limits, and provider-specific defaults | Runtime composition receives one validated opaque configuration and one explicit identity-specific port | Changing implementation details inside the same external identity preserves the contract; changing the external owner requires an accepted product, evidence, or protocol change |
| Replaceable implementation provider | The feature module owns a provider-neutral role port, normalized result, failures, evidence requirements, and lifecycle | Each provider adapter privately owns its endpoint, request and response schemas, authentication, transport behavior, limits, and provider identity | Runtime composition selects and constructs one adapter that returns the role port; consumers cannot observe provider configuration | A provider may be replaced only when the new adapter satisfies the complete unchanged role; otherwise it is a product-contract change |
| Ethereum JSON-RPC endpoint | Product chain identity and chain RPC method and normalization contracts remain authoritative | Runtime configuration owns default selection, exact admitted URI bytes, and source identity; `chain` owns the single HTTPS target-admission rule, methods, deadlines, concurrency, byte limits, normalization, and failures | Runtime carries the admitted endpoint identity; `chain` projects a request URL without user information and optional Basic authorization; features receive only canonical RPC and pinned chain-read ports | A conforming HTTPS endpoint changes through admitted configuration without changing feature contracts |

The current external integration classification is:

| External identity | Class | Product role and semantic SoT | Required adapter and configuration owner | Composition boundary |
| --- | --- | --- | --- | --- |
| Ethereum JSON-RPC endpoint | Standard chain transport | `docs/PRODUCT_POLICY.md` owns chain identity; `chain` owns RPC methods, normalization, limits, and failures | `runtime` owns default selection, exact admitted URI bytes, and source identity; `src/chain/rpc-transport-target.ts` owns HTTPS target admission; `chain` owns the bounded requester | The chain application constructs the requester from the exact admitted URI and passes only chain-read ports to features |
| Model Context Protocol | Binding product transport | The official MCP specification owns JSON-RPC transport meaning; this document's interface contract model and the canonical binding owners own Little John tool meaning | `src/interfaces/mcp.ts` owns official SDK server and stdio transport adaptation; role registries own their exact tool bindings | Interface composition constructs one MCP server from canonical bindings; replacing SDK details preserves the complete MCP identity and tool contracts |
| WalletConnect | Binding product transport | `docs/PRODUCT_POLICY.md` owns the wallet transport; this document owns session and handoff architecture | `wallet` owns SDK adaptation, project-ID validation, required namespace settings, metadata, SDK options, lifecycle, and provider defaults | The wallet application factory constructs one `WalletConnectClientPort` from opaque configuration received through runtime composition; other modules receive wallet product ports |
| Robinhood official-asset API | Binding source authority | `docs/EVIDENCE_POLICY.md` owns source authority; `officialAssetSourceDefinition` and the registry source contract own the exact source identity, normalized observations, failures, evidence, and storage ports | `src/registry/official-assets.ts` owns request and response admission, endpoint consumption, transport behavior, deadlines, and operational limits | Runtime composition constructs one source client; registry synchronization consumes the product-owned client and store ports; replacing the membership source changes the binding evidence authority |
| Robinhood StockFactory | Binding source authority | `docs/EVIDENCE_POLICY.md` owns the independent UID-to-token-address proof meaning; `stockFactoryAdmissionManifest` and the registry verification contract own the admitted deployment identity and exact verification result | `src/registry/stock-factory.ts` owns StockFactory call and identity verification behind the pinned-block `OfficialAssetChainReadPort` in `src/chain/official-assets.ts`; common RPC configuration remains with the chain transport | The chain application constructs the port for account-asset and token-inspection composition; changing verification internals preserves the admitted identity, while changing the deployment or source owner changes the manifest and evidence authority |
| Chainlink Data Feeds | Binding source authority | `docs/EVIDENCE_POLICY.md` owns source authority and evidence meaning; `referenceMarketManifest` owns the admitted directory identity and exact feed mappings; `docs/NUMERIC_POLICY.md` owns reference-price, cross-price, and candle meaning; `market-portfolio` and the canonical reference-market application contracts own admitted price and history result lifecycles | `src/chain/reference-market.ts` owns Data Feed call encoding, round admission, response validation, and batch fallback behind `ReferenceMarketChainReadPort`; common RPC configuration remains with the chain transport | The chain application constructs the port and runtime composition passes it to `market-portfolio`; changing a mapping changes the manifest, and replacing Chainlink with another source owner requires an accepted evidence or product-policy change |
| Sourcify API v2 | Replaceable implementation provider | `intelligence` owns `ContractSourceVerificationPort`, its normalized results and failures, evidence requirements, and lifecycle | `src/intelligence/sourcify.ts` owns the origin, path, request and response admission, deadline, response-size and concurrency limits, cleanup, and provider identity | Runtime composition constructs one Sourcify adapter and passes only `ContractSourceVerificationPort` to the shared contract-analysis process |
| Uniswap V2 | Binding protocol identity | `docs/PROTOCOL_ADAPTERS.md` and `src/protocols/uniswap-v2` own the exact V2 package, deployment records, native mapping, and capability registration; `docs/NUMERIC_POLICY.md` owns numeric meaning and `docs/EVIDENCE_POLICY.md` owns evidence meaning | `src/protocols/uniswap-v2/sdk.ts` owns the pinned Uniswap SDK loading and admission boundary; the package owns immutable deployment and route-asset records | Runtime composition constructs the statically registered V2 package once and passes only its canonical quote binding to interfaces |
| Lightweight Charts | Replaceable implementation provider | The browser interface owns `ReferenceChartPort`; admitted reference history and `docs/NUMERIC_POLICY.md` own the exact values and permitted ephemeral chart projection | `src/interfaces/web/lightweight-charts-adapter.tsx` owns package loading, chart options, event admission, failure normalization, subscriptions, and destruction | `src/interfaces/web/main.tsx` constructs one adapter; only a selected Prices pair detail requests the dynamic package chunk and receives `ReferenceChartPort` |

This table contains implemented external integrations only. The implementation
task that adds or removes an integration updates the table after the runtime
boundary exists or is removed. A proposed, researched, or unavailable
integration remains in its task plan or research material and is not listed as
current architecture.

Configuration values are classified independently from where the process reads
them:

- product-semantic values remain in the owning product, evidence, or protocol
  contract;
- provider operational values remain in the adapter module;
- an adapter-owned configuration may project a product identity, chain
  identity, fixed local origin, or another canonical value from its existing
  owner, but does not copy that literal or become its semantic owner;
- an exact binding-source URI that is canonical evidence identity and persisted
  provenance remains in the evidence contract and is consumed by the adapter
  without a second copy;
- credentials and user-supplied endpoint values may enter through the runtime
  environment, but the owning adapter validates them and runtime composition
  carries only the resulting opaque configuration;
- canonical provider or source identity may enter evidence only through the
  evidence owner; and
- no aggregate runtime configuration module restates provider defaults,
  provider schemas, SDK options, or provider limits.

WalletConnect is the current binding wallet transport. The Robinhood
official-asset API, Robinhood StockFactory, and Chainlink Data Feeds are
separate binding source identities with separate admission and replacement
boundaries. A supported DeFi protocol is a binding protocol identity. Replacing
any of those with a different external owner changes its owning product,
evidence, or protocol contract; adapter isolation does not pretend otherwise.

An externally operated service or vendor SDK enters the runtime through one
product-role port owned by the module that needs the role. The role is named for
the product responsibility when the implementation provider is replaceable. A
binding external identity remains explicit in its role name and evidence. A
consumer receives only validated product inputs, normalized results, documented
failures, and the lifecycle operations required by that role.

One provider adapter implements that port and owns:

- endpoint origins, path templates, request fields, headers, authentication, and
  transport settings, except an exact binding-source URI that the evidence
  contract owns as canonical source identity and persisted provenance;
- provider request and response schemas, SDK types, status and error mapping,
  rate and size limits, deadlines, retries, cancellation, cleanup, and resource
  ownership; and
- provider identity and terms metadata needed for dependency review.

Those provider details do not enter core schemas, feature contracts, shared
runtime configuration, persistence adapters, interface projections, or another
feature module. Canonical source identity and provenance may cross the adapter
only through the evidence contract that owns their product meaning.

The composition root may import one provider construction or registration entry
point. When an owning application factory already owns the complete external
resource lifecycle, the current-integration table may designate that factory as
the sole construction boundary instead. No handler, interface, browser
component, durable store, or unrelated feature imports the provider adapter. A
replaceable provider changes only the adapter and composition selection while
preserving the role contract. A binding external identity may change
implementation details behind its explicit port, but changing its external
owner is a product, evidence, or protocol decision.

Provider configuration is owned and validated by the adapter's module. Runtime
environment aggregation may invoke that parser and carry the resulting opaque
validated configuration to composition, but it does not copy provider defaults,
schemas, limits, or SDK settings into a second configuration authority.

A repository-owned configuration-integrity mechanism may consume one canonical
identity projection produced by the configuration owner when it must bind that
configuration to an existing MAC or local authority. The configuration owner
defines and validates that projection. The integrity mechanism does not inspect
or reconstruct provider settings, and the projection is not exposed to feature
consumers or public interfaces.

The repository does not maintain a generic external-service registry or dynamic
plugin system. A role port exists only for an implemented product
responsibility. Multiple providers, selection policy, fallback, failover, or
aggregation require their own accepted product and evidence contracts.

Ethereum JSON-RPC remains the standard chain-transport exception. Runtime owns
default selection, exact admitted URI identity, and source identity. One
side-effect-free `chain` owner admits HTTPS targets for both Runtime
configuration and the bounded requester; the remaining RPC behavior stays in
`chain`. Features consume chain RPC ports and never provider-specific endpoint
behavior. Protocol packages follow `docs/PROTOCOL_ADAPTERS.md` in addition to
this model.

Architecture verification checks the integration-table structure and exact
module export and import graph without copying the complete classification into
a test. Integrated review traces current source identities, adapters, SDK
imports, protocol registration, browser providers, and runtime composition to
the table and traces every table row back to implementation. Provider-specific
imports and literals remain in the adapter owner, only the declared composition
boundary constructs the adapter, consumers use product-owned ports, and
independent tests do not derive their oracle from the provider implementation.

### Contract Analysis Boundary

The `intelligence` module owns the ordered contract-analysis process used by
contract and token inspection. Core owns the serializable analysis contract,
target-dependent relation validation, and public evidence declarations.
`chain` implements one narrow `ContractAnalysisChainReadPort` whose instance is
already bound to one canonical block. The port exposes only the named runtime
code, supported proxy, owner, pause, and default-administrator reads; it does
not expose arbitrary RPC methods, calldata, storage slots, batching controls,
or block selection.

`intelligence` owns the provider-neutral
`ContractSourceVerificationPort`. A replaceable source-verification adapter
privately owns its endpoint, request and response admission, provider limits,
cleanup, and terms identity. It returns only a normalized exact-contract
interface, public source reference, and observation authority. Raw provider ABI
objects and provider response types do not cross that port.

One analysis execution contains the validated public analysis and the ordered
source observations that produced it. Contract and token capability handlers
consume that complete execution and cannot combine analysis data with source
observations from another execution.

Complete public capability validation is browser-safe and owns input parsing,
target-dependent result checks, public source-record digest comparison, evidence
replay, and result-size admission. Node-only capability execution separately
owns bindings, invocation identifiers, handler execution, and live observation
recording. A browser, transport, or stored-result reader does not implement a
weaker result parser.

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
- Machine-interface identity catalogs bind canonical contracts to their MCP,
  HTTP, and CLI identities. A separate browser-safe relation binds exact
  canonical contract objects to nonempty tuples of the current page and dialog
  surface objects. Browser clients, routes, application composition, and the
  support projection consume those same objects; the relation does not copy
  capability identifiers, paths, renderers, or workflow decisions.
- Domain-complete Wallet and token catalog admission binds each MCP-exposed
  local mutation identity to its exact same-domain operation-read binding and
  local read identity. MCP operation factories consume those admitted entries
  without a parallel action or operation-kind selector. When a local mutation
  result is uncertain, the MCP projection preserves that admitted result and
  adds only the binding-derived read tool and its admitted operation input; it
  does not perform that read. [HTTP Owner Authentication](#http-owner-authentication)
  owns the underlying send and bounded observation process.
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
- Every process uses the same local SQLite database and the fixed origin defined
  in [HTTP Boundary](#http-boundary).
- Exactly one compatible process owns the HTTP listener.
- A later compatible process verifies the current owner and defers HTTP
  ownership while continuing its stdio MCP connection.
- A compatible deferred process acquires the fixed port only through the
  demand-driven fixed-bind race after an owner operation fails.
- No process selects, increments, or falls back to another port.
- A foreign or incompatible port owner causes a clear startup failure and is
  never stopped or replaced.

## Runtime Lifecycle

- Runtime admits RPC configuration before resolving the application-data path
  or acquiring filesystem, database, requester, or network resources. The
  private invalid-RPC-configuration failure is recognized only at Runtime
  creation and uses the existing `invalid_input` process presentation before
  MCP or HTTP publication; it is not an application or interface error.
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
- Fixed-owner shutdown blocks new work, aborts and drains active work, and
  closes interface, reference-market, account-assets, token-catalog, and chain
  applications in dependency-reverse order before containing wallet product
  authority. Before WalletConnect SDK initialization begins, the runtime can
  release wallet resources, close product SQLite, release the database lease,
  and release the fixed HTTP listener in process. After SDK initialization
  begins, shutdown is process-terminal: the runtime retains the SDK, its
  injected storage, product SQLite and its lease, and the fixed listener until
  operating-system teardown. It does not claim a final wallet observation,
  seal or close injected storage, or issue a listener-release permit.
- The listener release requires the exact permit bound to the sealed and empty
  startup scope after application cleanup completes. Another permit or scope
  cannot share or trigger that release.
- A releasable shutdown failure keeps the owner in `stopping` and preserves the
  fixed port and every unresolved dependency. A later release attempt uses the
  same retained resources and never reconstructs them from projections. A
  process-terminal outcome is sticky and is not retried as an in-process SDK
  close.
- The direct executable owns process termination. It first settles every
  admitted CLI, terminal-restoration, QR, and MCP output write. A host-stream
  failure produces a nonzero status; backpressure remains pending rather than
  being reported as successful truncated output. After successful settlement,
  a process-terminal result uses operating-system teardown as the final SDK
  resource boundary. This is not a wallet disconnect and does not revoke an
  approved session. A released result permits normal Node termination.

## HTTP Owner Authentication

The operating-system port binding is the sole live-listener authority. SQLite
owner state is a revisioned projection and never authorizes takeover by itself.
The current operating-system user is the local trust boundary. Local credentials
separate that user from other users and unrelated listeners; they do not claim
to contain a malicious process already running with the same user authority.

- The local control credential contains 256 random bits, is encoded as
  unpadded base64url, and remains stable across owner takeover. Profile ID and
  owner instance ID each contain 128 random bits encoded as unpadded base64url.
  Owner revision is an unsigned base-10 integer string.
- A process first attempts to bind the fixed listener address defined in
  [HTTP Boundary](#http-boundary).
- Runtime configuration contains one canonical chain identity, the exact RPC
  URI bytes, and the WalletConnect project ID. Each process derives a keyed
  HMAC-SHA-256 configuration identifier from those values and the local control
  credential. The identifier reveals none of its inputs.
- The configuration key is the 32-byte HKDF-SHA-256 output derived from the
  decoded control credential with an empty salt and exact UTF-8 information
  `littlejohn/runtime-configuration/v1`. The HMAC payload contains the
  canonical chain ID, exact RPC URI bytes, and WalletConnect project ID in that
  order, each preceded by its unsigned 32-bit big-endian byte length. The
  result is canonical unpadded base64url for 32 bytes.
- After a successful bind, the process transactionally publishes its profile
  ID, owner instance ID, configuration identifier, process ID, owner revision,
  and acquisition time to SQLite. It then inserts its trusted
  configured chain before application construction and before entering the
  owner phase. A chain-insertion failure closes the listener; the published row
  remains a projection and never proves liveness.
- On `EADDRINUSE`, a peer sends a fresh 256-bit base64url challenge in the
  `Littlejohn-Identity-Challenge` header of the owner-identity resource declared
  by the runtime route registry.
- The owner returns the strict fields `profileId`, `ownerInstanceId`,
  `configurationMac`, echoed `challenge`, `ownerRevision`, and `proof`. The
  proof is HMAC-SHA-256 over the
  length-prefixed UTF-8 encoding of those preceding fields in that order using
  the local control credential. Each length prefix is the unsigned 32-bit
  big-endian byte length of the following UTF-8 field.
- The peer verifies the challenge, proof, profile ID, configuration identifier,
  and the persisted owner instance and revision before deferring ownership or
  sending any authenticated control request. A process with a different exact
  RPC URI, WalletConnect project ID, or chain configuration is incompatible and
  never shares the active fixed-port server.
- A credential-bearing owner operation is assigned only to the exact socket
  that completed identity verification. A replacement socket receives no
  credential until it completes a new identity verification.
- Connection, identity verification, and exact-socket request dispatch have a
  finite transport deadline. An authenticated owner session reports whether a
  request was not sent, received one complete response, or lost its response
  after sending began. Complete first-response observation has an independent
  private 300,000 ms bound. Changing that bound requires review of owner-session
  response lifecycle, ambiguous delivery, long-running operations, close, and
  failure meaning; equality with another duration does not create shared
  ownership.
- The local operation client allocates a 256-bit operation identifier before a
  start, sends each start, cancellation, or confirmation once, and validates
  the response through the binding catalog. Callers supply an opaque catalog
  identity and operation input. Wallet control-resource descriptors own each
  exact method and path; Wallet route registration and Wallet local-operation
  identities consume those descriptors. The binding catalog owns the request
  body, parser, error mapping, recovery, and outcome rules. A recoverable
  non-read identity names the exact same-domain operation-read identity rather
  than owning another method, path, or response parser. After an uncertain
  send, the client constructs and admits exact `{operationId}`, proves that the
  target read selects the same operation, and performs that read once with an
  independent private 2,000 ms bound while the authenticated profile, owner
  instance, configuration identifier, and owner revision are unchanged. Only
  a complete provenance-valid target success may establish the source result;
  every incomplete transport, non-success response, invalid provenance, target
  parse failure, or source conversion failure preserves `delivery_unknown` and
  forbids resend. A Wallet cancellation recovery admits only the exact
  operation with its captured connection revision; the operation state remains
  the sole statement of the effect outcome. Changing the recovery bound
  requires review of send-once behavior, owner continuity, observation
  availability, operation retention, failure interpretation, and permanent
  no-resend.
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
- The identity route validates the exact fixed Host, accepts no Origin or
  authorization credential, performs no durable mutation, and returns
  `Cache-Control: no-store`.

## State Ownership

- Shared product state lives in local SQLite.
- Browser cookies, local storage, and session storage are host-local UI state.
- Browser storage never contains wallet secrets, signing material, transaction
  authority, or the authoritative cross-host state.
- The browser tab retains only the validated identifier of the operation it
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
- One serial coordinator effect owns command admission, the immutable action
  deadline, SDK settlement, a fresh stable postcondition, operation
  publication, and cleanup. The operation and its interaction interface are
  bound before the effect begins.
- A local Little John profile admits zero or one valid WalletConnect session as
  connected and zero or one nonterminal wallet management operation. A pending
  pairing proposal is operation state, not a session. Multiple or invalid SDK
  sessions remain visible as unresolved state; Little John does not choose one.
- MCP, web, and CLI send commands to the coordinator and consume its connection
  and operation read models. They never copy session topics, keys, or signing
  authority into interface state.
- The WalletConnect SDK's private storage is authoritative for pairings,
  sessions, topics, namespaces, expiry, and session key material. Wallet injects
  one opaque SQLite key-value owner through the SDK's public storage option;
  product code never interprets its values as WalletConnect records.
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

SQLite alone interprets the main database and WAL. The main database and any WAL
bytes are durable SQLite artifacts; a zero-length WAL contains no bytes from
which Little John reconstructs product state. SHM is SQLite-owned
reconstructible coordination state, even when its file remains after close, and
its presence or bytes are never product-state evidence.

Fresh-database publication staging is never product state or a recovery input.
The runtime leases the final database and reads its required current rows before
removing exact owner-only staging artifacts. An unsafe artifact in the reserved
staging namespace fails startup without changing the final database. Concurrent
creators converge on the final database rather than choosing or repairing a
staging database.

The product SQLite database has one current schema definition. `currentSqliteSchemaSql` in
`src/runtime/sqlite-schema.ts` is its sole SQL owner. Fresh creation applies
that SQL and writes the literal SQLite `user_version=1`; opening existing state
never reads, compares, branches on, or rewrites `user_version`.

Existing-state admission derives a complete reference from the same SQL through
the pinned SQLite engine and compares the unfiltered `sqlite_schema` tuples
`(type, name, tbl_name, sql)`, including SQLite-generated autoindex rows and
excluding only `rootpage`. Candidate work is bounded by the reference row
count, each reference-derived field maximum, and the reference aggregate byte
total. There is no separate handwritten table-name or schema-shape authority.

Only complete absence of the main database, WAL, and SHM admits fresh
publication. An existing candidate requires an owner-only regular main file;
sidecars without the main database are unavailable state. Under the retained
main-file lease, Little John captures the current artifact set, opens the main
database `readonly` and `fileMustExist`, compares its exact structure, closes
that handle, and then checks the resulting artifact transition. The main
database and every pre-existing WAL remain durable SQLite artifacts and are
never deleted, truncated, repaired, copied, or rewritten by admission. For a
safely attested main-only candidate, the pinned read-only path may create only
an owner-only regular zero-length WAL. SHM is SQLite-owned reconstructible
coordination state and its presence or bytes are never product-state evidence.

Exact structure equality, successful closure of the read-only handle, the
artifact-transition postcondition, and the retained main-file lease together
authorize a write-capable open. That owner configures the connection, rechecks
the exact structure and lease, validates current product rows, and reconciles
publication staging before exposing product access. A completed exact
inequality produces the startup-only `runtime_state_reset_required` result only
after the same artifact postcondition passes. Incomplete projection, corruption,
permission, I/O, and contention failures retain their separately owned
meanings. Reset requires all Little John processes to stop and the complete
isolated data directory to be moved aside or replaced with a new empty
directory; no runtime migration, selective restoration, compatibility reader,
or schema repair exists.

The persisted owner projection contains only a fixed singleton identity plus
the profile, owner instance, configuration identifier, process ID, owner
revision, and acquisition time. The application record omits the singleton and
carries the remaining six admitted values. No stored or live owner field acts
as a runtime wire-version selector.

The product schema persists local profile and runtime-owner identity, trusted
chain configuration, admitted reference-feed history and synchronization
state, official-asset snapshots, verified contracts and token inspections,
durable wallet-account identity and the current secret-free connection
projection, account watchlists, and account token-selection state. The exact
table names and their SQL relationships are read from the SQLite schema owner,
not maintained as an independent documentation contract.

The connection projection includes one secret-free `revalidation_required`
boolean. It records only a contradiction or ambiguous product write that
Little John itself admitted and that the SDK may not retain. It is not a session copy,
event log, owner marker, generation, or source selector. A stable empty SDK
observation clears it atomically with the disconnected projection.

The connection projection is not the durable owner of account identity. A
validated connected transition inserts or reuses its exact wallet-account row
and replaces the projection in one transaction. A nonconnected transition
changes only the projection and never deletes a wallet-account row.

The current wallet management operation is owner-memory coordination state. It
contains its opaque identifier, kind, state, starting connection revision,
immutable action deadline, interaction interface, and secret-free terminal
result. It never enters SQLite or the WalletConnect SDK store. Terminal
retention is private owner memory and does not alter the action deadline.
Pairing URI and QR material remain separate exact-operation presentation state
and never enter the canonical operation read model.

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
no balance page, token standard observation, or read error. The separate
browser overview initializes the same defaults and scans the complete admitted
official snapshot. It partitions every member in snapshot order, reads selected
members and native balance at one block, carries the snapshot's candidate-list
commitment, and omits custom selections without changing the paged canonical
collection. Exact reads consume the overview view revision instead of
reconstructing the join in an interface. A failed official
synchronization preserves the last committed snapshot and never changes
account choices.

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

Only the HTTP-owner process opens the WalletConnect private database. It
registers the opened storage owner before the next fallible acquisition step,
then transfers that same registration to the WalletConnect adapter. Other
Little John processes consume owner-provided Wallet product ports and never
open or copy the private database.

The private database has one current opaque key-value schema. It stores each
admitted SDK key as its exact canonical UTF-8 bytes and stores bounded
`node:v8` values without interpreting them. It commits each effective mutation
and its monotonic revision in one SQLite transaction and admits only its exact
owner-only main/WAL/SHM artifact set. It has no migration, compatibility reader,
schema repair, or WalletConnect-record projection. A latched filesystem,
SQLite, key, codec, limit, permission, or closed-state failure cannot become an
empty observation.

SQLite connection state is a derived product projection and never proves that a
wallet is currently connected. A stable public SDK observation is exactly:

1. read the private-storage revision;
2. read the SDK's public proposal collection;
3. read the SDK's public session collection; and
4. reread the private-storage revision.

The observation is available only when both revision reads are healthy and
equal. It performs no SDK mutation. The adapter preserves optional namespace
field absence and converts session topics only to secret-free session-source
identities before returning the observation. Every returned session is
addressable by one such source. If any SDK session entry cannot produce that
source, the complete observation is unavailable rather than an unresolved set
that cannot be reconciled.

The coordinator projects one complete observation in this order: an active
effect is unknown; an unavailable observation is unknown; proposal-only state
is reconciling; any invalid session, multiple sessions, a session plus another
proposal, or a nonempty observation blocked by revalidation is unresolved; one
valid session is connected; and only a stable empty observation is
disconnected. It validates canonical chain and account identities, the exact
required methods and events, and expiry. It never selects a session from an
unresolved set.

WalletConnect callbacks are wake-up hints rather than connection or actor
evidence. The adapter attaches SDK callbacks before handoff, retains admitted
events in one bounded queue, and releases them only after the coordinator has
registered the sole consumer and the adapter has attempted one stable initial
observation. Events captured across that activation boundary use the same
mapping as later events; an identity event that cannot be attributed closes
current authority and schedules a stable observation instead of disappearing.
A generic observation-change callback schedules a stable observation without
writing a connection projection from the callback itself. Unknown callback
types are ignored. A supported identity callback for the
exact active session closes authority synchronously when its admitted content
is malformed or contradictory, persists `revalidation_required`, and then
requests a fresh observation. If a later nonempty unresolved observation still
contains that exact source, the coordinator retains it only as an internal
callback-attribution key; it exposes no active session and authorizes no wallet
request. An observation that no longer contains that source clears the internal
attribution. Deletion and expiry wording never become the cause of a public
projection; only an exact owned effect plus its stable postcondition can supply
an effect-specific disconnected reason. An unchanged stable empty observation
preserves an already admitted disconnected reason; absence alone cannot replace
that causal fact or advance the connection revision.

Shutdown rejects new commands and contains the admitted effect before detaching
product callbacks and closing in-memory wallet authority. Once WalletConnect
SDK initialization has begun, the public SDK boundary cannot prove that relay,
heartbeat, provider, expiry, or persistence work has stopped using injected
storage. The runtime therefore makes process-terminal ownership sticky: it
does not publish a final connection projection, seal or close injected storage,
or claim an aggregate `SignClient` close. It retains the inseparable SDK and
storage owner set until operating-system teardown. A successor process restores
the SDK and obtains a new healthy stable observation before publishing wallet
authority.

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
- Assets and Prices are the primary information pages. The product identity is
  the sole Assets navigation control and Prices is the sole named primary
  navigation control. One selected
  reference pair is a child Prices resource. Analysis is contextual modal
  content and has no information-page path. The information pages use one
  persistent application shell, shared navigation, wallet connection state,
  and one modal host. Only the selected information interface is mounted.
  Wallet connection, disconnection, operation identifiers, and Analysis targets
  do not create human page-path namespaces.
- The browser exposes no Quote information page, Swap or Buy/Sell surface, or
  transaction action. The canonical Uniswap V2 Quote capability remains
  available through HTTP, MCP, and CLI.
- Browser capability availability is derived from the exact canonical-contract
  to page-or-dialog relation. The reduced Assets and Prices overviews and the
  Stock Token information task do not establish capability availability for
  contracts whose complete behavior they do not expose.
- Opening an information page does not connect, disconnect, or confirm a wallet
  operation. A direct Connect or Disconnect action opens one fixed wallet task
  and requests only the transition permitted for that task through
  browser-scoped authority. No unrelated state change opens a wallet task.
- Wallet connection and wallet-operation state are independent canonical
  contracts. The browser application projection atomically composes their current
  values for presentation; it is not a third state and changes neither
  lifecycle.
- The wallet task consumes that application projection. It never derives
  lifecycle meaning from page location and never creates a second nonterminal
  operation.
- Every browser task dialog is a native modal dialog. Opening it moves keyboard
  focus into the dialog and makes the application behind it inert; closing it
  returns focus to the initiating control. When an exact cancellation is
  available, Escape, backdrop selection, and the cancellation control request
  that cancellation and keep the dialog open until the canonical operation
  changes. Applying work is not dismissible. Dismissing a delivery-uncertainty
  presentation changes presentation only and preserves its exact reconciliation
  subject.
- The dialog offers Connect only while cleanly disconnected. Connected and
  unresolved states offer Disconnect; unknown state permits no mutation, and
  unresolved state never selects one session. A confirmed unresolved
  disconnection applies to every exact public session source in the stable
  observation rather than choosing one. The browser start request contains
  `connect` or `disconnect` plus the connection revision displayed to the user;
  the coordinator rejects a stale revision, reads the actual current state, and
  applies that direct action atomically. An ordinary Connect request returns the
  current valid connection when one exists. A direct browser Disconnect creates
  the canonical awaiting-confirmation operation; the fixed Disconnect task
  performs the exact confirmation. Changing wallets requires a completed
  Disconnect followed by a new Connect action.
- A successful browser control request returns after the coordinator commits
  the operation's first canonical state. WalletConnect acquisition, approval,
  cancellation, validation, and session deletion continue under coordinator
  ownership while the browser observes those canonical states. The initiating
  browser never waits inside the control request for an SDK effect to finish.
- An MCP wallet-management tool returns the fixed root URL for browser display.
  The MCP operation identifier remains available to the agent for exact polling
  and cancellation but does not appear in the human page path.
- The browser reads the one current operation through the browser wallet route
  registry, then reads the exact retained operation
  by identifier until terminal so the shared dialog can present the result without
  inferring it from disappearance. Confirmation and cancellation carry that
  operation identifier in their action-resource paths for exact identity,
  revision, and stale-tab checks. The identifier is not navigation state or
  browser authority.
- Browser actions allocate the same canonical operation identifier and send
  once, but do not use authenticated owner sessions. A missing or malformed
  action response therefore becomes `delivery_unknown` without retry,
  cancellation, reload, or owner inference. Wallet and token presentation
  retain separate state lifecycles. Locally established delivery uncertainty
  is carried separately from response JSON and is bound to the exact task,
  revision, and operation identifier. The process continues exact canonical
  observation until that operation becomes observable or retention proves it
  absent; response data cannot claim its action, operation identifier, or resend
  policy.
- Exact-operation observation finishes before the browser adopts a successor
  operation. Canonical retention expiry clears the old observation without
  inventing a terminal result. Browser-session expiry or compatible-owner
  replacement reloads the current information page once to obtain a new
  browser request credential and CSRF token. A transport failure is not
  credential evidence and exposes no browser-generated error text.
- When the exact retained operation first reaches a terminal state, the browser
  presents at most one transient non-modal notification for that operation
  identifier. The notification preserves the canonical kind, state, result, and
  failure meaning. Its visual expiry is browser presentation only and never
  changes the operation, its retention, or the wallet connection.
- A background observation failure is not a wallet-operation result. Polling
  retries it without a notification. A failed direct browser control request
  produces an error notification without inventing a terminal operation.
- The Assets page accepts only an account-assets result produced for the current
  connected account. Account or connection-revision change aborts older reads,
  clears their presentation, and starts a new complete browser-overview read.
  The overview contains native balance and one digest-bound partition in which
  every admitted official Stock Token is selected or available to add. It does
  not expose the cursor or page boundaries of the separate canonical
  account-asset collection. A manual refresh retains the last verified
  overview until complete replacement; failure retains it and marks it stale.
- Contextual Analysis uses only the public contract- and token-inspection
  routes declared by the public interface registry and omits
  browser credentials. The browser applies the complete capability validator
  before presentation and performs no source lookup, chain read, evidence
  reconstruction, or digest calculation. A newer inspection or explicit
  cancellation invalidates an older response. One contextual action names one
  admitted contract or token target; a multi-contract result renders a separate
  named Analysis action for each target rather than an ambiguous aggregate
  action. The shared modal cannot open without one of those targets. It
  presents the strongest admitted control and source conclusions, states that
  maliciousness and safety are not established by those observations, and does
  not expose runtime-code hashes, signatures, source records, or digests as a
  substitute for that conclusion.
- The modal host presents exactly one explicit add, removal, information,
  Analysis, wallet-connect, wallet-disconnect, or retained-operation task. A
  task never changes its title or purpose as state changes or preempts an
  active task. The only sequential handoff is an explicit `Remove`
  action: information closes before the exact removal confirmation opens. The
  two tasks never coexist. Add inspects before the operation is admitted.
  Removal uses the current selection revision. The add view consumes the
  available members of the mounted complete official partition, filters them
  locally by normalized name or symbol, and exposes no cursor, pagination
  control, Custom ERC-20 input, or separate candidate-read lifecycle. Search
  remains fixed while only the candidate list scrolls. One exact candidate Add
  action is the
  complete user decision; canonical inspection, operation publication, exact
  review-digest confirmation, and terminal reconciliation remain internal and
  fail-closed. An awaiting-confirmation add operation discovered without the
  transient consent is never auto-confirmed. Information contains token facts,
  the exact contract target, and the current control summary without repeating
  the full contextual Analysis projection; it also owns the separated removal
  handoff. The row has no direct Analysis or removal action. A web-owned removal
  operation exposes its
  declared confirmation or cancellation action; a CLI-owned operation is
  read-only in the browser. Closing information changes presentation only. A
  loading or applying operation keeps its dialog open.
- The Prices list reads every supported current reference value through public
  read routes and keeps pair selection separate from pair evidence and history.
  Every user sees every manifest pair in manifest order. The browser exposes no
  add, remove, reorder, or saved-pair watchlist presentation. The canonical
  account watchlist remains available to its HTTP, MCP, CLI, storage, and
  machine consumers.
- A selected Prices pair detail reads one current price and one exact fixed
  history window through public-read routes. When at least two candles exist,
  it renders a
  non-authoritative candlestick projection from the admitted history and
  exposes pointer and keyboard selection of admitted candles and canonical
  empty intervals. Exact observed high and low,
  represented and observed interval counts, and the selected candle OHLC or
  empty-interval meaning do not depend on the chart provider. A result with
  fewer than two candles does not mount a trend chart. Its semantic details
  present partial or unavailable status, the concise coverage meaning,
  interpretation-changing limitations and warnings, and any unavailable
  reason. The browser renders no separate history table, list, timeline,
  navigation toolbar, coverage card, or raw-evidence view. The admitted result
  retains its complete candle and empty-bucket history, canonical block,
  mapping evidence, configured-RPC reference, and round identity for machine
  consumers without rendering them as the user answer or substituting
  display-derived facts.
- Only a selected Prices pair admits the optional history-window query declared
  by the browser location registry. Duplicate, unknown, malformed, or
  query-bearing non-pair locations fail before a browser credential or page
  shell is issued. Back, Forward, reload, and direct navigation preserve the
  admitted pair and window.
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
  response is reported as `delivery_unknown` through the canonical delivery
  exit mapping; the CLI names
  the exact operation and does not repeat or compensate for that action.
- The account-asset collection command consumes the account-assets application
  and exposes its exact
  canonical collection or the shared human view, including raw balances,
  verified official classification, required token standards, and adjusted
  Stock Token amounts when the current multiplier is available. Both successful wallet-connect
  outcomes perform the same first-page read before return or owner wait. A read
  failure does not relabel or roll back connection success.
- The reference-market price and history commands consume the public
  reference-market read contracts. Their human output preserves the canonical block, mapping
  evidence, source references, round identity and times, status, coverage,
  warnings, and unavailable reason; exact JSON remains the canonical result.
  The watchlist read command returns the connected account's exact ordered
  state. Its mutation commands require an explicit expected revision and use
  the same send-once mutation owner as MCP. An uncertain response uses the
  canonical delivery exit mapping and instructs the caller to read the
  watchlist before deciding whether to act again.
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
- Each nonterminal state has one role. `starting_connection` owns SDK Connect
  acquisition and every exact proposal or pairing it creates; after the SDK
  supplies an approval handle, `awaiting_wallet_approval` observes that exact
  attempt. `cancelling` contains acquisition or that exact attempt through its
  actual settlement and cleanup; and `validating_session` owns approved-topic
  validation, persistence, and cleanup authority.
  `awaiting_confirmation` waits for direct authorization of Disconnect, and
  `disconnecting` performs its bounded SDK session deletion.
- A completed or cancelled mutation is published only after its exact SDK
  settlement and fresh stable postcondition are known. Peer rejection preserves
  the admitted numeric WalletConnect refusal code. SDK, local deadline,
  observation, and validation failures retain their owning public failure
  class. Cleanup attempts every independently addressable proposal, pairing, or
  session even when another cleanup attempt fails; the fresh stable
  postcondition, not an individual SDK return, determines terminal success. A
  late approval after local cancellation is cleaned through the exact attempt
  owner and cannot republish QR or connection authority.
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
- One account for the canonical product chain owned by
  `docs/PRODUCT_POLICY.md` and `productChainId` is required in an approved
  session. Zero or multiple matching accounts fail validation; Little John
  never selects an account silently.
- The coordinator derives accounts, chains, methods, and events from the
  approved session namespaces as defined by the
  [WalletConnect session model](https://docs.walletconnect.network/wallet-sdk/web/usage).
- Connect sends these requirements as WalletConnect optional namespaces.
  Little John, rather than the peer request label, owns mandatory chain, account,
  method, event, and expiry admission after approval.
- The selected account remains usable only while its session exists, is not
  expired, and still contains the canonical product chain, the account, and the
  required method. Product-chain identity and its official source evidence are
  projected by `docs/PRODUCT_POLICY.md`.
- Connection expiry and evidence availability are evaluated by one coordinator
  transition before either agent reads or the browser composite projection is
  produced. Consumers do not apply separate freshness rules.
- A connected-address cache is display and lookup data only.
- An approved active session carries later transaction requests through the
  WalletConnect relay. A new QR is not created for each transaction.
- A new QR is required when no valid session or reusable pairing remains.
- A new session approval is required when the required chain, account, or method
  is outside the current approved namespaces.
- Storage or SDK observation failure makes connection evidence unavailable; it
  never produces healthy absence. Session disappearance, expiry, or removal of
  the selected account changes the public projection only after a new stable
  observation. Callback names do not become public causes.

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

- The fixed local origin is `http://127.0.0.1:46630`; the server binds only to
  that origin's host and port.
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
