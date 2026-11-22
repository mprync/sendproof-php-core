// The JSON viewer shared by response bodies, examples and JSON Schema views. A value becomes
// logical lines (with fold ids), every object and array starts open, and only a very large body
// (over LARGE_LINES lines) starts collapsed below the second level, with a note saying so.
// A collapsed node shows its size and, when it has one, a label: "5 keys · PAY-2026-0042".
// Port of mocks/schema.js (jsonLines, jsonView).
import { esc, icon } from './components.js';
import { formatBytes, formatNumber, t } from './i18n.js';
// Importing it installs the copy handler that keeps line numbers out of copied code.
import './code-copy.js';

/** Bodies with more lines than this start collapsed below the second level. */
export const LARGE_LINES = 2000;

const token = (text, kind) => ({ text, kind });
const punctuation = text => token(text, 'p');
const scalar = (value, source) => token(source ?? JSON.stringify(value), typeof value === 'string' ? 's' : typeof value === 'number' ? 'n' : 'b');
/** The id of a path in the line model. */
export const pathId = path => JSON.stringify(path);
const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined;

/** A short name for a collapsed object: its number, name, reference, display name, IBAN or id. */
export function labelOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const key of ['number', 'name', 'reference', 'displayName', 'iban', 'id']) {
    const found = own(value, key);
    if (typeof found === 'string' && found.trim() || typeof found === 'number') return String(found).trim().slice(0, 32);
  }
  return '';
}

/**
 * Turns a parsed JSON value into logical lines. Each line is `{ id, depth, path, ancestors,
 * tokens, folded?, fold?, copy? }`. `branches` are the ids of foldable nodes (every object and
 * array below the root); `initiallyFolded` is empty unless the body is large.
 *
 * @param {{ body: unknown, numbers?: WeakMap<object, Map<string,string>>, rootNumber?: string }} content
 */
export function buildJsonLines({ body, numbers, rootNumber }) {
  const lines = [];
  const branches = new Set();
  function visit(value, source, depth, path, ancestors, key, last) {
    const before = key === undefined ? [] : [token(JSON.stringify(key), 'k'), punctuation(': ')];
    const after = last ? [] : [punctuation(',')];
    const id = pathId(path);
    const copy = depth ? { value, source } : undefined;
    if (value === null || typeof value !== 'object') {
      lines.push({ id, depth, path, ancestors, tokens: [...before, scalar(value, source), ...after], copy });
      return;
    }
    const list = Array.isArray(value);
    const entries = Object.entries(value);
    const open = punctuation(list ? '[' : '{');
    const close = punctuation(list ? ']' : '}');
    const first = entries[0]?.[1];
    // Empty containers and one-scalar arrays are a single line with nothing to fold.
    if (!entries.length || (list && entries.length === 1 && (first === null || typeof first !== 'object') && JSON.stringify(value).length <= 80)) {
      const contents = entries.length ? [scalar(first, numbers?.get(value)?.get('0'))] : [];
      lines.push({ id, depth, path, ancestors, tokens: [...before, open, ...contents, close, ...after], copy });
      return;
    }
    const label = labelOf(value);
    const summary = t(list ? 'resp.summary.items' : 'resp.summary.keys', { n: entries.length });
    // The root can fold too, but Collapse all leaves it open (so something stays visible).
    const fold = true;
    if (depth > 0) branches.add(id);
    const folded = [...before, open, token(summary + (label ? ` · ${label}` : ''), 'folded'), close, ...after];
    lines.push({ id, depth, path, ancestors, tokens: [...before, open], folded, fold, copy });
    const parents = [...ancestors, id];
    entries.forEach(([name, entry], index) =>
      visit(entry, numbers?.get(value)?.get(name), depth + 1, [...path, name], parents, list ? undefined : name, index === entries.length - 1));
    lines.push({ id: id + ':end', depth, ancestors: parents, tokens: [close, ...after] });
  }
  visit(body, rootNumber, 0, [], [], undefined, true);
  const large = lines.length > LARGE_LINES;
  // Large bodies open the root and its direct children and fold everything deeper.
  const initiallyFolded = new Set(large ? lines.filter(line => line.fold && line.depth >= 2).map(line => line.id) : []);
  return { lines, branches, initiallyFolded, large };
}

/** HTML for a token list. `folded` tokens are the small "N keys" badge. */
export const tokensHtml = tokens => tokens.map(({ text, kind }) => kind ? `<span class="${kind === 'folded' ? kind : 'tok-' + kind}">${esc(text)}</span>` : esc(text)).join('');

/**
 * One line of a code view: line number, fold button (only for foldable nodes), the source and
 * optional actions. `html` is the already-marked-up source (search marks, tokens).
 */
export function codeLine(line, number, folded, html, actions = '', { cls = '', note = '' } = {}) {
  const fold = line.fold
    ? `<button type="button" class="fold" data-fold-line="${esc(line.id)}" aria-label="${esc(t(folded ? 'resp.expandName' : 'resp.collapseName', { name: line.path.at(-1) ?? t('json.root') }))}" aria-expanded="${!folded}">${icon(folded ? 'chevron-right' : 'chevron-down', true)}</button>`
    : '<span></span>';
  // The number is drawn by CSS from data-n (.ln .no::before), so it is not text: selecting or
  // copying lines can never pick it up, in Selection.toString() as well as in the clipboard.
  // A line the schema check flagged carries a quiet reason at its end (mock 101).
  return `<div class="ln${cls ? ' ' + cls : ''}"><span class="no" data-n="${formatNumber(number, { useGrouping: false })}" aria-hidden="true"></span>${fold}<code class="src" style="--d:${line.depth}">${html}${note ? `<span class="ln-note">${icon('warn', true)}${esc(note)}</span>` : ''}</code>${actions}</div>`;
}

/** The note shown above a large body. */
export const largeNote = (bytes, lines) => `<div class="inline-note flush large-note" role="note">${icon('info', true)}<span>${esc(t('json.large', { size: formatBytes(bytes), n: formatNumber(lines) }))}</span></div>`;

/** Visible lines for a fold set: a line is hidden when any ancestor is folded. */
export const visibleLines = (lines, folded) => lines.filter(line => !line.ancestors.some(id => folded.has(id)));

const views = new Map();
const bound = new WeakSet();
let viewCounter = 0;

/**
 * A read-only JSON viewer for examples and JSON Schema. Returns `{ html, lines, large }`; call
 * {@link bindJsonViews} on a container once `html` is in the document. The viewer starts with
 * every node open unless the value is large (see LARGE_LINES).
 */
export function jsonView(value, { label = 'JSON' } = {}) {
  const model = buildJsonLines({ body: value });
  const key = `json${++viewCounter}`;
  const folded = new Set(model.initiallyFolded);
  views.set(key, { model, folded });
  const bytes = JSON.stringify(value)?.length ?? 0;
  return {
    key, lines: model.lines.length, large: model.large, foldable: model.branches.size > 0,
    html: `<div data-json-view="${key}" data-json-label="${esc(label)}">${model.large ? largeNote(bytes, model.lines.length) : ''}${viewHtml(model, folded, label)}</div>`,
  };
}

function viewHtml(model, folded, label) {
  const lines = visibleLines(model.lines, folded);
  return `<div class="code-view ltr" role="group" aria-label="${esc(label)}">${lines.map((line, index) =>
    codeLine(line, index + 1, folded.has(line.id), tokensHtml(folded.has(line.id) ? line.folded : line.tokens))).join('')}</div>`;
}

/** Wires folding for every static viewer under a container. */
export function bindJsonViews(container) {
  for (const element of container.querySelectorAll('[data-json-view]')) {
    const entry = views.get(element.dataset.jsonView);
    if (!entry) continue;
    views.delete(element.dataset.jsonView);
    element.jsonView = entry;
  }
  if (bound.has(container)) return;
  bound.add(container);
  container.addEventListener('click', event => {
    const button = event.target.closest?.('[data-fold-line]');
    const element = button?.closest('[data-json-view]');
    if (!element?.jsonView) return;
    const { folded } = element.jsonView;
    const id = button.dataset.foldLine;
    if (folded.has(id)) folded.delete(id); else folded.add(id);
    redraw(element);
    element.querySelector(`[data-fold-line="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  });
}

function redraw(element) {
  const { model, folded } = element.jsonView;
  element.querySelector('.code-view').outerHTML = viewHtml(model, folded, element.dataset.jsonLabel);
}

/** Whether any foldable node of a static viewer is collapsed (the button then says Expand all). */
export const hasCollapsed = element => !!element?.jsonView && element.jsonView.folded.size > 0;

/** Collapses (`collapse` true) or expands every foldable node of a static viewer. */
export function setAllFolded(element, collapse) {
  const entry = element?.jsonView;
  if (!entry) return;
  entry.folded = new Set(collapse ? entry.model.branches : []);
  redraw(element);
}
