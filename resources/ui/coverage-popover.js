// The environment chip's panel (docs/plans/data-stores.md, "Coverage disclosure"): every store
// the binding hooked, from discovery's `dataStores`, with what Preview does to it, and the plain
// statement that stores and clients the binding never saw are not covered. Opened from the top
// bar's environment chip, which is a button only when discovery lists stores.
import { esc, icon } from './components.js';
import { t } from './i18n.js';
import { openPopoverAt } from './popover.js';
import { dataStores, sqlSystem, storeMark, storeName } from './stores.js';

/** The rows: the SQL database first (it always rolls back), then each hooked store. */
export function coverageRows(capabilities = {}) {
  const database = typeof capabilities.database === 'string' ? capabilities.database : capabilities.database?.name;
  const rows = database ? [{ system: sqlSystem(capabilities), name: database, mode: 'preview', reason: '' }] : [];
  return [...rows, ...dataStores(capabilities)];
}

/** The panel's markup, also used by tests. */
export function coverageMarkup(capabilities = {}) {
  const row = store => `<li class="cov-row">
      ${storeMark(store.system, 20)}
      <span class="stack"><span class="main">${esc(storeName(store.system))}${store.name ? ` <code class="ltr">${esc(store.name)}</code>` : ''}</span>
        <span class="sub">${store.reason ? `<span lang="en">${esc(store.reason)}</span>` : esc(t(store.mode === 'preview' ? 'cov.preview' : 'cov.guard'))}</span></span>
      <span class="mode-pill is-${store.mode}">${icon(store.mode === 'preview' ? 'undo' : 'ban', true)}${esc(t(store.mode === 'preview' ? 'cov.mode.preview' : 'cov.mode.guard'))}</span>
    </li>`;
  return `<div class="pop cov-pop" role="dialog" aria-labelledby="coverage-title">
    <div class="pop-head"><span id="coverage-title">${esc(t('cov.title', { env: capabilities.environment || '' }))}</span></div>
    <ul class="cov-list">${coverageRows(capabilities).map(row).join('')}</ul>
    <p class="cov-foot">${icon('shield', true)}<span>${esc(t('cov.limit'))}</span></p>
  </div>`;
}

/** Opens the panel under the environment chip. */
export function openCoverage(anchor, { capabilities }) {
  openPopoverAt(anchor, coverageMarkup(capabilities), { align: 'start', kind: 'coverage', focus: false });
}
