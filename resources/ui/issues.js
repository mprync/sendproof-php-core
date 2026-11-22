import { esc, icon } from './components.js';
import { t, th } from './i18n.js';
import { setFieldIssue } from './schema.js';
import { title } from './fields/dom.js';
import { shortcutAttrs, shortcutHint } from './shortcuts.js';

/** What an issue points at in a field: its select, lookup, radio group or input (never Clear or Remove). */
const CONTROLS = '[role="combobox"], [role="radiogroup"], input, textarea, button:not(.info-btn):not(.wand):not(.field-clear):not(.field-remove)';

const normalization = value => value.replace(/\[(\d+)\]/g, '.$1').replace(/^\$\.?/, '');
const fieldKey = issue => JSON.stringify([issue.tab || 'Body', normalization(issue.path || ''), issue.inputId || '']);

function fieldPath(field) {
  const parameter = field.closest('[data-parameter-name]')?.dataset.parameterName;
  const parts = JSON.parse(field.dataset.schemaPath);
  return normalization((parameter ? [parameter, ...parts] : parts).join('.'));
}

/**
 * Show request validation without growing or scrolling the form: an action-bar button with the
 * count, a popover listing each field, a flag on each tab that has issues, and a polite
 * announcement. Messages arrive already worded by the validators.
 */
export function createIssues({ $, selectTab }) {
  let issues = [];
  let server = false;
  let current = -1;

  function target(issue) {
    if (issue.inputId) {
      const input = document.getElementById(issue.inputId);
      if (input) return { input, field: input.closest('.field') };
    }
    if (issue.tab === 'Headers') {
      const row = [...document.querySelectorAll('[data-header-row]')]
        .find(node => (node.querySelector('[data-header-field="name"]')?.value || '').toLowerCase() === issue.path.toLowerCase());
      return { input: row?.querySelector('[data-header-field="value"]') };
    }
    if (issue.path === '$' && $('#json')) return { input: $('#json'), field: $('#json').closest('.field') };
    const candidates = [...document.querySelectorAll('#editor [data-schema-path]')];
    const path = normalization(issue.path || '');
    const field = candidates.find(node => fieldPath(node) === path) ??
      candidates.find(node => fieldPath(node).toLowerCase() === path.toLowerCase());
    // The currency segment of an amount is its own field and its own control.
    const input = field?.matches?.(CONTROLS) ? field : [...(field?.querySelectorAll(CONTROLS) || [])]
      .find(node => node.closest('[data-schema-path]') === field);
    return { field, input };
  }

  function close(restore = false) {
    $('#issues')?.remove();
    const trigger = $('.issues-btn');
    trigger?.setAttribute('aria-expanded', 'false');
    if (restore) trigger?.focus();
  }

  function focusIssue(index) {
    if (!issues.length) return;
    current = (index + issues.length) % issues.length;
    const issue = issues[current];
    close();
    let { input, field } = target(issue);
    if (!input) {
      selectTab(issue.tab || 'Form', { report: false });
      ({ input, field } = target(issue));
    }
    if (field) setFieldIssue(field, input, issue.message);
    // A radio group focuses its checked option; every other control focuses itself.
    const focusable = input || $('#editor').querySelector('textarea, input, [tabindex="0"]') || $('#editor');
    if (focusable.focusControl) focusable.focusControl(); else focusable.focus();
  }

  function open() {
    close();
    const trigger = $('.issues-btn');
    if (!trigger || !issues.length) return;
    const count = countFields();
    trigger.setAttribute('aria-expanded', 'true');
    $('.actionbar').insertAdjacentHTML('beforeend', `<section class="pop issues-pop" id="issues" role="dialog" aria-labelledby="issues-title">
      <div class="pop-head"><span id="issues-title">${esc(t('issues.fieldsNeed', { n: count }))}</span><span class="spacer"></span><span class="faint">${esc(t(server ? 'issues.rejected' : 'issues.notSent'))}</span></div>
      <div class="pop-group">${issues.map((issue, index) => {
        const { field, input } = target(issue);
        const name = field?.querySelector(':scope > .label')?.firstChild?.textContent ||
          (issue.path === '$' ? t('issues.body') : title((issue.path || t('issues.request')).split('.').at(-1)));
        return `<button class="issue-link${index === Math.max(0, current) ? ' is-active' : ''}" data-issue-index="${index}" ${input?.id ? `data-issue-target="${esc(input.id)}"` : ''} type="button">
          <span class="ico">${icon('alert', true)}</span><span class="name">${esc(name)}</span><span class="why">${esc(issue.message)}</span>
        </button>`;
      }).join('')}</div>
      <div class="pop-foot"><span>${th('issues.next', { key: shortcutHint('issue-next') })}</span><span>${th('issues.previous', { key: shortcutHint('issue-previous') })}</span><span class="spacer"></span><span>${th('issues.close', { key: shortcutHint('escape') })}</span></div>
    </section>`);
    const pop = $('#issues');
    pop.addEventListener('click', event => {
      const button = event.target.closest('[data-issue-index]');
      if (button) focusIssue(Number(button.dataset.issueIndex));
    });
    pop.addEventListener('keydown', event => {
      if (event.altKey || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const buttons = [...pop.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
      event.preventDefault();
    });
    pop.querySelector('.is-active')?.focus();
  }

  const countFields = () => issues.length;
  let initialStatus;
  function render() {
    const status = $('.actionbar .status');
    if (!status) return;
    initialStatus ||= status.innerHTML;
    const count = countFields();
    const text = count ? t('issues.fieldsNeed', { n: count }) : '';
    status.classList.toggle('is-error', !!count);
    status.innerHTML = count ? `<button class="issues-btn" data-action="issues" type="button" aria-haspopup="dialog"
      aria-expanded="false" aria-controls="issues" ${shortcutAttrs('issue-next')}>${icon('alert', true)}<span class="issues-label">${esc(text)}</span>
      ${shortcutHint('issue-next')}</button>` : initialStatus;
    const announcement = $('[data-request-announcement]');
    if (announcement) announcement.textContent = text;
    // A tab with issues shows its flag dot. The flag and its screen-reader text are always in
    // the tab, so toggling them never changes its width; the count lives in the action bar.
    for (const tab of document.querySelectorAll('[data-request-tab]')) {
      const flag = tab.querySelector('[data-tab-flag]');
      if (!flag) continue;
      const tabName = tab.dataset.requestTab;
      const errors = new Set(issues.filter(issue => (issue.tab || 'Body') === tabName).map(issue => issue.path)).size;
      flag.hidden = !errors;
      const flagText = tab.querySelector('[data-tab-flag-text]');
      if (flagText) flagText.textContent = errors ? ', ' + t('issues.tabFlag', { n: errors }) : '';
    }
  }

  function annotate() {
    for (const issue of issues) {
      const { field, input } = target(issue);
      if (field) setFieldIssue(field, input, issue.message);
    }
  }

  return {
    get active() { return issues.length > 0; },
    get server() { return server; },
    annotate,
    edit(input) {
      if (!server) return;
      const field = input.closest('[data-schema-path]');
      const path = field ? fieldPath(field) : undefined;
      issues = issues.filter(issue => !(
        issue.inputId && input.id === issue.inputId ||
        path !== undefined && normalization(issue.path || '').toLowerCase() === path.toLowerCase()
      ));
      close();
      annotate();
      render();
    },
    show(next, { fromServer = false, expand = false } = {}) {
      close();
      // Parser diagnostics are ordered first, before general schema errors.
      const unique = new Map();
      for (const issue of next) {
        const key = fieldKey(issue);
        if (!unique.has(key)) unique.set(key, issue);
      }
      const controls = [...document.querySelectorAll('#editor :is(input, textarea, [role="combobox"], [role="radiogroup"])')];
      issues = [...unique.values()].map(issue => {
        const { input } = target(issue);
        const fieldOrder = controls.indexOf(input);
        return { ...issue, fieldOrder: fieldOrder < 0 ? Infinity : fieldOrder };
      }).sort((first, second) => first.fieldOrder - second.fieldOrder);
      server = fromServer;
      current = -1;
      annotate();
      render();
      if (expand && !matchMedia('(max-width: 56rem)').matches) open();
    },
    clear() {
      close();
      issues = [];
      server = false;
      current = -1;
      render();
    },
    close,
    step(direction) { focusIssue(current < 0 && direction < 0 ? issues.length - 1 : current + direction); },
    toggle() { if ($('#issues')) close(true); else open(); },
  };
}
