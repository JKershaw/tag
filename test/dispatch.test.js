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

function harness(handler = context => response(completion(context)), limits = {}, { requestedModel = model, catalogue = catalog } = {}) {
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
  const agent = createProvider({ model: requestedModel, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    if (url.endsWith('/models')) return response(catalogue);
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
  assert.deepEqual(h.graph().run.pricing, { status: 'unknown', reason: 'not_checked' });
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
  for (const cost of [0.01, 0.10]) {
    const h = harness(context => {
      const data = completion(context);
      data.usage.cost = cost;
      return response(data);
    });
    const outcome = await h.run();
    assert.equal(outcome.stoppingReason, 'pricing_violation');
    assert.equal(outcome.usage.costUsd, cost);
    assert.equal(h.calls(), 1);
    assert.equal(h.graph().history[0].outcome, 'rejected');
  }
});

const router = 'openrouter/free';
const routerCatalogue = { data: [{ id: router, pricing: { prompt: '0', completion: '0' } }] };
const routerOptions = { requestedModel: router, catalogue: routerCatalogue };
const routedCompletion = context => ({ ...completion(context), model: 'routed/actual-model', provider: 'Other' });

test('free router requires explicit catalogue zeros and preserves routing restrictions and attribution', async () => {
  const h = harness(context => response(routedCompletion(context)), {}, routerOptions);
  const outcome = await h.run();
  assert.equal(outcome.status, 'resolved');
  assert.equal(outcome.usage.costUsd, 0);
  assert.equal(outcome.usage.accountingComplete, true);
  assert.equal(h.graph().run.pricing.status, 'known_free');
  assert.equal(h.graph().run.pricing.reason, 'all_prices_zero');
  assert.equal(h.graph().run.model, router);
  const attempt = h.graph().run.attempts[0];
  assert.equal(attempt.requestedModel, router);
  assert.equal(attempt.actualModel, 'routed/actual-model');
  assert.equal(attempt.model, 'routed/actual-model');
  assert.equal(attempt.provider, 'Other');
  assert.equal(attempt.actualProvider, 'Other');
  assert.equal(attempt.requestedProvider, null);
  assert.equal(h.graph().run.provider, null);
  assert.equal(h.requests[0].model, router);
  assert.deepEqual(h.requests[0].provider, {
    allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0 },
  });
  assert.deepEqual(attempt.routingPolicy, h.requests[0].provider);
  assert.deepEqual(h.graph().run.routingPolicy, h.requests[0].provider);
  assert.deepEqual(h.requests[0].usage, { include: true });
});

test('router name never substitutes for unknown or nonzero pricing', async t => {
  for (const [name, pricing, status] of [
    ['missing', undefined, 'unknown'], ['null', null, 'unknown'], ['empty', {}, 'unknown'],
    ['incomplete', { prompt: '0' }, 'unknown'],
    ['malformed', { prompt: '0', completion: '' }, 'unknown'],
    ['underflow', { prompt: '0', completion: '1e-999' }, 'unknown'],
    ['unknown extra', { prompt: '0', completion: '0', request: null }, 'unknown'],
    ['priced', { prompt: '0', completion: '0.01' }, 'known_priced'],
    ['priced extra', { prompt: '0', completion: '0', request: '0.01' }, 'known_priced'],
  ]) await t.test(name, async () => {
    const h = harness(undefined, {}, { requestedModel: router, catalogue: { data: [{ id: router, pricing }] } });
    assert.equal((await h.run()).stoppingReason, 'provider_preflight_failed');
    assert.equal(h.graph().run.pricing.status, status);
    assert.equal(h.calls(), 0);
    await assert.rejects(h.options.provider.generate({}, 128), /Unverified/);
  });
});

test('router absence or ambiguity cannot select an ordinary free model instead', async () => {
  for (const catalogue of [catalog, { data: [routerCatalogue.data[0], routerCatalogue.data[0]] }]) {
    const h = harness(undefined, {}, { requestedModel: router, catalogue });
    assert.equal((await h.run()).stoppingReason, 'provider_preflight_failed');
    assert.equal(h.graph().run.pricing.status, 'unknown');
    assert.equal(h.graph().run.pricing.reason, catalogue === catalog ? 'model_unavailable' : 'ambiguous_model');
    assert.equal(h.calls(), 0);
  }
});

test('router still requires actual-model attribution, valid provider metadata and usage on every completion', async () => {
  for (const [override, reason] of [
    [{ model: undefined }, 'provider_identity_mismatch'],
    [{ model: router }, 'provider_identity_mismatch'],
    [{ model: '' }, 'provider_identity_mismatch'],
    [{ model: 'x/y'.repeat(100) }, 'provider_identity_mismatch'],
    [{ provider: '' }, 'provider_identity_mismatch'],
    [{ provider: {} }, 'provider_identity_mismatch'],
    [{ provider: 'x'.repeat(129) }, 'provider_identity_mismatch'],
    [{ usage: undefined }, 'usage_unavailable'],
    [{ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }, 'usage_unavailable'],
  ]) {
    const h = harness(context => response({ ...routedCompletion(context), ...override }), {}, routerOptions);
    assert.equal((await h.run()).stoppingReason, reason);
    assert.equal(h.calls(), 1);
    assert.equal(h.graph().run.attempts[0].requestedModel, router);
  }
  const ordinary = harness(context => response(routedCompletion(context)));
  assert.equal((await ordinary.run()).stoppingReason, 'provider_identity_mismatch');
});

test('Chutes-only excludes available free-router endpoints; unpinned routing changes only provider.only', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/models')) return response(routerCatalogue);
    const request = JSON.parse(options.body);
    requests.push(request);
    if (request.provider.only) return response({ error: { code: 404,
      message: 'No allowed providers are available for the selected model. Available: novita; provider.only: chutes.' } }, 404);
    return response(routedCompletion({ nodeId: 'root', revision: 0 }));
  };
  const pinned = createProvider({ model: router, provider, fetchImpl });
  const unpinned = createProvider({ model: router, fetchImpl });
  assert.equal((await pinned.verify()).status, 'known_free');
  assert.equal((await unpinned.verify()).status, 'known_free');
  assert.equal((await pinned.generate({}, 1536)).error, 'provider_unavailable');
  const result = await unpinned.generate({}, 1536);
  assert.equal(result.error, undefined);
  assert.equal(result.usage.costUsd, 0);
  assert.equal(result.provider, 'Other');
  const restrictedRequest = structuredClone(requests[0]);
  delete restrictedRequest.provider.only;
  assert.deepEqual(requests[1], restrictedRequest);
});

test('explicit provider pinning remains enforced and ordinary models cannot be unpinned', async () => {
  assert.throws(() => createProvider({ model, provider: null }), /allowlisted/);
  assert.throws(() => createProvider({ model: router, provider: 'Other' }), /allowlisted/);
  for (const requestedModel of [model, router]) {
    const agent = createProvider({ model: requestedModel, provider, fetchImpl: async url => url.endsWith('/models')
      ? response(requestedModel === router ? routerCatalogue : catalog)
      : response({ ...completion({ nodeId: 'root', revision: 0 }), provider: 'Other' }) });
    await agent.verify();
    assert.equal((await agent.generate({}, 1536)).error, 'provider_identity_mismatch');
    assert.deepEqual(agent.routingPolicy.only, [provider]);
  }
});

test('unreported free-router provider remains null rather than being inferred from routing policy', async () => {
  for (const returnedProvider of [undefined, null]) {
    const h = harness(context => response({ ...routedCompletion(context), provider: returnedProvider }), {}, routerOptions);
    assert.equal((await h.run()).status, 'resolved');
    assert.equal(h.graph().run.attempts[0].actualProvider, null);
    assert.equal(h.graph().run.attempts[0].provider, null);
  }
  const h = harness(() => response({}, 404));
  await h.run();
  assert.equal(h.graph().run.attempts[0].requestedProvider, provider);
  assert.equal(h.graph().run.attempts[0].actualProvider, null);
});

test('routing policy cannot be mutated to remove zero-price caps or alter provider restrictions', () => {
  for (const requestedModel of [model, router]) {
    const agent = createProvider({ model: requestedModel });
    assert.throws(() => { agent.routingPolicy.max_price.prompt = 1; }, TypeError);
    assert.throws(() => { agent.routingPolicy.allow_fallbacks = true; }, TypeError);
    if (agent.routingPolicy.only) assert.throws(() => agent.routingPolicy.only.push('Other'), TypeError);
  }
});

test('nonzero router cost on a later completion stops before applying it or making another request', async () => {
  for (const cost of [0.01, 0.10]) {
    const h = harness((context, call) => {
      const data = { ...completion(context, [{ op: 'evidence', id: 'root', text: 'Continue', source: 'test' }]),
        model: 'routed/actual-model' };
      data.usage.cost = call === 1 ? 0 : cost;
      return response(data);
    }, {}, routerOptions);
    const outcome = await h.run();
    assert.equal(outcome.stoppingReason, 'pricing_violation');
    assert.equal(outcome.usage.costUsd, cost);
    assert.equal(outcome.usage.accountingComplete, true);
    assert.equal(h.calls(), 2);
    assert.equal(h.graph().nodes[0].evidence.length, 1);
    assert.equal(h.graph().run.pricing.status, 'known_free');
    assert.equal(h.graph().run.attempts[1].usage.costUsd, cost);
    assert.equal(h.graph().run.attempts[1].error, 'pricing_violation');
    await assert.rejects(h.options.provider.generate({}, 128), /Unverified/);
  }
});

test('router endpoint unavailability stops without retry, fallback or assumed zero actual cost', async () => {
  const h = harness(() => response({ error: 'Private endpoint details' }, 404), {}, routerOptions);
  const outcome = await h.run();
  assert.equal(outcome.stoppingReason, 'provider_unavailable');
  assert.equal(outcome.usage.costUsd, null);
  assert.equal(outcome.usage.accountingComplete, false);
  assert.equal(h.calls(), 1);
  assert.equal(h.graph().run.attempts[0].actualModel, null);
  assert.equal(h.graph().run.attempts[0].requestedModel, router);
  assert.equal(h.graph().run.attempts[0].httpStatus, 404);
  assert.equal(JSON.stringify(h.graph()).includes('Private endpoint details'), false);
});

test('workspace ZDR rejection after unpinning stops without retrying or overriding account guardrails', async () => {
  const message = '0 endpoints out of 3 requested are available matching your guardrail restrictions and data policy. '
    + 'ZDR violation (guardrail): 3 endpoints excluded';
  const h = harness(() => response({ error: { code: 404, message } }, 404), { maxRetries: 0 }, routerOptions);
  const outcome = await h.run();
  assert.equal(outcome.stoppingReason, 'provider_unavailable');
  assert.equal(h.calls(), 1);
  assert.equal(h.graph().run.pricing.status, 'known_free');
  assert.deepEqual(h.requests[0].provider, {
    allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0 },
  });
  const attempt = h.graph().run.attempts[0];
  assert.deepEqual(attempt.routingPolicy, h.requests[0].provider);
  assert.equal(attempt.actualModel, null);
  assert.equal(attempt.actualProvider, null);
  assert.equal(attempt.reportedCostUsd, null);
  assert.equal(attempt.usage, null);
  assert.equal(attempt.httpStatus, 404);
  assert.equal(outcome.usage.costUsd, null);
  assert.equal(outcome.usage.accountingComplete, false);
  assert.equal(outcome.usage.reservedCostUsd, h.graph().run.limits.maxCostUsd);
  assert.equal(JSON.stringify(h.graph()).includes(message), false);
});

test('nonzero reported router cost is preserved even when token accounting is malformed', async () => {
  const h = harness(context => response({ ...routedCompletion(context), usage: { cost: 0.01 } }), {}, routerOptions);
  const outcome = await h.run();
  assert.equal(outcome.stoppingReason, 'pricing_violation');
  assert.equal(outcome.usage.accountingComplete, false);
  assert.equal(outcome.usage.costUsd, null);
  assert.equal(h.graph().run.attempts[0].reportedCostUsd, 0.01);
  assert.equal(h.graph().run.attempts[0].usage, null);
  assert.equal(h.calls(), 1);
  await assert.rejects(h.options.provider.generate({}, 128), /Unverified/);
});

test('router requested and returned models survive MangoDB reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-router-attribution-'));
  let store;
  try {
    store = await openStore(directory);
    const agent = createProvider({ model: router, fetchImpl: async (url, options) => url.endsWith('/models')
      ? response(routerCatalogue)
      : response(routedCompletion(JSON.parse(JSON.parse(options.body).messages[1].content))) });
    await dispatchRun({ objective: 'Persist routed attribution' }, { store, provider: agent });
    const before = await store.load();
    await store.close();
    store = await openStore(directory);
    const after = await store.load();
    assert.deepEqual(after, before);
    assert.equal(after.run.attempts[0].requestedModel, router);
    assert.equal(after.run.attempts[0].actualModel, 'routed/actual-model');
    assert.equal(after.run.attempts[0].actualProvider, 'Other');
    assert.equal(after.run.attempts[0].requestedProvider, null);
    assert.deepEqual(after.run.routingPolicy, agent.routingPolicy);
    assert.deepEqual(after.run.attempts[0].routingPolicy, agent.routingPolicy);
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
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

test('pricing states distinguish valid zero, valid nonzero and incomplete or malformed tariffs', async t => {
  const cases = [
    ['string zeros', { prompt: '0.000', completion: '0', request: '0' }, 'known_free'],
    ['numeric zeros', { prompt: 0, completion: 0 }, 'known_free'],
    ['exponent zeros', { prompt: '0e-10', completion: '0.0E+2' }, 'known_free'],
    ['priced prompt', { prompt: '0.001', completion: '0' }, 'known_priced'],
    ['priced completion', { prompt: 0, completion: 0.002 }, 'known_priced'],
    ['priced extra component', { prompt: '0', completion: '0', request: '1e-8' }, 'known_priced'],
    ['missing', undefined, 'unknown'],
    ['null', null, 'unknown'],
    ['empty', {}, 'unknown'],
    ['missing completion', { prompt: '0' }, 'unknown'],
    ['array', [], 'unknown'],
    ['string', '0', 'unknown'],
    ...['', ' ', 'free', '0x0', '-1', 'NaN', 'Infinity', '1e999', '1e-999', null, false, [], {}]
      .map(value => [`invalid component ${JSON.stringify(value)}`, { prompt: '0', completion: value }, 'unknown']),
    ['invalid extra component', { prompt: '0', completion: '0', request: null }, 'unknown'],
    ['partially known price', { prompt: '0.01', completion: null }, 'unknown'],
  ];
  for (const [name, pricing, status] of cases) await t.test(name, async () => {
    const h = harness();
    let calls = 0;
    h.options.provider = createProvider({ fetchImpl: async (url, options) => {
      if (url.endsWith('/models')) return response({ data: [{ id: model, pricing }] });
      calls++;
      assert.equal(h.graph().run.pricing.status, 'known_free');
      return response(completion(JSON.parse(JSON.parse(options.body).messages[1].content)));
    } });
    const outcome = await h.run();
    const record = h.graph().run.pricing;
    assert.equal(record.status, status);
    assert.equal(record.modelPresent, true);
    assert.equal(record.paidInference, false);
    assert.equal(record.source, 'https://openrouter.ai/api/v1/models');
    assert.ok(Number.isFinite(Date.parse(record.checkedAt)));
    assert.equal(outcome.usage.costUsd, 0);
    assert.equal(outcome.usage.accountingComplete, true);
    assert.equal(outcome.usage.reservedCostUsd, 0);
    assert.equal(calls, status === 'known_free' ? 1 : 0);
    assert.equal(outcome.stoppingReason, status === 'known_free' ? 'root_terminal' : 'provider_preflight_failed');
    assert.equal(record.allAdvertisedPricesZero, status === 'unknown' ? null : status === 'known_free');
    if (status === 'unknown') {
      assert.equal(record.promptPriceUsd, null);
      assert.equal(record.completionPriceUsd, null);
      assert.equal(record.reason, pricing == null ? 'pricing_missing' : 'pricing_invalid');
    } else {
      assert.equal(record.promptPriceUsd, Number(pricing.prompt));
      assert.equal(record.completionPriceUsd, Number(pricing.completion));
    }
    if (status !== 'known_free') await assert.rejects(h.options.provider.generate({}, 128), /Unverified/);
  });
});

test('unavailable or malformed catalogue discovery is unknown, not priced or free', async () => {
  for (const [reply, reason] of [
    [() => response({}, 503), 'http_error'],
    [() => new Response('{'), 'invalid_catalogue'],
    [() => response(null), 'invalid_catalogue'],
    [() => response({ data: {} }), 'invalid_catalogue'],
    [() => response({ data: [null] }), 'invalid_catalogue'],
    [() => response({ data: [] }), 'model_unavailable'],
    [() => response({ data: [catalog.data[0], catalog.data[0]] }), 'ambiguous_model'],
  ]) {
    const h = harness();
    let calls = 0;
    h.options.provider = createProvider({ fetchImpl: async url => {
      calls++;
      assert.ok(url.endsWith('/models'));
      return reply();
    } });
    assert.equal((await h.run()).stoppingReason, 'provider_preflight_failed');
    assert.equal(h.graph().run.pricing.status, 'unknown');
    assert.equal(h.graph().run.pricing.reason, reason);
    assert.equal(h.graph().run.usage.generations, 0);
    assert.equal(calls, 1);
  }
});

test('reverification revokes free authorization on priced or unknown discovery', async () => {
  for (const pricing of [{ prompt: '0', completion: '0.01' }, null]) {
    let current = catalog;
    const agent = createProvider({ fetchImpl: async () => response(current) });
    assert.equal((await agent.verify()).status, 'known_free');
    current = { data: [{ id: model, pricing }] };
    assert.equal((await agent.verify()).status, pricing ? 'known_priced' : 'unknown');
    await assert.rejects(agent.generate({}, 128), /Unverified/);
  }
});

test('dispatch fails closed on thrown or unclassified provider verification', async () => {
  for (const verify of [async () => { throw new Error('Private details'); }, async () => undefined,
    async () => ({ allAdvertisedPricesZero: true })]) {
    const h = harness();
    h.options.provider = { model, name: provider, verify,
      generate: async () => assert.fail('Must not generate') };
    assert.equal((await h.run()).stoppingReason, 'provider_preflight_failed');
    assert.equal(h.graph().run.pricing.status, 'unknown');
    assert.equal(h.graph().run.usage.generations, 0);
    assert.equal(JSON.stringify(h.graph()).includes('Private details'), false);
  }
});

test('all three pricing states survive MangoDB close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-pricing-'));
  try {
    for (const [status, pricing] of [
      ['known_free', { prompt: '0', completion: '0' }],
      ['known_priced', { prompt: '0.01', completion: '0' }],
      ['unknown', null],
    ]) {
      let store = await openStore(join(directory, status));
      try {
        const agent = createProvider({ fetchImpl: async (url, options) => url.endsWith('/models')
          ? response({ data: [{ id: model, pricing }] })
          : response(completion(JSON.parse(JSON.parse(options.body).messages[1].content))) });
        const outcome = await dispatchRun({ objective: 'Preserve pricing state' }, { store, provider: agent });
        const before = await store.load();
        await store.close();
        store = await openStore(join(directory, status));
        const after = await store.load();
        assert.deepEqual(after, before);
        assert.equal(after.run.pricing.status, status);
        assert.deepEqual(after.run.usage, outcome.usage);
      } finally {
        await store.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  assert.equal(h.graph().run.pricing.status, 'unknown');
  assert.equal(h.graph().run.pricing.reason, 'transport_error');
  assert.equal(h.graph().run.pricing.modelPresent, null);
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
  assert.equal(h.graph().run.pricing.status, 'unknown');
  assert.equal(h.graph().run.pricing.reason, 'model_unavailable');
  assert.equal(h.graph().run.pricing.modelPresent, false);
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
