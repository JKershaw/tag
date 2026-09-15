import { validateGraph, explain, nextNode } from './graph.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const plain = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

export function renderGraph(graph, { html = false } = {}) {
  validateGraph(graph);
  const root = graph.nodes.find(node => node.parentId === null);
  const next = nextNode(graph)?.id ?? 'none';
  const children = id => graph.nodes.filter(node => node.parentId === id);
  const state = node => {
    const explanation = explain(graph, node.id);
    if (explanation.runnable) return 'ready · runnable';
    const waiting = [
      explanation.prerequisites.length ? 'waiting for prerequisites' : '',
      explanation.children.length ? 'waiting for children' : '',
    ].filter(Boolean);
    return [node.status, ...waiting].join(' · ');
  };
  const summary = `${graph.nodes.length} nodes · revision ${graph.revision} · generation ${graph.generation} · next: ${next}`;
  const run = graph.run
    ? `${graph.run.mode === 'plan' ? 'One-shot planning' : 'Dispatch'} · stopped: ${graph.run.stoppingReason ?? 'pending'}`
    : root.context.startsWith('OFFLINE REPLAY:')
      ? 'OFFLINE REPLAY · recorded proposal, not fresh inference or completed implementation'
      : 'Graph snapshot · see context and evidence for provenance';
  if (!html) {
    const lines = [plain(root.objective), summary, run,
      'Nested nodes = decomposition; depends on = prerequisites; references = context links.', ''];
    function visit(node, prefix = '', branch = '') {
      lines.push(`${prefix}${branch}${node.id} [${node.type} · ${state(node)}] ${plain(node.objective)}`);
      const indent = prefix + (branch ? '   ' : '');
      for (const [label, value] of [
        ['Depends on', node.blockedBy.join(', ')], ['References', node.references.join(', ')],
        ['Reason', node.reason], ['Context', node.context], ['Result', node.result],
      ]) if (value) {
        const preview = plain(value);
        lines.push(`${indent}  ${label}: ${preview.slice(0, 600)}`
          + (preview.length > 600 ? ` … [clipped; inspect ${node.id} for full text]` : ''));
      }
      for (const field of ['evidence', 'decisions', 'actions']) {
        for (const record of node[field]) {
          lines.push(`${indent}  ${field}: ${plain(record.text ?? JSON.stringify(record))}`
            + (record.source ? ` (source: ${plain(record.source)})` : ''));
        }
      }
      const descendants = children(node.id);
      descendants.forEach((child, index) => visit(child, indent, index === descendants.length - 1 ? '└─ ' : '├─ '));
    }
    visit(root);
    return lines.join('\n');
  }
  const link = id => `<a href="#node-${escape(id)}">${escape(id)}</a>`;
  function visit(node) {
    const records = ['evidence', 'decisions', 'actions'].map(field => node[field].length
      ? `<h4>${escape(field)}</h4><ul>${node[field].map(record => `<li><pre>${escape(record.text ?? JSON.stringify(record, null, 2))}</pre>`
        + (record.source ? `<small>Source: ${escape(record.source)}</small>` : '') + '</li>').join('')}</ul>` : '').join('');
    const descendants = children(node.id);
    return `<li id="node-${escape(node.id)}"><article>
      <h3>${escape(node.objective)}</h3>
      <p class="meta"><code>${escape(node.id)}</code> · ${escape(node.type)} · <strong>${escape(state(node))}</strong></p>
      ${node.blockedBy.length ? `<p>Depends on → ${node.blockedBy.map(link).join(', ')}</p>` : ''}
      ${node.references.length ? `<p>References → ${node.references.map(link).join(', ')}</p>` : ''}
      ${node.reason ? `<p class="reason">${escape(node.reason)}</p>` : ''}
      ${node.result ? `<h4>Result</h4><pre>${escape(node.result)}</pre>` : ''}
      <details><summary>Context, evidence &amp; decisions</summary>
        <pre>${escape(node.context || 'No additional context.')}</pre>${records}
      </details></article>
      ${descendants.length ? `<ul>${descendants.map(visit).join('')}</ul>` : ''}</li>`;
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>TAG — ${escape(root.objective)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;background:#f3f6fa;color:#162536;max-width:1100px;margin:auto;padding:24px}
h1{margin-bottom:4px}h3{margin:0}h4{margin-bottom:4px}a{color:#165a9d}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
.tree,.tree ul{list-style:none;padding-left:24px;border-left:2px solid #aebed0}.tree{padding:0;border:0}
article{background:white;border:1px solid #c6d2df;border-radius:8px;padding:16px;margin:12px 0}
li:target>article{outline:3px solid #246db5}.meta,small{color:#455b71}.reason{border-left:4px solid #986800;padding-left:12px}
summary{cursor:pointer;color:#165a9d}header,footer{padding:12px 0}code{font-weight:bold}
@media(max-width:600px){body{padding:12px}.tree ul{padding-left:12px}}
</style></head><body>
<header><p>TAG · Objective → research → task graph</p><h1>${escape(root.objective)}</h1>
<p>${escape(summary)}</p><p>${escape(run)}</p>
<p>Nested cards show decomposition. “Depends on” links show execution order; “References” links connect supporting context.
Click a link to highlight its node. Expand a card to inspect rationale, acceptance criteria, and evidence.</p>
<p>Next runnable node: ${next === 'none' ? 'none' : link(next)}. This view does not execute work.
Evidence records are provenance claims, not independently verified proof.</p></header>
<main><ul class="tree">${visit(root)}</ul></main>
<footer><details><summary>Run accounting and transition history</summary>
<pre>${escape(JSON.stringify({ run: graph.run ?? null, history: graph.history }, null, 2))}</pre>
</details></footer></body></html>`;
}
