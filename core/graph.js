import { protocol } from './protocol.js';

const terminal = new Set(['resolved', 'partially_resolved', 'failed']);
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const own = (object, key) => Object.hasOwn(object, key);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value, name) {
  assert(typeof value === 'string' && value.trim().length > 0, `${name} must be non-empty text`);
}

function id(value) {
  assert(typeof value === 'string' && identifier.test(value), 'Invalid node ID');
}

export function createNode(nodeId, objective, parentId = null, type = 'task', context = '') {
  id(nodeId);
  text(objective, 'objective');
  assert(protocol.types.includes(type), 'Invalid node type');
  assert(typeof context === 'string', 'context must be text');
  return {
    id: nodeId, objective, parentId, type, context, status: 'ready',
    blockedBy: [], references: [], evidence: [], decisions: [], actions: [],
    result: null, reason: null, attempts: 0,
  };
}

export function seed(objective, context = '') {
  return {
    protocolVersion: protocol.version, revision: 0, generation: 0,
    nodes: [createNode('root', objective, null, 'task', context)], history: [],
  };
}

export function validateGraph(graph) {
  assert(graph?.protocolVersion === protocol.version, 'Unsupported protocol version');
  assert(Number.isSafeInteger(graph.revision) && graph.revision >= 0, 'Invalid revision');
  assert(Number.isSafeInteger(graph.generation) && graph.generation >= 0, 'Invalid generation');
  assert(Array.isArray(graph.nodes) && graph.nodes.length > 0, 'Graph needs nodes');
  assert(Array.isArray(graph.history), 'Invalid history');
  const nodes = new Map();
  for (const node of graph.nodes) {
    id(node.id);
    assert(!nodes.has(node.id), 'Duplicate node ID');
    nodes.set(node.id, node);
    text(node.objective, 'objective');
    assert(typeof node.context === 'string', 'Invalid context');
    assert(protocol.types.includes(node.type), 'Invalid node type');
    assert(protocol.statuses.includes(node.status), 'Invalid node status');
    assert(Number.isSafeInteger(node.attempts) && node.attempts >= 0, 'Invalid attempts');
    for (const field of ['blockedBy', 'references', 'evidence', 'decisions', 'actions']) {
      assert(Array.isArray(node[field]), `Invalid ${field}`);
    }
    for (const field of ['blockedBy', 'references']) {
      assert(new Set(node[field]).size === node[field].length, `Duplicate ${field}`);
    }
    for (const item of [...node.evidence, ...node.decisions]) {
      text(item.text, 'record text');
      text(item.source, 'record source');
    }
    if (terminal.has(node.status)) text(node.result, 'result');
    if (['blocked', 'needs_human'].includes(node.status)) text(node.reason, 'reason');
  }
  assert(graph.nodes.filter(node => node.parentId === null).length === 1, 'Graph needs exactly one root');
  for (const node of graph.nodes) {
    if (node.parentId !== null) assert(nodes.has(node.parentId), 'Missing parent');
    for (const target of [...node.blockedBy, ...node.references]) {
      assert(nodes.has(target) && target !== node.id, 'Invalid graph reference');
    }
  }
  // A parent waits for its children as well as explicit prerequisites.
  const visiting = new Set();
  const visited = new Set();
  function visit(node) {
    assert(!visiting.has(node.id), 'Dependency/hierarchy cycle');
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    const children = graph.nodes.filter(child => child.parentId === node.id);
    for (const target of [...node.blockedBy, ...children.map(child => child.id)]) visit(nodes.get(target));
    visiting.delete(node.id);
    visited.add(node.id);
  }
  for (const node of graph.nodes) visit(node);
  for (const node of graph.nodes) {
    if (node.status !== 'resolved') continue;
    assert(node.blockedBy.every(target => nodes.get(target).status === 'resolved'), 'Resolved node has unresolved dependencies');
    assert(graph.nodes.filter(child => child.parentId === node.id).every(child => child.status === 'resolved'),
      'Resolved parent has unresolved children');
  }
  return graph;
}

export function runnable(graph) {
  return graph.nodes.filter(node => node.status === 'ready'
    && node.blockedBy.every(target => graph.nodes.find(other => other.id === target)?.status === 'resolved')
    && graph.nodes.filter(child => child.parentId === node.id).every(child => terminal.has(child.status)));
}

export function nextNode(graph) {
  return runnable(graph).sort((a, b) => a.attempts - b.attempts)[0] ?? null;
}

export function explain(graph, nodeId) {
  const node = graph.nodes.find(item => item.id === nodeId);
  assert(node, 'Unknown node');
  const prerequisites = node.blockedBy.map(target => graph.nodes.find(item => item.id === target))
    .filter(item => item.status !== 'resolved').map(({ id, status }) => ({ id, status }));
  const children = graph.nodes.filter(item => item.parentId === nodeId && !terminal.has(item.status))
    .map(({ id, status }) => ({ id, status }));
  return {
    id: node.id, status: node.status, terminal: terminal.has(node.status),
    runnable: node.status === 'ready' && prerequisites.length === 0 && children.length === 0,
    reason: node.reason, prerequisites, children,
  };
}

export function buildContext(graph, nodeId = nextNode(graph)?.id, { maxCharacters = 32000 } = {}) {
  validateGraph(graph);
  assert(Number.isSafeInteger(maxCharacters) && maxCharacters >= 8000, 'Context budget must be at least 8000 characters');
  const current = graph.nodes.find(node => node.id === nodeId);
  assert(current, 'No current node');
  const included = new Set([current.id]);
  let ancestor = current;
  while (ancestor.parentId !== null) {
    included.add(ancestor.parentId);
    ancestor = graph.nodes.find(node => node.id === ancestor.parentId);
  }
  for (const target of [...current.blockedBy, ...current.references]) included.add(target);
  for (const node of graph.nodes) {
    if (node.parentId === current.id || (current.parentId !== null && node.parentId === current.parentId)) {
      included.add(node.id);
    }
  }
  const related = [...included].filter(target => target !== current.id)
    .map(target => graph.nodes.find(node => node.id === target));
  let textLimit = 2000;
  let itemLimit = 8;
  let nodeLimit = 32;
  function project(node) {
    const copy = structuredClone(node);
    const omitted = {};
    function clip(value, field) {
      if (typeof value !== 'string' || value.length <= textLimit) return value;
      omitted[field] = { characters: value.length - textLimit };
      return value.slice(0, textLimit);
    }
    for (const field of ['objective', 'context', 'result', 'reason']) copy[field] = clip(copy[field], field);
    for (const field of ['blockedBy', 'references', 'evidence', 'decisions', 'actions']) {
      if (copy[field].length > itemLimit) omitted[field] = { items: copy[field].length - itemLimit };
      // Keep recent observations, but preserve stable order for relationship IDs.
      copy[field] = ['blockedBy', 'references'].includes(field)
        ? copy[field].slice(0, itemLimit) : copy[field].slice(-itemLimit);
      if (['blockedBy', 'references'].includes(field)) continue;
      copy[field] = copy[field].map((record, index) => {
        const entry = {};
        for (const [key, value] of Object.entries(record)) {
          if (key === 'input') {
            const json = JSON.stringify(value);
            entry.input = json.length > textLimit
              ? { jsonPreview: clip(json, `${field}[${index}].input`) } : value;
          } else {
            entry[key] = clip(value, `${field}[${index}].${key}`);
          }
        }
        return entry;
      });
    }
    return { ...copy, omitted };
  }
  while (true) {
    const context = {
      protocolVersion: protocol.version, revision: graph.revision, generation: graph.generation,
      nodeId: current.id, node: project(current), related: related.slice(0, nodeLimit).map(project),
      projection: {
        maxCharacters, omittedRelated: Math.max(0, related.length - nodeLimit),
        note: 'Clipped fields are prefixes, not summaries. Omitted counts are explicit; inspect full nodes before relying on missing evidence.',
      },
      protocol,
    };
    if (JSON.stringify(context).length <= maxCharacters) return context;
    if (textLimit > 128) textLimit = Math.max(128, Math.floor(textLimit / 2));
    else if (itemLimit > 1) itemLimit = Math.floor(itemLimit / 2);
    else if (nodeLimit > 0) nodeLimit = Math.floor(nodeLimit / 2);
    else throw new Error('Required context exceeds budget; inspect the current node');
  }
}

export function applyProposal(graph, proposal) {
  validateGraph(graph);
  assert(proposal && typeof proposal === 'object', 'Expected a proposal');
  const allowed = ['protocolVersion', 'revision', 'nodeId', 'summary', 'mutations'];
  assert(Object.keys(proposal).every(key => allowed.includes(key)), 'Unknown proposal field');
  assert(proposal.protocolVersion === protocol.version, 'Unsupported protocol version');
  assert(proposal.revision === graph.revision, 'Stale proposal revision');
  assert(runnable(graph).some(node => node.id === proposal.nodeId), 'Node is not runnable');
  text(proposal.summary, 'summary');
  assert(Array.isArray(proposal.mutations) && proposal.mutations.length > 0 && proposal.mutations.length <= 100,
    'Expected 1–100 mutations');
  const result = structuredClone(graph);
  const editable = new Set([proposal.nodeId]);
  for (const mutation of proposal.mutations) {
    assert(mutation && typeof mutation === 'object' && own(protocol.mutations, mutation.op), 'Unknown mutation');
    const shape = protocol.mutations[mutation.op];
    assert(Object.keys(mutation).every(key => own(shape, key)), 'Unknown mutation field');
    if (mutation.op === 'add') {
      assert(editable.has(mutation.parentId), 'New nodes must descend from the current node');
      assert(!result.nodes.some(node => node.id === mutation.id), 'Duplicate node ID');
      result.nodes.push(createNode(mutation.id, mutation.objective, mutation.parentId, mutation.type, mutation.context));
      editable.add(mutation.id);
      continue;
    }
    assert(editable.has(mutation.id), 'Mutation outside the current node');
    const node = result.nodes.find(item => item.id === mutation.id);
    assert(!terminal.has(node.status), 'Cannot mutate a terminal node');
    switch (mutation.op) {
      case 'depend':
        id(mutation.on);
        if (!node.blockedBy.includes(mutation.on)) node.blockedBy.push(mutation.on);
        break;
      case 'undepend':
        assert(node.blockedBy.includes(mutation.on), 'Dependency does not exist');
        node.blockedBy = node.blockedBy.filter(target => target !== mutation.on);
        break;
      case 'reference':
        id(mutation.target);
        if (!node.references.includes(mutation.target)) node.references.push(mutation.target);
        break;
      case 'evidence':
      case 'decision':
        text(mutation.text, 'record text');
        text(mutation.source, 'record source');
        node[mutation.op === 'evidence' ? 'evidence' : 'decisions'].push({
          text: mutation.text, source: mutation.source, generation: graph.generation + 1,
        });
        break;
      case 'resolve':
        text(mutation.result, 'result');
        assert(terminal.has(mutation.status ?? 'resolved'), 'Invalid resolution status');
        node.status = mutation.status ?? 'resolved';
        node.result = mutation.result;
        node.reason = null;
        break;
      case 'block':
        text(mutation.reason, 'reason');
        assert(mutation.human === undefined || typeof mutation.human === 'boolean', 'human must be boolean');
        node.status = mutation.human ? 'needs_human' : 'blocked';
        node.reason = mutation.reason;
        break;
      case 'propose':
        text(mutation.tool, 'tool');
        text(mutation.reason, 'reason');
        assert(own(mutation, 'input'), 'Missing tool input');
        node.actions.push({ tool: mutation.tool, input: mutation.input, reason: mutation.reason, status: 'proposed' });
        node.status = 'needs_human';
        node.reason = mutation.reason;
        break;
    }
  }
  assert(JSON.stringify(result.nodes) !== JSON.stringify(graph.nodes), 'Proposal makes no progress');
  result.nodes.find(node => node.id === proposal.nodeId).attempts++;
  result.generation++;
  result.revision++;
  result.history.push({
    generation: result.generation, revision: result.revision, nodeId: proposal.nodeId,
    outcome: 'applied', proposal: structuredClone(proposal),
  });
  return validateGraph(result);
}

export function humanUpdate(graph, nodeId, message, answer = false) {
  validateGraph(graph);
  text(message, 'human input');
  const result = structuredClone(graph);
  const node = result.nodes.find(item => item.id === nodeId);
  assert(node && ['blocked', 'needs_human'].includes(node.status), 'Node is not blocked');
  assert(!answer || node.type === 'question', 'Only question nodes accept answers; resume tasks with evidence');
  node.status = answer ? 'resolved' : 'ready';
  node.reason = null;
  node.result = answer ? message : null;
  node.evidence.push({ text: message, source: 'human', generation: graph.generation });
  result.revision++;
  result.history.push({ revision: result.revision, nodeId, outcome: answer ? 'answered' : 'resumed', message });
  return validateGraph(result);
}
