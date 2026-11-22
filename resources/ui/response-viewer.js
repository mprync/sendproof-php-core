// The Response tab's viewer (mocks 100–106, 111, m22): follow-ups and timing, then one viewer
// with a one-line toolbar (Pretty, Raw, Table, Schema at the start; icon actions at the end) and
// a body that never wraps. Pretty keeps its line numbers and folds sticky while long lines scroll
// sideways; Raw is the bytes as received with an optional Wrap; Table is a real table with a
// sticky header, row numbers and name column; Schema is the attribute list in compact rows with
// a presence mark at each line's end. The schema match lives in the result's status line
// (matchButton), with a toggletip that lists every issue.
import { copyButton, copyTextButton, esc, icon, method } from './components.js';
import { bindTrees, propertyTree } from './schema-tree.js';
import { buildJsonLines, codeLine, largeNote, pathId, visibleLines } from './json-view.js';
import { copyText } from './copy.js';
import { formatBytes, formatDuration, formatNumber, t, th } from './i18n.js';
import { shortcutAttrs, shortcutHint } from './shortcuts.js';
import { closePopover, openPopover, openPopoverAt } from './popover.js';
import {
  responseDefinition, responseFollowUps, responseMediaType, responseSchema, responseTimings,
} from './response-metadata.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined;
const token = (text, kind) => ({ text, kind });
const findAction = 'find-response';
const copyAction = 'copy-response';
const followAction = 'follow-response';
const bindings = new WeakMap();

function jsonContent(raw) {
  const numbers = new WeakMap();
  let rootNumber;
  // Preserve the wire spelling of decimals and large numbers where the browser supplies it.
  const body = JSON.parse(raw, function (key, value, context) {
    rootNumber = typeof value === 'number' ? context?.source : undefined;
    if (rootNumber !== undefined) {
      if (!numbers.has(this)) numbers.set(this, new Map());
      numbers.get(this).set(key, rootNumber);
    }
    return value;
  });
  return { body, raw, json: true, numbers, rootNumber };
}

function bodyContent(result) {
  const mediaType = responseMediaType(result);
  const body = result.body;
  const jsonType = mediaType.endsWith('/json') || mediaType.endsWith('+json');
  if (typeof result.raw === 'string') {
    if (result.raw === '') return { mediaType };
    if (jsonType || !mediaType) {
      try { return { ...jsonContent(result.raw), mediaType }; }
      catch { /* Malformed or non-JSON bodies remain inspectable as text. */ }
    }
    return { body: result.raw, raw: result.raw, json: false, malformed: jsonType, mediaType };
  }
  if (body === undefined || (body === null && (!jsonType || [204, 205, 304].includes(result.status))) || (body === '' && !jsonType)) {
    return { mediaType };
  }
  const json = jsonType || typeof body !== 'string';
  return { body, raw: json ? JSON.stringify(body, null, 2) : body, json, mediaType };
}

function titleOf(operation) {
  return operation.title ?? operation.operation?.summary ?? operation.method + ' ' + operation.path;
}

function followUpMarkup(followUps) {
  if (!followUps.length) return '';
  const names = new Set(followUps.flatMap(item => item.paths.map(path => path.at(-1))));
  const intro = names.size === 1 && [...names][0] !== undefined
    ? th('resp.useNameIn', { name: `<code>${esc([...names][0])}</code>` }) : esc(t('resp.useResultIn'));
  const buttons = followUps.map(({ operation, name }, index) => {
    const secured = operation.operation?.security?.some(item => Object.values(item).some(scopes => scopes.length));
    const permission = secured ? `<span class="faint">${icon('lock', true)}<span class="sr-only">${esc(t('resp.needsPermission'))}</span></span>` : '';
    return `<button type="button" class="chain" data-follow-up="${index}"${name ? ` title="${esc(name)}"` : ''} ${index === 0 ? shortcutAttrs(followAction) : ''}>${method(operation.method)}<span>${esc(titleOf(operation))}</span>${permission}${index === 0 ? shortcutHint(followAction) : ''}</button>`;
  }).join('');
  return `<div class="next-steps" role="group" aria-label="${esc(t('resp.useResult'))}"><span class="faint">${intro}</span>${buttons}</div>`;
}

function timingMarkup(result) {
  const metrics = responseTimings(result);
  if (!metrics.length) return '';
  const total = metrics.reduce((sum, metric) => sum + metric.duration, 0);
  const bar = total > 0 ? `<div class="timing-bar" aria-hidden="true">${metrics.filter(metric => metric.duration > 0).map(metric =>
    `<span style="flex:${metric.duration};background:${metric.color}"></span>`).join('')}</div>` : '';
  const legend = metrics.map(({ label, color, duration, description }) =>
    `<span><i style="background:${color}" aria-hidden="true"></i>${esc(label)} ${esc(formatDuration(duration))}${description ? ' · ' + esc(description) : ''}</span>`).join('');
  return `<div class="timing" role="group" aria-label="${esc(t('resp.timingTotal', { n: Math.round(total) }))}">${bar}<div class="timing-legend">${legend}</div></div>`;
}

function validationMarkup(result, body) {
  if (!(result.status >= 400) || !object(body?.errors)) return '';
  const fields = Object.keys(body.errors).length;
  const detail = typeof body.detail === 'string' ? body.detail
    : fields ? t('resp.fieldsNeedAttention', { n: fields }) : '';
  return `<div class="effect">${icon('alert', true)}<div><div class="t">${esc(t('resp.validationProblem'))}</div>${detail ? `<div class="s">${esc(detail)}</div>` : ''}</div></div>`;
}

/** Keys whose values name a record; the first one present leads the table and stays in view. */
const LABEL_KEYS = ['name', 'title', 'label', 'displayName', 'reference', 'number'];

/**
 * The Table view's model. A list (an array of objects, or a page object with one) is a table
 * of its items, its columns in first-seen order with the record's label first; any other
 * object is a Field / Value table.
 */
function tableRows(body, numbers, labelField) {
  const text = (row, key) => {
    const value = own(row, key);
    if (value !== null && typeof value === 'object') return { nested: Array.isArray(value) ? t('resp.summary.items', { n: value.length }) : t('resp.summary.keys', { n: Object.keys(value).length }) };
    if (value === null) return { text: 'null', null: true };
    return { text: numbers?.get(row)?.get(key) ?? (typeof value === 'string' ? value : JSON.stringify(value) ?? '') , number: typeof value === 'number' };
  };
  const listKey = object(body) ? Object.keys(body).find(key => Array.isArray(body[key]) && body[key].length && body[key].every(object)) : undefined;
  const items = Array.isArray(body) ? body : listKey !== undefined ? body[listKey] : undefined;
  if (items?.length && items.every(object)) {
    const columns = [...new Set(items.flatMap(Object.keys))];
    const lead = [labelField, ...LABEL_KEYS].find(key => key && columns.includes(key));
    if (lead) columns.splice(columns.indexOf(lead), 1), columns.unshift(lead);
    const rows = items.map(row => columns.map(key => Object.hasOwn(row, key) ? text(row, key) : { text: '', missing: true }));
    const numeric = new Set(columns.filter((key, column) => rows.every(row => row[column].number || row[column].null || row[column].missing)));
    const pageOf = key => typeof own(body, key) === 'number' ? own(body, key) : undefined;
    const page = object(body) ? { page: pageOf('page'), pages: pageOf('totalPages'), total: pageOf('totalItems') ?? pageOf('total') } : {};
    return { list: true, path: listKey ?? '', headings: columns, rows, numeric, lead: !!lead, page, basePath: listKey !== undefined ? [listKey] : [] };
  }
  if (object(body) && Object.keys(body).length) {
    return { list: false, headings: [t('resp.table.field'), t('resp.table.value')], rows: Object.keys(body).map(key => [{ text: key }, text(body, key)]), fields: true, numeric: new Set(), basePath: [] };
  }
}

function responseModel(result, context) {
  const content = bodyContent(result);
  const definition = responseDefinition(result, context);
  const followUps = responseFollowUps(result, context, definition, content.body);
  const pretty = content.json ? buildJsonLines(content) : undefined;
  const table = content.json ? tableRows(content.body, content.numbers) : undefined;
  const contentType = Object.entries(result.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? (typeof result.headers?.get === 'function' ? result.headers.get('content-type') : undefined);
  const rawLines = content.raw?.split(/\r\n|\n|\r/).map((text, index) => ({
    id: 'raw-' + index, depth: 0, ancestors: [], tokens: [token(text)],
  }));
  const schema = !content.malformed && responseSchema(result, context, definition, content.body);
  const firstLineFollowUps = new Map();
  for (const [index, item] of followUps.entries()) {
    for (const path of item.paths) {
      const key = pathId(path);
      if (!firstLineFollowUps.has(key)) firstLineFollowUps.set(key, index);
    }
  }
  return { ...content, followUps, pretty, table, rawLines, schema, firstLineFollowUps, contentType, lineIssues: schema && pretty ? issueLines(pretty.lines, schema) : undefined };
}

/**
 * Pretty's issue marks (mock 101): each issue on the line of its value; a missing property on
 * the line that opens its parent object.
 */
function issueLines(lines, check) {
  const marks = new Map();
  const ids = new Set(lines.map(line => line.id));
  for (const issue of check.issues || []) {
    const path = String(issue.path ?? '').split('.').filter(Boolean);
    let id = pathId(path);
    while (!ids.has(id) && path.length) { path.pop(); id = pathId(path); }
    if (!marks.has(id)) marks.set(id, issue.message);
  }
  return marks;
}

function initialState(model) {
  return {
    mode: model.pretty ? 'pretty' : 'raw',
    wrap: false,
    folded: new Set(model.pretty?.initiallyFolded),
    matches: [],
    byLine: new Map(),
    active: -1,
  };
}

function renderToken(text, kind) {
  if (!kind) return esc(text);
  return `<span class="${kind === 'folded' ? kind : 'tok-' + kind}">${esc(text)}</span>`;
}

function markedTokens(tokens, matches = [], active) {
  let offset = 0;
  let index = 0;
  return tokens.map(({ text, kind }) => {
    let html = '';
    let start = 0;
    const end = offset + text.length;
    while (index < matches.length && matches[index].start < end) {
      const match = matches[index];
      const from = Math.max(start, match.start - offset);
      const to = Math.min(text.length, match.end - offset);
      if (to > from) {
        html += renderToken(text.slice(start, from), kind);
        html += `<mark${match.index === active ? ' class="is-current" data-current-match' : ''}>${renderToken(text.slice(from, to), kind)}</mark>`;
        start = to;
      }
      if (match.end > end) break;
      index++;
    }
    offset = end;
    return html + renderToken(text.slice(start), kind);
  }).join('');
}

function tableMarkup(table, state) {
  const cell = (id, value) => markedTokens([token(value)], state.byLine.get(id), state.active);
  const classes = (name, column) => [table.numeric.has(name) ? 'num' : '', table.lead && column === 0 ? 'lead' : ''].filter(Boolean).join(' ');
  const headings = table.headings.map((name, index) => `<th scope="col"${classes(name, index) ? ` class="${classes(name, index)}"` : ''}>${cell('heading-' + index, name)}</th>`).join('');
  const rows = table.rows.map((row, index) => `<tr>${table.list ? `<th scope="row" class="idx">${formatNumber(index + 1)}</th>` : ''}${row.map((value, column) => {
    const id = 'cell-' + index + '-' + column;
    const path = table.list ? [...table.basePath, index, table.headings[column]] : [table.rows[index][0].text];
    const html = value.nested !== undefined ? `<button type="button" class="obj" data-table-open="${esc(pathId(path))}">${esc(value.nested)}</button>`
      : value.null ? `<span class="null">${cell(id, value.text)}</span>` : cell(id, value.text);
    const cls = classes(table.headings[column], column);
    return table.fields && column === 0 ? `<th scope="row">${html}</th>` : `<td${cls ? ` class="${cls}"` : ''}>${html}</td>`;
  }).join('')}</tr>`).join('');
  const label = table.list ? t('resp.table.of', { name: table.path || t('resp.body') }) : t('resp.tableLabel');
  const foot = table.list
    ? `<span>${th('resp.table.foot', { n: table.rows.length, path: `<code>${esc(table.path || '[]')}</code>` })}${table.page.page !== undefined && table.page.pages !== undefined ? ` · ${esc(t('resp.table.page', { page: formatNumber(table.page.page), pages: formatNumber(table.page.pages), total: formatNumber(table.page.total ?? table.rows.length) }))}` : ''}</span>`
    : `<span>${esc(t('resp.table.fields', { n: table.rows.length }))}</span>`;
  const more = table.list ? `<button type="button" class="tbl-more" data-table-more title="${esc(t("resp.table.moreLabel", { n: formatNumber(table.headings.length) }))}" hidden>${esc(t('resp.table.more', { n: formatNumber(table.headings.length) }))}${icon('arrow-right', true)}</button>` : '';
  return `<div class="tbl-wrap"><div class="tbl${table.fields ? ' is-kv' : ''}" role="region" tabindex="0" aria-label="${esc(label)}"><table><thead><tr>${table.list ? '<th scope="col" class="idx">#</th>' : ''}${headings}</tr></thead><tbody>${rows}</tbody></table></div></div>
    <div class="vb-foot">${foot}<span class="spacer"></span>${more}</div>`;
}

function lineMarkup(model, line, number, folded, state) {
  const note = state.mode === 'pretty' ? model.lineIssues?.get(line.id) : undefined;
  const index = model.firstLineFollowUps.get(line.id);
  const action = model.followUps[index];
  const actions = line.copy === undefined && !action ? '' : `<span class="line-acts">
    ${line.copy !== undefined ? copyTextButton(t('code.copy'), { cls: 'btn-xs', data: `data-copy-line="${esc(line.id)}" aria-label="${esc(t('resp.copyLine', { n: formatNumber(number) }))}"` }) : ''}
    ${action ? `<button type="button" class="btn btn-xs" data-follow-up="${index}">${esc(t('resp.openIn', { title: titleOf(action.operation) }))}${index === 0 ? shortcutHint(followAction) : ''}</button>` : ''}
    </span>`;
  return codeLine(line, number, folded, markedTokens(folded ? line.folded : line.tokens, folded ? [] : state.byLine.get(line.id), state.active), actions, note ? { cls: 'is-issue', note } : {});
}

/**
 * The Schema view (mock 30): the documented response schema, marking which top-level
 * properties this response returned, with a link to the model page.
 */
/** The dotted paths a body returned, in the form the property tree uses: `items[].id`, `bankDetails.scheme`. */
export function presentPaths(value, prefix = '', paths = new Set()) {
  if (Array.isArray(value)) value.forEach(item => presentPaths(item, prefix + '[]', paths));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      paths.add(path);
      presentPaths(child, path, paths);
    }
  }
  return paths;
}

/** The validator's dotted path (items.0.name) as the attribute list's path (items[].name). */
export const treePath = path => String(path ?? '').split('.').filter(Boolean).map(part => /^\d+$/.test(part) ? '[]' : part).join('.').replace(/\.\[\]/g, '[]');

/**
 * The Schema view (mocks 102, 103): a one-line legend, then the documented schema in compact
 * rows with a mark at each line's end (returned, not returned, doesn't match). Failing rows carry
 * their reason; properties the schema doesn't document are listed as "Not in the schema".
 */
function schemaMarkup(model, document) {
  const present = presentPaths(model.body);
  const check = model.schema;
  const issues = Object.fromEntries((check.issues || []).filter(issue => !issue.extra).map(issue => [treePath(issue.path), issue.message]));
  const extra = (check.extra || []).map(item => ({ ...item, issue: t('match.extra', { model: check.name }) }));
  const link = check.ref ? `<a class="type-link" href="#model/${encodeURIComponent(check.ref)}" data-model="${esc(check.ref)}">${esc(check.ref)} ${icon('arrow-right', true)}</a>` : '';
  const legendMark = kind => `<span class="attr-mark is-${kind}" aria-hidden="true"></span>`;
  return `<div class="schema-pane">
    <div class="legend"><span>${legendMark('on')}${esc(t('resp.legend.on'))}</span><span>${legendMark('off')}${esc(t('resp.legend.off'))}</span>${check.matches ? '' : `<span>${legendMark('issue')}${esc(t('resp.legend.issue'))}</span>`}<span class="spacer"></span>${link}</div>
    ${propertyTree(check.raw, document, { id: 'rs', compact: true, present, issues, extra, label: check.name })}
  </div>`;
}

function viewerBody(model, state) {
  if (state.mode === 'schema') return schemaMarkup(model, state.document);
  if (state.mode === 'table') return tableMarkup(model.table, state);
  const lines = state.mode === 'pretty' ? model.pretty.lines : model.rawLines;
  const folded = id => state.folded.has(id);
  const content = visibleLines(lines, state.folded).map((line, index) => lineMarkup(model, line, index + 1, folded(line.id), state)).join('');
  const type = model.mediaType || (model.json ? 'application/json' : '');
  const label = type ? t('resp.bodyType', { type }) : t('resp.body');
  const note = state.mode === 'pretty' && model.pretty.large ? largeNote(model.raw.length, model.pretty.lines.length) : '';
  // Raw is the bytes as received: one line for compact JSON, with Wrap as an option.
  const foot = state.mode === 'raw' ? `<div class="vb-foot"><span>${th('resp.raw.foot', { n: model.rawLines.length, size: esc(formatBytes(new TextEncoder().encode(model.raw).length)), type: `<code>${esc(model.contentType || type || 'text/plain')}</code>` })}</span><span class="spacer"></span><span class="hint">${esc(t(state.wrap ? 'resp.raw.wrapped' : 'resp.raw.scroll'))}</span></div>` : '';
  return `${note}<div class="vb-scroll" tabindex="0" role="region" aria-label="${esc(label)}"><div class="code-view${state.mode === 'raw' ? ' is-raw' : ''}${state.mode === 'raw' && state.wrap ? ' is-wrap' : ''}" role="group" aria-label="${esc(label)}">${content}</div></div>${foot}`;
}

/** The Collapse all / Expand all button: a label that gives way to its icon in a narrow pane. */
const foldAllButton = (label, hidden) => `<button type="button" class="btn btn-ghost btn-xs vb-lbl" data-fold-all title="${esc(label)}" aria-label="${esc(label)}" ${shortcutAttrs('fold-all')}${hidden ? ' hidden' : ''}>${icon('chevrons-ud', true)}<span class="lbl" data-fold-all-label>${esc(label)}</span></button>`;

/** An icon button for the viewer bar; `label` is plain text and becomes the aria-label and tooltip. */
function control(action, symbol, label, extra = '') {
  return `<button type="button" class="btn btn-ghost btn-icon btn-xs" aria-label="${esc(label)}" title="${esc(label)}" ${action ? `data-action="${action}" ${shortcutAttrs(action)}` : ''} ${extra}>${icon(symbol, true)}</button>`;
}

/** Render the response tab contents, including only features supported by this result. */
export function responseMarkup(result, context = {}) {
  const model = responseModel(result, context);
  const state = initialState(model);
  const overview = followUpMarkup(model.followUps) + timingMarkup(result) + validationMarkup(result, model.body);
  if (model.raw === undefined) return `<div class="response-viewer">${overview}<div class="viewer-empty faint">${esc(t('resp.noBody'))}</div></div>`;
  state.document = context.document;
  const modes = ['pretty', 'raw', 'table', 'schema'].filter(mode => mode === 'raw' || (mode === 'pretty' ? model.pretty : mode === 'table' ? model.table : model.schema?.raw && context.document));
  const buttons = modes.map(mode => `<button type="button" data-response-mode="${mode}" aria-pressed="${mode === state.mode}">${esc(t('resp.mode.' + mode))}</button>`).join('');
  const foldAllLabel = t(state.folded.size ? 'resp.expandAll' : 'resp.collapseAll');
  // One toolbar line at every width: views at the start, icon actions at the end.
  return `<div class="response-viewer">${overview}<div class="viewer v5-viewer">
    <div class="viewer-bar vb">
      <div class="segmented sm" role="group" aria-label="${esc(t('resp.bodyView'))}">${buttons}</div><span class="spacer"></span>
      ${foldAllButton(foldAllLabel, state.mode !== 'pretty' || !model.pretty?.branches.size)}
      ${control('', 'wrap', t('resp.wrap'), `data-wrap aria-pressed="false"${state.mode === 'raw' ? '' : ' hidden'} ${shortcutAttrs('wrap-lines')}`)}
      ${control(findAction, 'search', t('resp.search'), 'aria-expanded="false"')}
      ${copyButton(t('resp.copyBody'), { action: copyAction, shortcut: copyAction, size: 'btn-xs' })}
    </div>
    <div class="response-find" role="search" aria-label="${esc(t('resp.body'))}" hidden>
      <label class="input-sm">${icon('search', true)}<input type="search" aria-label="${esc(t('resp.find'))}" placeholder="${esc(t('resp.find'))}" spellcheck="false"></label>
      <span class="faint" data-match-count role="status"></span>
      ${control('', 'arrow-up', t('resp.prevMatch'), 'data-match-step="-1" disabled')}
      ${control('', 'arrow-down', t('resp.nextMatch'), 'data-match-step="1" disabled')}
      ${control('', 'x', t('resp.closeSearch'), 'data-close-response-find')}
    </div>
    <div class="vb-body" data-response-content data-mode="${state.mode}">${viewerBody(model, state)}</div>
    </div></div>`;
}

/**
 * The schema match in the result's status line (mocks 100, 101): a quiet "✓ Matches schema", or
 * an amber "⚠ 3 schema issues". Its toggletip says what was checked or lists each issue.
 * Returns '' when the response has no documented schema to check against.
 */
export function matchButton(result, context = {}) {
  const check = schemaCheck(result, context);
  if (!check) return '';
  const count = check.issues.length;
  return check.matches
    ? `<button type="button" class="match" id="match-btn" data-match aria-haspopup="dialog" aria-expanded="false">${icon('circle-check', true)}<span class="full">${esc(t('match.ok'))}</span><span class="short" aria-hidden="true">${esc(t('resp.mode.schema'))}</span></button>`
    : `<button type="button" class="match is-fail" id="match-btn" data-match aria-haspopup="dialog" aria-expanded="false">${icon('warn', true)}<span class="full">${esc(t('match.issues', { n: count }))}</span><span class="short" aria-hidden="true">${esc(formatNumber(count))}</span></button>`;
}

/** The documented schema and how the body compares with it, or undefined. */
export function schemaCheck(result, context = {}) {
  const model = responseModel(result, context);
  return model.schema?.raw && context.document ? model.schema : undefined;
}

/** The match toggletip's content. */
export function matchTip(result, context = {}) {
  const check = schemaCheck(result, context);
  if (!check) return '';
  const model = check.ref ? `<a class="type-link" href="#model/${encodeURIComponent(check.ref)}" data-model="${esc(check.ref)}">${esc(check.ref)}</a>` : `<code>${esc(check.name)}</code>`;
  const media = Object.entries(result.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1]?.split(';')[0] ?? 'application/json';
  const shown = check.issues.slice(0, 8);
  const body = check.matches
    ? `<h3 id="match-h">${icon('circle-check', true)}${esc(t('match.okTitle'))}</h3>
      <p>${th('match.okBody', { model, n: check.properties })}</p>
      <dl class="facts"><dt>${esc(t('match.schema'))}</dt><dd><span class="ltr">${esc(String(result.status))} · ${esc(media)}</span> · ${model}</dd><dt>${esc(t('match.checked'))}</dt><dd class="plain">${esc(t('match.checks'))}</dd></dl>`
    : `<h3 id="match-h">${icon('warn', true)}${esc(t('match.failTitle', { n: check.issues.length }))}</h3>
      <p>${th('match.failBody', { model, status: `<span class="ltr">${esc(String(result.status))}</span>` })}</p>
      <ul class="issue-list">${shown.map(issue => `<li><code>${esc(issue.path || '$')}</code><span>${esc(issue.message)}</span></li>`).join('')}</ul>
      ${check.issues.length > shown.length ? `<p class="faint">${esc(t('match.more', { n: check.issues.length - shown.length }))}</p>` : ''}
      <p class="faint note">${esc(t('match.note'))}</p>`;
  return `<div class="pop toggletip match-tip${check.matches ? '' : ' is-fail'}" role="dialog" aria-labelledby="match-h">
      <div class="tt-body">${body}</div>
      <div class="tt-foot"><button type="button" class="link" data-match-schema>${esc(t('match.showSchema'))}</button>${check.matches ? '' : `<button type="button" class="link" data-match-copy>${esc(t('match.copy'))}</button>`}<span class="spacer"></span>${shortcutHint('escape')}</div>
    </div>`;
}

/** Wires the match button in the status line: its toggletip, Show in Schema view and Copy issues. */
export function bindMatch(head, result, context = {}) {
  const button = head?.querySelector('[data-match]');
  if (!button) return;
  button.addEventListener('click', () => {
    if (openPopover()?.anchor === button) { closePopover(); return; }
    const pop = openPopoverAt(button, matchTip(result, context), { gap: 10, arrow: true, kind: 'toggletip', focus: false });
    pop.addEventListener('click', event => {
      if (event.target.closest('[data-match-schema]')) {
        closePopover();
        document.querySelector('.response-viewer')?.setMode?.('schema');
      } else if (event.target.closest('[data-match-copy]')) {
        const check = schemaCheck(result, context);
        void copyText(check.issues.map(issue => `${issue.path || '$'}: ${issue.message}`).join('\n'), { button: event.target.closest('[data-match-copy]'), what: t('match.what') });
      }
    });
  });
}

function searchLines(model, mode) {
  if (mode === 'table') return [
    ...model.table.headings.map((text, index) => ({ id: 'heading-' + index, tokens: [token(text)] })),
    ...model.table.rows.flatMap((row, index) => row.map((cell, column) => ({ id: 'cell-' + index + '-' + column, tokens: [token(cell.text ?? '')] }))),
  ];
  return mode === 'pretty' ? model.pretty.lines : model.rawLines;
}

function searchBody(model, state, query) {
  state.matches = [];
  state.byLine.clear();
  state.active = -1;
  if (!query) return;
  // The Schema view searches its attribute names once they're drawn (markSchema).
  if (state.mode === 'schema') { state.active = 0; return; }
  const pattern = new RegExp(query.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'giu');
  for (const line of searchLines(model, state.mode)) {
    const text = line.tokens.map(part => part.text).join('');
    const matches = Array.from(text.matchAll(pattern), match => {
      const found = { line, start: match.index, end: match.index + match[0].length, index: state.matches.length };
      state.matches.push(found);
      return found;
    });
    if (matches.length) state.byLine.set(line.id, matches);
  }
  if (state.matches.length) state.active = 0;
}

/** Attach a result-scoped viewer. A fresh render resets its view, folds and search. */
export function bindResponseViewer(container, result, context = {}) {
  const root = container.matches('.response-viewer') ? container : container.querySelector('.response-viewer');
  if (!root) return;
  bindings.get(root)?.abort();
  const binding = new AbortController();
  bindings.set(root, binding);
  const { signal } = binding;
  const model = responseModel(result, context);
  const state = initialState(model);
  state.document = context.document;
  const content = root.querySelector('[data-response-content]');
  const search = root.querySelector('.response-find');
  const input = search?.querySelector('input');
  const find = root.querySelector('[data-action="find-response"]');
  const all = root.querySelector('[data-fold-all]');
  const copies = new Map(model.pretty?.lines.map(line => [line.id, line.copy]));
  bindTrees(root);

  function render(reveal = false) {
    const current = reveal && state.matches[state.active]?.line;
    if (current) {
      for (const ancestor of current.ancestors ?? []) state.folded.delete(ancestor);
      state.folded.delete(current.id);
    }
    content.innerHTML = viewerBody(model, state);
    if (content.dataset) content.dataset.mode = state.mode;
    if (state.mode === 'schema' && input?.value) markSchema(input.value);
    const wrap = root.querySelector('[data-wrap]');
    if (wrap) { wrap.hidden = state.mode !== 'raw'; wrap.setAttribute('aria-pressed', String(state.wrap)); }
    if (state.mode === 'table') watchTable();
    if (state.mode === 'schema') bindTrees(root);
    for (const button of root.querySelectorAll('[data-response-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.responseMode === state.mode));
    }
    all.hidden = state.mode !== 'pretty' || !model.pretty?.branches.size;
    const foldLabel = t(state.folded.size ? 'resp.expandAll' : 'resp.collapseAll');
    all.querySelector('[data-fold-all-label]').textContent = foldLabel;
    all.setAttribute?.('aria-label', foldLabel);
    all.title = foldLabel;
    search.querySelector('[data-match-count]').textContent = input.value
      ? state.matches.length ? t('resp.matchCount', { current: formatNumber(state.active + 1), total: formatNumber(state.matches.length) }) : t('resp.noMatches')
      : '';
    for (const button of search.querySelectorAll('[data-match-step]')) button.disabled = !state.matches.length;
    if (reveal) content.querySelector('[data-current-match]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function closeSearch() {
    search.hidden = true;
    find.setAttribute('aria-expanded', 'false');
    input.value = '';
    searchBody(model, state, '');
    render();
    find.focus();
  }

  function moveMatch(step) {
    if (!state.matches.length) return;
    state.active = (state.active + step + state.matches.length) % state.matches.length;
    render(true);
  }

  /** Copies through the shared helper. If the clipboard is blocked, the body text is selected and a notice appears above it. */
  function copy(value, button, what, select = content.querySelector('.code-view, .response-table')) {
    return copyText(value, { button, what, select, notice: content });
  }

  /**
   * Table: an edge fade while columns remain off to the side, a shadow on the sticky name column
   * once scrolled, and the "15 columns, scroll" button while there is more to see.
   */
  function watchTable() {
    const region = content.querySelector?.('.tbl');
    if (!region) return;
    const update = () => {
      const max = region.scrollWidth - region.clientWidth;
      const x = Math.abs(region.scrollLeft);
      region.parentElement.classList.toggle('more-end', x < max - 1);
      region.parentElement.classList.toggle('is-scrolled', x > 0);
      const more = content.querySelector('[data-table-more]');
      if (more) more.hidden = max <= 1;
    };
    region.addEventListener('scroll', update, { passive: true, signal });
    new ResizeObserver(update).observe(region);
    update();
  }

  /** Search in the Schema view: marks the attribute names that contain the query. */
  function markSchema(query) {
    const pattern = new RegExp(query.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'giu');
    const names = [...(content.querySelectorAll?.('.attr-name') ?? [])];
    for (let pass = 0; pass < 2; pass++) {
      let count = 0;
      state.matches = [];
      for (const node of names) {
        const text = node.textContent;
        let html = '';
        let last = 0;
        for (const match of text.matchAll(pattern)) {
          const index = count++;
          state.matches.push({ index });
          html += `${esc(text.slice(last, match.index))}<mark${index === state.active ? ' class="is-current" data-current-match' : ''}>${esc(match[0])}</mark>`;
          last = match.index + match[0].length;
        }
        if (last) node.innerHTML = html + esc(text.slice(last));
      }
      if (state.active < state.matches.length) break;
      state.active = state.matches.length ? 0 : -1;
    }
  }

  /** Switches the body view (the match toggletip's "Show in Schema view" calls this too). */
  function setMode(mode) {
    if (!root.querySelector(`[data-response-mode="${mode}"]`)) return;
    state.mode = mode;
    searchBody(model, state, input?.value ?? '');
    render(Boolean(input?.value));
    root.querySelector(`[data-response-mode="${mode}"]`)?.focus?.();
  }
  root.setMode = setMode;

  root.addEventListener('click', event => {
    // On touch screens a tap on a line reveals that line's actions (copy, open in).
    const tapped = event.target.closest?.('.ln');
    if (tapped && !event.target.closest('button') && globalThis.matchMedia?.('(pointer: coarse)').matches) {
      const open = tapped.classList.contains('is-active');
      for (const line of root.querySelectorAll('.ln.is-active')) line.classList.remove('is-active');
      if (!open) tapped.classList.add('is-active');
    }
    const button = event.target.closest('button');
    if (!button || !root.contains(button)) return;
    const { dataset } = button;
    if (dataset.followUp !== undefined) {
      const followUp = model.followUps[Number(dataset.followUp)];
      if (followUp) context.onFollowUp(followUp.operation, structuredClone(followUp.values));
    } else if (dataset.action === copyAction) {
      event.stopPropagation();
      void copy(model.raw, button, t('copy.what.body'));
    } else if (dataset.copyLine !== undefined) {
      const { value, source } = copies.get(dataset.copyLine);
      void copy(source ?? (typeof value === 'string' ? value : JSON.stringify(value, null, 2)), button, t('copy.what.line'),
        button.closest('.ln')?.querySelector('.src'));
    } else if (dataset.action === findAction) {
      search.hidden = false;
      find.setAttribute('aria-expanded', 'true');
      input.focus();
      input.select();
    } else if (dataset.closeResponseFind !== undefined) {
      closeSearch();
    } else if (dataset.matchStep) {
      moveMatch(Number(dataset.matchStep));
    } else if (dataset.responseMode && dataset.responseMode !== state.mode) {
      state.mode = dataset.responseMode;
      searchBody(model, state, input.value);
      render(Boolean(input.value));
    } else if (dataset.wrap !== undefined) {
      state.wrap = !state.wrap;
      render();
    } else if (dataset.tableMore !== undefined) {
      const region = content.querySelector('.tbl');
      const rtl = getComputedStyle(region).direction === 'rtl';
      region.scrollBy({ left: (rtl ? -1 : 1) * region.clientWidth * 0.8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } else if (dataset.tableOpen) {
      // "3 keys" opens Pretty at that value, unfolded.
      const line = model.pretty?.lines.find(item => item.id === dataset.tableOpen);
      if (!line) return;
      for (const ancestor of line.ancestors) state.folded.delete(ancestor);
      state.folded.delete(line.id);
      state.mode = 'pretty';
      render();
      content.querySelector(`[data-fold-line="${CSS.escape(line.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (dataset.foldLine !== undefined) {
      const id = dataset.foldLine;
      if (state.folded.has(id)) state.folded.delete(id);
      else state.folded.add(id);
      render();
      for (const fold of content.querySelectorAll('[data-fold-line]')) {
        if (fold.dataset.foldLine === id) fold.focus({ preventScroll: true });
      }
    } else if (dataset.foldAll !== undefined) {
      // Anything collapsed means the next click opens everything; otherwise it closes everything.
      state.folded = state.folded.size ? new Set() : new Set(model.pretty.branches);
      render();
    }
  }, { signal });

  input?.addEventListener('input', () => {
    searchBody(model, state, input.value);
    render(true);
  }, { signal });
  search?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    } else if (event.target === input && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      moveMatch(event.shiftKey ? -1 : 1);
    }
  }, { signal });
}
