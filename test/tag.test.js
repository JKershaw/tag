import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed, applyProposal, nextNode, explain, buildContext, humanUpdate } from '../core/graph.js';
import { iterate } from '../core/iterate.js';
import { openStore } from '../adapters/mango.js';
import { createAgent } from '../adapters/openai.js';

const proposal = (graph, mutations, nodeId = nextNode(graph)?.id) => ({
  protocolVersion: 1, revision: graph.revision, nodeId, summary: 'One bounded step', mutations,
});
const add = (id, parentId = 'root') => ({ op: 'add', id, parentId, objective: id });
const resolve = id => ({ op: 'resolve', id, result: `Completed ${id}` });

test('dependency scheduling and explicit upward synthesis', () => {
  let graph = seed('Build feature');
  graph = applyProposal(graph, proposal(graph, [add('design'), add('code'), { op: 'depend', id: 'code', on: 'design' }]));
  assert.equal(nextNode(graph).id, 'design');
  graph = applyProposal(graph, proposal(graph, [resolve('design')]));
  assert.equal(nextNode(graph).id, 'code');
  graph = applyProposal(graph, proposal(graph, [resolve('code')]));
  assert.equal(nextNode(graph).id, 'root');
  assert.equal(graph.nodes[0].status, 'ready');
  graph = applyProposal(graph, proposal(graph, [resolve('root')]));
  assert.equal(nextNode(graph), null);
  assert.equal(graph.generation, 4);
});

test('invalid mutations are atomic and reject stale, out-of-scope and cyclic proposals', () => {
  const graph = seed('Build');
  for (const mutations of [
    [add('child'), { op: 'depend', id: 'child', on: 'root' }],
    [add('child'), { op: 'depend', id: 'child', on: 'missing' }],
    [add('child'), add('child')],
    [add('child'), resolve('root')],
    [{ op: '__proto__', id: 'root' }],
    [{ op: 'evidence', id: 'root', text: 'test', source: 'test', extra: true }],
  ]) assert.throws(() => applyProposal(graph, proposal(graph, mutations)));
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.history.length, 0);
  assert.throws(() => applyProposal(graph, { ...proposal(graph, [resolve('root')]), revision: 5 }), /Stale/);
  const expanded = applyProposal(graph, proposal(graph, [add('a'), add('b')]));
  assert.throws(() => applyProposal(expanded, proposal(expanded, [resolve('b')], 'a')), /outside/);
});

test('information gaps block dependent work but not independent branches', () => {
  let graph = seed('Build');
  graph = applyProposal(graph, proposal(graph, [
    { ...add('question'), type: 'question' }, add('dependent'), add('independent'),
    { op: 'block', id: 'question', reason: 'Need human policy', human: true },
    { op: 'depend', id: 'dependent', on: 'question' },
  ]));
  assert.equal(nextNode(graph).id, 'independent');
  graph = humanUpdate(graph, 'question', 'Use policy A', true);
  assert.equal(nextNode(graph).id, 'dependent');
  assert.equal(graph.generation, 1);
  assert.equal(graph.revision, 2);
});

test('frontier explanations distinguish human blocks, waiting children and failed prerequisites', () => {
  let graph = seed('Build');
  graph = applyProposal(graph, proposal(graph, [
    add('a'), add('b'), add('human'),
    { op: 'depend', id: 'b', on: 'a' },
    { op: 'block', id: 'human', human: true, reason: 'Need a decision' },
  ]));
  assert.equal(explain(graph, 'a').runnable, true);
  assert.deepEqual(explain(graph, 'b').prerequisites, [{ id: 'a', status: 'ready' }]);
  assert.equal(explain(graph, 'human').reason, 'Need a decision');
  assert.equal(explain(graph, 'root').children.length, 3);
  graph = applyProposal(graph, proposal(graph, [{ ...resolve('a'), status: 'failed' }], 'a'));
  assert.deepEqual(explain(graph, 'b').prerequisites, [{ id: 'a', status: 'failed' }]);
  assert.equal(explain(graph, 'a').terminal, true);
  assert.equal(explain(graph, 'root').children.length, 2);
  assert.equal(nextNode(graph), null);
  assert.throws(() => explain(graph, 'missing'), /Unknown/);
});

test('context is graph-derived, detached and excludes invocation history', () => {
  let graph = seed('Build', 'Seed material');
  graph = applyProposal(graph, proposal(graph, [add('a'), add('b')]));
  const context = buildContext(graph, 'a');
  assert.deepEqual(context.related.map(node => node.id), ['root', 'b']);
  assert.equal(context.history, undefined);
  context.node.objective = 'changed';
  assert.equal(graph.nodes[1].objective, 'a');
});

test('large context is bounded with explicit omissions and full durable evidence retained', () => {
  let graph = seed('Build', 'S'.repeat(100000));
  graph = applyProposal(graph, proposal(graph, [
    add('child'),
    ...Array.from({ length: 20 }, (_, index) => ({
      op: 'evidence', id: 'child', text: `${index}: ${'E'.repeat(10000)}`, source: 'test',
    })),
  ]));
  const context = buildContext(graph, 'child', { maxCharacters: 8000 });
  assert.ok(JSON.stringify(context).length <= 8000);
  assert.ok(context.node.omitted.evidence.items > 0);
  assert.ok(context.related[0].omitted.context.characters > 0);
  assert.equal(graph.nodes[0].context.length, 100000);
  assert.equal(graph.nodes[1].evidence.length, 20);
  assert.ok(context.node.evidence.at(-1).text.startsWith('19:'));
  assert.deepEqual(buildContext(graph, 'child', { maxCharacters: 8000 }), context);
  assert.throws(() => buildContext(graph, 'child', { maxCharacters: 1 }), /budget/);
});

test('wide context reports omitted neighbours without including invocation history', () => {
  const graph = applyProposal(seed('Build'), proposal(seed('Build'), Array.from({ length: 50 }, (_, i) => add(`child-${i}`))));
  const context = buildContext(graph, 'root');
  assert.equal(context.related.length, 32);
  assert.equal(context.projection.omittedRelated, 18);
  assert.equal(context.node.objective, 'Build');
  assert.equal(context.history, undefined);
});

test('tool requests stop for explicit approval rather than execute code', () => {
  let graph = seed('Build');
  graph = applyProposal(graph, proposal(graph, [
    { op: 'propose', id: 'root', tool: 'shell.exec', input: { command: 'npm test' }, reason: 'Host must run tests' },
  ]));
  assert.equal(nextNode(graph), null);
  assert.equal(graph.nodes[0].actions[0].status, 'proposed');
  graph = humanUpdate(graph, 'root', 'Host ran npm test: passed');
  assert.equal(nextNode(graph).id, 'root');
});

test('partial child results require parent synthesis, not automatic success', () => {
  let graph = seed('Build');
  graph = applyProposal(graph, proposal(graph, [add('child')]));
  graph = applyProposal(graph, proposal(graph, [{ ...resolve('child'), status: 'failed' }]));
  assert.equal(nextNode(graph).id, 'root');
  assert.throws(() => applyProposal(graph, proposal(graph, [resolve('root')])), /unresolved children/);
  graph = applyProposal(graph, proposal(graph, [{ ...resolve('root'), status: 'partially_resolved' }]));
  assert.equal(nextNode(graph), null);
});

test('real MangoDB survives close/reopen, locks stores and checks revisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-store-'));
  let store;
  try {
    store = await openStore(directory);
    await assert.rejects(openStore(directory), /locked/);
    const graph = seed('Persist');
    await store.save(graph);
    const updated = applyProposal(graph, proposal(graph, [resolve('root')]));
    await store.save(updated, graph.revision);
    await assert.rejects(store.save(updated, graph.revision), /Stale/);
    await store.close();
    store = await openStore(directory);
    assert.deepEqual(await store.load(), updated);
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('iterate obeys its budget, stops on exhaustion and journals rejected calls', async () => {
  let state = seed('Build');
  const store = { load: async () => structuredClone(state), save: async value => { state = value; } };
  let calls = 0;
  const agent = async context => {
    calls++;
    return proposal(state, [{ op: 'evidence', id: context.nodeId, text: `Observation ${calls}`, source: 'test' }]);
  };
  const result = await iterate({ store, agent, count: 2 });
  assert.equal(result.stop, 'generation_limit');
  assert.equal(calls, 2);
  assert.equal(state.generation, 2);
  await assert.rejects(iterate({ store, agent, count: 31 }), /count/);
  const failed = await iterate({ store, agent: async () => ({ wrong: true }), count: 2 });
  assert.equal(failed.stop, 'agent_error');
  assert.equal(state.generation, 3);
  assert.equal(state.history.at(-1).outcome, 'rejected');
  await iterate({ store, agent: async () => proposal(state, [resolve('root')]), count: 1 });
  assert.equal((await iterate({ store, agent, count: 30 })).stop, 'no_runnable_nodes');
});

test('OpenAI-compatible adapter sends fresh graph context and hides HTTP error bodies', async () => {
  let request;
  const agent = createAgent({
    endpoint: 'https://example.test/chat/completions', model: 'test', instructions: 'One step',
    fetchImpl: async (url, options) => {
      request = options;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"test":true}' } }] }) };
    },
  });
  assert.deepEqual(await agent({ nodeId: 'root' }), { test: true });
  assert.equal(JSON.parse(request.body).messages.length, 2);
  assert.equal(request.redirect, 'error');
  assert.throws(() => createAgent({ endpoint: 'http://remote.test', model: 'x' }), /HTTPS/);
  const failing = createAgent({
    endpoint: 'http://localhost:8080', model: 'test', instructions: '',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  await assert.rejects(failing({}), /HTTP 401/);
});

test('CLI resumes an exported graph and explains the persisted frontier', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-cli-'));
  const execute = promisify(execFile);
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const run = async (...args) => {
    const { stdout } = await execute(process.execPath, [cli, ...args, '--store', join(directory, 'store')], { cwd: directory });
    return JSON.parse(stdout);
  };
  try {
    const graph = applyProposal(seed('Build'), proposal(seed('Build'), [
      add('question'), { op: 'block', id: 'question', human: true, reason: 'Need policy' },
    ]));
    const snapshot = join(directory, 'snapshot.json');
    await writeFile(snapshot, JSON.stringify(graph));
    await run('init', '--from', snapshot);
    const status = await run('status');
    assert.equal(status.next, null);
    assert.deepEqual(status.waiting.find(node => node.id === 'root').children, [{ id: 'question', status: 'needs_human' }]);
    assert.equal((await run('explain', 'question')).reason, 'Need policy');
    assert.deepEqual(await run('graph'), graph);
    await assert.rejects(run('init'), /already initialized/);
    await assert.rejects(run('explain', 'missing'), /Unknown node/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
