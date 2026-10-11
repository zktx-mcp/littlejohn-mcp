# Architecture

## MCP Host Terminology

An **MCP Host** is the AI application that manages MCP client connections to
MCP servers, as defined by the [official MCP architecture](https://modelcontextprotocol.io/docs/learn/architecture#participants).
The MCP Host applications discussed for this repository's App integration are
**Codex** and **Claude Desktop**.

The **MCP client** is the connection component inside that application.
The **Little John MCP server** exposes Little John's tools and results.
The **MCP App View** is Little John's card interface rendered inside the
MCP Host application when that connection admits MCP Apps. The View and its
containing application are distinct components.

The **local HTTP owner** is Little John's backend process under
[Local Process Model](#local-process-model). The external **Wallet** and
its signing authority are governed by `docs/TRANSACTION_POLICY.md`; neither is
the MCP Host application. In HTTP request rules, **HTTP `Host` header** means
the request header, not Codex or Claude Desktop.

## Current State

Little John is a Node.js `>=22.13.0` ESM TypeScript modular monolith. Foreground
MCP and CLI entries construct a Runtime client. A fixed backend entry composes
the owner-only SQLite product store, Wallet application and SDK worker, bounded
Robinhood Chain RPC reader, feature applications and final support manifest.
The client and backend have separate cleanup owners under
[Local Process Model](#local-process-model) and
[Runtime Lifecycle](#runtime-lifecycle).

The current runtime composes wallet connection and operation ownership, pinned
chain reads, canonical Address inspection, contract analysis with the current
source-verification provider,
official-asset synchronization and StockFactory admission, account token
selection, account assets, Stock Token trade history from admitted external
data, and the statically registered protocol
packages. Each feature owns its canonical application contracts and persistence
ports. Wallet management persists its operation before an external effect;
token-selection decisions atomically persist their local mutation and terminal
operation. Review supplies temporary transaction and data-signing decisions and
one-time Wallet handoff. Receipt/Activity accounts for received transaction hashes;
verified data signatures use direct response delivery without persistence.
Exact terminal Wallet and Token
operations have no automatic eviction. This document records the current external-integration
classification in
[External Integration Model](#external-integration-model); exact support,
evidence, numeric, and protocol meanings remain in their owning sources.

One authenticated fixed-port HTTP owner serves the owner-identity handshake,
compatible-process controls, and public canonical reads under fixed route and
request-security registries. Public reads and authenticated controls remain
separate authority classes. The loopback endpoint serves no user interface,
browser session, Cookie credential, or CSRF authority.

A no-argument package process exposes one stdio MCP connection through the
Runtime client's lazy snapshot-read and publication-key ports, admitted packaged
App resource and explicit local-operation client. It publishes the connection
owner before starting stdio. Input end or close terminates the MCP connection,
which closes its SDK server and adopted transport before its local-operation
client and local database handle. Whole-backend shutdown is a separate Runtime
management operation. On an admitted MCP Apps connection,
explicit read and decision publication tools use the bounded immutable-presentation process
defined by
[Immutable Presentation Snapshot Ownership](#immutable-presentation-snapshot-ownership)
and [MCP App View Lifecycle](#mcp-app-view-lifecycle). Connection admission,
rather than missing construction inputs, selects ordinary or App presentation
under `docs/PRODUCT_POLICY.md#capability-availability`. App-only controls and
interactive CLI commands independently send the same admitted Reviews to the
same domain owners. Wallet management and Token selection read exact durable
operations; transaction decisions use the separately typed temporary source and
actual-result ledger defined below. The standard transport is primary. Implemented MCP Host
adapters are limited to current App association and card-reference delivery,
the measured Codex creating-error carriage path, and the measured Codex View
operation-result carriage path.
Canonical binding catalogs and role registries own exact MCP names, native HTTP
resources, CLI commands, parsing, and availability. The closed App presentation
registry owns its implemented contract set. Help text, route coverage,
capability and presentation catalogs, and the generated public support
projection derive from those owners; this document does not maintain a second
interface catalog.

Owner-only application-data permissions separate the SQLite product store,
WalletConnect private store, and local control credential. Compatible-process
credentials and WalletConnect session state remain distinct. Transaction decisions use an expiring memory source, direct App/TTY confirmation,
one Wallet request and a received-hash execution ledger. These implementation
paths do not qualify physical Wallet execution; exact support claims remain in
Product Policy and the Runtime manifest. Route responses use the
declared canonical-JSON policies, and canonical JSON rejects ill-formed Unicode
before UTF-8 encoding.

CLI QR rendering uses compact black modules on a white background. The verified
VS Code terminal profile supports continuous module geometry. The Codex app
terminal profile is not qualified for faithful QR display because its half-block
characters have horizontal gaps. Terminal-display, Wallet-scan and MCP App
qualification are separate. Terminal presentation ownership is defined in
[CLI Surface](#cli-surface).

The runtime support manifest is the sole machine authority for implemented
binding availability and the implemented App presentation catalog. Its
deterministic public projection is
`docs/PRODUCT_POLICY.md#current-support`. Exact chain, protocol, evidence,
numeric, transaction, and presentation meaning remains in each owning binding
document rather than being restated in this Current State section.

This document is the sole authority for repository ownership, module
dependencies, local processes, persistence, MCP App and CLI surfaces,
WalletConnect session ownership, local credentials, and the loopback HTTP
boundary. Sections after Current State define required architecture and do not
claim that it is implemented. Product availability is owned by
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
- Stock Token trade-history source identities, data admission, and chart-series
  construction;
- protocol adapters;
- WalletConnect handoff; and
- receipt verification.

## Release Publication

A published GitHub Release is the only package-publication trigger. Its tag is
the package version with an optional `v` prefix. The workflow runs
`release:check`, publishes that exact verified tarball to the public npm
registry, and verifies its recorded integrity and distribution tag. Separate
npm and MCP Registry jobs preserve that order; the Registry job consumes the
npm job's exact artifact integrity and can be retried without rebuilding or
republishing npm. Public npm visibility is checked at 30-second intervals for
up to 20 minutes, with temporary request failures and Retry-After respected.
This is a workflow wait budget, not an npm availability guarantee. Before a
stable npm commit it uses the fixed official MCP publisher to validate
`server.json`; after the npm commit is visible it registers and verifies the
same stable version in the official MCP Registry. Prereleases use npm tag
`next` and do not enter the MCP Registry.

The first npm publication requires the repository secret `NPM_TOKEN` to contain
a granular npm token authorized to publish the package named in `package.json`. After that package
exists, the maintainer configures npm Trusted Publisher for
`.github/workflows/publish.yml` and removes `NPM_TOKEN`; the unchanged workflow
then uses GitHub OIDC. The token is available only to the npm publication step
and is removed from the MCP publisher process environment. Publishing a GitHub
Release remains the maintainer's assertion that the release is ready; automated
package verification does not replace manual host and wallet gates.

The package verifier executes the admitted installed App View and consumes
the installed presentation and immutable-read contracts. The exact load
producers, targets and canonical-parser consumers are enforced by
`packagedIntegrationLoadBoundaryViolations` in `test/runtime/import-audit.ts`;
an import count alone grants no execution permission.

## Logical Modules

| Module | Responsibility |
| --- | --- |
| `core` | Chain-neutral contracts, canonical JSON, exact rational arithmetic, evidence replay, invocation, and errors |
| `evm` | EVM identities, address targets, token amounts, event values, native evidence admission, encodings, and request commitments |
| `chain` | Address-target resolution, RPC, pinned reads, simulation, broadcast, and receipt ports |
| `registry` | Product chain and asset identity, official-asset source admission and synchronization lifetime, StockFactory identity, and ordered default Stock Tokens |
| `intelligence` | ABI, source, contract, calldata, signature, and transaction analysis |
| `security` | Deterministic policy, simulation coverage, warnings, blocks, and state deltas |
| `stock-token-trade-history` | Official Stock Token selection, same-block StockFactory verification, trade-history data admission, and chart-series construction |
| `stock-token-prices` | Official-token catalog and candidate-scoped pool-price reads, candidate-source admission, execution lifecycle and canonical results |
| `protocols` | Protocol package contract and protocol-specific capabilities and action adapters |
| `review` | Transaction and data-signing intent, account binding, commitments, freshness, temporary Review state and direct result admission |
| `wallet` | WalletConnect sessions and exact reviewed-request handoff |
| `token-catalog` | Token inspection and account-specific selection contracts |
| `account-assets` | Selected-account collection, classification, standard, and balance reads |
| `receipt-activity` | Transactions, receipts, traces, finality, and actual state deltas |
| `interfaces` | MCP, MCP App presentation, native loopback HTTP, and interactive CLI |
| `runtime` | Composition root, SQLite, configuration, HTTP ownership, and feature gates |

## Dependency Rules

EVM's `identities.ts` owns equality of admitted EVM account identities.
Core's `primitives.ts` owns strict code-point ordering of canonical string sequences
and UTC millisecond addition. Consumers retain their domain correlations,
admission failures and lifetime values. The History feature's `calendar.ts`
owns its shared UTC calendar-month calculation; its numeric meaning follows
`docs/NUMERIC_POLICY.md`.

EVM's `erc20-events.ts` owns canonical Transfer/Approval value and encoding
relations. Chain's `evm-standard.ts` adapts viem and checks decoded values
against the original log through that owner. Its generic ABI scalar decoders
use the existing viem parameter decoder; domain function ABIs own their actual
calls rather than unrelated scalar results.

- `core` imports no native-chain or product owner, provider, protocol SDK,
  wallet SDK, React, HTTP, or SQLite implementation. Generic invocation chain
  scope follows [CAIP-2](https://standards.chainagnostic.org/CAIPs/caip-2).
  Native owners supply stricter identity, amount, evidence and encoding admission;
  generic execution and replay never select an EVM or product-chain default.
- Concrete read capabilities belong to their feature owners: Chain owns status,
  address and transaction inspection, Account owns balance, and Wallet owns
  connection. Runtime aggregates their definitions without owning their meaning.
- Core owns the common display-text admission used by Registry labels and Token
  metadata. `token-catalog/metadata-contract.ts` owns metadata read outcomes and
  their failure reasons; Chain reads and Account projections consume that pure
  contract. `chain/read-failures.ts` owns the RPC and address-target read failure
  sets consumed by Chain and Account. These contract modules import no execution
  owners or external adapters.
- EVM exposes explicit server and interface-safe entries. Registry owns the sole
  product-chain and product-asset code projections. Native schemas, semantics and
  commitments are not re-exported by Core.
- Server modules consume the curated `core/index` entry point. Interface-safe
  error definitions, shared operation contracts, MCP App renderers, and CLI
  projections, together with Registry's pure default-token lookup, consume one
  curated interface-safe core entry point. No other
  module imports a core leaf directly.
- Concrete SDK, database, HTTP, and adapter implementations enter through
  `runtime` composition.
- Contract and error-mapping consumers use the owning contract entries without
  importing application factories or external adapters. Registry owns the public
  official-source and StockFactory failure definitions; Token and trade history
  consume that branch while retaining their own permitted failure sets.
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
| Model Context Protocol | Binding product transport | The official MCP specification owns JSON-RPC transport meaning; this document's interface contract model and the canonical binding owners own Little John tool meaning | `src/interfaces/mcp.ts` owns official SDK server and stdio transport adaptation; role registries own their exact tool bindings | Foreground composition supplies the lazy Runtime client ports, packaged resource and explicit local-operation client, and publishes one stdio owner before connection; replacing SDK details preserves MCP identity, tool contracts and client-only EOF cleanup without ending the independent backend |
| Model Context Protocol Apps | Binding product transport | The official MCP Apps specification owns resource and View transport meaning; Little John's canonical contracts own product results and this document owns presentation lifecycle | `src/interfaces/mcp-app` owns the self-contained resource, descriptor and chunk transport, View bridge, renderers, and narrow MCP Host adapters; Runtime owns the immutable snapshot store | MCP composition always supplies the Runtime store and admitted packaged resource; connection admission, rather than missing construction inputs, selects ordinary or App presentation, and replacing a MCP Host adapter preserves the standard transport and every canonical result while replacing the extension requires an accepted integration change |
| Codex MCP App Host | Replaceable implementation provider | The MCP Apps integration requirements below own the provider-neutral MCP Host role and the exact current Codex transport boundary | Local Codex configuration owns MCP Host enablement; the Codex adapters under `src/interfaces/mcp-app` own only the measured missing transport facts defined below | The local stdio MCP connection and sandboxed View enter the common MCP Apps process; another MCP Host may replace Codex only by satisfying that complete unchanged process |
| Claude MCP App Host | Replaceable implementation provider | The MCP Apps integration requirements below own the provider-neutral MCP Host role and the exact current Claude transport boundary | Local Claude configuration owns MCP Host enablement; the Claude adapter under `src/interfaces/mcp-app` owns only the measured missing transport fact defined below | The local stdio MCP connection and sandboxed View enter the common MCP Apps process; another MCP Host may replace Claude only by satisfying that complete unchanged process |
| WalletConnect | Binding product transport | `docs/PRODUCT_POLICY.md` owns the wallet transport; this document owns session and handoff architecture | `wallet` owns SDK adaptation, project-ID validation, required namespace settings, metadata, SDK options, lifecycle, and provider defaults | The independent backend's wallet application constructs one parent `WalletConnectClientPort`; its fixed Wallet worker owns SDK construction and private storage. Other modules receive wallet product ports. The client/IPC contract is the replacement boundary |
| Robinhood official-asset API | Binding source authority | `docs/EVIDENCE_POLICY.md` owns source authority; `officialAssetSourceDefinition` and the registry source contract own the exact source identity, normalized observed-or-unavailable read result, evidence, and storage ports | `src/registry/official-assets.ts` owns request and response admission, endpoint consumption, transport behavior, deadlines, and operational limits | Runtime composition constructs one source client; registry synchronization consumes its value result and the product-owned store without an exception translation layer; replacing the membership source changes the binding evidence authority |
| Robinhood StockFactory | Binding source authority | `docs/EVIDENCE_POLICY.md` owns the independent UID-to-token-address proof meaning; `stockFactoryAdmissionManifest` and the registry verification contract own the admitted deployment identity and identity-bearing verification result | `src/registry/stock-factory.ts` owns StockFactory call and identity verification behind the pinned-block `OfficialAssetChainReadPort` in `src/chain/official-assets.ts`; common RPC configuration remains with the chain transport | The chain application constructs the port and preserves the same result contract for single and batch reads used by account-assets and token inspection; changing verification internals preserves the admitted identity, while changing the deployment or source owner changes the manifest and evidence authority |
| Robinhood Uniswap V4 PoolManager events | Binding source authority | `docs/EVIDENCE_POLICY.md` owns trade evidence meaning; the V4 protocol owner supplies the shared deployment, Swap event and pool identity; `src/stock-token-trade-history/source-semantics.ts` owns archive finality, stored resolutions and source revision; `docs/NUMERIC_POLICY.md` owns exact trade-candle meaning | The separate collector owns bounded finalized log collection, exact decoding, cursor, repair, one-minute candle construction, and archive publication; Little John has no log reader or candle builder | Little John consumes only the admitted provider-neutral archive result; changing collection internals preserves its exact contract, while changing the deployment, Pool identity, event, quote asset, revision, or numeric construction changes the binding source contract and does not imply Uniswap transaction support |
| GitHub Releases Stock Token trade-history data | Replaceable implementation provider | `stock-token-trade-history` owns the provider-neutral `StockTokenTradeHistorySourcePort`, canonical capability, source outcomes, limits, lifecycle, and evidence projection while finalized PoolManager events remain the semantic source | `src/stock-token-trade-history/github-source.ts` owns bounded catalog pagination, uploaded-root filtering, exact Range transport, redirects, response admission, and stream cleanup | The feature application factory constructs one GitHub transport and one archive source, registers the source before the application execution owner, and exposes only the canonical capability binding; another carrier may replace GitHub only by returning the unchanged provider facts to the same source process |
| Sourcify API v2 | Replaceable implementation provider | `intelligence` owns `ContractSourceVerificationPort`, its normalized results and failures, evidence requirements, and lifecycle | `src/intelligence/sourcify.ts` owns the origin, path, request and response admission, deadline, response-size and concurrency limits, cleanup, and provider identity | Runtime composition constructs one Sourcify adapter and passes only `ContractSourceVerificationPort` to the shared contract-analysis process |
| DEX Screener token-pairs API | Replaceable implementation provider | `stock-token-prices/ports.ts` owns the candidate-source port; `source-contract.ts` owns the admitted source observation; price and asset facts retain their Chain, protocol and Registry owners | `stock-token-prices/dexscreener-source.ts` owns the build-time endpoint, source-chain name, schema/hint mapping, bounded HTTP read, quota and cleanup | The price application factory selects one adapter; the feature consumes the unchanged candidate contract and its evidence authority. A replacement supplies the same role without changing the price or presentation contracts |
| Uniswap V2 | Binding protocol identity | `docs/PROTOCOL_ADAPTERS.md` and `src/protocols/uniswap-v2` own the exact V2 package, deployment records, native mapping, and capability registration; `docs/NUMERIC_POLICY.md` owns numeric meaning and `docs/EVIDENCE_POLICY.md` owns evidence meaning | `src/protocols/uniswap-v2/sdk.ts` owns the pinned Uniswap SDK loading and admission boundary; the package owns immutable deployment and route-asset records | Runtime composition constructs the statically registered V2 package once and passes only its canonical quote binding to interfaces |
| Uniswap V3 | Binding protocol identity | `docs/PROTOCOL_ADAPTERS.md` and `src/protocols/uniswap-v3` own the version, factory admission and native pool-state read | The V3 package owns deployment/source records and ABI; the existing pinned Chain port owns transport | Protocol composition registers the package and supplies its reader through `PoolPriceReadPort`; the market feature owns the public price capability, and no V3 transaction action is registered |
| Uniswap V4 | Binding protocol identity | `docs/PROTOCOL_ADAPTERS.md` and `src/protocols/uniswap-v4` own the native registration, selected deployment, pool identity and action mapping | V4 owns native ABI/codec and immutable catalog; the existing Chain requester and viem codec supply transport/encoding | Runtime registers its stateful pool read before constructing the shared Review/Receipt application; its source refresh uses authenticated owner controls and interfaces receive only canonical product contracts |

This table contains implemented external integrations only. The implementation
task that adds or removes an integration updates the table after the runtime
boundary exists or is removed. A proposed, researched, or unavailable
integration remains in its task plan or research material and is not listed as
current architecture.

The V4 package is an additional binding protocol identity. `src/protocols/uniswap-v4`
owns its deployment, catalog, native parameter mapping, codec, pool read and
registration. Runtime constructs its pool read after Registry synchronization is
available and supplies the registered native operations to Review. It consumes
the existing Chain transport and installed viem codec; replacing its deployment
or native version changes the protocol contract rather than an endpoint option.

### MCP Apps Integration Requirements

The official Model Context Protocol Apps extension is a binding product
transport. The official extension owns resource, View, initialization, and
tool-visibility protocol meaning. Little John's canonical contracts own every
result, Review, operation, and action meaning.

`interfaces/mcp-app` owns the self-contained App resources, standard
capability admission, presentation descriptors, exact snapshot transport,
View bridge, typed renderers, and transport-only MCP Host adapters. Runtime owns
the immutable presentation-snapshot store. Immutable presentation handoff,
failure, and replay are owned by
[Immutable Presentation Snapshot Ownership](#immutable-presentation-snapshot-ownership).
View execution order and the separate direct operation-result transport are
owned by [MCP App View Lifecycle](#mcp-app-view-lifecycle).

The shared App resource requests no browser permissions. Signing-result
interaction follows [Data-Signing Decisions And Results](USER_INTERFACE_POLICY.md#data-signing-decisions-and-results);
private-value retention and disposal follow [Data Signing](TRANSACTION_POLICY.md#data-signing).

`scripts/mcp-app-notices.ts` owns build-time notice selection and text assembly
from the rendered source inventory, including build-inserted virtual modules,
and retained license documents. The existing App build plugin embeds that text
in an inert HTML template and emits the same text as package documentation.
The MCP App HTML resource contains its notices without reading the companion file.
Executable script and style, canonical results, resource hashing and transport
ownership remain with their existing owners. Dependency approval and source
preservation policy remain in `AGENTS.md`.

Codex and Claude are replaceable MCP Apps Host providers. A connection uses
the standard MCP Apps capability, nested metadata, resource, result, and
bridge contracts first. Exact MCP `clientInfo.name` may select a server-side
adapter only after the required standard server signal is absent or physically
unusable. Exact View `hostInfo.name` may select a View-side adapter only after
standard View initialization and only for a measured View transport defect.
Server and View identity are never inferred from one another, and MCP Host version
never selects product behavior.

The admitted MCP Host adapters are closed:

- the Codex server adapter uses result-level `ui.resourceUri` association on
  an exact `codex-mcp-client` connection that admits the standard Apps capability.
  A successful general-card acknowledgement with disposition `created` or
  `existing` carries the same general App URI. `creating` and failed creation
  invocations carry no result association. A stored card's domain failure,
  cancellation or owner loss does not turn its successful `existing`
  acknowledgement into a failed creation invocation. Redisplay creates no new
  card, source, request or authority. The model-visible creation tool has no
  static UI URI on this binding; ordinary data and Review results carry no
  automatic UI association. Chart creation retains its card-specific URI;
- the Codex creating-result resource-link adapter unwraps only the measured
  single JSON text wrapper in exact `chatgpt` View-reported MCP Host identity,
  after the standard resource-link path is absent. The wrapper is admitted as
  one MCP result envelope. Its structured result, direct JSON text, card
  metadata, links and explicit error flag enter the same supplied-copy checks
  as their outer counterparts. Conflicting values, multiple or nested wrappers,
  and a wrapper mixed with a standard link are rejected. Wrapper text is not
  also interpreted as a product acknowledgement;
- the Codex creating-error adapter runs only after a creating result omits the
  standard `isError` field in exact `chatgpt` View-reported MCP Host identity. It accepts
  only the measured `content,structuredContent` canonical application-failure
  form whose one exact canonical text equals the strict structured failure, or
  the measured `content`-only form whose text is the exact common MCP
  delivery-size error. It restores only error classification and rejoins the
  common creating-result tool-error admission before any presentation resource
  admission;
- the Codex View operation-result adapter runs only after ordinary owning
  admission of `structuredContent` fails in exact `chatgpt` View-reported MCP Host identity.
  It admits only the canonical result text from the same `CallToolResult` when
  the strict response descriptor matches and recursively removing only object
  properties whose value is exactly `null` produces the delivered
  `structuredContent`; and
- the Claude View adapter reverses only the measured exact flattened card-link
  text in exact `Claude` View-reported MCP Host identity, requiring its name and
  URI to identify the same card. A missing link does not require redundant
  metadata when another complete admitted creating identity is present. Every
  supplied acknowledgement and card reference must agree. The adapter never
  obtains domain data or a snapshot from compatibility text.

Each adapter supplies only the missing transport fact and then enters the same
descriptor, byte, digest, canonical-admission, lifecycle, and renderer owners.
It cannot select a snapshot, read domain state, change canonical meaning, or
grant action authority. When the MCP Host physically supplies the corresponding
standard primitive, the standard path handles that primitive and the adapter
is deleted in the same MCP Host-support change. There is no version branch,
generic MCP Host registry, guessed identity, or compatibility reader.

Every View-initiated operation result whose input reached owning admission
carries one strict View-private `operation_tool_result_descriptor`. Version
`1` contains the canonical tool name, normalized input UTF-8 byte length and
SHA-256, canonical result UTF-8 byte length and SHA-256, and server `isError`
meaning. The MCP binding computes it from the same admitted input and final
canonical result used for that `CallToolResult`. It is ephemeral transport
correlation and is never a domain field, persisted value, snapshot, evidence
record, signature, MAC, or MCP Host authentication.

Descriptor input capacity consumes the Local HTTP request-body owner; result
capacity consumes the derived canonical response-payload owner. Numeric
classification and their relationship are defined by
`docs/NUMERIC_POLICY.md#durable-operation-and-presentation-limits`. Neither
consumes immutable snapshot capacity. Every descriptor-bearing operation input
is bounded by its domain owner before descriptor construction.

The View first admits the MCP success envelope when declared for the tool, then
applies the unchanged owning success, failure, or `delivery_unknown` admission
to its canonical value. Standard `structuredContent` is always tried first. Only the
Codex operation-result adapter may inspect another carrier after that fails.
It reads only one direct canonical JSON text item and the descriptor in the
same response's outer metadata. It never unwraps a complete `CallToolResult`
or selects among nested structured values and text. It requires exact descriptor
agreement with the current tool, input, original canonical result bytes, and
`isError`, at least one omitted object
property whose value is exactly `null`, and exact equality between the
delivered structured value and that one null-elided wire projection. The same
MCP envelope admission obtains the original result for descriptor comparison;
wire framing never changes the descriptor's canonical byte identity. It preserves
array positions and array `null` values, then applies the same owning admission
to that one complete result. Missing or malformed metadata, descriptive text,
a complete-result wrapper, a changed or omitted non-null value, an added
value, a type conversion, an array change, an `isError` mismatch, or owning
admission failure rejects the result. The adapter never infers a field,
inserts `null`, applies a schema default, repeats a call, or selects another
operation. Claude operation results use only standard structured admission.

Before JSON parsing, both the direct operation-result text and the creating
resource-link wrapper text consume the existing MCP result source bound owned
by `interfaces/mcp-result.ts`. The first text is contained in the completed
server result; the second is that result's JSON serialization. Neither can
exceed its source packet. This is a text admission, not a limit on the expanded
Host envelope, whose JSON string escaping can increase its size. Canonical
component capacity still applies to the original value after MCP envelope
admission. The standard paths and creating-error admission retain their own
ordering and failure meaning.

The Codex operation-result adapter is deleted when a current physical Codex
qualification preserves required object-valued `null` properties in
View-initiated action and exact-operation `structuredContent`. Its descriptor
emission is deleted with the adapter when no remaining admitted transport path
consumes it.

An MCP connection that does not admit the App transport receives no App-only
resource or authority. It may read an exact SQLite immutable-result resource
for bounded metadata and obtain the same source through model result parts.
HTML, charts, cards, private and live decision sources remain App-only. A bridge that transports tools but not
resources therefore cannot present an App on that connection. Product
interface selection and non-fallback meaning are owned by
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
official-asset API, Robinhood StockFactory, and Robinhood Uniswap V4 PoolManager
events are separate binding source identities with separate admission and
replacement boundaries. A supported DeFi protocol is a binding protocol
identity. Replacing any of those with a different external owner changes its
owning product, evidence, or protocol contract; adapter isolation does not
pretend otherwise.

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

For an optional adapter construction setting, exact `undefined` is the only
omitted value. Every other supplied value, including `null`, is present input
and must pass the setting owner's type and bound admission before the adapter
publishes a port or starts external work. A setting that admits `null` declares
and validates it explicitly. This admission rule shares no implementation or
lifecycle between adapters.

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
Address and token inspection. Intelligence owns the serializable analysis contract,
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
source observations that produced it. Address and token capability handlers
consume that complete execution and cannot combine analysis data with source
observations from another execution.

EVM owns one strict explicit-address or active-Wallet target contract. Chain
owns one resolver instance used by Address inspection and account balance and
exposes that same immutable resolver through its internal application handoff.
Explicit input never reads Wallet state. Active input captures one admitted
Wallet snapshot and source for that invocation; an unavailable snapshot fails
before Chain I/O and a later Wallet change cannot rewrite the captured address.
The resolver also owns equality of the resolved account, connection revision,
and stable session-source identifier; callers do not reconstruct that
continuity relation.

Address inspection resolves one canonical block and performs one target
runtime-code read through the contract-analysis Chain port. Empty code ends the
process before proxy, source-verification, ABI, implementation, or control
work. Nonempty code enters the unchanged analysis process. The public evidence
meaning and conclusion completeness remain owned by
`docs/EVIDENCE_POLICY.md`.

Complete public capability validation is interface-safe and owns input
parsing, target-dependent result checks, public source-record digest
comparison, evidence replay, and result-size admission. Node-only capability
execution separately owns bindings, invocation identifiers, handler execution,
and live observation recording. An interface, transport, or stored-result
reader does not implement a weaker result parser.

A capability definition may declare a positive safe complete-success byte
maximum no greater than the Core default. Omission selects the unchanged Core
default. The definition snapshot and schema projection carry the selected
value, and produced and replayed successes enter the same post-evidence byte
admission. A result above that owning maximum becomes canonical
`result_too_large` before an interface receives it.

A capability binding may supply one execution-owner port. When present, the
owner encloses input admission, handler work, observation recording, evidence
closure, complete-success validation, byte admission and final publication.
The owner decides caller-before-owner stop precedence and supplies only the
combined signal and terminal stop result; Core does not adopt the feature's
source, Chain, deadline or cleanup meanings. Bindings that omit the port retain
the current execution behavior.

## Stock Token Price Read Ownership

The price application owns `market.stock_token_prices` and `market.stock_tokens`.
Registry supplies membership and exact asset verification. Protocol composition
supplies `PoolPriceReadPort`; native readers and codecs remain inside their
version packages. One session retains code/call observations only within one
invocation and one pinned block. It has no cross-request cache or database row.

The candidate adapter is called by a new price request, not by startup, idle
work or presentation replay. The feature reads the candidate set, resolves the
current block and completes its native reads before returning its canonical
result. Catalog reads consume Registry without a pool-source read. The shared
`runtime/read-execution.ts` owner admits, aborts and drains History and price
invocations; each feature retains its ordered business reads and failure meanings.

The two canonical results use the existing immutable presentation registry and
SQLite snapshot process. They create no decision/card-state record, pending
price operation, refresh control or separate View lifecycle. The snapshot is
never an input to a later price request. The common market CLI dispatch process
consumes each registered identity and its admitted result.

## Interface Contract Model

- Canonical semantic contract ownership and projection follow
  `../AGENTS.md#interface-contract-policy`. This section owns only Little John's
  runtime binding, registry, transport, path, and correlation architecture.
- MCP uses the protocol's
  [JSON-RPC tool surface](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
  through the official SDK. Little John does not define a second agent JSON-RPC
  protocol or duplicate MCP tool catalog.
- For a model-visible tool, the MCP Host selects the tool and constructs its
  arguments from the person's natural-language request. Little John's authority
  begins when the owning parser admits that machine invocation. Prompt text is
  not canonical input, evidence, snapshot identity, or authorization, and a
  direct function call is only an internal protocol-verification method.
- MCP input JSON Schema is a derived projection of the owning parser. A closed
  top-level discriminated object union publishes one closed object with common
  fields declared once and discriminator-specific requirements retained in
  its branches. The server still admits the value through the unchanged owning
  parser. No MCP Host adapter parses a JSON string as an input object or changes
  the owning contract's accepted value set.
- The MCP result owner constructs every final `CallToolResult` after attaching
  all Little John content and private metadata. A result is admitted only when
  `JSON.stringify(result)` fits the complete packet budget owned by
  [Numeric Policy](NUMERIC_POLICY.md#durable-operation-and-presentation-limits).
  That budget is not a universal MCP Host maximum. MCP Host text offloading
  does not change canonical result authority or this admission boundary.
  Successful results with an output schema retain conforming
  `structuredContent` and exactly one bounded model-visible text item. The
  registered interface may derive that text from the admitted success; an
  interface without a projector retains the canonical JSON text. The text is
  never a second result oracle or a reconstruction input. An
  oversized registered immutable read is retained by the backend before its
  exact snapshot resource is returned as a separate transport branch. Native
  results, failures and their nullable envelopes keep their owning meaning.
  An oversized result without that admitted immutable branch becomes one bounded
  `isError` tool-execution result with a
  plain-text delivery-size statement and no structured result, resource link,
  snapshot metadata, operation metadata, or domain payload. This transport
  error does not change the owning application failure contract or the
  independent canonical capability-success bound. The request ID remains
  client-owned, so Little John does not claim a universal byte bound for the
  complete JSON-RPC response.
- `interfaces/mcp-result.ts` owns success-envelope schema projection,
  serialization and admission. The existing Activity and Exchange bindings whose
  owning success schema admits root `null` carry every successful value as the
  strict object `{value: <original canonical result>}`, including non-null results.
  Other successes and all owning failures retain their existing object carriage.
  The envelope is transport only: HTTP, CLI, stored results and operation-result
  descriptor lengths and digests continue to identify the original canonical
  value. The same codec precedes owning admission in the App; no consumer
  reconstructs a result, accepts both formats or selects framing by MCP Host.
- Compatible-process control resources are private owner IPC consumed by MCP and
  CLI adapters. They are not agent-facing URLs and do not redefine the MCP
  contract.
- Machine-interface identity catalogs bind canonical contracts to their MCP,
  native HTTP, and CLI identities. A separate closed presentation registry
  binds an exact canonical contract object to its canonical parser, typed MCP
  App renderer, and
  exactly one `presentationKind`: `immutable_result`, `review`, `transaction_review`,
  `signing_review`, `selection`, or `operation`, and its permitted retention source.
  Presentation kind selects typed content and source admission. Decision entries
  also declare their card source kind. The backend card state owns interaction
  lifecycle under [Card State Ownership](#card-state-ownership). An `operation`
  remains a nested exact-operation result. The registry
  never reconstructs a contract from a string identifier and contains no
  generic JSON renderer, secondary process set, or MCP Host-dependent
  classification.
- Address inspection and account balance interface schemas derive their target
  forms from the same EVM owner. An interface cannot add a stored-account,
  session, chain, or authority variant.
- MCP App presentation is a connection-local lossless transport projection of
  a canonical result, not another canonical binding or support-manifest axis. The standard
  resource and View path and the exact MCP Host adapters in
  [MCP Apps Integration Requirements](#mcp-apps-integration-requirements) are
  transport projections only.
- Every MCP tool declares an explicit visibility tuple. Model-visible handlers
  expose canonical reads and immutable Review creation. Their permitted effects
  are owned by [Local Persistence Boundary](#local-persistence-boundary) and
  the default-selection rule in `docs/PRODUCT_POLICY.md#default-stock-tokens`.
  They cannot make direct Token selection decisions, Wallet requests, domain
  operations, or transaction grants. App-only handlers may invoke a direct
  domain decision only after the canonical Review and current preconditions
  are independently re-admitted. Effect annotations describe behavior and do
  not grant action authority. Canonical binding owners distinguish a Review's
  non-idempotent source creation from a pure existing-source lookup and use the
  corresponding action verb. An annotation covers the complete admitted input
  union; independent background relay or cleanup activity is not an invocation
  effect.
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

- MCP and CLI foreground processes are clients of one independent local
  backend at the fixed origin defined in [HTTP Boundary](#http-boundary).
  Compatible clients share the admitted profile, package, protocol and exact
  configuration. A foreign owner is never stopped or replaced automatically.
- A normal client startup admits its configuration and existing database
  contract, authenticates the listener, and may start the fixed backend entry
  from its own installed package before sending application work. One local
  acquisition is shared by pending callers and spawns at most one candidate.
  The operating-system bind selects the only backend across processes; a losing
  candidate releases its startup resources and exits without a takeover loop.
- Runtime spawns Node's own executable without a shell, with detached process
  ownership, ignored stdio and an unreferenced child handle. No permanent IPC
  connects client and backend. The fixed entry cannot be selected by user input.
  Only the admitted data directory, RPC and Wallet configuration, PATH,
  NODE_ENV and necessary Windows system/temporary-directory variables cross
  that boundary. Node loader options and unrelated Host secrets are excluded.
- The backend owns application composition, durable writers, temporary Reviews,
  Wallet authority and the existing SDK worker. Client EOF, termination and
  completed CLI work release only that client's transport, output and local
  database handle. They do not end another client's work or the backend.
- Backend lifetime ends at explicit Runtime shutdown, operating-system
  termination or fatal backend failure. There is no idle timeout, login service,
  hidden CLI keeper or same-generation SDK restart. SDK parent loss means loss
  of the backend, not loss of a foreground MCP process.
- MCP initialization and static discovery do not wait for backend readiness.
  Dynamic work uses bounded shared startup observation; it never treats PID or
  spawn success as readiness. Fatal configuration/profile/schema admission
  fails startup. Readiness timeout alone leaves the MCP connection available
  for a later new call, without replaying the failed call.
- Startup observation preserves its original deadline across joins. Each
  caller's cancellation ends only its wait. A client that still has a live
  startup candidate does not spawn another after observation times out.
  Proven starting state and ordinary contention have the separate numeric
  meanings defined by Numeric Policy. Ready requests still authenticate their
  exact socket. No process selects another port or resends application work.
- Help and Runtime management commands do not auto-start a backend. Maintenance
  first pauses the affected clients, then explicitly stops the exact backend
  before removing its installed files or profile. A later ordinary call may
  start a new backend; Runtime stop is not persistent disablement.

## Runtime Lifecycle

Account, Token and History factories own separate instances of
`src/runtime/application-lifecycle.ts`. That owner supplies admission state,
opening and retryable closing; `resource-ownership.ts` supplies resource
registration and ordered cleanup. Factories retain domain construction and
consumer ports. History's binding consumes the same read-only admission view,
while its execution owner retains admitted-work cancellation and draining.

- Before starting an effect that can synchronously reenter its lifecycle owner,
  the owner records the exact admitted-work completion and attaches its success
  and rejection handlers. Before starting abort, queue rejection, or cleanup
  that can synchronously reenter the owner, the owner blocks new admission and
  records the cleanup completion. Reentrant and concurrent close calls share
  that completion.
- Draining admitted work waits for fulfillment or rejection without treating
  the work's rejection as a cleanup failure; failure of an owned cleanup
  operation remains a cleanup failure. These rules do not merge owner-specific
  operation, failure, retry, or terminal meaning.
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
- Internal startup cleanup does not request a Runtime stop. New dispatch and
  owner-session callers wait for that cleanup without application work. Complete
  resource and listener release permits a new shared acquisition; failed cleanup
  or process-terminal ownership is `runtime_state_unavailable` and retains the
  unresolved resources. The original startup caller retains its own failure.
  Caller cancellation and an explicit Runtime stop remain `request_aborted`.
- Registry owns the official-asset synchronization lifecycle independently of
  Token. Runtime acquires Registry once and supplies its read port to each
  dependent feature. Feature consumers cannot close that shared resource.
- The token-catalog application factory owns its coordinator, application adapter,
  consumer ports, support entry, admission and close/drain lifecycle. Its supplied
  startup owner retains cleanup authority until the complete application is
  returned. Runtime consumes the complete application without constructing Token
  internals.
- Named feature factories consume actual data ports. History needs Chain and
  Registry; Price needs Chain, Registry and protocol price reads. Neither Price
  assembly nor execution depends on History or Account support. Each feature
  produces its support entry from the same initial manifest; Runtime validates
  producer provenance and merges completed entries before Interfaces project
  their transport availability. Support aggregation is not a feature dependency.
- Fixed-owner shutdown blocks new authority and work, begins containment of the
  owned SDK worker, and closes interface, exchange, Price, History, Account,
  protocol, Token, Registry and Chain applications in dependency-reverse order.
  Worker containment begins before consumer drain so an unsettled SDK request
  cannot create a shutdown cycle. Receipt/Activity and product SQLite remain
  available until their bounded result consumers finish. No late continuation
  creates financial work. Wallet shutdown is `released` only after actual worker
  close and coordinator cleanup. Only then may product SQLite, its lease and the
  fixed HTTP listener be released. An unconfirmed child termination retains
  unresolved ownership and fails shutdown; a signal or acknowledgement is not
  release. Generic process-terminal failures still require OS teardown.
- The listener release requires the exact permit bound to the sealed and empty
  startup scope after application cleanup completes. Another permit or scope
  cannot share or trigger that release.
- A releasable shutdown failure keeps the owner in `stopping` and preserves the
  fixed port and every unresolved dependency. A later release attempt uses the
  same retained resources and never reconstructs them from projections. A
  process-terminal outcome is sticky and is not retried as an in-process SDK
  close.
- While the listener and admitted owner record remain held, the identity route
  and the exact Runtime management resources may answer from that cached
  record. These controls do not read closing SQLite, reopen application
  resources or join the application shutdown drain. Listener release closes
  their sockets as well.
- The direct executable owns process termination. It first settles every
  admitted CLI, terminal-restoration, QR, and MCP output write. A process output-stream
  failure produces a nonzero status; backpressure remains pending rather than
  being reported as successful truncated output. After settlement, the CLI
  process decision requires operating-system teardown when applicable MCP or
  local-operation-client cleanup rejects or foreground Runtime client cleanup
  rejects. The backend executable separately owns whole-Runtime termination
  after its shared shutdown completes or reports process-terminal failure. This decision does not claim that a retained
  resource was released. It is not a wallet disconnect and does not revoke an
  approved session. Normal Node termination requires either no created Runtime
  or a fulfilled released client-cleanup result after the applicable dependent
  proves closed. Client cleanup does not claim backend release.

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
- Only a backend candidate attempts the fixed listener bind. Foreground clients
  first authenticate the existing listener and start a candidate only on
  transport unavailability before application send.
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
- A client sends a fresh 256-bit base64url challenge in the
  `Littlejohn-Identity-Challenge` header of the owner-identity resource declared
  by the runtime route registry.
- The owner returns the strict fields `profileId`, `ownerInstanceId`,
  `configurationMac`, echoed `challenge`, `ownerRevision`, `packageName`,
  `packageVersion`, `controlProtocolVersion`, `role`, `phase`, and `proof`.
  Package identity comes from the installed package manifest. The strict
  control protocol version is `1`, the role is `backend`, and phase is one of
  `starting`, `running`, `stopping`, or `failed`. The proof is HMAC-SHA-256 over the
  length-prefixed UTF-8 encoding of those preceding fields in that order using
  the local control credential. Each length prefix is the unsigned 32-bit
  big-endian byte length of the following UTF-8 field.
- A ready owner returns that identity with HTTP 200. An initializing, stopping,
  failed-cleanup or process-terminal owner with an admitted record returns the
  same identity and proof with HTTP 503 and `application/json`. Both require
  complete identity verification; an unsigned error response proves neither
  compatibility nor readiness. HTTP 200 requires running phase; HTTP 503
  requires a non-running phase. After a verified HTTP 503, only the two exact
  management resources below may receive credentials on that same socket.
  Other application and control requests remain unavailable.
- The peer verifies the challenge, proof, profile ID, configuration identifier,
  package/protocol/role/phase, and the persisted owner instance and revision
  before sending any authenticated control request. A process with a different exact
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
- Non-HTTP/parser failures, received incomplete or oversized identity bodies,
  wrong content headers, invalid identity/proof/profile/configuration, and
  statuses other than 200 or 503 are `port_conflict`. Refusal, reset, close or
  timeout before any response bytes is transport unavailability. The peer
  never sends its credential to an unverified listener. Non-ready listeners
  admit only the exact management exception above.
- After owner loss, a new client acquisition may start a new backend candidate.
  The single successful binder publishes the next owner revision. Failed or
  interrupted application requests are not resent.
- Replacement acquisition is demand-driven and never infers liveness from
  SQLite. Only the successful backend binder constructs feature coordinators
  and reconciles their authoritative stores before serving application work.
- Lost bind followed by transport unavailability does not prove a winner.
  The foreground Runtime client owns bounded, cancelable acquisition retries
  under Numeric Policy. Authenticated starting state transfers to startup
  observation; stopping and failed state do not receive that extension.
  A local bind or valid ready identity ends contention; SDK/application
  initialization and post-send observation retain their separate lifecycles.
  Expiry is `runtime_state_unavailable`. Internal startup cleanup admission
  follows [Runtime Lifecycle](#runtime-lifecycle); caller cancellation or an
  explicit Runtime stop is `request_aborted`. Neither permits an application
  resend or automatic SDK restart after successful binding.
- Concurrent callers join one pending acquisition before opening another
  probe loop. Joining does not reset its deadline or backoff. Each caller
  receives a separately authenticated exact socket. Canceling one waiter does
  not cancel surviving waiters or an already bound Runtime; losing all waiters
  cancels an unacquired operation. Runtime stop cancels acquisition and callers,
  and every attempt closes its transport before the next attempt starts.
- The local-operation client propagates caller cancellation through initial
  owner-session acquisition and request send. It closes a late acquired session
  before reporting a pre-send abort. Result recovery after send remains bounded
  by the Runtime lifecycle and never resends the application request.
- Identity responses, challenges, and proofs contain no local control
  credential, WalletConnect secret, or transaction authority.
- The identity route validates the exact fixed HTTP `Host` header, accepts no Origin or
  authorization credential, performs no durable mutation, and returns
  `Cache-Control: no-store`.

## Runtime Management

`src/runtime/management-contract.ts` owns Runtime management descriptors,
inputs and results. The native status descriptor is GET with no mutation or
body; shutdown is POST with declared control mutation and the exact admitted
profile, owner instance and revision. The descriptors select only the native
Runtime status and shutdown resources under the local-control namespace.
The CLI maps those contracts to
`runtime status` and `runtime stop`; neither is a model tool or financial
permission. Runtime shutdown does not disconnect an approved Wallet session.

After identity publication, these two descriptors are selected before ordinary
application readiness and stop gates. They retain all normal Host, Origin,
credential, method, query, body and exact-owner checks. They use the cached
owner record and do not depend on feature or SDK readiness. Invalid prefixes
or caller flags cannot select this exception. Stop blocks new work immediately
and starts one shared shutdown independent of acknowledgement delivery. A lost
response or cancelled observer does not cancel the admitted shutdown.

Status distinguishes authenticated phase from confirmed listener absence.
Timeout, incompatible proof or missing local state does not mean not running.
Management opens only existing profile/credential state with the common
read-only schema admission and file lease; it never creates missing state.

A stop acknowledgement is not release. After actual SDK/application, database,
lease and listener/socket release, only an explicitly stopped generation
publishes `runtime-shutdown/<ownerInstanceId>.json` in its owner-only profile.
The immutable record contains its target identity, configuration MAC, package
identity, control protocol, released outcome and proof. Its proof is HMAC-SHA-256
of the canonical JSON of every unsigned field under the 32-byte HKDF-SHA-256
key derived from the control credential, empty salt and UTF-8 information
`littlejohn/runtime-shutdown/v1`. Staging, file synchronization and exclusive
hard-link publication prohibit overwriting another generation or outcome.
The record is a shutdown result, never listener authority or package state.

A bounded exact-file reader verifies the strict record, profile, owner ID,
optional captured revision and proof. Stop uses that reader after a potentially
lost acknowledgement, watches the exact result directory and performs a final
read at its original observation deadline. Missing or invalid evidence remains
`shutdown_unconfirmed` with the original target. It is never inferred from port
absence, a signal or another generation's result.

`runtime status --shutdown <owner-instance-id>` performs one exact local read
without network, backend startup or stop retransmission. The CLI's unconfirmed
result supplies this command with its original owner ID. Stored package and
configuration values describe that historical result, not live compatibility.
Results remain until explicit profile reset; no enumeration, TTL or latest-file
fallback exists. The schema and owning carrier bound each individual read.

## State Ownership

- Foreground Runtime exposes only profile/owner lookup, exact snapshot reads
  and the existing publication-key owner. It reuses common database bootstrap,
  schema admission, lease and decoders; its handle is not claimed to be an
  operating-system read-only database. Only backend composition receives
  feature writers and owner publication.
- Durable product state lives in local SQLite. Transaction Review, request and
  confirmation authority have the memory lifetime defined by
  [Transaction Request Ownership](#transaction-request-ownership).
- Runtime owns one immutable presentation-snapshot store in product SQLite.
  It retains the lossless normalized canonical input and admitted canonical
  result bytes required for exact App redisplay. The stored input is used only
  to repeat the owning contract's result admission; it is never submitted to
  domain execution or used as an evidence source, current-state cache, or CLI
  dependency.
- View layout, disclosure, focus, scroll, and mount state are ephemeral MCP Host
  state. Cookies, local storage, session storage, IndexedDB, MCP Host widget
  state, and mount identifiers never select a snapshot or operation and
  contain no wallet secret, signing material, QR material, or action
  authority.
- Store and domain-coordinator transitions own lifecycle rules. MCP, MCP App,
  native HTTP, and CLI map those transitions and do not reimplement them.
- The independent backend's Wallet parent owns product connection authority, management operations,
  request reservation and the actual child handle. One fixed SDK worker owns
  Sign Client, relay callbacks, raw session topics, private SQLite and original
  SDK futures. `client-contract.ts` and `worker-contract.ts` own the pure product
  port and closed, versioned IPC. Worker bootstrap is private; no public input
  selects an executable, module, relay, or method proxy.
- Worker acquisition starts asynchronously. Independent Chain, Registry, Price,
  History and retained-result consumers do not await SDK readiness. Preparing,
  failed or exited SDK state closes Wallet authority and never starts a second
  child in the same Runtime. Recovery requires a new actual Runtime owner.
  The client activation exposes its owner's current availability without I/O.
  Acquisition, admitted readiness and final unavailability are distinct from a
  stable observation, execution authority, external settlement and actual release.
  Callback names and observation failure do not establish acquisition completion.
- Each IPC direction admits generation, correlation, exact canonical input and
  payload/queue bounds before use. Pending observation, management and financial
  lanes have separate responsibilities. Unavailable, stale or malformed replies
  never become an empty or fresh session. Only the derived Wallet source key
  crosses private bootstrap; the HTTP control credential and raw topics do not.
  Parent session evidence is reconstructed locally from the admitted HMAC digest.
  Private IPC data never appears in arguments, environment or output logs.
- Its asynchronous active-wallet port captures one fresh complete connection
  observation with its durable revision, stable session source and evidence
  authority. Request-specific resolution and bound validation additionally
  capture the exact native account and its local selection and permission
  revisions. Connection capture alone does not resolve a default account.
  Consumers do not combine
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
  one storage owner through the SDK's public storage option. It routes explicitly
  admitted restoration namespaces to private SQLite and all other SDK values to
  memory. Values remain opaque; namespace lifetime belongs to Wallet.
- A connected Wallet projection preserves the complete admitted namespace set,
  its secret-free connection source and expiry. Canonical CAIP-2/CAIP-10
  identifiers retain case; only supported EVM identities use native normalization.
  Namespace and chain-scoped grants remain distinct. A request combines only
  the base namespace and that account's exact chain scope, never another chain's
  permissions. Observation of an account does not establish method availability
  or support for executing on that network.
- Wallet owns request-specific account resolution and validation of a previously
  bound account. Zero eligible accounts is unavailable; one is immediately usable;
  several require a valid direct local preference. The preference belongs to
  the profile, connection and network. It is neither SDK observation nor a
  Wallet permission, chain switch, financial grant or operation.
- Connection revision tracks admitted connection facts. Selection revision
  tracks actual preference changes or confirmed invalidation. Wallet's active
  permission map retains each unchanged account's last-change revision; removal
  and later re-admission do not restore an old reference. Bound requests keep
  their original account and required methods across preference changes.
  Fresh observation, original source, expiry and permission admission remain
  required; equality of a revision alone grants no authority.
- Unavailable observation closes execution authority without asserting source loss
  or clearing preferences. Fresh SDK observation must re-admit persisted
  preference before use after restart. Retained neutral account identity never
  proves a live session, address ownership or current request authority.
  Complete observed source absence remains a separate fact even when pending
  proposals make the public connection projection unknown. Its durable and
  authority transitions follow [Wallet Authority Recovery](#wallet-authority-recovery).
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

`src/runtime/paths.ts` owns directory synchronization and its handle cleanup.
Product database and control-credential publication invoke it at their own
settlement points; their artifact admission, publication and recovery remain
separate processes.

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
Reconciliation traverses directory entries incrementally through `opendir`; the
iterator closes on completion or failure and retains no whole-directory array.
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

Private scalar projections in `database.ts` check storage class and encoded
byte length with lazy SQL CASE before transferring complete TEXT or BLOB values.
Text crosses the driver as bounded bytes and receives fatal UTF-8 decoding;
rejected fields retain their metadata and cannot be admitted as null, absence
or a valid prefix. Existing canonical parsers own content and relationship admission.
Profile and owner scans retain one excess-row witness. Startup admits the exact
schema, profile, owner, current Wallet projection, permissions and preference,
and the exact recovery operations that projection names. It does not enumerate
closed operations, selections, ledger rows, cards or snapshots. The current
invalid-card projection is checked by generation; abandoned input is settled
lazily at exact card admission. Exact and page reads validate their bounded
canonical rows and required parent relations on one SQLite snapshot. A missing
referenced parent is not normal absence. Stored selection flags admit exactly
integer zero or one before boolean conversion.

Retained snapshot, card and ledger history has no total row or byte quota,
automatic expiry or pruning. Read admission has no whole-history count, sum,
map or global foreign-key check. SQLite foreign-key enforcement remains enabled
for every owned write. Individual rows, current collections, pages, live work,
SDK storage and transport retain their separate Numeric Policy bounds.
These bounds do not specify SQLite engine memory, file size, WAL size or query
duration. Disk exhaustion is an actual atomic storage failure, never a forecast
of future write success. Connection and artifact-observation settings are owned
by [SQLite Operating Limits](NUMERIC_POLICY.md#sqlite-operating-limits).

The persisted owner projection contains only a fixed singleton identity plus
the profile, owner instance, configuration identifier, process ID, owner
revision, and acquisition time. The application record omits the singleton and
carries the remaining six admitted values. No stored or live owner field acts
as a runtime wire-version selector.

The product schema persists local profile and runtime-owner identity, trusted
chain configuration, official-asset snapshots, verified contracts and token inspections,
durable account identity and the current secret-free Wallet connection
projection, account token-selection state, immutable
presentation snapshots, exact Wallet/Token operations, and received-hash
transaction accounting. The exact table names and
their SQL relationships are read from the SQLite schema owner, not maintained
as an independent documentation contract.

An official-asset snapshot stores the exact admitted source URI with its source
observation and members. Snapshot replacement writes that URI, and every
subsequent read admits the stored value through the same snapshot contract; the
database never reconstructs provenance from the current build constant. A single
synchronous deferred transaction owns header admission, the bounded member read
and complete snapshot validation. Nested write callers use the driver savepoint;
a concurrent committed replacement cannot combine one header with another
member set.

The Wallet connection header, namespace permissions and account membership are
normalized product projections. Each read bounds counts and encoded fields before
materialization and re-admits the complete canonical observation. Supported
current membership references retained neutral account identity; unsupported
opaque identities do not acquire an account-retention foreign key.

Wallet's source latches and independent recovery records follow
[Wallet Authority Recovery](#wallet-authority-recovery). The pure Wallet schemas
own their admitted forms; this store persists only their bounded canonical
bytes and exact correlations.

A healthy admitted connection retains every configured-network native account
in the same projection transaction, independent of available transaction
methods or local preference. Overlapping approval scopes reuse the same neutral
account row. Unknown, unresolved and unsupported identities do not retain new
accounts. Disconnect and preference changes do not delete retained identity or
Token choices. Confirmed Token addition may also retain its resolved account in
its existing transaction; explicit reads and Token Review creation do not.

Wallet local selection uses an expected connection and selection revision,
rechecks fresh eligible accounts and cancellation after await, then commits its
exact result synchronously. A no-op selection preserves its revision. A choice
made through a card commits that card's admitted result in the same transaction.
The ProductDatabase alone owns an outer write transaction and nested domain/card
writers consume that transaction; an unrelated external transaction cannot
bypass identity and write admission.

Public consumption of a trusted Wallet observation may atomically update its
derived connection projection, retain healthy configured-network accounts and
invalidate an existing read preference after confirmed source or account loss.
It does not select an account or admit a direct decision, pairing, grant or
financial request. It initiates or queues no SDK session deletion or containment.
The independent Wallet timer and event owners perform expiry cleanup. Declared
exact-operation convergence has its separate settlement responsibility under
[Durable Operation Ownership](#durable-operation-ownership).


Wallet and token-selection operations are durable exact
resources under [Durable Operation Ownership](#durable-operation-ownership).
Every operation SELECT admits storage class and encoded byte length in SQL
before returning complete bounded BLOB fields. Exact reads, current recovery
and write readbacks consume that projection without scanning terminal history. Each row then passes its
domain parser and indexed-identity comparison. An invalid existing operation is
runtime state unavailability.
Pairing URI and QR material remain owner-memory presentation state and never
enter the canonical operation, product SQLite, or the WalletConnect public
store projection.

The Token inspection cache stores one complete canonical result as UTF-8 BLOB
bytes under its chain, contract and digest identity. Its Numeric Policy owner is
separate from capability, transport, presentation and operation capacity.
Cache insertion admits bounded retention metadata on one SQLite snapshot and
keeps its separate row and byte limits. Exact inspection lookup admits the
selected bounded result through its canonical parser, serialization, digest and
indexed identity. Unrelated cache results are not startup inputs.

Each account selection stores a nullable exact inspection digest as a soft cache
key. It is not selection state, revision identity or a foreign key that gives
the cache authority over selection lifetime. Exact lookup uses the selection's
chain, token and digest together. A missing or evicted row returns no historical
inspection and never selects another cached result. Default selection creates
no key, addition and re-addition store the inspection used by that decision,
and removal preserves the key.

Before inserting a new inspection, the Token store reads bounded cache metadata
and removes the smallest canonical identity prefix required by the independent
row and aggregate-byte bounds. Eviction changes only cache rows. The initiating
candidate cannot be its own victim. Retention, candidate insertion, selection
mutation and terminal operation remain one transaction, so any later failure
restores the preceding cache and selection state. There is no background cache
worker, current-state substitution, history interface or compatibility reader.

Account Assets and Token Catalog consume the same Chain resolver as Address
inspection and account balance under
[Contract Analysis Boundary](#contract-analysis-boundary).

The account-assets application owns one selected-account collection read. On a
first page it resolves the target once, attempts one bounded Official Asset
synchronization, enters one Chain invocation, resolves one opaque canonical
block, and reads native balance plus at most five selected contract assets at
that block. Reading an unretained explicit address never creates an account or
selection row. If the resolved account is already retained and defaults remain
uninitialized, the application verifies the complete missing default set before
the collection read and commits it all-or-none only in synchronous finalization.
A failed verification or any other failure before that step
leaves default state unchanged.

The Account Asset contract owns token-position derivation and comparison, using
Registry's existing default-token rank lookup through its curated client entry.
The ordered manifest and lookup remain in one pure Registry module shared with
server consumers; the client entry exposes the lookup, not the complete
manifest. Account result validation and application pagination consume those
same position functions. The application validates prepared positions before
default initialization rather than sorting or repairing a contradictory store
result. Serialized responses enter the same owning result validator in HTTP
conversion and MCP App admission. Numeric field admission consumes the native and common
owners required by `docs/NUMERIC_POLICY.md`.

Preparation retains the exact existing page selections and verified pending
defaults in one ordered page. After preparation and the final caller/owner
abort gate, synchronous finalization checks continuity and optionally commits
default initialization. It uses that transaction's returned state and inserted
selections with the prepared existing values to construct the canonical result
and cursor. It performs no selection-store or clock read, Wallet capture,
asynchronous work, abort reclassification, or further mutation after commit.
Without a default commit, result construction uses the prepared state and
selections.

Later pages preserve the admitted account, Official Asset status, revision,
unavailability reason, and selection-set revision while resolving a fresh block.
The view revision and cursor both carry the resolved account, so a continuation
cannot be transferred between accounts even when all other revisions coincide.
An active read rechecks account, connection revision, and stable session-source
identity before finalization; an explicit read performs no Wallet capture.
Selection and Official Asset continuity are checked before that same optional
commit and result return. Owner close or process restart removes the in-memory
Official Asset correlation and requires a fresh first page.

Each visible official member is verified against StockFactory before it is
classified as a Robinhood Stock Token. Batch verification returns
identity-bearing results; the account-assets owner rejects a missing, duplicate,
unexpected, reordered, or member-mismatched result instead of recovering
identity from array position. An unavailable Official Asset snapshot retains
only its admitted source outcome and stored revision, while a current member
whose StockFactory verification is unavailable retains that member and
verification outcome as a different classification cause. The Account Asset
application maintains no current-value balance or token-standard read cache
and no dedicated read-error store. Retention of an admitted Account result for
immutable App redisplay follows
[Immutable Presentation Snapshot Ownership](#immutable-presentation-snapshot-ownership).
The collection is the only Account Asset application contract; no exact or
overview operation remains.
MCP App and CLI consume its admitted projection without reconstructing identity,
membership, or failure meaning.

A first-page collection may replace the single bounded Official Asset snapshot
and may initialize defaults for an already retained account. Its HTTP route is
therefore declared control. Its MCP tool is non-read-only, destructive,
non-idempotent, and open-world: snapshot replacement can remove prior derived
members, while default initialization is additive and never replaces an account
choice. A failed Official Asset synchronization preserves the last committed
snapshot and never changes account choices.

The stock-token-trade-history application is the sole owner of Stock Token/USDG
trade-history results. Its period owner fixes one half-open request interval and
the finest stored resolution with at most `185` positions from the canonical
result block. No provider, chart, or interface recalculates them.

One read consumes the registry owner's complete current official-asset
observation, resolves one official member, enters one Chain invocation, resolves
one opaque canonical block, verifies that member through StockFactory, and
reads ERC-20 decimals at the same block. Only after those identity gates succeed
does it call the archive source once. Caller cancellation, application closure,
and an unadmitted local failure
terminate the whole read. The application aborts and drains active work before
it closes.

The feature application execution owner registers the complete binding
invocation before official synchronization or another dependent effect. It
encloses Core input admission through final success publication, blocks new
invocations before abort and shares one close completion while every admitted
invocation drains. Runtime acquisition registers the archive source first and
the application execution owner second. Reverse cleanup therefore drains the
application before closing the source, with neither owner closing the other.

The archive source accepts a verified base address, exact request bounds,
canonical block and the selected non-`1m` stored resolution. The shared
interface-safe semantic owner revalidates that resolution as the finest one
within `185` natural positions. The source pins the greatest catalog root and,
after state admission, derives the calendar months touched by state coverage in
the natural-position window and the natural-start owner months whose complete
same-Pool intervals are aggregate-eligible. It Range-reads exactly those month
members and eligible selected-resolution members; an unavailable or stale tail
creates no member requirement.

The server keeps state, month and resolution roles, raw Pool chronology and each
raw coverage sequence internal. It retains producer boundaries while admitting
each role, then coalesces adjacent same-Pool segments once only when timestamp
and block boundaries are equal. It returns one provider-neutral result with the
canonical block-bearing coverage segments intersecting the natural-position
window, exact Pool keys, the coverage-owner month sequence, exact ordered month
and resolution member identities, and unchanged selected candles. It never
invents an outer block boundary.
The source contract owns its private operational settings; production consumers
cannot override them. The GitHub adapter owns bounded catalog and Range
transport and complete stream cleanup. It never downloads a complete packed
asset or reads a base-day or `1m` member.

The application consumes SourcePort coverage once to derive the exact requested
coverage range and one position per request-intersecting natural stored-
resolution interval. It does not aggregate source candles. A request-cut
position is partial but may retain its complete stored candle and Pool
provenance. Only an interior full-natural same-Pool position with its exact
resolution member admitted may use an empty candle as a no-trade claim. Raw
coverage segmentation and unused Pool facts terminate at this projection.
The trade-history application does not collect `Swap` logs, discover PoolKeys,
run an indexer cursor or repair process, build candles, or maintain a local
trade-history store. The protocol package's pool catalog and identity admission
remain separate from this archive-consumption boundary.

The public result is a compact closed stage union. Before archive selection it
retains only completed official, canonical-block, StockFactory and decimals
stages. Catalog-root unavailability retains no invented source; selected-base
unavailability additionally retains the selected root; selected-period
unavailability additionally retains the selected base-state identity. An
available result retains exact requested coverage bounds and limitations,
ordered month and resolution member identities without their internal coverage
arrays, only the Pool keys referenced by its positions, and at most `185`
natural positions with stored candles unchanged. The public parser revalidates
only relationships representable from those retained facts: request and
position bounds, requested coverage, PoolId to PoolKey, candle and source
ordering, canonical-block bound, member roles and position-state combinations.
Physical Range membership, natural-window coverage, unused Pool facts and
source-position membership in omitted block-bearing coverage remain SourcePort
admission facts and are never claimed as public replay checks.

The application, MCP, HTTP, CLI JSON, presentation admission and immutable
presentation-snapshot store hand off the admitted result losslessly. The result
contains exact requested and natural bounds, source-file identities,
requested coverage, limitations and complete position meanings.
Model-visible and human text distinguish complete absence, partial unknown,
unavailable coverage and request-cut candles that may include activity outside
represented request bounds. Snapshot replay reads only the stored canonical
input and result and has no chain, trade-history data or aggregation port.

The WalletConnect storage owner supplies the SDK's key-value interface. Its
private SQLite namespace allowlist contains client identity, keychain, pairing,
session, subscription and expiry metadata. The pinned Wallet adapter owns those
exact namespace identities. Other namespaces, including JSON-RPC history,
request/proposal/authentication bodies, messages and messages awaiting client
acknowledgement, remain in bounded memory. An unknown namespace never falls
through to durable storage. Existing non-restoration rows make the store
unavailable rather than being silently restored, migrated or discarded.

The product SQLite database never stores a pairing URI, session topic, symmetric
key, relay credential, raw WalletConnect session record, raw signature, or raw
signed transaction. Product persistence does not interpret, migrate, or repair
the WalletConnect SDK's protocol records. The separate private SQLite store
retains only admitted restoration namespaces through the opaque value boundary
described below. SDK request lifetime and cleanup follow the transaction owner
when a transaction request is supported.

Only the owned SDK worker opens the WalletConnect private database. It registers
storage before SDK acquisition. Once SDK initialization begins, storage remains
open until actual worker exit; SDK close never proves that its background work
has stopped. A successor must obtain the existing store's real EXCLUSIVE SQLite
admission before loading the SDK. Normal handoff also requires the parent's
confirmation of its owned child's actual close. After parent loss, the retained
store and exclusive reentry supply the ownership guarantee, not PID, file
presence or acknowledgement. Product and interface processes never open or copy
private SDK storage. A failed exclusive admission starts no SDK.

The private database has one current opaque key-value schema. It stores each
admitted restoration key as exact canonical UTF-8 bytes and bounded `node:v8`
values without interpreting them. Volatile values use the same codec and shared
key, value and aggregate admission in memory. Each durable mutation and its
revision commit in one SQLite transaction; each volatile mutation and its
generation publish synchronously. The store admits only its exact
owner-only main/WAL/SHM artifact set. It has no migration, compatibility reader,
schema repair, or WalletConnect-record projection. A latched filesystem,
SQLite, key, codec, limit, permission, or closed-state failure cannot become an
empty observation.

Before exposing an existing store, the private owner admits schema storage
classes and bounded BLOB prefixes against exact local tuple bytes encoded on
the same SQLite connection. This preserves admitted UTF-8, UTF-16le and UTF-16be
databases without converting them. The bounded row set and each tuple must
match completely; a prefix is never accepted as a truncated schema. The same
inspection runs in the initial read-only scope and again under exclusive
ownership. Metadata identity and revision are returned only when SQLite reports
integer storage. Other stored types are withheld as NULL and rejected by the
existing row, identity and revision checks; invalid rows are not filtered out.
Stored keys and encoded-value lengths are admitted before complete
entry reads. Successful startup, the retained exclusive lock and bounded
transactional mutations preserve those bounds for ordinary SDK reads.

Serialization may synchronously invoke a supported value's getter. The owner
rechecks admission after serialization and before entering the write transaction;
a failure or close during that call cannot permit a later outer mutation.
The owning interface exposes the combined SDK storage facade, a healthy revision
checkpoint and close. Within one owner lifetime the checkpoint is the persisted
revision plus the volatile generation; any effective mutation changes it. The
volatile generation is not restored or compared across owner processes. Close
blocks admission, releases volatile values and attempts native handle release,
preserving a latched failure. Numeric classifications and byte-limit exclusions
are owned by [WalletConnect Private Storage Limits](NUMERIC_POLICY.md#walletconnect-private-storage-limits).

SQLite connection state is a derived product projection and never proves that a
wallet is currently connected. A stable public SDK observation is exactly:

1. read the combined storage checkpoint;
2. read the SDK's public proposal collection;
3. read the SDK's public session collection; and
4. reread the combined storage checkpoint.

The observation is available only when both revision reads are healthy and
equal within the same owner. It performs no SDK mutation. The adapter preserves optional namespace
field absence and converts session topics only to secret-free session-source
identities before returning the observation. Every returned session is
addressable by one such source. If any SDK session entry cannot produce that
source, the complete observation is unavailable rather than an unresolved set
that cannot be reconciled.

The coordinator projects one complete observation in this order: an active
effect is unknown; an unavailable observation is unknown; proposal-only state
is reconciling; any invalid session, multiple sessions, a session plus another
proposal, or a nonempty observation blocked by a source or recovery cause is
unresolved; one valid session is connected; and only a stable empty observation is
disconnected. It validates complete namespace scope, canonical chain and account
identities, expiry and source health independently of request-specific method
availability. It never selects a session from an unresolved set.

WalletConnect callbacks are wake-up hints rather than connection or actor
evidence. The adapter attaches SDK callbacks before handoff, retains admitted
events in one bounded queue, and releases them only after the coordinator has
registered the sole consumer and the adapter has attempted one stable initial
observation. Events captured across that activation boundary use the same
mapping as later events; an identity event that cannot be attributed closes
current authority and schedules a stable observation instead of disappearing.
A generic observation-change callback closes current authority before scheduling
fresh observation; it never writes a connection projection from callback data.
Observations and live checks are asynchronous across IPC. Every consumer checks
current source, revision, permissions, cancellation and expiry again after await.
Unknown callback types are ignored. Correlated malformed identity and recovery
follow [Wallet Authority Recovery](#wallet-authority-recovery).
Normal accountsChanged, including partial or empty account lists, and
chainChanged callbacks request fresh observation without replacing approved
accounts, permissions or preference. If a later nonempty unresolved observation
still contains the previous exact source, the coordinator retains it only as an internal
callback-attribution key; it exposes no active session and authorizes no wallet
request. An observation that no longer contains that source clears the internal
attribution. Deletion and expiry wording never become the cause of a public
projection; only an exact owned effect plus its stable postcondition can supply
an effect-specific disconnected reason. An unchanged stable empty observation
preserves an already admitted disconnected reason; absence alone cannot replace
that causal fact or advance the connection revision.

Shutdown closes parent authority and new command admission first, starts worker
containment, then drains bounded consumers. The direct worker entry terminates
its actual process after containment; parent loss enters the same cleanup through
IPC disconnect. The parent owns close completion and forces only its owned child
if the existing settlement wait expires. Forced termination is not itself release;
late actual close settles the same ownership and never creates a new child.
A successor restores SDK state and obtains a new healthy stable observation before
publishing authority. Runtime process-terminal ownership is reserved for unresolved
cleanup rather than normal SDK shutdown.

Public request waiting, request-resource cleanup and the original SDK future have
separate completions. Local expiry, caller cancellation or an IPC reply cannot
release an unsettled financial/signing lane. Only its original future's actual
settlement or confirmed child close releases that reservation. An uncertain send
is never resent. A late hash uses only the original bounded Receipt continuation;
an expired signature is discarded. Child termination does not establish that an
external Wallet effect has ended.

Both stores live under the Little John application-data directory rather than
the repository or client storage. Little John restricts their filesystem
access to the current operating-system user and excludes their contents from
application logs, exports, and diagnostic bundles.

### Wallet Authority Recovery

Wallet keeps observed session facts, execution admission and exact operation
outcomes separate. `src/wallet/authority-recovery.ts` owns the pure product and
cleanup recovery schemas. Runtime stores their nullable canonical BLOBs in the
current connection singleton and retains the bounded malformed-source ID set.
Numeric field admission is owned by
[Wallet Connection Storage Admission](NUMERIC_POLICY.md#wallet-connection-storage-admission).

A malformed-source latch closes only its correlated source until complete
observation proves that source absent. A product recovery record identifies an
uncertain projection or the exact operation whose durable successor is
uncertain. A cleanup recovery record identifies the original management
operation or expiry source whose settlement or empty postcondition remains
unproved. Transient observation unavailability remains in memory and does not
prove source loss. These causes can coexist; satisfying one never clears another.
Healthy partial namespace approval is neither malformed identity nor product
persistence uncertainty.

The coordinator closes execution before persistence or observation can yield.
Closing or closed ownership, unsettled original work and either recovery cause
prevent execution. A complete observed source set drives source-latch removal
and preference invalidation in the projection transaction, even when the public
projection is unknown. Permission entries are published after commit. Reappearance
of the same source or account cannot restore its old permission reference.

Product recovery requires trusted storage-owner readmission: the retained
main-file lease, original profile, exact schema, necessary current rows and exact
operation predecessor or successor must all admit normally. The coordinator
also proves the original work's actual settlement or containment and obtains
fresh complete SDK facts. Startup and existing serial convergence perform this
reconciliation. A public observation read can admit a derived projection and
already-established durable outcome; it cannot derive an operation successor or
initiate external cleanup. Missing or corrupt required predecessors remain
unavailable and are never reconstructed, deleted or repaired.

Every recovery attempt binds its current cause and correlation, observation
epoch, worker generation, original effect identity and expected connection
revision, and rechecks them after awaiting work. A late observation or effect
cannot clear a newer cause. The storage owner conditionally commits the next
connection counter, projection, preference invalidation, admitted cause removal
and any exact reconciled operation successor in one synchronous transaction.
An earlier admitted terminal outcome retains its original committed connection
reference; a newly derived completed outcome binds this publication. The parent
publishes the permission map only after commit. Recovery resets authority even
when public connection facts are unchanged, and counter exhaustion leaves it
closed.

SDK emptiness alone does not clear product uncertainty. Cleanup recovery requires
actual original settlement or containment and the complete stable empty
postcondition. If work has settled but sessions remain, execution stays closed;
a complete trusted target set permits a new disconnection Review and direct
decision. That new operation commits before its new reviewed cleanup begins.
It may replace the settled cleanup correlation, but never rewrites an earlier
terminal result, deletes an unreviewed source or resends an earlier effect.

Startup admits the same recovery records and source latches while execution is
closed. It consumes the actual prior worker exit and exclusive private-store
admission required by [Runtime Lifecycle](#runtime-lifecycle), then fresh SDK
facts and the same no-resend reconciliation. A failed attempt to persist a cause
retains the in-memory closure; trusted recovery first records that exact cause
before clearing it. No history scan, event log, SDK-record copy, automatic repair,
new polling owner or public recovery API supplies authority. Worker termination
does not prove completion of an external financial request.

## Immutable Presentation Snapshot Ownership

`src/runtime/presentation-snapshot.ts` owns contract-identity admission, snapshot
ID syntax and identity calculation. SQLite create/read/chunk paths and App
descriptor admission consume that same implementation; their separate byte,
resource and canonical-result checks remain at the receiving boundaries.

One Runtime-owned SQLite store retains exact admitted input/result pairs for
read-capability and durable Wallet/Token Review redisplay. Transaction decisions
use the source declared by their owning presentation contract instead.

| Source | Retained value and read lifetime |
| --- | --- |
| `sqlite` | Existing immutable read and durable Wallet/Token presentation pairs; exact persisted reads |
| `review_memory` | The original command and Review in the same Runtime slot as its request; exact reads end on consumption, discard or expiry |

A snapshot is a presentation replay cache. Domain
applications, evidence owners, operation transitions, CLI projections, and
support projection cannot read it, execute its stored input, or derive
availability from it.

The closed presentation registry defined by
[Interface Contract Model](#interface-contract-model) binds an existing
canonical contract object to its immutable snapshot admission and typed
presentation. It never reconstructs a contract from a string identifier. After the contract
normalizes and admits input and admits its correlated result, the registry
captures each value as canonical JSON and encodes it once as UTF-8. Canonical
input consumes the Local HTTP request-body bound owned by
`docs/NUMERIC_POLICY.md#local-http-limits`. A capability-backed result remains
subject to its owning capability success admission. The separate presentation-
result capacity is owned by
`docs/NUMERIC_POLICY.md#durable-operation-and-presentation-limits` and is not a
Core read-capability or durable-operation projection. Raw MCP or HTTP
envelopes, headers, MCP Host metadata, user messages, credentials, WalletConnect
material, and signing material are not snapshot input.

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

Contract IDs contain well-formed text without NUL and contract versions are
positive canonical base-10 integers. Their storage envelopes are owned by
[Durable Operation And Presentation Limits](NUMERIC_POLICY.md#durable-operation-and-presentation-limits).
The strict descriptor has kind
`presentation_snapshot_descriptor` and contains its explicit source, snapshot URI,
snapshot ID, contract ID and version, the input and result UTF-8 byte lengths
and digests, result-chunk byte limit, and result-chunk count. The live Review source additionally identifies its
operation and expiry. Stored URIs retain the form above; live Reviews use
`littlejohn://presentation/reviews/{operationId}/sha256/{identityDigest}` and
cannot fall through to the SQLite store. A blocked decision has no source
resource; its saved card carries only the admitted closed classification.
The chunk byte
limit is owned by
[Durable Operation And Presentation Limits](NUMERIC_POLICY.md#durable-operation-and-presentation-limits);
the chunk count is the ceiling of the result byte length divided by that limit.
Chunk indexes are zero-based. Every non-final chunk fills the limit and the final
chunk is the remaining nonempty slice.
Result chunks cover `R` once, in order without overlap or gap.

The strict `presentation_snapshot_resource` contains only that kind, the
descriptor, and the normalized canonical input value. Canonically serializing
that input must reproduce the descriptor's input length and digest. The
complete resource response must fit the unchanged internal compatible-process
response limit. Snapshot admission checks this bound before insertion or
advertising.

Retention has no total row or encoded-byte quota. Equal contract identity,
canonical input bytes and canonical result bytes reuse one immutable row without
refresh or mutation. Identity, admitted bytes, lease and insertion are checked
in one SQLite transaction. A collision, partial write, I/O or lease failure
advertises no new source. Individual result, input, metadata and chunk bounds
remain owned by Numeric Policy. No snapshot is deleted automatically or selected
by insertion time, and no result-only row, migration or inferred input exists.

`interfaces/immutable-read-application.ts` owns canonical read execution for
card collection and initial MCP data delivery. Its registered contract objects
and fixed domain ports admit the original input and result. The data registry
includes read-only sources without adding View renderers or card kinds.
One native local-control result request returns either the original inline value
or an exact immutable resource. The backend measures the same complete MCP
formatter used by the foreground and commits that source only when reference
transport is required. It accepts no caller-supplied result or execution method.
The foreground never writes snapshots or repeats the domain read to obtain them.
Source framing is distinct from the canonical result and never enters its bytes.

Snapshot persistence failure never changes the already admitted domain result.
It fails the dependent MCP reference delivery without repeating the read;
canonical HTTP and CLI results keep their owning contract. Card preparation,
commit and asynchronous read failure are owned by
[Card State Ownership](#card-state-ownership). A failed result delivery does not
roll back a committed card or repeat its read. Exact source lookup or chunk read reports
`presentation_unavailable`; its reason is exactly one of `capacity_exceeded`,
`runtime_unavailable`, `snapshot_missing`, or `snapshot_inconsistent`.
An input or result above its section bound, a snapshot resource above the
internal response limit is `capacity_exceeded`.
Invalid request syntax remains the owning interface's `invalid_input` failure
and is not converted into a presentation reason. Corruption, identifier
mismatch, invalid canonical UTF-8 or JSON, contract-admission failure, and
missing chunks fail that exact presentation and never cause a domain refresh
or another snapshot lookup. An unrelated valid snapshot remains independently
readable. Existing SQLite schema mismatch keeps the reset behavior defined by
[Local Persistence Boundary](#local-persistence-boundary).

Explicit card publication returns only its bounded creation acknowledgement
and exact card reference. Creation and source commit order belongs to
[Card State Ownership](#card-state-ownership). Source preparation checks the
complete resource bound and the committed record must equal its prepared bytes.
The acknowledgement never substitutes for the canonical source pair, and a
transport failure after commit never becomes permission to create it again.

`resources/read` accepts only that canonical URI and returns the bounded
snapshot resource, never `R`.
`presentation_get_snapshot` is a pure model-visible tool that accepts only the
exact URI, admits its retained metadata and normalized input, and returns one strict
`presentation_snapshot_reference` with the same link and descriptor; it copies
no retained payload into its structured result and attaches no View-private
snapshot data or UI association. Snapshot lookup never selects a card from an
operation or source identity. Explicit card publication and
exact card reads use [Card State Ownership](#card-state-ownership); neither
snapshot lookup nor redisplay creates a card or admits decision input. Its registered producer returns the complete MCP
handoff once; the handler does not bypass it through another snapshot getter.
Known reference failures preserve their owning meaning: missing, inconsistent,
capacity and runtime availability map to their corresponding presentation
reasons. A request abort stays a call abort, and unknown exceptions do not become
successful presentation data.
`presentation_get_snapshot_chunk` is App-only and accepts only an admitted
snapshot URI and result-chunk index. The URI identifies its owning source; the
returned chunk still binds the exact snapshot ID. It returns one strict
`presentation_snapshot_chunk` containing that ID, index, and RFC 4648 Base64
with required padding and no whitespace for the exact result slice.
Decoding and encoding again must reproduce the identical string. None of these
owners exposes a current, latest, default, list, mount, or descriptor-free
lookup.

The model-visible result-part contract admits only SQLite immutable-result
entries. Metadata reads validate identity, normalized input, lengths and digests
without transferring the complete result. Each part consumes the same verified
chunk owner as the App and carries exact source and position correlation.
Private/live/decision sources are rejected before chunk access; resources and
parts do not enumerate history or create UI. Consumers assemble ordered bytes,
verify length and digest, decode canonical UTF-8 JSON and use the original owning
input/result parser before treating them as domain data. Metadata admission
alone does not validate the untransferred result body.

The View's initial result admits only a card acknowledgement or its tool error.
First display and redisplay read the exact saved card and consume its admitted
source resource. They use the same sequential result-chunk reader: decode
Base64, join bytes, verify length and digest, perform fatal UTF-8 decoding and
canonical JSON checks, then re-admit the normalized input and correlated result
through the owning registry before rendering. The resource's input bytes and
identity are independently admitted at that boundary. A model snapshot-reference
result is data for the model and cannot initialize a View. JavaScript string
indexes never own chunk boundaries.

## Transaction Request Ownership

Runtime constructs the Review application after the actual Chain, Wallet,
Registry and native protocol producers. Exchange, Signing and Receipt/Activity expose separate
canonical application ports. Interfaces register their reads and compatible-process
controls; they do not construct those domain lifetimes. The original command and
ready Review are serialized from the same memory slot for App presentation.

The local Wallet-request delivery path keeps only operation correlation and request
input length/digest while awaiting its result; it has no durable recovery read or
resend target. MCP's matching continuation follows the same retention boundary.
The App response adapter consumes that compact input evidence rather than keeping
a complete Review solely to verify a later response carrier.


Transaction authority and receipt claims are owned by
`TRANSACTION_POLICY.md`. Transaction Reviews and direct grants must consume a
Runtime-owned expiring memory source. They do not use the durable Wallet/Token
operation or SQLite presentation-snapshot stores. A live immutable transaction
Review may be read until its owner releases it; an expired or consumed artifact
cannot be reconstructed for replay. The App presentation contract must identify
this memory source explicitly, with no SQLite fallback.

Wallet owns the request continuation and the SDK's private protocol state.
Local wait termination and SDK request settlement are separate events. Request
and message bodies must remain volatile and be retired at their owning lifetime;
replacing the injected backend alone does not establish controller cleanup.
Only restoration state survives owner restart. No pending transaction is resent
or queried merely because an owner starts.

Review produces the immutable versioned request-comparison reference before
Wallet handoff. Receipt/Activity admits a returned hash and that reference into
one atomic ledger record; there is no pre-send transaction row. Its persistence
port accepts no complete Review, calldata, signed serialization or signature.
A user-supplied hash cannot supply or manufacture a reviewed-request reference.
The ledger and stored read views have no port to issue a Wallet request.

Receipt/Activity owns explicit bounded reconciliation and its canonical actual
result. Runtime owns its SQLite storage; interfaces consume the admitted result
rather than reconstructing it from a summary or requesting domain effects during
presentation. Numeric storage and waiting bounds belong to `NUMERIC_POLICY.md`.

The ledger writer atomically increments its account's signed-64 revision with
every actual canonical row change; identical bytes do not increment it. Missing
revision for retained rows, overflow or I/O failure is unavailable and leaves
both row and revision uncommitted. Reconciliation uses indexed candidate pages,
not a retained array. One Chain invocation emits pinned source/block/confirmed
nonce and starting revision, each canonical dependency, then normal completion
with the final revision. Own writes use revision CAS, and another writer or a
missing end makes the observation incomplete. Review keeps only the small
predicate accumulator and completion stamp. It checks current revision, bound
Wallet authority, cancellation and deadline after dependent awaits and again
before synchronous grant consumption. No prefix observation authorizes a request.

## Data Signing And Shared Request Material

Review owns signing command, temporary Review, direct-decision, response context
and outcome contracts. Intelligence owns signature verification; Chain adapts
the installed viem hashing and recovery without exposing SDK types. Runtime
constructs both consumers of one expiring request-material owner, with aggregate
reservation capacity across transaction and signing material. Domain-specific
admission remains in each owner; callers cannot configure its lifecycle order.
Wallet uses one request lane and protocol-resource cleanup for all admitted
request methods. Transaction results alone enter Receipt/Activity.

A signing completion contains one canonical public outcome and, only when
verified, the exact private signature. The outcome binds operation, account,
method, pre-send message hash and SHA-256 of the exact signature bytes. Native
authenticated control delivers the closed pair. MCP delivers the complete
outcome in ordinary structured/text fields and the signature only under the
declared App-private `littlejohn/signature` metadata key, attached before final
result-size admission. The operation-result descriptor describes only the public
outcome. No public read or result-retrieval API exposes the private value.

The App checks the outcome against its compact pre-send response context and
checks the private bytes against its digest before display/copy. Missing or
invalid private carriage is delivery unavailable without retry. The value belongs
only to the current result panel; dismissal, replacement and teardown release
product references. CLI admits the same pair, writes only to interactive TTY,
settles output and releases its result. Backend result retention is response-
scoped. Neither path caches, snapshots or persists the signature, and reopening
an old Review cannot retrieve it. External copies and verification claims follow
`TRANSACTION_POLICY.md#data-signing`.

The shared no-replay local request delivery retains only admitted compact
response correlation, never the full Review. Signing has no receipt interval or
transaction-shaped fallback. Required and optional Wallet methods have one
Wallet-owned definition; actual namespace permission admits each exact request.
Wallet connection observation does not resolve a default account. The signing
response continuation receives only the original source ID, compact response
context and fixed local expiry, and consumes those fresh connection facts. It
receives no executable permission reference or default-account selection. The
handoff and response authority are owned by `TRANSACTION_POLICY.md#data-signing`.
Missing permission requires explicit disconnect/connect reapproval, never an
automatic broadened session. Wallet metadata consumes the installed package's
HTTPS homepage from its own manifest, with no separate URL or fallback.

## Durable Operation Ownership

This section applies to Wallet management and token selection. They own separate
operation stores and canonical contracts; transaction requests follow
[Transaction Request Ownership](#transaction-request-ownership). They may share primitive operation IDs, canonical
JSON capture, and SQLite transaction utilities, but no configurable operation
framework owns their Review meaning, revalidation order, effects, failures,
or restart behavior.

A model-visible Review creation retains the admitted immutable input and Review
under its owning durable source, including exact disconnect-target snapshots
when required. It creates no domain operation, direct decision or Wallet effect.
The Review contains one reserved, unstored operation ID, creation
time, one server-owned action deadline admitted by that domain's canonical
operation contract, exact decision facts, fixed evidence anchors, one closed
domain precondition value, and a domain-owned digest. Presentation may retain
the already admitted Review under the snapshot contract; that cache write does
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

The complete Review and direct-action envelope consume the Local HTTP request-
body bound owned by `docs/NUMERIC_POLICY.md#local-http-limits`. A Review
contains a bounded decision projection rather than another capability's
complete result. Domain contract modules own the exact fields and generated
maximum envelope.

Every stored operation contains its operation ID, domain kind, informational
`initiatedBy` value `cli` or `mcp_app`, immutable verified Review and digest,
creation time, deadline where applicable, exact state, and the one result,
failure, peer refusal, or empty terminal outcome admitted by that state.
`initiatedBy` is provenance and never prevents an exact read or permitted
Wallet cancellation from the other direct interface.

Every stored operation consumes its domain row capacity under
`docs/NUMERIC_POLICY.md#durable-operation-and-presentation-limits` and must fit
the complete framed Local HTTP exact-result response. The MCP and CLI paths
return that same admitted canonical operation and never reconstruct it from a
summary, snapshot or cache projection.

Token selection exact reads, list reads, and Review creation carry one canonical
Address target. Exact and list results carry the resolved account even when a
page is empty. A Review stores that account with either an explicit-address
precondition or an active-Wallet precondition containing the captured connection
revision. Explicit Reviews never read Wallet state. Active Reviews re-resolve
the same account, revision, and session source after their Chain work; a decision
repeats the durable connection check inside the mutation transaction. Duplicate
operation lookup retains precedence over those current-state checks.

Token addition stores the exact inspection repeated at action time in its
completed operation. After duplicate-operation lookup and complete current-state
revalidation, the owner serializes that inspection and the intended terminal
operation before its first mutation. Either produced size excess returns
non-retryable `result_too_large`; no cache row, selection, selection-state
revision or operation is written. A cache-admitted decision atomically applies
required cache replacement, the exact inspection and selection key, the
selection mutation and the terminal operation. Token removal performs no
inspection, so its completed operation carries `historicalInspection: null`.
Public selection reads independently resolve only their stored exact cache key
and do not change the removal operation.

The Token contract owns one private inspection-derived projection shared by
Review construction and completed-addition validation. The canonical operation
validator checks the Review's inspection-derived facts against its embedded
inspection independently of request correlation. Stored-row and interface
readers consume that same validator; validation performs no Chain read or
post-commit repair. Field comparisons remain defined by the Token contract,
separate from the producer's pre-write reinspection and atomic storage process.

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

Wallet ordinary and presentation operation reads consume one coordinator
process: open/ID admission, exact stored lookup, nonterminal convergence and
exact stored re-read. This declared exact-operation convergence may settle an
existing management attempt and publish its conditional durable successor; it
does not create or resend an operation. Presentation adds only the matching
currently permitted
in-memory QR, without an asynchronous gap after operation selection. A failed
successor write retains the stored predecessor and removes QR; neither reader
substitutes an in-memory operation for the store.

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
nonterminal operation, the coordinator preserves its exact inherited predecessor
while the SDK is acquiring. It does not turn missing readiness into a terminal
failure, create expiry intent for inherited approval evidence, or reopen execution
authority through a public capture. One reconciliation owner consumes readiness,
coalesced wake-ups and exact-operation demand, discards invalidated replies, and
joins its owned completion during close. Live attempt expiry keeps its separate
responsibility. Cancellation admits the exact live or inherited cancellable entry
through the same conditional operation transition.

The wallet application gives the client and coordinator the same composed
Runtime and application-shutdown signal. The coordinator checks that signal at
activation, callback admission and after await, before inherited publication.
An aborted lifecycle takes precedence over client unavailability even when worker
containment wakes the coordinator before its close call. Application shutdown
aborts admission and begins SDK containment before draining consumers. It retains
the original live cleanup and bounded result continuations; a signal is not
settlement or release.

After readiness, for a nonterminal connect, one stable valid session matching the persisted Review
may complete the operation. Otherwise the Wallet adapter expires every pending
proposal, disconnects each pairing not referenced by an admitted session,
performs a second bounded stable observation, and settles the operation to its
stored cancellation or expiry target, or to `failed` when success cannot be
proved. It never reconstructs QR or resends connect. A settled healthy approved
session that does not satisfy the original connect Review's required scope
produces `failed` with `wallet_session_unusable`; its exact approved namespaces
remain independent connection facts. Missing methods do not create a product
or malformed-source recovery cause. `disconnecting` becomes
completed only when stable observation proves the required empty postcondition; a
retained or unavailable session produces `failed` without resend. Malformed,
multiple, conflicting, or unbounded SDK collections make Wallet authority
unavailable rather than fabricating cleanup or completion.

Token-selection actions have no nonterminal state. The owner revalidates its
Review and atomically commits the domain mutation
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

Wallet App-private metadata never copies the canonical operation. When an
active operation has QR material, one strict envelope carries only its kind,
exact operation ID, the admitted public operation-result SHA-256, and the QR
matrix. The View first admits the public operation result and accepts that QR
only when the operation ID and result digest match and the admitted state and
deadline still permit presentation. Missing, malformed, stale, or mismatched
metadata displays no QR and cannot change the public operation.

## Card State Ownership

Interfaces owns the canonical card contract and one backend card application.
Runtime owns its product SQLite store and supplies the current HTTP owner's
lifecycle, domain ports and immutable snapshot store. A View, MCP Host event,
model answer or widget cache is never a card-state authority.

Each publication has an independent `cardId`. A decision binds its actual domain
operation and original canonical source; local account selection has connection
and network context without a fabricated operation ID. Several cards may refer
to the same immutable Review. The domain owner still permits that Review's one
consumption, and another card's existence does not close input. Exact card/source
admission uses `cardId` and the admitted descriptor; an operation-to-single-card
lookup is not permitted. Snapshot-only reads remain immutable resource reads.

Decision input is `input_pending` or `input_closed`. Closure has an exact reason
and only submitted input has a dispatch identifier. Domain progress, admitted
outcome and response-transport uncertainty remain separate from input state.
Read cards are readonly and carry only preparation state, contract/input digest
and exact snapshot reference. A creation reservation has no decision controls.
Metadata contains no raw transaction/signing Review, executable request, grant,
signature, pairing secret, QR or event log.

`cardOpenRequestId` correlates a View request and its retries; it is not first-View
exclusivity or financial authority. A newly authenticated View may re-admit the
same pending card and live source. Redisplay, another View, focus and teardown
never close input or create a new domain request. Exact private-source lookup
ends with the existing material lifetime. A saved closed classification never
restores that material or a private signature.

One card application owns creation reservation, domain preparation, commit,
publication and cleanup. Ordinary data, Review, status and snapshot/chunk tools
return their canonical values without creating UI. Explicit read or decision
creation consumes the registered owner and returns its actual card reference
and created, existing or creating disposition. Existing-source creation reads
that exact source and never substitutes a newly prepared Review.

For general Codex publication, the MCP binding normalizes only own thread/turn
properties of the supplied metadata object. Provider extras remain unread and
are not stored. Missing or malformed required context rejects only new general
publication. Runtime derives a profile-bound HMAC under a separate publication
domain from the existing local credential. Raw context and credentials never
enter product rows, card fields or financial authority. Other standard App
bindings do not require Codex context. Charts do not consume a general key.

The store reserves the publication key before preparation. The shared Interfaces
work owner reserves a current creation permit; stored card counts do not consume it.
Wallet/Token durable Review, immutable snapshots, card metadata and created key
commit in one product transaction. Private Review registers with its existing
bounded memory owner before metadata commit; known precommit failure disposes
that source before releasing the reservation. A cleanup failure retains failed
ownership and cannot start another preparation through that key. SQL never spans
SDK/RPC await. Created or live-creating keys return their original reference
without another producer call. An unfinished old generation becomes owner_lost
without replay. Late cancelled delivery cannot release a committed key.

A readonly card read reserves current input-plus-maximum-result work capacity
before its one owning execution. Its pending reference commits before collection;
completion commits the exact snapshot and completed card atomically. The permit
is held until the original work settles, including after cancellation, and is
released in its cleanup. There is no durable read-reservation table. Completed
history and unsubmitted stored decisions consume no live permit. Exact reads of
abandoned-generation creation, pending reads or pending input perform the
original conditional owner-loss transition without a startup sweep. Submitted
Wallet/Token results remain with their operation owner and are not overwritten.
State read, remount and restart never execute the stored input. A Wallet creation
with no required decision retains its compact canonical result without a fake
operation.

Direct input first admits its exact source and subject. Invalid input and an
unchanged subject's stale preference revision do not consume pending input.
Wallet/Token/local-selection admission and card closure share one SQL commit.
Private financial/signing preparation returns opaque server-owned material;
card closure commits synchronously before its existing grant/RPC/Wallet handoff
starts. A reserved private source is temporarily unavailable to presentation;
that is distinct from consumed, expired or discarded material. Reads cannot
cancel the preparation, and a losing admission cannot dispose another caller's
prepared slot. Temporary source/RPC failure preserves the original unconsumed
source; confirmed source invalidation closes input without submitting an effect.
Commit failure disposes that attempt's prepared material without an effect. Caller
cancellation gates commit, and cancellation after commit never rolls back or
reports a committed local change as cancelled. Domain completion only changes
the original outcome, never reopens input or retargets the request.

The backend reads current domain state and exact saved card/source before
projection. Confirmed expiry, source invalidation or owner loss closes pending
input. Temporary unavailability disables controls without inventing a domain
outcome. A closed input may accompany pending Wallet work. Explicit Wallet
cancellation remains its owning operation's action; financial/signing Stop waiting
ends local waiting without claiming remote cancellation. Original bounded late-hash
accounting remains separate. Actual terminal facts take precedence over delayed
reads or display errors.

`CardPresentation` carries admitted state, exact decision/snapshot resource or
typed operation projection and currently available controls. Local selection
keeps its initial immutable subject/list and obtains only the current selection
revision for direct input. A changed connection invalidates that original subject.
UI never reconstructs a canonical operation from the projection. An available
Wallet QR may be read again from the same live operation's private owner and never
starts another pairing; terminal work removes it. Signature transport remains
one response/current result panel and is not recoverable by a card read.

The native action envelope pairs the original canonical result with its current
presentation and optional private QR. Each original domain binding admits its
inner result. MCP carries the admitted presentation as bounded canonical JSON
text in View-private metadata; the direct result descriptor correlates the same
input and original result. A display/storage failure does not replace an already
admitted domain response. Unknown response delivery permits only an exact saved
read and never a resend; a later current preference alone cannot prove that a
lost selection response committed.

A fixed HTTP owner settles abandoned reservations and unfinished reads before
exposing controls, closes unsubmitted old decisions, and observes existing
Wallet/Token postconditions without repeating effects. Owner shutdown closes
card admission and aborts registered work before HTTP draining, then joins the
existing application close. It does not close the database or SDK out of order.
Numeric owns metadata, reservation and complete response bounds. Profile/schema
admission has no compatibility migration, silent repair or user-state deletion.

## MCP App View Lifecycle

One `interfaces/mcp-app` owner implements immutable presentation, durable
exact-operation presentation and temporary transaction and signing decisions over typed
inputs. The
exact-operation family has two closed flows: atomic decision to terminal and
Wallet observation. These flows share admission and terminal adoption but do
not configure, reorder, or emulate one another. A renderer owns semantic DOM
and SVG only and cannot make tool calls or configure lifecycle order.

The View result ingress first admits the protocol envelope and its supplied
creating facts. It reads only the relevant own fields. Absent or exactly
undefined optional protocol properties are absent; null and malformed supplied
facts are not repaired. Unrelated Host metadata is not canonical product data
and is not hashed or retained. A complete creation acknowledgement is admitted
through its owning schema from structured content or its complete JSON text;
JSON whitespace and key order do not change that value. A card reference alone
may identify the same saved card. All supplied acknowledgement copies, card
references and explicit error flags must agree before any card read. Text is
bounded before JSON parsing by its existing source-packet bound. Domain data,
partial text and snapshots do not become creation acknowledgements.

The ingress then applies one standard-first creating-result tool-error
admission before any snapshot, resource, or chunk admission. An intact
`isError: true` result enters directly. Exact `chatgpt` View-reported MCP Host identity may
restore only the two measured creating-error forms defined under
[MCP Apps Integration Requirements](#mcp-apps-integration-requirements).
Only absent optional protocol properties are normalized for that exact outer
shape check; defined extra fields are not removed to manufacture an admitted
form. An explicit error flag in the admitted one-layer creating wrapper is
received error information, not a new missing-flag inference. Inner text never
adds another missing-error form. A successful acknowledgement alongside an
explicit error flag is inconsistent and causes no resource read.
The exact common MCP delivery-size error retains its owned statement. A
canonical application failure is admitted through its registered owning failure
schema, including its code, category, exact message, retryability and bounded
structure. Registered contracts sharing a code must share the same definition.
The View displays an admitted failure's code and message as Request failed,
without raw exception or issue text. An unrecognized standard tool error keeps
one generic, bounded statement. The measured Codex missing-field application
form enters the same admission only when its strict canonical failure and text
agree. Failure admission does not infer an owning operation, a grant, a new
card state, or a reason to restart or resend. A
malformed, mismatched, broadened, explicit-false, or success-shaped missing-field
result enters neither error form. Tool-error admission never treats an error as
failed domain-data verification, reads a resource, calls a tool, or renders raw
error data.

After tool-error admission, the common ingress passes the exact admitted card
identity to the existing card opening process. A complete acknowledgement,
strict card metadata or exact card link can supply that identity; its carrier
does not determine input authority or introduce another View mode. A created
card's View reads its exact saved card and re-admits the original source before
direct input. Ordinary data and snapshot references alone cannot open a card.
Snapshot-only redisplay acquires no decision controls. A pending decision read
without a View request returns its exact available Review
with no controls. It preserves the original decision and never creates a direct
decision payload in the View. Pending decision reads without an opening also
carry no mutation controls or QR. The original decision View and read-operation
controls retain their own admitted actions. A failed original opening retains
its View execution ID. Until a matching opening response is admitted, an explicit
retry uses the same existing open contract and ID. After that admission, a
detail or state failure permits only the existing exact read. Snapshot and read
Views never acquire an opening through recovery. Neither recovery path creates
a Review or repeats a domain action, and the backend rechecks its original
state, expiry and source conditions. Closed-state display
does not read or reconstruct consumed Review material. Only a still-actionable
decision proceeds to exact Review admission before enabling direct controls;
the backend supplies the operation's admitted display projection. A missing
or inconsistent card reference is not a normal closed state. Renderers do not
decide persisted transitions, and a repeated creating result within one View
does not open a second decision.

The common ingress admits each notification once after standard View
initialization, holds at most one pending admitted identity before connection
settles, and compares repeated delivery by admitted card identity or failure
meaning. It does not compare hashes of whole Host packets. Same-card delivery
preserves the existing result and its current lifecycle. Conflicting delivery
invalidates that View, disables controls and disposes private material without
changing backend state or starting another request. Previously admitted public
facts remain visible with a bounded failure notice. Teardown prevents late
notifications from remounting the card.

If opening fails, an exact saved-state read may establish the current card state.
Controls still require this View's admitted opening and the original source to
remain actionable. An admitted pending state is observed without restarting its
work. A missing or mismatched state is unavailable.

An explicit read card completes one backend read and consumes the handoff owned
by [Immutable Presentation Snapshot Ownership](#immutable-presentation-snapshot-ownership).
The first display and later displays admit the same exact snapshot through its
owned transport and presentation registry. The View does not repeat the domain
read. The registry selects its exact renderer; an operation is not a new read
card. Stateful decisions enter the common card process described above rather
than an independent per-View state machine. No presentation defines a second
product result or fallback.

The backend card opening checks the reserved Wallet or Token operation as part
of state admission. The View then admits the fixed Review when its saved state
requires that material. `operation_not_found` alone never restores controls.
An unexpired decision is actionable only through this View's admitted opening
and standard `serverTools` capability. An existing operation replaces only
controls and operation status; it never refreshes the Review subject.

The common card process disables decision controls before one direct action.
While the backend reports admitted work as pending, the View waits `500`
milliseconds after the preceding call settles before starting the next exact
card-state read. It permits at most one in-flight state read. This includes a
new opening of pending work. The loop stops on closed state, View teardown or
read failure. A failed read disables mutation controls and permits an explicit
retry for the same saved card. It does not cancel the original backend work,
recreate its input or retry its execution. Token-selection effects retain their
atomic terminal operation and cannot be repeated by observation.

Every direct-action and card-state tool result enters one transport admission
step before the View renders it. Standard structured admission is first. Only
the measured Codex View adapter defined under
[MCP Apps Integration Requirements](#mcp-apps-integration-requirements) may
recover the same complete canonical value from the same response. The backend
returns CardPresentation together with the original admitted action result. State delivery
failure does not rewrite that result; the View may explicitly read the same
saved card. Failure exposes no parser internals or raw schema diagnostics.

The backend resolves domain operation and card state before projection. A
confirmed terminal card cannot carry a nonterminal operation projection. A failed
detail read does not erase its saved terminal fact. The View removes QR,
countdown and decision controls on terminal adoption. Reopening reads the same
saved card and retained result without requiring consumed Review material.
MCP Host redelivery and View-local display are not replay authority.

The common card View keeps the last rendered admitted output separate from its
latest saved-state observation. When the admitted state and local submission
state are unchanged, it preserves the rendered controls and their pending input.
Controls from a superseded input cannot submit an action.
A late read failure or limited terminal summary
cannot replace an already displayed result or its original Dismiss control.
A bounded diagnostic describes the failed read alongside that result.
If only the terminal fact is known, the View presents that fact and the missing
detail limitation. Successful saved-state recovery does not remount a private
result or undo its dismissal. This display bookkeeping retains no additional
signature value and never supplies a backend state transition.

The backend verifies live transaction or signing material during card opening;
the View admits the exact original source against that saved correlation before
enabling input. The common card process disables controls before one App-only
request and releases complete decision objects from its response continuation.
It observes saved card state without polling the chain or replaying a
transaction operation. Discard consumes only an
unacted decision. The transaction response wait includes the remaining local
Wallet interval and its possible initial lookup under Numeric Policy. Explicit Stop waiting ends the original local wait through its backend
control. A display timer reads the backend state; a lost response does not end
admitted work. Neither establishes external cancellation. Known hashes and actual results
use Receipt/Activity. Blocked and refresh-required cards preserve only their
admitted state and failure classification on reopening.

## Human Interface Surfaces

- Product interface access and selection are owned by
  `docs/PRODUCT_POLICY.md#product-scope`.
- Immutable App renderers exist only for contracts registered with
  `presentationKind: immutable_result` in the closed presentation registry.
  Product Policy's generated Current Support projects the exact implemented
  catalog. A canonical read without an App entry retains its declared MCP/CLI
  surfaces; it does not enter a generic JSON View.
- Each immutable card presents only the canonical result correlated with its
  creating normalized input or exact retained snapshot. It has no navigation
  shell, current-value refresh, global dashboard, local HTTP request, domain
  read, or client-storage recovery.
- A Stock Token trade-history card renders the admitted Stock Token/USDG price
  candles and USDG volume on one shared time axis. It does not refresh,
  aggregate, or reconstruct the admitted result. User-relevant identity,
  period, freshness, coverage, and limitations precede the chart. Exact values
  and empty-position meaning remain accessible with source identity and machine
  correlation fields in the default-closed `Developer details` disclosure.
  The chart admits exactly one price pane and one volume pane; each pane's right
  price scale omits an edge tick when its complete formatted label does not fit
  inside that pane.
- A decision card presents one immutable canonical Review for Wallet connection
  or disconnection or token-selection addition or removal. `Decision` is the human presentation role;
  `Review` remains the domain artifact carried to the action owner. Constructing,
  displaying, dismissing, or displaying that Review again performs no domain
  mutation and occupies no operation slot.
- A transaction decision card consumes its separately typed temporary Review
  source and follows [Transaction Request Ownership](#transaction-request-ownership)
  and [MCP App View Lifecycle](#mcp-app-view-lifecycle).
- App-only controls appear only after standard View initialization reports
  `serverTools`. A MCP Host is trusted to broker that direct control call, but the
  domain owner independently re-admits the complete Review and revalidates its
  current preconditions and fixed evidence anchors.
- Model-visible handlers retain the authority boundary defined by
  [Interface Contract Model](#interface-contract-model) even when an MCP Host
  incorrectly forwards a View call to them.
- A pending card observes only its exact saved card state under
  [MCP App View Lifecycle](#mcp-app-view-lifecycle). It never refreshes
  account, trade history, asset, contract, Wallet, or token-selection
  facts.
- QR appears only in App-private metadata for the exact active Wallet
  operation and in direct interactive CLI presentation. Product privacy and
  MCP Host-observation meaning are owned by
  `docs/PRODUCT_POLICY.md#product-philosophy`.
- A terminal card presents its saved outcome and admitted retained details. Completed
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
- No Wallet or domain state stores or infers an interface choice. MCP Host
  capability controls only connection-local App availability and never selects
  another interface or changes domain state.
- Wallet-management and token-selection Reviews are not locked to an interface.
  MCP App or interactive CLI may present the same admitted Review and exact operation.
  The first valid direct decision commits through the domain owner; duplicate
  delivery returns the same stored operation. Temporary transaction decisions
  use the one-time authority and disposal boundary in
  [Transaction Request Ownership](#transaction-request-ownership); they have no
  stored operation to replay after consumption.
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
- Address inspection accepts one explicit address or the active Wallet target
  and presents the exact empty- or nonempty-runtime-code result without
  classifying address type or control.
- The CLI is a client of the shared local runtime and does not start a
  separate Wallet coordinator or maintain separate product state.
- CLI Runtime management observes or stops one exact backend generation using
  [Runtime Management](#runtime-management). It does not grant Wallet authority
  or depend on an interactive financial Review.
- CLI consumes the same canonical results, immutable Reviews, durable
  operations, commitments, WalletConnect session, and receipt verification as
  MCP and MCP App. It never consumes App markup or presentation snapshots.
- Wallet connection, Wallet cancellation, token-selection changes, and
  transaction confirmation require an interactive TTY.
- CLI obtains the domain-owned immutable Review and waits for the ordered
  Review and prompt write callbacks before opening one live TTY question.
  It rechecks that question and its joined signal after the answer and accepts
  only one exact case-insensitive `y` response. Cancellation, EOF, input error
  and disposal settle the question and close its reader and listeners. Failed
  output never opens a question. Decline, end of input or interruption before
  the direct call creates no operation or mutation.
- Once an action send begins, an unproved response is reported as
  `delivery_unknown` through the canonical delivery exit mapping. CLI names
  the exact operation or Review and never repeats or compensates for the
  action.
- An admitted signing outcome or failure is not reclassified by later
  interruption or expiry during local session cleanup. Raw signature delivery
  remains limited to the live direct invocation. A verified outcome whose private
  delivery ends before native stream admission remains verified and reports
  `Signature delivery unavailable` with command exit status 2, without another
  request. The process output owner releases pending private values on their
  original expiry, cancellation or disposal and rechecks lifetime immediately
  before the actual write, without an intervening await. Once admitted to the
  native stream, the write waits for its callback; later cancellation cannot
  establish that no bytes were delivered. Resource cleanup and output settlement
  retain their independent final failure priority.
- CLI may read every durable exact operation. It may cancel only an active
  Wallet connect attempt admitted by the Wallet operation contract.
- The account-asset command exposes its exact canonical collection or shared
  human projection, including raw balances, verified official classification,
  required token standards, and adjusted Stock Token amounts when the current
  multiplier is available. A read failure never relabels or rolls back a
  successful Wallet connection.
- The Stock Token trade-history command presents its requested period,
  material freshness and coverage limitations, latest exact fixed-interval
  chart close, and the observed bounds of its contributing trades. Its JSON
  mode returns the complete admitted result without re-reading or aggregating
  data.
- The Wallet owner converts a WalletConnect pairing URI to a QR matrix and
  discards the URI. CLI receives only the complete admitted matrix and never
  prints or serializes the raw URI.
- Pairing URI and terminal QR output never enter MCP results, redirected
  stdout, product logs, shell arguments, durable evidence, or activity
  records.
  A terminal transcript made outside Little John remains outside its control.
- CLI confines QR to an alternate terminal screen with the cursor hidden.
  The output owner admits its current display slot, operation expiry, signal and
  terminal dimensions at the actual write. Replacement or invalidation discards
  queued QR without waiting for ordinary output. Alternate-screen state starts
  at native write admission, not queue insertion; restoration remains ordinary
  cleanup after approval, refusal, cancellation, expiry, dimension failure or
  controlled exit and is completed before process termination.
- CLI derives required rows and columns from the complete matrix and
  four-module quiet zone. Required width includes one unused terminal column
  so the raster cannot enter automatic right-margin wrapping.
- CLI renders only a complete undistorted matrix when both dimensions are
  known and sufficient. Otherwise it renders no QR, reports the current or
  unknown and exact required dimensions, and continues observing the same
  exact operation.
- QR rendering uses explicit RGB black and white and represents two vertical
  modules per terminal cell. Equal-color module pairs use a background-only
  space; different-color pairs use an upper half-block over the lower module's
  background. Solid regions do not depend on full-block glyphs or the indexed
  palette. Rendering resets inherited text attributes and redraws when the
  reported terminal dimensions change.
  Scanability is claimed only for terminal profiles that pass the physical
  Wallet check; pixel geometry is not inferred from locale or static width data.
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
- `wallet/session-requirements.ts` owns the exact required and requested optional method/event tuples
  and their Review schema. Configuration and SDK proposal construction consume
  those values. Public cancellability and its narrowed input type derive from
  `walletOperationStateDefinitions`; CLI and App consume the Wallet cancellation
  projection. Shutdown containment has its separate state obligations.
- The SDK adapter admits array length before key enumeration, and admits own-key
  count before bounded descriptor capture. Complete canonical indices and a
  final length recheck reject sparse, accessor-backed or inconsistent captures.
  Namespace objects admit key count and string keys before individual value
  descriptors and normalization. No value getter supplies array elements or
  namespace values. Transparent Proxies remain admissible; native key enumeration
  and arbitrary reflection-trap execution are not bounded memory or time claims.
- Input capacities, the pending callback queue, canonical Review lifetime,
  acquisition and settlement waits have separate owners under
  [Wallet Management Input And Waiting Limits](NUMERIC_POLICY.md#wallet-management-input-and-waiting-limits).
  Both Review constructors consume the canonical contract's lifetime. Callback
  classification precedes queue admission, so ignored events cannot overflow it.
  Overflow cannot restore healthy observation through activation or later events.
- Acquisition keeps one parent-owned monotonic deadline from activation through
  spawn, bootstrap, exclusive storage admission, module loading, SDK initialization
  and ready publication. Approval settlement starts after proposal/pairing containment;
  coordinator effect settlement retains its own per-wait deadline and failure
  reconciliation. These waits do not replace the
  [actual worker ownership boundary](#runtime-lifecycle).
- A connect Review is available only from a clean disconnected state at the
  displayed connection revision. A valid current session returns the current
  compact connection identity/revision facts and creates no operation. Unresolved state grants no active wallet,
  permits no connect, and never automatically selects or deletes a session.
- A disconnect Review is available for connected or unresolved state only when
  a complete stable session set is observable and no proposal remains. It binds
  the complete admitted target set and connection revision. Its inline or
  immutable target-manifest branch carries each source's exact available facts
  or unavailable reason. App and CLI use the same owning exact chunk reader,
  admit every target before enabling input and never authorize from a summary.
  The App or interactive CLI displays the complete set and obtains one direct
  decision before the operation is stored and SDK deletion begins. Unknown state
  remains unavailable; a changed set, state or revision rejects the decision.
  No-session state returns `already_disconnected` without an SDK effect.
- Explicit disconnection removes only reviewed sessions from this profile.
  A newly observed unreviewed session is never included. Failure or partial
  cleanup keeps authority closed under
  [Wallet Authority Recovery](#wallet-authority-recovery). Restart observes the accepted operation's
  postcondition without resending deletion. A new attempt requires a new Review.
- Changing wallets remains two decisions: disconnect must complete, then a new
  connect Review may be created. Failed or unresolved disconnection never
  starts pairing.
- A direct valid connect decision creates `starting_connection` durably before
  its reviewed SDK pairing effect. The exact attempt may advance through
  `awaiting_wallet_approval`, `validating_session`, and `cancelling` before a
  terminal state.
- A direct valid disconnect decision creates `disconnecting` durably before
  its single SDK deletion call. It has no pending confirmation operation.
- Completion, cancellation, refusal and expiry outcomes require the exact
  settlement and stable postcondition owned by
  [Durable Operation Ownership](#durable-operation-ownership). A failed
  operation may retain an independent cleanup-recovery cause; its terminal
  failure does not assert that unresolved original SDK work has ended.
- A public Wallet cancellation binds the exact operation ID, Review digest,
  expected active state, and connection revision captured by that operation.
  A concurrent successor wins through the conditional durable transition.
- A single session may expose several supported or unsupported accounts and
  networks. Full namespace observation, expiry and checkpoint/source health are
  admitted independently of request-method availability. A request uses Wallet's
  network/method-specific account resolution and bound permission validation
  defined in [State Ownership](#state-ownership); interfaces do not silently pick
  an array element or reinterpret unsupported identifiers as executable accounts.
- Public connection reads and account resolution obtain a fresh bounded worker
  observation. The coordinator owns any resulting projection and permission-map
  convergence under [Local Persistence Boundary](#local-persistence-boundary).
  They create or queue no pairing, SDK deletion or containment, financial effect,
  account selection, grant or automatic request retry. Expired authority cannot
  be restored by a backwards clock adjustment.
- Coordinator-owned wake-ups and SDK events perform observation, durable
  convergence and expiry cleanup independently of public reads. Delayed wake-ups
  do not permit expired authority. Exact operation reads retain the declared
  convergence process in [Durable Operation Ownership](#durable-operation-ownership)
  and disclose their possible mutation and external settlement in MCP annotations.
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
- A reserved Wallet/Token operation ID correlates its immutable Review with a
  possible future durable operation. It grants no action and is not stored
  until a direct decision is admitted. A transaction Review's operation ID
  identifies its temporary memory resource under
  [Transaction Request Ownership](#transaction-request-ownership), not a future
  durable Wallet/Token operation.
- A durable operation ID selects one exact domain operation for read and,
  where declared, Wallet cancellation. It cannot authorize a state change
  without complete Review re-admission and the domain owner's current checks.
- A Review digest proves equality with the complete canonical Review under its
  owning contract. It is not secret and does not prove a physical click.
- App-only visibility separates MCP Host-routed controls from model-visible tools.
  The admitted MCP Host is the UI-call trust boundary; visibility is not a custom
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

Request, response, target, route and owner-transport numeric boundaries are
owned by `docs/NUMERIC_POLICY.md#local-http-limits`. This section owns their
transport, authority and lifecycle meaning without copying those values.

- The native loopback endpoint is `http://127.0.0.1:46630`; the server binds
  only to that loopback address and port.
- The endpoint is backend transport, not a user-facing web origin. It serves
  no HTML, App resource, navigation path, Cookie, browser session, or CSRF
  token.
- Compatible-process and CLI state changes require the exact local control
  credential. That credential authenticates the native caller but never proves
  an App or CLI decision.
- Public canonical reads require the exact HTTP `Host` header and an absent
  Origin. They may atomically publish only trusted derived Wallet observation,
  supported-account retention and preference invalidation under
  [Local Persistence Boundary](#local-persistence-boundary). This class admits
  no direct user decision, domain-operation transition, account selection,
  grant, SDK containment or session deletion. Other declared read effects use
  their existing compatible-process control resource.
- Request bodies accept standard UTF-8 JSON under RFC 8259 and are captured
  and validated by the owning schema. Whitespace and object-member order carry
  no authority. Deterministic serialization is an output and narrow digest
  concern, not an HTTP input requirement.
- A transaction handoff additionally requires the server-owned confirmation
  grant defined by `docs/TRANSACTION_POLICY.md#confirmation-authority`.
- No local credential, Review, operation ID, or grant appears in a query
  string.

Request-class security is fixed as follows:

| Request class | HTTP `Host` header | Origin | Authentication | Durable mutation |
| --- | --- | --- | --- | --- |
| Owner identity | Exact fixed HTTP `Host` header | Must be absent | None; challenge proof is the response | No |
| Public canonical read | Exact fixed HTTP `Host` header | Must be absent | None | Only trusted derived Wallet observation, supported-account retention and preference invalidation |
| Compatible-process control | Exact fixed HTTP `Host` header | Must be absent | Local control credential | Only the declared control transition |

An Origin header always fails. A request never changes class because it omits
a credential. Each route has exactly one request class.

## Verification

Implementation verification covers module dependency direction, fixed-port
ownership and takeover, foreign-process conflict, store separation, the
single-session invariant, exact Review purity, direct-decision revalidation,
durable operation uniqueness and immutability, stale action rejection,
external effect ordering, no-resend restart, QR lifetime, stable session
restoration and invalidation, MCP App and CLI use of the same domain owners,
native credential separation, MCP Host adapter isolation and deletion conditions,
snapshot identity,
capacity, corruption, exact input/result reconstruction and full canonical
re-admission,
terminal observation stopping, request limits, token-selection atomicity,
account-assets continuity, trade-history source-file identity, digest,
capacity, coverage, and
source/provider separation, send-once delivery, owner takeover, and secret-leak
boundaries. Address verification additionally covers one shared target and
resolver, explicit Wallet independence, one active-Wallet capture, exact
empty/nonempty runtime-code results, no dependent analysis after empty code,
result-owned evidence conclusions, lossless interface and snapshot handoff,
and independent installed-package fixtures.
