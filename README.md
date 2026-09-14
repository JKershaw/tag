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

## Model-driven iterations

Set `TAG_ENDPOINT` to an **explicitly trusted full chat-completions URL** and
`TAG_MODEL` to the provider's model name. Supply `TAG_API_KEY` through your
environment if required; never put credentials in graph state. Then:

```sh
node cli.js iterate --count 10
node cli.js history
node cli.js inspect root
```

Each invocation sends only the current graph projection and bootstrap
instructions. Configuring an endpoint authorizes sending the projected graph
(including seed material and evidence) there. HTTPS is required except on
localhost; redirects are rejected. No default provider is contacted.

`iterate` makes at most 1–30 calls per command, persists each transition, and
stops early when no node is runnable or a call/proposal fails. Failed calls
are counted and audited without applying mutations. Inspect the error before
explicitly retrying. `apply` is one externally driven generation.

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

`core/graph.js`, `core/protocol.js`, and `core/iterate.js` use ordinary modern
ECMAScript without Node imports. A store supplies asynchronous `load()` and
`save(state, expectedRevision)` methods; an agent is an asynchronous function
from graph context to a proposal. Node filesystem/MangoDB and HTTP integration
live in `adapters/`; the CLI uses Node's built-in argument parser.

This is deliberately a single-writer, small-graph prototype. All CLI commands
take an exclusive store lock; after a crash, remove `writer.lock` **only after
confirming the owning process has stopped**. Await all store operations before
closing. MangoDB rewrites the snapshot with a temporary-file rename; there
are no cross-process database transactions or power-loss durability guarantees.
Back up the closed directory. External code/tool effects and graph commits
are not atomic; verify actual effects before retrying after a crash.

Tests use built-in `node:test`, including real MangoDB reopen/locking checks.
There are no separate lint or build tools.
