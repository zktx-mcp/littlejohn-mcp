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

Little John is a Node.js `>=22.13.0` ESM TypeScript modular monolith. One
runtime composition root opens the owner-only SQLite product store, the
WalletConnect SDK store, one bounded Robinhood Chain RPC reader, the implemented
feature applications, and the final interface support manifest. Runtime creation
returns a cleanup-capable handle before it starts or defers to the fixed
loopback HTTP owner. The owner, compatible peer, takeover, and shutdown behavior
follows [Runtime Lifecycle](#runtime-lifecycle).

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

A no-argument package process exposes one stdio MCP connection while sharing or
taking over that HTTP owner. It constructs the complete server from the Runtime
snapshot store, admitted packaged App resource, and one explicit local-operation
client, then publishes the connection owner before starting stdio. Input end or
close terminates that owner, which closes the SDK server and adopted transport
before its local-operation client. On an admitted MCP Apps connection,
registered read and Review tools use the bounded immutable-presentation process
defined by
[Immutable Presentation Snapshot Ownership](#immutable-presentation-snapshot-ownership)
and [MCP App View Lifecycle](#mcp-app-view-lifecycle). Connection admission,
rather than missing construction inputs, selects ordinary or App presentation
under `docs/PRODUCT_POLICY.md#capability-availability`. App-only controls and
interactive CLI commands independently send the same admitted Reviews to the
same domain owners. Wallet management and Token selection read exact durable
operations; transaction decisions use the separately typed temporary source and
actual-result ledger defined below. The standard transport is primary. Implemented MCP Host
adapters are limited to current App association, immutable snapshot delivery,
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
| Model Context Protocol | Binding product transport | The official MCP specification owns JSON-RPC transport meaning; this document's interface contract model and the canonical binding owners own Little John tool meaning | `src/interfaces/mcp.ts` owns official SDK server and stdio transport adaptation; role registries own their exact tool bindings | Interface composition supplies the complete Runtime server port, packaged resource, and explicit local-operation client, and publishes one stdio owner before connection; replacing SDK details preserves the complete MCP identity, tool contracts, EOF termination, and cleanup order |
| Model Context Protocol Apps | Binding product transport | The official MCP Apps specification owns resource and View transport meaning; Little John's canonical contracts own product results and this document owns presentation lifecycle | `src/interfaces/mcp-app` owns the self-contained resource, descriptor and chunk transport, View bridge, renderers, and narrow MCP Host adapters; Runtime owns the immutable snapshot store | MCP composition always supplies the Runtime store and admitted packaged resource; connection admission, rather than missing construction inputs, selects ordinary or App presentation, and replacing a MCP Host adapter preserves the standard transport and every canonical result while replacing the extension requires an accepted integration change |
| Codex MCP App Host | Replaceable implementation provider | The MCP Apps integration requirements below own the provider-neutral MCP Host role and the exact current Codex transport boundary | Local Codex configuration owns MCP Host enablement; the Codex adapters under `src/interfaces/mcp-app` own only the measured missing transport facts defined below | The local stdio MCP connection and sandboxed View enter the common MCP Apps process; another MCP Host may replace Codex only by satisfying that complete unchanged process |
| Claude MCP App Host | Replaceable implementation provider | The MCP Apps integration requirements below own the provider-neutral MCP Host role and the exact current Claude transport boundary | Local Claude configuration owns MCP Host enablement; the Claude adapter under `src/interfaces/mcp-app` owns only the measured missing transport fact defined below | The local stdio MCP connection and sandboxed View enter the common MCP Apps process; another MCP Host may replace Claude only by satisfying that complete unchanged process |
| WalletConnect | Binding product transport | `docs/PRODUCT_POLICY.md` owns the wallet transport; this document owns session and handoff architecture | `wallet` owns SDK adaptation, project-ID validation, required namespace settings, metadata, SDK options, lifecycle, and provider defaults | The wallet application constructs one parent `WalletConnectClientPort`; a fixed Wallet worker owns SDK construction and private storage. Other modules receive wallet product ports. The client/IPC contract is the replacement boundary |
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

- the Codex server adapter adds the MCP Host-required output-template association
  only when exact `codex-mcp-client` identity omits the standard UI
  capability;
- the Codex View adapter unwraps only the measured single JSON text wrapper in
  exact `chatgpt` View-reported MCP Host identity;
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
- the Claude View adapter admits the strict same-result snapshot resource from
  View-private metadata when exact `Claude` View-reported MCP Host identity omits the
  standard result resource link or replaces result `content` with its measured
  file-offload statement, or reverses only Claude's measured exact flattened
  snapshot-link text when that is the sole redelivered link form. The flattened
  name and URI must carry the same snapshot digest before the result rejoins
  standard resource admission. Compatibility content is never a View result
  authority.

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

The View always applies the unchanged owning success, failure, or
`delivery_unknown` admission to standard `structuredContent` first. Only the
Codex operation-result adapter may inspect another carrier after that fails.
It requires one canonical JSON text item, exact descriptor agreement with the
current tool, input, result bytes, and `isError`, at least one omitted object
property whose value is exactly `null`, and exact equality between the
delivered structured value and that one null-elided projection. It preserves
array positions and array `null` values, then applies the same owning admission
to the complete candidate. Missing or conflicting metadata, descriptive text,
a wrapper with another shape, a changed or omitted non-null value, an added
value, a type conversion, an array change, an `isError` mismatch, or owning
admission failure rejects the result. The adapter never infers a field,
inserts `null`, applies a schema default, repeats a call, or selects another
operation. Claude operation results use only standard structured admission.

The Codex operation-result adapter is deleted when a current physical Codex
qualification preserves required object-valued `null` properties in
View-initiated action and exact-operation `structuredContent`. Its descriptor
emission is deleted with the adapter when no remaining admitted transport path
consumes it.

An MCP connection that does not admit the App transport receives no App
resource or App-only authority. A bridge that transports tools but not
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
  `JSON.stringify(result)` is at most `1,048,575` UTF-8 bytes. This is the
  product's delivery budget, not a universal MCP Host maximum. MCP Host text offloading
  does not change canonical result authority or this admission boundary.
  Successful results with an output schema retain conforming canonical
  `structuredContent` and exactly one bounded model-visible text item. The
  registered interface may derive that text from the admitted success; an
  interface without a projector retains the canonical JSON text. The text is
  never a second result oracle or a reconstruction input. An
  oversized result becomes one bounded `isError` tool-execution result with a
  plain-text delivery-size statement and no structured result, resource link,
  snapshot metadata, operation metadata, or domain payload. This transport
  error does not change the owning application failure contract or the
  independent canonical capability-success bound. The request ID remains
  client-owned, so Little John does not claim a universal byte bound for the
  complete JSON-RPC response.
- Compatible-process control resources are private owner IPC consumed by MCP and
  CLI adapters. They are not agent-facing URLs and do not redefine the MCP
  contract.
- Machine-interface identity catalogs bind canonical contracts to their MCP,
  native HTTP, and CLI identities. A separate closed presentation registry
  binds an exact canonical contract object to its canonical parser, typed MCP
  App renderer, and
  exactly one `presentationKind`: `immutable_result`, `review`, `transaction_review`,
  `signing_review`, or `operation`, and its permitted retention source.
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
  expose canonical reads and immutable Reviews. Their permitted read effects
  are owned by [Local Persistence Boundary](#local-persistence-boundary) and
  the default-selection rule in `docs/PRODUCT_POLICY.md#default-stock-tokens`.
  They cannot make direct Token selection decisions, Wallet requests, domain
  operations, or transaction grants. App-only handlers may invoke a direct
  domain decision only after the canonical Review and current preconditions
  are independently re-admitted. Effect annotations describe behavior and do
  not grant action authority.
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
- Public dispatch and authenticated control-session acquisition use the same
  Runtime owner-connection process. It may acquire a replacement owner before
  an application request is sent. An interrupted application request is never
  replayed by that connection process.
- No process selects, increments, or falls back to another port.
- A foreign or incompatible port owner causes a clear startup failure and is
  never stopped or replaced.
- Exhausted acquisition without a ready owner is `runtime_state_unavailable`.
  A startup with a proven compatible but not-ready owner defers and keeps its
  stdio connection alive; it does not start a background acquisition loop.

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
  may answer from that cached record. This bounded, side-effect-free control
  response never reads closing SQLite, reopens application resources, or adds
  work to the application shutdown drain. Listener release closes its sockets.
- The direct executable owns process termination. It first settles every
  admitted CLI, terminal-restoration, QR, and MCP output write. A process output-stream
  failure produces a nonzero status; backpressure remains pending rather than
  being reported as successful truncated output. After settlement, the CLI
  process decision requires operating-system teardown when applicable MCP or
  local-operation-client cleanup rejects, Runtime stop rejects, or Runtime
  shutdown is process-terminal. This decision does not claim that a retained
  resource was released. It is not a wallet disconnect and does not revoke an
  approved session. Normal Node termination requires either no created Runtime
  or a fulfilled released Runtime result after the applicable dependent proves
  closed.

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
- A ready owner returns that identity with HTTP 200. An initializing, stopping,
  failed-cleanup or process-terminal owner with an admitted record returns the
  same identity and proof with HTTP 503 and `application/json`. Both require
  complete identity verification; an unsigned error response proves neither
  compatibility nor readiness. HTTP 503 permits startup to defer but never
  permits an application or credential-bearing request.
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
- Non-HTTP/parser failures, received incomplete or oversized identity bodies,
  wrong content headers, invalid identity/proof/profile/configuration, and
  statuses other than 200 or 503 are `port_conflict`. Refusal, reset, close or
  timeout before any response bytes is transport unavailability. The peer
  never sends its credential to an unverified or not-ready listener.
- After owner loss, deferred processes race only by binding the fixed port. The
  single successful binder becomes owner and publishes the next owner revision.
  Other processes authenticate and defer to that owner.
- Owner takeover is demand-driven. A deferred process attempts the fixed bind
  only when an operation needs the owner and a fresh authenticated identity or
  request to the recorded owner fails. It does not poll, use a lease, infer
  liveness from SQLite, or maintain a second coordinator. The successful owner
  reconciles authoritative stores before serving the triggering operation.
- Lost bind followed by transport unavailability does not prove a winner.
  The requesting Runtime owns bounded, cancelable contention retries with
  exponential backoff and jitter under the Numeric policy. Valid not-ready
  identity keeps dispatch/session acquisition waiting within that same bound.
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

## State Ownership

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
- One Wallet parent owns product connection authority, management operations,
  request reservation and the actual child handle. One fixed SDK worker owns
  Sign Client, relay callbacks, raw session topics, private SQLite and original
  SDK futures. `client-contract.ts` and `worker-contract.ts` own the pure product
  port and closed, versioned IPC. Worker bootstrap is private; no public input
  selects an executable, module, relay, or method proxy.
- Worker acquisition starts asynchronously. Independent Chain, Registry, Price,
  History and retained-result consumers do not await SDK readiness. Preparing,
  failed or exited SDK state closes Wallet authority and never starts a second
  child in the same Runtime. Recovery requires a new actual Runtime owner.
- Each IPC direction admits generation, correlation, exact canonical input and
  payload/queue bounds before use. Pending observation, management and financial
  lanes have separate responsibilities. Unavailable, stale or malformed replies
  never become an empty or fresh session. Only the derived Wallet source key
  crosses private bootstrap; the HTTP control credential and raw topics do not.
  Parent session evidence is reconstructed locally from the admitted HMAC digest.
  Private IPC data never appears in arguments, environment or output logs.
- Its asynchronous active-wallet read port obtains a fresh SDK observation and
  captures connection state, account, chain,
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
  one storage owner through the SDK's public storage option. It routes explicitly
  admitted restoration namespaces to private SQLite and all other SDK values to
  memory. Values remain opaque; namespace lifetime belongs to Wallet.
- A connected wallet projection contains one canonical EIP-155 chain identity
  and one canonical lowercase EVM address. The coordinator derives their
  CAIP-10 account reference only at WalletConnect protocol and internal session
  continuity boundaries under the
  [CAIP-10 account identifier specification](https://standards.chainagnostic.org/CAIPs/caip-10).
  A persistent account row is local account identity only; it never
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
Profile and owner scans retain one excess-row witness. Parent, account,
selection and operation startup scans stream bounded rows in indexed order;
exact-key and page consumers use the same field admission. Stored selection
flags admit exactly integer zero or one before boolean conversion. Wallet
connection reads use the same scalar admission and an excess-row witness before
their status-specific storage decoder. Its produced revision and encoded fields
are bounded before the atomic account/projection mutation.

These bounds control returned fields and the live JavaScript working set.
Durable Wallet-management and token-selection operation history has no total
row quota or automatic eviction, so its startup work scales with retained rows.
The transaction ledger has separate row and byte bounds under
[Transaction Request Ownership](#transaction-request-ownership).
These bounds do not specify SQLite engine memory,
file size, WAL size or query duration. Foreign-key validation consumes the first
violation; an empty result requires the engine to complete its check. Connection
and artifact-observation settings are owned by
[SQLite Operating Limits](NUMERIC_POLICY.md#sqlite-operating-limits).

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

The connection projection includes one secret-free `revalidation_required`
boolean. It records only a contradiction or ambiguous product write that
Little John itself admitted and that the SDK may not retain. It is not a session copy,
event log, owner marker, generation, or source selector. A stable empty SDK
observation clears it atomically with the disconnected projection.

The connection projection is not the durable owner of account identity. A
validated connected transition inserts or reuses its exact neutral account row
and replaces the projection in one transaction. A nonconnected transition
changes only the projection and never deletes an account row. A confirmed Token
addition may also retain its resolved account in the same transaction as its
inspection, selection, selection-set state, and terminal operation. Account
reads and Token Review creation never retain an account.

Wallet and token-selection operations are durable exact
resources under [Durable Operation Ownership](#durable-operation-ownership).
Every operation SELECT admits storage class and encoded byte length in SQL
before returning complete bounded BLOB fields. Startup streams those rows; exact
reads and write readbacks consume the same projection. Each row then passes its
domain parser and indexed-identity comparison. An invalid existing operation is
runtime state unavailability.
Pairing URI and QR material remain owner-memory presentation state and never
enter the canonical operation, product SQLite, or the WalletConnect public
store projection.

The Token inspection cache stores one complete canonical result as UTF-8 BLOB
bytes under its chain, contract and digest identity. Its Numeric Policy owner is
separate from capability, transport, presentation and operation capacity.
Existing-state admission uses one synchronous SQLite snapshot for the cache's
row-count, BLOB metadata and complete-result passes. It proves retained row
count, storage class, individual bytes and aggregate result bytes without
selecting a complete result, then admits each bounded result through the
unchanged Token inspection parser, canonical serialization, digest and indexed
identity. Fresh bootstrap runs the same operation as a savepoint inside its
existing exclusive transaction. The bounded cache snapshot ends before
selection and other database validation and is not a database-wide startup
snapshot.

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
A generic observation-change callback closes current authority before scheduling
fresh observation; it never writes a connection projection from callback data.
Observations and live checks are asynchronous across IPC. Every consumer checks
current source, revision, permissions, cancellation and expiry again after await. Unknown callback
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
| `response_memory` | A blocked transaction decision carried only by its creating response; no redisplay lookup or store commit |

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
operation and expiry; the response-only source has no lookup authority. Stored
URIs retain the form above; live Reviews use
`littlejohn://presentation/reviews/{operationId}/sha256/{identityDigest}` and
response-only decisions use
`littlejohn://presentation/responses/sha256/{identityDigest}`. Neither URI form
can fall through to the SQLite store. The chunk byte
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

Retention applies independent distinct-row and aggregate input-plus-result
byte bounds owned by
[Durable Operation And Presentation Limits](NUMERIC_POLICY.md#durable-operation-and-presentation-limits).
Startup and new commit share one metadata-only capacity reader. Startup rejects
an excessive retained total without eagerly replaying individual snapshots;
commit checks the new total after exact-pair reuse has been considered.

Equal contract identity, canonical input bytes, and canonical result bytes
reuse one row and do not refresh or mutate it. A new snapshot is admitted only
when both post-insert bounds hold.
The SQLite snapshot schema stores only this pair. There is no result-only row,
compatibility reader, inferred input, or snapshot migration path.
The owner checks identity, count, aggregate bytes, and insertion in one SQLite
transaction. A collision, partial write, lease failure, capacity failure, or
invalid existing row advertises no new snapshot. No snapshot is automatically
expired, evicted, reordered, or selected by insertion time. Only an explicit
complete profile reset removes snapshots.

Snapshot persistence failure never changes the already admitted domain result
or an interface outside this App presentation process. During an initial App
presented read or Review, preparation or commit failure returns the owning
interface's existing `internal_error` and no presentation handoff. After a
handoff exists, an App-only snapshot lookup or chunk read reports
`presentation_unavailable`; its reason is exactly one of `capacity_exceeded`,
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

For the SQLite source, initial App creation prepares the immutable record and constructs the complete
MCP result, including the resource link and private snapshot resource, before
the common MCP result admission. An oversized result returns the bounded MCP
delivery error and commits no snapshot. Only an admitted complete result may
commit; the committed record must equal the prepared record byte for byte, and
no content, metadata, or size decision is added after that commit.

After an App-presented read or Review admits its exact source (and commits only
when that source is SQLite), its initial result remains the owning tool's canonical MCP
success: domain `structuredContent` that conforms to the advertised output
schema and one bounded registered model-visible text projection. The
presentation owner appends
exactly one standard resource link to `snapshotUri` and the exact snapshot
resource in View-private metadata. It re-admits and stores the value carried by
that same canonical result; it never accepts a second raw domain value or
replaces the tool success with a snapshot reference.
`resources/read` accepts only that canonical URI and returns the bounded
snapshot resource, never `R`.
`presentation_get_snapshot` is a pure model-visible tool that accepts only the
exact URI, re-admits the retained input/result pair, and returns one strict
`presentation_snapshot_reference` with the same link and descriptor; it copies
no retained payload into its structured result and attaches the exact snapshot
resource only in View-private metadata. Decision snapshots additionally carry
their existing DB card reference through the card handoff defined under
[Card State Ownership](#card-state-ownership). Snapshot lookup does not create
a card or admit an opening. Its registered producer returns the complete MCP
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

For an initial creating result, the View requires the direct canonical domain
`structuredContent` and the same-result private snapshot resource. Before MCP Host
delivery, the server has already admitted the structured value through its
owning parser and bounded the registered text projection. The View never treats
that text or transformed compatibility content as another result oracle. It
admits the standard resource
link when the MCP Host preserves it and otherwise only the measured Claude omission,
file-offload, or flattened-link form defined above. It validates the resource,
descriptor, snapshot identity, normalized input, carried result byte length and
digest, exact reserialization, and owning input/result admission before renderer
dispatch. This path performs no snapshot-reference, resource-read, or
result-chunk tool call.

For immutable redisplay, the View requires the strict
`presentation_snapshot_reference`, validates that it identifies the exact
resource, and reconstructs the result through the exact sequential result
chunks. It decodes Base64, joins raw bytes, verifies total length and digest,
performs one fatal UTF-8 decode, verifies canonical JSON, and uses the same
registry entry to re-admit the correlated result before renderer dispatch. The
creating domain result and replay reference cannot substitute for one another.
JavaScript string indexes never own chunk boundaries.

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

A model-visible Review is immutable and performs no domain mutation or
external effect. It contains one reserved, unstored operation ID, creation
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

Wallet ordinary and presentation reads consume one synchronous coordinator
process: open/ID admission, exact stored lookup, nonterminal convergence and
exact stored re-read. Presentation adds only the matching currently permitted
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
Runtime composes its existing domain/source ports and owns the card-state table in product SQLite, defined by
`src/runtime/sqlite-schema.ts`. The fixed HTTP owner hosts this application; compatible
MCP processes use authenticated controls. Views, MCP Host events, model answers and
widget caches are not card-state authorities.

The interface factory supplies the existing Runtime generation's lifecycle
signal to the card application. Owner termination closes card admission and
aborts its registered work before HTTP handlers drain. Request transport abort
remains separate. The existing application close then drains card work and
removes its listener in dependency order, without closing the database, SDK or
HTTP listener early.

The backend creates a stable `cardId`. A decision card binds it to the exact
domain `operationId`; a read card stores its admitted read input without a
fabricated operation or Review identity.
Each original decision View execution sends its own `cardOpenRequestId`; repeated creating
delivery and request retries within that execution reuse that value. A snapshot
replay reference and a read-start acknowledgement use saved-state reads without
creating an opening ID. Their existing result contracts identify that read role. The backend
atomically stores the first admitted value as `firstCardOpenRequestId`, initially
null. The same first value is idempotent; a different value applies the return
rule. A state read or render update is not an opening. A MCP Host-created replacement
also constitutes a new opening, regardless of navigation. No timing, focus or
teardown heuristic decides state. A silent re-exposure with no input is not an
observable opening.

The card contract projects `ready` as Interactive. A View enables controls only
after the backend admits its first opening and exact Review. Input admission
ends the decision controls: `dispatching`, `pending` and `closed` are Static. Static does not mean that the domain
operation is terminal. SQLite retains bounded identity, source correlation and phase/outcome
metadata only: no complete transaction/signing Review, request, signature, QR
or event log. Existing snapshots and domain operations retain their owners.
Card state never reconstructs a canonical domain result from a summary.

The card row is the sole durable owner of a data-signing outcome classification
after its one-time response; it does not retain the signature. Card failure
classifications include the card owner's existing failure definitions as well as
its domain sources. A refused publication can terminate its retained pending
card without treating that admitted failure as a failure of all card storage. Existing Wallet,
Token and transaction records remain the owners of their canonical results.
Stateful creating results carry their saved card reference through a standard
`littlejohn://presentation/cards/<cardId>` resource link and the matching
`littlejohn/presentation-card` metadata. Reading that resource reads state only;
it does not admit an opening. The original domain result remains separate from
this transport reference. Creation returns the actual stored identity, including
when an identical domain decision has already been inserted.

The same stored identity accompanies a decision snapshot's replay result.
The existing authenticated owner-session control reads a card reference by the
original operation ID and admitted snapshot descriptor. The card application
uses the store's unique kind/operation lookup and the canonical source comparison:
contract, version, result digest, durable snapshot ID or original memory source
and expiry must agree. It creates no row, opening, Review or Wallet request.
No MCP client becomes a second card-state owner. Missing or inconsistent linkage
prevents a decision presentation instead of creating a replacement identity.

Reading a durable decision by snapshot ID resolves that same card and returns
its current saved state. The read contract requires the returned card to retain
the requested snapshot ID. Immutable data and results with no decision retain
their snapshot-only representation. `snapshot-record.ts` owns exact stored-pair
admission for both the card application and MCP presentation service; it does
not own card transitions. The source comparison in the card contract also
governs View admission. No consumer reconstructs authority from snapshot data.
Memory-source lookup still becomes unavailable when the original material is
gone; an already delivered card reference can display its saved terminal state
without loading that material.

One backend process admits the exact card/opening/action, commits dispatch
classification, calls its domain owner once and adopts the admitted outcome.
Its App action response includes that original result and the presentation of
its published DB record. It reuses an admitted operation result for projection;
an exact terminal read is needed only if a later DB completion has overtaken it.
MCP does not issue a second owner-session request to decorate the action result.
The original CLI result and its recovery behavior remain independent.
No store transaction or admission lock spans external waiting. Ordinary reads
do not create openings or cancel otherwise-live work. They may settle an already
elapsed deadline, lost material owner or exact terminal operation. Closed-card
reads never refresh business facts or alter their saved outcome.

An admitted return closes an unsubmitted decision. Once a direct input or read
request has been admitted, returning reads the original work's state without
cancelling or restarting it. The original execution owns its deadline, explicit
stop, session validity, result publication and cleanup independently of the
request's response transport. A closed response transport retains no private
signature for a replacement View.

The first connection View may display the Wallet owner's current QR. A new
opening displays only state, including when the user left before scanning.
Neither an opening nor a state read creates another pairing. QR suppression is
not Wallet rejection or cancellation. Explicit stop uses the exact original
operation and its owner's current cancellation admission. A cancelling operation
is not terminal, and non-cancellable work is not rolled back.

CardPresentation combines the admitted DB card state, a typed display projection
or exact resource reference, and the currently available actions. The backend
owns the ordered source read, state reconciliation and projection. One request
carries its admitted domain observation and latest DB record through projection.
An unchanged state does not enter a write transaction. After an awaited source
read the backend checks the DB again; an overtaking terminal record takes
precedence and permits only the exact terminal detail read that it requires.
The original Wallet View uses the existing combined operation/QR observation.
Projection does not repeat source reads or state reconciliation. The View
never reconstructs an operation from that projection. QR uses the existing
private metadata correlated to the original operation digest. Response-only
signature carriage remains separate from saved state and from display projections.
The App-native action envelope contains `result`, `presentation`, and optional
`qr`; its source and component admission are owned by the card contract. Each
original binding admits its inner domain result. MCP retains the original public
result and serializes the admitted presentation once as canonical JSON text in
`littlejohn/presentation-state`. The View decodes those exact bytes and admits
that value without defaults or an alternative object carrier. Existing QR and
signature metadata keys remain unchanged. Native action bindings and their route
consume the same derived response bound; other routes retain their class bound.
A valid application failure explains the failed call without assigning a new
card state. It is not a response-transport failure. A separately admitted terminal
DB presentation is not replaced by a later direct-response error. An unconfirmed
response without a known terminal card still permits only an explicit state read.
An admitted direct domain outcome remains displayable independently of saved-card
presentation delivery, including outcomes without a private signature. One View
process admits and adopts those facts using the original domain renderers. A
matching DB operation display retains its admitted QR and controls; a direct
response alone cannot supply them. A directly displayed pending operation can be
replaced by its later DB result, while terminal facts and original private-result
disposal remain protected from delayed state reads. This display bookkeeping
does not write or infer a DB phase.
An unknown-delivery report from the response transport is not a confirmed
operation outcome. A later admitted DB result may replace that report without
retrieving a private signature or repeating the action.
A route may declare a bounded response size up to the largest existing transport
response bound. This cannot change request authorization or the owning payload
and storage capacities. Numeric owns the complete envelope accounting.

A read card stores its admitted capability input and pending state before the
single owning capability execution starts. Its acknowledgement returns the
stable card reference before data collection completes. Runtime commits the
canonical snapshot and the card's completed snapshot reference in one SQLite
transaction. No read, remount or restart repeats that execution. Already immutable
results keep their original snapshot identity without a mutable card row.

A new fixed HTTP owner settles retained unfinished cards before exposing controls.
It closes unsubmitted decisions, preserves confirmed domain terminal results,
and uses existing Wallet/Token postcondition reconciliation. Lost volatile request
waits remain unknown; lost read work is interrupted. Compatible clients do not
repeat startup settlement. No final shutdown notification is required.

Local wait termination correlates with the original active request and uses its
existing cancellation signal. It creates no second Wallet request lane, private
result cache or recovery API. Admitted completion wins over later termination;
an earlier end prevents later data-signature publication. The original bounded
late-transaction-hash bookkeeping remains intact. Local stop does not call the
full response close that releases that reference. A lost control reply does not
undo a commit; an exact state read may establish the persisted result.

Storage failure before dispatch prevents the effect. Failure after possible
dispatch cannot authorize retry or prove not-sent. Persistence failure neither
prolongs authority nor rewrites an admitted domain result. Owner loss cannot
recover temporary material or manufacture a response. Schema/profile admission
follows the exact SQLite reset boundary without migration.

## MCP App View Lifecycle

One `interfaces/mcp-app` owner implements immutable presentation, durable
exact-operation presentation and temporary transaction and signing decisions over typed
inputs. The
exact-operation family has two closed flows: atomic decision to terminal and
Wallet observation. These flows share admission and terminal adoption but do
not configure, reorder, or emulate one another. A renderer owns semantic DOM
and SVG only and cannot make tool calls or configure lifecycle order.

The View result ingress applies one standard-first creating-result tool-error
admission before any snapshot, resource, or chunk admission. An intact
`isError: true` result enters directly. Exact `chatgpt` View-reported MCP Host identity may
restore only the two measured creating-error forms defined under
[MCP Apps Integration Requirements](#mcp-apps-integration-requirements).
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

After tool-error admission, the common ingress distinguishes the original
domain creating result, snapshot replay reference and read-start acknowledgement
by their existing contracts. Only the original decision result admits an opening;
replay and read acknowledgement use the fixed reference to read saved state.
A ready decision read without an opening returns its exact available Review
with no controls. It preserves the original decision and never creates a direct
decision payload in the View. Pending decision reads without an opening also
carry no mutation controls or QR. The original decision View and read-operation
controls retain their own admitted actions. A failed original opening retains
its View execution ID. Until a matching opening response is admitted, an explicit
retry uses the same existing open contract and ID. After that admission, a
detail or state failure permits only the existing exact read. Snapshot and read
Views never acquire an opening through recovery. Neither recovery path creates
a Review or repeats a domain action, and the backend rechecks its original
state, expiry and opening conditions. Closed-state display
does not read or reconstruct consumed Review material. Only a still-actionable
decision proceeds to exact Review admission before enabling direct controls;
the backend supplies the operation's admitted display projection. A missing
or inconsistent card reference is not a normal closed state. Renderers do not
decide persisted transitions, and a repeated creating result within one View
does not open a second decision.

If opening fails after possible closure, one exact saved-state read may establish
a committed closed card. That read cannot restore decision input. An admitted pending state may be
observed without restarting its work. A missing or mismatched state is unavailable.

For a successful immutable result, the immutable process consumes the handoff owned
by [Immutable Presentation Snapshot Ownership](#immutable-presentation-snapshot-ownership),
distinguishes the creating domain result from the replay reference by their
owning tool contracts, selects the standard transport before an exact MCP Host
adapter, dispatches the fully re-admitted result through the presentation
registry, and renders without polling or a domain read. Initial creation uses
the result already carried by the domain tool; replay alone reconstructs the
same retained result from exact chunks. The registry selects its exact renderer
and rejects an operation result as an invalid creating presentation. Stateful
decisions enter the common card process described above rather than an
independent per-View state machine. No presentation defines a second product
result or fallback.

The backend card opening checks the reserved Wallet or Token operation as part
of state admission. The View then admits the fixed Review when its saved state
requires that material. `operation_not_found` alone never restores controls.
An unexpired decision is actionable only through its admitted initial opening
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
latest saved-state observation. A late read failure or limited terminal summary
cannot replace an already displayed result or its original Dismiss control.
A bounded diagnostic describes the failed read alongside that result.
If only the terminal fact is known, the View presents that fact and the missing
detail limitation. Successful saved-state recovery does not remount a private
result or undo its dismissal. This display bookkeeping retains no additional
signature value and never supplies a backend state transition.

The backend verifies live transaction or signing material during card opening;
the View admits the exact creating data against that saved correlation before
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
- CLI consumes the same canonical results, immutable Reviews, durable
  operations, commitments, WalletConnect session, and receipt verification as
  MCP and MCP App. It never consumes App markup or presentation snapshots.
- Wallet connection, Wallet cancellation, token-selection changes, and
  transaction confirmation require an interactive TTY.
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
  connection and creates no operation. Unresolved state grants no active wallet,
  permits no connect, and never automatically selects or deletes a session.
- A disconnect Review is available for connected or unresolved state only when
  a complete stable session set is observable and no proposal remains. It binds
  every session's opaque source ID, the current state and connection revision.
  The App or interactive CLI displays the complete set and obtains one direct
  decision before the operation is stored and SDK deletion begins. Unknown state
  remains unavailable; a changed set, state or revision rejects the decision.
  No-session state returns `already_disconnected` without an SDK effect.
- Explicit disconnection removes only reviewed sessions from this profile.
  A newly observed unreviewed session is never included. Failure or partial
  cleanup keeps authority closed; revalidation is cleared only after a complete
  empty session/proposal observation. Restart observes the accepted operation's
  postcondition without resending deletion. A new attempt requires a new Review.
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
  never selects an account silently. Valid additional EVM chains in that session
  do not grant other-chain authority. Account and explicit chain arrays must be
  internally consistent and contain no duplicate canonical entries.
- Approved namespaces are admitted from the external wallet under the official
  WalletConnect session model. Little John validates canonical chain, account,
  required methods and events, expiry, and stable session-source identity.
- The selected account remains usable only while that exact admitted session
  exists, is not expired, and retains the required namespace. Product-chain
  identity remains owned by `docs/PRODUCT_POLICY.md`.
- One coordinator capture evaluates connection eligibility and evidence
  availability before an interface result is produced. Public connection reads
  and active-account capture may invalidate ephemeral authority but perform no
  durable write, SDK call, or queued maintenance. Expired authority cannot be
  restored by a backwards clock adjustment. Consumers do not apply separate
  freshness or session-selection rules.
- Coordinator-owned wake-ups and SDK events perform observation, durable
  convergence and expiry cleanup independently of public reads. Delayed wake-ups
  do not permit expired authority. Exact operation reads retain the synchronous
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
- Public canonical reads require the exact HTTP `Host` header and an absent Origin. They
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

| Request class | HTTP `Host` header | Origin | Authentication | Durable mutation |
| --- | --- | --- | --- | --- |
| Owner identity | Exact fixed HTTP `Host` header | Must be absent | None; challenge proof is the response | No |
| Public canonical read | Exact fixed HTTP `Host` header | Must be absent | None | No |
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
