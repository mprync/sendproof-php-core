// A quiet note that says what the workbench just did on the person's behalf (for example, signing
// them in as the persona a journey runs as). It never asks for anything: it fades after a few
// seconds, has a close button, and is announced politely to screen readers. One at a time.
import { esc, icon } from './components.js';
import { t } from './i18n.js';

const SHOWN_MS = 7000;
let current = null;

/** Shows `text` as a note at the bottom of the window. `glyph` is an icon name. Returns a function that closes it. */
export function showToast(text, { glyph = 'info', duration = SHOWN_MS } = {}) {
  const doc = globalThis.document;
  current?.close();
  const host = doc.createElement('div');
  host.className = 'toast';
  host.setAttribute('role', 'status');
  host.innerHTML = `${icon(glyph, true)}<span class="toast-text">${esc(text)}</span><button class="btn btn-ghost btn-icon btn-xs toast-close" type="button" aria-label="${esc(t('dialog.close'))}">${icon('x', true)}</button>`;
  doc.body.append(host);
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    host.remove();
    if (current?.host === host) current = null;
  };
  host.querySelector('.toast-close').addEventListener('click', close);
  if (duration > 0) timer = setTimeout(close, duration);
  current = { host, close };
  return close;
}
