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
browser content under the current route and request-security registries.
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
dependencies, local processes, persistence, MCP App, Browser, and CLI
surfaces, WalletConnect session ownership, local credentials, and the loopback
HTTP boundary. Sections after Current State define required architecture and
do not claim that it is implemented. Product availability is owned by
`docs/PRODUCT_POLICY.md#current-support`. Transaction and wallet-request
authority are owned by `docs/TRANSACTION_POLICY.md`.

## Runtime Shape

The product interface set owned by
`docs/PRODUCT_POLICY.md#product-scope` binds one modular runtime with MCP over
stdio, MCP App resources and Views, an interactive CLI, a native loopback
backend, local SQLite product state, and the WalletConnect session boundary
defined here. An unavailable interface changes neither another binding nor
the runtime's process, store, transport, or authority model.

## Repository Ownership

This repository owns:

- local runtime and configuration;
- MCP tools, resources, and self-contained App Views;
- native loopback HTTP reads and compatible-process controls;
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
| `review` | Transaction intent, account binding, commitments, freshness, and transaction Review state |
| `wallet` | WalletConnect sessions and exact reviewed-request handoff |
| `token-catalog` | Token inspection and account-specific selection contracts |
| `account-assets` | Stable connected-account selection, classification, standard, and balance reads |
| `receipt-activity` | Transactions, receipts, traces, finality, and actual state deltas |
| `interfaces` | MCP, MCP App presentation, native loopback HTTP, and interactive CLI |
| `runtime` | Composition root, SQLite, configuration, HTTP ownership, and feature gates |

## Dependency Rules

- `core` imports no provider, protocol SDK, wallet SDK, React, HTTP, or SQLite
  implementation.
- Server modules consume the curated `core/index` entry point. Interface-safe
  error definitions, shared operation contracts, MCP App renderers, and CLI
  projections consume one curated interface-safe core entry point. No other
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
- MCP App renderers consume admitted canonical results and never call chain
  RPC, quote providers, protocol SDKs, or protocol adapters directly.
- MCP App and CLI never initialize WalletConnect or own WalletConnect
  sessions.
- MCP never calls concrete protocol adapters directly.
- Protocol adapters never call WalletConnect.
- Only `wallet` owns WalletConnect sessions and secrets.
- Only `review` creates the transaction Review states defined by
  `docs/TRANSACTION_POLICY.md#review-and-simulation`.
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
| Robinhood official-asset API | Binding source authority | `docs/EVIDENCE_POLICY.md` owns source authority; `officialAssetSourceDefinition` and the registry source contract own the exact source identity, normalized observed-or-unavailable read result, evidence, and storage ports | `src/registry/official-assets.ts` owns request and response admission, endpoint consumption, transport behavior, deadlines, and operational limits | Runtime composition constructs one source client; registry synchronization consumes its value result and the product-owned store without an exception translation layer; replacing the membership source changes the binding evidence authority |
| Robinhood StockFactory | Binding source authority | `docs/EVIDENCE_POLICY.md` owns the independent UID-to-token-address proof meaning; `stockFactoryAdmissionManifest` and the registry verification contract own the admitted deployment identity and identity-bearing verification result | `src/registry/stock-factory.ts` owns StockFactory call and identity verification behind the pinned-block `OfficialAssetChainReadPort` in `src/chain/official-assets.ts`; common RPC configuration remains with the chain transport | The chain application constructs the port and preserves the same result contract for single and batch reads used by account-assets and token inspection; changing verification internals preserves the admitted identity, while changing the deployment or source owner changes the manifest and evidence authority |
| Chainlink Data Feeds | Binding source authority | `docs/EVIDENCE_POLICY.md` owns source authority and evidence meaning; `referenceMarketManifest` owns the admitted directory identity and exact feed mappings; `docs/NUMERIC_POLICY.md` owns reference-price, cross-price, and candle meaning; `market-portfolio` and the canonical reference-market application contracts own admitted price and history result lifecycles | `src/chain/reference-market.ts` owns Data Feed call encoding, round admission, response validation, and batch fallback behind `ReferenceMarketChainReadPort`; common RPC configuration remains with the chain transport | The chain application constructs the port and runtime composition passes it to `market-portfolio`; changing a mapping changes the manifest, and replacing Chainlink with another source owner requires an accepted evidence or product-policy change |
| Sourcify API v2 | Replaceable implementation provider | `intelligence` owns `ContractSourceVerificationPort`, its normalized results and failures, evidence requirements, and lifecycle | `src/intelligence/sourcify.ts` owns the origin, path, request and response admission, deadline, response-size and concurrency limits, cleanup, and provider identity | Runtime composition constructs one Sourcify adapter and passes only `ContractSourceVerificationPort` to the shared contract-analysis process |
| Uniswap V2 | Binding protocol identity | `docs/PROTOCOL_ADAPTERS.md` and `src/protocols/uniswap-v2` own the exact V2 package, deployment records, native mapping, and capability registration; `docs/NUMERIC_POLICY.md` owns numeric meaning and `docs/EVIDENCE_POLICY.md` owns evidence meaning | `src/protocols/uniswap-v2/sdk.ts` owns the pinned Uniswap SDK loading and admission boundary; the package owns immutable deployment and route-asset records | Runtime composition constructs the statically registered V2 package once and passes only its canonical quote binding to interfaces |
| Lightweight Charts | Replaceable implementation provider | The browser interface owns `ReferenceChartPort`; admitted reference history and `docs/NUMERIC_POLICY.md` own the exact values and permitted ephemeral chart projection | `src/interfaces/web/lightweight-charts-adapter.tsx` owns package loading, chart options, event admission, failure normalization, subscriptions, and destruction | `src/interfaces/web/main.tsx` constructs one adapter; only a selected Prices pair detail requests the dynamic package chunk and receives `ReferenceChartPort` |

This table contains implemented external integrations only. The implementation
task that adds or removes an integration updates the table after the runtime
boundary exists or is removed. A proposed, researched, or unavailable
integration remains in its task plan or research material and is not listed as
current architecture.

### MCP Apps Integration Requirements

The official Model Context Protocol Apps extension is a binding product
transport. The official extension owns resource, View, initialization, and
tool-visibility protocol meaning. Little John's canonical contracts own every
result, Review, operation, and action meaning.

`interfaces/mcp-app` owns the self-contained App resources, standard
capability admission, presentation descriptors, exact snapshot transport,
View bridge, typed renderers, and transport-only Host adapters. Runtime owns
the immutable presentation-snapshot store. Existing MCP bindings attach App
presentation to canonical tools without changing those tools' admitted text,
structured result, failure, or availability meaning.

Codex and Claude are replaceable MCP Apps Host providers. A connection uses
the standard MCP Apps capability, nested metadata, resource, result, and
bridge contracts first. Exact MCP `clientInfo.name` may select a server-side
adapter only after the required standard server signal is absent or physically
unusable. Exact View `hostInfo.name` may select a View-side adapter only after
standard View initialization and only for a measured View transport defect.
Server and View identity are never inferred from one another, and Host version
never selects product behavior.

The admitted Host adapters are closed:

- the Codex server adapter adds the Host-required output-template association
  only when exact `codex-mcp-client` identity omits the standard UI
  capability;
- the Codex View adapter unwraps only the measured single JSON text wrapper in
  exact `chatgpt` View Host identity; and
- the Claude View adapter admits only the strict same-result descriptor from
  View-private metadata when exact `Claude` View Host identity omits the
  standard result resource link.

Each adapter supplies only the missing transport fact and then enters the same
descriptor, byte, digest, canonical-admission, lifecycle, and renderer owners.
It cannot select a snapshot, read domain state, change canonical meaning, or
grant action authority. When the Host physically supplies the corresponding
standard primitive, the standard path handles that primitive and the adapter
is deleted in the same Host-support change. There is no version branch,
generic Host registry, guessed identity, or compatibility reader.

An MCP connection that does not admit the App transport retains ordinary MCP
text and structured results. It receives no App resource or App-only
authority. A bridge that transports tools but not resources therefore cannot
present an App on that connection. Product interface selection and
non-fallback meaning are owned by
`docs/PRODUCT_POLICY.md#product-scope`.

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

The composition root may import one provider construction or registration
entry point. When an owning application factory already owns the complete
external resource lifecycle, the current-integration table may designate that
factory as the sole construction boundary instead. No handler, renderer,
durable store, or unrelated feature imports the provider adapter. A
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
module export and import graph without copying the complete classification
into a test. Integrated review traces current source identities, adapters, SDK
imports, protocol registration, interface providers, and runtime composition
to the table and traces every table row back to implementation.
Provider-specific imports and literals remain in the adapter owner, only the
declared composition boundary constructs the adapter, consumers use
product-owned ports, and independent tests do not derive their oracle from the
provider implementation.

### Contract Analysis Boundary

The `intelligence` module owns the ordered contract-analysis process used by
contract and token inspection. Core owns the serializable analysis contract,
target-dependent relation validation, and public evidence declarations.
`chain` implements one narrow `ContractAnalysisChainReadPort` whose instance is
already bound to one canonical block. The port exposes only the named runtime
code, supported proxy, owner, pause, and default-administrator reads; it does
not expose arbitrary RPC methods, calldata, storage slots, batching controls,
or block selection.

The `intelligence` process applies one supported-marker observer to the target
and once to a candidate first-hop implementation. Candidate inspection reuses
the aggregate EIP-1967 storage port call, whose Chain implementation owns the
implementation, beacon, and administrator slot requests. A candidate with a
supported or ambiguous marker remains unresolved with its first-hop and
terminality observations retained. The process never follows that marker,
calls a candidate beacon, or sends the candidate to source verification or
ABI-dependent control reads as an effective implementation.

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

Complete public capability validation is interface-safe and owns input
parsing, target-dependent result checks, public source-record digest
comparison, evidence replay, and result-size admission. Node-only capability
execution separately owns bindings, invocation identifiers, handler execution,
and live observation recording. An interface, transport, or stored-result
reader does not implement a weaker result parser.

## Interface Contract Model

- Canonical semantic contract ownership and projection follow
  `../AGENTS.md#interface-contract-policy`. This section owns only Little John's
  runtime binding, registry, transport, path, and correlation architecture.
- MCP uses the protocol's
  [JSON-RPC tool surface](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
  through the official SDK. Little John does not define a second agent JSON-RPC
  protocol or duplicate MCP tool catalog.
- Compatible-process control resources are private owner IPC consumed by MCP and
  CLI adapters. They are not agent-facing URLs and do not redefine the MCP
  contract.
- Machine-interface identity catalogs bind canonical contracts to their MCP,
  native HTTP, and CLI identities. A separate closed presentation registry
  binds an exact canonical contract object to its canonical serializer and
  parser, deterministic MCP text projection, and typed MCP App renderer. The
  registry never reconstructs a contract from a string identifier and
  contains no generic JSON renderer.
- MCP App presentation is connection-local metadata on a canonical MCP
  result, not another canonical binding or support-manifest axis. The standard
  resource and View path and the exact Host adapters in
  [MCP Apps Integration Requirements](#mcp-apps-integration-requirements) are
  transport projections only.
- Every MCP tool declares an explicit visibility tuple. Model-visible
  handlers are safe when called by either a model or a View: they read
  canonical state or construct an immutable Review and perform no domain
  mutation or external effect. App-only handlers may invoke a direct domain
  decision only after the canonical Review and current preconditions are
  independently re-admitted.
- MCP App initialization reports connection-local presentation and action
  capability. MCP read availability remains the canonical support value.
  `mcp_app` records the provenance of a direct decision and is neither a
  static support axis nor a domain-state lock.
- Native HTTP resource paths identify backend reads or compatible-process
  controls. They are not human navigation locations. An MCP tool name
  identifies one MCP operation and an App resource URI identifies executable
  presentation, never domain data.
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
- The compatible-process operation client sends each complete direct decision
  and permitted Wallet cancellation once and validates the response through
  the binding catalog. The domain Review owner supplies the reserved operation
  ID; the client never allocates, replaces, or rewrites it. Callers supply an
  opaque catalog identity and admitted input. Control-resource descriptors own
  each exact method and path, and route registration and local-operation
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
- Runtime owns one immutable presentation-snapshot store in product SQLite.
  It retains the lossless normalized canonical input and admitted canonical
  result bytes required for exact App redisplay. The stored input is used only
  to repeat the owning contract's result admission; it is never submitted to
  domain execution or used as an evidence source, current-state cache, or CLI
  dependency.
- View layout, disclosure, focus, scroll, and mount state are ephemeral Host
  state. Cookies, local storage, session storage, IndexedDB, Host widget
  state, and mount identifiers never select a snapshot or operation and
  contain no wallet secret, signing material, QR material, or action
  authority.
- Store and domain-coordinator transitions own lifecycle rules. MCP, MCP App,
  native HTTP, and CLI map those transitions and do not reimplement them.
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
  publication, and cleanup. The operation, immutable Review digest, expected
  state, and domain subject revision are bound before the effect begins. The
  initiating interface is recorded only as provenance.
- A local Little John profile admits zero or one valid WalletConnect session as
  connected and zero or one nonterminal wallet management operation. A pending
  pairing proposal is operation state, not a session. Multiple or invalid SDK
  sessions remain visible as unresolved state; Little John does not choose one.
- MCP App and CLI send admitted commands to the coordinator and consume its
  connection and exact operation read models. They never copy session topics,
  keys, or signing authority into interface state.
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
  It reconciles a durable nonterminal Wallet operation under
  [Durable Operation Ownership](#durable-operation-ownership) and never
  resends its external effect.

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

Every product write checks the retained main-file lease before entering its
SQLite transaction and again before commit. Successful commit is the final
reported write outcome; a later operation rechecks the lease as its own
precondition. Read operations continue to check the lease before and after
their non-durable observation.

The persisted owner projection contains only a fixed singleton identity plus
the profile, owner instance, configuration identifier, process ID, owner
revision, and acquisition time. The application record omits the singleton and
carries the remaining six admitted values. No stored or live owner field acts
as a runtime wire-version selector.

The product schema persists local profile and runtime-owner identity, trusted
chain configuration, admitted reference-feed history and synchronization
state, official-asset snapshots, verified contracts and token inspections,
durable wallet-account identity and the current secret-free connection
projection, account watchlists, account token-selection state, immutable
presentation snapshots, and exact domain operations. The exact table names and
their SQL relationships are read from the SQLite schema owner, not maintained
as an independent documentation contract.

An official-asset snapshot stores the exact admitted source URI with its source
observation and members. Snapshot replacement writes that URI, and every
subsequent read admits the stored value through the same snapshot contract; the
database never reconstructs provenance from the current build constant.

The connection projection includes one secret-free `revalidation_required`
boolean. It records only a contradiction or ambiguous product write that
Little John itself admitted and that the SDK may not retain. It is not a session copy,
event log, owner marker, generation, or source selector. A stable empty SDK
observation clears it atomically with the disconnected projection.

The connection projection is not the durable owner of account identity. A
validated connected transition inserts or reuses its exact wallet-account row
and replaces the projection in one transaction. A nonconnected transition
changes only the projection and never deletes a wallet-account row.

Wallet, token-selection, and reference-watchlist operations are durable exact
resources under [Durable Operation Ownership](#durable-operation-ownership).
Pairing URI and QR material remain owner-memory presentation state and never
enter the canonical operation, product SQLite, or the WalletConnect public
store projection.

The account-assets application is the sole owner of the connected-account asset
read. On a first-page read it atomically captures the active wallet and attempts
one bounded official-source synchronization before entering one chain
invocation. Synchronization returns either the committed snapshot or the exact
unavailable reason and retained stored revision; persistence and other local
failures are not translated into that result. The invocation resolves one
opaque canonical block, initializes
the exact ordered defaults once for that account after verifying them at that
block, and reads one bounded included-selection page at the same block. Default
initialization is one optional atomic mutation: if any missing default cannot be
verified, no partial initialization is committed, the read continues with the
existing selections and native balance, and a later first-page read may retry.
Later pages preserve the admitted official-snapshot status, revision,
unavailability reason, and selection-set revision while resolving a fresh block
in their own invocation. The view revision and cursor make the unavailable
reason a required member of only the unavailable state, so an exact or later-page
read cannot reconstruct a different source outcome. The account-assets owner
retains only its current synchronization observation and admits a continuation
or exact request only when its status, revision, and unavailable reason match
that owner state. Every list, overview, and exact result repeats that comparison
at its public-success boundary. A later synchronization with the same canonical
correlation value does not invalidate an in-flight read; a different value does.
Owner close or process restart removes the correlation and requires a fresh
overview or first page. Each visible official
member is verified against StockFactory before it is classified as a Robinhood
Stock Token. Single and batch verification use the same identity-bearing result;
the account-assets owner rejects a missing, duplicate, unexpected, reordered,
or member-mismatched result instead of recovering identity from array position.
An unavailable official snapshot retains only its admitted source outcome and
stored revision, while a current member whose StockFactory verification is
unavailable retains that member and verification outcome as a different
classification cause. Caller cancellation, runtime request capacity, and owner
closure fail the whole account read and do not publish a partial classification.
The account-assets view derives one human identity and classification
presentation from that admitted result; MCP App and CLI consumers use that
projection without reconstructing a name, membership, or failure explanation.
The application reads ERC-20 metadata, raw balance,
required ERC-8056 observations,
and the native balance through the exact block authority, then rereads the
selection-set revision and recaptures the wallet. It accepts the result only
when the account, connection revision, stable session-source identity, official
snapshot status, revision, unavailable reason when applicable, and selection-set
revision still equal the values consumed by that read. SQLite stores no balance
page, token standard observation, or read error. An interface consumes the
canonical collection or exact result and never reconstructs an overview join,
selection revision, or official-member partition. A failed official
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
One history segment publishes its observations and traversal position together.
A retryable source or transport stop retains completed segments and returns the
bounded committed snapshot with its remaining work explicit; cancellation,
application closure, inconsistent source evidence, and internal failure remain
failures.
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
the repository or client storage. Little John restricts their filesystem
access to the current operating-system user and excludes their contents from
application logs, exports, and diagnostic bundles.

## Immutable Presentation Snapshot Ownership

One Runtime-owned SQLite store retains exact admitted input/result pairs for
MCP App redisplay. A snapshot is a presentation replay cache. Domain
applications, evidence owners, operation transitions, CLI projections, and
support projection cannot read it, execute its stored input, or derive
availability from it.

The closed presentation registry binds an existing canonical contract object
to its contract ID, contract version, input parser, public-result parser,
canonical serializer, deterministic MCP text projection, and typed renderer.
It never reconstructs a contract from a string identifier. After the contract
normalizes and admits input and admits its correlated result, the registry
captures each value as canonical JSON and encodes it once as UTF-8. Canonical
input is at most the unchanged `65,536`-byte compatible-process request bound;
canonical result is at most the canonical capability-success bound of
`8,388,607` bytes. Raw MCP or HTTP envelopes, headers, Host metadata, user
messages, credentials, WalletConnect material, and signing material are not
snapshot input.

For canonical input bytes `I`, canonical result bytes `R`, contract ID `C`,
and decimal contract version `V`:

- `inputDigest = lowercase_hex(SHA-256(I))`;
- `resultDigest = lowercase_hex(SHA-256(R))`;
- `identityInput` is `C`, NUL, `V`, NUL, the canonical decimal byte length of
  `I`, NUL, `inputDigest`, NUL, the canonical decimal byte length of `R`, NUL,
  and `resultDigest` concatenated in that order;
- `identityDigest = lowercase_hex(SHA-256(UTF-8(identityInput)))`;
- `snapshotId` is `sha256:` followed by `identityDigest`; and
- `snapshotUri` is `littlejohn://presentation/snapshots/sha256/` followed by
  `identityDigest`.

Contract IDs cannot contain NUL and contract versions are positive canonical
base-10 integers. The strict descriptor has kind
`presentation_snapshot_descriptor` and contains only that kind, snapshot URI,
snapshot ID, contract ID and version, the input and result UTF-8 byte lengths
and digests, result-chunk byte limit, and result-chunk count. The chunk byte
limit is `65,536`; the chunk count is the ceiling of the result byte length
divided by the limit. Chunk indexes are zero-based. Every non-final chunk is
exactly `65,536` raw bytes and the final chunk is the remaining nonempty slice.
Result chunks cover `R` once, in order without overlap or gap.

The strict `presentation_snapshot_resource` contains only that kind, the
descriptor, and the normalized canonical input value. Canonically serializing
that input must reproduce the descriptor's input length and digest. The
complete resource response must fit the unchanged internal compatible-process
response limit. Snapshot admission checks this bound before insertion or
advertising.

Retention uses these two independent bounds:

- at most `16,384` distinct snapshots; and
- at most `536,870,912` aggregate input-plus-result canonical bytes.

Equal contract identity, canonical input bytes, and canonical result bytes
reuse one row and do not refresh or mutate it. A new snapshot is admitted only
when both post-insert bounds hold.
The first product schema stores only this pair. There is no result-only row,
compatibility reader, inferred input, or snapshot migration path.
The owner checks identity, count, aggregate bytes, and insertion in one SQLite
transaction. A collision, partial write, lease failure, capacity failure, or
invalid existing row advertises no new snapshot. No snapshot is automatically
expired, evicted, reordered, or selected by insertion time. Only an explicit
complete profile reset removes snapshots.

Snapshot persistence failure never changes the already admitted domain result,
ordinary MCP text or structured output, or CLI output. The affected App
presentation reports `presentation_unavailable` and receives no durable-card
claim. Its reason is exactly one of `capacity_exceeded`,
`runtime_unavailable`, `snapshot_missing`, or `snapshot_inconsistent`.
An input or result above its section bound, a snapshot resource above the
internal response limit, or an insert above either retention bound is
`capacity_exceeded`.
Invalid request syntax remains the owning interface's `invalid_input` failure
and is not converted into a presentation reason. Corruption, identifier
mismatch, invalid canonical UTF-8 or JSON, contract-admission failure, and
missing chunks fail that exact presentation and never cause a domain refresh
or another snapshot lookup. An unrelated valid snapshot remains independently
readable. Existing SQLite schema mismatch keeps the reset behavior defined by
[Local Persistence Boundary](#local-persistence-boundary).

The creating MCP result keeps its canonical structured result. After snapshot
commit it also carries the exact snapshot resource in View-private metadata
and one standard MCP resource link to `snapshotUri`. `resources/read` accepts
only that canonical URI and returns the bounded snapshot resource, never `R`.
`presentation_get_snapshot` is a pure model-visible tool that accepts only the
exact URI, re-admits the retained input/result pair, and returns one strict
`presentation_snapshot_reference` with the same link and descriptor; it copies
no retained payload into its structured result and attaches the exact snapshot
resource only in View-private metadata.
`presentation_get_snapshot_chunk` is App-only and accepts only an admitted
snapshot ID and result-chunk index. It returns one strict
`presentation_snapshot_chunk` containing that ID, index, and RFC 4648 Base64
with required padding and no whitespace for the exact result slice.
Decoding and encoding again must reproduce the identical string. None of these
owners exposes a current, latest, default, list, mount, or descriptor-free
lookup.

The View validates the snapshot resource, descriptor, and snapshot identity;
canonically serializes and verifies the carried input; and parses that input
through the registry entry. When the creating result carries a complete
canonical structured result, the View canonically serializes it and verifies
the descriptor's result length and digest. Otherwise it reconstructs the
result through its exact sequential result chunks, decodes base64, joins raw
bytes, verifies total length and digest, performs one fatal UTF-8 decode, and
verifies canonical JSON. The same registry entry fully re-admits the correlated
result before renderer dispatch. JavaScript string indexes never own chunk
boundaries.

## Durable Operation Ownership

Wallet, token-selection, and reference-watchlist own separate operation stores
and canonical contracts. They may share primitive operation IDs, canonical
JSON capture, and SQLite transaction utilities, but no configurable operation
framework owns their Review meaning, revalidation order, effects, failures,
or restart behavior.

A model-visible Review is immutable and performs no domain mutation or
external effect. It contains one reserved, unstored operation ID, creation
time, one server-owned action deadline exactly `300,000` milliseconds after
creation, exact decision facts, fixed evidence anchors, one closed domain
precondition value, and a domain-owned digest. Presentation may retain the
already admitted Review under the snapshot contract; that cache write does
not occupy an operation slot or grant action authority.

An App-only call or interactive CLI decision carries the complete canonical
Review. The domain owner performs this order:

1. re-admit the Review and recompute its digest;
2. return an existing exact operation when the same ID, domain, kind, target,
   and digest already exist;
3. reject conflicting ID reuse or an expired unacted Review with no write or
   effect;
4. recapture and compare the complete current precondition value;
5. repeat only the bounded source reads required to derive the same decision
   at the Review's original evidence identities, revisions, and chain anchors;
6. require the same admitted decision facts and digest without substituting a
   newer source, block, or evaluation time; and
7. perform the domain's single conditional transition or return its owning
   failure with no operation and no effect.

The complete Review and direct-action envelope remain within the unchanged
`65,536`-byte compatible-process request limit. A Review contains a bounded
decision projection rather than another capability's complete result. Domain
contract modules own the exact fields and generated maximum envelope.

Every stored operation contains its operation ID, domain kind, informational
`initiatedBy` value `cli` or `mcp_app`, immutable verified Review and digest,
creation time, deadline where applicable, exact state, and the one result,
failure, peer refusal, or empty terminal outcome admitted by that state.
`initiatedBy` is provenance and never prevents an exact read or permitted
Wallet cancellation from the other direct interface.

There is no general operation revision. Operation ID, immutable Review digest,
exact expected state, and domain subject revision are the predecessor
identity.
Every transition is one conditional SQLite update or transaction over that
identity. A terminal row cannot change and has no automatic retention expiry.
Only complete profile reset removes it. Exact reads require the
domain-specific operation ID and never consult a current-operation resource.

Only Wallet has nonterminal operations. SQLite enforces zero or one active
Wallet operation for a profile from the owning nonterminal-state set. A Wallet
decision commits its exact pre-effect state before the first SDK call. A
connect commits `starting_connection`; after the SDK provides an approval
handle, the owner commits `awaiting_wallet_approval` before exposing QR. A
disconnect commits `disconnecting` before its single SDK deletion call.
Restart never resends connect or disconnect.

After the first SDK call begins, one Wallet post-effect reconciliation owner
handles every ambiguous SDK outcome and every failure to commit a successor.
It retains the durable predecessor, publishes no uncommitted QR or result,
never repeats the SDK effect, and uses bounded stable observation and
containment to admit the exact successor. If persistence remains unavailable,
Wallet authority is unavailable and the predecessor remains for startup
reconciliation; no interface fabricates or advances an outcome.

Wallet connect uses `starting_connection`, `awaiting_wallet_approval`,
`validating_session`, and `cancelling`; disconnect uses `disconnecting`.
Wallet terminal states are `completed`, `cancelled`, `rejected`, `expired`,
and `failed`. Cancellation applies only to an active connect attempt. It first
commits `cancelling` with the exact terminal target and then contains the
owned attempt. The owner deadline, not a View timer, settles expiry.

At startup, a terminal Wallet operation is admitted unchanged. For a
nonterminal connect, one stable valid session matching the persisted Review
may complete the operation. Otherwise the Wallet adapter expires every pending
proposal, disconnects each pairing not referenced by an admitted session,
performs a second bounded stable observation, and settles the operation to its
stored cancellation or expiry target, or to `failed` when success cannot be
proved. It never reconstructs QR or resends connect. `disconnecting` becomes
completed only when stable observation proves the reviewed session absent; a
retained or unavailable session produces `failed` without resend. Malformed,
multiple, conflicting, or unbounded SDK collections make Wallet authority
unavailable rather than fabricating cleanup or completion.

Token-selection and reference-watchlist actions have no nonterminal state.
Each owner revalidates its Review and atomically commits the domain mutation
and immutable `completed` operation in one SQLite transaction. A rejected
revalidation or failed transaction commits neither. Duplicate delivery
returns the stored terminal operation and never repeats the mutation. Startup
requires only schema admission of those terminal rows.

Pairing URI and QR matrix are exact active-operation presentation material.
They remain only in the Wallet owner memory and App-private or direct TTY
presentation, never in product SQLite, logs, model-visible MCP output, URLs,
or durable evidence. QR is visible only for the exact unexpired
`awaiting_wallet_approval` operation. Approval, refusal, cancellation, expiry,
failure, owner loss, or validated completion removes it before the successor
is published. Scanning alone is not completion; one validated session is.

## MCP App View Lifecycle

One `interfaces/mcp-app` owner implements two process families over typed
inputs: immutable presentation and exact-operation presentation. The
exact-operation family has two closed flows: atomic decision to terminal and
Wallet observation. These flows share admission and terminal adoption but do
not configure, reorder, or emulate one another. A renderer owns semantic DOM
and SVG only and cannot make tool calls or configure lifecycle order.

The immutable process admits one creating result or exact snapshot reference,
selects the standard transport before an exact Host adapter, admits the linked
snapshot resource, obtains and verifies the exact normalized input and canonical
result, dispatches through the presentation registry, and renders without
polling or a domain read.

When the result carries the complete canonical structured result and
snapshot resource, the View uses both directly. When the resource is absent,
the View may read only the exact linked snapshot resource and only when View
initialization reports `serverResources`. A View that has neither a complete
resource nor `serverResources` fails that presentation without guessing a
descriptor or reading domain state. After resource admission, missing result
bytes are obtained only through the exact sequential snapshot-chunk path.

Both decision processes first admit the immutable Review and perform one
immediate exact read of its reserved operation ID. `operation_not_found` means
no decision has been admitted and leaves an unexpired Review actionable only
when standard View initialization reports `serverTools`. An existing
operation replaces only controls and operation status. It never refreshes the
Review subject.

The token-selection and reference-watchlist process disables its controls
before one direct action. That call returns either the atomically stored
terminal operation or an owning failure. It performs no automatic observation
and never repeats the action.

The Wallet process disables its controls before one direct action. After that
action returns a nonterminal operation, or when the initial exact read returns
one, the View waits `500` milliseconds after the preceding call settles before
starting the next exact-operation read. It permits at most one in-flight read.
A late result from a closed lifecycle is ignored. Terminal adoption, teardown,
owner loss, or an action failure removes automatic observation. A read failure
disables mutation controls and permits only an explicit retry of the same
exact operation. No rule depends on Host cancellation propagation or a
teardown callback receipt.

A terminal operation is rendered from its complete admitted value and causes
permanent removal of polling, QR, countdown, and action controls for that
View. Creating another View for the exact Review re-admits the same Review
snapshot, reads only its reserved operation ID, and adopts the stored terminal
value. It never calls a current domain read. Host redelivery and View-local
state may optimize display but are not replay authority.

## Human Interface Surfaces

- Product interface access and selection are owned by
  `docs/PRODUCT_POLICY.md#product-scope`.
- MCP keeps useful text and structured results whether App presentation is
  available on the connection. App metadata never replaces the admitted MCP
  result.
- Immutable App renderers exist only for account assets, reference price,
  fixed reference history, reference-pair watchlist, contract inspection,
  token inspection, Wallet connection, token selection, and token-selection
  list.
  Another canonical read remains MCP text and structured output plus CLI where
  declared; it does not enter a generic JSON View.
- Each immutable card presents only the canonical result correlated with its
  creating normalized input or exact retained snapshot. It has no navigation
  shell, current-value refresh, global dashboard, local HTTP request, domain
  read, or client-storage recovery.
- Fixed reference history may render accessible semantic HTML and SVG from its
  exact admitted candles and empty intervals. It never performs another price
  or history read and never treats chart coordinates as canonical values.
- An immutable Review card presents Wallet connection or disconnection,
  token-selection addition or removal, or reference-watchlist addition,
  removal, or reordering. Constructing, displaying, dismissing, or displaying
  that Review again performs no domain mutation and occupies no operation
  slot.
- App-only controls appear only after standard View initialization reports
  `serverTools`. A Host is trusted to broker that direct control call, but the
  domain owner independently re-admits the complete Review and revalidates its
  current preconditions and fixed evidence anchors.
- A model-visible handler is pure even when a Host incorrectly forwards a View
  call to it. No model-visible handler creates a Wallet request, domain
  operation, token selection, watchlist mutation, transaction grant, or
  external effect.
- An active operation card observes only its exact Wallet operation under
  [MCP App View Lifecycle](#mcp-app-view-lifecycle). It never refreshes
  account, market, asset, contract, Wallet, watchlist, or token-selection
  facts.
- QR appears only in App-private metadata for the exact active Wallet
  operation and in direct interactive CLI presentation. Product privacy and
  Host-observation meaning are owned by
  `docs/PRODUCT_POLICY.md#product-philosophy`.
- A terminal card presents only the immutable exact operation. Completed
  connection, wallet refusal, cancellation, expiry, and failure retain their
  distinct terminal meaning while exposing no QR material.
- The local loopback server has no independently navigable information page,
  Browser credential, Cookie, CSRF authority, Browser session, Browser
  capability binding, or Browser asset service. It remains the native backend
  and compatible-process transport defined by [HTTP Boundary](#http-boundary).
- Human information order, semantic roles, responsive composition, and
  accessibility are owned by `docs/USER_INTERFACE_POLICY.md`.

## Interface Selection

- MCP App and CLI direct decisions enter the same domain owners; they are not
  separate Wallet modes.
- No Wallet or domain state stores or infers an interface choice. Host
  capability controls only connection-local App availability and never selects
  another interface or changes domain state.
- An immutable Review is not locked to an interface. MCP App or interactive
  CLI may present the same admitted Review and exact operation. The first
  valid direct decision commits through the domain owner; duplicate delivery
  returns the same stored operation.
- `initiatedBy: mcp_app | cli` records the accepted decision's provenance. It
  grants no later authority and does not make an exact operation read-only in
  the other interface.
- MCP stdio is the transport and session gateway for Apps. A model-visible MCP
  call may create a pure immutable Review but cannot make a direct decision or
  issue a WalletConnect request.
- App action availability is admitted after View initialization. A View
  without `serverTools` presents immutable information only and creates no
  operation or mutation.
- CLI action availability requires a live interactive TTY. Piped or redirected
  input cannot make a direct decision.
- Terminal capacity changes only CLI QR presentation and never changes
  interface choice, operation state, or authority.
- Cancellation is a direct exact-operation action available only for the
  active Wallet connect states declared by the Wallet owner. It is not an
  interface transfer or a transaction confirmation.

## CLI Surface

- Read operations render deterministic human text and lossless canonical JSON
  without requiring MCP App or another user interface.
- The CLI is a client of the shared local runtime and does not start a
  separate Wallet coordinator or maintain separate product state.
- CLI consumes the same canonical results, immutable Reviews, durable
  operations, commitments, WalletConnect session, and receipt verification as
  MCP and MCP App. It never consumes App markup or presentation snapshots.
- Wallet connection, Wallet cancellation, token-selection changes, watchlist
  changes, and transaction confirmation require an interactive TTY.
- CLI obtains the domain-owned immutable Review, presents it completely, and
  accepts only one exact case-insensitive `y` response. Decline, end of input,
  or interruption before the direct call creates no operation or mutation.
- Once an action send begins, an unproved response is reported as
  `delivery_unknown` through the canonical delivery exit mapping. CLI names
  the exact operation or Review and never repeats or compensates for the
  action.
- CLI may read every durable exact operation. It may cancel only an active
  Wallet connect attempt admitted by the Wallet operation contract.
- The account-asset command exposes its exact canonical collection or shared
  human projection, including raw balances, verified official classification,
  required token standards, and adjusted Stock Token amounts when the current
  multiplier is available. A read failure never relabels or rolls back a
  successful Wallet connection.
- Reference price and history commands preserve canonical block, mapping
  evidence, source references, round identity and times, status, coverage,
  warnings, and unavailable reason. Watchlist commands consume the same Review
  and atomic mutation owner as MCP App.
- The Wallet owner converts a WalletConnect pairing URI to a QR matrix and
  discards the URI. CLI receives only the complete admitted matrix and never
  prints or serializes the raw URI.
- Pairing URI and terminal QR output never enter MCP results, redirected
  stdout, product logs, shell arguments, durable evidence, or activity
  records.
  A terminal transcript made outside Little John remains outside its control.
- CLI confines QR to an alternate terminal screen with the cursor hidden and
  restores the primary screen after approval, refusal, cancellation, expiry,
  dimension failure, or controlled exit.
- CLI derives required rows and columns from the complete matrix and
  four-module quiet zone. Required width includes one unused terminal column
  so the raster cannot enter automatic right-margin wrapping.
- CLI renders only a complete undistorted matrix when both dimensions are
  known and sufficient. Otherwise it renders no QR, reports the current or
  unknown and exact required dimensions, and continues observing the same
  exact operation.
- Compact rendering uses one-cell Unicode half-block glyphs. Scanability is
  claimed only for terminal profiles that pass the physical Wallet check;
  ambiguous-width behavior is not inferred from locale or static width data.
- A catchable termination signal is latched before readline or terminal
  cleanup. Before direct decision it prevents an action. During a cancellable
  Wallet operation it starts cancellation of that exact operation before
  removing QR.
- A terminal presentation or exact-observation failure uses only the recovery
  admitted by the operation contract. It never authorizes a second operation.
- Transaction authorization is defined by
  `docs/TRANSACTION_POLICY.md#confirmation-authority`.

## Wallet Connection Lifecycle

- Wallet connection creates or restores the profile's only server-owned live
  WalletConnect session.
- Constructing a Wallet Review, directly deciding it in MCP App or interactive
  CLI, and approving a WalletConnect proposal in the external wallet are
  separate actions. Pairing and session approval never authorize a
  transaction.
- One Wallet coordinator owns connection, disconnection, cancellation, stable
  observation, durable operation transitions, QR lifetime, SDK effects, and
  startup reconciliation.
- A connect Review is available only from a clean disconnected state at the
  displayed connection revision. A valid current session returns the current
  connection and creates no operation. Unresolved state permits no connect and
  never selects or deletes a session.
- A disconnect Review binds the exact admitted session set and connection
  revision. No-session state returns `already_disconnected` without an SDK
  effect. A changed revision rejects the action before operation creation.
- Changing wallets remains two decisions: disconnect must complete, then a new
  connect Review may be created. Failed or unresolved disconnection never
  starts pairing.
- A direct valid connect decision creates `starting_connection` durably before
  SDK acquisition. The exact attempt may advance through
  `awaiting_wallet_approval`, `validating_session`, and `cancelling` before a
  terminal state.
- A direct valid disconnect decision creates `disconnecting` durably before
  its single SDK deletion call. It has no pending confirmation operation.
- Completed, cancelled, rejected, expired, and failed states are published
  only after the exact SDK settlement and stable postcondition required by
  [Durable Operation Ownership](#durable-operation-ownership).
- A public Wallet cancellation binds the exact operation ID, Review digest,
  expected active state, and connection revision captured by that operation.
  A concurrent successor wins through the conditional durable transition.
- One account for the canonical product chain is required in an approved
  session. Zero or multiple matching accounts fail validation; Little John
  never selects an account silently.
- Approved namespaces are admitted from the external wallet under the official
  WalletConnect session model. Little John validates canonical chain, account,
  required methods and events, expiry, and stable session-source identity.
- The selected account remains usable only while that exact admitted session
  exists, is not expired, and retains the required namespace. Product-chain
  identity remains owned by `docs/PRODUCT_POLICY.md`.
- Connection expiry and evidence availability are evaluated by one coordinator
  transition before any interface result is produced. Consumers do not apply
  separate freshness or session-selection rules.
- An approved active session carries later transaction requests through the
  WalletConnect relay. A new QR is not created for each transaction. A new QR
  is required only when no valid approved session exists and a new connect
  operation is admitted.
- A new session approval is required when the required chain, account, or
  method is outside current approved namespaces.
- Storage or SDK observation failure makes connection evidence unavailable; it
  never produces healthy absence. Session disappearance, expiry, or account
  removal changes the public projection only after a new stable observation.
  Callback names never become public causes.

## Local Authority Taxonomy

These values have separate authority and are never interchangeable:

- A `local control credential` authenticates a native Little John process or
  CLI to the loopback owner. It permits only the declared control resource and
  never proves a direct App or CLI decision, Wallet approval, signature, or
  transaction confirmation.
- A presentation snapshot ID and URI select one immutable admitted
  input/result pair whose result is displayed. They are not credentials,
  evidence, operation identifiers, or action authority. The stored input may
  validate the paired result but cannot initiate domain execution.
- A reserved operation ID correlates an immutable Review with a possible
  future exact operation. It grants no action and is not stored until a direct
  decision is admitted.
- A durable operation ID selects one exact domain operation for read and,
  where declared, Wallet cancellation. It cannot authorize a state change
  without complete Review re-admission and the domain owner's current checks.
- A Review digest proves equality with the complete canonical Review under its
  owning contract. It is not secret and does not prove a physical click.
- App-only visibility separates Host-routed controls from model-visible tools.
  The admitted Host is the UI-call trust boundary; visibility is not a custom
  credential or cryptographic user-gesture attestation.
- A transaction `confirmation grant` is server-owned, single-use authority
  created and consumed under
  `docs/TRANSACTION_POLICY.md#confirmation-authority`. It is never returned to
  an interface.
- A WalletConnect session is SDK-owned protocol state for approved
  namespaces, accounts, methods, events, and expiry. It is neither local
  authentication nor confirmation of a Wallet-management or transaction
  Review.

Local control credentials and WalletConnect secrets remain owner-only and are
excluded from URLs, logs, product evidence, presentation snapshots, MCP
output, and client storage. Snapshot references, Review digests, and operation
IDs may appear only in the canonical contracts that declare them and never
gain secret or authorization meaning from their placement.

## HTTP Boundary

- The native loopback endpoint is `http://127.0.0.1:46630`; the server binds
  only to that host and port.
- The endpoint is backend transport, not a user-facing web origin. It serves
  no HTML, App resource, navigation path, Cookie, browser session, or CSRF
  token.
- Compatible-process and CLI state changes require the exact local control
  credential. That credential authenticates the native caller but never proves
  an App or CLI decision.
- Public canonical reads require the exact Host and an absent Origin. They
  perform no durable mutation.
- Request bodies accept standard UTF-8 JSON under RFC 8259 and are captured
  and validated by the owning schema. Whitespace and object-member order carry
  no authority. Deterministic serialization is an output and narrow digest
  concern, not an HTTP input requirement.
- A transaction handoff additionally requires the server-owned confirmation
  grant defined by `docs/TRANSACTION_POLICY.md#confirmation-authority`.
- No local credential, Review, operation ID, or grant appears in a query
  string.

Request-class security is fixed as follows:

| Request class | Host | Origin | Authentication | Durable mutation |
| --- | --- | --- | --- | --- |
| Owner identity | Exact fixed Host | Must be absent | None; challenge proof is the response | No |
| Public canonical read | Exact fixed Host | Must be absent | None | No |
| Compatible-process control | Exact fixed Host | Must be absent | Local control credential | Only the declared control transition |

An Origin header always fails. A request never changes class because it omits
a credential. Each route has exactly one request class.

## Verification

Implementation verification covers module dependency direction, fixed-port
ownership and takeover, foreign-process conflict, store separation, the
single-session invariant, exact Review purity, direct-decision revalidation,
durable operation uniqueness and immutability, stale action rejection,
external effect ordering, no-resend restart, QR lifetime, stable session
restoration and invalidation, MCP App and CLI use of the same domain owners,
native credential separation, Host adapter isolation and deletion conditions,
snapshot identity,
capacity, corruption, exact input/result reconstruction and full canonical
re-admission,
terminal observation stopping, request limits, token-selection and watchlist
atomicity, account-assets continuity, reference-market evidence and history
bounds, send-once delivery, owner takeover, and secret-leak boundaries.
