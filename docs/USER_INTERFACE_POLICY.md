# User Interface Policy

This document is the sole authority for human-interface information priority,
semantic-role meaning, decision hierarchy, responsive composition, and
accessibility presentation.

It does not own product facts, evidence meaning, numeric meaning, protocol
behavior, MCP transport, runtime architecture, or transaction authority. Those
remain in their owning documents and canonical contracts.

## Canonical Inputs

- An interface presents an admitted canonical result, immutable Review, or
  operation without changing, reconstructing, or replacing it.
- Human interfaces are sibling projections of the same canonical owners. No
  interface consumes another interface's markup, text, layout, or local state.
- A human summary remains a presentation projection. It is not persisted as
  a canonical result, sent to another interface as authority, or used to
  recreate evidence.
- Every displayed fact comes from the exact admitted value being presented.
  Field availability does not by itself require display.
- Approximate text is visibly identified and never becomes an input,
  comparison oracle, chart source, persisted value, or evidence value.
- Unavailable, unresolved, stale, partial, conflicting, rejected, expired,
  cancelled, and failed outcomes remain distinct. Presentation never converts
  one into a positive conclusion.
- A person is never asked to derive a product conclusion from raw evidence.
  The strongest conclusion established by the owning contract is presented.
  A conclusion the owner does not establish is labelled `Not established` or
  with the owner's unavailable state.

## Information Priority

Each human presentation answers one user question. Information appears in this
order:

1. the question and its primary answer or available decision;
2. status, freshness, coverage, deadline, and limitations that change
   interpretation;
3. supporting comparison and context; and
4. exact values and identifiers that the person must choose, copy, compare,
   recover, or authorize.

One presentation has at most one dominant answer. Equal candidates and
comparable records receive equal treatment. A fact is present only when it
directly answers the question, changes interpretation, identifies the exact
subject or decision, supplies an accessibility-equivalent presentation, or
answers an explicitly requested technical question.

Evidence replay records, source bindings, digests, provider diagnostics,
transport chunks, and machine correlation values remain in their canonical
machine results when they meet none of those conditions. Human omission never
removes or rewrites canonical evidence.

One human fact has one primary owner in a presentation. The same successful
status, identifier, block, value, or explanation is not repeated merely to
fill space. A disclosure answers one named question and does not collect
unrelated technical fields.

Machine pagination, storage pages, RPC batches, snapshot chunks, and response
size boundaries never become interface navigation. A complete admitted
collection is presented in its canonical order and may be filtered locally
without changing or reconstructing the result.

## Semantic Roles

The following vocabulary is closed. Visual implementations and text
projections may use only these meanings. A renderer cannot create a local
palette, type scale, corner scale, shadow, motion rule, status meaning, or
action meaning.

Content roles:

- `brand` identifies Little John. It never means safe, profitable, complete,
  current, or executable.
- `focus` identifies the element that owns visible keyboard focus. It never
  means selection, success, evidence status, or action priority.
- `primary_answer` carries the question and its dominant answer.
- `supporting_text` explains the answer or gives decision-relevant context.
- `metadata` carries subordinate, non-decisive context.
- `exact_value` carries an exact identifier, time, amount, or numeric value.
- `group` contains one coherent semantic region.
- `divider` separates content without turning every value into a card.

Evidence roles:

- `current` means only that the owning freshness rule is satisfied.
- `stale` means that the owning freshness rule is not satisfied.
- `complete` means that the admitted result has complete declared coverage.
- `partial` means that the admitted result has incomplete declared coverage.
- `unavailable` means that the requested fact was not established.
- `warning` names a caution that changes interpretation.
- `error` means that the requested read or interaction failed.

Decision and operation roles:

- `review` identifies the complete immutable facts presented for one decision.
  Its top-level human label is `Decision`; `Review` remains the canonical
  artifact term and may appear only when identifying that artifact or one of
  its exact fields, such as a Review digest.
- `primary_action` is the one permitted non-destructive decision.
- `destructive_action` identifies an explicit destructive decision and never
  shares primary-action styling.
- `secondary_action` is a permitted non-dominant action.
- `disabled_action` identifies an unavailable control and states why it is
  unavailable.
- `active_operation` identifies admitted work that has no terminal result.
- `deadline` presents the server-owned action or operation deadline.
- `operation_absent` means that the Review's reserved operation does not
  exist; it is not an error or evidence that an action occurred.
- `completed`, `cancelled`, `rejected`, `expired`, and `failed` retain the
  exact terminal meanings owned by the operation contract.
- `qr_foreground` and `qr_background` render only the admitted QR matrix and
  quiet zone. They use opaque black and white respectively, with no brand
  tint, transparency, smoothing, cropping, or geometric distortion.

Every evidence, action, active, and terminal role has a human label and a
persistent non-color marker. Color is supporting presentation only. A
limitation that changes interpretation is never reduced to muted fine print.
Chart direction colors describe only the relation between admitted chart
values and never mean gain, loss, recommendation, or evidence status.

Each visual implementation has one visual-token owner for the complete role
vocabulary. Read renderers consume only read roles. Operation renderers add
the already defined decision and operation roles without changing or
repurposing an existing token. Each text interface owns a deterministic
projection of the same meanings and does not depend on color or terminal
styling.

## Typography

Typography expresses information priority through size, weight, color, and
spacing together.

- `primary_answer` appears once per presentation.
- One primary financial answer may receive the strongest value treatment.
- A non-financial answer uses heading treatment rather than an oversized
  display style.
- Repeated comparison values use equal weight and size.
- Field labels and supporting context remain subordinate to their values.
- `exact_value` uses a form that keeps every character distinguishable.
- Action size does not imply authorization; wording, order, and the action
  role express decision priority.

Bold text is not used to fill empty space or make every value important.
Repeated list values never use the primary-answer treatment.

## Human Decisions

- A Review presents the complete bounded decision facts admitted by its owning
  domain. It never substitutes visual or text projection for the canonical
  Review carried to the action owner.
- One user decision that completely determines a permitted local action
  remains one decision. Internal admission, evidence revalidation, operation
  creation, and reconciliation do not become extra confirmation steps when
  they introduce no new material choice.
- A changed subject, effect, evidence anchor, precondition, or authorization
  boundary requires a new Review rather than silent continuation.
- A direct action names its exact subject and effect. A result with multiple
  possible subjects never receives one ambiguous action.
- A destructive action appears in the exact subject context and receives its
  own explicit decision before mutation.
- Transaction Review meaning is owned by
  `docs/TRANSACTION_POLICY.md#review-and-simulation`; this document controls
  only its human information order and roles.
- A read-only quote states the exact limitation admitted by its capability and
  never presents itself as an asset-effect or transaction Review.

## Immutable And Operation Presentation

- An immutable result or Review never refreshes its subject, observation time,
  evidence, or values. Presenting the same artifact again displays the same
  admitted snapshot or fails; it never substitutes a current result.
- A Review remains visually fixed while its reserved exact operation is read.
  An existing operation replaces only the action controls and operation-status
  region. It does not rewrite the Review facts.
- `operation_absent` leaves an unexpired Review actionable only when the
  current interface binding admits direct controls. It never implies
  cancellation, rejection, or failure.
- A direct action disables all decision controls before the call begins.
  Duplicate activation cannot create a second effect.
- An active Wallet operation presents its exact state, server-owned deadline,
  and QR only while the owning operation permits it. A countdown is display
  only and cannot settle or extend the operation.
- A terminal operation removes QR and all action controls before presenting
  its immutable terminal result. Reopening it presents the same terminal
  value.
- A presentation-read failure never invents an operation outcome. It disables
  state-changing controls and may offer only an exact-operation read retry.

## Temporary Transaction Decisions

A transaction decision consumes the Runtime memory presentation source defined
by [Architecture](ARCHITECTURE.md#transaction-request-ownership). It does not read a
durable operation or recreate an expired decision. A blocked decision may display
its same-response facts without offering controls or creating a replay snapshot.

Before direct controls become available, the View checks the exact live decision.
Acceptance disables controls before the call and releases the complete canonical
decision from its continuation. The original decision deadline still owns local
Wallet waiting; a timely hash may enter the separately bounded initial result
lookup. A display timeout or Stop waiting action states unknown signing/broadcast
when no response is observed and never claims remote cancellation.

The person sees the exact token-unit conditions, recipient, applicable allowance,
selected fee caps and gas limit, relevant control facts and evidence limitations.
Routine source/code comparison steps and raw digests do not replace that decision.
Stored activity presents actual execution, request/effect comparison, movements,
fees and material unavailable details. An explicit result query is distinct from
opening a stored result; neither result arrival nor rendering initiates another
financial request.

## Data-Signing Decisions And Results

Data-signing decisions show the complete exact data and declared domain before
direct acceptance. Control characters remain inspectable text or bytes and are
never terminal instructions. Missing chain binding and the absence of broadcast
or proof of external effects are explicit. Closing a result does not revoke its
signature. The signature result provides a selectable complete value and an
explicit Copy action. Copy failure permits manual copying without another Wallet
request. Unknown delivery, unsupported verification, failed verification, Wallet
rejection and failed private delivery remain separate; no unverified value is
presented as usable. Dismissed or replaced result controls cannot be repopulated
by a late response. Exact authority and disposal follow
`docs/TRANSACTION_POLICY.md#data-signing`.

## Layout And Responsive Composition

Every human interface preserves the same semantic reading order. A narrow or
wide visual presentation may stack or reflow content but never hide a
comparison field, change canonical order, move evidence ahead of the primary
answer, or change action meaning.

Each visual implementation owns one outer content region. A renderer does not
create a second outer width or horizontal anchor. The region expands only when
the admitted collection or graphic requires it. Named inner widths may
constrain prose, forms, summaries, tables, Review facts, or QR without moving
the primary answer or redefining reading order.

Only an explicitly labelled comparison table or exact-code region may scroll
horizontally. Ordinary values wrap. Long identifiers remain complete in the
document and clipboard value; a shortened visual line exposes the complete
value through accessible text.

Whitespace and restrained dividers establish hierarchy. Nested decorative
cards, background effects, and empty dashboard fillers do not substitute for
information design.

## Interaction

- Opening, navigating to, rendering, resizing, presenting again, or dismissing
  an immutable presentation does not mutate product state, request a
  signature, or start an operation.
- One clear primary action exists only when the admitted state permits it.
- Secondary actions remain available without competing with the primary
  action.
- Loading, success, empty, invalid-input, unavailable, stale, partial, active,
  and terminal states remain visibly distinct.
- An interface exposes a recovery action only when the owning contract permits
  the exact recovery. It never recommends repeating an action whose delivery
  or effect is unknown.
- A transient dialog has one title and purpose. It does not open another
  dialog or transform into a different task. A direct action may close the
  current dialog before opening one distinct successor task; the two are never
  mounted together.
- Ephemeral layout, disclosure, focus, and scroll state have no product
  authority and cannot select another snapshot or operation.

## Accessibility

- Every visual presentation has one main landmark and one primary heading.
- Every interactive element is keyboard reachable in semantic order and has a
  visible focus indicator.
- Programmatic focus identifies the changed or invalid region without removing
  visible focus.
- Status, selection, error, terminal, and chart meaning never depend on color
  alone.
- Controls retain a usable target size for the active pointer and layout.
- Forms keep labels, instructions, errors, and described-by relationships
  explicit. Validation does not silently rewrite editable text.
- Exact chart values, time, gaps, and coverage remain usable without canvas,
  pointer input, animation, or color.
- QR presentation includes a textual connection instruction and remaining
  server-owned time without exposing the pairing URI.
- A modal presentation preserves native modality and returns focus to the
  control that opened it.
- A status change replaces one live status region rather than appending
  repeated announcements.

## Charts

A graphic receives only the non-authoritative numeric projection permitted by
`docs/NUMERIC_POLICY.md#charts`. Exact values and empty-interval meaning
remain available in accessible text. A graphic cannot become the source for a
later value or comparison.

A Stock Token trade-history presentation always states archive freshness after
archive work as `Current`, `Stale`, or `Unknown`, and states available coverage
as `Complete` or `Partial`, before the chart. Requested coverage is the exact
request intersection of admitted natural-position coverage; evidence outside
the request is never described as requested-period coverage. The presentation
states the published-through bound and every before/after coverage limitation
that changes interpretation. `Unknown` uses the unavailable semantic role
without being relabelled as source absence. An unavailable result states its
exact reason and reached scope. Positive states are explicit rather than
represented by missing text.

A request-cut position is visibly `Partial` even when it carries a candle. The
presentation states before the chart that this is the unchanged full stored
natural candle and may include activity outside the represented request bounds.
It never calls the candle clipped, recalculated, or request-only. Exact natural
and represented bounds remain accessible without comparing chart geometry.

An empty complete position states that no qualifying Swap occurred in that
complete natural interval. An empty partial position states that trade absence
was not established. An unavailable position states that published coverage is
unavailable and also makes no absence claim. A whole-result no-trade sentence is
permitted only when every position is complete and empty. These meanings are
present in model-visible MCP text, CLI human output and accessible App text; a
Host model is not expected to infer them from null fields or timestamp
comparison.

Developer details expose exact requested coverage, the admitted member
identities, every position's natural and represented bounds, state, referenced
Pool provenance, full candle interval and source positions. Raw natural-window
coverage transitions remain server admission facts and are not reconstructed
for presentation. Canvas, color and pointer interaction are never the only way
to distinguish these facts.

## Motion

Motion communicates a direct state change only. Focus, validation errors,
loading completion, evidence-status changes, and terminal adoption are not
delayed for animation. Looping, decorative, background, parallax, and
price-celebration animation is prohibited. Reduced-motion preference removes
nonessential motion without changing information or action availability.
