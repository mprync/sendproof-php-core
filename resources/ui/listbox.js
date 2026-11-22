// The listbox popover shared by selects, the ID lookup and the language picker (mocks 78–81,
// 107, 112, m19, m20, m24, m25). It follows the WAI-ARIA select-only combobox pattern: focus
// stays on the control (or moves into the search box when the list is long) and
// aria-activedescendant points at the active option.
//
//   Keys     ↑ ↓ move · Home End jump · Enter or Space chooses · Esc closes (or clears the
//            search first) · Tab chooses the active option and moves on · typing jumps to the
//            first value that starts with what was typed (500 ms buffer, echoed in the footer)
//   Desktop  anchored to the control's start edge (the right edge in RTL), at least the
//            control's width and 16rem, below it or above when there is no room; the list gives
//            up height before the popover passes the viewport, so search and footer stay
//   Phone    (56rem and narrower) a bottom sheet: grab handle, the field's name and
//            description as its title, a 44 px Close, a scrim, focus kept inside, safe-area
//            padding. It never covers its own trigger.
//
// The listbox is its own layer above the anchored popovers in popover.js (it can open from
// Display settings), so it handles Esc and outside clicks before they reach that module.
import { esc, icon } from './components.js';
import { formatNumber, t } from './i18n.js';
import { shortcutHint } from './shortcuts.js';

const SHEET_QUERY = '(max-width: 56rem)';
const TYPE_AHEAD_MS = 500;
let open;
let counter = 0;

/** Whether a listbox popover is open now. */
export const listboxOpen = () => !!open;

/** Closes the open listbox. `restore` puts focus back on its control. */
export function closeListbox(restore = false) {
  if (!open) return;
  const current = open;
  open = undefined;
  current.pop.remove();
  current.scrim?.remove();
  current.anchor.setAttribute('aria-expanded', 'false');
  current.anchor.removeAttribute('aria-activedescendant');
  current.anchor.classList.remove('is-open');
  current.onClose?.();
  if (restore) current.anchor.focus({ preventScroll: true });
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = text => String(text ?? '').toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** Escapes `text` and marks the part that matches `query`. */
function highlight(text, query) {
  const value = String(text ?? '');
  if (!query) return esc(value);
  const at = fold(value).indexOf(fold(query));
  if (at < 0) return esc(value);
  return `${esc(value.slice(0, at))}<mark>${esc(value.slice(at, at + query.length))}</mark>${esc(value.slice(at + query.length))}`;
}

/**
 * Places a listbox popover against its anchor in viewport coordinates.
 * Exported for tests and for the language picker, which opens beside Display settings.
 */
export function placeListbox(anchor, pop, { align = 'start', gap = 6, width = 'anchor' } = {}) {
  const a = anchor.getBoundingClientRect();
  const rtl = getComputedStyle(anchor).direction === 'rtl';
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const list = pop.querySelector('.lb-list');
  if (list) list.style.maxBlockSize = '';
  Object.assign(pop.style, { position: 'fixed', top: '', bottom: '', left: '', right: '' });
  // At least the trigger's width (never capped below it) and at least 16rem.
  if (width === 'anchor') pop.style.inlineSize = Math.min(Math.max(a.width, 16 * rem), innerWidth - 24) + 'px';
  const w = pop.offsetWidth;
  const end = (align === 'end') !== rtl;
  const left = Math.max(12, Math.min(end ? a.right - w : a.left, innerWidth - w - 12));
  pop.style.left = left + 'px';
  const height = pop.offsetHeight;
  const below = innerHeight - a.bottom - gap - 12;
  const above = a.top - gap - 12;
  pop.classList.toggle('is-above', height > below && above > below);
  if (height > below && above > below) pop.style.bottom = (innerHeight - a.top + gap) + 'px';
  else pop.style.top = (a.bottom + gap) + 'px';
  // Never past the viewport: the list gives up height; the search and footer stay.
  const room = pop.classList.contains('is-above') ? above : below;
  if (list && height > room) list.style.maxBlockSize = Math.max(7.5 * rem, list.offsetHeight - (height - room)) + 'px';
}

/**
 * Opens a listbox for `anchor` (the element with role="combobox").
 *
 * @param {HTMLElement} anchor
 * @param {object} config
 * @param {string} config.label            accessible name of the listbox
 * @param {Array<object>} config.items     options: { value, label, detail, description, mono,
 *        lang, dir, glyph (chip text), icon, end (HTML), group, keywords, command, unset }
 * @param {*} [config.value]               the chosen value (shows the check)
 * @param {boolean|'auto'} [config.search] a search box: 'auto' when there are more than 8 values
 * @param {string} [config.searchLabel]    its placeholder
 * @param {string} [config.before]         HTML shown above the options (states such as loading)
 * @param {string} [config.after]          HTML under the list (the lookup's source line, a preview)
 * @param {string|false} [config.foot]     footer HTML; false hides it; default shows the keys
 * @param {{title: string, sub?: string}} [config.sheet] the bottom sheet's title (HTML) on phones
 * @param {string} [config.className]      extra classes for the popover
 * @param {(item: object) => void} config.onPick
 * @param {(item: object) => void} [config.onActive] the active option changed (language preview)
 * @param {(query: string) => void} [config.onSearch]
 * @param {() => void} [config.onClose]
 * @param {*} [config.active]              the option to start on (default: the chosen one)
 * @param {(event: KeyboardEvent, api: {item: object, choose: Function}) => boolean} [config.onKey]
 *        handles a key before the listbox does; return true when it did
 */
export function openListbox(anchor, config) {
  closeListbox();
  const id = `lb-${++counter}`;
  const sheet = !!config.sheet && matchMedia(SHEET_QUERY).matches;
  const pop = document.createElement('div');
  pop.className = `pop lb${sheet ? ' is-sheet' : ''}${config.className ? ' ' + config.className : ''}`;
  pop.dataset.layer = 'listbox';
  const searchable = config.search === 'auto' ? config.items.filter(item => !item.command && !item.unset).length > 8 : !!config.search;
  let query = '';
  let typed = '';
  let typedTimer;
  let shown = [];
  let active = -1;
  let scrim;

  if (sheet) {
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'true');
    pop.setAttribute('aria-label', String(config.sheet.title).replace(/<[^>]+>/g, ''));
    scrim = document.createElement('div');
    scrim.className = 'sheet-scrim';
    scrim.dataset.layer = 'listbox';
    scrim.setAttribute('aria-hidden', 'true');
    scrim.addEventListener('click', () => closeListbox(true));
    document.body.append(scrim);
  }
  const keys = config.foot === false ? '' : config.foot ?? `<span>${shortcutHint('updown')}${esc(t('select.move'))}</span><span>${shortcutHint('enter')}${esc(t('select.choose'))}</span><span class="typed" data-typed hidden></span><span class="spacer"></span><span>${shortcutHint('escape')}</span>`;
  pop.innerHTML = `${sheet ? `<div class="sheet-head"><span class="grab" aria-hidden="true"></span>
      <div class="sheet-title"><strong>${config.sheet.title}</strong>${config.sheet.sub ? `<span>${config.sheet.sub}</span>` : ''}</div>
      <button type="button" class="btn btn-ghost btn-icon" data-sheet-close aria-label="${esc(t('select.close'))}">${icon('x')}</button></div>` : ''}
    ${searchable ? `<div class="lb-search">${icon('search', true)}<input type="text" role="searchbox" autocomplete="off" spellcheck="false" aria-controls="${id}" aria-label="${esc(config.searchLabel || t('select.search', { n: formatNumber(config.items.length) }))}" placeholder="${esc(config.searchLabel || t('select.search', { n: formatNumber(config.items.length) }))}"><span class="lb-count" aria-live="polite"></span></div>` : ''}
    <ul class="lb-list" role="listbox" id="${id}" aria-label="${esc(config.label)}" ${sheet && !searchable ? 'tabindex="0"' : ''}></ul>
    <div data-lb-after>${config.after ?? ''}</div>
    ${keys ? `<div class="pop-foot" aria-hidden="true">${keys}</div>` : ''}`;
  document.body.append(pop);
  const list = pop.querySelector('.lb-list');
  const search = pop.querySelector('.lb-search input');
  const count = pop.querySelector('.lb-count');
  // Keys go to the search box when there is one, to the list in a sheet, else to the control.
  const keyTarget = search || (sheet ? list : anchor);

  function matches(item) {
    if (!query || item.unset) return !query || !item.unset;
    if (item.command) return true;
    const q = fold(query);
    return [item.label, item.detail, item.description, item.value, ...(item.keywords || [])].some(text => fold(text).includes(q));
  }

  function optionHtml(item, index) {
    const selected = !item.command && !item.unset ? Object.is(item.value, config.value) : item.unset ? config.value === undefined : false;
    const lead = item.glyph !== undefined ? `<span class="chip-ico" aria-hidden="true">${esc(item.glyph)}</span>` : item.icon ? `<span class="lead-ico" aria-hidden="true">${icon(item.icon, true)}</span>` : '';
    return `<li class="lb-opt${item.unset ? ' is-unset' : ''}${item.description || item.detail ? ' has-desc' : ''}" role="option" id="${id}-o${index}" data-index="${index}" aria-selected="${selected}"${item.lang ? ` lang="${esc(item.lang)}"` : ''}>
      <span class="lb-check" aria-hidden="true">${selected ? icon('check', true) : ''}</span>${lead}
      <span class="lb-text"><span class="v${item.mono ? ' mono' : ''}"${item.valueLang ? ` lang="${esc(item.valueLang)}"` : ''}${item.dir ? ` dir="${esc(item.dir)}"` : ''}>${item.html ?? highlight(item.label, query)}</span>${item.detail ? `<span class="d mono">${highlight(item.detail, query)}</span>` : ''}${item.description ? `<span class="d"${item.descriptionLang ? ` lang="${esc(item.descriptionLang)}"` : ''}>${highlight(item.description, query)}</span>` : ''}</span>
      ${item.end ? `<span class="end">${item.end}</span>` : ''}</li>`;
  }

  function render() {
    shown = config.items.map((item, index) => ({ item, index })).filter(({ item }) => matches(item));
    const real = shown.filter(({ item }) => !item.command && !item.unset);
    let html = config.before ?? '';
    let group;
    let sawCommand = false;
    for (const [position, { item, index }] of shown.entries()) {
      if (item.group !== undefined && item.group !== group) { group = item.group; html += `<li class="lb-group" role="presentation">${item.group}</li>`; }
      if (item.command && !sawCommand && position > 0) html += '<li class="lb-sep" role="presentation"></li>';
      if (item.command) sawCommand = true;
      html += optionHtml(item, index);
    }
    if (query && !real.length) html += `<li class="lb-empty" role="presentation">${esc(t('select.noMatch', { query }))}</li>`;
    list.innerHTML = html;
    if (count) count.textContent = query ? t('select.matches', { n: real.length }) : '';
    const keep = shown.findIndex(({ index }) => index === active);
    setActive(keep >= 0 ? active : (query ? real[0]?.index : undefined) ?? shown[0]?.index ?? -1, false);
    config.onSearch?.(query);
  }

  function setActive(index, scroll = true) {
    active = index;
    for (const row of list.querySelectorAll('.lb-opt')) row.classList.toggle('is-active', Number(row.dataset.index) === index);
    const row = list.querySelector(`[data-index="${index}"]`);
    if (row) {
      keyTarget.setAttribute('aria-activedescendant', row.id);
      if (keyTarget !== anchor) anchor.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    } else keyTarget.removeAttribute('aria-activedescendant');
    if (index >= 0) config.onActive?.(config.items[index]);
  }

  function move(step) {
    if (!shown.length) return;
    const at = shown.findIndex(({ index }) => index === active);
    const next = shown[Math.max(0, Math.min(shown.length - 1, at < 0 ? (step > 0 ? 0 : shown.length - 1) : at + step))];
    setActive(next.index);
  }

  function choose(index = active) {
    const item = config.items[index];
    if (!item) return false;
    closeListbox(true);
    config.onPick(item);
    return true;
  }

  /** Type-ahead: jump to the first value that starts with what was typed. */
  function typeAhead(char) {
    clearTimeout(typedTimer);
    typed += char;
    typedTimer = setTimeout(() => { typed = ''; echo(); }, TYPE_AHEAD_MS);
    const found = shown.find(({ item }) => !item.command && !item.unset && fold(item.label).startsWith(fold(typed)))
      ?? shown.find(({ item }) => !item.command && !item.unset && fold(item.label).startsWith(fold(char)));
    if (found) setActive(found.index);
    echo();
  }
  function echo() {
    const slot = pop.querySelector('[data-typed]');
    if (!slot) return;
    slot.hidden = !typed;
    slot.innerHTML = typed ? `${esc(t('select.typed'))} <code>${esc(typed)}</code>` : '';
  }

  function onKey(event) {
    if (!open || open.pop !== pop) return;
    // A caller's own shortcuts first (the lookup's ⌘↵ picks and previews).
    if (config.onKey?.(event, { item: config.items[active], choose })) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.altKey && event.key !== 'ArrowUp' || event.ctrlKey || event.metaKey) return;
    const inSearch = event.target === search;
    let handled = true;
    switch (event.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': if (event.altKey) choose(); else move(-1); break;
      case 'PageDown': move(8); break;
      case 'PageUp': move(-8); break;
      case 'Home': if (inSearch && search.value) handled = false; else setActive(shown[0]?.index ?? -1); break;
      case 'End': if (inSearch && search.value) handled = false; else setActive(shown.at(-1)?.index ?? -1); break;
      case 'Enter': choose(); break;
      case 'Tab':
        if (sheet) { trapFocus(event); return; }
        handled = false;
        if (active >= 0 && config.items[active] && !config.items[active].command) { const item = config.items[active]; closeListbox(); config.onPick(item); }
        else closeListbox();
        break;
      case ' ':
        if (inSearch) { handled = false; break; }
        if (typed) typeAhead(' '); else choose();
        break;
      default:
        if (!inSearch && event.key.length === 1 && !event.altKey) typeAhead(event.key);
        else handled = false;
    }
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }

  /** Keeps Tab inside the sheet (it is modal). */
  function trapFocus(event) {
    const stops = [...pop.querySelectorAll('button, input, [tabindex="0"]')].filter(node => !node.disabled && node.offsetParent !== null);
    if (!stops.length) return;
    const at = stops.indexOf(document.activeElement);
    event.preventDefault();
    stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
  }

  list.addEventListener('pointerdown', event => event.preventDefault());
  list.addEventListener('pointermove', event => {
    const row = event.target.closest('.lb-opt');
    if (row && Number(row.dataset.index) !== active && event.pointerType !== 'touch') setActive(Number(row.dataset.index), false);
  });
  list.addEventListener('click', event => {
    const row = event.target.closest('.lb-opt');
    if (row) choose(Number(row.dataset.index));
  });
  pop.addEventListener('click', event => {
    if (event.target.closest('[data-sheet-close]')) closeListbox(true);
  });
  search?.addEventListener('input', () => { query = search.value.trim(); render(); });
  pop.addEventListener('keydown', onKey);
  if (keyTarget === anchor) anchor.addEventListener('keydown', onKey);

  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', id);
  anchor.classList.add('is-open');
  open = { pop, scrim, anchor, onClose: () => { anchor.removeEventListener('keydown', onKey); clearTimeout(typedTimer); config.onClose?.(); }, sheet, reposition: () => !sheet && placeListbox(anchor, pop, config.place) };
  const start = config.active !== undefined ? config.items.findIndex(item => Object.is(item.value, config.active))
    : config.items.findIndex(item => item.unset ? config.value === undefined : !item.command && Object.is(item.value, config.value));
  active = start;
  render();
  if (!sheet) placeListbox(anchor, pop, config.place);
  setActive(active >= 0 ? active : shown[0]?.index ?? -1);
  if (keyTarget !== anchor) keyTarget.focus({ preventScroll: true });

  return {
    pop,
    /** Replaces the options (a lookup that finished loading) and keeps the active one if it's still there. */
    update(items, { before, after } = {}) {
      config.items = items;
      if (before !== undefined) config.before = before;
      if (after !== undefined) pop.querySelector('[data-lb-after]').innerHTML = after;
      render();
      if (!sheet) placeListbox(anchor, pop, config.place);
    },
    setAfter(html) { pop.querySelector('[data-lb-after]').innerHTML = html; },
    close: closeListbox,
  };
}


// Global listeners: one set, in a browser only (unit tests import this module in Node). The
// window capture phase runs before popover.js's document listeners, so Esc and outside clicks
// close the listbox first and leave Display settings open beneath it.
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', event => {
    if (!open || event.key !== 'Escape') return;
    const search = open.pop.querySelector('.lb-search input');
    event.preventDefault();
    event.stopPropagation();
    // The search box has one control: Esc clears it, then closes.
    if (search && search.value && document.activeElement === search) { search.value = ''; search.dispatchEvent(new Event('input')); return; }
    closeListbox(true);
  }, true);
  window.addEventListener('pointerdown', event => {
    if (!open || open.pop.contains(event.target) || open.anchor.contains(event.target)) return;
    if (open.scrim?.contains(event.target)) return;
    closeListbox();
  }, true);
  window.addEventListener('resize', () => open?.reposition());
  window.addEventListener('scroll', event => { if (open && !open.pop.contains(event.target)) open.reposition(); }, true);
}
