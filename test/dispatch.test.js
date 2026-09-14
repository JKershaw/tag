import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dispatchRun, executionLimits } from '../core/dispatch.js';
import { createProvider, allowedModels, allowedProviders } from '../adapters/openrouter.js';
import { openStore } from '../adapters/mango.js';
import { dispatch } from '../adapters/dispatch.js';

const model = allowedModels[0];
const provider = allowedProviders[0];
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const proposal = (context, mutations = [{ op: 'resolve', id: context.nodeId, result: 'The answer is 42.' }]) => ({
  protocolVersion: 1, revision: context.revision, nodeId: context.nodeId, summary: 'One bounded action', mutations,
});
const completion = (context, mutations) => ({
  model, provider, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0 },
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal(context, mutations)) } }],
});
const catalog = { data: [{ id: model, pricing: { prompt: '0', completion: '0', request: '0' } }] };

function harness(handler = context => response(completion(context)), limits = {}) {
  let graph = null;
  let calls = 0;
  let clock = 0;
  const waits = [];
  const requests = [];
  const store = {
    load: async () => structuredClone(graph),
    save: async (value, expected = null) => {
      assert.equal(graph?.revision ?? null, expected);
      if (graph) assert.equal(value.revision, graph.revision + 1);
      graph = structuredClone(value);
    },
  };
  const agent = createProvider({ fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    if (url.endsWith('/models')) return response(catalog);
    calls++;
    const request = JSON.parse(options.body);
    requests.push(request);
    assert.equal(graph.run.usage.generations, calls);
    assert.equal(graph.run.attempts.at(-1).status, 'pending');
    assert.equal(graph.run.usage.reservedCostUsd, graph.run.limits.maxCostUsd);
    assert.equal(graph.run.usage.accountingComplete, false);
    assert.equal(graph.run.usage.costUsd, null);
    return handler(JSON.parse(request.messages[1].content), calls);
  } });
  const options = { store, provider: agent, now: () => clock, wait: async ms => { waits.push(ms); clock += ms; } };
  return {
    options, store, requests, waits, graph: () => graph, calls: () => calls,
    run: () => dispatchRun({ objective: 'Compute a closed-scope answer', limits }, options),
  };
}

test('strict limits reject weakening, unknown fields and invalid task input before inference', async () => {
  for (const limits of [
    { concurrency: 2 }, { maxRetries: 2 }, { minDelayMs: 2999 }, { maxGenerations: 16 },
    { maxCostUsd: 0.11 }, { maxCostUsd: NaN }, { maxCostUsd: '0.1' }, { maxNodes: 26 },
    { maxOutputTokens: 2049 }, { maxOutputTokens: null }, { ignored: 1 }, [], null,
  ]) assert.throws(() => executionLimits(limits));
  const h = harness();
  await assert.rejects(dispatchRun({ objective: 'test', context: { shell: 'no' } }, h.options));
  assert.equal(h.calls(), 0);
  assert.equal(h.graph(), null);
});

test('zero budget stops before pricing or inference and terminalizes the root', async () => {
  const h = harness(undefined, { maxCostUsd: 0 });
  const outcome = await h.run();
  assert.equal(outcome.stoppingReason, 'budget_exhausted');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.usage.generations, 0);
  assert.equal(h.calls(), 0);
});

test('generation exhaustion counts every request and rate limits successful calls', async () => {
  const h = harness(context => response(completion(context, [
    { op: 'evidence', id: context.nodeId, text: 'Still working', source: 'test' },
  ])), { maxGenerations: 2 });
  const outcome = await h.run();
  assert.equal(outcome.stoppingReason, 'generation_exhausted');
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.waits, [3000]);
  assert.equal(h.graph().generation, 2);
  assert.equal(outcome.usage.totalTokens, 300);
  assert.equal(outcome.usage.costUsd, 0);
  assert.equal(outcome.usage.reservedCostUsd, 0);
  assert.equal(h.requests[0].max_tokens, 1536);
  assert.deepEqual(h.requests[0].provider.only, [provider]);
  assert.deepEqual(h.requests[0].provider.max_price, { prompt: 0, completion: 0 });
  assert.equal(h.requests[0].provider.allow_fallbacks, false);
});

test('unexpected spend is accounted and stops, even below the budget', async () => {
  for (const [cost, reason] of [[0.01, 'pricing_violation'], [0.10, 'budget_exhausted']]) {
    const h = harness(context => {
      const data = completion(context);
      data.usage.cost = cost;
      return response(data);
    });
    const outcome = await h.run();
    assert.equal(outcome.stoppingReason, reason);
    assert.equal(outcome.usage.costUsd, cost);
    assert.equal(h.calls(), 1);
    assert.equal(h.graph().history[0].outcome, 'rejected');
  }
});

test('excessive graph expansion is rejected atomically', async () => {
  const h = harness(context => response(completion(context, [
    { op: 'add', id: 'a', parentId: 'root', objective: 'a' },
    { op: 'add', id: 'b', parentId: 'root', objective: 'b' },
  ])), { maxNodes: 2 });
  assert.equal((await h.run()).stoppingReason, 'graph_limit');
  assert.equal(h.graph().nodes.length, 1);
  assert.equal(h.calls(), 1);
});

test('graph byte growth is also bounded', async () => {
  const h = harness(context => response(completion(context, [
    { op: 'evidence', id: 'root', text: 'x'.repeat(600000), source: 'test' },
  ])));
  assert.equal((await h.run()).stoppingReason, 'graph_limit');
  assert.equal(h.graph().nodes[0].evidence.length, 0);
});

test('429 retries once, honours Retry-After and records both attempts', async () => {
  const h = harness((context, call) => call === 1
    ? response({ error: 'private provider text' }, 429, { 'retry-after': '5' })
    : response(completion(context)));
  const outcome = await h.run();
  assert.equal(outcome.stoppingReason, 'root_terminal');
  assert.equal(outcome.usage.generations, 2);
  assert.deepEqual(h.waits, [5000]);
  assert.equal(h.graph().run.attempts[0].error, 'rate_limited');
  assert.equal(JSON.stringify(h.graph()).includes('private provider text'), false);
});

test('persistent 429, disabled retries, long Retry-After and generation ceilings cannot loop', async () => {
  for (const [limits, delay, calls, reason] of [
    [{}, '0', 2, 'rate_limited'],
    [{ maxRetries: 0 }, '0', 1, 'rate_limited'],
    [{}, '3600', 1, 'rate_limited'],
    [{}, 'garbage', 1, 'rate_limited'],
    [{ maxGenerations: 1 }, '0', 1, 'generation_exhausted'],
  ]) {
    const h = harness(() => response({}, 429, { 'retry-after': delay }), limits);
    assert.equal((await h.run()).stoppingReason, reason);
    assert.equal(h.calls(), calls);
  }
});

test('ambiguous transport and server failures retain reservations and do not retry', async () => {
  for (const handler of [
    () => { throw new Error('secret transport details'); },
    () => response({ error: 'secret server details' }, 503),
    () => response({}, 401),
  ]) {
    const h = harness(handler);
    const outcome = await h.run();
    assert.equal(h.calls(), 1);
    assert.equal(outcome.usage.accountingComplete, false);
    assert.equal(outcome.usage.costUsd, null);
    assert.equal(outcome.usage.reservedCostUsd, 0.10);
    assert.equal(JSON.stringify(h.graph()).includes('secret'), false);
  }
});

test('malformed JSON, absent/invalid usage and truncated outputs fail closed', async () => {
  const cases = [
    [() => new Response('{'), 'malformed_response', false],
    [() => response(null), 'malformed_response', false],
    [context => { const d = completion(context); delete d.usage; return response(d); }, 'usage_unavailable', false],
    [context => { const d = completion(context); d.usage.cost = '0'; return response(d); }, 'usage_unavailable', false],
    [context => { const d = completion(context); d.usage.total_tokens++; return response(d); }, 'usage_unavailable', false],
    [context => { const d = completion(context); d.choices[0].message.content = '{'; return response(d); }, 'malformed_proposal', true],
    [context => { const d = completion(context); d.choices[0].finish_reason = 'length'; return response(d); }, 'provider_response_error', true],
    [context => { const d = completion(context); d.provider = 'Other'; return response(d); }, 'provider_identity_mismatch', true],
    [context => { const d = completion(context); d.usage.completion_tokens = 2000; d.usage.total_tokens = 2100; return response(d); }, 'output_limit', true],
  ];
  for (const [handler, reason, accounted] of cases) {
    const h = harness(handler);
    const outcome = await h.run();
    assert.equal(outcome.stoppingReason, reason);
    assert.equal(outcome.usage.accountingComplete, accounted);
    assert.equal(h.calls(), 1);
    assert.equal(h.graph().nodes[0].status, 'failed');
  }
});

test('wrong-node proposals and model tool requests cannot perform host actions', async () => {
  const h = harness(context => response(completion(context, [
    { op: 'propose', id: 'root', tool: 'shell', input: { command: 'touch /tmp/must-not-run' }, reason: 'Host approval' },
  ])));
  const outcome = await h.run();
  assert.equal(outcome.stoppingReason, 'no_runnable_nodes');
  assert.equal(h.graph().nodes[0].actions[0].status, 'proposed');
  assert.equal(outcome.blockers[0].status, 'needs_human');
  const wrong = harness(context => {
    const d = completion(context);
    d.choices[0].message.content = JSON.stringify({ ...proposal(context), nodeId: 'other' });
    return response(d);
  });
  assert.equal((await wrong.run()).stoppingReason, 'invalid_proposal');
});

test('allowlists, missing prices and nonzero tariffs prevent inference', async () => {
  assert.throws(() => createProvider({ model: 'paid/model' }), /allowlisted/);
  assert.throws(() => createProvider({ provider: 'Other' }), /allowlisted/);
  for (const pricing of [null, {}, { prompt: '0', completion: '0.01' }, { prompt: '', completion: '0' },
    { prompt: '0', completion: '0', request: '0.1' }]) {
    const h = harness();
    let calls = 0;
    h.options.provider = createProvider({ fetchImpl: async () => {
      calls++;
      return response({ data: [{ id: model, pricing }] });
    } });
    assert.equal((await h.run()).stoppingReason, 'provider_preflight_failed');
    assert.equal(calls, 1);
    assert.equal(h.graph().run.usage.generations, 0);
  }
  await assert.rejects(createProvider().generate({}, 128), /Unverified/);
});

test('untrusted response identity and oversized bodies cannot grow the audit without bounds', async () => {
  const h = harness(context => {
    const data = completion(context);
    data.model = 'x'.repeat(100000);
    data.provider = { payload: 'x'.repeat(100000) };
    return response(data);
  });
  assert.equal((await h.run()).stoppingReason, 'provider_identity_mismatch');
  assert.ok(JSON.stringify(h.graph()).length < 10000);
  const huge = harness(() => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  assert.equal((await huge.run()).stoppingReason, 'malformed_response');
  assert.equal(huge.calls(), 1);
});

test('pending reservation is durable before I/O and failed persistence cannot start inference', async () => {
  const h = harness();
  const original = h.store.save;
  h.store.save = async (...args) => {
    if (args[0].run.attempts.length) throw new Error('disk failure');
    return original(...args);
  };
  await assert.rejects(h.run(), /disk failure/);
  assert.equal(h.calls(), 0);
  await assert.rejects(h.run(), /empty store/);
});

test('failed accounting commit leaves pending cost unknown, never a complete zero-cost claim', async () => {
  const h = harness();
  const original = h.store.save;
  h.store.save = async (...args) => {
    if (args[0].run.attempts.at(-1)?.status === 'applied') throw new Error('accounting save failed');
    return original(...args);
  };
  await assert.rejects(h.run(), /accounting save failed/);
  assert.equal(h.calls(), 1);
  assert.equal(h.graph().run.usage.accountingComplete, false);
  assert.equal(h.graph().run.usage.costUsd, null);
  assert.equal(h.graph().run.usage.reservedCostUsd, 0.10);
  assert.equal(h.graph().run.attempts.at(-1).status, 'pending');
  await assert.rejects(h.run(), /empty store/);
});

test('MangoDB flushes snapshot and ancestor directories; sync failures stop before inference', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-sync-'));
  let store;
  try {
    const probe = await open(join(directory, 'probe'), 'w');
    const prototype = Object.getPrototypeOf(probe);
    const original = prototype.sync;
    await probe.close();
    const synced = [];
    let fail = false;
    t.mock.method(prototype, 'sync', async function () {
      if (fail) throw new Error('sync failed');
      synced.push((await this.stat()).isDirectory() ? 'directory' : 'file');
      return original.call(this);
    });
    store = await openStore(join(directory, 'nested', 'run'));
    const h = harness();
    let calls = 0;
    const agent = createProvider({ fetchImpl: async (url, options) => {
      assert.equal(synced[0], 'file');
      assert.ok(synced.slice(1).includes('directory'));
      if (url.endsWith('/models')) {
        synced.length = 0;
        return response(catalog);
      }
      calls++;
      const context = JSON.parse(JSON.parse(options.body).messages[1].content);
      return response(completion(context));
    } });
    const outcome = await dispatchRun({ objective: 'Check durable reservations' }, { ...h.options, store, provider: agent });
    assert.equal(outcome.status, 'resolved');
    assert.equal(calls, 1);
    await store.close();
    store = await openStore(join(directory, 'sync-failure'));
    fail = true;
    await assert.rejects(dispatchRun({ objective: 'Do not send' }, { store, provider: agent }), /sync failed/);
    assert.equal(calls, 1);
  } finally {
    t.mock.restoreAll();
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('isolated persisted run decomposes, resolves dependencies and synthesizes a caller result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-dispatch-'));
  let store;
  try {
    store = await openStore(directory);
    const h = harness();
    // Use the real adapter with the real store; HTTP alone is deterministic.
    const agent = createProvider({ fetchImpl: async (url, options) => {
      if (url.endsWith('/models')) return response(catalog);
      const current = JSON.parse(JSON.parse(options.body).messages[1].content);
      const g = await store.load();
      assert.equal(g.run.attempts.at(-1).status, 'pending');
      if (current.generation === 0) return response(completion(current, [
        { op: 'add', id: 'sum', parentId: 'root', objective: 'Add 12 and 30' },
        { op: 'add', id: 'check', parentId: 'root', objective: 'Compare to cap 50' },
        { op: 'depend', id: 'check', on: 'sum' },
      ]));
      return response(completion(current, [
        { op: 'evidence', id: current.nodeId, text: '12 + 30 = 42; 50 - 42 = 8.', source: 'Supplied numbers' },
        { op: 'resolve', id: current.nodeId, result: current.nodeId === 'root'
          ? 'The total is 42, within the cap of 50 by 8.' : 'Total 42; within cap by 8.' },
      ]));
    } });
    const outcome = await dispatchRun({ objective: 'Total 12 and 30 and check against cap 50' },
      { ...h.options, store, provider: agent });
    assert.equal(outcome.status, 'resolved');
    assert.equal(outcome.result, 'The total is 42, within the cap of 50 by 8.');
    assert.equal(outcome.usage.generations, 4);
    assert.equal(outcome.usage.costUsd, 0);
    assert.equal(outcome.stoppingReason, 'root_terminal');
    assert.deepEqual(outcome.blockers, []);
    assert.equal(outcome.graph, undefined);
    await store.close();
    store = await openStore(directory);
    const graph = await store.load();
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.run.attempts.length, 4);
    assert.equal(graph.nodes[0].result, outcome.result);
    assert.equal(graph.run.stoppingReason, outcome.stoppingReason);
    await assert.rejects(dispatchRun({ objective: 'Spend again' }, { store, provider: agent }), /empty store/);
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI returns the contract without credentials and refuses the old unbudgeted path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-dispatch-cli-'));
  try {
    const input = join(directory, 'task.json');
    await writeFile(input, JSON.stringify({ objective: 'No inference', limits: { maxCostUsd: 0 } }));
    const cli = new URL('../cli.js', import.meta.url).pathname;
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'dispatch', input, '--store', join(directory, 'run')]);
    assert.deepEqual(Object.keys(JSON.parse(stdout)).sort(), ['blockers', 'evidence', 'result', 'status', 'stoppingReason', 'usage']);
    await assert.rejects(promisify(execFile)(process.execPath, [cli, 'iterate']), /Unbudgeted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public dispatch API owns the lock, returns the contract, and never reuses a run', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-public-dispatch-'));
  const apiKey = 'test-only-credential';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    await assert.rejects(openStore(directory), /locked/);
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/models')) {
      assert.equal(options.headers?.Authorization, undefined);
      return response(catalog);
    }
    calls++;
    assert.equal(options.headers.Authorization, ['Bearer', apiKey].join(' '));
    return response(completion(JSON.parse(JSON.parse(options.body).messages[1].content)));
  });
  try {
    const outcome = await dispatch({ objective: 'Return a bounded answer' }, { directory, apiKey });
    assert.deepEqual(Object.keys(outcome).sort(), ['blockers', 'evidence', 'result', 'status', 'stoppingReason', 'usage']);
    assert.equal(outcome.status, 'resolved');
    assert.equal(outcome.usage.generations, 1);
    const store = await openStore(directory);
    try {
      const graph = await store.load();
      assert.deepEqual(graph.run.usage, outcome.usage);
      assert.equal(graph.run.stoppingReason, outcome.stoppingReason);
      assert.equal(JSON.stringify({ graph, outcome }).includes(apiKey), false);
    } finally {
      await store.close();
    }
    await assert.rejects(dispatch({ objective: 'Do not restart' }, { directory, apiKey }), /empty store/);
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public dispatch rejects task-supplied capabilities and releases the store after invalid input', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-public-input-'));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('No network expected'); });
  try {
    for (const field of ['model', 'provider', 'apiKey', 'directory', 'tools']) {
      await assert.rejects(dispatch({ objective: 'No host overrides', [field]: 'untrusted' }, { directory }), /Expected/);
    }
    const outcome = await dispatch({ objective: 'No inference', limits: { maxCostUsd: 0 } }, { directory });
    assert.equal(outcome.stoppingReason, 'budget_exhausted');
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pricing transport failures stop before inference with complete zero-attempt accounting', async () => {
  const h = harness();
  let calls = 0;
  h.options.provider = createProvider({ fetchImpl: async () => {
    calls++;
    throw new Error('Private network details');
  } });
  const outcome = await h.run();
  assert.equal(calls, 1);
  assert.equal(outcome.stoppingReason, 'provider_preflight_failed');
  assert.equal(outcome.usage.generations, 0);
  assert.equal(outcome.usage.costUsd, 0);
  assert.equal(outcome.usage.accountingComplete, true);
  assert.equal(outcome.usage.reservedCostUsd, 0);
  assert.equal(JSON.stringify(h.graph()).includes('Private network details'), false);
});

test('an unavailable allowlisted model stops without selecting another catalogue model', async () => {
  const h = harness();
  let calls = 0;
  h.options.provider = createProvider({ fetchImpl: async url => {
    calls++;
    assert.ok(url.endsWith('/models'));
    return response({ data: [{ id: 'other/model:free', pricing: { prompt: '0', completion: '0' } }] });
  } });
  const outcome = await h.run();
  assert.equal(outcome.stoppingReason, 'provider_preflight_failed');
  assert.equal(outcome.usage.generations, 0);
  assert.equal(outcome.usage.costUsd, 0);
  assert.equal(calls, 1);
  assert.equal(h.graph().run.model, model);
});

test('Retry-After HTTP dates respect spacing and reject excessive delays', async t => {
  const time = Date.parse('2026-09-14T12:00:00Z');
  t.mock.method(Date, 'now', () => time);
  for (const [delay, expectedCalls] of [[5000, 2], [61000, 1]]) {
    const h = harness((context, call) => call === 1
      ? response({}, 429, { 'retry-after': new Date(time + delay).toUTCString() })
      : response(completion(context)));
    const outcome = await h.run();
    assert.equal(h.calls(), expectedCalls);
    assert.equal(outcome.stoppingReason, expectedCalls === 2 ? 'root_terminal' : 'rate_limited');
    assert.deepEqual(h.waits, expectedCalls === 2 ? [delay] : []);
  }
});
