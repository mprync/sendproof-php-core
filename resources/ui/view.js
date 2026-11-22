// The workbench shell: top bar, sidebar, request and result panes, the reading view used by
// Docs, Models and the API overview, and the pane dividers. Mocks: shell.js, workbench.html.
import { esc, icon, method, tab } from './components.js';
import { t } from './i18n.js';
import { shortcutAttrs, shortcutHint, shortcutLong, shortcutLabel } from './shortcuts.js';

export { esc, icon, method };

/** Two-letter initials for an avatar. */
export const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';

/** A tooltip title with the long shortcut form: "History · ⌘Y". */
const titled = (label, id) => `${label} · ${shortcutLong(id)}`;

function persona(user) {
  if (!user?.name) {
    return `<button type="button" class="btn btn-primary btn-sm signin-cta" data-action="signin" ${shortcutAttrs('signin')} title="${esc(titled(t('shell.signIn'), 'signin'))}">${icon('log-in', true)}${esc(t('shell.signIn'))}</button>`;
  }
  // The name is the visible text plus a hidden suffix, so voice users can say what they see (WCAG 2.5.3).
  return `<button type="button" class="persona" data-action="signin" aria-haspopup="dialog" ${shortcutAttrs('signin')} title="${esc(titled(shortcutLabel('signin'), 'signin'))}">
      <span class="avatar" aria-hidden="true">${esc(initials(user.name))}</span><span class="name">${esc(user.name)}</span>${user.role ? ` <span class="role">${esc(user.role)}</span>` : ''}<span class="sr-only">${esc(t('shell.signedInSuffix'))}</span>${icon('chevron-down', true)}
    </button>`;
}

/**
 * The environment and its database. When discovery lists hooked data stores, the chip is a button
 * that opens what Preview covers (coverage-popover.js); otherwise it is a label.
 */
function envChip(cap, database) {
  const inner = `<span class="dot" aria-hidden="true"></span><strong>${esc(cap.environment)}</strong>${database ? `<span class="ltr">${esc(database)}</span>` : ''}`;
  if (!(Array.isArray(cap.dataStores) && cap.dataStores.length)) return `<span class="env desktop-only">${inner}</span>`;
  return `<button type="button" class="env desktop-only" data-action="coverage" aria-haspopup="dialog" aria-expanded="false" title="${esc(t('cov.open'))}">${inner}${icon('chevron-down', true)}</button>`;
}

function topbar(cap, info) {
  const database = typeof cap.database === 'string' ? cap.database : cap.database?.name;
  const version = info.version ? `<span class="ver">${esc(/^\d/.test(info.version) ? 'v' + info.version : info.version)}</span>` : '';
  const toolButton = (id, glyph, label) => `<button type="button" class="btn btn-ghost btn-icon btn-sm desktop-only" id="${id}-btn" data-action="${id}" aria-label="${esc(label)}" title="${esc(titled(label, id))}" ${shortcutAttrs(id)}>${icon(glyph, true)}</button>`;
  return `<header class="topbar">
    <button type="button" class="btn btn-ghost btn-icon mobile-only" data-action="navigation" aria-label="${esc(t('shell.openOperations'))}" aria-controls="operations" aria-expanded="false">${icon('menu')}</button>
    <div class="brand"><span class="brand-mark" aria-hidden="true">${icon('mark')}</span><span class="desktop-only">${esc(t('app.name'))}</span></div>
    <span class="crumb-sep desktop-only" aria-hidden="true">/</span>
    <span class="api-switch"><span class="name" lang="en" dir="auto">${esc(cap.apiName || info.title || 'API')}</span>${version}</span>
    ${cap.environment || database ? envChip(cap, database) : ''}
    <div class="spacer"></div>
    <button type="button" class="search-trigger" data-action="palette" ${shortcutAttrs('palette')}>
      ${icon('search', true)}<span class="grow">${esc(t('shell.search'))}</span>${shortcutHint('palette')}
    </button>
    ${toolButton('display', 'sliders', t('shell.display'))}
    ${toolButton('history', 'history', t('shell.history'))}
    ${toolButton('shortcuts', 'keyboard', t('shell.shortcuts'))}
    ${persona(cap.identity)}
  </header>`;
}

function sidebar() {
  return `<nav class="sidebar" id="operations" aria-label="${esc(t('side.operations'))}">
    <div class="tabs" role="tablist" aria-label="${esc(t('side.browse'))}">
      ${tab(t('side.operations'), { selected: true, count: '–', id: 'side-tab-operations', controls: 'nav', shortcut: 'sidebar-operations', data: `data-side-tab="operations" title="${esc(t('side.operations'))}"` })}
      ${tab(t('side.models'), { count: '–', id: 'side-tab-models', controls: 'nav', shortcut: 'sidebar-models', data: `data-side-tab="models" title="${esc(t('side.models'))}"` })}
    </div>
    <div data-auth-notice hidden></div>
    <div class="sidebar-search">
      <label class="input-sm">${icon('filter', true)}<span class="sr-only" data-filter-label>${esc(t('side.filterOperations'))}</span>
        <input id="filter" placeholder="${esc(t('side.filterOperations'))}" type="search" autocomplete="off" ${shortcutAttrs('filter')}>
        <span data-filter-end>${shortcutHint('filter')}</span>
      </label>
    </div>
    <div class="nav" id="nav" role="tabpanel" aria-labelledby="side-tab-operations"></div>
    <div class="pane-bar side-bar"></div>
  </nav>`;
}

/** The landmarks and panel containers of the approved workbench mock. */
export function shell(capabilities, info = {}) {
  return `<a class="skip-link" href="#request">${esc(t('shell.skip'))}</a>
  <div class="app">
    ${topbar(capabilities, info)}
    <div class="mobile-switch">
      <div class="segmented" role="group" aria-label="${esc(t('shell.show'))}">
        <button type="button" data-view="request" aria-pressed="true">${esc(t('shell.request'))}</button>
        <button type="button" data-view="response" aria-pressed="false">${esc(t('shell.result'))}</button>
      </div>
    </div>
    <div class="workspace" data-view="request">
      ${sidebar()}
      <main class="pane request" id="request" aria-labelledby="op-title" tabindex="-1">
        <div id="context"></div>
        <div class="pane-scroll">
          <div id="operation"></div>
          <div class="tabs scrolls"><div class="request-tabs" role="tablist" aria-label="${esc(t('shell.request'))}"></div><div class="end request-tools"></div></div>
          <div id="editor" class="form" role="tabpanel"></div>
        </div>
        <!-- Why an operation marked preview: false can't Preview; filled by results.renderBar. -->
        <div class="pv-dock" data-preview-dock role="note" aria-labelledby="preview-dock-title" tabindex="-1" hidden></div>
        <div class="actionbar"></div>
      </main>
      <section class="pane response" aria-labelledby="resp-title" tabindex="-1">
        <h2 id="resp-title" class="sr-only">${esc(t('shell.result'))}</h2>
        <div class="resp-head" role="status" aria-live="polite"></div>
        <div class="progress" aria-hidden="true"></div>
        <div class="tabs scrolls" role="tablist" aria-label="${esc(t('shell.result'))}"></div>
        <div class="pane-scroll" id="result" role="tabpanel"></div>
        <div class="pane-bar result-bar"></div>
      </section>
      <!-- Docs, Models and the overview take the request and result columns, so widths never change. -->
      <main class="pane doc-pane" id="doc-pane" tabindex="-1" hidden></main>
      <aside class="pane aside-pane" id="aside-pane" hidden></aside>
      ${resizeHandle('sidebar', 'operations', t('shell.resizeSidebar'))}
      ${resizeHandle('request', 'request', t('shell.resizePanes'))}
    </div>
    <div class="sr-only" role="status" aria-live="polite" data-request-announcement></div>
  </div>
  <div id="overlay"></div>`;
}

function resizeHandle(type, controls, label) {
  return `<div class="resize-handle" data-layout-divider="${type}" tabindex="0" role="separator"
    aria-orientation="vertical" aria-label="${esc(label)}" aria-controls="${controls}" ${shortcutAttrs('left', 'right', 'home', 'end', 'pageup', 'pagedown')}>
    <span class="size-tip" aria-hidden="true" hidden></span>
  </div>`;
}
