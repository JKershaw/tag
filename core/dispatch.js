import { seed, applyProposal, buildContext, nextNode, explain } from './graph.js';

export const defaultLimits = Object.freeze({
  maxGenerations: 5, maxCostUsd: 0.10, concurrency: 1, maxRetries: 1,
  minDelayMs: 3000, maxOutputTokens: 1536, maxNodes: 25,
});

export function executionLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !Object.hasOwn(defaultLimits, key))) throw new Error('Unknown execution limit');
  const limits = { ...defaultLimits, ...input };
  for (const [key, min, max] of [
    ['maxGenerations', 1, 15], ['concurrency', 1, 1], ['maxRetries', 0, 1],
    ['minDelayMs', 3000, 60000], ['maxOutputTokens', 128, 2048], ['maxNodes', 1, 25],
  ]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max) {
      throw new Error(`Invalid ${key}: allowed range ${min}..${max}`);
    }
  }
  if (typeof limits.maxCostUsd !== 'number' || !Number.isFinite(limits.maxCostUsd)
    || limits.maxCostUsd < 0 || limits.maxCostUsd > 0.10) throw new Error('maxCostUsd must be between 0 and 0.10');
  return limits;
}

const terminal = new Set(['resolved', 'partially_resolved', 'failed']);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const maxGraphBytes = 1024 * 1024;
const size = value => new TextEncoder().encode(JSON.stringify(value)).length;

// The provider and store are trusted host capabilities, never model-supplied.
export async function dispatchRun(task, { store, provider, wait = sleep, now = () => performance.now() }) {
  if (!task || typeof task !== 'object' || Array.isArray(task)
    || Object.keys(task).some(key => !['objective', 'context', 'limits'].includes(key))
    || typeof task.objective !== 'string' || !task.objective.trim() || task.objective.length > 4000
    || (task.context !== undefined && (typeof task.context !== 'string' || task.context.length > 16000))) {
    throw new Error('Expected { objective: text (1..4000), context?: text (0..16000), limits?: object }');
  }
  const limits = executionLimits(task.limits);
  if (await store.load()) throw new Error('Dispatch requires an empty store; runs cannot be restarted or reused');
  let graph = seed(task.objective, task.context ?? '');
  graph.run = {
    limits, model: provider.model, provider: provider.name, maxGraphBytes,
    routingPolicy: structuredClone(provider.routingPolicy ?? null),
    usage: { generations: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      knownCostUsd: 0, costUsd: 0, accountingComplete: true, reservedCostUsd: 0 },
    pricing: { status: 'unknown', reason: 'not_checked' },
    attempts: [], stoppingReason: null,
  };
  await store.save(graph);
  async function save(updated) {
    await store.save(updated, graph.revision);
    graph = updated;
  }
  async function stop(reason) {
    const updated = structuredClone(graph);
    updated.revision++;
    updated.run.stoppingReason = reason;
    const root = updated.nodes[0];
    const blockers = updated.nodes.filter(node => !terminal.has(node.status)).map(node => explain(updated, node.id));
    if (!terminal.has(root.status)) {
      root.status = updated.nodes.some(node => terminal.has(node.status)) ? 'partially_resolved' : 'failed';
      root.result = `Execution stopped: ${reason}. No complete root synthesis is available.`;
      root.reason = reason;
    }
    const outcome = {
      status: root.status, result: root.result,
      evidence: root.evidence, blockers,
      usage: updated.run.usage, stoppingReason: reason,
    };
    updated.history.push({ revision: updated.revision, generation: updated.generation, nodeId: root.id,
      outcome: 'stopped', stoppingReason: reason });
    await save(updated);
    return outcome;
  }
  if (limits.maxCostUsd === 0) return stop('budget_exhausted');
  async function verify() {
    try {
      graph.run.pricing = await provider.verify();
    } catch {
      graph.run.pricing = { status: 'unknown', reason: 'verification_error' };
    }
    if (!['known_free', 'known_priced', 'unknown'].includes(graph.run.pricing?.status)) {
      graph.run.pricing = { status: 'unknown', reason: 'invalid_verification' };
    }
    graph.run.routingPolicy = structuredClone(provider.routingPolicy ?? null);
    return graph.run.pricing.status === 'known_free'
      || (graph.run.pricing.status === 'known_priced' && graph.run.pricing.paidInference === true
        && typeof provider.reserve === 'function');
  }
  if (!await verify()) {
    graph.run.preflightError = 'Pricing is unknown or not authorized for inference; see run.pricing';
    return stop('provider_preflight_failed');
  }
  let lastFinished = null;
  let retries = 0;
  let retryDelay = 0;
  while (true) {
    if (terminal.has(graph.nodes[0].status)) return stop('root_terminal');
    const node = nextNode(graph);
    if (!node) return stop('no_runnable_nodes');
    if (graph.run.usage.knownCostUsd >= limits.maxCostUsd) return stop('budget_exhausted');
    if (graph.run.usage.generations >= limits.maxGenerations) return stop('generation_exhausted');
    if (lastFinished !== null) {
      await wait(Math.ceil(Math.max(0, Math.max(limits.minDelayMs, retryDelay) - (now() - lastFinished))));
      if (!await verify()) return stop('provider_preflight_failed');
    }
    const pending = structuredClone(graph);
    pending.revision++;
    pending.run.usage.generations++;
    const context = buildContext(pending, node.id);
    const remainingUsd = limits.maxCostUsd - pending.run.usage.knownCostUsd;
    let reservation = null;
    if (graph.run.pricing.status === 'known_priced') {
      try { reservation = provider.reserve(context, limits.maxOutputTokens, remainingUsd); } catch {}
      if (!reservation || !Number.isFinite(reservation.costUsd) || reservation.costUsd <= 0
        || reservation.costUsd > remainingUsd) return stop('reservation_unavailable');
    }
    // Persist before I/O; uncertain responses never release the reservation.
    pending.run.usage.reservedCostUsd = reservation?.costUsd ?? remainingUsd;
    pending.run.usage.accountingComplete = false;
    pending.run.usage.costUsd = null;
    pending.run.attempts.push({
      generation: pending.run.usage.generations, nodeId: node.id,
      model: provider.model, provider: provider.name, status: 'pending',
      requestedModel: provider.model, actualModel: null,
      requestedProvider: provider.name, actualProvider: null,
      routingPolicy: structuredClone(provider.routingPolicy ?? null),
      pricing: structuredClone(graph.run.pricing),
      reservedCostUsd: pending.run.usage.reservedCostUsd,
      reservation: structuredClone(reservation),
      startedAt: new Date().toISOString(), retry: retries,
    });
    await save(pending);
    let response;
    try {
      response = await provider.generate(context, limits.maxOutputTokens, reservation);
    } catch {
      response = { error: 'provider_transport_error', uncertain: true };
    }
    lastFinished = now();
    let updated = structuredClone(graph);
    const attempt = updated.run.attempts.at(-1);
    Object.assign(attempt, {
      status: 'rejected', finishedAt: new Date().toISOString(),
      model: response.model ?? provider.model, provider: response.provider ?? provider.name,
      actualModel: response.model ?? null,
      actualProvider: response.provider ?? null,
      reportedCostUsd: response.reportedCostUsd ?? response.usage?.costUsd ?? null,
      usage: response.usage ?? null, error: response.error ?? null, httpStatus: response.httpStatus ?? null,
    });
    const usage = updated.run.usage;
    if (response.usage && (!['promptTokens', 'completionTokens', 'totalTokens'].every(
      key => Number.isSafeInteger(response.usage[key]) && response.usage[key] >= 0)
      || response.usage.totalTokens !== response.usage.promptTokens + response.usage.completionTokens
      || !Number.isFinite(response.usage.costUsd) || response.usage.costUsd < 0)) {
      response.usage = null;
      response.error = 'usage_unavailable';
    }
    if (response.usage) {
      usage.promptTokens += response.usage.promptTokens;
      usage.completionTokens += response.usage.completionTokens;
      usage.totalTokens += response.usage.totalTokens;
      usage.knownCostUsd += response.usage.costUsd;
      usage.costUsd = usage.knownCostUsd;
      usage.accountingComplete = true;
      usage.reservedCostUsd = 0;
    } else if (response.unbilled === true) {
      usage.reservedCostUsd = 0;
      usage.accountingComplete = true;
      usage.costUsd = usage.knownCostUsd;
    } else {
      usage.accountingComplete = false;
      usage.costUsd = null;
      response.error ??= 'usage_unavailable';
      attempt.error = response.error;
    }
    attempt.reconciledCostUsd = response.usage?.costUsd ?? (response.unbilled === true ? 0 : null);
    attempt.releasedCostUsd = usage.accountingComplete
      ? Math.max(0, attempt.reservedCostUsd - attempt.reconciledCostUsd) : 0;
    let reason = response.error;
    if (graph.run.pricing.status === 'known_free' && attempt.reportedCostUsd > 0) reason = 'pricing_violation';
    else if (attempt.reportedCostUsd > attempt.reservedCostUsd) reason = 'reservation_violation';
    if (!reason) {
      try {
        if (response.proposal?.nodeId !== node.id) throw new Error('wrong_node');
        if (graph.nodes.length + (response.proposal?.mutations?.filter(m => m.op === 'add').length ?? 0) > limits.maxNodes) {
          reason = 'graph_limit';
        } else {
          const applied = applyProposal(updated, response.proposal);
          if (size(applied) > maxGraphBytes - 16384) reason = 'graph_limit';
          else {
            updated = applied;
            updated.run.attempts.at(-1).status = 'applied';
          }
        }
      } catch {
        reason = 'invalid_proposal';
      }
    }
    if (reason) {
      updated.revision++;
      updated.generation++;
      updated.nodes.find(item => item.id === node.id).attempts++;
      updated.run.attempts.at(-1).error = reason;
      updated.history.push({ revision: updated.revision, generation: updated.generation,
        nodeId: node.id, outcome: 'rejected', error: reason });
    }
    await save(updated);
    if (reason) {
      if (response.unbilled === true && ['rate_limited', 'provider_unavailable'].includes(reason)
        && retries < limits.maxRetries && response.retryAfterMs !== null) {
        retries++;
        retryDelay = response.retryAfterMs ?? 0;
        continue;
      }
      return stop(reason);
    }
    retries = 0;
    retryDelay = 0;
  }
}
