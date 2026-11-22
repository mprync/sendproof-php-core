// History (mock 35): every Preview and Send of this session with its inputs, kept in this
// browser only. A row replays the request into its operation without running it.
import { esc, icon, method, stateBlock } from './components.js';
import { formatTime, t } from './i18n.js';
import { shortcutHint } from './shortcuts.js';
import { closePopover, openPopoverAt } from './popover.js';

export function openHistory(anchor, { state, replay }) {
  const rows = state.history;
  const list = rows.length ? `<div class="pop-group" role="list">${rows.map((entry, index) => `
    <button type="button" class="opt-row" role="listitem" data-history="${index}" style="inline-size:100%;border:0;background:none;text-align:start;font:inherit">
      ${method(entry.op.method)}<span class="stack"><span class="main" lang="en">${esc(entry.op.title)}</span><span class="sub">${esc(t(entry.preview ? 'res.preview' : 'res.sent'))} · <bdi class="ltr">${esc(entry.status ?? '')}</bdi> · ${esc(formatTime(entry.when))}</span></span>
      <span class="end">${icon('history', true)}${esc(t('history.replay'))}</span>
    </button>`).join('')}</div>`
    : stateBlock({ glyph: 'history', compact: true, title: esc(t('history.emptyTitle')), body: esc(t('history.emptyBody')), why: esc(t('history.local')) });
  const pop = openPopoverAt(anchor, `<div class="pop hist-pop" role="dialog" aria-labelledby="history-title">
    <div class="pop-head"><span id="history-title">${esc(t('shell.history'))}</span><span class="spacer"></span>${shortcutHint('history')}</div>${list}</div>`, { align: 'end', kind: 'history' });
  pop.addEventListener('click', event => {
    const row = event.target.closest('[data-history]');
    if (!row) return;
    closePopover();
    replay(rows[Number(row.dataset.history)]);
  });
}
