// Small HTML builders shared by every view, matching the approved mock builders
// (mocks: shell.js `tab`, `kbd`, `copyBtn`, `copyTextBtn`, `state`). Every builder returns markup;
// callers escape data with esc() before passing it in.
import { formatNumber, t } from './i18n.js';
import { shortcutAttrs, shortcutHint } from './shortcuts.js';

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapes text for HTML content and attribute values. */
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);

// Icons whose meaning has a direction mirror in right-to-left layouts.
const directional = new Set(['chevron-right', 'chevron-left', 'arrow-left', 'arrow-right', 'send', 'log-in', 'undo']);

/** A decorative icon from the sprite in icons.js. */
export const icon = (name, small = false, extra = '') =>
  `<svg class="i${small ? ' i-sm' : ''}${directional.has(name) ? ' i-dir' : ''}${extra ? ' ' + extra : ''}" aria-hidden="true"><use href="#i-${esc(name)}"/></svg>`;

/** A status code's hue by class: 2xx success, 3xx info, 4xx warning, 5xx danger. */
export const statusTone = code => /^2/.test(String(code)) ? 'ok' : /^3/.test(String(code)) ? 'info' : /^4/.test(String(code)) ? 'warn' : /^5/.test(String(code)) ? 'danger' : 'muted';

/** An HTTP method badge. Always left to right. */
export const method = name => `<span class="method m-${esc(name.toLowerCase())}">${esc(name.toUpperCase())}</span>`;

/**
 * The one tab component. `count` is a number, '–' (not known yet) or undefined (no badge).
 * `flag` adds the issue dot and its accessible description; it never changes the tab's width.
 */
export function tab(label, { selected = false, count, flag, flagSlot = false, id, controls, shortcut, data = '', icon: glyph, lang, labelClass } = {}) {
  const badge = count === undefined ? ''
    : count === '–' ? '<span class="n unknown" aria-hidden="true">–</span>'
    : `<span class="n">${typeof count === 'number' ? formatNumber(count) : esc(count)}</span>`;
  const description = flag ? `<span class="sr-only">, ${esc(flag)}</span>`
    : count === '–' ? `<span class="sr-only">, ${esc(t('tab.notRun'))}</span>` : '';
  return `<button type="button" class="tab" role="tab" aria-selected="${selected}" tabindex="${selected ? 0 : -1}"${id ? ` id="${esc(id)}"` : ''}${controls ? ` aria-controls="${esc(controls)}"` : ''} ${shortcut ? shortcutAttrs(shortcut) : ''} ${data}>${glyph ? icon(glyph, true) : ''}<span${lang ? ` lang="${lang}"` : ''}${labelClass ? ` class="${esc(labelClass)}"` : ''}>${esc(label)}</span>${badge}${flag || flagSlot ? `<span class="flag" aria-hidden="true"${flag ? '' : ' hidden'} data-tab-flag></span>` : ''}${flagSlot ? `<span class="sr-only" data-tab-flag-text>${flag ? `, ${esc(flag)}` : ''}</span>` : description}</button>`;
}

/**
 * An icon copy button. The icon swaps to a check and a "Copied" bubble overlays it, so nothing
 * moves. `action` is the data-action handled by the view; ui/copy.js gives the feedback.
 */
export function copyButton(label, { action, size = 'btn-sm', shortcut, data = '' } = {}) {
  return `<button type="button" class="btn btn-ghost btn-icon ${size} copy" aria-label="${esc(label)}" title="${esc(label)}"${action ? ` data-action="${esc(action)}"` : ''} ${shortcut ? shortcutAttrs(shortcut) : ''} ${data}>${icon('copy', true, 'i-idle')}${icon('check', true, 'i-done')}</button>`;
}

/** A text copy button: "Copy" and "Copied" share one grid cell, so its width never changes. */
export function copyTextButton(label, { action, cls = 'btn-sm', data = '' } = {}) {
  return `<button type="button" class="btn ${cls} copy"${action ? ` data-action="${esc(action)}"` : ''} ${data}>${icon('copy', true, 'i-idle')}${icon('check', true, 'i-done')}<span class="copy-label"><span>${esc(label)}</span><span aria-hidden="true">${esc(t('copy.copied'))}</span></span></button>`;
}

/** A button with an optional icon and keycaps. `label` is escaped. */
export function button(label, { cls = 'btn-sm', glyph, shortcut, action, data = '', hint = true } = {}) {
  return `<button type="button" class="btn ${cls}"${action ? ` data-action="${esc(action)}"` : ''} ${shortcut ? shortcutAttrs(shortcut) : ''} ${data}>${glyph ? icon(glyph, true) : ''}${esc(label)}${shortcut && hint ? ' ' + shortcutHint(shortcut) : ''}</button>`;
}

/**
 * Empty, error and explanation states share one anatomy: icon tile, title, one or two sentences,
 * an optional "why" note, actions and extra content such as steps or ghost rows.
 * `title`, `body` and `why` are HTML (escape data first).
 */
export function stateBlock({ glyph = 'info', tone = '', title, body = '', why = '', actions = [], extra = '', center = false, compact = false, heading = 'h3', role = '' }) {
  return `<div class="state${center ? ' center' : ''}${compact ? ' compact' : ''}"${role ? ` role="${role}"` : ''}>
    ${glyph ? `<span class="state-ico${tone ? ' ' + tone : ''}" aria-hidden="true">${icon(glyph)}</span>` : ''}
    <${heading}>${title}</${heading}>
    ${body ? `<p>${body}</p>` : ''}
    ${why ? `<div class="why">${icon('info', true)}<span>${why}</span></div>` : ''}
    ${actions.length ? `<div class="actions">${actions.join('')}</div>` : ''}
    ${extra}
  </div>`;
}

/** Faint placeholder rows that preview what a tab will show (not a skeleton: nothing loads). */
export const ghostRows = rows => `<div class="ghost" aria-hidden="true">${rows.map(([glyph, first, second]) =>
  `<div class="ghost-row">${icon(glyph, true)}<span class="bar" style="inline-size:${first}"></span><span class="spacer"></span><span class="bar" style="inline-size:${second}"></span></div>`).join('')}</div>`;

/** An inline notice where a problem happened. It never replaces a pane. `html` is trusted. */
export const inlineNote = (html, { tone = '', flush = false, glyph = 'info', role = '', dismiss = false, extra = '' } = {}) =>
  `<div class="inline-note${tone ? ' ' + tone : ''}${flush ? ' flush' : ''}"${role ? ` role="${role}"` : ''}>${icon(glyph, true)}<span>${html}</span>${extra}${dismiss ? `<button type="button" class="btn btn-ghost btn-icon btn-xs" data-dismiss-note aria-label="${esc(t('copy.dismiss'))}">${icon('x', true)}</button>` : ''}</div>`;
