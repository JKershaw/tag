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

## See TAG plan improvements to itself

This iteration makes **objective → source research → decomposition → inspection**
visible. It does not implement the proposed improvements or execute child tasks.
It reuses TAG's existing graph protocol, scheduler, MangoDB store, and budgeted
provider path; there is no new service, UI dependency, or autonomous execution loop.

### Reliable offline demonstration

From the repository root, with Node.js 22+:

```sh
npm ci
node cli.js demo --store .tag/improve-tag-demo
node cli.js view --store .tag/improve-tag-demo
node cli.js view --html --store .tag/improve-tag-demo > .tag/improve-tag.html
```

Open `.tag/improve-tag.html` in your browser. It is a self-contained, offline HTML
file: no server, scripts, CDN, or model credentials are needed.
You should see **Improve TAG** above four child cards:

- `planning`: one source-grounded decomposition, runnable.
- `inspection`: readable graph inspection, independently runnable.
- `demonstration`: waiting for both `planning` and `inspection`.
- `execution-policy`: a question explicitly waiting for a human.

The root waits for its children; it is **not resolved**. Click prerequisite links
to highlight their nodes and expand cards for rationale, acceptance criteria,
evidence, and source locations. The footer shows transition history.
The terminal view shows the same hierarchy and relationships; long context is
explicitly clipped there, while HTML and `inspect` retain the full text.

**This is a labelled recorded replay, not fresh LLM research.**
`examples/improve-tag.proposal.json` records an external coding agent's inspection
and decomposition of baseline commit `94eef1c` for this iteration. Baseline
citations describe gaps before these changes, not claims that those gaps still
exist. Replaying applies that proposal through TAG's normal atomic mutation
validator. It makes no network calls, runs no tests, and changes no source files.

### Fresh planning for an objective

```sh
# Preview exactly the local research material the planner will send:
node cli.js research

# Supply your key through the environment, never a file committed to the repo.
export OPENROUTER_API_KEY='your-key'
node cli.js plan "Improve TAG" --store .tag/improve-tag-live
node cli.js view --html --store .tag/improve-tag-live > .tag/improve-tag-live.html
```

Open `.tag/improve-tag-live.html`. Substitute your own objective in the `plan`
command to ask for a different improvement to this TAG checkout.
Fresh planning reads a fixed, bounded selection of local TAG sources, with line
numbers, content hashes, and explicit clipping, then asks the existing OpenRouter
adapter to analyse those excerpts and produce one research-backed decomposition.
It does **not** crawl arbitrary files, read environment files, search the web,
run tools/tests, or independently verify model claims. Review `research` before
using it on a checkout containing private modifications: those excerpts are sent
to your selected provider. Missing information should appear as questions rather
than invented findings.

Planning permits **at most one inference attempt, no retries**, up to 2,048 output
tokens, 25 nodes, and the existing $0.10 local budget ceiling and pricing checks.
The default is the existing allowlisted free model; `TAG_MODEL` selects another
existing allowlisted route explicitly. There is no fallback or paid escalation.
A successful outcome says `status: "planned"` and
`stoppingReason: "plan_created"`; the graph remains open with unexecuted tasks.
Fresh model output varies and is not promised to match the offline replay.

Unavailable models/pricing, malformed proposals, or accounting errors stop
explicitly; **failure never silently substitutes the replay**. As with dispatch,
check the JSON outcome as well as the process exit code. Use `graph` and `history`
to inspect `run.pricing`, attempt diagnostics, and usage; an unknown charge is
still `null`, not zero. Live inference is not required for the offline demo.

Both commands require an empty store. To run again, choose a new directory
(for example `.tag/improve-tag-live-2`); existing runs are never overwritten.
Inspection works with existing TAG stores too:

```sh
node cli.js inspect demonstration --store .tag/improve-tag-demo
node cli.js explain demonstration --store .tag/improve-tag-demo
node cli.js graph --store .tag/improve-tag-demo
node cli.js history --store .tag/improve-tag-demo
```

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

**Paid inference requires a local worst-case reservation.** The fixed HTTPS OpenRouter
endpoint accepts only `meta-llama/llama-3.3-70b-instruct:free` (default),
`qwen/qwen3-4b:free`, `openrouter/free`, or the explicitly authorized paid model
`deepseek/deepseek-v4.1-flash`. Individual free models remain restricted to
the `Chutes` backend; the free router and paid DeepSeek model have no default provider pin.
`TAG_MODEL` can explicitly select an allowlisted model or route; there is no automatic model switch, fallback, or
paid escalation. Free model availability is not guaranteed. Before any model
call, TAG locally verifies current catalogue pricing. Missing, malformed or
unavailable prices stop the run. Free routes still require every advertised price
to be zero. Requests prohibit backend fallback and cap prompt/completion prices
at the verified tariff (zero for free routes); returned identities are checked.

`openrouter/free` is the sole router exception to exact returned-model matching:
OpenRouter selects the actual model, whose nonempty bounded model ID must be
returned; the actual provider is recorded when supplied, otherwise left unknown.
An explicitly supplied Chutes pin is still enforced. The route itself must pass the same
catalogue validator as ordinary models: its name or documentation alone never
authorizes inference. The live catalogue must contain exactly one matching entry,
explicit valid prompt/completion zeros, and no nonzero or invalid advertised
components. No individual routed-model tariff is hardcoded or inferred.
Only this router and the authorized paid model may omit `provider.only`.
For free routes, `allow_fallbacks: false`, `require_parameters: true`, and zero
maximum prompt/completion prices still apply. No ZDR requirement is added.

Catalogue knowledge is recorded separately from permission to run and actual
charges. `graph.run.pricing.status` is one of:

| State | Meaning | Inference permitted |
| --- | --- | --- |
| `known_free` | Required prompt/completion prices and every advertised component are valid and zero. | Yes, within all existing limits. |
| `known_priced` | All advertised prices are valid, including required prompt/completion, and at least one is positive. | Only for the authorized paid model, with supported cost accounting and a conservative reservation fitting completely within the remaining local budget. |
| `unknown` | Discovery failed, the requested model is absent/ambiguous, pricing is missing/invalid, or verification has not run. | No: unknown is never treated as free or as a known paid tariff. |

Verification accepts nonnegative finite numeric prices and decimal strings
(including scientific notation); malformed values and positive strings that
underflow to zero remain unknown. Every advertised component is checked, not
just prompt/completion. The audit includes a sanitized `reason`, discovery
source/time, and `modelPresent` (`null` when discovery cannot establish presence).
Unknown prices and `allAdvertisedPricesZero` are `null`, not zero/false.
The zero-budget `not_checked` record has only status and reason.
Unknown or unauthorized pricing retains the `provider_preflight_failed` outcome;
inspect `graph.run.pricing` to distinguish them. The low-level trusted provider's
`verify()` must return an explicit pricing status; absent/unrecognized records
fail closed. A previously verified adapter loses inference permission if a
subsequent verification is unknown or unauthorized. Paid authorization is
single-use; each subsequent request requires fresh catalogue verification.

For paid text inference, the input estimate is the UTF-8 byte length of the exact
serialized messages plus 4096 tokens for two-message template/provider framing,
using the verified DeepSeek byte-level tokenizer family. This deliberately
overestimates ordinary text token counts. The output estimate is the full
`maxOutputTokens`, including any reasoning tokens. The estimate must also fit
the advertised context window. Multiply by the highest verified rates across
the base tariff and **every** scheduled override, ignore cache discounts, and
round the USD reservation up to the next nano-dollar. Schedule fields and prices
are validated, not silently discarded. Higher cache rates also increase the
input bound; unsupported nonzero fees (including per-request/image charges)
make paid inference ineligible. OpenRouter price caps use USD per million tokens.
No provider daily key cap substitutes for this local ledger.

The local ledger persists the paid worst-case reservation (or, for existing free
runs, all remaining allowance) **durably before I/O**, counts the attempt and
marks its cost unknown before sending. Insufficient budget or an unavailable
estimate stops as `reservation_unavailable`, without sending or counting an attempt.
The reservation is released only on valid
usage/cost accounting or an explicit HTTP 429 rejection. Missing/malformed
accounting or uncertain transport/server failures retain the reservation and
stop immediately without retries. Reported costs are accumulated; any nonzero
free-route charge stops as `pricing_violation`. Paid charges above the reservation
stop as `reservation_violation`, before applying the proposal; input/output
token-bound violations also stop. A positive reported cost is preserved even if token
accounting is malformed; total accounting then remains incomplete, not zero.
Budget exhaustion stops before another request. As with any remote billing
API, a provider charging contrary to its advertised tariff cannot be
prevented locally; it is reported, never treated as permission to spend more.
Each attempt preserves the tariff, token estimate, original reserved USD,
reconciled actual USD, and unused USD released. A fully accounted exact-budget
terminal response may be applied; no further inference is permitted.

Only explicit HTTP 429 rejections may retry, within **both** the retry and
generation ceilings. `Retry-After` is honoured up to 60 seconds; invalid or longer
values stop rather than retry early. HTTP 5xx, authentication errors, timeouts,
malformed responses/proposals, and output truncation stop. Error bodies and
credentials are not written to audit. `graph.run` records requested/returned
model/provider, pricing verification, limits, per-attempt tokens/cost/errors,
timestamps, reservations, and final stopping reason.
The run and each attempt persist the exact `routingPolicy` sent to OpenRouter.
Each attempt retains `requestedModel`/`requestedProvider` separately from
`actualModel`/`actualProvider` (null when not reported), and `reportedCostUsd` separately from validated
usage. HTTP 404 is recorded as `provider_unavailable`, without retry or an
assumption of zero cost.

Each inference attempt also persists content-free `diagnostics`: `stage`,
`failureKind`, HTTP status, monotonic `elapsedMs` (request through adapter
validation), the 30-second deadline and 2 MiB response limit, bytes actually read,
whether the body was completely read, its SHA-256 when complete, and the parsed
top-level JSON type. Missing measurements are `null`; partial byte counts are
not the full response size. HTTP error bodies are not read. Exception names and
underlying network codes are allowlisted classifications, never messages, stacks,
URLs, credentials, or arbitrary headers. Returned identities are bounded and
syntax-filtered; validated usage and reported numeric cost remain separate.

Inspect `diagnostics.failureKind` alongside the existing stopping reason:
`request_network_failure`, `request_timeout`, `http_error_status`,
`body_read_failure`, `body_read_timeout`, `response_size_limit`,
`utf8_decode_failure`, `json_parse_failure`, `unexpected_json_type`,
`accounting_validation_failure`, `identity_validation_failure`, or
`proposal_validation_failure`. `stage` distinguishes proposal JSON parsing from
graph/protocol validation. A timeout requires explicit timeout exception/code or
an expired request signal: **elapsed time near 30 seconds is not a diagnosis**.
Legacy stopping reasons such as `malformed_response` remain compatible.
`validProposal` becomes true only when graph validation and application succeed.
No raw prompt/completion payloads are added to the audit; accepted graph mutations
and the existing caller-supplied task remain normal graph state.

#### Controlled lifecycle diagnostic attempt (2026-09-15)

After all **124 offline tests passed**, CodeQL reported zero alerts and an
independent read-only review found no significant issues (the built-in review
binary was unavailable). Exactly one new dispatch used the unchanged
`examples/mangodb/lifecycle-task.json`, `deepseek/deepseek-v4.1-flash`, no provider
pin, and the existing two-generation/$0.03/zero-retry fixture limits.
No query or snapshot fixture was dispatched, and no fallback was attempted.

The isolated store is `/tmp/tag-lifecycle-diagnostics-QiDwpS/lifecycle`.
The persisted outcome and graph are exported as
`examples/mangodb/lifecycle-diagnostics-outcome.json` and
`examples/mangodb/lifecycle-diagnostics-graph.json`. The task SHA-256 before and
after was `005bd9c2f909916e611dacb6777414152a20938ce8dba9ff04c40ea255a7f23c`.

The single inference request was rejected with **HTTP 429**: terminal root
`failed`, stopping reason `rate_limited`, stage `http_status`, failure kind
`http_error_status`, elapsed **768.56941 ms**. The response body was deliberately
not read: byte count, JSON type and body hash are unknown; the configured size
limit remained 2,097,152 bytes. Actual model/provider, token usage and
provider-reported cost were not established. There was no valid proposal,
decomposition, evidence, tool action or model-applied mutation; the one-node graph
only records executor rejection and stopping (generation 1, revision 3).

The $0.0041424 reservation was released in full under the existing explicit-429
unbilled-rejection rule: reconciled cost $0, outstanding reservation $0,
accounting complete. These ledger zeros are **not provider-reported usage**.
No further inference was sent. The previous attempt's unknown charge and retained
reservation were not modified; neither this 429 nor the earlier 30.017-second
duration establishes the cause of that earlier `malformed_response`.

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

### Catalogue-verified free-router replay (2026-09-14)

At 20:46:27 UTC, the public
[OpenRouter catalogue](https://openrouter.ai/api/v1/models) returned HTTP 200
and exactly one `openrouter/free` entry with
`pricing: { "prompt": "0", "completion": "0" }`, with no other pricing components.
The ordinary allowlisted models were still absent. OpenRouter's
[pricing schema](https://openrouter.ai/docs/guides/overview/models#pricing-object)
defines `"0"` as free; its
[free-router documentation](https://openrouter.ai/docs/guides/routing/routers/free-router)
states that both router use and routed requests are free and that the response
`model` identifies the actual selected model. This justifies allowing explicit
selection of this route, **not** a pricing-validation exception. Each dispatch
independently rechecked its live catalogue entry with the unchanged validator
and persisted `known_free / all_prices_zero`. Missing or invalid router pricing
still stops before inference. Catalogue tariff verification does not establish
availability through the required Chutes backend.

All **91 tests passed** (74 baseline plus 17 new router regression cases).
New coverage includes explicit zero router pricing; unknown, malformed,
nonzero, absent and ambiguous router entries; requested/actual attribution and
MangoDB persistence; strict ordinary-model identity checks; provider identity
and missing usage rejection; positive cost on a later completion, at the budget,
and with malformed tokens; and HTTP 404 without fallback, retry or assumed cost.
CodeQL reported zero alerts; a separate read-only code review found no
significant issues (the automated review binary was unavailable).

Exactly the same three fixtures were dispatched once each, sequentially, at
20:50:26–20:50:33 UTC in fresh stores under
`/tmp/tag-mangodb-free-router-eTVq8F`. Before/after SHA-256 checks matched; task
inputs and limits were not edited. Each retained two maximum attempts, $0.03,
concurrency one, zero retries, 3-second spacing, 1,536 output tokens and three
maximum nodes. All requests selected `openrouter/free`, restricted to Chutes,
with backend fallback disabled and maximum prompt/completion prices zero.

| Fixture | Terminal status / reason | Requested route | Actual model | Attempts | Generations | Provider-reported cost | Graph nodes (compact JSON bytes) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Lifecycle | failed / `provider_unavailable` (HTTP 404) | `openrouter/free` | None returned | 1 | 1 | Unknown (`null`) | 1 (2,376) |
| Query | failed / `provider_unavailable` (HTTP 404) | `openrouter/free` | None returned | 1 | 1 | Unknown (`null`) | 1 (2,382) |
| Snapshot | failed / `provider_unavailable` (HTTP 404) | `openrouter/free` | None returned | 1 | 1 | Unknown (`null`) | 1 (2,449) |

Each run retained its $0.03 reservation with `accountingComplete: false`.
The zero known-cost/token counters are **not** provider reports of zero usage:
no completion usage was returned. Combined actual cost remains unknown, with
$0.09 reserved. HTTP 404 establishes request unavailability, not its underlying
cause or a billable/unbillable determination; raw error bodies were not retained.
No alternative provider, model, paid fallback, additional replay, or Harbour
integration was attempted.

Exact CLI outcomes and reopened graph/audit exports are preserved under
`examples/mangodb/` as `<name>-free-router-outcome.json` and
`<name>-free-router-graph.json`; earlier artifacts remain unchanged.
**This is not the first verified live TAG model completion:** pricing preflight
is now positively verified for this route, but none of the three requests
returned a model completion.

### Provider restriction diagnosis: blocked by workspace ZDR (2026-09-14)

Before changing code, one bounded diagnostic dispatch through the unchanged
adapter reproduced HTTP 404. Its actual OpenRouter error explicitly said that
the available free-model providers were `novita`, `google-ai-studio`, `liquid`,
`nex-agi`, `poolside`, and `nvidia`, but the request's `provider.only` allowed
only `chutes`. Thus Chutes-only was a concrete exclusion, not a pricing failure.
The router's endpoint listing was empty (it is a router, not a concrete model);
the account-filtered catalogue still advertised its prompt/completion prices
as zero.

The minimal request change removes **only** the default `provider.only` for
`openrouter/free`. Explicit Chutes pins and ordinary model restrictions remain
enforced. Free-only catalogue verification, zero prompt/completion price caps,
`allow_fallbacks: false`, `require_parameters: true`, credentials, capability
boundaries and all local limits remain unchanged. The audit now records the
exact routing policy and separates requested from actually reported providers;
missing provider attribution remains null.

Unpinning did **not** obtain a completion. A second diagnostic returned 404;
a third diagnostic captured the remaining error:

> 0 endpoints out of 3 requested are available matching your guardrail
> restrictions and data policy. [...] ZDR violation (guardrail):
> 3 endpoints excluded

This is an OpenRouter workspace/account guardrail, not a TAG request setting.
TAG sends no ZDR requirement. OpenRouter documents that
[request-level ZDR cannot override account or guardrail enforcement](https://openrouter.ai/docs/guides/features/zdr#per-request-zdr-enforcement);
adding `zdr: false` would not resolve it. No account settings, keys, billing
constraints or other guardrails were changed, and no further inference was
attempted.

All three diagnostic dispatches used the same diagnostic objective and limits:
one maximum generation, $0.03, concurrency one, zero retries, 3-second minimum
spacing, 1,536 output tokens and three maximum graph nodes. Each independently
verified `known_free`, made one inference attempt/generation, stopped with
`provider_unavailable`, returned no actual model/provider or usage, and retained
its $0.03 reservation with unknown (`null`) cost. Their graph sizes were
1 node / 1,728 compact JSON bytes before unpinning, and 1 node / 1,979 bytes
for each unpinned diagnostic. Combined diagnostic cost is **unknown**, not zero.

The diagnostic messages were manually inspected for sensitive data and retained
with outcomes and reopened graphs in
`/home/runner/work/tag/tag/examples/mangodb/routing-diagnostic.json`.
Production audit behavior still excludes raw provider error bodies.

**Lifecycle, query and snapshot were not replayed in this milestone.** The
verified-completion prerequisite remains blocked; each has zero new attempts,
zero new generations, no new returned model/provider or provider-reported cost,
and no new graph/store. Their inputs, limits and prior artifacts are untouched,
with all three fixture SHA-256 hashes matching the baseline. No successful
completion is claimed and the previous HTTP 404 outcomes are not relabelled.

All **96 tests pass** (91 baseline plus five focused routing regressions):
Chutes exclusion versus an otherwise identical unpinned request; explicit
pin/ordinary-model enforcement; absent-provider attribution; immutable routing
price caps; and fail-closed workspace ZDR rejection. Existing tests also cover
pricing-state semantics, positive-cost stops, unknown costs and MangoDB audit
persistence. CodeQL found zero alerts.

**TAG has not yet achieved its first verified live completion.** An OpenRouter
administrator needs to permit non-ZDR inference for this experiment in the
[applicable guardrail](https://openrouter.ai/workspaces/default/guardrails),
without changing spending limits or other safety controls. Then a separately
authorized continuation can verify a free completion and replay the three
unchanged fixtures once each in fresh stores. No Harbour integration was added.

### Budget-reserved DeepSeek experiment (2026-09-15)

Paid eligibility and reconciliation are implemented; **the live three-fixture
milestone remains incomplete because the first request lacked reliable accounting.**
All **103 tests passed** before inference, including the three real MangoDB host
checks and focused reservation, exact-fit/rejection, current-price revocation,
usage reconciliation, overrun, unknown accounting and durable reopen tests.
CodeQL found zero alerts. The separate read-only code reviewer found no significant
issues; the automated review binary was unavailable.

The live catalogue at `2026-09-15T06:22:27.311Z` verified
`deepseek/deepseek-v4.1-flash` as `known_priced`: base/worst-case **$0.30/M input
tokens, $1.20/M output tokens**, and $0.006/M cache-read tokens. Advertised
scheduled discounts are $0.15/M input, $0.60/M output and $0.003/M cache reads.
Reservations use the maxima, not discounts. The full verified schedule is
preserved in `examples/mangodb/lifecycle-deepseek-graph.json`.

The lifecycle fixture was sent **once**, in a fresh store
`/tmp/tag-mangodb-deepseek-eoGzgD/lifecycle`, with all original limits unchanged:
$0.03 per fixture/$0.09 experiment, concurrency one, zero retries, two generations,
1536 output tokens, 3000 ms spacing and three nodes. Its exact message estimate
was **7664 input tokens + 1536 maximum output tokens**, reserving **$0.0041424**
durably before inference. No automatic backend fallback or model switch was allowed.

| Fixture | Outcome | Generations / inference attempts | Actual tokens / cost | Graph / decomposition |
| --- | --- | --- | --- | --- |
| Lifecycle | Failed: `malformed_response` | 1 / 1 | Unknown / unknown; $0.0041424 remains reserved | 1 node, 7007 compact JSON bytes; no children |
| Query | Not attempted: experiment safety stop | 0 / 0 | No request; 0 / $0 | No new graph/store |
| Snapshot | Not attempted: experiment safety stop | 0 / 0 | No request; 0 / $0 | No new graph/store |

The lifecycle response could not be read/decoded into usable provider accounting.
Its attempt lasted 30,017 ms; the sanitized failure does **not** establish the
underlying cause. Actual model/provider and input/output token counts are
**unknown**, not the requested model or zero. There is no synthesized model
result. The ledger's zero token/known-cost counters mean no validated usage was
received; `costUsd: null` and `accountingComplete: false` are authoritative.
No reservation was released. In accordance with the operator's stop condition,
**no further inference was sent**, including query and snapshot; they are not
reported as completed replays.

Independent host tests support the fixture observations: lifecycle reopened
`a.count=5`, absent `b`, one document (`test/mangodb-tasks.test.js:11–33`);
query returned exactly `b:9` then `d:7` with the requested projection (lines 35–57);
snapshot preserved the complete graph and opaque `$oid`/`$date` input with its
action still merely proposed (lines 59–86). These are host results, **not**
model findings, and do not establish general compatibility.

Exact CLI outcome and reopened graph are retained as
`examples/mangodb/lifecycle-deepseek-{outcome,graph}.json`; the consolidated
`examples/mangodb/deepseek-experiment.json` records both unattempted fixtures and
matching before/after input hashes. Earlier artifacts and objectives are untouched.
The operator-described $1/day provider key cap was neither changed nor used as
local accounting. No extra task, retry, fallback, Harbour integration, or
model-generated shell/file execution was performed.

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
