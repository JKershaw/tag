#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { seed, validateGraph, nextNode, runnable, explain, buildContext, applyProposal, humanUpdate } from './core/graph.js';
import { protocol } from './core/protocol.js';
import { openStore } from './adapters/mango.js';
import { dispatch } from './adapters/dispatch.js';

const print = value => console.log(JSON.stringify(value, null, 2));
const readJSON = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const usage = `TAG — Tiny Agent Node Graph & Lightweight Executor
  tag init [objective] [--from snapshot.json]
  tag status | graph | history | protocol
  tag inspect <id> | explain <id> | context [id]
  tag apply <proposal.json>
  tag answer <question-id> <answer> | resume <node-id> <evidence>
  tag dispatch <task.json> --store <new-run-directory>
Options: --store <directory> (default .tag), --from <snapshot>, --help
Model: OPENROUTER_API_KEY, optional TAG_MODEL (allowlisted free routes or budget-reserved DeepSeek V4.1 Flash).
Without a model, use context + apply with an external coding agent.
Tool proposals require explicit host action; no model commands are executed.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { store: { type: 'string', default: '.tag' }, from: { type: 'string' }, help: { type: 'boolean' } },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) return console.log(usage);
  if (command === 'protocol') return print(protocol);
  if (command === 'iterate') throw new Error('Unbudgeted model iteration is disabled; use dispatch with explicit run limits');
  if (command === 'dispatch') {
    if (args.length !== 1 || values.store === '.tag') throw new Error('dispatch requires a task JSON file and an isolated --store directory');
    return print(await dispatch(await readJSON(args[0]), { directory: values.store, model: process.env.TAG_MODEL }));
  }
  if (!['init', 'status', 'graph', 'history', 'inspect', 'explain', 'context', 'apply', 'answer', 'resume'].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  const store = await openStore(values.store);
  try {
    let graph = await store.load();
    if (command === 'init') {
      if (graph) throw new Error('Store is already initialized');
      graph = values.from ? validateGraph(await readJSON(values.from)) : seed(
        args.join(' ') || 'Build TAG into the graph-native agent system described in transcript.md and bootstrap.md',
        await readFile(new URL('./transcript.md', import.meta.url), 'utf8'),
      );
      await store.save(graph);
      return print({ initialized: true, revision: graph.revision });
    }
    if (!graph) throw new Error('Store is empty; run tag init first');
    switch (command) {
      case 'status':
        return print({
          revision: graph.revision, generation: graph.generation, nodes: graph.nodes.length,
          next: nextNode(graph)?.id ?? null, runnable: runnable(graph).map(node => node.id),
          blocked: graph.nodes.filter(node => ['blocked', 'needs_human'].includes(node.status))
            .map(({ id, reason }) => ({ id, reason })),
          waiting: graph.nodes.map(node => explain(graph, node.id)).filter(node => !node.terminal && !node.runnable),
          roots: graph.nodes.filter(node => node.parentId === null).map(({ id, status, result }) => ({ id, status, result })),
        });
      case 'graph': return print(graph);
      case 'history': return print(graph.history);
      case 'explain': return print(explain(graph, args[0]));
      case 'inspect': {
        const node = graph.nodes.find(item => item.id === args[0]);
        if (!node) throw new Error('Unknown node');
        return print(node);
      }
      case 'context': return print(buildContext(graph, args[0]));
      case 'apply': {
        if (args.length !== 1) throw new Error('apply requires a proposal JSON file');
        const updated = applyProposal(graph, await readJSON(args[0]));
        await store.save(updated, graph.revision);
        return print({ generation: updated.generation, revision: updated.revision });
      }
      case 'answer':
      case 'resume': {
        const updated = humanUpdate(graph, args[0], args.slice(1).join(' '), command === 'answer');
        await store.save(updated, graph.revision);
        return print({ revision: updated.revision });
      }
    }
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(`TAG: ${error.message}`);
  process.exitCode = 1;
});
