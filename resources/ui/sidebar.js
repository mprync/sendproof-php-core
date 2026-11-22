// The sidebar (mocks/sidebar.js): Operations and Models tabs, the signed-out notice, the filter,
// tag and model groups, and the foot bar.
//
//  - Every group starts open (List pages in Models start closed). Each heading collapses its
//    group, the choice is remembered per API in localStorage, and "Collapse all" lives in the foot.
//  - Signed out, a notice at the top says how many operations need sign-in; locked rows carry a
//    lock. Deprecated and locked markers stack. Signed in, role-restricted rows carry a shield.
//  - The tab changes only when the user picks it. An operation a model was opened from stays
//    marked as the current context (`.is-context`, aria-current="location").
import { esc, icon, method, stateBlock } from './components.js';
import { formatNumber, t, th } from './i18n.js';
import { isPublic, requiredScopes, scopeText } from './security.js';
import { shortcutAttrs, shortcutHint } from './shortcuts.js';
import { modelGroups, modelKind, modelSize } from './schema-model.js';
import { opKey } from './operations.js';
import { previewUnavailable } from './stores.js';
import { bindDeprecationTips, deprecationTipParts } from './deprecation.js';

/** Edit distance, used to suggest a likely intended filter. */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

/** The closest word to a query among names, for "Try “payment”". */
export function suggestion(query, words) {
  let best;
  for (const word of new Set(words.map(item => item.toLowerCase()).filter(item => item.length > 2))) {
    const score = distance(query, word);
    if (score <= Math.max(1, Math.floor(query.length / 3)) && (!best || score < best.score)) best = { word, score };
  }
  return best?.word;
}

const searchText = op => `${op.title} ${op.path} ${op.method} ${op.group} ${op.operation.operationId || ''} ${(op.operation.tags || []).join(' ')}`.toLowerCase();

/** Models groups that start collapsed, until the user opens them. */
const COLLAPSED_BY_DEFAULT = new Set(['lists']);

/** The storage key of the remembered group state for one API document. */
export const navStorageKey = documentUrl => `sendproof-nav:${documentUrl || ''}`;

/**
 * Reads the remembered group state: `{ ops: { [tag]: boolean }, models: { [group]: boolean } }`
 * where true means collapsed. Anything unreadable means "nothing remembered".
 */
export function loadNavState(storage, documentUrl) {
  try {
    const value = JSON.parse(storage?.getItem(navStorageKey(documentUrl)) || 'null');
    const clean = source => Object.fromEntries(Object.entries(source && typeof source === 'object' ? source : {}).filter(([, flag]) => typeof flag === 'boolean'));
    return { ops: clean(value?.ops), models: clean(value?.models) };
  } catch { return { ops: {}, models: {} }; }
}

/** Writes the remembered group state; storage that is full or blocked is ignored. */
export function saveNavState(storage, documentUrl, nav) {
  try { storage?.setItem(navStorageKey(documentUrl), JSON.stringify(nav)); } catch { /* A blocked store only forgets the choice. */ }
}

/** Tag groups in the document's tag order, then any tags only operations mention. */
export function operationGroups(ops, document) {
  const map = new Map((document?.tags || []).map(tag => [tag.name, []]));
  for (const op of ops) {
    if (!map.has(op.group)) map.set(op.group, []);
    map.get(op.group).push(op);
  }
  return [...map].filter(([, items]) => items.length);
}

/** Sidebar rendering and its small amount of state. */
export function createSidebar({ state, $, storage = globalThis.localStorage }) {
  let tab = 'operations';
  let nav = { ops: {}, models: {} };
  let loadedFor;

  bindDeprecationTips();
  const signedIn = () => !!state.cap?.identity?.name;
  const models = () => Object.entries(state.doc?.components?.schemas || {});
  const groups = () => operationGroups(state.ops, state.doc);
  const loaded = () => {
    if (loadedFor !== state.documentUrl) { loadedFor = state.documentUrl; nav = loadNavState(storage, state.documentUrl); }
    return nav;
  };
  const isCollapsed = (kind, key) => loaded()[kind][key] ?? (kind === 'models' && COLLAPSED_BY_DEFAULT.has(key));
  const remember = (kind, key, collapsed) => { loaded()[kind][key] = collapsed; saveNavState(storage, state.documentUrl, nav); };

  /** Whether the signed-in user's role is outside the roles an operation names (admins pass anything they're listed for). */
  function restricted(op) {
    const scopes = requiredScopes(op, state.doc);
    const identity = state.cap?.identity;
    const roles = [identity?.role, ...(identity?.roles || [])].filter(Boolean);
    return scopes.length > 0 && !scopes.some(scope => roles.includes(scope));
  }

  /** Deprecated and locked (or role) markers stack; each has a tooltip and screen-reader text. */
  function trail(op) {
    const out = [];
    const mark = (glyph, label, cls = '') => out.push(`<span${cls ? ` class="${cls}"` : ''} title="${esc(label)}">${icon(glyph, true)}<span class="sr-only">${esc(label)}</span></span>`);
    if (op.operation.deprecated) mark('warn', t('side.deprecated'));
    // Marked preview: false by the API author (mock 122): the reason is in the tooltip.
    const noPreview = !['GET', 'HEAD', 'OPTIONS'].includes(op.method) && previewUnavailable(op, state.cap);
    if (noPreview) mark('flask-off', noPreview.reason ? `${t('side.noPreview')} · ${noPreview.reason}` : t('side.noPreview'), 'no-preview');
    if (!isPublic(op, state.doc)) {
      if (!signedIn()) mark('lock', t('side.needsSignIn'), 'lock');
      else if (restricted(op)) mark('shield', t('side.needsScope', { scope: scopeText(op, state.doc) }));
    }
    return out.length ? `<span class="trail">${out.join('')}</span>` : '';
  }

  function noMatch(query, names, forModels = false) {
    const guess = suggestion(query, names.flatMap(name => name.split(/[^\p{L}\p{N}]+/u)));
    return `<div class="nav-state">${stateBlock({
      glyph: 'search', compact: true, title: esc(t(forModels ? 'side.noMatchModelsTitle' : 'side.noMatchTitle', { query })),
      body: esc(t(forModels ? 'side.noMatchModelsBody' : 'side.noMatchBody')),
      actions: [`<button type="button" class="btn btn-sm" data-action="clear-filter">${esc(t('side.clearFilter'))} ${shortcutHint('escape')}</button>`,
        guess ? `<button type="button" class="btn btn-ghost btn-sm" data-filter-suggestion="${esc(guess)}">${esc(t('side.try', { query: guess }))}</button>` : ''].filter(Boolean),
    })}</div>`;
  }

  /** A group with a disclosure heading and its list. `open` is forced while filtering. */
  function group(id, kind, key, label, count, open, items, lang = true) {
    return `<div class="nav-group">
      <button type="button" class="nav-heading" data-group="${esc(key)}" data-group-kind="${kind}" aria-controls="${id}" aria-expanded="${open}">${icon(open ? 'chevron-down' : 'chevron-right', true)}<span${lang ? ' lang="en"' : ''}>${esc(label)}</span><span class="count">${formatNumber(count)}</span></button>
      <ul id="${id}" ${open ? '' : 'hidden'}>${items}</ul>
    </div>`;
  }

  function operationList(query) {
    if (!state.ops.length) return stateBlock({
      glyph: 'list', compact: true, title: esc(t('side.emptyTitle')),
      body: th('side.emptyBody', { url: `<code class="ltr">${esc(new URL(state.documentUrl, location.href).pathname)}</code>` }),
      actions: [`<button type="button" class="btn btn-sm" data-action="restart" ${shortcutAttrs('reload-spec')}>${icon('refresh', true)}${esc(t('side.reload'))} ${shortcutHint('reload-spec')}</button>`],
    });
    const matching = groups().map(([name, items]) => [name, items.filter(op => searchText(op).includes(query))]).filter(([, items]) => items.length);
    if (!matching.length) return noMatch(query, state.ops.flatMap(op => [op.title, op.group, ...(op.operation.tags || [])]));
    const context = state.view === 'model' ? state.modelFrom?.op : undefined;
    const docs = state.view === 'docs';
    return matching.map(([name, items], index) => group(`nav-group-${index}`, 'ops', name, name, items.length, !!query || !isCollapsed('ops', name),
      items.map(op => {
        const current = op === state.op && (state.view === 'try' || state.view === 'docs');
        const here = current ? ' aria-current="page"' : op === context ? ' aria-current="location"' : '';
        // A deprecated row's tooltip says when it stops working and what to use (mock 90).
        const parts = op.operation.deprecated && deprecationTipParts(op, state.ops, state.doc);
        const tip = parts ? ` data-dep-tip="${esc(parts.head)}" data-dep-use="${esc(parts.use)}"` : ` title="${esc(op.title)}"`;
        return `<li><a class="nav-item${op.operation.deprecated ? ' is-deprecated' : ''}${op === context ? ' is-context' : ''}" href="#${docs ? 'docs' : 'op'}/${encodeURIComponent(opKey(op))}" data-op="${state.ops.indexOf(op)}"${tip}${here}>${method(op.method)}<span class="label-text" lang="en">${esc(op.title)}</span>${trail(op)}</a></li>`;
      }).join(''))).join('');
  }

  function modelList(query) {
    const all = models();
    if (!all.length) return stateBlock({
      glyph: 'box', compact: true, title: esc(t('side.noModelsTitle')),
      body: th('side.noModelsBody', { source: '<code class="ltr">components.schemas</code>' }),
    });
    const shown = new Set(all.filter(([name, schema]) => `${name} ${schema?.description || ''}`.toLowerCase().includes(query)).map(([name]) => name));
    if (!shown.size) return noMatch(query, all.map(([name]) => name), true);
    return modelGroups(state.doc).map(([key, names], index) => [key, names.filter(name => shown.has(name)), index]).filter(([, names]) => names.length).map(([key, names, index]) =>
      group(`model-group-${index}`, 'models', key, t('models.group.' + key), names.length, !!query || !isCollapsed('models', key), names.map(name => {
        const schema = state.doc.components.schemas[name];
        const kind = modelKind(schema, state.doc);
        const current = state.view === 'model' && state.model === name;
        return `<li><a class="nav-item" href="#model/${encodeURIComponent(name)}" data-pick-model="${esc(name)}" title="${esc(name)}"${current ? ' aria-current="page"' : ''}><span class="model-ico" title="${esc(t('side.kind.' + kind.id))}">${esc(kind.glyph)}<span class="sr-only">${esc(t('side.kind.' + kind.id))}</span></span><span class="label-text" lang="en">${esc(name)}</span><span class="trail num">${formatNumber(modelSize(schema, state.doc))}</span></a></li>`;
      }).join(''), false)).join('');
  }

  /** The signed-out notice: how many operations need sign-in and the ways to do it. */
  function notice() {
    const locked = state.ops.filter(op => !isPublic(op, state.doc)).length;
    if (signedIn() || !locked) return '';
    const providers = state.cap?.authProviders || [];
    const seeded = providers.some(provider => provider.kind?.toLowerCase() === 'personas' && provider.url);
    const actions = providers.length ? `<div class="an-actions">
        <button type="button" class="btn btn-primary btn-sm" data-action="signin" ${shortcutAttrs('signin')}>${icon('log-in', true)}${esc(t('shell.signIn'))}${shortcutHint('signin')}</button>
        ${seeded ? `<button type="button" class="btn btn-sm" data-action="seeded-menu" aria-haspopup="menu" aria-expanded="false">${esc(t('auth.out.seeded'))}${icon('chevron-down', true)}</button>` : ''}
      </div>` : '';
    return `<section class="auth-notice" aria-labelledby="auth-notice-title">
      <div class="an-title">${icon('lock', true)}<h2 id="auth-notice-title">${esc(t('auth.out.title'))}</h2></div>
      <p>${esc(t('auth.out.body', { n: formatNumber(locked), total: formatNumber(state.ops.length) }))}</p>${actions}
    </section>`;
  }

  /** The foot bar: counts, and Collapse all / Expand all for the operation groups. */
  function foot() {
    if (tab === 'models') return models().length
      ? `<span class="bar-text">${icon('box', true)}<span>${esc(t('side.footSchemas', { n: models().length }))}</span></span>` : '';
    if (!state.ops.length) return '';
    const everyGroupClosed = groups().every(([name]) => isCollapsed('ops', name));
    return `<span class="bar-text">${icon('list', true)}<span>${esc(t('side.footOps', { n: state.ops.length }))}</span></span>
      <button type="button" class="btn btn-ghost btn-xs" data-action="toggle-groups" title="${esc(t(everyGroupClosed ? 'side.expandAll' : 'side.collapseAll'))}">${icon('chevrons-ud', true)}<span class="lbl">${esc(t(everyGroupClosed ? 'side.expandAll' : 'side.collapseAll'))}</span></button>`;
  }

  /** Re-renders the tabs' counts, the notice, the filter's end slot, the list and the foot bar. */
  function render() {
    const input = $('#filter');
    const query = (input?.value || '').trim().toLowerCase();
    for (const button of document.querySelectorAll('[data-side-tab]')) {
      const selected = button.dataset.sideTab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      const badge = button.querySelector('.n');
      const count = button.dataset.sideTab === 'models' ? models().length : state.ops.length;
      if (badge) { badge.textContent = formatNumber(count); badge.classList.remove('unknown'); badge.removeAttribute('aria-hidden'); }
      button.querySelector('.sr-only')?.remove();
    }
    const placeholder = t(tab === 'models' ? 'side.filterModels' : 'side.filterOperations');
    if (input) input.placeholder = placeholder;
    const label = $('[data-filter-label]');
    if (label) label.textContent = placeholder;
    const end = $('[data-filter-end]');
    if (end) end.innerHTML = query
      ? `<button type="button" class="btn btn-ghost btn-icon btn-xs" data-action="clear-filter" aria-label="${esc(t('side.clearFilter'))}">${icon('x', true)}</button>`
      : shortcutHint('filter');
    const noticeSlot = $('[data-auth-notice]');
    if (noticeSlot) { noticeSlot.innerHTML = notice(); noticeSlot.hidden = !noticeSlot.innerHTML; }
    const list = $('.nav');
    list.setAttribute('aria-labelledby', `side-tab-${tab}`);
    const scroll = list.scrollTop;
    list.innerHTML = tab === 'models' ? modelList(query) : operationList(query);
    list.scrollTop = scroll;
    const bar = $('.side-bar');
    bar.innerHTML = query && !list.querySelector('.nav-item') ? '' : foot();
    // A long translation ("40 Operationen" beside "Alle einklappen") keeps the count whole: the
    // toggle gives way to its icon, its name stays in aria-label and the tooltip.
    const count = bar.querySelector('.bar-text > span');
    const toggle = bar.querySelector('[data-action="toggle-groups"]');
    if (count && toggle && count.scrollWidth > count.clientWidth + 1) {
      toggle.classList.add('btn-icon');
      toggle.setAttribute('aria-label', toggle.title);
      toggle.querySelector('.lbl').hidden = true;
    }
  }

  /** Opens or closes one group from its heading and remembers the choice. */
  function toggleGroup(heading) {
    const list = heading.nextElementSibling;
    const expand = list.hidden;
    remember(heading.dataset.groupKind, heading.dataset.group, !expand);
    list.hidden = !expand;
    heading.setAttribute('aria-expanded', String(expand));
    heading.querySelector('use').setAttribute('href', expand ? '#i-chevron-down' : '#i-chevron-right');
    if (heading.dataset.groupKind === 'ops') render();
  }

  /** Collapses every operation group, or opens them all when they are all collapsed. */
  function toggleAll() {
    const collapse = !groups().every(([name]) => isCollapsed('ops', name));
    for (const [name] of groups()) remember('ops', name, collapse);
    render();
    $('[data-action="toggle-groups"]')?.focus();
  }

  /** Switches to the tab that holds a group, opens the group and moves focus to its heading. */
  function reveal(kind, key) {
    const wanted = kind === 'models' ? 'models' : 'operations';
    if (tab !== wanted) tab = wanted;
    const input = $('#filter');
    if (input) input.value = '';
    remember(kind, key, false);
    render();
    const heading = document.querySelector(`[data-group-kind="${kind}"][data-group="${CSS.escape(key)}"]`);
    heading?.focus();
    heading?.scrollIntoView?.({ block: 'nearest' });
  }

  return {
    render, toggleGroup, toggleAll, reveal,
    get tab() { return tab; },
    /** Picks the tab without drawing (before the shell exists). */
    setTab(next) { tab = next; },
    selectTab(next, { focusFilter = false } = {}) {
      if (next !== tab) {
        tab = next;
        const input = $('#filter');
        if (input) input.value = '';
      }
      render();
      if (focusFilter) $('#filter')?.focus();
    },
  };
}
