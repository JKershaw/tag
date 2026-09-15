import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { plan, researchContext } from '../adapters/plan.js';
import { openStore } from '../adapters/mango.js';
import { seed, applyProposal, buildContext, explain } from '../core/graph.js';
import { renderGraph } from '../core/render.js';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
const recorded = JSON.parse(await readFile(new URL('../examples/improve-tag.proposal.json', import.meta.url), 'utf8'));
const execute = promisify(execFile);

test('research is bounded, labelled, source-grounded and retained in planning projections', async () => {
  const context = await researchContext();
  assert.ok(context.length > 2000 && context.length <= 16000);
  for (const source of ['package.json:1-', 'bootstrap.md:1-', 'core/graph.js:96-', 'cli.js:1-']) {
    assert.ok(context.includes(source));
  }
  assert.match(context, /sha256 [a-f0-9]{64}/);
  assert.match(context, /not a full repository audit/);
  assert.match(context, /excerpt clipped/);
  const graph = seed('Improve TAG', context);
  assert.equal(buildContext(graph).node.context.length, 2000);
  const projection = buildContext(graph, 'root', { maxTextCharacters: 16000 });
  assert.equal(projection.node.context, context);
  assert.ok(JSON.stringify(projection).length <= 32000);
  assert.throws(() => buildContext(graph, 'root', { maxTextCharacters: Infinity }), /Text budget/);
});

test('fresh planning uses the real adapter and store with mocked HTTP, then stops without execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-plan-'));
  let calls = 0;
  let suppliedContext;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({
      data: [{ id: 'openrouter/free', pricing: { prompt: '0', completion: '0' } }],
    }));
    calls++;
    const request = JSON.parse(options.body);
    assert.match(request.messages[0].content, /research and decomposition ONLY/);
    assert.equal(request.max_tokens, 2048);
    suppliedContext = JSON.parse(request.messages[1].content);
    assert.equal(suppliedContext.mode, 'plan');
    assert.ok(suppliedContext.node.context.includes('core/graph.js:96-'));
    return new Response(JSON.stringify({
      model: 'test/routed-model', provider: 'Test',
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, cost: 0 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        ...recorded, revision: suppliedContext.revision,
      }) } }],
    }));
  });
  try {
    const outcome = await plan('Improve TAG', { directory, apiKey: 'test-only', model: 'openrouter/free' });
    assert.equal(outcome.status, 'planned');
    assert.equal(outcome.stoppingReason, 'plan_created');
    assert.equal(calls, 1);
    assert.equal(outcome.usage.generations, 1);
    assert.equal(outcome.usage.costUsd, 0);
    const store = await openStore(directory);
    let graph;
    try { graph = await store.load(); } finally { await store.close(); }
    assert.equal(graph.run.limits.maxGenerations, 1);
    assert.equal(graph.run.limits.maxRetries, 0);
    assert.equal(graph.nodes[0].context, suppliedContext.node.context);
    assert.equal(graph.nodes[0].status, 'ready');
    assert.equal(graph.nodes[0].result, null);
    assert.equal(graph.nodes.length, 5);
    assert.equal(graph.generation, 1);
    assert.equal(graph.run.attempts[0].status, 'applied');
    assert.equal(explain(graph, 'demonstration').prerequisites.length, 2);
    assert.match(renderGraph(graph, { html: true }), /One-shot planning/);
    await assert.rejects(plan('Improve TAG', { directory, apiKey: 'test-only', model: 'openrouter/free' }), /empty store/);
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('offline CLI demonstration persists and renders a real graph without credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-demo-cli-'));
  const store = join(directory, 'store');
  const run = (...args) => execute(process.execPath, [cli, ...args, '--store', store],
    { cwd: directory, env: { ...process.env, OPENROUTER_API_KEY: '', TAG_MODEL: 'not-a-model' } });
  try {
    assert.equal(JSON.parse((await run('demo')).stdout).status, 'replayed');
    const before = JSON.parse((await run('graph')).stdout);
    assert.equal(before.nodes[0].objective, 'Improve TAG');
    assert.equal(before.run, undefined);
    assert.equal(before.history.length, 1);
    assert.equal(before.nodes.length, 5);
    const text = (await run('view')).stdout;
    assert.match(text, /OFFLINE REPLAY/);
    assert.match(text, /demonstration \[task · ready · waiting for prerequisites\]/);
    assert.match(text, /execution-policy \[question · needs_human\]/);
    const html = (await run('view', '--html')).stdout;
    assert.match(html, /<!doctype html>/);
    assert.match(html, /href="#node-planning"/);
    assert.match(html, /Baseline core\/dispatch.js/);
    assert.deepEqual(JSON.parse((await run('graph')).stdout), before);
    await assert.rejects(run('demo'), /empty store/);
    await assert.rejects(run('plan', 'Improve TAG'), /OPENROUTER_API_KEY/);
    assert.deepEqual(JSON.parse((await run('graph')).stdout), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rendering escapes all graph text and preserves references, results, and proposed actions', () => {
  const attack = '<script>alert("x")</script><img src=x onerror=alert(1)>';
  let graph = seed(attack, attack);
  graph = applyProposal(graph, {
    protocolVersion: 1, revision: 0, nodeId: 'root', summary: attack, mutations: [
      { op: 'add', id: 'done', parentId: 'root', objective: 'Done' },
      { op: 'resolve', id: 'done', result: attack },
      { op: 'add', id: 'tool', parentId: 'root', objective: 'Tool' },
      { op: 'reference', id: 'tool', target: 'done' },
      { op: 'evidence', id: 'tool', text: attack, source: attack },
      { op: 'decision', id: 'tool', text: attack, source: attack },
      { op: 'propose', id: 'tool', tool: 'shell', input: { command: attack }, reason: attack },
    ],
  });
  const original = structuredClone(graph);
  const html = renderGraph(graph, { html: true });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /References → <a href="#node-done">done<\/a>/);
  assert.match(html, /Result/);
  assert.match(html, /actions/);
  assert.deepEqual(graph, original);
  graph.nodes[0].objective = '\x1b[31mcontrol';
  assert.ok(!renderGraph(graph).includes('\x1b'));
});
