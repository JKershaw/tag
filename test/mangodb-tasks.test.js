import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MangoClient } from '@jkershaw/mangodb';
import { openStore } from '../adapters/mango.js';
import { seed, applyProposal } from '../core/graph.js';
import { dispatchRun } from '../core/dispatch.js';

test('MangoDB task observations: lifecycle survives a new client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-mango-lifecycle-'));
  let client = new MangoClient(directory);
  try {
    await client.connect();
    const items = client.db('checks').collection('items');
    await items.insertMany([{ _id: 'a', count: 2 }, { _id: 'b', count: 7 }]);
    const update = await items.updateOne({ _id: 'a' }, { $inc: { count: 3 } });
    assert.equal(update.matchedCount, 1);
    assert.equal(update.modifiedCount, 1);
    assert.equal((await items.deleteOne({ _id: 'b' })).deletedCount, 1);
    await client.close();
    client = new MangoClient(directory);
    await client.connect();
    const reopened = client.db('checks').collection('items');
    assert.equal((await reopened.findOne({ _id: 'a' })).count, 5);
    assert.equal(await reopened.findOne({ _id: 'b' }), null);
    assert.equal(await reopened.countDocuments(), 1);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MangoDB task observations: filtering, sorting, projection and limit after reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-mango-query-'));
  let client = new MangoClient(directory);
  try {
    await client.connect();
    await client.db('checks').collection('items').insertMany([
      { _id: 'a', active: true, score: 4 },
      { _id: 'b', active: true, score: 9 },
      { _id: 'c', active: false, score: 12 },
      { _id: 'd', active: true, score: 7 },
    ]);
    await client.close();
    client = new MangoClient(directory);
    await client.connect();
    const result = await client.db('checks').collection('items')
      .find({ active: true, score: { $gte: 5 } }, { projection: { _id: 1, score: 1 } })
      .sort({ score: -1 }).limit(2).toArray();
    assert.deepEqual(result, [{ _id: 'b', score: 9 }, { _id: 'd', score: 7 }]);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MangoDB task observations: opaque snapshot retains proposed action and history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-mango-snapshot-'));
  let store;
  try {
    store = await openStore(directory);
    const graph = seed('Preserve an external proposal');
    await store.save(graph);
    const updated = applyProposal(graph, {
      protocolVersion: 1, revision: graph.revision, nodeId: 'root', summary: 'Record only; do not execute',
      mutations: [{
        op: 'propose', id: 'root', tool: 'external', reason: 'Host approval required',
        input: { values: [{ $oid: 'external-id', label: 'keep' }, { $date: 'not-a-date', extra: true }] },
      }],
    });
    await store.save(updated, graph.revision);
    await store.close();
    const documents = JSON.parse(await readFile(join(directory, 'tag', 'snapshots.json'), 'utf8'));
    assert.equal(typeof documents[0].stateJSON, 'string');
    store = await openStore(directory);
    const reopened = await store.load();
    assert.deepEqual(reopened, updated);
    assert.equal(reopened.nodes[0].status, 'needs_human');
    assert.equal(reopened.nodes[0].actions[0].status, 'proposed');
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MangoDB fixtures conform to external dispatch with a bounded combined allowance', async () => {
  let allowance = 0;
  let generations = 0;
  for (const name of ['lifecycle', 'query', 'snapshot']) {
    const task = JSON.parse(await readFile(new URL(`../examples/mangodb/${name}-task.json`, import.meta.url), 'utf8'));
    allowance += task.limits.maxCostUsd;
    generations += task.limits.maxGenerations;
    assert.equal(task.limits.maxRetries, 0);
    assert.equal(task.limits.maxCostUsd, 0.03);
    assert.equal(task.limits.concurrency, 1);
    assert.equal(task.limits.maxGenerations, 2);
    assert.equal(task.limits.maxOutputTokens, 1536);
    assert.equal(task.limits.minDelayMs, 3000);
    assert.equal(task.limits.maxNodes, 3);
    let graph;
    const outcome = await dispatchRun(task, {
      store: { load: async () => graph, save: async value => { graph = structuredClone(value); } },
      provider: { model: 'offline', name: 'offline', verify: async () => { throw new Error('Offline validation only'); } },
    });
    assert.equal(outcome.stoppingReason, 'provider_preflight_failed');
    assert.equal(graph.nodes[0].objective, task.objective);
    assert.equal(graph.nodes[0].context, task.context);
    assert.equal(outcome.usage.generations, 0);
  }
  assert.ok(allowance <= 0.09);
  assert.ok(generations <= 6);
});
