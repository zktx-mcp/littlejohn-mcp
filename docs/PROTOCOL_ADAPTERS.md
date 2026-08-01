# Protocol Adapters

This document defines protocol integration packages and their activation
contract. It is the sole authority for protocol package structure, capability
mapping, activation, commercial behavior, and adapter verification policy.

## Candidate Selection Policy

- Candidate evidence follows `docs/EVIDENCE_POLICY.md`. A candidate first
  satisfies the repository-wide requirements referenced below.
- Among candidates that satisfy those mandatory gates, Little John prioritizes
  integrations with an officially documented and technically verifiable revenue
  mechanism.
- Revenue capability affects integration work priority only. It never grants a
  support level, activates an adapter, ranks an executable quote, selects a
  venue, changes a security conclusion, or weakens a repository-wide
  requirement.
- Protocol domains and execution classes remain distinct. Direct DEX
  protocols, same-chain aggregators, and managed vaults are examples of
  non-equivalent classes; commercial similarity never collapses their
  execution semantics or responsibilities.
- A revenue-bearing integration declares the provider terms identity, fee
  mechanism, payer, recipient, fee token rules, exact rate scale, rounding,
  credential model, calldata effect, simulation evidence, and receipt evidence.
- Hidden fees, undisclosed commercial relationships, positive-slippage capture,
  and revenue-based routing are prohibited.

## Package Boundary

- Each supported protocol integration is an independent package
  included in the published `littlejohn-mcp` package.
- The running `npx` service does not discover, download, install, or load protocol
  code dynamically.
- When a package uses an SDK, it contains the pinned official SDK integration
  and keeps every SDK type inside the package boundary. An SDK is not required
  when the protocol's supported contract can be implemented and independently
  verified without one.
- A package exports one registration entry point.
- Importing the registration entry point performs no network reads, creates no
  SDK client, mutates no state, and starts no background work.
- Runtime dependencies enter through an explicit factory context at composition
  time.
- Each package applies the runtime external-integration ownership model in
  `docs/ARCHITECTURE.md#external-integration-model`. This document adds only the
  protocol-package contracts below.

## Registration Model

One protocol integration package descriptor contains:

- contract version;
- protocol identifier and display metadata;
- the current exact protocol support level;
- package identity and version, plus SDK identity and version when an SDK is
  used;
- supported chain IDs;
- required deployment record identifiers;
- commercial capability evidence identity when the package supports a revenue
  mechanism; and
- the exact capability identifiers owned by the package.

One static package registration binds that descriptor to its canonical read
capability definitions, action adapter definitions, and application factories.
Executable schemas, behavior, and runtime dependencies remain in those narrow
owners; they are not stored as values in the package descriptor.

Each implemented package descriptor is recorded with its current external
integration classification under
`docs/ARCHITECTURE.md#external-integration-model`.

The top-level package descriptor is not a single large adapter implementation.
Each read capability and action adapter implements a narrow contract.

## Protocol Version Identity

- Each materially different onchain protocol version is an independent package
  with one stable protocol identifier. Its deployment discovery, failures, and
  its implementation of the numeric and evidence owners form one complete
  correctness model.
- A protocol family identifier and display name group version packages only for
  presentation. They never select, dispatch, replace, rank, or provide a
  fallback for a version package.
- Every public capability identifier names the exact protocol version. Requests
  and saved records never use a family identifier in place of a version
  identifier.
- Identifiers and configuration contain no `latest` alias. Runtime never
  selects the newest version or chooses a version by comparing quote results.
- Adding a version adds a new package directory and one static registration. It
  does not edit, wrap, migrate, deactivate, or replace an existing version
  package.
- A task that corrects or extends an existing version names that version
  explicitly. Adding another version is not authority to change it.
- Removal or deactivation is a separate product decision with an exact
  protocol and deployment identity. A security or availability problem does not
  make removal implicit in another version's registration.
- Protocol version, protocol-family display identity, package contract version,
  capability contract identity, deployment identity, SDK package version, and
  package version are separate values with separate owners.
- A deployment identity is the exact tuple of protocol identifier, chain ID,
  contract role, and full contract address. Multiple admitted deployments remain
  independently selectable; no mutable default deployment exists.
- An SDK update does not rename a protocol. An added deployment does not
  overwrite an admitted deployment record.
- Every version package that uses an SDK owns its exact SDK dependency names and
  resolved versions. A later package cannot update an earlier package's imports.
  When incompatible SDK releases must coexist, the new version uses npm's
  standard dependency alias only after its accepted task proves independent
  resolution and package behavior.
- Static registration is additive. Adding or omitting another package preserves
  every existing descriptor, deployment, capability, interface binding, and
  distributed package entry.

## Capability And Action Contracts

Support is tracked by exact `chain × protocol × action × capability` identity.
Package presence does not imply that every protocol action is available.

A read capability declares its input, output, source requirements, conclusions,
freshness policies, and static scope exclusions.

The module responsible for a user action owns that action's canonical,
versioned contract. The contract defines the action identity, applicable
inputs, results, state transitions, ordered responsibilities, expected effects,
failure meanings, recovery, and the construction, simulation, handoff, and
receipt requirements that apply to that action.

A protocol package registers one protocol-specific implementation against one
exact action-contract version. The implementation maps the admitted domain
input to the protocol-native operation and implements only the stages required
by that action contract. There is no universal executable-action pipeline. A
quote is required only when the canonical action contract requires an
execution-price or rate proposal. An action that has no quote does not expose a
placeholder quote, and a read-only quote does not become an executable action.

Every transaction-producing action still provides the exact construction,
decode, expected-effect, simulation, and receipt behavior required by
`docs/TRANSACTION_POLICY.md`. The action contract fixes how those
responsibilities compose and which product module owns their lifecycle. A
protocol package cannot reorder, bypass, or redefine that lifecycle.

Two actions share a process only when their responsibilities, invariants,
durable or externally visible effects, terminal outcomes, failure behavior,
recovery, and cleanup are equivalent. Repeated SDK calls or similar parameter
names do not justify a common process.

Read support, quote support, review support, transaction building, wallet
handoff, and receipt verification activate independently through explicit
feature gates admitted by the applicable capability or action contract.

## Names And Semantics

Little John does not use SDK method names or contract function names as the
cross-protocol abstraction.

Each executable integration keeps two explicit descriptions:

- the canonical action contract owned by the module responsible for the user
  action, defined by user meaning, exact inputs, units, constraints, expected
  effects, lifecycle, and verification requirements; and
- the protocol-native operation, defined by the official SDK method, contract
  function, ABI signature, protocol terms, and native parameter names.

The adapter records the mapping between them. Protocol-native names remain in
audit evidence, decoded transaction details, source references, and developer
diagnostics.

Mapping follows these rules:

- Different native names map to one Little John action only when their input
  meaning, execution model, effects, failure behavior, and required guarantees
  are equivalent.
- The same native name maps to separate Little John actions when its meaning,
  amount mode, execution model, authorization, or effects differ.
- Partially overlapping operations use separate action contracts and share only
  the exact common evidence and numeric types.
- A protocol-specific operation remains a protocol-namespaced action. It is not
  forced into an unrelated common action.
- Display labels never determine action identity or dispatch.

## Parameter Contracts

Every canonical action contract defines a discriminated, versioned input schema.
The protocol implementation defines a separate native parameter mapping. The
canonical input contains:

- a common envelope for chain, sender, recipient, token identities, exact raw
  amounts, limits, expiry, and user selections when those concepts apply; and
- an action-specific payload for the exact canonical semantics.

The protocol-native mapping remains inside the protocol package and translates
the validated canonical input into exact SDK and calldata parameters.

The common envelope contains no meaningless placeholder fields. An action that
does not use a common concept omits it through a different action schema rather
than setting it to `null`, `unknown`, or a protocol-specific interpretation.

Protocol-specific parameters are namespaced by protocol and action. They use a
closed schema, not `Record<string, unknown>`, an unvalidated options bag, or SDK
types exposed across the package boundary.

For every transaction-critical parameter, the adapter declares:

- canonical field and native field;
- exact type and unit;
- required or prohibited status;
- authoritative source;
- valid range and cross-field constraints;
- conversion and rounding rule;
- whether the value is user-selected, policy-derived, chain-read, quote-derived,
  or protocol-required; and
- the calldata or value field that consumes it.

SDK defaults never supply a transaction-critical value implicitly. Little John
resolves the value explicitly, includes it in review and commitments when it can
change meaning, and blocks the action when it cannot be resolved.

## Capability Identity

Capability identity is stable and semantic. It includes the action and behavior
needed to distinguish materially different operations. A broad display term
such as `swap` never hides distinctions such as exact-input and exact-output
behavior.

The package registration binds each capability to:

- stable capability ID and contract version;
- supported chain, protocol, deployment, and action identity;
- its canonical read or action contract and exact version;
- native operation identity;
- required evidence and chain reads;
- conclusions and static scope exclusions;
- expected effects and simulation requirements when the canonical action
  contract requires them; and
- its applicable chain, protocol, and action support meaning.

The package descriptor owns the current exact protocol support level. Action
adapters own any distinct action support level. The runtime support manifest
derives capability availability from the completed interface bindings; package
code cannot declare an unavailable binding available.

Intent resolution targets a semantic capability. When the request is ambiguous
between capabilities or protocols, Little John asks for the missing choice and
does not infer it from similar names.

## Mapping Output

Each protocol implementation returns:

- canonical capability or action evidence for only the consumers admitted by
  the owning contract; and
- protocol-native evidence containing exact official names, arguments, decoded
  calls, SDK and contract versions, and source references.

Canonical action evidence is admitted by the owning action contract and never
discards a protocol distinction that can change
calldata, authorization, asset flow, price limit, fees, expiry, expected effects,
or receipt interpretation.

## Repository-Wide Requirements

Protocol packages cannot replace or weaken platform rules owned by:

- `docs/EVIDENCE_POLICY.md` for source authority and evidence records;
- `docs/NUMERIC_POLICY.md` for asset identity, units, decimals, and arithmetic;
- `docs/TRANSACTION_POLICY.md` for construction, commitments, review,
  simulation, confirmation, wallet handoff, and receipt verification; and
- `docs/ARCHITECTURE.md` for module dependencies, runtime composition, and
  WalletConnect session ownership.

Protocol SDK output follows the trust boundary in
`docs/EVIDENCE_POLICY.md#identity-and-trust`. Transaction-critical validation
follows `docs/TRANSACTION_POLICY.md`.

## Activation Rules

- A package registration never grants transaction authority by itself.
- Protocol support enters as verified read capability before its transaction
  builder activates.
- Executable action support satisfies the `L3 executable` requirements owned by
  `docs/PRODUCT_POLICY.md#support-levels`.
- A protocol name appears in support surfaces only at the exact established
  support level.
- Venue authorization follows `docs/TRANSACTION_POLICY.md`. Adapter registration
  and quote enumeration never select or rank a venue.
- Missing, incompatible, duplicate, or invalid package descriptors fail startup.

## Implemented Packages

The runtime statically registers `uniswap_v2` on Robinhood Chain
`eip155:4663`. The package exposes only
`uniswap_v2.quote_exact_input`. Each request selects the registered factory by
its full address. The capability evaluates the direct candidate and the
declared WETH or USDG one-intermediary candidates in deterministic order,
stopping each candidate at its first terminal hop.

The V2 package does not select a best route, inspect routes outside that
coverage, calculate minimum output or slippage tolerance, estimate gas,
construct a transaction, establish transfer success, or establish token or
transaction safety. No other Uniswap version is implemented.

## Contract Verification

Protocol support is unavailable unless shared contract verification establishes:

- descriptor schema and contract version;
- unique package, capability, and action identifiers;
- the exact canonical read-capability or action-contract owner and version;
- for an action, only the stages and lifecycle admitted by its contract;
- chain and deployment declarations;
- absence of SDK types across package boundaries;
- exact numeric and token-unit behavior;
- different-name equivalent mappings and same-name non-equivalent separation;
- rejection of ambiguous, unknown, extra, and incorrectly namespaced
  parameters;
- canonical-to-native and native-to-canonical mapping vectors;
- explicit transaction-critical parameters and absence of implicit SDK
  defaults;
- malformed and conflicting SDK outputs;
- required failure behavior;
- platform-gate enforcement; and
- support-surface consistency.
