import { applyProposal, buildContext, nextNode, validateGraph } from './graph.js';

export async function iterate({ store, agent, count = 1 }) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 30) throw new Error('count must be an integer from 1 to 30');
  if (typeof agent !== 'function') throw new Error('An agent function is required');
  const completed = [];
  for (let index = 0; index < count; index++) {
    const graph = validateGraph(await store.load());
    const node = nextNode(graph);
    if (!node) return { stop: 'no_runnable_nodes', completed };
    let updated;
    try {
      const proposal = await agent(buildContext(graph, node.id));
      updated = applyProposal(graph, proposal);
    } catch (error) {
      const failed = structuredClone(graph);
      failed.generation++;
      failed.revision++;
      failed.nodes.find(item => item.id === node.id).attempts++;
      failed.history.push({
        generation: failed.generation, revision: failed.revision, nodeId: node.id,
        outcome: 'rejected', error: String(error.message ?? error),
      });
      await store.save(failed, graph.revision);
      return { stop: 'agent_error', completed, error: String(error.message ?? error) };
    }
    await store.save(updated, graph.revision);
    completed.push({ generation: updated.generation, nodeId: node.id });
  }
  return { stop: 'generation_limit', completed };
}
