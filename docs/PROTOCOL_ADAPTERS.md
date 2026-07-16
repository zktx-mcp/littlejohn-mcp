# Protocol Adapters

This document defines the binding package and activation contract. It is the
sole authority for protocol package, capability mapping, activation, commercial
behavior, and adapter verification policy.

## Candidate Selection Policy

- Candidate evidence follows `docs/EVIDENCE_POLICY.md`. A candidate first
  satisfies the platform-owned gates referenced below.
- Among candidates that satisfy those mandatory gates, Little John prioritizes
  integrations with an officially documented and technically verifiable revenue
  mechanism.
- Revenue capability affects integration work priority only. It never grants a
  support level, activates an adapter, ranks an executable quote, selects a
  venue, changes a security conclusion, or weakens a platform gate.
- Direct DEX protocols, same-chain aggregators, and managed vaults remain
  distinct integration classes. Commercial similarity never collapses their
  execution semantics or responsibilities.
- A revenue-bearing integration declares the provider terms identity, fee
  mechanism, payer, recipient, fee token rules, exact rate scale, rounding,
  credential model, calldata effect, simulation evidence, and receipt evidence.
- Hidden fees, undisclosed commercial relationships, positive-slippage capture,
  and revenue-based routing are prohibited.

## Package Boundary

- Each supported DEX integration is an independent workspace package included
  in the published `littlejohn-mcp` package.
- The running `npx` service does not discover, download, install, or load DEX
  code dynamically.
- A package contains its pinned official SDK integration and keeps every SDK
  type inside the package boundary.
- A package exports one registration entry point.
- Importing the registration entry point performs no network reads, creates no
  SDK client, mutates no state, and starts no background work.
- Runtime dependencies enter through an explicit factory context at composition
  time.

## Registration Model

One protocol package descriptor contains:

- contract version;
- protocol identifier and display metadata;
- package and SDK identity and versions;
- supported chain IDs;
- required deployment record identifiers;
- commercial capability evidence when the package supports a revenue mechanism;
- read capability descriptors; and
- action adapter descriptors.

The package descriptor is a registration root, not a single large adapter
implementation. Each read capability and action adapter implements a narrow
contract.

## Capability And Action Units

Support is tracked by exact `chain × protocol × action × capability` identity.
Package presence does not imply that every protocol action is available.

A read capability declares its input, output, source requirements, conclusions,
freshness policies, and static scope exclusions.

An executable action adapter exposes:

```text
resolveDeployments
quote
build
decode
expectedEffects
simulationRequirements
verifyReceipt
```

Read support, quote support, review support, transaction building, wallet
handoff, and receipt verification activate independently through explicit
feature gates.

## Names And Semantics

Little John does not use SDK method names or contract function names as the
cross-protocol abstraction.

Each action adapter keeps two explicit descriptions:

- the Little John action contract, defined by user meaning, exact inputs, units,
  constraints, expected effects, and verification requirements; and
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

Every action adapter defines a discriminated, versioned Little John input schema
and a separate protocol-native parameter mapping. The Little John input contains:

- a common envelope for chain, sender, recipient, token identities, exact raw
  amounts, limits, expiry, and user selections when those concepts apply; and
- an action-specific payload for the exact protocol-independent semantics.

The protocol-native mapping remains inside the adapter package and translates
the validated Little John input into exact SDK and calldata parameters.

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

The package descriptor declares for each capability:

- stable capability ID and contract version;
- supported chain, protocol, deployment, and action identity;
- input and output schemas;
- native operation identity;
- required evidence and chain reads;
- conclusions and static scope exclusions;
- expected effects and simulation requirements; and
- applicable chain, protocol, and action support level plus exact capability
  availability.

Intent resolution targets a semantic capability. When the request is ambiguous
between capabilities or protocols, Little John asks for the missing choice and
does not infer it from similar names.

## Mapping Output

Adapters return both:

- canonical action evidence consumed by review, security, wallet, receipt, MCP,
  and React read models; and
- protocol-native evidence containing exact official names, arguments, decoded
  calls, SDK and contract versions, and source references.

Canonical evidence never discards a protocol distinction that can change
calldata, authorization, asset flow, price limit, fees, expiry, expected effects,
or receipt interpretation.

## Platform-Owned Gates

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

## Contract Verification

Protocol support is unavailable unless shared contract verification establishes:

- descriptor schema and contract version;
- unique package, capability, and action identifiers;
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
