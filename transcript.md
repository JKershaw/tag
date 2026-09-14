# TAG — Session Transcript

Source session: https://chatgpt.com/share/6aa833ef-fd04-83eb-890c-5426502fd165?ogimg=plain

This transcript contains the substantive user/assistant discussion that led to the idea for TAG:
**Tiny Agent Node Graph & Lightweight Executor**.

---

## User

Ok, so I imagine a task as a node in a graph. An llm takes a node, and can create subnodes/branch. 

Basically, given a task it breaks it down in a tree structure until the node is a code change. Then it can take the nodes and tree and walk it back up until the task has a solution in whatever resolution was reached until there was an information gap.

Each node and llm with basic harness.

Some nodes "block" others, forcing an order where needed.

## Assistant

Yes. I think this gives you a much cleaner primitive than “agent runs a task”.

The core object becomes a **node**, and the LLM is essentially a transformation engine that moves nodes through different levels of resolution.

Conceptually:

```text
                    [ Build authentication ]
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
      [ Understand auth flow ]        [ Add password reset ]
              │                               │
         information                         ▼
            gap                    [ Add reset endpoint ]
                                            │
                                   ┌────────┴────────┐
                                   ▼                 ▼
                            [ Create token ]   [ Send email ]
                                   │                 │
                                   ▼                 ▼
                              code change       code change
```

Then the interesting bit is that execution works in **both directions**.

### Downward: decomposition

An LLM receives:

```text
node
+ ancestors
+ relevant siblings
+ project context
+ available tools
```

and decides something like:

```text
SOLVE directly
DECOMPOSE into children
REQUEST information
BLOCK on another node
FAIL / abandon
```

So:

```text
TASK
 ↓
SUBTASK
 ↓
SUBTASK
 ↓
CODE CHANGE
```

You don't actually need to prescribe how deep the tree is. The agent keeps increasing resolution until it reaches something it can confidently execute.

### Upward: synthesis

Once leaves resolve, their results propagate upwards.

```text
code change ✓
     ↓
implementation task ✓
     ↓
feature task ✓
     ↓
original task ✓
```

But importantly, a parent doesn't necessarily become simply `done`.

It might become:

```text
resolved
partially_resolved
blocked
needs_human
needs_information
failed
```

So the result of a tree might naturally be:

> We implemented the API and UI, but cannot complete the Stripe integration because the account credentials aren't available.

That's a perfectly valid resolution of the root node. The graph has discovered the boundary of what is currently knowable/doable.

## And I wouldn't quite call it a tree

Once you introduce:

> Some nodes block other nodes.

you've basically got a **DAG**.

For example:

```text
                 [ Implement checkout ]
                    /           \
                   /             \
                  ▼               ▼
        [ Build API ]       [ Build UI ]
                  │               │
                  └──────┐  ┌─────┘
                         ▼  ▼
                    [ Integration ]
```

Or more explicitly:

```text
[Design schema] ───────▶ [Implement API]
      │
      └───────────────▶ [Implement migration]

[Implement API] ───────▶ [Integration test]
[Implement migration] ─▶ [Integration test]
```

The hierarchy answers:

> **Why does this node exist?**

Dependencies answer:

> **When can this node run?**

That's a very useful separation.

I would therefore make these two edge types first-class:

```text
parent → child
node   → blocked_by
```

rather than trying to encode ordering into the hierarchy.

## The node can be surprisingly small

Something roughly like:

```js
{
  id,
  parentId,

  objective,
  context,

  status,
  resolution,

  blockedBy: [],

  children: [],

  attempts: []
}
```

With perhaps one especially important field:

```js
resolutionLevel
```

Something like:

```text
intent
plan
task
implementation
code_change
verification
```

Though I'd be tempted **not** to make those rigid types initially. Let the graph emerge rather than forcing every problem through the same ontology.

The harness around each node can then be extremely small:

```text
1. Gather node context
2. Gather relevant graph context
3. Ask model for next action
4. Execute tools if required
5. Record result
6. Mutate graph
7. Find newly-runnable nodes
```

And repeat.

## There's a really nice scheduler hiding in this

At any moment the graph has a **frontier**:

```text
              resolved
                 │
        ┌────────┴─────────┐
        ▼                  ▼
    runnable           runnable
        │                  │
        ▼                  ▼
     agent A            agent B

             blocked
                │
                ▼
          waiting for A
```

So rather than an agent being responsible for recursively doing everything, the orchestration system can continually ask:

> Which unresolved nodes have all their dependencies satisfied?

Those are runnable.

That immediately gives you:

- parallelism
- bounded concurrency
- model selection per node
- retries per node
- human intervention per node
- cost accounting per node
- provenance
- resumability
- delegation across different harnesses

And it avoids requiring a single giant agent context.

## The particularly powerful bit is that nodes don't have to mean “work”

A node could represent:

```text
Implement feature
Investigate behaviour
Answer question
Make decision
Acquire information
Modify code
Run test
Verify assumption
Ask human
```

For example:

```text
[Fix login bug]
       │
       ▼
[Determine why token expires]
       │
       ├──▶ [Inspect auth middleware]
       │
       └──▶ [What is intended expiry time?]
                         │
                         ▼
                    HUMAN BLOCK
```

Meanwhile the rest of the graph can continue wherever it isn't dependent on that answer.

That means **uncertainty itself becomes graph structure** rather than something buried in an agent's context window.

I think that's an unusually important property.

## It also gives Harbour a wonderfully simple conceptual model

You could almost reduce the whole system to:

> **Harbour maintains a graph of things that need resolving. Agents increase the resolution of nodes until they can resolve them, discover dependencies, or reach an information boundary. Resolutions propagate back through the graph.**

And then Autopilot isn't really a special complicated thing anymore.

It's essentially:

```text
while root unresolved:
    find runnable frontier
    dispatch nodes
    incorporate results
    expand graph
    propagate resolutions
```

with human/cost/time/token policies governing the loop.

That feels significantly more fundamental than the prompt-template orchestration model we've been discussing. Prompt types could become **strategies available to a node**, rather than the organising principle of Harbour itself.

---

## User

It would effectively be an agent harness, but it's context isn't a simple long string. It's nodes.

## Assistant

Exactly. That’s the more interesting abstraction.

The harness still looks like an agent harness, but instead of:

```text
system prompt
+ conversation history
+ files
+ previous tool output
= context window
```

you have something closer to:

```text
current node
+ ancestors
+ relevant descendants
+ dependencies
+ blockers
+ sibling outcomes
+ linked evidence
+ project/global nodes
= context projection
```

So the agent's "context" is not really stored as a transcript. It's **computed from the graph for each invocation**.

That changes quite a lot.

A node might be:

```js
{
  id: "implement-reset-token",

  objective: "Implement password reset token generation",

  parent: "password-reset",
  blockedBy: ["choose-token-policy"],

  evidence: [
    "auth-schema",
    "existing-token-implementation"
  ],

  children: [],

  state: "ready",

  result: null
}
```

When an LLM operates on it, the harness doesn't just dump every node into the prompt. It performs a **context query**:

```text
Give me:

- this node
- its purpose
- relevant ancestor decisions
- resolved dependencies
- relevant code/evidence nodes
- neighbouring work likely to affect it
```

and builds a temporary working context.

So the graph becomes something like **external structured memory**, while the model's context window becomes a cache or working set.

That is quite different from conventional agents.

## Context becomes a function

You could almost formalise it as:

```text
Context(node, graph, policy) → working context
```

Where `policy` might determine:

- maximum tokens
- traversal depth
- relevance threshold
- whether unresolved siblings are included
- how much ancestor history matters
- whether raw evidence or summaries are preferred

Then different agents could look at the *same node* with different projections.

For example, a coding agent might receive:

```text
node
parent requirement
resolved architecture decisions
affected files
tests
blocking dependencies
```

Whereas a review agent gets:

```text
node
original objective
implemented result
sibling results
acceptance criteria
diff
tests
```

Same graph. Different context lens.

## It also fixes one of the nastiest agent problems

Long-running agents usually accumulate state like this:

```text
turn 1
turn 2
turn 3
tool output
turn 4
summary
turn 5
tool output
...
```

Eventually the model has to infer:

> Which of these 80,000 tokens still matter?

Your version moves that responsibility out of the LLM.

The harness already knows:

```text
this decision superseded that one
this investigation resolved this uncertainty
this task depends on these two results
this file is relevant to these nodes
this branch failed
```

So instead of endlessly compressing a conversation, you're **maintaining structured state**.

That feels like a much better substrate for persistent agents.

## And nodes can carry provenance

I'd make this a core property.

A resolution shouldn't just be:

```text
"use JWT"
```

It should be something like:

```js
{
  conclusion: "Use signed 15-minute JWT reset tokens",
  derivedFrom: [
    "security-requirements",
    "existing-auth-library",
    "investigation-349"
  ],
  producedBy: "decision-351",
  confidence: 0.91
}
```

Then an agent can traverse *why* something is believed rather than merely inheriting a textual summary.

That gives you something conventional chat history is very poor at:

```text
What do we know?
Why do we know it?
What depends on it?
What would become invalid if it changed?
```

## Which suggests the node itself may be the agent's unit of cognition

Rather than thinking:

> "An agent has memory."

you can think:

> **"The graph has memory; an agent temporarily inhabits a node."**

It receives the relevant portion of the graph, reasons, uses tools, and leaves behind graph mutations:

```text
new child
new dependency
new evidence
new decision
new result
new blocker
node resolved
```

Then it disappears.

Another model — even a completely different provider — can pick up the node later without needing the previous agent's internal conversation.

That is very attractive for Harbour because it makes agents fundamentally disposable.

## The graph can also contain different kinds of context

You may eventually find that you don't even need a sharp divide between "task" and "memory".

For example:

```text
TASK
"Implement password reset"

DECISION
"Use existing email provider"

FACT
"Users authenticate via email"

QUESTION
"What expiry period should reset links use?"

EVIDENCE
"src/auth/token.js"

RESULT
"Reset endpoint implemented"

CONSTRAINT
"Do not change the users table"
```

All of those can just be nodes with typed relationships.

Then:

```text
TASK ─requires────▶ DECISION
TASK ─uses────────▶ FACT
TASK ─reads───────▶ EVIDENCE
QUESTION ─blocks──▶ TASK
RESULT ─resolves──▶ TASK
```

At that point you've moved from **task graph** toward a **reasoning graph**.

And I think that distinction matters: the task tree may be the initial visible metaphor, but underneath, what you're really constructing is a structured model of the agent's understanding of the project.

The bit I'd concentrate on next is therefore not the agent loop itself. That's relatively straightforward.

It's **the context-selection algorithm**: given one node and a large graph, what is the smallest useful subgraph to hand to the model?

If that works well, the rest of this architecture becomes surprisingly elegant.

---

## User

Let's do a literature study to see how much of this idea has already been explored.

## Assistant

Yes. I did a first-pass literature study across both classical AI and modern LLM-agent work. The result is interesting: **almost every individual component of the idea has substantial precedent, but I did not find a well-established architecture that combines them in quite the way we're describing.**

The closest description of the gap is:

> **A persistent, dynamically expanding problem graph in which nodes are both units of work and units of context, LLM invocations operate locally over graph-derived context, dependencies determine execution order, information gaps become explicit nodes, and completed leaves are progressively synthesized upward into resolutions of their ancestors.**

That exact combination seems much less explored than I expected.

### Main related areas identified

- **AND/OR graphs** — decomposition into required or alternative subproblems.
- **Hierarchical Task Networks (HTNs)** — recursive task decomposition until executable actions.
- **Soar** — impasses create substates/subgoals to resolve missing knowledge.
- **Blackboard systems** — shared structured problem-solving state.
- **Tree of Thoughts / Graph of Thoughts** — graph/tree reasoning during LLM inference.
- **RAP / LATS** — LLM reasoning as search/planning.
- **MemGPT** — external persistent memory with context as a working set.
- **A-MEM** — graph-shaped persistent agent memory.
- **GraphRAG / HippoRAG** — graph-derived context retrieval.
- **Context Graphs** — live relational state for agents.
- **AFlow** — graph-based LLM workflows.
- **CodePlan** — dynamic plan graph for repository-level coding.
- **Truth Maintenance Systems** — explicit justifications and invalidation of dependent beliefs.

The central distinction that emerged was:

> **Move the agent's state out of the context window and into a persistent semantic problem graph.**

Then make an LLM invocation approximately stateless:

```text
(node, graph projection, tools)
            ↓
           LLM
            ↓
graph mutations + world mutations
```

The graph becomes the persistent agent; individual LLM invocations become disposable workers operating on graph state.

The research opportunity appears to lie less in any individual ingredient and more in the combination:

- persistent semantic task/problem graph
- dynamic LLM decomposition
- dependency-aware execution
- graph-derived context
- explicit information boundaries
- upward synthesis
- provenance
- resumability across model instances

A useful framing was:

> **Can long-horizon LLM agents perform better when their persistent cognitive state is represented as a dynamically generated problem graph, rather than as accumulated conversational context?**

---

## User

Or, we could dogfood. We put a .md copy of this session's transcript in, with an instruction to iterate x times/run for x many generations.

## Assistant

Yes — and that is probably a better experiment than designing too much architecture first.

Take this conversation as the **root problem state**, rather than writing a bespoke benchmark. Give the prototype the transcript plus a deliberately minimal instruction.

For example:

```text
You are operating on a problem represented as a graph of nodes.

The attached transcript describes the problem and current thinking.

Your job is to advance the problem.

For the current node, you may:
- resolve it
- decompose it into child nodes
- create a dependency
- identify an information gap
- create a question requiring human input
- attach evidence or a conclusion
- mark it blocked

Operate only on the context supplied by the harness.

Continue until no runnable nodes remain or the generation limit is reached.
```

Then set, say:

```text
generations = 50
max_concurrency = 3
```

The important thing is **not to tell it how to research/design the graph architecture** beyond that. Otherwise we'd mostly be testing our prompt.

Start with one node:

```text
ROOT
│
└── "Investigate and develop the graph-native agent
     architecture described in transcript.md"
```

The strongest dogfood test is:

> **Do not give later generations the previous generation transcripts.**

Give them only the graph projection their node requires.

If they can continue coherently, the central hypothesis has been demonstrated.

An even stronger experiment would deliberately swap models during the run. If the architecture works, model continuity should matter much less because continuity belongs to the graph rather than the model session.

Keep individual model invocations as an audit log, but don't make them normal context.

After a run, give a fresh model only the resulting graph and ask:

> What is the current understanding of this project, what has been established, what remains uncertain, and what should happen next?

Compare that with a model receiving the full multi-generation transcript.

The root task can effectively be:

> Work out whether this architecture is a good idea.

So if the experiment works, the architecture will have researched, specified and potentially implemented **itself**.

---

## User

Would you recommend I start with this session's transcript as the most minimalist kickoff? There's something pleasant about the idea. But, a more formal document covering everything may be smarter. And should the "iterate" command be well specified... and should we outline an architecture so it can run effectively as code asap, a coding agent's tool to control, observe, built itself etc.

## Assistant

I’d start with **this session transcript plus a very small bootstrap spec**.

The transcript has a useful property that a formal design doc would partly destroy: it contains the *evolution of the idea*, including uncertainty, distinctions we discovered, and the reasons behind them. That makes it a good seed for testing whether the graph can recover and refine understanding from messy human context.

But I would not use the transcript alone. I’d pair it with a tiny, explicit contract that defines what “iterate” means and what mutations are allowed. Otherwise you risk testing prompt interpretation rather than the architecture.

A good minimalist kickoff would be three files:

```text
/transcript.md
/bootstrap.md
/state.json
```

Where `transcript.md` is just this conversation, and `bootstrap.md` says roughly:

```text
You are operating a persistent problem graph.

The graph is the source of durable state.
Do not rely on previous model conversations.

For the current runnable node, you may:
- resolve it
- decompose it
- add/remove dependencies
- create an information-gap node
- attach evidence
- record a decision
- mark it blocked
- propose code/tool actions

Each iteration must:
1. inspect the current node and supplied graph context
2. choose one bounded next action
3. perform that action
4. emit structured graph mutations
5. stop

Never continue implicitly into another iteration.
```

That last line matters a lot.

I would make **`iterate` extremely well specified**. Not intellectually elaborate, but operationally precise.

Something like:

```text
iterate --count 20
```

should mean:

```text
repeat up to 20 times:
    select next runnable node
    construct context projection
    invoke model
    validate proposed mutations
    apply mutations
    execute permitted tool actions
    persist state
    stop early if no runnable nodes remain
```

I’d avoid “keep working for 20 generations” as the core semantic, because it leaves too much ambiguity around whether one model call may recurse internally.

You want **one invocation = one graph transition** as much as practical.

For the architecture, define only the minimum executable boundary:

```text
GraphStore
Scheduler
ContextBuilder
AgentRunner
ToolRunner
```

With a loop like:

```js
while (iterationsRemaining) {
  const node = scheduler.next(graph);

  if (!node) break;

  const context = contextBuilder.forNode(node, graph);

  const proposal = await agentRunner.run({
    node,
    context,
    tools
  });

  const validated = validate(proposal);

  const effects = await toolRunner.execute(validated.actions);

  graph.apply(validated.mutations, effects);

  await graphStore.save(graph);
}
```

The coding agent should be able to inspect and control this machinery itself.

Useful early tools:

```text
graph.list
graph.get
graph.addNode
graph.updateNode
graph.addEdge
graph.resolve
graph.block
graph.explain

run.iterate
run.status
run.history

fs.read
fs.write
shell.exec
test.run
```

A useful constraint from day one:

> **The agent may modify the harness code, but not silently modify the rules governing graph mutation or validation.**

Those should be explicit protocol files or schemas.

For example:

```text
/protocol/
  node.schema.json
  mutation.schema.json
  iteration.md
```

The first experiment can remain pleasantly small:

```text
Seed:
this transcript

Root:
"Turn the ideas in this transcript into a working minimal graph-native coding agent."

Budget:
30–50 iterations

Model:
one strong model initially

Goal:
produce and improve its own harness until it can use the harness to work on itself
```

So the recommendation is:

> **messy transcript as semantic seed + tiny formal protocol as execution seed.**

---

## User

I'd like the code to be fairly minimalistic by design; node, MangoDB (a file based Mongo, another pet project), sensible dependencies, etc. then it can run anywhere JavaScript can run.

## Assistant

Yes. I think that constraint improves the design.

I’d make “can run anywhere JavaScript can run” a first-class architectural rule, which means the core should be almost boring:

```text
Node
Graph
Store
Scheduler
Harness
```

with MangoDB as the default persistence layer, but behind a tiny interface so the graph logic never depends on filesystem details.

Something like:

```js
class Store {
  async getNode(id) {}
  async putNode(node) {}
  async findNodes(query) {}
  async putEdge(edge) {}
  async findEdges(query) {}
}
```

Then MangoDB implements that, but the harness only knows about `Store`.

That gives you a very small centre:

```js
const node = await scheduler.next(store)
const context = await buildContext(node, store)
const result = await runAgent(node, context)
await applyMutations(result, store)
```

Everything else can remain optional.

I’d also resist introducing a heavy graph library. The graph is probably simple enough to model as documents:

```js
{
  _id: "node-123",
  type: "task",
  objective: "Implement password reset",
  status: "ready",
  parentId: "node-1",
  blockedBy: ["node-99"],
  result: null,
  metadata: {}
}
```

and perhaps edges only where the relationship is richer than `parentId` / `blockedBy`.

A useful rule:

> If a relationship can be represented locally on the node, do that. Introduce explicit edge documents only when you need richer semantics.

So v1 might only need:

```text
parentId
blockedBy[]
references[]
```

rather than a general graph database abstraction.

Keep the dependency list deliberately small too:

```text
runtime: Node.js initially
storage: MangoDB
validation: maybe Zod or JSON Schema
LLM: native fetch
CLI: native process.argv
tests: node:test
```

Potentially **zero runtime dependencies apart from MangoDB**.

To avoid accidental Node lock-in, isolate platform-specific pieces:

```text
/core
  node.js
  graph.js
  scheduler.js
  context.js
  iterate.js

/adapters
  mango.js
  openai.js
  anthropic.js
  shell.js
```

The core should ideally use only ordinary ECMAScript.

Then an agent harness becomes almost a composition:

```js
const harness = createHarness({
  store: mango,
  model,
  tools
})

await harness.iterate()
```

The entire agent's durable mind could literally just be a directory containing small documents.

For example:

```text
.agent/
  nodes/
  edges/
  runs/
  evidence/
```

No service. No daemon. No infrastructure.

Copy the directory and you've copied the agent's state.

Avoid initially:

- vector database
- workflow engine
- message bus
- agent framework
- graph database
- distributed scheduler
- embeddings
- elaborate ontology
- generic plugin system

For v0, context could simply be:

```text
current node
+ ancestors to root
+ resolved blockers
+ direct children
+ explicitly referenced nodes
+ transcript.md
```

The architecture should ideally be understandable by reading **five or six small JS files**.

If the concept is strong, it shouldn't need much machinery around it.

---

## User

Would you like to name the project?

## Assistant

Yes. **Arbor**.

It feels right for what we've arrived at:

- The task begins as a root.
- It branches as understanding develops.
- Leaves are where concrete work happens.
- Results flow back through the structure.
- Some branches stop growing because the environment can't support them yet.
- The persistent structure matters more than any individual agent working on it.

And technically, *arbor* means a tree/tree-like structure, while the implementation can quietly be a DAG rather than pretending everything is strictly hierarchical.

It also sits nicely alongside **Harbour** without sounding like a Harbour sub-feature:

> Harbour orchestrates work.  
> Arbor grows solutions.

I'd call the repository simply:

```text
arbor
```

and the first command:

```bash
arbor iterate 50
```

There is something rather satisfying about giving Arbor this transcript and essentially saying **"grow."**

A few runners-up I like are **Grove**, **Bough**, **Ramify**, and **Trellis**.

But **Arbor** is the one I'd pick.

---

## User

I feel like that might get confused with Harbour, with the u. Are there any simpler/friendlier suggestions?

## Assistant

Agreed. **Harbour / Arbor** is exactly the kind of pair that seems charming until you're saying them aloud or typing repo names all day.

I’d lean toward names that describe the *behaviour* without sounding technical.

A few I particularly like:

- **Twig** — probably my favourite. Tiny, friendly, graph/tree association, and fits the deliberately minimal implementation.
- **Sprout** — the initial node grows into whatever structure is necessary.
- **Branch** — extremely clear and wonderfully literal.
- **Grove** — calm and memorable.
- **Bud** — charmingly minimal: a node contains the potential to expand or resolve.
- **Nod** — derived loosely from *node*.
- **Grow** — a verb-first project name.
- **Seed** — `transcript.md` is quite literally the seed from which the solution graph develops.

**Twig** keeps jumping out at me.

There’s a pleasing correspondence:

```text
twig/
  node.js
  graph.js
  context.js
  iterate.js
```

```bash
twig iterate 50
twig status
twig inspect <node>
```

And the philosophy almost writes itself:

> **Twig is a tiny agent harness where context grows as a graph, not a conversation.**

---

## User

"tiny agent graph harness" is cute, I wonder if there's a nice acronym

## Assistant

**TAG**.

**T**iny **A**gent **G**raph.

I like it more than trying to force “harness” into the acronym. It is short, friendly, technical without sounding like an AI product.

```bash
tag iterate 50
tag status
tag inspect <node>
tag graph
```

And the description remains:

> **TAG is a tiny agent graph harness.**

A few other constructions work, but feel more forced:

- **TANG** — Tiny Agent Node Graph
- **TANGLE** — Tiny Agent Node Graph + Lightweight Execution
- **NAG** — Node Agent Graph
- **TIG** — Tiny Intelligence Graph

But for the philosophy we've been converging on — *as little machinery as possible* — I’d choose **TAG**.

`tag iterate 50` feels exactly like the program we're describing.

---

## User

I like Tag, with the tagline Tiny Agent Node Graph & Lightweight Executor. What license would you like?

## Assistant

I have an opinionated answer for TAG.

I’d pick a **very permissive licence**. The project feels like a small primitive intended to be embedded, forked, experimented with, and run almost anywhere.

My preference would be **MIT-0** for maximum frictionlessness, with **Blue Oak Model License 1.0.0** as an attractive modern alternative because of its clearer language and explicit patent grant.

The philosophy should remain separate from the licence itself.

A small project-level statement could be:

```text
TAG — Tiny Agent Node Graph & Lightweight Executor

Small enough to understand in an afternoon.
Portable enough to run anywhere JavaScript runs.
State lives in the graph, not the conversation.
```

A pleasant bootstrap layout might eventually look like:

```text
tag.md          # Seed + protocol
transcript.md   # Human conversation
graph/          # MangoDB documents
```

with the first command:

```bash
tag iterate
```

The seed provides the initial understanding; the graph becomes the durable state.

