// Nested document diffs for store changes (mock v6-stores.js docCard, screens 113–116 and m26):
// a MongoDB document, a DynamoDB item or a Redis value as a tree with every object open. Changed
// leaves are tinted with old → new, added and removed paths are marked, every branch that holds
// changes says how many, arrays compare by index, Extended JSON reads as typed badges and secret
// fields as a muted "redacted" pill at any depth. Updates open on Diff with Changes only off; the
// switch shows Before or After, and each branch folds.
import { esc, icon } from './components.js';
import { t } from './i18n.js';
import { storeKind } from './stores.js';

// MongoDB Extended JSON v2 (relaxed and canonical) wrappers shown as a type badge, by key.
const EXTENDED = {
  $oid: 'ObjectId', $date: 'Date', $numberDecimal: 'Decimal128', $numberLong: 'Int64', $numberInt: 'Int32',
  $numberDouble: 'Double', $binary: 'Binary', $uuid: 'UUID', $timestamp: 'Timestamp', $regularExpression: 'Regex',
  $symbol: 'Symbol', $code: 'Code', $minKey: 'MinKey', $maxKey: 'MaxKey',
};
const REDACTED = '[REDACTED]';

/** The Extended JSON key of a one-key wrapper such as { "$oid": "…" }, or undefined. */
export function extendedType(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length === 1 && EXTENDED[keys[0]] ? keys[0] : undefined;
}

const isBranch = value => !!value && typeof value === 'object' && !extendedType(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (container, key) => container != null && typeof container === 'object' &&
  (Array.isArray(container) ? key < container.length : Object.hasOwn(container, key));

/** One value as it reads in the tree: typed badges, the redacted pill, then JSON literals. */
export function valueMarkup(value) {
  const ext = extendedType(value);
  if (ext) {
    const inner = value[ext];
    const text = inner && typeof inner === 'object' ? (extendedType(inner) ? inner[extendedType(inner)] : JSON.stringify(inner)) : inner;
    return `<span class="xt"><span class="xt-t">${EXTENDED[ext]}</span><span class="xt-v ltr">${esc(text)}</span></span>`;
  }
  if (value === REDACTED) return `<span class="redacted" title="${esc(t('diff.redactedTip'))}">${icon('lock', true)}${esc(t('diff.redacted'))}</span>`;
  if (value === null) return '<span class="j-null ltr">null</span>';
  if (typeof value === 'string') return `<span class="j-s ltr">"${esc(value)}"</span>`;
  if (typeof value === 'number') return `<span class="j-n ltr">${esc(String(value))}</span>`;
  if (typeof value === 'boolean') return `<span class="j-b ltr">${value}</span>`;
  return `<span class="j-o ltr">${esc(JSON.stringify(value))}</span>`;
}

/**
 * Flattens `before` and `after` into tree rows in document order: after's key order, with removed
 * keys where they stood; arrays by index. Each row: { depth, key, index, kind: same|chg|add|del,
 * branch: object|array (branches only), size, inner (changes below a branch), inherit (inside an
 * added or removed branch), before, after, path }.
 */
export function diffRows(before, after, depth = 0, out = [], path = '') {
  const keys = [];
  if (Array.isArray(before) || Array.isArray(after)) {
    const length = Math.max(Array.isArray(before) ? before.length : 0, Array.isArray(after) ? after.length : 0);
    for (let index = 0; index < length; index++) keys.push(index);
  } else {
    const kept = Object.keys(after || {});
    keys.push(...kept);
    Object.keys(before || {}).forEach((key, index) => { if (!kept.includes(key)) keys.splice(Math.min(keys.length, index), 0, key); });
  }
  for (const key of keys) {
    const inBefore = has(before, key);
    const inAfter = has(after, key);
    const old = inBefore ? before[key] : undefined;
    const now = inAfter ? after[key] : undefined;
    const kind = !inBefore ? 'add' : !inAfter ? 'del' : same(old, now) ? 'same' : 'chg';
    const rowPath = typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;
    const shape = kind === 'del' ? old : now;
    const index = typeof key === 'number';
    if (isBranch(shape) && (kind !== 'chg' || isBranch(old))) {
      const row = { depth, key, index, kind: kind === 'chg' ? 'same' : kind, branch: Array.isArray(shape) ? 'array' : 'object', size: Object.keys(shape).length, inner: 0, path: rowPath };
      out.push(row);
      const start = out.length;
      diffRows(kind === 'add' ? undefined : old, kind === 'del' ? undefined : now, depth + 1, out, rowPath);
      const below = out.slice(start);
      if (kind === 'add' || kind === 'del') below.forEach(item => { item.kind = kind; item.inherit = true; });
      row.inner = below.filter(item => !item.inherit && item.kind !== 'same').length;
    } else out.push({ depth, key, index, kind, before: old, after: now, path: rowPath });
  }
  return out;
}

/** Counts for the card: leaves changed, paths added and paths removed (not their contents). */
export function tally(rows) {
  const top = rows.filter(row => !row.inherit);
  return {
    changed: top.filter(row => row.kind === 'chg').length,
    added: top.filter(row => row.kind === 'add').length,
    removed: top.filter(row => row.kind === 'del').length,
  };
}

const MARKS = { chg: '~', add: '+', del: '−', same: '' };

/**
 * One tree row. `mode` is update (tinted diff), insert or delete (every row marked, nothing
 * tinted: the whole card is one operation) or plain (Before and After).
 */
function treeRow(row, mode) {
  const kind = mode === 'insert' ? 'add' : mode === 'delete' ? 'del' : mode === 'plain' ? 'same' : row.kind;
  const tint = mode === 'update' && kind !== 'same' ? ` is-${kind}${row.inherit ? ' is-inherit' : ''}` : kind !== 'same' ? ` is-plain-${kind}` : '';
  const mark = mode === 'update' && row.inherit ? '' : MARKS[kind];
  const key = `<span class="dt-k${row.index ? ' is-idx' : ''} ltr">${esc(row.key)}</span>`;
  let value;
  if (row.branch) {
    const size = t(row.branch === 'array' ? 'diff.items' : 'diff.fields', { n: row.size });
    const inner = mode === 'update' && row.kind === 'same' && row.inner ? `<span class="dt-inner">${esc(t('diff.changes', { n: row.inner }))}</span>` : '';
    value = `<span class="dt-meta"><span class="br" aria-hidden="true">${row.branch === 'array' ? '[' : '{'}</span>${esc(size)}${inner}</span>`;
  } else if (kind === 'chg') {
    value = `<span class="dt-v is-pair"><span class="dt-old">${valueMarkup(row.before)}</span><span class="dt-arrow" aria-hidden="true">→</span><span class="sr-only">${esc(t('db.changedTo'))}</span><span class="dt-new">${valueMarkup(row.after)}</span></span>`;
  } else value = `<span class="dt-v">${valueMarkup(kind === 'del' || (mode === 'plain' && row.after === undefined) ? row.before : row.after)}</span>`;
  const twisty = row.branch
    ? `<button type="button" class="dt-tw" data-diff-fold aria-expanded="true" aria-label="${esc(t('diff.fold', { name: String(row.key) }))}">${icon('chevron-down', true)}</button>`
    : '<span class="dt-tw" aria-hidden="true"></span>';
  return `<div class="dt-row${tint}${row.branch ? ' is-branch' : ''}" data-depth="${row.depth}" data-kind="${kind}"${row.branch ? ` data-inner="${row.inner}"` : ''} style="--d:${row.depth}">
    <span class="dt-mk" aria-hidden="true">${mark}</span><span class="dt-in">${twisty}${key}${value}</span></div>`;
}

/** The tree for one view of a change: diff (update), before or after, or the whole insert/delete. */
export function treeMarkup(change, view = 'diff') {
  const operation = changeOperation(change);
  if (operation === 'insert') return diffRows(undefined, change.after).map(row => treeRow(row, 'insert')).join('');
  if (operation === 'delete') return diffRows(change.before, undefined).map(row => treeRow(row, 'delete')).join('');
  if (view === 'before') return diffRows(change.before, change.before).map(row => treeRow(row, 'plain')).join('');
  if (view === 'after') return diffRows(change.after, change.after).map(row => treeRow(row, 'plain')).join('');
  return diffRows(change.before, change.after).map(row => treeRow(row, 'update')).join('');
}

const changeOperation = change => String(change.operation || '').toLowerCase();

/** The record's key: `_id` for MongoDB, the key attributes for DynamoDB, `key` for Redis. */
function keyMarkup(key) {
  if (key == null) return '';
  if (typeof key !== 'object' || Array.isArray(key) || extendedType(key)) return `<span class="doc-id">${valueMarkup(key)}</span>`;
  return Object.entries(key).map(([name, value]) => `<span class="doc-id"><span class="k ltr">${esc(name)}</span>${valueMarkup(value)}</span>`).join('');
}

const BADGES = { insert: ['ins', '+ INSERT'], update: ['upd', '~ UPDATE'], delete: ['del', '− DELETE'] };

/**
 * A store change as a card: operation, collection (or table, or key prefix), the "via upsert" or
 * "whole document replaced" qualifier, then the key and the counts, then the tree. `index` ties
 * the card to its change for bindDocDiffs.
 */
export function docCard(change, index = 0) {
  const operation = changeOperation(change);
  const [style, label] = BADGES[operation] || ['', operation.toUpperCase()];
  const kind = storeKind(change.store);
  const record = ['document', 'index'].includes(kind) ? 'document' : kind === 'key' ? 'key' : kind === 'sql' ? 'row' : 'item';
  const via = change.via === 'upsert' ? t('diff.viaUpsert') : change.via === 'replace' ? t('diff.viaReplace') : '';
  let summary;
  if (operation === 'update') {
    const counts = tally(diffRows(change.before, change.after));
    summary = [
      counts.changed && `<span class="dc c-upd">${esc(t('diff.changed', { n: counts.changed }))}</span>`,
      counts.added && `<span class="dc c-ins">${esc(t('diff.added', { n: counts.added }))}</span>`,
      counts.removed && `<span class="dc c-del">${esc(t('diff.removed', { n: counts.removed }))}</span>`,
    ].filter(Boolean).join('') || `<span class="dc c-same">${esc(t('diff.noChange'))}</span>`;
  } else {
    const fields = Object.keys((operation === 'delete' ? change.before : change.after) || {}).length;
    summary = `<span class="dc c-${style}">${esc(t(`diff.${operation === 'delete' ? 'removedRecord' : 'newRecord'}.${record}`))} · ${esc(t('diff.fields', { n: fields }))}</span>`;
  }
  const views = operation === 'update' ? `<span class="spacer"></span>
      <button type="button" class="btn btn-ghost btn-xs doc-only" data-diff-only aria-pressed="false" title="${esc(t('diff.changesOnly'))}">${icon('filter', true)}<span class="lbl">${esc(t('diff.changesOnly'))}</span></button>
      <div class="segmented sm doc-views" role="group" aria-label="${esc(t('diff.show'))}">${['diff', 'before', 'after'].map(view =>
        `<button type="button" data-diff-view="${view}" aria-pressed="${view === 'diff'}">${esc(t('diff.view.' + view))}</button>`).join('')}</div>` : '';
  return `<article class="doc-card is-${esc(operation)}" data-doc-card="${index}" aria-label="${esc(t('db.cardLabel', { table: change.table, operation }))}">
    <header class="doc-head">${label ? `<span class="op-badge op-${style}">${esc(label)}</span>` : ''}<span class="doc-coll ltr" title="${esc(change.table)}">${esc(change.table)}</span>${via ? `<span class="doc-via">${esc(via)}</span>` : ''}${views}</header>
    <div class="doc-bar">${keyMarkup(change.key)}<span class="doc-sum">${summary}</span></div>
    <div class="dt" data-diff-tree>${treeMarkup(change)}</div>
  </article>`;
}

/** Shows or hides the rows a folded branch or Changes only hides; the two compose. */
function applyVisibility(card) {
  const only = card.querySelector('[data-diff-only]')?.getAttribute('aria-pressed') === 'true';
  const diff = (card.querySelector('[data-diff-view][aria-pressed="true"]')?.dataset.diffView ?? 'diff') === 'diff';
  let foldedAt = Infinity;
  for (const row of card.querySelectorAll('.dt-row')) {
    const depth = Number(row.dataset.depth);
    if (depth <= foldedAt) foldedAt = Infinity;
    const unchanged = row.dataset.kind === 'same' && (!row.classList.contains('is-branch') || row.dataset.inner === '0');
    row.hidden = depth > foldedAt || (only && diff && unchanged);
    if (!row.hidden && row.querySelector('[data-diff-fold]')?.getAttribute('aria-expanded') === 'false') foldedAt = depth;
  }
}

/** Wires each card's view switch, Changes only and branch folding. `changes` are the change records. */
export function bindDocDiffs(container, changes) {
  container.addEventListener('click', event => {
    const card = event.target.closest('[data-doc-card]');
    if (!card) return;
    const change = changes[Number(card.dataset.docCard)];
    const view = event.target.closest('[data-diff-view]');
    const only = event.target.closest('[data-diff-only]');
    const fold = event.target.closest('[data-diff-fold]');
    if (view && change) {
      card.querySelectorAll('[data-diff-view]').forEach(button => button.setAttribute('aria-pressed', String(button === view)));
      card.querySelector('[data-diff-tree]').innerHTML = treeMarkup(change, view.dataset.diffView);
      const onlyButton = card.querySelector('[data-diff-only]');
      if (onlyButton) onlyButton.disabled = view.dataset.diffView !== 'diff';
    } else if (only) only.setAttribute('aria-pressed', String(only.getAttribute('aria-pressed') !== 'true'));
    else if (fold) fold.setAttribute('aria-expanded', String(fold.getAttribute('aria-expanded') !== 'true'));
    else return;
    applyVisibility(card);
  });
}
