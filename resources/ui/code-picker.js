// The language picker shared by the Docs "Request sample" card and the Try it Code panel.
//
// A fixed-width trigger button shows `[mark] Language` with the client library in muted text and a
// chevron; it opens a listbox with one row per language (mark, name, library right-aligned in
// muted mono, and a check on the selected row). The trigger never changes size with the choice, so
// nothing beside it shifts. The choice is remembered in localStorage and shared by both screens.
//
// The row's cells follow the page direction (so the auto margin that pushes the library to the far
// edge mirrors in RTL); the Latin names inside them stay left to right.
//
// Keyboard (WAI-ARIA menu button + listbox):
//   trigger   ↓ ↑ Enter Space open the list on the selected language
//   list      ↓ ↑ move, Home / End jump, a letter jumps to the next language starting with it
//             (typing more letters narrows), Enter / Space choose, Esc closes and returns focus
//             to the trigger, Tab closes too. The chosen row carries aria-selected="true".
import { esc, icon } from './components.js';
import { t } from './i18n.js';
import { langIcon } from './lang-icons.js';
import { closePopover, openPopoverAt, place } from './popover.js';
import { pickerFormats } from './snippets.js';

const STORAGE_KEY = 'sendproof-code-language';
const DEFAULT_FORMAT = 'curl';
/** How long typed letters count as one search string. */
const TYPE_AHEAD_MS = 700;

/** The remembered language id (a picker format), or cURL when nothing valid is stored. */
export function getCodeFormat() {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return pickerFormats.some(format => format.id === stored) ? stored : DEFAULT_FORMAT;
  } catch {
    return DEFAULT_FORMAT; // Storage can be blocked; the choice then lasts only for this page.
  }
}

/** Remembers the language for the next render, on Docs and Try it alike. */
export function setCodeFormat(id) {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, id); } catch { /* Blocked storage: keep going. */ }
}

const formatOf = id => pickerFormats.find(format => format.id === id) ?? pickerFormats[0];

/** The inside of the trigger: mark, language, library, chevron. Names stay left to right in RTL. */
function triggerContent(format) {
  return `${langIcon(format.icon)}<span class="lang-name ltr">${esc(format.label)}</span> <span class="lang-lib ltr" title="${esc(format.library)}">${esc(format.library)}</span>${icon('chevron-down', true, 'lang-chev')}`;
}

const triggerLabel = format => t('code.languageValue', { name: format.label, library: format.library });

/**
 * The trigger button. `id` must be unique on the page (it is how focus finds the trigger again
 * after a re-render).
 */
export function codePicker({ id, value = getCodeFormat() }) {
  const format = formatOf(value);
  return `<div class="code-picker" data-code-picker><button type="button" class="btn btn-sm code-picker-trigger" id="${esc(id)}" data-code-trigger aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(triggerLabel(format))}">${triggerContent(format)}</button></div>`;
}

/** Shows another language on a trigger without re-rendering anything around it. */
export function updateCodePicker(trigger, id) {
  const format = formatOf(id);
  trigger.innerHTML = triggerContent(format);
  trigger.setAttribute('aria-label', triggerLabel(format));
}

const optionHtml = (format, selected) => `<div class="opt-row lang-row" role="option" id="lang-opt-${esc(format.id)}" tabindex="-1" data-lang="${esc(format.id)}" aria-selected="${selected}">${langIcon(format.icon)}<span class="main"><bdi class="ltr">${esc(format.label)}</bdi></span><span class="end lang-lib" title="${esc(format.library)}"><bdi class="ltr">${esc(format.library)}</bdi></span><span class="lang-check" aria-hidden="true">${selected ? icon('check', true) : ''}</span></div>`;

/**
 * Wires every trigger under `root`. `onChange(id)` runs after the choice is stored and the list
 * is closed; focus then returns to the trigger with that id (it may have been re-rendered).
 */
export function bindCodePicker(root, { onChange }) {
  for (const trigger of root.querySelectorAll('[data-code-trigger]')) {
    trigger.addEventListener('click', () => {
      // A second click on an open trigger closes the list.
      if (trigger.getAttribute('aria-expanded') === 'true') closePopover(true);
      else openList(trigger, onChange);
    });
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openList(trigger, onChange);
      }
    });
  }
}

function openList(trigger, onChange) {
  closePopover();
  const current = getCodeFormat();
  const pop = openPopoverAt(trigger, `<div class="pop code-pop" role="listbox" aria-label="${esc(t('code.language'))}"><div class="pop-group">${pickerFormats.map(format => optionHtml(format, format.id === current)).join('')}</div></div>`,
    { align: 'start', focus: false, kind: 'code-language' });
  // The list is at least as wide as its trigger, so the right-aligned libraries line up under it.
  pop.style.minInlineSize = `max(${trigger.offsetWidth}px, 21rem)`;
  // On short screens the list scrolls inside the room on the roomier side of the trigger, so no row is cut off.
  const box = trigger.getBoundingClientRect();
  const room = Math.max(box.top, innerHeight - box.bottom) - 6 - 12 - 4;
  pop.querySelector('.pop-group').style.maxBlockSize = `${Math.max(160, Math.min(room, 448))}px`;
  place(trigger, pop, { align: 'start' });
  const options = [...pop.querySelectorAll('[role="option"]')];
  const focus = index => {
    for (const [position, option] of options.entries()) option.classList.toggle('is-active', position === index);
    options[index]?.focus({ preventScroll: false });
  };
  focus(Math.max(0, options.findIndex(option => option.dataset.lang === current)));

  const choose = option => {
    setCodeFormat(option.dataset.lang);
    closePopover();
    onChange(option.dataset.lang);
    document.getElementById(trigger.id)?.focus();
  };

  let typed = '';
  let typedAt = 0;
  pop.addEventListener('keydown', event => {
    const index = options.indexOf(document.activeElement);
    const keys = { ArrowDown: Math.min(index + 1, options.length - 1), ArrowUp: Math.max(index - 1, 0), Home: 0, End: options.length - 1 };
    if (event.key in keys) {
      event.preventDefault();
      focus(keys[event.key]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (index >= 0) choose(options[index]);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      closePopover(true);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Type-ahead: letters typed in quick succession form a prefix; one letter repeated cycles.
      const now = Date.now();
      typed = now - typedAt > TYPE_AHEAD_MS ? event.key.toLowerCase() : typed + event.key.toLowerCase();
      typedAt = now;
      const cycling = typed.length > 1 && [...typed].every(letter => letter === typed[0]);
      const prefix = cycling ? typed[0] : typed;
      const start = cycling || typed.length === 1 ? index + 1 : index;
      const ordered = [...options.slice(start), ...options.slice(0, start)];
      const hit = ordered.find(option => formatOf(option.dataset.lang).label.toLowerCase().startsWith(prefix));
      if (hit) {
        event.preventDefault();
        focus(options.indexOf(hit));
      }
    }
  });
  pop.addEventListener('click', event => {
    const option = event.target.closest('[role="option"]');
    if (option) choose(option);
  });
}
