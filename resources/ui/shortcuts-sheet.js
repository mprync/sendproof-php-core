// The keyboard shortcut sheet (?), built from the shortcut registry (mock 55). Search filters
// every registered shortcut; without a query it shows the curated overview below.
import { esc, icon } from './components.js';
import { t } from './i18n.js';
import { matchesShortcut, shortcutHint, shortcutLabel, shortcutLong, SHORTCUTS } from './shortcuts.js';

const sections = ['General', 'Navigate', 'Request', 'Fields', 'Headers & lists', 'Result'];
// [label key or shortcut id, ...shortcut ids]. A label key starts with "sheet.".
const overview = [
  [['palette'], ['shortcuts'], ['display'], ['sidebar'], ['theme'], ['history'], ['signin']],
  [['filter'], ['sheet.nextPrevious', 'next', 'previous'], ['sheet.sidebarTabs', 'sidebar-operations', 'sidebar-models'], ['docs'],
    ['request-tab-range'], ['result-tab-range'], ['model-back']],
  [['preview'], ['send'], ['autofill-required'], ['editor-mode'], ['issue-next'], ['copy-url']],
  [['generate'], ['generate-menu'], ['field-info'], ['lookup-open'], ['autofill-ids'], ['autofill-undo']],
  [['add-row'], ['remove-row'], ['toggle-header'], ['bulk-edit']],
  [['copy-curl'], ['copy-response'], ['follow-response'], ['sheet.changes', 'change-next', 'change-prev'], ['escape']],
];

const row = (label, ids) => `<div class="sc-row"><span>${esc(label)}</span><span class="sc-keys">${ids.map(id => shortcutHint(id)).join('<span class="then" aria-hidden="true">/</span>')}</span></div>`;

/** Opens the shortcut sheet and keeps keyboard focus within it. */
export function showShortcuts(overlay) {
  const opener = document.activeElement?.closest('.palette') ? document.querySelector('.search-trigger') : document.activeElement;
  const app = document.querySelector('.app');
  overlay.innerHTML = `<div class="scrim shortcuts-scrim">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="sc-title">
      <div class="dialog-head">
        <h2 id="sc-title">${esc(t('sheet.title'))}</h2>
        <label class="input-sm">${icon('search', true)}<span class="sr-only">${esc(t('sheet.search'))}</span><input placeholder="${esc(t('sheet.search'))}" type="search"></label>
        <span class="spacer"></span><span class="faint desktop-only" style="font-size:var(--fs-sm)">${esc(t('sheet.note', { example: shortcutLong('send') }))}</span>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="${esc(t('sheet.close'))}">${icon('x', true)}</button>
      </div>
      <div class="dialog-body"></div>
    </section></div>`;
  const dialog = overlay.querySelector('.dialog');
  const input = overlay.querySelector('input');
  const dismiss = overlay.querySelector('.dialog-head button');
  const body = overlay.querySelector('.dialog-body');
  // Journeys shortcuts are listed only where Journeys mode exists (the mode switch is drawn).
  const journeys = !!document.querySelector('[data-mode]');
  const all = Object.entries(SHORTCUTS).filter(([, definition]) => definition.group && (definition.chord || definition.sequence) && (!definition.journeys || journeys));
  if (app) app.inert = true;

  function render() {
    const query = input.value.trim().toLowerCase();
    body.innerHTML = sections.map((section, index) => {
      const rows = query
        ? all.filter(([id, definition]) => definition.group === section && shortcutLabel(id).toLowerCase().includes(query)).map(([id]) => row(shortcutLabel(id), [id]))
        : overview[index].map(([first, ...rest]) => first.startsWith('sheet.') ? row(t(first), rest) : row(shortcutLabel(first), [first]));
      return rows.length ? `<section class="sc-group" aria-label="${esc(t('sheet.group.' + section))}"><h3>${esc(t('sheet.group.' + section))}</h3>${rows.join('')}</section>` : '';
    }).join('') || `<p class="faint" role="status">${esc(t('sheet.none'))}</p>`;
  }
  function close() {
    overlay.innerHTML = '';
    if (app) app.inert = false;
    opener?.focus();
  }

  dialog.addEventListener('keydown', event => {
    if (matchesShortcut('escape', event)) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === 'Tab' && !event.shiftKey && document.activeElement === dismiss) {
      event.preventDefault(); input.focus();
    } else if (event.key === 'Tab' && event.shiftKey && document.activeElement === input) {
      event.preventDefault(); dismiss.focus();
    }
  });
  dismiss.addEventListener('click', close);
  overlay.querySelector('.scrim').addEventListener('click', event => {
    if (event.target === event.currentTarget) close();
  });
  input.addEventListener('input', render);
  render();
  input.focus();
}
