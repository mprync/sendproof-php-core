// The one shortcut registry. Keyboard handling, aria-keyshortcuts, keycaps on buttons, the
// command palette and the shortcut sheet all read these definitions, so they can't disagree.
//
// A chord is shown as one keycap: "⇧⌘↵" on a Mac, "Ctrl ⇧↵" elsewhere. Tooltips, menus and the
// sheet's note use the long form, such as "Ctrl+Shift+Enter".
import { current, t } from './i18n.js';

const keys = (...values) => values.join('+');

/** Shared shortcut definitions. `group` places an entry in the sheet and palette. */
export const SHORTCUTS = {
  palette: { group: 'General', chord: keys('Mod', 'K'), icon: 'search' },
  shortcuts: { group: 'General', chord: '?', icon: 'keyboard' },
  display: { group: 'General', chord: keys('Mod', ','), icon: 'sliders' },
  sidebar: { group: 'General', chord: keys('Mod', '\\'), icon: 'sidebar' },
  theme: { group: 'General', chord: keys('Mod', 'Shift', 'L'), icon: 'moon' },
  history: { group: 'General', chord: keys('Mod', 'Y'), icon: 'history' },
  signin: { group: 'General', chord: keys('Mod', 'Shift', 'U'), icon: 'user' },
  filter: { group: 'Navigate', chord: '/', icon: 'filter' },
  next: { group: 'Navigate', chord: 'J' },
  previous: { group: 'Navigate', chord: 'K' },
  'sidebar-operations': { group: 'Navigate', sequence: ['G', 'O'], icon: 'list' },
  'sidebar-models': { group: 'Navigate', sequence: ['G', 'M'], icon: 'box' },
  'goto-operation': { group: 'Navigate', icon: 'search' },
  // Journeys mode (v7): the mode switch, and moving between a run's steps.
  'mode-spec': { group: 'Navigate', sequence: ['G', 'S'], icon: 'braces', journeys: true },
  'mode-journeys': { group: 'Navigate', sequence: ['G', 'J'], icon: 'route', journeys: true },
  'step-previous': { group: 'Navigate', chord: '[', journeys: true },
  'step-next': { group: 'Navigate', chord: ']', journeys: true },
  'run-to-end': { group: 'Request', chord: keys('Mod', 'Alt', 'Enter'), icon: 'forward', journeys: true },
  docs: { group: 'Navigate', chord: 'D', icon: 'book' },
  'model-back': { group: 'Navigate', chord: keys('Alt', 'ArrowLeft'), icon: 'arrow-left' },
  'focus-pane': { group: 'Navigate', chord: keys('Mod', '[') },
  'editor-mode': { group: 'Request', chord: keys('Mod', 'E'), icon: 'code' },
  'issue-next': { group: 'Request', chord: keys('Alt', 'ArrowDown'), icon: 'alert' },
  'issue-previous': { group: 'Request', chord: keys('Alt', 'ArrowUp'), icon: 'alert' },
  'copy-url': { group: 'Request', chord: keys('Mod', 'Alt', 'U'), icon: 'copy' },
  'open-replacement': { group: 'Request', chord: keys('Alt', 'R'), icon: 'arrow-right' },
  'traced-send': { group: 'Request', icon: 'eye' },
  'add-header': { group: 'Headers & lists', chord: keys('Mod', 'Shift', 'H'), icon: 'plus' },
  'add-row': { group: 'Headers & lists', chord: keys('Mod', 'Enter') },
  'remove-row': { group: 'Headers & lists', chord: 'Backspace' },
  'toggle-header': { group: 'Headers & lists', chord: keys('Mod', '/') },
  'bulk-edit': { group: 'Headers & lists', chord: keys('Mod', 'Shift', 'B'), icon: 'edit' },
  'header-presets': { group: 'Headers & lists', icon: 'list' },
  generate: { group: 'Fields', chord: keys('Alt', 'G') },
  'generate-menu': { group: 'Fields', chord: keys('Alt', 'Shift', 'G') },
  'field-info': { group: 'Fields', chord: keys('Alt', 'I') },
  'lookup-open': { group: 'Fields', chord: keys('Alt', 'ArrowDown') },
  'lookup-preview': { group: 'Fields', chord: keys('Mod', 'Enter') },
  'lookup-paste': { group: 'Fields', chord: keys('Mod', 'V') },
  'autofill-undo': { group: 'Fields', chord: keys('Mod', 'Z'), mode: 'undo' },
  'date-today': { group: 'Fields', chord: 'T' },
  'date-tomorrow': { group: 'Fields', chord: 'Plus' },
  'date-yesterday': { group: 'Fields', chord: '-' },
  'copy-curl': { group: 'Result', chord: keys('Mod', 'Shift', 'C'), icon: 'copy' },
  'copy-response': { group: 'Result', chord: keys('Mod', 'Alt', 'C'), icon: 'copy' },
  'find-response': { group: 'Result', chord: keys('Mod', 'F'), icon: 'search' },
  'fold-all': { group: 'Result', chord: keys('Alt', 'Shift', 'ArrowUp'), icon: 'chevrons-ud' },
  'wrap-lines': { group: 'Result', chord: keys('Alt', 'Z'), icon: 'wrap' },
  'follow-response': { group: 'Result', chord: keys('Mod', 'G'), icon: 'link' },
  'change-next': { group: 'Result', chord: 'N' },
  'change-prev': { group: 'Result', chord: 'P' },
  escape: { group: 'Result', chord: 'Escape' },
  'autofill-required': { group: 'Request', chord: keys('Mod', 'Shift', 'F'), mode: 'required', icon: 'wand' },
  'autofill-all': { group: 'Request', chord: keys('Mod', 'Alt', 'Shift', 'F'), mode: 'all', icon: 'list' },
  'autofill-reuse': { group: 'Request', chord: keys('Mod', 'R'), mode: 'reuse' },
  'autofill-ids': { group: 'Fields', chord: keys('Mod', 'I'), mode: 'ids' },
  'autofill-clear': { group: 'Request', chord: keys('Mod', 'Shift', 'Backspace'), mode: 'clear' },
  preview: { group: 'Request', chord: keys('Mod', 'Enter'), icon: 'flask' },
  send: { group: 'Request', chord: keys('Mod', 'Shift', 'Enter'), icon: 'send' },
  'send-read-only': { chord: keys('Mod', 'Enter') },
  'reload-spec': { chord: keys('Mod', 'R') },
  enter: { chord: 'Enter' },
  tab: { chord: 'Tab' },
  up: { chord: 'ArrowUp' },
  down: { chord: 'ArrowDown' },
  updown: { chord: 'ArrowUp', display: '↑↓' },
  left: { chord: 'ArrowLeft' },
  right: { chord: 'ArrowRight' },
  home: { chord: 'Home' },
  end: { chord: 'End' },
  pageup: { chord: 'PageUp' },
  pagedown: { chord: 'PageDown' },
  copy: { chord: keys('Mod', 'C') },
  'zoom-in': { chord: keys('Mod', 'Plus') },
  'zoom-out': { chord: keys('Mod', '-') },
};
for (let index = 0; index < 5; index++) {
  SHORTCUTS['request-tab-' + index] = { chord: keys('Alt', index + 1) };
  SHORTCUTS['result-tab-' + index] = { chord: keys('Shift', 'Alt', index + 1) };
}
SHORTCUTS['request-tab-range'] = { range: ['request-tab-0', 'request-tab-4'] };
SHORTCUTS['result-tab-range'] = { range: ['result-tab-0', 'result-tab-4'] };

/** The label of a shortcut in the current language. */
export const shortcutLabel = id => t('shortcut.' + id);

const keyGlyphs = {
  Enter: '↵', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Backspace: '⌫', Plus: '+', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
};
const modifiers = ['Mod', 'Shift', 'Alt', 'Meta', 'Control'];
const platformStyle = () => current().platform === 'mac'
  ? { order: ['Alt', 'Shift', 'Mod'], compact: { Mod: '⌘', Shift: '⇧', Alt: '⌥' }, long: { Mod: '⌘', Shift: '⇧', Alt: '⌥', Enter: 'Return' }, joiner: '' }
  : { order: ['Mod', 'Shift', 'Alt'], compact: { Mod: 'Ctrl ', Shift: '⇧', Alt: 'Alt ' }, long: { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Enter: 'Enter' }, joiner: '+' };

function sortedParts(chord) {
  const parts = chord.split('+');
  const style = platformStyle();
  return [...style.order.filter(key => parts.includes(key)), ...parts.filter(key => !modifiers.includes(key))];
}

/** One keycap's text for a chord: "⇧⌘↵" on a Mac, "Ctrl ⇧↵" elsewhere. */
export function chordText(chord) {
  const style = platformStyle();
  return sortedParts(chord).map(key => style.compact[key] ?? keyGlyphs[key] ?? key).join('');
}

/** The long form for tooltips and menus: "⇧⌘Return" on a Mac, "Ctrl+Shift+Enter" elsewhere. */
export function chordLong(chord) {
  const style = platformStyle();
  return sortedParts(chord).map(key => style.long[key] ?? keyGlyphs[key] ?? key).join(style.joiner);
}

/** The keycaps shown for a shortcut, in order. A sequence such as G then O gives ['G', 'then', 'O']. */
export function shortcutParts(id) {
  const definition = SHORTCUTS[id];
  if (!definition) return [];
  if (definition.range) {
    const first = shortcutParts(definition.range[0])[0];
    const last = shortcutParts(definition.range[1])[0];
    return [first.slice(0, -1) + first.at(-1) + '–' + last.at(-1)];
  }
  if (definition.sequence) return definition.sequence.flatMap((key, index) => index ? ['then', key] : [key]);
  if (definition.display) return [definition.display];
  return definition.chord ? [chordText(definition.chord)] : [];
}

/** The long, readable form of a shortcut, for tooltips: "Ctrl+Shift+Enter". */
export function shortcutLong(id) {
  const definition = SHORTCUTS[id];
  if (definition?.sequence) return definition.sequence.join(' ' + t('kbd.then') + ' ');
  return definition?.chord ? chordLong(definition.chord) : '';
}

const partMarkup = key => key === 'then'
  ? `<span class="then">${t('kbd.then')}</span>`
  : `<kbd class="kbd">${key.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</kbd>`;

/** Keycaps for one or more shortcuts. Decorative: the control's aria-keyshortcuts announces them. */
export function shortcutHint(...ids) {
  return `<span class="keys" data-shortcut-hint="${ids.join(' ')}" aria-hidden="true">${ids.flatMap(shortcutParts).map(partMarkup).join('')}</span>`;
}

/** The same keycaps as a DOM node. */
export function shortcutHintNode(...ids) {
  const group = document.createElement('span');
  group.className = 'keys';
  group.dataset.shortcutHint = ids.join(' ');
  group.setAttribute('aria-hidden', 'true');
  for (const key of ids.flatMap(shortcutParts)) {
    const cap = document.createElement(key === 'then' ? 'span' : 'kbd');
    cap.className = key === 'then' ? 'then' : 'kbd';
    cap.textContent = key === 'then' ? t('kbd.then') : key;
    group.append(cap);
  }
  return group;
}

export function shortcutAria(...ids) {
  return ids.flatMap(id => {
    const chord = SHORTCUTS[id]?.chord;
    return !chord ? [] : chord.includes('Mod') ? [chord.replace('Mod', 'Meta'), chord.replace('Mod', 'Control')] : [chord];
  }).join(' ');
}

export function shortcutAttrs(...ids) {
  const aria = shortcutAria(...ids);
  return aria ? `aria-keyshortcuts="${aria}" data-shortcut="${ids.join(' ')}"` : '';
}

export function matchesShortcut(id, event) {
  const parts = SHORTCUTS[id]?.chord?.split('+');
  if (!parts || event.defaultPrevented || event.isComposing) return false;
  const key = parts.at(-1) === 'Plus' ? '+' : parts.at(-1);
  const symbol = key === '?' || key === '+' || key === ',';
  const keyMatches = event.key.toLowerCase() === key.toLowerCase() ||
    (parts.length > 1 && (/^[a-z]$/i.test(key) && event.code === 'Key' + key.toUpperCase() ||
      /^\d$/.test(key) && event.code === 'Digit' + key));
  return keyMatches &&
    (symbol || !!event.shiftKey === parts.includes('Shift')) &&
    !!event.altKey === parts.includes('Alt') &&
    (parts.includes('Mod') ? !!(event.metaKey || event.ctrlKey) :
      !!event.metaKey === parts.includes('Meta') && !!event.ctrlKey === parts.includes('Control'));
}
