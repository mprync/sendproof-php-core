// The one clipboard path. Success shows a check and a "Copied" bubble on the button for 1.5 s
// and announces it politely; nothing reflows. If the browser blocks the clipboard, an inline
// notice appears where the copy was, the text is selected so ⌘C works, and no pane is replaced.
import { icon, inlineNote } from './components.js';
import { t, th } from './i18n.js';
import { shortcutHint } from './shortcuts.js';

const FEEDBACK_MS = 1500;
const timers = new WeakMap();

async function write(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Embedded views and iframes can deny the async API; the legacy command may still work.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    Object.assign(area.style, { position: 'fixed', insetBlockStart: '-100vh', opacity: '0' });
    document.body.append(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    area.remove();
    return copied;
  }
}

function announce(text) {
  const region = document.querySelector('[data-request-announcement]');
  if (!region) return;
  region.textContent = '';
  requestAnimationFrame(() => { region.textContent = text; });
}

function showCopied(button) {
  if (!button) return;
  clearTimeout(timers.get(button));
  button.classList.add('is-copied');
  if (button.classList.contains('btn-icon') && !button.querySelector('.copied-bubble')) {
    button.insertAdjacentHTML('beforeend', `<span class="copied-bubble" aria-hidden="true">${icon('check', true)}${t('copy.copied')}</span>`);
  }
  timers.set(button, setTimeout(() => {
    button.classList.remove('is-copied');
    button.querySelector('.copied-bubble')?.remove();
  }, FEEDBACK_MS));
}

/** Selects the text of an element so the user can copy it with the keyboard. */
function selectContents(target) {
  if (!target) return;
  const selection = getSelection();
  const range = document.createRange();
  range.selectNodeContents(target);
  selection.removeAllRanges();
  selection.addRange(range);
  target.classList.add('is-selected');
  document.addEventListener('selectionchange', function clear() {
    if (!selection.containsNode(target, true)) {
      target.classList.remove('is-selected');
      document.removeEventListener('selectionchange', clear);
    }
  });
}

/**
 * Copies text and shows feedback.
 * - button: the copy button that gets the check and bubble.
 * - what: a short noun for announcements, such as "URL" ("URL copied").
 * - select: the element whose text is selected if the clipboard is blocked.
 * - notice: where the inline failure notice is inserted (before this element).
 */
export async function copyText(text, { button, what, select, notice } = {}) {
  const noticeHost = notice ?? select;
  noticeHost?.parentElement?.querySelector(':scope > [data-copy-failure]')?.remove();
  if (await write(String(text ?? ''))) {
    showCopied(button);
    announce(what ? t('copy.copiedWhat', { what }) : t('copy.copied'));
    return true;
  }
  const message = th('copy.failed', { what: what ? what.toLowerCase() : t('copy.text'), key: shortcutHint('copy') });
  if (noticeHost) {
    noticeHost.insertAdjacentHTML('beforebegin', inlineNote(message, { tone: 'danger', flush: !!noticeHost.closest('.viewer'), glyph: 'alert', role: 'alert', dismiss: true }));
    const note = noticeHost.previousElementSibling;
    note.dataset.copyFailure = '';
    note.querySelector('[data-dismiss-note]')?.addEventListener('click', () => note.remove());
  }
  selectContents(select);
  if (!noticeHost) announce(t('copy.failedShort'));
  return false;
}
