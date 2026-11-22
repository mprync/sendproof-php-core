// A small, safe CommonMark subset for OpenAPI descriptions: paragraphs, bullet and numbered
// lists, headings, **bold**, *emphasis*, `code` and http(s) links. Everything else is escaped.
import { esc } from './components.js';

/** Inline markup only, for one-line descriptions. */
export function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a class="link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/** Block markup: paragraphs, lists and headings. */
export function markdown(text) {
  const blocks = String(text ?? '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  return blocks.map(block => {
    const lines = block.split('\n');
    if (lines.every(line => /^\s*[-*+]\s+/.test(line))) return `<ul>${lines.map(line => `<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`).join('')}</ul>`;
    if (lines.every(line => /^\s*\d+[.)]\s+/.test(line))) return `<ol>${lines.map(line => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
    if (heading && lines.length === 1) return `<h4>${inline(heading[2])}</h4>`;
    return `<p>${lines.map(inline).join(' ')}</p>`;
  }).join('');
}

/**
 * Descriptions often name another operation by its operationId (`BalancesController.Get`). This
 * turns each such code span into a link with the operation's method and name: "GET Get balance".
 * `ops` are the discovered operations; `view` is 'docs' or 'op' for the link's route.
 */
export function linkOperationIds(html, ops, view = 'docs') {
  return html.replace(/<code>([A-Za-z_][\w.-]*)<\/code>/g, (match, id) => {
    const index = ops.findIndex(op => op.operation?.operationId === id);
    if (index < 0) return match;
    const op = ops[index];
    return `<a class="op-ref" href="#${view}/${encodeURIComponent(id)}" data-op="${index}"${view === 'docs' ? ' data-op-view="docs"' : ''} title="${esc(id)}"><span class="method m-${esc(op.method.toLowerCase())}">${esc(op.method.toUpperCase())}</span><span lang="en">${esc(op.title)}</span></a>`;
  });
}
