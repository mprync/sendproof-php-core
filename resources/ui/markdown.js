// A small, safe CommonMark subset for OpenAPI descriptions: paragraphs, bullet and numbered
// lists, headings, GitHub tables, **bold**, *emphasis*, `code` and http(s) links. Everything else
// is escaped.
import { esc } from './components.js';

/** Inline markup only, for one-line descriptions. */
export function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a class="link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/** A table's delimiter row, such as `| --- | :---: |`. */
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A table row's cells: outer pipes dropped, split on pipes that aren't escaped (`\|`). */
function cells(line) {
  const row = line.trim().replace(/^\|/, '').replace(/(^|[^\\])\|$/, '$1');
  return row.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

/** A GitHub table: header, delimiter row (which sets each column's alignment) and body rows. */
function table(lines) {
  const head = cells(lines[0]);
  const align = cells(lines[1]).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'end' : '');
  const cell = (tag, text, index) => `<${tag}${align[index] ? ` style="text-align:${align[index]}"` : ''}>${inline(text ?? '')}</${tag}>`;
  const body = lines.slice(2).map(line => { const row = cells(line); return `<tr>${head.map((_, index) => cell('td', row[index], index)).join('')}</tr>`; }).join('');
  return `<div class="md-table"><table><thead><tr>${head.map((text, index) => cell('th', text, index)).join('')}</tr></thead>${body ? `<tbody>${body}</tbody>` : ''}</table></div>`;
}

/** Block markup: paragraphs, lists, headings and tables. */
export function markdown(text) {
  const blocks = String(text ?? '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  return blocks.map(block => {
    const lines = block.split('\n');
    // A table may follow a paragraph's lines without a blank line between them.
    const delimiter = lines.findIndex((line, index) => index > 0 && line.includes('-') && DELIMITER.test(line) && lines[index - 1].includes('|'));
    if (delimiter > 0) {
      const before = lines.slice(0, delimiter - 1);
      return `${before.length ? `<p>${before.map(inline).join(' ')}</p>` : ''}${table(lines.slice(delimiter - 1))}`;
    }
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
