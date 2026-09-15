# Numeric And Asset Policy

This document is the sole authority for numeric values, units, asset identity,
decimals, conversion, arithmetic, prices, charts, serialization, and numeric
verification.

## Invariant

Numeric and unit correctness is transaction-critical. Missing, conflicting,
ambiguous, rounded, truncated, overflowed, or precision-lost values block the
affected calculation, review, or transaction.

## Canonical Amount

- The raw token integer is the canonical amount for balances, quotes, limits,
  fees, expected effects, accounting, simulation, wallet handoff, and receipts.
- Raw quantities use `BigInt` in memory.
- JSON, SQLite, MCP, HTTP, evidence, logs, and package boundaries use base-10
  integer strings.
- An EVM RPC raw asset amount is between zero and `2^256 - 1` inclusive. A
  larger structurally valid decimal string is not an EVM balance.
- JavaScript `number`, binary floating point, and exponent notation never carry
  a transaction-critical or authoritative user-visible financial value. The
  non-authoritative chart projection defined below is the only display
  exception.
- Untyped bare quantities never cross a module boundary.

Every raw asset quantity observation binds:

- asset identity;
- raw integer;
- one of the decimals states defined below; and
- exactly one source position: a chain anchor, a verified registry version, or
  an explicitly unanchored pending-transaction observation.

An unanchored pending-transaction observation binds its transaction hash and
source observation, states that no inclusion block exists, and carries unknown
freshness. It permits reporting the observed raw transaction value and raw gas
rate only. It never becomes confirmed state, valuation input, accounting input,
execution readiness, or a duration guarantee.

Decimals state is exactly one of:

- `available`: an authoritative decimals value and the observation that
  supplied it;
- `not_observed`: a reason code declared by the capability definition, proving
  that the capability did not request or claim decimals evidence; or
- `unavailable`: `missing` or `conflicting` decimals evidence and the exact
  source observations that establish that result.

`not_observed` is not external evidence. It never receives a fabricated source
observation and is valid only when the owning capability definition declares
the referenced exclusion for that exact amount field. `missing` requires at
least one attempted decimals-source observation. `conflicting` requires at
least two disagreeing authoritative observations.

Asset identity uses one canonical EIP-155 CAIP-2 chain ID and is one of:

- native asset identity: chain ID and the native-asset discriminator; or
- contract-token identity: chain ID and canonical lowercase EVM contract
  address.

A raw chain quantity remains reportable when decimals are not observed or are
unavailable. It is not an amount with verified decimals and cannot be formatted,
compared, valued, quoted, or used for transaction construction. An amount with
verified decimals exists only when the required authoritative decimals are
present and bound to the same asset and observation identity.

## Token Identity And Decimals

- Contract-token identity is canonical EIP-155 `chainId + contract address`.
- Symbol, name, logo, and legal underlying are separate display and registry
  metadata.
- Decimals source authority follows `docs/EVIDENCE_POLICY.md`. Execution-critical
  decimals are verified against the exact deployed contract.
- A chain decimals observation binds the exact token identity and chain anchor.
- A registry decimals observation binds the registry identifier, release
  version, record identifier, and canonical record digest.
- Little John never assumes `18`, infers decimals from a symbol or name, or
  reuses decimals from another deployment.
- Missing decimals, conflicting authoritative sources, or changed verified
  decimals invalidate dependent caches, quotes, reviews, simulations, and
  transaction material.
- Decimals disagreement fails closed.

## Display Conversion

Core's `amounts.ts` owns human token-unit admission and conversion through
`humanTokenAmountSchema` and `parseHumanTokenAmount`. Its input length is the
larger of the uint256 decimal width plus one and maximum token decimals plus
two. This is a representation bound; each consuming action retains its positive
amount, asset, unit and evidence requirements. Display formatting is a separate
operation and is never used to reconstruct transaction authority.

- Display input uses an exact decimal parser.
- An exact human-input parser accepts one unsigned plain decimal with no leading integer zeroes,
  except for zero itself. A decimal point requires at least one following digit.
  Signs, whitespace, grouping separators, and exponent notation are rejected.
- Fractional precision beyond the verified token decimals is rejected.
- Parsing never rounds, truncates, accepts exponent notation, or substitutes an
  approximate amount.
- The parsed integer must fit the EVM `uint256` range. A surface that accepts
  human amount input bounds its input before parsing.
- Display formatting derives only from the canonical raw integer and verified
  decimals.
- The account-asset human view removes leading integer zeroes, inserts the
  decimal point implied by verified decimals, and removes trailing fractional
  zeroes. Zero is `0`; no exponent notation, locale separator, rounding, or
  `number` conversion is used. The raw integer remains canonical and remains
  available to exact machine projections. Human presentation follows
  `docs/USER_INTERFACE_POLICY.md` and does not display the raw integer merely
  because the canonical result contains it.
- A formatted value round-trips to the identical raw integer.
- A display value never becomes quoting, accounting, simulation, or transaction
  input without a new exact parse and unit binding.
- Zero may be paired with the exact asset symbol in human presentation without
  an admitted decimals value because every decimal scale represents zero as
  zero. A nonzero raw quantity without admitted decimals is not formatted or
  labelled as a human asset amount. A human interface may present its amount
  as unavailable while exact machine projections retain the canonical raw
  value.

### Rational Display

- One interface-neutral core owner formats a nonnegative reduced rational for
  human display with at most eight significant base-10 digits.
- It uses round-half-to-even once, removes trailing fractional zeroes, and
  reports whether the display is exact or approximate.
- Plain notation is used when the normalized base-10 exponent is from `-6`
  through `15`, inclusive. Other values use a coefficient and signed exponent.
- Rounding that changes a coefficient from `9.9999999` to `10` increments the
  exponent before notation is selected.
- Zero is exact `0`. Every positive rational remains visibly positive and is
  never collapsed into a shared threshold label.
- Exponent selection, rounding, and notation use integer cross-products and
  `BigInt` only. No logarithm, floating-point value, or intermediate formatted
  decimal participates.
- The exact fraction remains the authority. Approximate text is a display
  projection and never becomes an input, comparison value, chart source,
  persisted value, or evidence value.
- A raw-output-units-per-raw-input-unit price is converted to an exact reduced
  output-token-units-per-input-token rational by applying both admitted decimal
  scales once. Human-interface consumers use that object and do not parse a
  fraction string to recover it.

## Arithmetic And Rounding

`src/core/integer-math.ts` owns the shared BigInt greatest-common-divisor
calculation used by rational admission, construction and display scaling.
Each numeric domain retains its own sign, zero, denominator, scale and range
admission; the integer calculation does not admit a financial value.

- Integer, fixed-point, arbitrary-precision decimal, or rational arithmetic owns
  every financial calculation.
- Multiplication and division preserve exact intermediate values.
- Every operation that cannot produce an exact integer declares its rounding
  direction at the protocol or policy boundary that owns the meaning.
- Rounding behavior is part of the public calculation contract and test vectors.
- Price and rate values retain numerator, denominator, base asset, quote asset,
  scale, source, and observation time.
- Price and rate comparisons use exact arithmetic rather than formatted values.
- Values with different token identities, units, scales, or observation meaning
  are never added, subtracted, or compared without an explicit conversion.

## External Boundaries

- SDK, RPC, API, registry, database, and interface values are normalized and
  validated before arithmetic.
- An SDK `number` result is display-only unless exactness for the required range
  is independently established.
- Raw contract or SDK integer results are preferred. An unavailable exact value
  blocks transaction-critical use.
- JSON integers remain strings and never pass through a JavaScript numeric
  parser.

## Core Text, Evidence, And Read Admission Limits

Core text and identifier schemas apply these stable product admissions:

| Boundary | Maximum | Unit |
| --- | ---: | --- |
| fixed identifier | `64` | printable ASCII characters |
| snake-case code | `64` | ASCII characters |
| general single-line text | `512` | Unicode code points |
| warning message | `256` | Unicode code points |
| capability identifier | `64` | ASCII characters including its one dot |

The fixed identifier, snake-case code, and capability identifier are separate
contracts even though their current maxima are equal.

Canonical evidence applies these separate stable product admissions:

| Boundary | Maximum |
| --- | ---: |
| evidence observations | `128` |
| evidence conclusions | `64` |
| replay fact requirements | `128` |
| evidence warnings | `64` |
| observation-target roles | `8,192` |
| public replay references | `8,192` |

Observation projections consume the observation maximum. Conclusion
declarations, drafts, results, and coverage partitions consume the conclusion
maximum. Admitted fact requirements and their supporting-fact subsets consume
the fact-requirement maximum. Warning requirements and results consume the
warning maximum. Equal values do not merge these contracts. The observation
target role maximum applies to the complete static and dynamic role set owned
by one target. The public replay-reference maximum applies in aggregate across
every target in one replay. Changing the first changes evidence-definition
authoring capacity; changing the second changes public evidence-closure
capacity. Canonical JSON arrays and observation claims retain their separate
owners even when their current values equal one of these limits.

Canonical semantic reads apply these stable product admissions:

| Boundary | Maximum | Unit |
| --- | ---: | --- |
| runtime code | `262,144` | decoded bytes |
| transaction calldata | `2,097,152` | decoded bytes |
| transaction receipt | `4,096` | logs |
| transaction access list | `1,024` | entries |
| transaction access-list storage keys | `4,096` | total occurrences |
| account token request or result | `50` | token addresses |

These are canonical read-contract limits, not Ethereum maxima, provider
guarantees, measured maxima, or private adapter tuning. Changing one changes
public admission and requires an accepted contract and Numeric Policy change.
An oversized value fails admission and is not truncated into a partial result.

One complete canonical capability success is at most `8,388,607` UTF-8 bytes,
including its complete result object and excluding transport framing. Core
rejects a larger success as `result_too_large` before any interface receives
it. Changing this maximum changes every capability-definition projection and
each transport envelope derived from it; it does not change an independently
owned feature, presentation, persistence, provider, or MCP-result limit.

`readCapabilityLimits.transactionLogTopics` directly applies the EVM maximum
of four topics per log. `readCapabilityLimits.transactionType` directly
applies the EIP-2718 range owned by [Transaction Type And
Fees](#transaction-type-and-fees) and does not define a second range. These
standard-derived values are not product tuning.

## Chain Invocation And RPC Limits

Chain transport applies these current numeric boundaries:

| Boundary | Current value | Unit | Class and failure | Change meaning |
| --- | ---: | --- | --- | --- |
| exact RPC transport target | `4,096` | UTF-8 bytes | stable configuration admission; invalid input throws `TypeError` before publication or external work | changes the admitted endpoint envelope and requires target-security and Runtime-configuration review |
| per-request deadline | default and maximum `10,000`; supplied safe integer `1..10,000` | milliseconds | private transport deadline; expiry is `chain_response_unavailable` and caller abort remains `request_aborted` | changes external-resource lifetime and failure timing without changing product-data meaning |
| response body after HTTP content decoding | `8,388,608` | bytes | private transport resource guard; declared or streamed overflow is `source_inconsistent` before copying or parsing the overflowing byte | changes admitted provider bytes, memory use, and the derived block-hash maximum |
| active external RPC requests | `16` | requests per process | private process capacity shared by requester instances; excess admission is `runtime_busy` before `fetch` | changes process resource use, overload behavior, and each direct scheduler ceiling |
| JSON-RPC batch | `1..32` | calls per external request | private transport capacity; invalid cardinality throws `TypeError` before external work | changes provider compatibility and every relational consumer, but not an equal Core or feature-private limit |
| block transaction hashes | `121,574` | hash occurrences | derived normalization bound `floor((8,388,608 - 1) / 69)` for one canonical JSON hash array | cannot change independently of the response-byte boundary and canonical-array formula |
| whole Chain invocation | `90,000` | milliseconds | stable application terminal boundary; deadline is `chain_response_unavailable` | changes terminal timing for every Chain capability and requires close-and-drain review |

Target admission, request deadline, response bytes, process concurrency, batch
cardinality, and whole-invocation termination remain separate contracts. The
whole-invocation deadline is neither the sum nor the configuration of request
deadlines. Equal feature, Core, provider, local-HTTP, or release values do not
share these owners. The block-transaction maximum derives only from the
response-byte boundary and the canonical JSON array formula.

Changing one boundary requires review of its failure meaning, direct consumers,
and derived projections. It does not authorize a provider or endpoint change,
merge an equal-valued limit, or reinterpret a feature-private capacity.

## Local HTTP Limits

The fixed loopback transport applies these current numeric boundaries:

| Boundary | Current value | Unit | Failure | Change meaning |
| --- | ---: | --- | --- | --- |
| request body | `65,536` | raw HTTP body bytes | excess is `payload_too_large` before JSON parsing or handler work | changes every POST transport admission and canonical snapshot-input capacity |
| default internal response | `65,536` | encoded bytes in the owning response carrier | an oversized produced HTTP frame is `internal_error`; an oversized compatible-owner response retains its unavailable or delivery-unknown lifecycle; an oversized snapshot resource is `capacity_exceeded` | changes owner identity, compatible-process, control and snapshot-resource envelopes |
| public-read HTTP response | `8,388,608` | bytes including one line feed | a conforming canonical capability success fits; an invalid oversized route result is not published | cannot change independently of the Core complete-success maximum or fixed framing |
| complete request target | `4,096` | UTF-16 code units including query | excess is `invalid_input` for inbound HTTP and invalid dispatch input before transport | changes only target admission |
| route pathname | `2,048` | UTF-16 code units | excess actual input is `route_not_found`; a definition whose minimum concrete pathname exceeds the limit is rejected before registration | changes route-definition and route-match admission together |
| actual or literal route segment | `128` | ASCII characters | excess actual input is `route_not_found`; an over-limit literal definition is rejected before registration | changes literal-definition and parameter-value admission together; parameter names do not consume this value |
| owner transport | `2,000` | milliseconds | expiry retains the owner unavailable, port-conflict, request-not-sent and send-began distinctions of its lifecycle | changes connection, identity-verification and pre-response dispatch timing, not response observation or recovery |
| owner dispatch attempts | `2` | attempts per dispatch | exhaustion is `runtime_state_unavailable` | permits one initial attempt and at most one pre-connection demand-driven takeover retry; changing it changes contention and retry work without authorizing resend after connection or send began |

The public-read response maximum is the Core complete-success maximum plus its
one line-feed byte. Request, response, route, owner-session, snapshot,
operation-observation and persistence limits remain separate contracts when
their values are equal. Complete first-response observation and recovery retain
their independently owned lifecycle bounds in `docs/ARCHITECTURE.md`.

## Durable Operation And Presentation Limits

Immutable presentation and direct operation handling apply these separate
current boundaries:

| Boundary | Current value | Unit | Produced failure | Existing-state failure | Change meaning |
| --- | ---: | --- | --- | --- | --- |
| immutable presentation result | `8,388,607` | UTF-8 bytes per complete canonical result | snapshot `capacity_exceeded` before advertisement or commit | snapshot inconsistency or unavailability retains its owning reason | changes immutable snapshot identity, row and chunk admission, and retention only |
| retained presentation snapshots | `16,384` | distinct rows | a new row above capacity is `capacity_exceeded`, without insertion or eviction; an exact existing pair remains reusable | over-capacity startup is `runtime_state_unavailable` | changes retention admission only |
| retained presentation bytes | `536,870,912` | aggregate encoded input-plus-result bytes | a new pair above capacity is `capacity_exceeded`, without mutation | over-capacity startup is `runtime_state_unavailable` | changes aggregate retention admission; metadata and database file size are excluded |
| presentation result chunk | `262,144` | raw bytes per non-final result chunk; the final chunk contains the remaining nonempty bytes | invalid chunk admission retains snapshot inconsistency | invalid exact chunk read is `snapshot_inconsistent` | changes chunk indexing, count and stored chunk-digest derivation |
| direct Wallet operation action | `16,384` | UTF-8 bytes per complete canonical decision or cancellation input | `invalid_input` before lookup, persistence or external effect | not applicable | changes Wallet connect, disconnect and cancellation input admission only |
| persisted Wallet operation JSON | `65,535` | UTF-8 bytes per SQLite row | the current writer is structurally below the limit | `runtime_state_unavailable` | changes Wallet operation storage and exact-read capacity only |
| persisted Token Catalog operation JSON | `65,535` | UTF-8 bytes per SQLite row | addition excess is non-retryable `result_too_large` with the complete mutation uncommitted; removal remains structurally representable | `runtime_state_unavailable` | changes Token Catalog operation storage and exact-read capacity only |

The original canonical JSON payload in a Local HTTP internal response is
`65,535` UTF-8 bytes, derived exactly from the `65,536`-byte carrier and its
required one-byte line feed. It is not independently tunable. The MCP App
operation-result descriptor consumes the Local HTTP request-body maximum for
its input length and this derived payload maximum for its result length; it
owns no additional numeric capacity.

The App-native card action pairs the original result with its admitted card
presentation delivery. Each component retains that `65,535`-byte canonical
bound. Inserting `"result":` and a comma into the presentation delivery adds
10 bytes, and the HTTP line feed adds one. The complete paired carrier is
therefore at most `2 * 65,535 + 10 + 1 = 131,081` bytes. The card contract owns
this derived envelope and its component checks. Its native route and binding
consume that bound; ordinary internal responses and all storage bounds remain
unchanged. MCP's public action result remains the original component. Private
presentation JSON text is bounded by the original component maximum before
parsing, and complete MCP framing retains its owning overall limit.

Wallet and Token Catalog persistence retain separate owners despite their equal
current values. Changing either requires review of its canonical operation,
atomic failure, SQLite admission and exact Local HTTP, MCP and CLI consumers.
Neither value is a projection of the immutable snapshot or Core capability
success maximum.

Runtime's `presentationSnapshotLimits` in `src/runtime/presentation-snapshot.ts`
owns presentation result, row, aggregate and chunk capacities. Snapshot input
consumes the [Local HTTP request-body bound](#local-http-limits). The same
Runtime module owns the derived metadata bounds in
`presentationSnapshotMetadataLimits`: each contract identity field consumes
`internalResponseLimitBytes`, and the canonical chunk-digest array is at most
`67 * ceil(resultBytes / resultChunkBytes) + 1` UTF-8 bytes. These are containing-
envelope and encoding bounds, not independently tunable capacities. Complete App
resource admission still checks the entire response. Oversized produced
identity text is `capacity_exceeded` before persistence; malformed text or an
invalid stored identity is `snapshot_inconsistent` at the exact read boundary.

Runtime owner revision storage consumes
`internalCanonicalJsonResponseLimitBytes`, the necessary field bound of its
unchanged owner-identity response. The reader admits encoded bytes before
integer conversion, and publication admits the next revision before writing.
Excess is `runtime_state_unavailable` with no owner update, saturation or wrap.
This storage envelope does not change Core unsigned-decimal admission or
replace the complete response-size check.

## SQLite Operating Limits

### Card Metadata

`presentationCardLimits` in `src/interfaces/mcp-app/card-contract.ts` owns a
separate capacity of `16,384` stateful card records, including closed and
response-only decisions. This matches the snapshot decision count without
consuming its separate data allowance. No eviction or growing post-dispatch
allocation is permitted.

The row bound is the JSON object envelope with metadata scalars at their owning
maximum, plus the largest closed outcome branch. Core's 32-byte base64url IDs
need 43 ASCII characters; SHA-256 text needs 64, snapshot IDs 71
and canonical UTC 24. The containing decision row adds 135 bytes for the public signing account/method
context to the scalar/outcome envelope, for 801 bytes. Read-card input and result
reference branches fit within that containing bound. Aggregate capacity is
13,123,584 bytes. Enum widths come from admitted sets. Keys, quotes,
delimiters are included. Nullable fields
use the larger form. Incompatible maximum field combinations form a containing
bound, not a valid input. Aggregate bytes are row capacity times row bytes.
Stored JSON length is admitted before materialization and decoding. A transition
cannot introduce unbounded text, arrays or payloads.

### Wallet Connection Storage Admission

Wallet connection storage derives permission-array byte envelopes from the
canonical connected-wallet count and Core printable-ASCII identifier width.
For maximum count `n` and identifier width `m`, the canonical JSON envelope is
`n * (2 * m + 3) + 1` bytes, accounting for quote/backslash escaping. The current
`64` entries and `64` characters give `8,385` bytes per array. This does not
merge canonical connection capacity with private SDK input limits.

Connection revision storage consumes `internalCanonicalJsonResponseLimitBytes`
from its exact-operation response envelope. Unresolved session-count storage
consumes Core's `maximumSuccessUtf8Bytes` from its public connection-result
envelope. These are necessary field ceilings, not new integer ranges. Full
containing-result admission remains independent. Stored fields must be bounded
before materialization; an invalid row is `runtime_state_unavailable`. A
produced excess leaves its entire mutation uncommitted, without saturation,
truncation, or schema repair.

### Connection Operating Settings

`sqliteOperationalLimits` in `src/runtime/database.ts` owns these separate
operating settings:

| Setting | Current value | Unit | Failure and change meaning |
| --- | ---: | --- | --- |
| busy timeout | `5,000` | milliseconds of SQLite lock waiting | preserves Runtime `runtime_busy` and Token's existing storage normalization; changing it changes lock-wait behavior, not a query deadline |
| artifact settlement attempts | `8` | attempts to obtain an admitted artifact observation | exhaustion propagates the last failed observation; changing it changes bounded observation attempts, not mutation retries or a duration guarantee |

Constructors and PRAGMA configuration consume the same busy-timeout definition.
Artifact observation keeps its existing `setImmediate` scheduling. Neither
setting changes Wallet private storage, HTTP deadlines or operation lifetimes.

## Wallet Management Input And Waiting Limits

The Wallet adapter in `src/wallet/walletconnect-client.ts` owns its private
input and waiting settings. The shared SDK collection limit also bounds the
complete disconnect Review's session list. The canonical Review and coordinator settlement
retain the separate owners identified below. These are current local settings,
not WalletConnect protocol maxima or measured wallet-service guarantees.

| Boundary | Current value | Unit and classification | Source owner | Failure and change meaning |
| --- | ---: | --- | --- | --- |
| SDK record collection | `256` | records per complete proposal, session or pairing array, and sources per complete disconnect Review | `walletSdkCollectionLimit` in `src/wallet/session-limits.ts` | excess fails the owning admission without a partial collection; changing it changes SDK collection admission, bounded descriptor work and disconnect Review capacity; the separate complete-action byte cap still applies |
| SDK namespace set | `16` | own namespace names; private admission | adapter `maximumNamespaceCount` | excess makes an addressable session invalid; changing it changes namespace capture and normalization capacity |
| SDK namespace array | `64` | accounts, methods, events or optional chains per array; private admission | adapter `maximumNamespaceArrayLength` | excess makes its session invalid or its callback identity invalid; pairing-method excess fails SDK admission; changing it changes these input admissions, not Core connected-wallet capacity |
| SDK text | `512` | Unicode code points per value admitted by `validSdkText`; private admission | adapter `maximumSdkTextLength` | invalid or excess text retains its owning session, callback or SDK failure; changing it changes those text admissions and the derived UTF-16 precheck, not unrelated fields |
| pending captured SDK callbacks | `256` | events before activation release; private queue capacity | adapter `maximumPendingSdkEventCount` | overflow irreversibly makes observation unavailable; ignored events consume no entry; changing it changes pending event retention only |
| Wallet Review action lifetime | `300,000` | milliseconds from `createdAt` to `actionExpiresAt`; canonical contract | `walletReviewActionLifetimeMilliseconds` in `src/wallet/operation-contract.ts` | another interval is an invalid Review; an unacted Review at or after expiry is `wallet_operation_expired`; changing it changes Wallet Review construction, commitment and action expiry |
| SDK acquisition | `300,000` | milliseconds across module loading and SDK initialization; private monotonic deadline | adapter `acquisitionDeadlineMilliseconds` | expiry fails acquisition with `deadline` and prevents late publication; changing it changes acquisition timing, not approval settlement |
| approval settlement after containment | `300,000` | milliseconds waiting for the approval future after proposal/pairing containment; private wait | adapter `approvalSettlementMilliseconds` | timeout fails cancellation or withdrawal containment and poisons SDK admission; a late approval cannot replace the terminal result; changing it changes this wait only |
| coordinator effect settlement | `300,000` | milliseconds per cancellation, post-effect cleanup or close wait; private wait | `effectSettlementMilliseconds` in `src/wallet/coordinator.ts` | `withDeadline` raises `wallet_timeout`; postcondition reconciliation still owns the operation result, and close retains process-terminal ownership; changing it changes these waits only |

The SDK text precheck is twice its code-point maximum in UTF-16 code units,
derived from the maximum width of one code point. It does not replace complete
code-point and character admission. The array and namespace caps bound
product-owned descriptor capture after cardinality admission. They do not bound
SDK-created values, the native `Reflect.ownKeys` key array, arbitrary Proxy
execution, string/QR codec allocation, decoded heap or process memory. No new
raw pairing-URI quota is implied.

Equal values do not merge collection and queue capacities, Review and settlement
lifetimes, or Wallet and Token Catalog contracts. Review constructors and its
parser consume the same canonical lifetime. SDK acquisition uses one deadline
across both phases. Approval settlement does not bound the preceding containment
work. Coordinator settlement is a per-wait bound; sequential waits do not imply
one aggregate duration limit. Expiry and initial connect/disconnect waits use
the operation's remaining immutable action window. Timeout never proves that
external SDK work stopped. Lifecycle and terminal ownership remain in
[Architecture](ARCHITECTURE.md#wallet-connection-lifecycle).

The coordinator schedules session and operation wake-ups in slices no greater
than `2,147,483,647` milliseconds, the timer delay representation bound. It
rechecks the actual expiry after a slice and never shortens a session to fit
one timer. This is not a new deadline, polling interval or expiry authority.

## WalletConnect Private Storage Limits

`walletConnectStorageLimits` in `src/wallet/walletconnect-storage.ts` owns these
combined persistent/volatile storage boundaries. They do not share the product database's capacities
or operating settings, even when values are equal.

| Boundary | Current value | Unit and classification | Failure and change meaning |
| --- | ---: | --- | --- |
| stored keys | `4,096` | distinct keys; private capacity | excess existing state rejects opening; a new key at capacity fails without mutation, while replacement remains possible; changing it changes storage and complete-read capacity |
| stored key | `4,096` | canonical UTF-8 bytes per nonempty NUL-free key; private admission | malformed or excessive input or stored bytes fail admission; changing it changes key admission and its derived startup projection |
| stored value | `16,777,216` | complete `node:v8`-serialized bytes per value; private capacity | excess existing state rejects opening; excess serialization fails before a SQLite mutation; changing it changes value admission and schema identity |
| stored value aggregate | `134,217,728` | sum of serialized value bytes; private capacity | excess existing state rejects opening; insertion or replacement excess fails atomically without eviction; replacement accounts for `total - old + new`; changing it changes storage and complete-read capacity |
| storage checkpoint | `0..2^63 - 1` | persisted SQLite revision plus volatile generation, calculated as `BigInt` within one owner lifetime | an effective mutation beyond the maximum leaves its value unchanged and fails; durable revision changes roll back with their SQL mutation; no wrap or saturation |
| busy timeout | `5,000` | milliseconds of SQLite lock waiting; private operating setting | lock failure becomes private storage unavailable; constructors and PRAGMA configuration consume the same value; changing it changes lock-wait behavior, not a query or SDK deadline |

The aggregate excludes keys, schema, metadata and SQLite artifacts. The startup
key prefix is derived from the key-byte limit plus one excess byte, and the
entry scan from the key-count limit plus one excess row. Schema field prefixes
and row count derive from the exact local schema reference, encoded on the same
SQLite connection, plus one excess byte or row. These witnesses never authorize
accepted truncation and are not separately tunable quotas.

Private storage failures latch the owning unavailable result; they do not
produce an empty store. The combined key and value aggregate includes both
tiers. Each durable mutation and revision commit together; volatile mutations
and their generation publish synchronously. A volatile generation is not
restored after owner termination.
An equal-value `setItem` still advances revision; removing a missing key does not.
Architecture owns storage lifecycle and stable-observation use of the revision.

The value limit is checked after serialization. It bounds encoded stored and
transferred bytes, not the supplied object graph, codec allocation or CPU,
decoded heap, process memory, SQLite engine parsing, database/WAL file size or
startup duration. The standard opaque codec does not promise canonical bytes
for equal JavaScript values. No numeric bound here permits interpreting the
SDK value contents or changes session authority. The exact restoration-namespace
allowlist and volatile namespace lifetimes belong to Architecture and Wallet.

## Official Asset Limits

Official Stock Token observation applies these independent current boundaries:

| Boundary | Current value | Unit | Failure | Change meaning |
| --- | ---: | --- | --- | --- |
| normalized official members | `512` | members per complete snapshot | excess provider membership is `source_inconsistent` and produces no snapshot | changes official membership admission and every direct bounded projection |
| snapshot revision | `16` | random bytes encoded as canonical unpadded Base64url | invalid width is a local contract or persistence failure and never source evidence | changes stored revision, cursor and evidence-correlation contracts |
| provider deployments | `8` | deployments per source asset | excess is `source_inconsistent` | changes only provider-response admission |
| provider response | `1,048,576` | bytes after HTTP content decoding | declared or cumulative streamed excess is `official_asset_response_too_large` before copying or parsing the overflowing result | changes provider memory and response admission |
| provider response deadline | `10,000` | milliseconds for fetch plus complete body | expiry is `official_asset_response_unavailable`; caller abort remains `request_aborted` | changes provider resource lifetime and failure timing |
| StockFactory verification concurrency | `5` | member verifications in flight per `verifyManyAtBlock` call | no partial result is published | changes Chain scheduling and RPC pressure, not the process-wide requester maximum or evidence meaning |

The canonical Registry contract owns member and snapshot-revision admission.
The Robinhood source adapter privately owns deployment, response-byte and
deadline limits. Chain privately owns StockFactory verification scheduling.
Equal Token Catalog, Account, RPC or Local HTTP values do not merge these
contracts. Source authority remains in `docs/EVIDENCE_POLICY.md` and integration
and lifecycle ownership remains in `docs/ARCHITECTURE.md`.

## Token Catalog Limits

Token selection applies these independent current boundaries:

| Boundary | Current value | Unit | Failure | Change meaning |
| --- | ---: | --- | --- | --- |
| selection and selection-set revision | `16` | random bytes encoded as canonical unpadded Base64url | invalid width is a local contract or persistence failure | changes optimistic selection identity, set identity and stored correlation, not Official Asset revision meaning |
| omitted selection-list limit | `25` | selections | omitted input normalizes to `25` | changes default page demand only and cannot exceed the maximum |
| selection-list maximum | `25` | selections per request and result page | excess request input is `invalid_input`; an excess produced result is invalid and is not published | changes request, result and bounded persistence-query capacity |
| direct selection action | `32,768` | UTF-8 bytes of complete canonical JSON | excess direct input is `invalid_input` before operation lookup, state comparison or mutation | changes only the Token Catalog direct-decision envelope, not the Local HTTP request-body limit |
| Token Catalog Review action lifetime | `300,000` | milliseconds from `createdAt` to `actionExpiresAt` | another interval is an invalid Review; an unacted Review at or after expiry is `token_review_expired` | changes the Token Catalog decision window and commitment, not Wallet Review or owner-session timing |

The canonical Token Catalog contract owns these values, their schemas and
their state meaning. Selection and selection-set revisions share one width
because they identify the item and collection sides of the same selection
state transition. Official Asset revisions, Core display text and operation
IDs, Account Asset pages, Wallet Reviews, Local HTTP transport, presentation
results and persisted-operation envelopes retain their separate owners.

## Account Asset Page Limits

The Account Asset collection applies these independent current boundaries:

| Boundary | Current value | Unit | Failure | Change meaning |
| --- | ---: | --- | --- | --- |
| omitted collection limit | `5` | contract assets | omitted input normalizes to `5` | changes default page demand only and cannot exceed the maximum |
| collection maximum | `5` | contract assets per request and result page | excess request input is `invalid_input`; an excess produced result is invalid and is not published | changes Account Asset request, result, and bounded selection-query capacity |

The native asset is separate from these counts. These values do not derive from
Official Asset capacity, Token selection-list capacity, the default manifest,
Local HTTP response bytes, or MCP App layout. The Account Asset canonical
contract owns their schemas and result admission.

## Token Inspection Persistence Limits

The local Token inspection cache applies these independent current boundaries:

| Boundary | Current value | Unit | Produced failure | Existing-state failure | Change meaning |
| --- | ---: | --- | --- | --- | --- |
| persisted inspection result | `65,536` | UTF-8 bytes per complete canonical result | excess during Token addition is non-retryable `result_too_large` before mutation | `runtime_state_unavailable` | changes cache-row admission and startup result materialization only |
| retained inspection rows | `4,096` | rows | deterministic cache replacement keeps the post-insert count within the bound | `runtime_state_unavailable` | changes cache metadata work and replacement frequency only |
| retained inspection result bytes | `67,108,864` | aggregate UTF-8 bytes | deterministic cache replacement keeps the post-insert total within the bound | `runtime_state_unavailable` | changes cache storage and complete startup re-admission work only |

The Runtime SQLite schema owns these storage values. Row count and aggregate
bytes remain independent: the aggregate admits one maximum-size result and is
strictly below the maximum implied by filling every row to its per-result
limit. Token capability success, Token operation, Local HTTP, immutable
presentation, Token list and SQLite engine limits remain separate owners even
when a value is adjacent or equal.

Changing one cache boundary requires review of produced admission,
deterministic replacement, existing-state preflight and exact selection lookup.
It does not change the canonical Token inspection, its digest, selection
revision, operation row capacity, current Chain evidence or a public history
contract.

## Runtime Support Manifest Limits

Runtime support-manifest construction applies these separate private
admissions:

| Boundary | Maximum | Unit | Failure | Change meaning |
| --- | ---: | --- | --- | --- |
| protocol-support entries | `128` | entries per final manifest | Runtime construction rejects the manifest before publishing a support projection | changes the versioned Runtime manifest schema and compiled protocol-registration capacity |
| MCP App presentation-contract entries | `256` | entries per final manifest | Runtime construction rejects the manifest before publishing a support projection | changes the versioned Runtime manifest schema and compiled presentation-registration capacity |

These values do not merge with each other, capability registration, protocol
package registration, presentation contract registration, or the generic
canonical-JSON array limit. Changing either value requires an accepted Numeric
Policy change and a Runtime support-manifest contract-version change. It does
not by itself change public `Current Support`; only a change to the admitted
implemented entries or their availability changes that projection.

## Transaction Review And Result Limits

The Review, Wallet response and Receipt/Activity owners apply these distinct
bounds. Equal values do not merge their lifetimes.

| Boundary | Value | Owner and meaning |
| --- | ---: | --- |
| complete request Review or direct-decision JSON | `32,768` UTF-8 bytes | `review/request-limits.ts`; shared transaction/signing envelope; excess is refused before presentation or direct authority |
| private supported request JSON | `4,096` UTF-8 bytes | `review/limits.ts`; excess never enters Wallet handoff |
| live request Review reservations and published Reviews | `16` in aggregate | Runtime's shared transaction/signing memory owner; no truncation or eviction to make room |
| Review lifetime | at most `300,000` ms | Review; the user's deadline and session expiry can shorten it |
| direct grant lifetime | at most `5,000` ms | Review; cannot exceed Review expiry and is consumed inside handoff |
| local Wallet wait | remaining Review lifetime | Review response owner; hash arrival ends this wait before the separate initial receipt query |
| SDK Wallet request expiry | `300` seconds | Wallet's pinned Sign request; shared by transaction and data-signing methods, separate from Review and onchain deadlines |
| outstanding SDK request lane | `1` | Wallet; shared by all request kinds; local wait expiry does not release an unsettled SDK request |
| one receipt query or reconciliation | `90,000` ms | existing Chain whole-invocation bound in `chain/invocation-limits.ts`; one budget for the whole command |
| sequential receipt poll delay | `2,000` ms | Receipt/Activity; no overlapping polls and no polling outside the originating bounded command |
| local transaction-response observation | at most `390,000` ms | derived Review maximum plus one Chain invocation; the App consumes the actual remaining Review interval plus that invocation, without renewing Wallet or execution expiry |
| canonical ledger row | `65,535` UTF-8 bytes | Receipt/Activity; hash/reference and admitted actual results, never a Review or request backup |
| ledger rows | `16,384` | Receipt/Activity; no silent eviction |
| aggregate ledger JSON | `536,870,912` UTF-8 bytes | Receipt/Activity; both new and updated rows remain within the aggregate |
| activity page | `25` complete rows | Receipt/Activity; continuation binds the exact account and preceding hash |

Signing typed integers are canonical decimal strings within the declared signed
or unsigned EIP-712 width; byte values have their exact declared width. The
standard message hash is 32 bytes with EVM hex encoding. Intelligence's selected
signature profile owns 32-byte r, 32-byte s and one recovery byte (0, 1, 27 or 28),
represented as lowercase prefixed hex. The private-carriage digest consumes
Core's unprefixed 64-digit SHA-256 representation of those exact bytes. It is
not the signing hash. Signing consumes the shared Review/grant bounds and SDK
request expiry; its local result wait has no receipt interval and introduces no
result-retention timer or persistent capacity.

The transaction-response observation includes the separately bounded result
lookup that may begin after a timely hash. It does not extend signing authority.
Both the App bridge and local owner client explicitly consume this derived bound.
Transaction memory presentations consume the existing input/result byte encoding
and identity owner; they do not consume SQLite snapshot row capacity.

Every ledger read projects SQLite storage class and bytes before native transfer.
A later JSON rejection is not its transfer bound. Capacity reservations remain
memory-only and cannot guarantee that a later disk write succeeds. Failed writes
preserve the preceding row and do not change an observed Wallet hash.

Native fee units use `registry/native-asset.ts`, whose versioned record identifies
Robinhood Chain's ETH and the Ethereum denomination of `10^18` wei per ETH.
The record cites the [Robinhood network specification](https://docs.robinhood.com/chain/connecting/)
and [Ether denomination specification](https://ethereum.org/developers/docs/intro-to-ether/).
RPC supplies actual wei and gas quantities; it does not supply the unit definition.
ERC-20 decimals retain their independent deployed-contract source.

## Transaction Type And Fees

- An [EIP-2718 transaction type](https://eips.ethereum.org/EIPS/eip-2718) is a
  nominal base-10 integer from `0` through `127`.
- Legacy transaction types `0` and `1` carry an exact gas-price value.
- Dynamic-fee transaction type `2` carries exact maximum-fee and priority-fee
  values.
- Other transaction types remain explicitly unsupported for fee interpretation
  and never enter a legacy or dynamic-fee calculation.
- Every interpreted fee value binds the native asset, raw integer, decimals
  observation, and transaction block anchor.
- A pending transaction's reported raw gas rate is not an interpreted fee value
  and follows the unanchored pending-transaction boundary above.

## Charts

- Chart source values remain exact decimal or rational values.
- A chart library may receive a finite floating-point projection only after the
  exact value is established.
- The projection is ephemeral and never stored, returned as canonical data,
  compared, or reused for financial logic.
- A UI chart must display the exact formatted value alongside the visual
  projection.

## Stock Tokens And Market Data

- Registry identifier, contract address, symbol, legal underlying, and token
  unit remain separate.
- Stock Token raw balance and human-display-adjusted balance remain separate.
- A verified current ERC-8056 multiplier applies exactly once. For raw
  balance `raw` and current multiplier `multiplier`, both unsigned integers,
  the adjusted raw amount is exactly
  `floor(raw * multiplier / 1000000000000000000)`. The implementation uses
  arbitrary-precision integer arithmetic and never converts either operand or
  the intermediate product to a JavaScript `number`.
- The current multiplier, its `10^18` scale, token identity, account identity,
  and canonical block remain attached to the adjusted result. A pending
  multiplier is reported as pending evidence and is not applied as the current
  value.
- Missing, malformed, contradictory, or out-of-range multiplier evidence leaves
  the raw balance intact and produces no adjusted amount.
- Trade OHLCV and wallet net flow remain separate data types.
- Wallet net flow is not market volume, P&L, or cost basis.
- A quote is not a candle, fill, guaranteed price, or execution result.

### Uniswap V2 Exact-Input Values

- The quote input and every candidate output are raw unsigned token integers.
- One V2 hop calculates
  `floor(amountIn * 997 * reserveOut / (reserveIn * 1000 + amountIn * 997))`.
  The package uses arbitrary-precision integer arithmetic, preserves the
  downward rounding required by integer division, and reports
  `arithmetic_overflow` for a candidate when a checked EVM `uint256` operation
  would overflow.
- V2 reserves are admitted as `uint112` values. Pair direction follows the
  admitted token order; reserves are never paired by symbol or display order.
- Mid price, execution price, and price impact are reduced nonnegative rational
  values. Zero price impact is exactly `0/1`.
- Token decimals label raw units and the SDK comparison. They do not enter the
  independent raw-unit output calculation. Endpoint decimal failure makes the
  quote unavailable; an unavailable intermediary decimal leaves the independent
  quote reportable and makes only the SDK comparison unavailable.
- The human CLI view labels the canonical raw-unit price separately. It derives
  the exact token-unit price as
  `rawPrice * 10^inputDecimals / 10^outputDecimals`, reduce the resulting
  rational, and display it without converting any component to a JavaScript
  `number`. This display value is not written back into the canonical quote.
- SDK comparison never supplies, rounds, or replaces a canonical quote value.

### Stock Token Trade History Values

- A trade-history period is `1..365` days, `1..52` weeks, `1..12` UTC calendar
  months, or one UTC calendar year. Days and weeks are exact durations. Months
  and years use UTC calendar subtraction with missing-day clamping.
- One canonical complete success is at most `600,000` UTF-8 bytes. Core rejects
  a larger success as `result_too_large` before any interface. This is the
  current initial product admission, not the physical maximum of an interface
  serializer, a provider limit, a profile, or a version.
- A Stock Token/USDG stored candle contains exact positive reduced rational
  open, high, low, and close values, raw Stock Token and USDG volumes, trade
  count, and first and last contributing finalized `Swap` positions. Its price
  is Stock Token units quoted in USDG. These values derive together from the
  same admitted source set and are never reconstructed from chart output.
- Every Unix-epoch-aligned interval intersecting the half-open request is
  represented. The finest stored non-`1m` resolution with at most `185` natural
  positions is selected. Stored values are never split, prorated, resampled,
  interpolated or aggregated again by Little John.
- A Canvas renderer may derive only finite ephemeral price values and
  `quoteVolumeRaw / 10^quoteToken.decimals` from that completed chart series.
  These approximations are never serialized, stored, compared as financial
  values, or used to rebuild an exact field.
- The completed chart series retains its period, exact
  bounds, pair and asset units, positions, gaps, and aggregates in canonical
  JSON. Snapshot reload renders that admitted value without re-reading source
  files or aggregating the chart series.
- Human-interface chart coordinates may use only the non-authoritative
  floating-point projection allowed by [`Charts`](#charts). Exact chart times,
  OHLC values, volumes, trade counts, coverage, and source bounds remain
  available beside that projection and are the only returned or stored chart
  values.

#### Internal Archive Source

The internal archive source admits fixed stored resolutions `1m`, `15m`,
`30m`, `1h`, `2h`, `4h`, `6h`, `12h`, `1d`, and `2d` with exact interval
seconds `60`, `900`, `1,800`, `3,600`, `7,200`, `14,400`, `21,600`, `43,200`,
`86,400`, and `172,800`. It accepts only non-`1m` month members. Stored candle
prices remain positive reduced rationals; volumes and trade counts remain
positive decimal integers. Digit widths are pre-screens only. Block and source
coordinates are at most `2^256 - 1`; a Swap magnitude is at most `2^127`; one
derived trade count is at most `sourceCandleCount × Number.MAX_SAFE_INTEGER`;
and each raw volume is between that trade count and
`tradeCount × 2^127`. A stored price is admitted only when its scale can be
reversed to one positive base amount and one positive USDG amount that each fit
the signed `int128` magnitude boundary under the admitted base decimals and
fixed six USDG decimals.

## Verification

An implemented numeric boundary requires audited golden vectors and
property-based invariants that cover:

- display parsing and raw formatting;
- raw-display-raw round trips;
- serialization across every boundary;
- zero and one raw unit;
- maximum supported integers and decimals;
- values above JavaScript's safe-integer range;
- pending transaction quantities without a fabricated block anchor;
- incompatible token identities and units;
- fabricated, mismatched, and undeclared `not_observed` decimals exclusions;
- every declared rounding direction;
- conflicting and changed decimals; and
- adapter and SDK normalization boundaries.

## Contract Control Enumeration

One contract analysis admits at most `8,192` declared function signatures, and
each canonical signature contains at most `1,024` UTF-16 code units. Core owns
both limits. The source-verification adapter consumes them and does not copy
them. The adapter's smaller response-byte limit further bounds the functions
that one provider response can supply.

One contract-analysis result admits at most `32` observed default-administrator
members. The limit bounds one public result and one same-block RPC batch.
An observed count above the limit produces the explicit `limit_exceeded`
result and no member calls. Returned members are canonical addresses in
strict code-point order with no duplicates.

This public limit is owned by the contract-analysis core contract. The chain
adapter verifies that it does not exceed the chain RPC batch limit and does not
copy or redefine either value. Source-provider response size, request deadline,
and active-request limits are private adapter resource controls and do not
change this public enumeration limit.
