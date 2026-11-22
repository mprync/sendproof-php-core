// The Database tab: the rows, documents, items and keys a request changed (mocks 01, 49, 113–118).
// With only the SQL database involved it is the list of row cards it has always been; once a
// change names a data store, or discovery lists hooked stores, the changes group by store under
// its mark, name and database, with a jump strip, the stores that were only read and a note on
// what Sendproof covers.
import { esc, icon } from './components.js';
import { formatList, t, th } from './i18n.js';
import { bindDocDiffs, docCard } from './doc-diff.js';
import { SQL, dataStore, dataStores, recordCount, sqlSystem, storeMark, storeName } from './stores.js';

const operations = {
  insert: ['ins', '+ INSERT'],
  update: ['upd', '~ UPDATE'],
  delete: ['del', '− DELETE'],
};

const serialize = value => typeof value === 'string' ? value : JSON.stringify(value);

function renderRows(change, columns) {
  const { before, after, operation } = change;
  return columns.map(key => {
    const original = serialize(before?.[key]);
    const updated = serialize(after?.[key]);
    const title = operation === 'update' ? `${original} → ${updated}` : operation === 'delete' ? original : updated;
    const value = operation === 'update'
      ? `<span class="old">${esc(original)}</span><span class="arrow" aria-hidden="true">→</span><span class="sr-only">${esc(t('db.changedTo'))}</span>${esc(updated)}`
      : esc(operation === 'delete' ? original : updated);
    const style = operation === 'delete' ? 'old' : operation === 'insert' ? 'new' : '';
    return `<div class="k" title="${esc(key)}">${esc(key)}</div><div class="v ${style}" title="${esc(title)}">${value}</div>`;
  }).join('');
}

/** "Id 7d2e41a0…9f13": a row's primary key, with long values shortened in the middle. */
function rowKey(key) {
  if (key == null) return '';
  const short = value => { const text = serialize(value); return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text; };
  const entries = typeof key === 'object' && !Array.isArray(key) ? Object.entries(key) : [[null, key]];
  return entries.map(([name, value]) => `${name ? `<span class="k">${esc(name)}</span> ` : ''}<span class="ltr">${esc(short(value))}</span>`).join(' · ');
}

/**
 * A SQL row change. `grouped` cards (inside a store group) show the row's key in the head, as the
 * group head already counts rows; the classic list keeps "1 row".
 */
function changeCard(change, grouped = false) {
  const operation = String(change.operation || '').toLowerCase();
  const [style, label] = operations[operation] || ['', operation.toUpperCase()];
  const columns = Object.keys({ ...change.before, ...change.after })
    .filter(key => operation !== 'update' || serialize(change.before?.[key]) !== serialize(change.after?.[key]));
  const leading = columns.slice(0, 5);
  const rest = columns.slice(5);
  return `<article class="table-change" aria-label="${esc(t('db.cardLabel', { table: change.table, operation }))}">
    <div class="tc-head">${label ? `<span class="op-badge op-${style}">${esc(label)}</span>` : ''}
      <span class="name" title="${esc(change.table)}">${esc(change.table)}</span>
      <span class="spacer"></span>${grouped && change.key != null
        ? `<span class="faint tc-key" title="${esc(serialize(change.key))}">${rowKey(change.key)}</span>`
        : `<span class="faint" title="${esc(serialize(change.key))}">${esc(t('db.rows', { n: 1 }))}</span>`}
    </div>
    <div class="kv">${renderRows(change, leading)}</div>
    ${rest.length ? `<details><summary class="more-cols">${icon('chevron-down', true)}${esc(t('db.moreColumns', { n: rest.length }))}</summary>
      <div class="kv">${renderRows(change, rest)}</div></details>` : ''}
  </article>`;
}

/** True once stores other than the SQL database are part of the picture. */
export const groupsByStore = (result, capabilities = {}) =>
  (result.changes || []).some(change => change?.store) || dataStores(capabilities).length > 0;

/** The changes by store, SQL first, then in the order stores first appear. */
function storeGroups(changes) {
  const groups = new Map();
  changes.forEach((change, index) => {
    const system = change.store ? String(change.store).toLowerCase() : SQL;
    if (!groups.has(system)) groups.set(system, []);
    groups.get(system).push({ change, index });
  });
  return [...groups].sort(([a], [b]) => (a === SQL ? -1 : b === SQL ? 1 : 0));
}

/** The stores this request only read: commands in the logs, no changes. */
function readOnlyStores(result, systems) {
  const read = new Set();
  for (const log of result.logs || []) {
    if (log?.db?.system) read.add(String(log.db.system).toLowerCase());
    else if (log?.sql?.text || String(log?.level).toLowerCase() === 'sql') read.add(SQL);
  }
  return [...read].filter(system => !systems.includes(system));
}

/** What happened to a store's writes: rolled back, aborted, or committed by Send. */
function groupState(system, preview, capabilities) {
  if (!preview) return [icon('check', true), t('stores.state.committed')];
  if (system === SQL) return [icon('undo', true), t('stores.state.rolledBack')];
  return [icon('undo', true), t(dataStore(capabilities, system)?.mode === 'guard' ? 'stores.state.blocked' : 'stores.state.aborted')];
}

/** One store's head: mark, name, database, state and count. `mark` is the SQL provider for SQL. */
function groupHead(system, entries, result, capabilities) {
  const sqlMark = system === SQL ? sqlSystem(capabilities) : system;
  const databaseName = system === SQL
    ? (typeof capabilities.database === 'string' ? capabilities.database : capabilities.database?.name)
    : entries.find(entry => entry.change.namespace)?.change.namespace || dataStore(capabilities, system)?.name;
  const [glyph, state] = groupState(system, result.preview, capabilities);
  return `<header class="sg-head">${storeMark(sqlMark, 20)}<h3 id="store-group-${esc(system)}">${esc(storeName(sqlMark))}</h3>${databaseName ? `<code class="ltr">${esc(databaseName)}</code>` : ''}<span class="sg-state${result.preview ? '' : ' is-ok'}">${glyph}${esc(state)}</span><span class="spacer"></span><span class="sg-count">${esc(recordCount(sqlMark, entries.length))}</span></header>`;
}

/**
 * "Covered in Development: SQLite and MongoDB roll back; Redis and DynamoDB block writes. Stores
 * and clients Sendproof didn't hook aren't covered." Built from discovery, so it never claims more
 * than the binding said.
 */
export function coverageNote(capabilities = {}) {
  const stores = dataStores(capabilities);
  if (!stores.length) return '';
  const label = store => esc(storeName(store.system)) + (store.name ? ` <code class="ltr">${esc(store.name)}</code>` : '');
  const hasSql = !!(typeof capabilities.database === 'string' ? capabilities.database : capabilities.database?.name);
  const rolled = [...(hasSql ? [esc(storeName(sqlSystem(capabilities)))] : []), ...stores.filter(store => store.mode === 'preview').map(label)];
  const blocked = stores.filter(store => store.mode === 'guard').map(label);
  const parts = [];
  if (rolled.length) parts.push(th('stores.cover.rolled', { stores: formatList(rolled), n: rolled.length }));
  if (blocked.length) parts.push(th('stores.cover.blocked', { stores: formatList(blocked), n: blocked.length }));
  const env = capabilities.environment ? th('stores.cover.in', { env: esc(capabilities.environment) }) + ' ' : '';
  return `<p class="cov">${icon('shield', true)}<span>${env}${parts.join(t('stores.cover.separator'))}. ${esc(t('stores.cover.limit'))}</span></p>`;
}

/** Changes grouped by store: a jump strip when there is more than one, then a section per store. */
function groupedMarkup(result, capabilities) {
  const groups = storeGroups(result.changes);
  const systems = groups.map(([system]) => system);
  const read = readOnlyStores(result, systems);
  const markFor = system => system === SQL ? sqlSystem(capabilities) : system;
  const strip = groups.length > 1 || read.length ? `<nav class="ss" aria-label="${esc(t('stores.strip'))}">
      ${groups.length > 1 ? groups.map(([system, entries]) => `<button type="button" class="ss-item" data-store-jump="${esc(system)}">${storeMark(markFor(system))}<span>${esc(storeName(markFor(system)))}</span><span class="n">${esc(recordCount(markFor(system), entries.length))}</span></button>`).join('') : ''}
      ${read.length ? `<span class="ss-note">${icon('eye', true)}<span>${esc(t('stores.readOnly'))} ${read.map(system => `<span class="ss-st">${storeMark(markFor(system))}${esc(storeName(markFor(system)))}</span>`).join(' ')}</span></span>` : ''}
    </nav>` : '';
  const sections = groups.map(([system, entries]) => `<section class="sg" aria-labelledby="store-group-${esc(system)}">
      ${groupHead(system, entries, result, capabilities)}
      <div class="sg-list">${entries.map(({ change, index }) => system === SQL ? changeCard(change, true) : docCard(change, index)).join('')}</div>
    </section>`).join('');
  return strip + sections;
}

/** Render actual captured row deltas and a compact summary linking to the effects (mocks 01, 49). */
export function databaseMarkup(result, capabilities) {
  const count = result.changes.length;
  const databaseName = typeof capabilities.database === 'string' ? capabilities.database : capabilities.database?.name;
  const db = databaseName ? `<code class="ltr">${esc(databaseName)}</code>` : esc(t('db.thisDatabase'));
  const actor = capabilities.identity?.name;
  const vars = { db, name: esc(actor || ''), n: count };
  const grouped = groupsByStore(result, capabilities);
  // Stores in the order their groups appear: the SQL database first.
  const touched = storeGroups(result.changes || []).map(([system]) => system === SQL ? sqlSystem(capabilities) : system);
  const storeVars = { ...vars, stores: esc(formatList(touched.map(storeName))) };
  const banner = result.preview
    ? `<div class="banner">${icon('undo')}<div><strong>${esc(t('db.rolledTitle'))}</strong> ${grouped
      ? th(actor ? 'stores.rolledBodyAs' : 'stores.rolledBody', storeVars)
      : th(actor ? 'db.rolledBodyAs' : 'db.rolledBody', vars)}</div></div>`
    : result.status < 400
      ? `<div class="banner banner-ok">${icon('check')}<div><strong>${esc(t('db.committedTitle'))}</strong> ${th(actor ? 'db.committedBodyAs' : 'db.committedBody', vars)}</div><button type="button" class="btn btn-ghost btn-xs" data-action="traced-off">${esc(t('res.tracedOff'))}</button></div>`
      : `<div class="banner banner-neutral">${icon('info')}<div><strong>${esc(t('db.capturedTitle'))}</strong> ${th('db.capturedBody', vars)}</div></div>`;
  const effect = result.effects?.find(item => item.kind === 'email') || result.effects?.[0];
  const matching = effect ? result.effects.filter(item => item.kind === effect.kind) : [];
  const effectSummary = effect ? `<div class="effect">
    ${icon(effect.kind === 'email' ? 'mail' : 'send')}<div class="grow">
      <div class="t">${esc(t(`db.effect.${effect.kind === 'email' ? 'email' : 'other'}.${result.preview ? 'held' : 'recorded'}`, { n: matching.length, kind: effect.kind }))}</div>
      <div class="s" lang="en">${esc(effect.description)}</div>
    </div><button type="button" class="btn btn-ghost btn-sm" data-result-tab="Side effects">${esc(t('db.view'))}</button>
  </div>` : '';
  return `${banner}
    ${grouped ? groupedMarkup(result, capabilities) : result.changes.map(change => changeCard(change)).join('')}
    ${result.changesTruncated ? `<p class="faint">${esc(t('db.truncated'))}</p>` : ''}
    ${grouped ? coverageNote(capabilities) : ''}
    ${effectSummary}`;
}

/** Wires the store jump strip and the document diffs of a rendered Database tab. */
export function bindDatabase(container, result) {
  bindDocDiffs(container, result.changes || []);
  container.addEventListener('click', event => {
    const jump = event.target.closest('[data-store-jump]');
    if (!jump) return;
    const head = container.querySelector(`#store-group-${CSS.escape(jump.dataset.storeJump)}`);
    head?.closest('.sg')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}
