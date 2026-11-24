// The workbench's own dialog (mocks v8, screens 160–167, m43–m45). The workbench never opens a
// native browser dialog (confirm, alert, prompt): every question or notice is this one component,
// so it can list what will happen instead of one line of text.
//
// One shape: a tinted icon tile with the title and one sentence beside it, an optional list of
// consequences (rows of a name with a subtitle under it), the meta on the left of the footer and
// the actions on the right. On a phone it is a bottom sheet with the main action first.
//
// It is a native <dialog> opened with showModal(), so the page behind it is inert and focus stays
// inside. Focus starts on the safe action (Cancel, Keep running, Stay as…); Esc, the close button
// and a swipe down on a phone resolve null; the committing action needs the chord it shows (never
// plain Enter, which acts on whatever has focus); focus returns to the opener.
import { esc, icon, method } from './components.js';
import { t } from './i18n.js';
import { matchesShortcut, shortcutAttrs, shortcutHint } from './shortcuts.js';

const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
/** The plain text of a trusted HTML snippet, for a row's tooltip. */
export const plainText = html => String(html ?? '').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, entity => entities[entity]);

/** Text that stays left to right inside a right-to-left dialog: an address, a file name, a status code. */
export const ltr = text => `<bdi dir="ltr">${esc(text)}</bdi>`;

/** A round mark for a row: an icon, tinted for ok (a step that ran) or warn. */
export const dialogMark = (glyph, tone = '') => `<span class="dl-mark${tone ? ` is-${tone}` : ''}" aria-hidden="true">${icon(glyph, true)}</span>`;

/**
 * One row of a dialog's list: a mark, a name with a subtitle under it and an optional end. `name`
 * is plain text, `code` (optional) a file or database name set beside it, `sub` trusted HTML. The
 * full text is the row's tooltip, because on a desktop the line is clipped with an ellipsis.
 */
export function dialogRow({ mark, name, code = '', sub = '', end = '' }) {
  const title = [code ? `${name} ${code}` : name, plainText(sub)].filter(Boolean).join('\n');
  const codeHtml = code ? ` <bdi dir="ltr"><code>${esc(code)}</code></bdi>` : '';
  return `<li class="dl-row">${mark}<span class="dl-text" title="${esc(title)}"><span class="dl-name">${esc(name)}${codeHtml}</span>${sub ? `<span class="dl-sub">${sub}</span>` : ''}</span>${end}</li>`;
}

/** The list that holds rows. */
export const dialogList = rows => `<ul class="dl-list">${rows.join('')}</ul>`;

/** A label above a list, with an optional chip on its end (the environment). */
export const dialogLabel = (text, end = '') => `<p class="dl-label"><span>${esc(text)}</span>${end}</p>`;

/** A one-line reminder under a list. */
export const dialogHint = (glyph, text) => `<p class="dl-hint">${icon(glyph, true)}<span>${esc(text)}</span></p>`;

/** The environment chip: a dot, the environment's name and its database. */
export const dialogEnv = (environment, database) => !environment && !database ? '' :
  `<span class="dl-env"><span class="dot" aria-hidden="true"></span>${esc(environment ?? '')}${database ? `<span class="dl-env-db">${ltr(database)}</span>` : ''}</span>`;

/** A footer note: an icon and a few words. */
export const dialogNote = (glyph, text) => `<span class="dl-foot-note">${icon(glyph, true)}${esc(text)}</span>`;

/** A row that offers an operation: its method, name and a line about it. Clicking it resolves `value`. */
export const dialogOffer = ({ value, httpMethod, name, sub }) =>
  `<button class="dl-undo" type="button" data-dialog-value="${esc(value)}">${method(httpMethod)}<span class="dl-text" title="${esc([name, sub].filter(Boolean).join('\n'))}"><span class="dl-name" dir="auto">${esc(name)}</span>${sub ? `<span class="dl-sub" dir="auto">${esc(sub)}</span>` : ''}</span>${icon('arrow-right', true)}</button>`;

/**
 * The action that has focus when the dialog opens: the one marked `focus`, else the first plain
 * action (Cancel, Keep running), else the first. Committing actions never take it.
 */
export function initialAction(actions) {
  const marked = actions.findIndex(action => action.focus);
  if (marked >= 0) return marked;
  const safe = actions.findIndex(action => !action.kind || action.kind === 'default');
  return safe >= 0 ? safe : 0;
}

const kindClass = { primary: 'btn btn-primary btn-sm', danger: 'btn btn-sm dl-danger' };

/** The dialog's markup. `title`, `body`, `content` and `foot` are trusted HTML: callers escape data. */
export function dialogMarkup({ tone = 'neutral', glyph, head, title, body = '', content = '', foot = '', actions = [] }, id = 'dl') {
  const first = initialAction(actions);
  const buttons = actions.map((action, index) => `<button class="${kindClass[action.kind] ?? 'btn btn-sm'}" type="button" data-dialog-action="${index}"${index === first ? ' data-dialog-initial autofocus' : ''}${action.shortcut ? ` ${shortcutAttrs(action.shortcut)}` : ''}>${action.icon ? icon(action.icon, true) : ''}${esc(action.label)}${action.shortcut ? shortcutHint(action.shortcut) : ''}</button>`).join('');
  return `<div class="dl dl-${tone}">
    <span class="dl-grab" aria-hidden="true"></span>
    <header class="dl-head">
      ${head || `<span class="dl-tile is-${tone}" aria-hidden="true">${icon(glyph, false)}</span>`}
      <div class="dl-titles"><h2 id="${id}-t">${title}</h2>${body ? `<p id="${id}-d">${body}</p>` : ''}</div>
      <button class="btn btn-ghost btn-icon btn-sm dl-close" type="button" data-dialog-close aria-label="${esc(t('dialog.close'))}" title="${esc(t('dialog.closeTip'))}">${icon('x', true)}</button>
    </header>
    ${content ? `<div class="dl-body">${content}</div>` : ''}
    <footer class="dl-foot"><span class="dl-meta">${foot}</span><span class="dl-actions">${buttons}</span></footer>
  </div>`;
}

/** The value of the action whose chord `event` is, if any. Only a shown chord commits; plain Enter never does. */
export function actionForKey(actions, event) {
  const hit = actions.find(action => action.shortcut && matchesShortcut(action.shortcut, event));
  return hit ? { value: hit.value ?? null } : null;
}

/** The index Tab or Shift+Tab moves to among `count` focusable controls, wrapping at both ends. */
export function nextFocus(count, current, backwards) {
  if (!count) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? -1 : 1) + count) % count;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let counter = 0;

/**
 * Opens a dialog and resolves to the chosen action's `value`, or null when it was dismissed (Esc,
 * the close button, a swipe down on a phone). `actions` is `[{ label, kind: 'primary' | 'danger' |
 * 'default', value, icon, shortcut (a shortcuts.js id), focus }]`. `role` is alertdialog for a
 * warning or something that can't be undone.
 */
export function openDialog(spec) {
  const doc = globalThis.document;
  const opener = doc.activeElement;
  const id = `dl-${++counter}`;
  const tone = spec.tone ?? 'neutral';
  const host = doc.createElement('dialog');
  host.className = 'dl-host';
  host.setAttribute('role', tone === 'danger' || tone === 'warn' ? 'alertdialog' : 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-labelledby', `${id}-t`);
  if (spec.body) host.setAttribute('aria-describedby', `${id}-d`);
  host.innerHTML = dialogMarkup({ ...spec, tone }, id);
  doc.body.append(host);
  const actions = spec.actions ?? [];

  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      host.close?.();
      host.remove();
      if (opener?.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
      resolve(value);
    };
    host.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    host.addEventListener('close', () => finish(null));
    host.addEventListener('click', event => {
      const target = event.target;
      if (target.closest?.('[data-dialog-close]')) return finish(null);
      const offer = target.closest?.('[data-dialog-value]');
      if (offer) return finish(offer.dataset.dialogValue);
      const button = target.closest?.('[data-dialog-action]');
      if (button) finish(actions[Number(button.dataset.dialogAction)]?.value ?? null);
    });
    host.addEventListener('keydown', event => {
      // The workbench's own shortcuts (Send, search, J and K…) stay quiet while a question is open.
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); finish(null); return; }
      const chord = actionForKey(actions, event);
      if (chord) { event.preventDefault(); finish(chord.value); return; }
      if (event.key === 'Tab') {
        const controls = [...host.querySelectorAll(FOCUSABLE)];
        const to = nextFocus(controls.length, controls.indexOf(doc.activeElement), event.shiftKey);
        if (to >= 0) { event.preventDefault(); controls[to].focus(); }
      }
    });
    swipeToClose(host, () => finish(null));
    host.showModal();
    host.querySelector('[data-dialog-initial]')?.focus();
  });
}

/** On a phone, dragging the sheet down from its handle or heading dismisses it, like the Cancel it shows. */
function swipeToClose(host, dismiss) {
  let start = null;
  const card = () => host.querySelector('.dl');
  host.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || !event.target.closest?.('.dl-grab, .dl-head')) return;
    start = { y: event.clientY, time: event.timeStamp };
  });
  host.addEventListener('pointermove', event => {
    if (!start) return;
    const delta = Math.max(0, event.clientY - start.y);
    const sheet = card();
    if (sheet) { sheet.style.transition = 'none'; sheet.style.transform = `translateY(${delta}px)`; }
  });
  const release = event => {
    if (!start) return;
    const delta = event.clientY - start.y;
    const fast = delta / Math.max(1, event.timeStamp - start.time) > 0.6;
    start = null;
    const sheet = card();
    if (sheet) { sheet.style.transition = ''; sheet.style.transform = ''; }
    if (delta > 96 || (fast && delta > 32)) dismiss();
  };
  host.addEventListener('pointerup', release);
  host.addEventListener('pointercancel', () => {
    start = null;
    const sheet = card();
    if (sheet) { sheet.style.transition = ''; sheet.style.transform = ''; }
  });
}
