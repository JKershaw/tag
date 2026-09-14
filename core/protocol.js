// Changing mutation rules requires an explicit protocol version change.
export const protocol = {
  version: 1,
  statuses: ['ready', 'blocked', 'needs_human', 'resolved', 'partially_resolved', 'failed'],
  types: ['task', 'question', 'fact', 'decision', 'evidence'],
  envelope: {
    protocolVersion: '1',
    revision: 'revision from context',
    nodeId: 'current runnable node',
    summary: 'one bounded action, including any externally performed work',
    mutations: 'non-empty array; only the current node or nodes created this iteration',
  },
  mutations: {
    add: { op: 'add', id: 'new ID', objective: 'text', parentId: 'current or new node', type: 'optional type', context: 'optional text' },
    depend: { op: 'depend', id: 'node ID', on: 'prerequisite ID' },
    undepend: { op: 'undepend', id: 'node ID', on: 'prerequisite ID' },
    reference: { op: 'reference', id: 'node ID', target: 'evidence/context node ID' },
    evidence: { op: 'evidence', id: 'node ID', text: 'observation', source: 'file, test, URL, or other provenance' },
    decision: { op: 'decision', id: 'node ID', text: 'decision and rationale', source: 'provenance' },
    resolve: { op: 'resolve', id: 'node ID', result: 'conclusion', status: 'optional resolved/partially_resolved/failed' },
    block: { op: 'block', id: 'node ID', reason: 'why', human: 'optional boolean' },
    propose: { op: 'propose', id: 'node ID', tool: 'requested tool', input: 'JSON input', reason: 'why approval is needed' },
  },
  tools: 'Proposals are recorded and block the node for human/host approval. TAG never executes model-supplied commands.',
};
