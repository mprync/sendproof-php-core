import { t } from './i18n.js';
import { backTarget } from './router.js';
import { resultTabLabel } from './result-states.js';
import { matchesShortcut, shortcutLabel, SHORTCUTS } from './shortcuts.js';

function editing(target) {
  return target?.closest?.('input, textarea, select, [contenteditable=true]');
}

/** Resolve the current command against the visible request, field and result. */
export function createCommands({ $, state, chooseTab, chooseResult, chooseOperation, fill, preview,
  send, openPalette, openSheet, openSidebar, changePane, issues, addHeader, bulkEdit, toggleHeader, copyResponse,
  openDisplay, openHistory, toggleTheme, toggleDocs, sidebarTab, modelBack, generate, toggleTrace, traceAvailable,
  reloadSpec, canReload,
}) {
  const click = selector => $(selector)?.click();
  const requestTab = () => [...document.querySelectorAll('.request-tabs [data-request-tab]')];
  const resultTab = () => [...document.querySelectorAll('.response .tabs [data-result-tab]')];
  const moveOperation = step => {
    const start = state.ops.indexOf(state.op);
    if (state.ops.length) chooseOperation((start + step + state.ops.length) % state.ops.length);
  };
  const header = callback => {
    changePane('request');
    if (state.tab !== 'Headers') chooseTab('Headers');
    callback();
  };
  const nextChange = step => {
    const changes = [...document.querySelectorAll('.response .table-change')];
    if (!changes.length) return;
    const current = changes.indexOf(document.activeElement);
    const next = changes[(current < 0 ? step > 0 ? 0 : changes.length - 1 :
      (current + step + changes.length) % changes.length)];
    next.tabIndex = -1;
    next.focus();
  };
  const actions = {
    palette: () => openPalette(),
    shortcuts: () => openSheet(),
    sidebar: () => openSidebar(),
    display: () => openDisplay(),
    theme: () => toggleTheme(),
    history: () => openHistory(),
    signin: () => click('.topbar [data-action="signin"]'),
    docs: () => toggleDocs(),
    'sidebar-operations': () => sidebarTab('operations'),
    'sidebar-models': () => sidebarTab('models'),
    'model-back': () => modelBack(),
    generate: target => generate(target, false),
    'generate-menu': target => generate(target, true),
    'field-info': target => {
      const button = target.closest?.('.field')?.querySelector('.info-btn');
      if (!button) return false;
      button.click();
    },
    'traced-send': () => toggleTrace(),
    'reload-spec': () => reloadSpec(),
    filter: () => {
      if (!$('#filter').getClientRects().length) openSidebar(true);
      $('#filter').focus();
    },
    next: () => moveOperation(1),
    previous: () => moveOperation(-1),
    'goto-operation': () => openPalette(false, 'Operations'),
    'focus-pane': target => changePane(target?.closest('.response') ? 'request' : 'response', true),
    'editor-mode': () => { changePane('request'); chooseTab(state.bodyMode === 'JSON' ? 'Form' : 'JSON', { focus: true }); },
    'issue-next': () => issues.step(1),
    'issue-previous': () => issues.step(-1),
    'copy-url': () => click('[data-action="copy-url"]'),
    'add-header': () => header(addHeader),
    'add-row': target => {
      const list = target.closest('.list-input');
      if (list) list.querySelector('button.add:not(:disabled)')?.click();
      else if (target.closest('#header-list')) addHeader();
      else return false;
    },
    'remove-row': target => {
      const row = target.closest('[data-header-kind="custom"]');
      if (!row || [...row.querySelectorAll('input[data-header-field]')].some(input => input.value)) return false;
      row.querySelector('[data-action="remove-header"]')?.click();
    },
    'toggle-header': target => {
      const id = target.closest('[data-header-row]')?.dataset.headerId;
      if (!id) return false;
      toggleHeader(id);
    },
    'bulk-edit': () => header(bulkEdit),
    'header-presets': () => header(() => click('[data-header-command="presets"]')),
    'copy-curl': () => click('[data-action="copy-curl"]'),
    'copy-response': copyResponse,
    'find-response': () => {
      if (state.resultTab !== 'Response') chooseResult('Response');
      changePane('response');
      click('[data-action="find-response"]');
    },
    'follow-response': () => click('[data-follow-up], [data-location-open]'),
    'open-replacement': () => click('[data-replace-op]'),
    'fold-all': () => click('.response-viewer [data-fold-all]:not([hidden])'),
    'wrap-lines': () => click('.response-viewer [data-wrap]:not([hidden])'),
    'change-next': () => nextChange(1),
    'change-prev': () => nextChange(-1),
    preview,
    send,
  };
  for (const [id, definition] of Object.entries(SHORTCUTS)) {
    if (definition.mode) actions[id] = () => fill(definition.mode);
  }

  const canRun = {
    'editor-mode': () => !!$('[data-request-tab="Body"]') && state.view === 'try',
    docs: () => !!state.op && ['try', 'docs'].includes(state.view),
    'model-back': () => state.view === 'model' && !!backTarget(state.route),
    generate: () => state.view === 'try',
    'generate-menu': () => state.view === 'try',
    'traced-send': () => traceAvailable(),
    'reload-spec': () => canReload(),
    'autofill-reuse': () => state.history.some(entry => entry.op === state.op),
    'issue-next': () => issues.active,
    'issue-previous': () => issues.active,
    'autofill-undo': () => state.canUndoAutofill,
    'copy-url': () => !!state.op,
    'add-header': () => !!state.op,
    'bulk-edit': () => !!state.op,
    'header-presets': () => !!state.op,
    'copy-curl': () => !!$('[data-action="copy-curl"]'),
    'copy-response': () => !!state.result?.raw,
    'find-response': () => !!state.result?.raw,
    'follow-response': () => !!$('[data-follow-up], [data-location-open]'),
    'open-replacement': () => !!$('[data-replace-op]'),
    'fold-all': () => !!$('.response-viewer [data-fold-all]:not([hidden])'),
    'wrap-lines': () => !!$('.response-viewer [data-wrap]:not([hidden])'),
    'change-next': () => !!$('.response .table-change'),
    'change-prev': () => !!$('.response .table-change'),
    preview: () => !!$('.actionbar [data-action="preview"]:not(:disabled)'),
    send: () => !!$('.actionbar [data-action="send"]:not(:disabled), [data-action="confirm-send"]'),
  };
  function tabCommands() {
    return [...requestTab().map((button, index) => ({
      id: 'request-tab-' + index, label: t('palette.goToTab', { tab: button.querySelector('span')?.textContent.trim() }), icon: 'list',
      run: () => { changePane('request'); button.click(); },
    })), ...resultTab().flatMap((button, index) => [{
      id: 'result-tab-' + index, label: t('palette.showResult', { tab: button.dataset.resultTab === 'Headers' ? t('palette.responseHeaders') : resultTabLabel(button.dataset.resultTab) }),
      icon: 'eye', group: 'Result',
      run: () => { changePane('response'); chooseResult(button.dataset.resultTab, true); },
    }])];
  }

  function available() {
    return [...Object.entries(actions).flatMap(([id, action]) => {
      const definition = SHORTCUTS[id];
      if (!definition?.icon || id === 'palette' || (canRun[id] && !canRun[id]())) return [];
      return [{ id, label: shortcutLabel(id), icon: definition.icon, group: definition.group, run: () => action(document.activeElement) }];
    }), ...tabCommands()];
  }

  let sequenceAt = 0;
  function handle(event) {
    if (event.defaultPrevented || event.isComposing) return false;
    const target = event.target;
    const modal = target.closest?.('[aria-modal=true]');
    if (modal && !(modal.classList.contains('palette') && matchesShortcut('shortcuts', event))) return false;

    const isEditor = editing(target);
    const local = new Set(['add-row', 'remove-row', 'toggle-header']);
    for (const id of ['add-row', 'remove-row', 'toggle-header', ...Object.keys(actions).filter(id => !local.has(id))]) {
      const definition = SHORTCUTS[id];
      if (!definition?.chord || !matchesShortcut(id, event) || canRun[id] && !canRun[id]()) continue;
      const bareKey = !definition.chord.includes('+');
      if (isEditor && (bareKey || id === 'autofill-undo') && !local.has(id) && id !== 'shortcuts') continue;
      if (id === 'shortcuts' && isEditor && !modal) continue;
      if (actions[id](target) === false) continue;
      event.preventDefault();
      return true;
    }
    const tab = tabCommands().find(({ id }) => matchesShortcut(id, event));
    if (tab) {
      event.preventDefault();
      tab.run();
      return true;
    }
    // Two-key sequences such as G then O: the second key must follow within 900 ms.
    if (!isEditor && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const key = event.key.toUpperCase();
      const sequences = Object.entries(SHORTCUTS).filter(([, definition]) => definition.sequence);
      const pending = sequenceAt && performance.now() - sequenceAt.time < 900 ? sequenceAt.key : '';
      const match = pending && sequences.find(([, definition]) => definition.sequence[0] === pending && definition.sequence[1] === key);
      sequenceAt = sequences.some(([, definition]) => definition.sequence[0] === key) && !match ? { key, time: performance.now() } : 0;
      if (match && actions[match[0]]) {
        event.preventDefault();
        actions[match[0]](target);
        return true;
      }
    }
    return false;
  }
  return { available, handle, labels: tabCommands };
}
