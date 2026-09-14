# TAG

Tiny Agent Node Graph & Lightweight Executor. State lives in a persistent
problem graph, not in a conversation. See `transcript.md` for the motivation
and `bootstrap.md` for the one-action-per-invocation contract.

## Run

Node.js 22+; no database service, build step, or transpiler:

```sh
npm ci
npm test
node cli.js init
node cli.js status
node cli.js explain root
node cli.js context
node cli.js protocol
```

The only direct runtime dependency is **`@jkershaw/mangodb`**, the file-based
MangoDB, not MongoDB or the unrelated unscoped `mangodb` package.
MangoDB stores a single graph-and-audit snapshot under `.tag/tag/`.
`--store /absolute/path` selects another directory. Copy a closed store to
move it to another machine. `state.json` contains the exported self-development
graph, not a live database; `graph` exports a portable snapshot and `init --from snapshot.json`
imports one into an empty MangoDB store.

## External coding-agent workflow

TAG is useful without provider credentials. A trusted host can inspect files,
make code changes, and run tests, then record **one bounded action**:

1. Run `node cli.js context > /tmp/context.json`.
2. Give a fresh worker `bootstrap.md` and that graph projection, not previous
   model conversations. The worker may inspect the repository.
3. Perform one bounded action and emit a JSON proposal matching `node cli.js protocol`.
4. Run `node cli.js apply /tmp/proposal.json`. Stop that worker invocation.
5. Repeat from fresh graph context, at most 30 generations for an experiment.

For example, at revision zero:

```json
{
  "protocolVersion": 1,
  "revision": 0,
  "nodeId": "root",
  "summary": "Record the initial test result",
  "mutations": [
    {
      "op": "evidence",
      "id": "root",
      "text": "Initial tests passed",
      "source": "npm test, run by the host"
    }
  ]
}
```

Only record results actually observed. Evidence is a provenance claim, not
independent proof. Revisions prevent stale proposals; invalid batches change
nothing. Node IDs are short alphanumeric identifiers with `.`, `_`, or `-`.
New nodes must descend from the current node; other mutations can touch only
that node and nodes created in the same transition.

## External-task bounded dispatch

The trusted caller owns task selection, context, and limits. TAG owns decomposition,
dependencies, information gaps, scheduling, and explicit parent synthesis.
There is no service and the caller does not need the internal graph.
**Harbour is not integrated.** The CLI and exported API are caller-neutral;
the older Harbour-named examples below are historical fixtures, not a connector.

```sh
export OPENROUTER_API_KEY=... # supply through the environment, never a task file
node cli.js dispatch /absolute/path/task.json --store /absolute/path/new-run
node cli.js graph --store /absolute/path/new-run
node cli.js history --store /absolute/path/new-run
```

The task JSON contract is `{ objective, context?, limits? }`. Objective and
context are plain text (at most 4,000 and 16,000 characters respectively).
`examples/harbour-task.json` is a closed-scope planning arithmetic example.
Each dispatch requires an **empty, exclusive store** and creates one isolated
root. A used or interrupted store cannot be redispatched: limits cannot reset
on restart. Keep that directory for inspection; it contains the complete graph
and run audit in the usual MangoDB snapshot.

Stdout is one JSON outcome with exactly:

- `status`: `resolved`, `partially_resolved`, or `failed`.
- `result`: the root synthesis, or an explicit executor stopping message if
  there was no complete synthesis (not a fabricated model conclusion).
- `evidence`: root evidence with provenance; model claims are not independently
  verified observations.
- `blockers`: the unresolved frontier at stopping, including human requests,
  unfinished children, and unsatisfied prerequisites.
- `usage`: all attempted generations (including retries), prompt/completion/total
  tokens, known USD cost, total USD cost, accounting completeness, and outstanding
  budget reservation. `costUsd: null` means a charge cannot be established;
  **never interpret this as free**.
- `stoppingReason`: e.g. `root_terminal`, `generation_exhausted`,
  `budget_exhausted`, `graph_limit`, `no_runnable_nodes`, `rate_limited`,
  `provider_preflight_failed`, or a provider/accounting/proposal error.

Task-level failures still return an outcome with exit code zero. Invalid inputs,
occupied stores, or persistence failures exit nonzero; the caller must check
both process exit and outcome status. A storage failure aborts immediately and
may leave a durable `pending` attempt; inspect it rather than automatically retry.

Programmatic callers can import `dispatch` from `tiny-agent-graph/dispatch`
and call `dispatch(task, { directory, apiKey?, model?, provider? })`.
The public API owns opening/closing the exclusive store. Directory and provider
configuration are trusted host options, never model output.

### Fail-closed safety envelope

| Limit | Default | Allowed |
| --- | --- | --- |
| `maxGenerations` (HTTP inference attempts, including retries) | 5 | 1–15 |
| `maxCostUsd` | $0.10 | $0–$0.10 |
| `concurrency` | 1 | 1 only |
| `maxRetries` per selected-node call | 1 | 0–1 |
| `minDelayMs` after the previous call finishes | 3000 | 3000–60000 |
| `maxOutputTokens` | 1536 | 128–2048 |
| `maxNodes` including the root | 25 | 1–25 |

Unknown limits or attempts to weaken these ceilings are rejected before
inference. A zero budget performs no inference. Graph projections remain capped
at 32,000 serialized characters; graph growth is additionally checked against a
1 MiB serialized-byte ceiling with space reserved for audit/stopping records.
Each HTTP response is capped at 2 MiB and each request times out after 30 seconds.

**Paid inference is intentionally unsupported.** The fixed HTTPS OpenRouter
endpoint accepts only `meta-llama/llama-3.3-70b-instruct:free` (default),
`qwen/qwen3-4b:free`, or `openrouter/free`, and only the `Chutes` backend.
`TAG_MODEL` can explicitly select an allowlisted model or route; there is no automatic model switch, fallback, or
paid escalation. Free model availability is not guaranteed. Before any model
call, TAG locally verifies the model catalogue has zero prices for every
advertised pricing component. Missing, malformed, unavailable, or nonzero
prices stop the run. Requests also prohibit backend fallback and require zero
maximum prompt/completion prices; returned model/provider identities are checked.

`openrouter/free` is the sole router exception to exact returned-model matching:
OpenRouter selects the actual model, whose nonempty bounded model ID must be
returned along with the allowed provider. The route itself must pass the same
catalogue validator as ordinary models: its name or documentation alone never
authorizes inference. The live catalogue must contain exactly one matching entry,
explicit valid prompt/completion zeros, and no nonzero or invalid advertised
components. No individual routed-model tariff is hardcoded or inferred.
The provider restrictions remain intact even if no compatible endpoint exists.

Catalogue knowledge is recorded separately from permission to run and actual
charges. `graph.run.pricing.status` is one of:

| State | Meaning | Inference permitted |
| --- | --- | --- |
| `known_free` | Required prompt/completion prices and every advertised component are valid and zero. | Yes, within all existing limits. |
| `known_priced` | All advertised prices are valid, including required prompt/completion, and at least one is positive. | No: paid inference remains unsupported. |
| `unknown` | Discovery failed, the requested model is absent/ambiguous, pricing is missing/invalid, or verification has not run. | No: unknown is never treated as free or as a known paid tariff. |

Verification accepts nonnegative finite numeric prices and decimal strings
(including scientific notation); malformed values and positive strings that
underflow to zero remain unknown. Every advertised component is checked, not
just prompt/completion. The audit includes a sanitized `reason`, discovery
source/time, and `modelPresent` (`null` when discovery cannot establish presence).
Unknown prices and `allAdvertisedPricesZero` are `null`, not zero/false.
The zero-budget `not_checked` record has only status and reason.
Both disallowed states retain the existing `provider_preflight_failed` outcome;
inspect `graph.run.pricing` to distinguish them. The low-level trusted provider's
`verify()` must return an explicit pricing status; absent/unrecognized records
fail closed. A previously verified adapter loses inference permission if a
subsequent verification is priced or unknown.

The local ledger reserves all remaining USD allowance **durably before I/O**,
counts the attempt and marks its cost unknown before sending, and releases the reservation only on valid
usage/cost accounting or an explicit HTTP 429 rejection. Missing/malformed
accounting or uncertain transport/server failures retain the reservation and
stop immediately without retries. Reported costs are accumulated; any nonzero
charge violates the free-only tariff and stops as `pricing_violation`, including
at or above the budget. A positive reported cost is preserved even if token
accounting is malformed; total accounting then remains incomplete, not zero.
Budget exhaustion stops before another request. As with any remote billing
API, a provider charging contrary to its advertised zero tariff cannot be
prevented locally; it is reported, never treated as permission to spend more.

Only explicit HTTP 429 rejections may retry, within **both** the retry and
generation ceilings. `Retry-After` is honoured up to 60 seconds; invalid or longer
values stop rather than retry early. HTTP 5xx, authentication errors, timeouts,
malformed responses/proposals, and output truncation stop. Error bodies and
credentials are not written to audit. `graph.run` records requested/returned
model/provider, pricing verification, limits, per-attempt tokens/cost/errors,
timestamps, reservations, and final stopping reason.
Each attempt retains `requestedModel` separately from `actualModel` (null when
no response model is available) and `reportedCostUsd` separately from validated
usage. HTTP 404 is recorded as `provider_unavailable`, without retry or an
assumption of zero cost.

No model output is executed as shell commands or file writes. Validated graph
mutations are the only automatic effects; tool proposals require human review.
`tag iterate` and the old unbudgeted HTTP adapter have been retired rather than
leaving an unsafe CLI bypass. The low-level `core/iterate.js` helper and `apply`
remain for trusted external-host transitions, not provider inference.

### Milestone experiment (2026-09-14)

All 31 offline tests passed **before** the live attempt, including budget and
generation exhaustion, graph expansion, retries, malformed responses, and rate
limits. The deterministic integration test uses real MangoDB, a mocked HTTP
provider, and four generations: decomposition into two dependent children,
child resolution, and root synthesis. Its caller receives “The total is 42,
within the cap of 50 by 8.” The graph has three nodes. This is not live inference.

The single live CLI attempt submitted `examples/harbour-task.json` to the
isolated `/tmp/tag-harbour-live-20260914` store. It asks whether three planned
generations estimated at $0.012 + $0.018 + $0.000 fit five generations/$0.10;
those planning numbers are not actual usage. Limits were exactly concurrency 1,
five attempts, $0.10, one retry, 3-second spacing, 1,536 output tokens, 25 nodes.
Requested routing was `meta-llama/llama-3.3-70b-instruct:free` via Chutes/OpenRouter.

OpenRouter discovery failed with `getaddrinfo ENOTFOUND openrouter.ai` in this
environment. Dispatch failed closed at pricing preflight, **before any
generation**. Actual models used: none; generations: **0**; actual cost:
**$0.00**; graph size: **1 node**. The caller received `status: "failed"` and
`stoppingReason: "provider_preflight_failed"`, with the explicit result:
“Execution stopped: provider_preflight_failed. No complete root synthesis is
available.”

The exact exported graph and stdout are preserved as
`examples/harbour-live-graph.json` and `examples/harbour-live-outcome.json`.
The graph can be imported with `init --from` into a separate empty store.
The original self-development `state.json` was inspected and left unchanged.

**The live end-to-end milestone is not yet proven.** Human/environment action
is required to permit DNS/HTTPS access to `openrouter.ai` and confirm the
allowlisted free model/backend is available. Then submit the same example into
a new store. No further inference, paid fallback, service, or Harbour-specific
graph coupling was attempted. Harbour still needs to invoke this CLI/API and
consume the outcome; its source is not part of this repository.
Subsequent review added regression tests for interrupted accounting commits and
filesystem synchronization; pending attempts cannot appear fully accounted.
That milestone's final suite passed all 33 tests.

### Real MangoDB task attempts (2026-09-14)

The existing safety envelope and external dispatch interface were retained,
not replaced or relaxed. Additional offline coverage verifies the public API's
exclusive lock, store cleanup after invalid input, rejection of task-supplied
host capabilities, credential omission from the audit, pricing transport
failures, unavailable allowlisted models, and HTTP-date `Retry-After` handling.

Three small, real MangoDB checks use the installed `@jkershaw/mangodb` in
isolated temporary directories:

| Task fixture under `examples/mangodb/` | Observed host result |
| --- | --- |
| `lifecycle-task.json` | Insert/update/delete survived a new client: `a.count=5`, `b` absent, one document remaining. |
| `query-task.json` | Filtering, descending sort, projection and limit after reopen returned only `b:9`, then `d:7`. |
| `snapshot-task.json` | TAG's opaque JSON, tool input and audit survived reopening; the action stayed proposed, never executed. |

`test/mangodb-tasks.test.js` reproduces these observations. **All 41 tests
passed before the live dispatches**; a subsequent regression for the observed
unavailable-model condition brings the suite to 42. The tasks ask TAG to assess
supplied host observations, not to execute database commands. These are narrow
local checks, not upstream MangoDB fixes or comprehensive MongoDB compatibility
testing. No other repository or Harbour code was changed.

Each fixture was dispatched once, sequentially, through the real CLI, into a
different store under `/tmp/tag-mangodb-live-ZhbGp1`. Each allowed two inference
attempts, $0.03, concurrency one, **zero retries**, at least three-second spacing,
1,536 output tokens and three graph nodes. The combined configured allowance was
six attempts/$0.09; only allowlisted free inference was permitted.

**All three stopped at `provider_preflight_failed`: zero inference attempts,
zero tokens, $0.00 actual inference cost, no reservations, and one node per graph.**
No model produced an assessment. Unlike the earlier milestone, DNS succeeded
and a separate unauthenticated catalogue diagnostic returned HTTP 200, but
neither allowlisted model had available pricing in that response. TAG did not
switch models, relax verification, or attempt paid fallback.

The exact CLI stdout and exported audit for each task are preserved beside its
fixture as `<name>-outcome.json` and `<name>-graph.json`. The sanitized catalogue
diagnostic is `examples/mangodb/catalogue-check.json`.
Live model completion remains unverified. Before another authorized attempt,
confirm availability and zero pricing for an allowlisted model/backend; use a
**new** store, never the previous run directory. For example, after rerunning
the host tests:

```sh
node cli.js dispatch /absolute/path/to/tag/examples/mangodb/lifecycle-task.json \
  --store /absolute/path/to/new-lifecycle-run
```

### Three-fixture replay after pricing classification (2026-09-14)

All **74 tests passed**, including the original three real MangoDB host checks
and pricing-state persistence regressions, before the replay. Exactly the same
`lifecycle-task.json`, `query-task.json`, and `snapshot-task.json` were dispatched
once each, sequentially, into fresh stores under
`/tmp/tag-mangodb-replay-bF6lgd`. Fixture SHA-256 hashes matched before and after;
objectives, observations, and limits were unchanged. The combined ceiling
remained six inference attempts/$0.09 with zero retries and no paid fallback.
Requested routing remained `meta-llama/llama-3.3-70b-instruct:free` via Chutes.

| Fixture | Pricing status / reason | Outcome | Inference attempts / actual cost |
| --- | --- | --- | --- |
| Lifecycle | `unknown` / `model_unavailable` | `provider_preflight_failed` | 0 / $0.00 |
| Query | `unknown` / `model_unavailable` | `provider_preflight_failed` | 0 / $0.00 |
| Snapshot | `unknown` / `model_unavailable` | `provider_preflight_failed` | 0 / $0.00 |

Each catalogue lookup completed, but the requested model was absent
(`modelPresent: false`); this establishes **unknown pricing**, not a paid tariff
or a free one. All three audits have null advertised prices, zero tokens, no
reservations, and one graph node. Actual cost is zero because no inference was
attempted, not because pricing was assumed free. No model produced an assessment,
and live end-to-end completion remains unverified.

Exact new CLI stdout and reopened MangoDB graph exports are preserved under
`examples/mangodb/` as `<name>-replay-outcome.json` and
`<name>-replay-graph.json`. The earlier outcomes, graphs, catalogue diagnostic,
and self-development `state.json` remain unchanged.

## Graph rules and human boundaries

- A ready node runs only when its prerequisites are **resolved** and all its
  children have terminal outcomes. Least-attempted nodes run first; ties use
  insertion order.
- Hierarchy explains purpose; `blockedBy` determines prerequisites. Validation
  rejects dangling references, duplicate IDs, and cycles across both kinds of
  waiting edges.
- Children do not automatically resolve their parent: the parent becomes
  runnable for an explicit synthesis. Failed/partial children cannot yield a
  fully resolved parent.
- `reference`, `evidence`, and `decision` retain context and provenance.
  Projection includes the current node, ancestors, dependencies, references,
  children, and siblings; audit history is never normal model context.
  The default projection budget is 32,000 serialized characters. Long fields
  are literal prefixes, recent records are preferred, and all omissions are
  explicit. `inspect <id>` retrieves the full durable node; do not infer missing
  evidence from a clipped projection.
- Create a `question`, block it with `human: true`, and add a dependency to
  represent missing information. Independent branches remain runnable.
- `propose` records a tool request and marks the node `needs_human`.
  **TAG does not execute model-supplied shell commands or file writes.**
  A trusted host must review and perform permitted actions externally, then
  `resume <id> <evidence>`. Use `answer <question-id> <answer>` for questions.
  These explicit human transitions increment revision but not generation.
- `explain <id>` and `status.waiting` distinguish human blocks, unfinished
  children, and unsatisfied prerequisites (including failed/partial outcomes).
- Mutation rules are explicit in `core/protocol.js`; changing them requires
  an explicit version change, not a silent self-edit.

## Small, portable core

`core/graph.js`, `core/protocol.js`, `core/iterate.js`, and `core/dispatch.js` use ordinary modern
ECMAScript without Node imports. A store supplies asynchronous `load()` and
`save(state, expectedRevision)` methods; an agent is an asynchronous function
from graph context to a proposal. Node filesystem/MangoDB and HTTP integration
live in `adapters/`; the CLI uses Node's built-in argument parser.

This is deliberately a single-writer, small-graph prototype. All CLI commands
take an exclusive store lock; after a crash, remove `writer.lock` **only after
confirming the owning process has stopped**. Await all store operations before
closing. MangoDB rewrites the snapshot with a temporary-file rename; TAG then
fsyncs the snapshot and all ancestor directory entries before acknowledging a
save, including pre-request reservations. Filesystems must support and honour
file/directory fsync; synchronization errors abort, never permit inference.
There are no cross-process database transactions, and hardware/filesystem
failures still require operator inspection rather than automatic recovery.
Back up the closed directory. External code/tool effects and graph commits
are not atomic; verify actual effects before retrying after a crash.

Tests use built-in `node:test`, including real MangoDB reopen/locking checks.
There are no separate lint or build tools.

## Self-development run

`state.json` records **seven applied generations** and one explicit human
transition recording the user's existing authorization:

1. A fresh worker decomposed the bootstrap into context, diagnostics, and
   continuity tasks using TAG's projected graph.
2. The host implemented and verified bounded context.
3. The host implemented and verified frontier explanations.
4. A different fresh worker reconstructed progress from graph-only context.
5. TAG recorded independent review findings as a new hardening task.
6. The host reproduced and fixed all three findings, with regression tests.
7. A fresh worker synthesized the resolved children and resolved the root.

The run stopped with no runnable nodes, below the 30-generation ceiling.
This is a real external-host dogfood run, **not** an unattended provider run
or proof of superiority over conversation-based agents. Code changes and
tests ran in the trusted host; no model-supplied commands were auto-executed.
Full proposals, observations, decisions and results are in the exported graph.

Inspect the recorded run in a separate MangoDB store:

```sh
node cli.js init --from state.json --store /tmp/tag-replay
node cli.js status --store /tmp/tag-replay
node cli.js history --store /tmp/tag-replay
```
