# AGENTS.md

Read this file before every task in this repository.

This file is the sole authority for repository-wide development, review,
documentation, planning, progress, technical-debt, verification, and completion
policy. It does not own product policy, product state, evidence authority,
runtime architecture, numeric rules, protocol behavior, or transaction
authority.

## Document Ownership

Read every document whose boundary a task touches.

| Document | Sole responsibility |
| --- | --- |
| `docs/PRODUCT_POLICY.md` | Product identity, scope, philosophy, responsibilities, support meanings, and the public current-support projection |
| `docs/EVIDENCE_POLICY.md` | Source authority, provenance, freshness, coverage, inference, and public evidence claims |
| `docs/ARCHITECTURE.md` | Repository state and ownership, modules, dependencies, processes, persistence, MCP App and CLI surfaces, WalletConnect session ownership, and loopback HTTP |
| `docs/USER_INTERFACE_POLICY.md` | Human-interface information priority, interaction hierarchy, visual-role meaning, responsive composition, and accessibility presentation |
| `docs/NUMERIC_POLICY.md` | Numeric values, units, asset identity, decimals, conversion, arithmetic, prices, charts, serialization, and numeric verification |
| `docs/PROTOCOL_ADAPTERS.md` | Protocol packages, capability mapping, activation, commercial behavior, and adapter verification |
| `docs/TRANSACTION_POLICY.md` | Transaction authority, explicit confirmation, construction, commitments, review, simulation, wallet handoff, broadcast, receipts, and transaction security claims |

Keep each detailed rule in its owning document. A non-owning document names the
owner and does not paraphrase the rule.

## Documentation Policy

- Every binding policy, current-state fact, interface contract, schema, and
  identifier has one authoritative source. A second handwritten copy is a
  defect even when its wording differs.
- Generated projections identify their authoritative source and are never
  edited as independent contracts.
- A `Current State` section contains only verified present behavior and
  availability. Required architecture and policy appear outside that section
  and do not claim implementation.
- Replace obsolete current-state statements. Do not retain historical state.
- When documents conflict, stop work at the affected boundary. Determine which
  document owns the subject, preserve permanent product and security boundaries,
  and remove the non-owner copy. Do not invent precedence between two rules that
  both belong to the same owner; report the contradiction for explicit
  resolution.
- A task plan narrows implementation work but cannot redefine product policy or
  another binding document. A binding policy change requires explicit user
  approval before the dependent implementation proceeds.
- `AGENTS.md` and `docs/` contain only current policy and current state. Exclude
  decision logs, chronological narratives, status snapshots, past alternatives,
  meeting notes, retrospectives, implementation diaries, origin stories,
  motivational prose, ecosystem commentary, roadmaps, phases, milestones,
  forecasts, future feature lists, and speculative integrations.
- Product behavior claims describe current implementation only. Policy documents
  define mandatory boundaries without presenting unavailable behavior as a
  feature. Unresolved task work belongs in the active progress document as
  technical debt.
- State implemented, unavailable, and permanently prohibited behavior
  distinctly. Do not describe unavailable behavior as planned, optional, or an
  extension.
- External links are evidence citations, not required reading for instructions.
- Public claims use source-owner official citations under
  `docs/EVIDENCE_POLICY.md`.
- Exclude other-chain and other-product comparisons.
- Repository-visible code, comments, schemas, tests, fixtures, development
  documents, and product documents use English by default.
- Ignored files under `.WORK/` may use any language. Rewrite material in English
  before moving it to a repository-visible surface.
- Use plain, common technical terms in this file, binding documents, task plans,
  progress and research files, code, schemas, tests, and interfaces. Do not
  create a repository-specific term when a standard technical term or a direct
  descriptive phrase expresses the same meaning. Define an unavoidable domain
  term at its single owning source. Remove coined, ambiguous, duplicate, and
  legacy names.

## Naming Policy

- Repository-visible identifiers use one format for each role: capability IDs
  contain one dot between a lowercase snake-case domain and member; MCP tool
  names use lowercase `domain_verb_object`; application errors, reasons,
  operation kinds, and operation states use lowercase snake case; JSON and
  TypeScript fields use lower camel case; SQLite identifiers use lowercase
  snake case; HTTP literal
  path segments use lowercase kebab case and name resources rather than clients;
  CLI commands and flags use lowercase kebab case. Do not expose an interface
  name in a shared domain or HTTP resource solely to describe the caller.
- A public action verb describes its actual effect. Use `start` when a call
  creates an asynchronous or confirmation-dependent operation, `get` for one
  current resource, `list` for a collection, `inspect` for analysis, and
  `cancel` for cancellation. Do not use `prepare`, `manage`, `handle`, or
  `process` as substitutes for an exact effect.

## Interface Contract Policy

- The module that owns a capability or operation owns its canonical identifier,
  contract version, input schema, success schema, failure codes, and state
  transitions.
- TypeScript types, JSON Schema, MCP tool schemas, HTTP request and response
  bodies, CLI JSON, MCP App presentations, support projections, and generated
  documentation derive from that canonical contract. An interface never
  rewrites the domain contract.
- After an owning contract admits a canonical product result, evidence record,
  operation state, or persisted value, every handoff uses that admitted value
  or a lossless serialization admitted by the same owner. A consumer-specific
  summary, index, transport view, or visual projection remains separate, names
  its canonical source, and never replaces the admitted value or becomes an
  input from which another consumer reconstructs it. This rule does not bypass
  the owning admission and normalization of untrusted external input.
- Protocol envelopes are transport concerns. MCP JSON-RPC, HTTP status and
  headers, CLI presentation, and App View lifecycle may differ without changing
  the canonical input, result, failure, or operation meaning.
- Runtime binding, registry, path, and correlation architecture is owned only by
  `docs/ARCHITECTURE.md#interface-contract-model`.

## Policy Conflict Resolution

Resolve conflicts by authority, not by convenience:

1. Permanent user authority, key-custody, transaction-integrity, numeric,
   identity, privacy, and fail-closed boundaries cannot be weakened.
2. The document that owns a subject controls that subject's contract and current
   state.
3. An accepted task plan controls implementation order and completion only
   within the binding documents.
4. Process and formatting rules cannot be used to weaken the original product
   goal, a complete handoff, or a higher-authority boundary.

A lower-authority rule never silently overrides a higher-authority rule. Stop at
the conflict, preserve completed valid outputs, identify the exact owner, and
request explicit resolution when the owning policy itself is contradictory or
the required correction changes an accepted plan.

## Workspace Policy

- `.WORK/sources/` contains external source repositories used as references.
- `.WORK/notes/` contains active task plan and progress files.
- `.WORK/notes/research/` contains research material.
- `.WORK/tests/` contains reusable, non-authoritative reproduction, adversarial,
  and audit code that does not belong in the product test suite. Do not create
  repository test code under operating-system private or temporary directories.
- `.WORK/experiments/` contains isolated experiments that do not modify product
  source.
- `.WORK/` is ignored and is not product authority. An accepted plan is
  authoritative only for its task implementation.
- Do not preserve obsolete plans and progress files as an implementation
  history. Delete them only after the user selects replacement, clean restart,
  or abandonment and every reusable current requirement and item of evidence
  has an explicit owner.
- Preserve reusable tests and experiments. Remove generated dependencies, build
  output, credentials, and runtime session state from retained material.
- A retained external source, review input, fixture, capture, screenshot, or
  generated verification artifact remains byte-preserved evidence. Do not edit
  it to represent a later state or reconstruct the source from a projection.
  Store a transformation as a separate derived artifact that names its source
  and limits. When evidence becomes stale, replace the current citation or
  owner statement without rewriting the original artifact.

## Agent Rules

- Inspect repository state before editing.
- Preserve user changes and unrelated work.
- State assumptions that affect authority, security, public interfaces,
  financial meaning, support claims, or user authorization.
- Implement the simplest complete structure that satisfies the accepted goal
  and closes the affected boundary. Complete authority, lifecycle, failure, and
  handoff logic takes priority over minimizing changed lines or code size.
- Use the current ecosystem-standard manifest, protocol, encoding, and package
  behavior when it completely expresses the required boundary. A custom
  artifact may own only product-specific meaning that the standard does not
  express; verification evidence never becomes package-manager state, runtime
  compatibility, or a public contract.
- Do not add unrelated refactors or formatting.
- Do not invent scripts, addresses, liquidity, quotes, evidence, or support.
- Do not weaken binding policy or its verification without explicit user
  approval.
- An accepted task may use a pinned dependency under an automatically permitted
  open-source license without separate per-package user approval when the
  official package artifact identifies the license and the current use adds no
  fee, service account, data transfer, telemetry, branding requirement, source
  disclosure duty, reciprocal product-license duty, field-of-use restriction,
  or commercial-use restriction. Preserve every required copyright, license,
  attribution, modification, and notice artifact in the distributed form that
  triggers that obligation.
- Automatically permitted SPDX license identifiers are `0BSD`, `MIT`, `ISC`,
  `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`, and `BlueOak-1.0.0`. For an
  `OR` expression, one complete branch must contain only automatically permitted
  identifiers and the official package artifact must supply or unambiguously
  identify the selected branch's license text. Record that selection in the
  dependency review. For an `AND` expression, every branch must be
  automatically permitted. Any other identifier, operator, exception,
  `LicenseRef`, missing license, or ambiguous artifact requires the review in
  the next rule.
- Review the complete pinned dependency closure rather than direct dependencies
  alone. Classify runtime, development, optional, and platform dependencies and
  distinguish local development use, separate npm installation, bundled or
  vendored distribution, and generated product output. Apply preservation and
  redistribution duties to the actual use and distribution form.
- Before adding an npm package or changing a pinned npm version, review current
  evidence for that exact version and its complete closure. Inspect the
  official package artifact, source and release provenance, maintainers,
  published security advisories, install and lifecycle scripts, dependency
  graph, release and issue activity, reported operational problems, bundle and
  runtime cost, and the behavior required by the product. Review relevant user
  reports to find practical failure and maintenance risks, but never treat
  popularity, download counts, or user sentiment as security authority.
  Compare the current implementation, a no-dependency implementation, and
  maintained alternatives for security surface, capability fit, performance,
  licensing, redistribution duties, replacement cost, and long-term ownership.
  Select the smallest complete and currently supportable closure. Record the
  pinned-version rationale, material evidence, and why rejected alternatives
  are worse for the exact use. Repeat the review for every version change; a
  prior review does not authorize a different artifact.
- An agent never accepts a custom or non-permissive license, service term, paid
  threshold, data-processing term, branding obligation, source-disclosure or
  reciprocal-license duty, field-of-use or commercial restriction, or other
  material redistribution obligation on the user's behalf. Record the exact
  official terms and required artifacts, then obtain explicit user approval
  before the first dependent implementation or service use. Do not request the
  same approval again while the exact dependency version, official terms, and
  disclosed use remain unchanged.
- Run relevant checks, audit what those checks establish, and report exact
  results.
- Check final repository status and classify unexpected files.

### External Integration Work

- Before adding or changing a hosted service, vendor SDK, protocol integration,
  or other externally operated dependency, identify it under the complete
  classification and current-integration tables in
  `docs/ARCHITECTURE.md#external-integration-model` for runtime ownership and
  `docs/PROTOCOL_ADAPTERS.md` for protocol packages.
- At plan creation, before every affected work unit starts, at every affected
  work-unit boundary, and during integrated review, read the classification
  and current-integration tables in
  `docs/ARCHITECTURE.md#external-integration-model`. Record the applicable class,
  semantic SoT, configuration owner, adapter boundary, and replacement boundary
  in the task plan or current progress state. A stale or missing classification
  blocks the affected integration work.
- A task that implements or removes an external integration updates the current
  integration table in its final documentation unit. Do not add an unavailable
  integration to that current-state table. Protocol integrations additionally
  update their package descriptor under `docs/PROTOCOL_ADAPTERS.md`.

### Shared Process Ownership

- When more than one code path performs the same ordered operation with the same
  responsibilities, invariants, lifecycle, points at which changes become
  durable or externally visible, terminal outcomes, failure behavior, and
  cleanup requirements, implement that operation through one owner.
- Sharing utility functions is not sufficient when each caller still controls
  the order, validation, state changes, commit or rollback, error handling,
  recovery, or cleanup.
- Pass caller-specific data and external dependencies through narrow, validated
  inputs. Do not make callers configure, bypass, reorder, or reproduce the
  shared operation's internal rules.
- Repeated syntax alone is not evidence of a shared process. Keep operations
  separate when they have different responsibilities, state lifecycles,
  durable or externally visible effects, terminal outcomes, failure meanings,
  trust boundaries, or independent verification purposes.
- Do not create a generic wrapper merely to remove repeated code. A wrapper that
  only forwards calls or delegates its internal decisions back to callbacks
  does not provide shared process ownership.
- Do not hide different behavior behind a shared function name or a configurable
  wrapper.

## Problem And Improvement Workflow

Apply this workflow to every defect correction, hardening task, refactor, and
quality improvement. Complete each step before the next.

1. Do not fix a newly observed problem immediately.
2. Combine agent findings and supplied external-review findings into one
   deduplicated issue inventory. External review is evidence, not authority.
3. Search affected and analogous boundaries for similar defects, including
   implementation, tests, schemas, generated projections, documentation, and
   downstream handoffs.
4. Identify structural root causes. Separate root causes, direct defects,
   consequences, unaccepted public choices, and unrelated observations.
5. Produce an honest structural improvement plan that preserves the accepted
   goal and review boundary, fixes the root causes, removes obsolete paths, and
   defines independent verification.
6. Start implementation only after the applicable plan and user-controlled
   choices are explicitly accepted.

Passing reported examples, adding wrappers, renaming work, narrowing its scope,
or increasing test counts never substitutes for closing the complete affected
boundary.

## Work Plan And Progress Policy

Do not create plan or progress files for trivial work. Use them when dependency
management, multi-step implementation, review quality, technical debt, or
handoff quality requires persistent task context.

Task files are:

```text
.WORK/notes/<canonical-task-name>-plan.md
.WORK/notes/<canonical-task-name>-progress.md
```

### Plan Baseline

- The accepted plan is the fixed task contract. Do not edit it during
  implementation.
- The plan defines one canonical task name, goal, exact scope, permanent
  boundaries, dependency-ordered work units, inputs, outputs, affected surfaces,
  acceptance gates, review evidence, debt handling, and final completion gates.
- Write requirements and outcomes as decisive statements. Remove ambiguous
  language that makes an implementer choose unstated behavior.
- The plan must be executable by a third party without conversation history,
  external narrative, or hidden decisions.
- Do not record repository commit identifiers, plan digests, test counts, or
  command transcripts as planning evidence unless a named verification or
  dependent handoff consumes them. A record that only demonstrates activity is
  not evidence.
- Do not rename, split, narrow, replace, or reframe a task to present incomplete
  work as complete.
- Do not delete or rewrite an active plan to escape its goal or reset
  responsibility.
- A clean restart requires explicit user authorization and a new proposed plan
  that preserves the complete product goal and completion criteria before
  implementation resumes.

### Dependency Order And Work Units

- Order work only by dependency, never by category, file type, team, or
  convenience.
- Every work unit consumes complete dependency outputs and produces a complete,
  independently reviewable input for its dependents.
- Every work unit defines the limit of its output: the contract, policy, state
  model, or port it completes; the concerns it does not own; and the exact input
  its dependents receive.
  Work-unit boundaries have no value when a dependent must rediscover or
  reinterpret those limits.
- A passed work-unit output is the single task source for the contract, policy,
  state model, or port that it owns. Dependent units consume that output
  without redefining, repairing, weakening, or bypassing its meaning.
- A work unit fixes every downstream-relevant invariant, failure behavior, and
  extension point that belongs to its output. A dependent unit may add only the
  implementations and entries permitted by those declared extension points.
- If a dependent unit requires an unstated choice, a new bypass, or a change to
  a passed dependency, the dependency output was incomplete. Stop at that
  boundary; do not patch the missing contract in the dependent unit.
- Each planned work unit identifies the contract, policy, state model, or port
  it completes; the fixed output its dependents receive; permitted downstream
  extensions; prohibited downstream changes; consumers; and independent
  verification of that output.
- A passed unit leaves the minimum reproducible handoff evidence needed to
  prove that dependent work did not alter that fixed output. Use canonical
  schema or artifact digests and owned-path manifests only when they reduce that
  uncertainty; retain them in the progress document as current dependency
  evidence, not as a chronological log.
- Work-unit order and historical source bytes are never repository architecture
  or product authority. After every dependent boundary closes, current owning
  modules, canonical contracts, generated projections, and final package
  behavior replace temporary handoff evidence as the verification target.
- Every work unit terminates with `passed` or `failed`.
- Do not implement a later work unit early. Early implementation blocks the
  task even when it appears useful or passes tests.
- Do not split work into units too small to carry meaningful behavior, context,
  and review evidence.
- A review request contains one or more dependency-contiguous work units that
  form a meaningful behavioral or architectural result.
- Do not combine unrelated work merely to enlarge a review request.
- A review boundary is observational. Removing it from a plan must not change
  the planned production structure or behavior.
- A work unit must leave its production structure and behavior in the final
  task output. Do not introduce a transitional result merely to create a review
  boundary. If later evidence requires deleting, replacing, or bypassing that
  result, the unit's completion is `0` and any prior `passed` conclusion is
  invalid. Stop, record the conflict and alternatives, and implement the
  correction only under an accepted replacement baseline.

### Plan Simulation

Before accepting a plan and at every work-unit and review boundary, perform:

1. Forward simulation from the first unit to the final result, checking
   dependency availability, handoff, policy, architecture, state transitions,
   failure behavior, and review boundaries.
2. Reverse simulation from the final result to the first unit, checking that
   each required fact has one producer and each dependent receives a complete
   input.

Reject or block the plan when either simulation finds a missing dependency,
circular or contradictory work, incomplete handoff, hidden early
implementation, weakened boundary, policy violation, unreviewable work unit, or
completion condition that permits unresolved task debt.

### Parallel Work

- Parallelize only work whose results commute: every participant uses the same
  fixed snapshot, has no dependency on another participant, owns a disjoint
  write and decision surface, and produces the same integrated result
  regardless of completion order.
- One integrator reconciles the complete batch before the shared snapshot or
  plan changes. Architecture decisions, plan editing, and dependency-connected
  implementation remain sequential.
- A changed shared premise invalidates every dependent parallel result. Recheck
  it against the new snapshot; do not append stale findings in arrival order.

### Progress Document

- A progress document is current task state, not a diary.
- Record only the canonical task and plan reference, current work unit and
  outcome, available dependency outputs, material evidence, current blocker,
  current technical debt, and self-review of architecture, policy, scope,
  quality, and handoff completeness.
- Replace stale content. Do not append timestamps, percentages, command history,
  test counts, routine actions, resolved errors, or format-filling text.
- Record verification only when it reduces handoff uncertainty or supports a
  pass, fail, blocker, risk, or debt conclusion.
- Retain the current canonical identifiers and digests of passed dependency
  handoffs until every consumer boundary that relies on them has closed.

### Technical Debt

- Technical debt is an incomplete quality condition, not a successful outcome.
- A work unit cannot pass when debt prevents its output, reviewability,
  acceptance gate, or dependent handoff from being complete.
- Bind downstream-resolvable debt to the earliest dependency-valid owning unit
  and resolve it before that unit passes.
- Do not move debt to an unrelated unit.
- Unowned debt blocks the task. Remaining task-scoped debt makes final
  completion fail.

### Plan Conflict And Alternatives

- A contradiction, missing dependency, early implementation, invalid handoff,
  policy conflict, or unowned debt first creates a `blocked` state. It does not
  decide the final outcome by itself.
- Stop at the affected boundary. Do not change the accepted plan, enter another
  unit, or implement a recovery path before the user selects an alternative.
- State the exact conflict, affected outputs, evidence, and why the accepted
  plan cannot proceed unchanged.
- Present executable in-scope alternatives and their costs. These include
  revalidating completed outputs, reverting incomplete work, restarting the
  invalid boundary, explicitly authorized clean restart under the full goal, or
  abandonment.
- Do not delete a complete output merely because its plan is blocked.
- Classify an execution attempt as `failed` only after the selected alternative
  terminates it, the user abandons the goal, or no executable alternative
  remains.

### Pre-Release Anti-Legacy Policy

- The repository has no released compatibility surface.
- Use the best current structure directly.
- Remove obsolete names and structures across code, schemas, tests, fixtures,
  and documentation in the owning work unit.
- Do not add compatibility aliases, deprecated wrappers, legacy readers or
  writers, dual fields, old-name fallbacks, or migration shims for unreleased
  behavior.

### Outcome Rules

- Work-unit and final task outcomes are `passed` or `failed`. `blocked` is a
  current state, not success.
- Completion is binary. It is `1` only when the original accepted boundary is
  fully implemented and verified with no in-scope defect, technical debt,
  required verification gap, or invalidated output. It is `0` otherwise.
- A valid `passed` outcome has completion `1`. `blocked`, `failed`,
  `partially complete`, `unverified`, `deferred`, and `known debt` only explain
  why completion is `0`; they never establish a middle completion state or
  support a completion claim.
- An accepted replacement baseline does not preserve prior completion. It
  defines the boundary that must later reach completion `1`.
- A failed execution attempt leaves the original goal incomplete and never
  makes replacement planning the completed product.
- Do not use partial success or positive wording to pass incomplete work.
- Acceptance gates and checklists are minimum evidence, not proof of completion
  or quality.
- The result passes only when it honestly and robustly satisfies the original
  goal, product boundaries, architecture, and complete dependent handoff.
- Passing gates never overrides failed self-review, architecture weakness,
  policy violation, incomplete handoff, or technical debt.

## Test And Verification Policy

### Verification Order

Review the affected boundary in this order:

1. Define the correctness model first: responsibilities, invariants, allowed
   state transitions, points at which changes become durable or externally
   visible, terminal outcomes, rollback behavior where rollback is possible,
   failure outcomes, recovery, and cleanup. Rigor means establishing whether the
   correctness model and implementation remain valid under applicable
   adversarial paths. It is not measured by the number of files or functions
   reviewed.
2. Derive boundary and adversarial checks from that model. Inspect malformed
   input, parameter combinations, individual and aggregate size limits, numeric
   limits, stale state, concurrency, cancellation, deadlines, ambiguous
   outcomes such as lost responses, storage and memory limits, and error
   precedence where they apply.
3. Audit the tests independently. Do not accept a test as proof of the complete
   boundary when it uses test-only production behavior, derives its oracle from
   the implementation under test, bypasses production composition, manipulates
   the outcome, or verifies only isolated components.

Every layer is required. Boundary checks do not replace structural reasoning,
and structural reasoning does not replace boundary checks. A counterexample
that exposes an incomplete or incorrect correctness model must update that
model and its checks.

- Test quantity, branch quantity, and exhaustive parameter enumeration are not
  proof of correctness. Choose checks for the distinct invariants they can
  falsify, not to increase counts or enumerate combinations without a
  correctness model.
- Audit test code to determine the behavior, boundaries, and counterexamples it
  actually verifies.
- Test schema rejection, normalization, exact numeric behavior, commitments,
  malformed inputs, stale state, mismatches, cancellation, and failure paths
  applicable to the implemented boundary.
- Test security and external boundaries independently from the implementation
  path. Do not make a generated projection verify its own source.
- Do not hardcode production behavior for fixtures, manipulate tests to pass, or
  treat a special-case reproduction as complete boundary coverage.
- Automated tests never broadcast a transaction or request a real signature.
- Networked smoke tests and broadcast-capable checks are manual-only.

## Commands

Inspect the current manifest before running project commands. Use only declared
scripts.

## Completion

- Implement the requested current behavior without weakening its owning policy.
- Keep code, schemas, interfaces, storage, tests, and documentation consistent.
- Verify relevant normal and failure paths and audit what the verification
  proves.
- Do not present fixtures, experiments, or discovery as live support.
- State unavailable and unverified behavior directly.
- Check final repository status.
