#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { seed, validateGraph, nextNode, runnable, buildContext, applyProposal, humanUpdate } from './core/graph.js';
import { iterate } from './core/iterate.js';
import { protocol } from './core/protocol.js';
import { openStore } from './adapters/mango.js';
import { createAgent } from './adapters/openai.js';

const print = value => console.log(JSON.stringify(value, null, 2));
const readJSON = async path => JSON.parse(await readFile(resolve(path), 'utf8'));
const usage = `TAG — Tiny Agent Node Graph & Lightweight Executor
  tag init [objective] [--from snapshot.json]
  tag status | graph | history | protocol
  tag inspect <id> | context [id]
  tag apply <proposal.json>
  tag answer <question-id> <answer> | resume <node-id> <evidence>
  tag iterate [--count 1..30]
Options: --store <directory> (default .tag), --from <snapshot>, --help
Model: TAG_ENDPOINT (full chat completions URL), TAG_MODEL, TAG_API_KEY.
Without a model, use context + apply with an external coding agent.
Tool proposals require explicit host action; no model commands are executed.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { store: { type: 'string', default: '.tag' }, count: { type: 'string' }, from: { type: 'string' }, help: { type: 'boolean' } },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) return console.log(usage);
  if (command === 'protocol') return print(protocol);
  if (!['init', 'status', 'graph', 'history', 'inspect', 'context', 'apply', 'answer', 'resume', 'iterate'].includes(command)) {
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
          roots: graph.nodes.filter(node => node.parentId === null).map(({ id, status, result }) => ({ id, status, result })),
        });
      case 'graph': return print(graph);
      case 'history': return print(graph.history);
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
      case 'iterate': {
        if (!process.env.TAG_ENDPOINT) throw new Error('Configure TAG_ENDPOINT and TAG_MODEL, or use context + apply with an external agent');
        const agent = createAgent({
          endpoint: process.env.TAG_ENDPOINT, model: process.env.TAG_MODEL, apiKey: process.env.TAG_API_KEY,
          instructions: await readFile(new URL('./bootstrap.md', import.meta.url), 'utf8'),
        });
        const result = await iterate({ store, agent, count: Number(values.count ?? 1) });
        print(result);
        if (result.stop === 'agent_error') process.exitCode = 1;
      }
    }
  } finally {
    await store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`TAG: ${error.message}`);
    process.exitCode = 1;
  });
}
