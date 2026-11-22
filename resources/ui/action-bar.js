// The action bar under the request (mock: request.js "action bar"): a status line that wraps to
// two lines rather than truncating, then fixed-width Send and Preview buttons. Safe methods
// show one primary Send and say why there is no Preview instead of disabling it.
import { esc, icon } from './components.js';
import { t, th } from './i18n.js';
import { shortcutAttrs, shortcutHint, shortcutLong, shortcutLabel } from './shortcuts.js';
import { storeMark, storeNames } from './stores.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True for methods that can't change anything, so Preview has nothing to roll back. */
export const isReadOnly = op => SAFE.has(op?.method);

/**
 * The default status line for an operation. `unavailable` is its previewUnavailable entry (an API
 * author marked it preview: false); `blocked` is set when its last Preview was stopped by the
 * write guard, and names the store.
 */
export function idleStatus(op, previewAvailable, { unavailable, blocked } = {}) {
  if (blocked) return `<span class="status is-blocked">${icon('ban', true)}<span>${esc(t('bar.lastBlocked', { store: blocked }))}</span></span>`;
  if (unavailable) return `<span class="status">${icon('send', true)}<span>${esc(t('bar.sendOnly'))}</span></span>`;
  if (isReadOnly(op)) return `<span class="status">${icon('eye', true)}<span>${esc(t('bar.readOnly', { method: op.method }))}</span></span>`;
  if (!previewAvailable) return `<span class="status">${icon('info', true)}<span>${esc(t('bar.noPreview'))}</span></span>`;
  return `<span class="status">${icon('undo', true)}<span>${esc(t('bar.rule'))}</span></span>`;
}

/**
 * Send and Preview. Preview only exists when the operation can be previewed and isn't read-only.
 * An operation marked preview: false keeps a disabled Preview in its place (no layout shift
 * between operations), described by the reason docked above the bar; Send becomes primary.
 */
export function runButtons(op, previewAvailable, { unavailable } = {}) {
  const readOnly = isReadOnly(op);
  if (unavailable && !readOnly) {
    return `<button type="button" class="btn btn-run btn-send btn-primary" id="send-btn" data-action="send" ${shortcutAttrs('send')} title="${esc(t('bar.sendTip') + ' · ' + shortcutLong('send'))}">${icon('send', true)}<span>${esc(t('bar.send'))}</span>${shortcutHint('send')}</button>`
      + `<button type="button" class="btn btn-run btn-preview is-unavailable" data-action="preview" aria-disabled="true" aria-describedby="preview-dock-title" title="${esc(t('bar.previewOffTip'))}">${icon('flask-off', true)}<span>${esc(t('bar.preview'))}</span></button>`;
  }
  const sendShortcut = readOnly ? 'send-read-only' : 'send';
  const send = `<button type="button" class="btn btn-run btn-send${readOnly || !previewAvailable ? ' btn-primary' : ''}" id="send-btn" data-action="send" ${shortcutAttrs(sendShortcut)} title="${esc(t(readOnly ? 'bar.sendTipReadOnly' : 'bar.sendTip') + ' · ' + shortcutLong(sendShortcut))}">${icon('send', true)}<span>${esc(t('bar.send'))}</span>${shortcutHint(sendShortcut)}</button>`;
  const preview = readOnly || !previewAvailable ? ''
    : `<button type="button" class="btn btn-primary btn-run btn-preview" data-action="preview" ${shortcutAttrs('preview')} title="${esc(shortcutLabel('preview') + ' · ' + shortcutLong('preview'))}">${icon('flask', true)}<span>${esc(t('bar.preview'))}</span>${shortcutHint('preview')}</button>`;
  return send + preview;
}

/** The whole bar for an idle operation. `options` as for idleStatus. */
export const actionBar = (op, previewAvailable, options = {}) =>
  op ? idleStatus(op, previewAvailable, options) + runButtons(op, previewAvailable, options) : '';

/**
 * The reason a marked operation can't Preview, docked right above the action bar with a caret to
 * the disabled Preview button (mocks 122, 128, 130, m29): the store's mark, "Preview unavailable",
 * the author's reason (their words, in English, so lang="en"), why, and who marked it. It takes
 * layout space, so it never covers the form. On a phone "Why?" opens the explanation.
 */
export function previewDock(entry) {
  if (!entry) return '';
  const store = entry.stores[0];
  const why = entry.stores.length ? t('dock.why', { stores: storeNames(entry.stores) }) : t('dock.whyNoStore');
  return `<span class="pv-tile">${store ? storeMark(store, 20) : icon('flask-off')}</span>
    <div class="pv-text">
      <p class="pv-title"><strong id="preview-dock-title">${esc(t('dock.title'))}</strong>${entry.reason ? `<span class="pv-reason" lang="en">${esc(entry.reason)}</span>` : ''}</p>
      <p class="pv-sub"><span class="pv-why" id="preview-dock-why">${esc(why)} </span><span class="pv-by">${th('dock.by', { mark: '<code class="ltr">preview: false</code>' })}</span>
        <button type="button" class="pv-more" data-action="dock-why" aria-expanded="false" aria-controls="preview-dock-why">${esc(t('dock.more'))}</button></p>
    </div>
    <span class="pv-caret" aria-hidden="true"></span>`;
}

/** The status while a request runs: who it runs as, and that editing stays possible. */
export function runningStatus(preview, identity) {
  const key = preview ? (identity ? 'bar.previewingAs' : 'bar.previewing') : (identity ? 'bar.sendingAs' : 'bar.sending');
  return `<span class="spinner" aria-hidden="true"></span><span>${esc(t(key, { name: identity }))}</span>`;
}

/** The status after generated values were filled in, with Undo. */
export function generatedStatus(count) {
  return `<span class="status is-ok" role="status">${icon('wand', true)}<span>${esc(t('bar.filled', { n: count }))}</span><button type="button" class="btn btn-ghost btn-xs" data-action="undo-fill" ${shortcutAttrs('autofill-undo')}>${esc(t('bar.undo'))} ${shortcutHint('autofill-undo')}</button></span>`;
}

/**
 * The confirmation that replaces the buttons before a committing Send. Cancel and Confirm send sit
 * in one pair that is at least as wide as Send + Preview, so the status keeps its room, and that
 * grows to fit a long translation instead of clipping it (see .run-pair in app.css).
 */
export function confirmation(method, path, stores = []) {
  const text = stores.length ? t('bar.confirmStores', { stores: storeNames(stores) }) : t('bar.confirm', { method, path });
  return `<span class="status${stores.length ? ' is-confirm-store' : ''}" role="status">${stores.length ? icon('warn', true) : ''}<span>${esc(text)}</span></span>
    <span class="run-pair">
      <button type="button" class="btn btn-run btn-ghost" data-action="cancel-confirm" ${shortcutAttrs('escape')}>${esc(t('bar.cancel'))} ${shortcutHint('escape')}</button>
      <button type="button" class="btn btn-run btn-primary" data-action="confirm-send" ${shortcutAttrs('send')}>${icon('send', true)}<span>${esc(t('bar.confirmSend'))}</span>${shortcutHint('send')}</button>
    </span>`;
}
