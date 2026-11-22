// The ID lookup (mocks 81, 85, m24): a select whose options are real records from the API
// (x-lookup). The control shows the chosen record's name with its detail in mono; the popover
// is the shared listbox (ui/listbox.js) with search by name, detail or ID, "From your last
// request" first, every record with a quiet tag for a non-default status, then "Paste an ID"
// (⌘V) and "Random UUID" (to test 404). The source of the options lives in the popover's footer
// on one line: GET /api/v2/accounts · as Ada Admin · 25, with Refresh.
//
// Loading, empty, error and signed-out states mirror the loaded layout; paste works in all of them.
import { element, svg, title } from './dom.js';
import { fromLastResponse, getLookupOptions } from './lookup-source.js';
import { newUuid } from '../uuid.js';
import { matchesShortcut, shortcutAria, shortcutHint } from '../shortcuts.js';
import { esc, icon } from '../components.js';
import { formatNumber, t, th } from '../i18n.js';
import { closeListbox, openListbox } from '../listbox.js';

/** "account" from an x-lookup URL such as /api/v2/accounts?pageSize=100. */
export function lookupNoun(url) {
  const segment = String(url ?? '').split('?')[0].split('/').filter(Boolean).at(-1) ?? '';
  if (!/^[a-z][a-z-]*$/i.test(segment)) return '';
  const word = segment.endsWith('ies') ? segment.slice(0, -3) + 'y' : segment.endsWith('s') && !segment.endsWith('ss') ? segment.slice(0, -1) : segment;
  return word.replace(/-/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** The chip glyph for a record: a currency symbol when it has one, else its first letter. */
function glyph(option) {
  const currency = typeof option.end === 'string' && /^[A-Z]{3}$/.test(option.end) ? option.end : undefined;
  if (currency) {
    try { return new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find(part => part.type === 'currency')?.value || option.label.charAt(0); }
    catch { /* An unknown code keeps the first letter. */ }
  }
  return String(option.label).charAt(0).toUpperCase();
}

/**
 * Records already loaded, by lookup URL, for the session: a re-rendered field (after a pick, a
 * tab switch or a carried-over value) names its record at once instead of flashing the raw ID.
 */
const known = new Map();

/** A shortened ID for the status line: e25dbc9d…e3dd. */
const shortId = value => { const text = String(value); return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text; };

/**
 * The lookup control. `field` carries the label id and the phone sheet's title.
 * Returns the `.control` element (role="combobox").
 */
export function lookupControl(context, metadata, schema, path, id, required, label, field = {}) {
  const control = element('div', 'control sel lk');
  control.id = id;
  control.tabIndex = 0;
  control.setAttribute('role', 'combobox');
  control.setAttribute('aria-haspopup', 'listbox');
  control.setAttribute('aria-expanded', 'false');
  if (field.labelledBy) control.setAttribute('aria-labelledby', field.labelledBy);
  if (required) control.setAttribute('aria-required', 'true');
  const shortcuts = ['lookup-open', 'lookup-preview', 'lookup-paste', ...(schema.format === 'uuid' ? ['autofill-ids'] : [])];
  control.setAttribute('aria-keyshortcuts', shortcutAria(...shortcuts));
  control.dataset.shortcut = shortcuts.join(' ');
  const picked = element('span', 'picked');
  const slot = element('span', 'slot');
  slot.setAttribute('aria-hidden', 'true');
  const trigger = element('span', 'sel-trigger');
  trigger.setAttribute('aria-hidden', 'true');
  trigger.append(svg('chevron-down'));
  control.append(picked, slot, trigger);

  const noun = lookupNoun(metadata.url) || title(label).toLowerCase().replace(/ id$/, '');
  const placeholder = t('lookup.choose', { name: noun, article: /^[aeiou]/.test(noun) ? 'an' : 'a' });
  const last = fromLastResponse(context.lastResponse, metadata);
  const signedOut = context.signedIn === false && !!metadata.url;
  const cacheKey = `${context.basePath}|${metadata.url}`;
  let options = (metadata.url && known.get(cacheKey)) || [];
  let state = signedOut ? 'signedout' : metadata.url && !known.has(cacheKey) ? 'idle' : 'ok';
  let loadError = { status: '' };
  let generation = 0;
  let searchTimer;
  let box;

  const currentOption = () => options.find(option => Object.is(option.value, context.get(path))) ||
    (last && Object.is(last.value, context.get(path)) ? last : undefined);

  /** The control's face: the record's chip, name and detail, or the placeholder. */
  function renderSelection() {
    const value = context.get(path);
    const current = currentOption();
    picked.replaceChildren();
    control.classList.toggle('has-pick', value !== undefined);
    if (value === undefined) { picked.append(element('span', 'placeholder', placeholder)); return; }
    // Until the records arrive, a placeholder in the record's shape, not the raw ID.
    if (!current && ['idle', 'loading'].includes(state)) {
      const chip = element('span', 'sk sk-box');
      const line = element('span', 'sk sk-line');
      line.style.inlineSize = '10rem';
      picked.append(chip, line);
      picked.setAttribute('aria-busy', 'true');
      return;
    }
    picked.removeAttribute('aria-busy');
    const text = String(current?.label ?? value);
    const chip = element('span', 'chip-ico', current ? glyph(current) : text.charAt(0).toUpperCase());
    chip.setAttribute('aria-hidden', 'true');
    const main = element('span', 'main', text);
    main.lang = 'en';
    picked.append(chip, main);
    if (current?.detail !== undefined) picked.append(element('span', 'sub', String(current.detail)));
    else if (!current) main.classList.add('mono-val');
  }

  /** The record noun's plural as the group label: "Accounts · 25". */
  const groupLabel = n => `${esc(title(String(metadata.url ?? '').split('?')[0].split('/').filter(Boolean).at(-1) || t('lookup.optionsTitle')))} · ${esc(formatNumber(n))}`;

  function items() {
    const list = [];
    if (last?.value !== undefined && last.value !== null) list.push({ ...row(last), group: esc(t('lookup.lastResponse')) });
    const rest = options.filter(option => !Object.is(option.value, last?.value));
    list.push(...rest.map(option => ({ ...row(option), group: groupLabel(options.length) })));
    list.push({ command: 'paste', icon: 'copy', label: t('lookup.paste'), end: shortcutHint('lookup-paste') });
    if (schema.format === 'uuid') list.push({ command: 'uuid', icon: 'refresh', label: t('lookup.random'), description: t('lookup.randomBody') });
    return list;
  }
  function row(option) {
    const end = [option.status && !/^(open|active|enabled)$/i.test(String(option.status)) ? `<span class="tag">${esc(option.status)}</span>` : '', option.end ? esc(option.end) : ''].join('');
    return { value: option.value, label: String(option.label), detail: option.detail !== undefined ? String(option.detail) : undefined, keywords: [String(option.value)], glyph: glyph(option), end, valueLang: 'en' };
  }

  /** The state rows above the commands, in the same shape as the loaded list. */
  function before() {
    if (state === 'loading' || state === 'idle') {
      const widths = [[52, 70], [64, 62], [44, 74], [58, 66], [48, 70]];
      return `<li class="lb-group" role="presentation"><span class="spinner" aria-hidden="true"></span>${esc(t('lookup.loading'))}</li>${widths.map(([a, b]) =>
        `<li class="lb-sk" aria-hidden="true"><span class="sk sk-box"></span><span class="stack"><span class="sk sk-line" style="inline-size:${a}%"></span><span class="sk sk-line thin" style="inline-size:${b}%"></span></span><span class="sk sk-line" style="inline-size:2rem"></span></li>`).join('')}`;
    }
    if (state === 'empty') {
      // The operation that creates a record of this kind, when the spec has one: POST to the same collection.
      const create = context.document?.paths?.[String(metadata.url).split('?')[0]]?.post;
      const action = create?.operationId ? `<a class="btn btn-sm" href="#op/${encodeURIComponent(create.operationId)}">${icon('plus', true)}<span lang="en">${esc(create.summary || create.operationId)}</span></a>` : '';
      return `<li class="lb-state" role="presentation"><strong>${icon('db', true)}${esc(context.actor ? t('lookup.emptyTitle', { name: context.actor }) : t('lookup.emptyTitlePlain'))}</strong><p>${esc(t('lookup.emptyBody'))}</p>${action}</li>`;
    }
    if (state === 'error') return `<li class="lb-state is-error" role="presentation"><strong>${icon('alert', true)}${esc(t('lookup.errorTitle'))}</strong><p>${loadError.status ? th('lookup.errorBody', { request: `<code>GET ${esc(metadata.url)}</code>`, status: esc(loadError.status) }) : esc(loadError.message)}</p><button type="button" class="btn btn-sm" data-lookup-retry>${icon('refresh', true)}${esc(t('lookup.retry'))}</button></li>`;
    if (state === 'signedout') return `<li class="lb-state" role="presentation"><strong>${icon('lock', true)}${esc(t('lookup.outTitle'))}</strong><p>${esc(t('lookup.outBody'))}</p>${context.onSignIn ? `<button type="button" class="btn btn-sm btn-primary" data-lookup-signin>${icon('log-in', true)}${esc(t('shell.signIn'))}</button>` : ''}</li>`;
    return '';
  }

  /** The footer: where the options come from, as whom, how many, and Refresh. */
  function source() {
    if (!metadata.url) return '';
    const [route, query] = String(metadata.url).split(/(?=\?)/);
    const meta = { ok: context.actor ? `<span class="who">· ${esc(t('lookup.as', { name: context.actor }))}</span> · ${esc(formatNumber(options.length))}` : `· ${esc(formatNumber(options.length))}`,
      loading: `· ${esc(t('lookup.metaLoading'))}`, idle: `· ${esc(t('lookup.metaLoading'))}`, empty: context.actor ? `<span class="who">· ${esc(t('lookup.as', { name: context.actor }))}</span> · ${esc(formatNumber(0))}` : `· ${esc(formatNumber(0))}`,
      error: `· ${esc(t('lookup.metaError', { code: loadError.status || '?' }))}`, signedout: `· ${esc(t('lookup.metaOut'))}` }[state];
    const glyphName = state === 'error' ? 'alert' : state === 'signedout' ? 'lock' : 'db';
    return `<div class="lb-src">${icon(glyphName, true)}<code class="src-q ltr" title="${esc(`GET ${metadata.url}`)}"><span>GET ${esc(route)}</span>${query ? `<span class="qs">${esc(query)}</span>` : ''}</code><span class="meta">${meta}</span><span class="spacer"></span><button type="button" class="btn btn-ghost btn-icon btn-xs" data-lookup-refresh aria-label="${esc(t('lookup.refresh'))}" title="${esc(t('lookup.refresh'))}">${icon('refresh', true)}</button></div>`;
  }

  async function load(query = '', force = false) {
    if (!metadata.url && !Array.isArray(metadata.options)) return;
    if (signedOut) return;
    const ticket = ++generation;
    if (force) { context.lookupCache.clear?.(); known.delete(cacheKey); }
    if (state === 'ok' && !force && !query && options.length) return;
    state = 'loading';
    refresh();
    try {
      const loaded = await getLookupOptions(context, metadata, query);
      if (ticket !== generation) return;
      options = loaded;
      if (!query && metadata.url) known.set(cacheKey, loaded);
      state = loaded.length || query ? 'ok' : 'empty';
    } catch (error) {
      if (ticket !== generation) return;
      loadError = { status: /HTTP (\d+)/.exec(error.message)?.[1] ?? '', message: error.message };
      state = 'error';
    }
    refresh();
    renderSelection();
    // The status line counts the records once they're known (unless an error has taken it over).
    const hint = control.closest?.('.field')?.querySelector(':scope > .assist:not(.is-error):not(.is-generated) .field-hint');
    if (hint) { hint.innerHTML = control.lookupStatus(); hint.dataset.base = hint.innerHTML; }
  }

  function refresh() {
    box?.update(items(), { before: before(), after: source() });
  }

  function pick(value, preview = false) {
    context.set(path, value);
    context.render(JSON.stringify(path));
    if (preview) context.onLookupPreview?.();
  }

  async function command(item) {
    if (item.command === 'paste') {
      try { paste(await navigator.clipboard.readText()); }
      catch { control.title = t('lookup.pasteHelp'); }
    } else if (item.command === 'uuid') pick(newUuid());
  }

  function paste(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return;
    closeListbox();
    pick(context.kind(schema) === 'integer' && /^-?\d+$/.test(text) ? Number(text) : text);
  }

  function show() {
    box = openListbox(control, {
      label: t('lookup.options', { name: title(label) }), className: 'lk-pop',
      items: items(), value: context.get(path), search: true,
      // "Search by name, IBAN or ID": a short field name is an acronym; a longer one reads as words.
      searchLabel: metadata.detailField ? t('lookup.searchBy', { detail: metadata.detailField.length <= 4 ? metadata.detailField.toUpperCase() : title(metadata.detailField).toLowerCase() }) : t('lookup.searchPlain'),
      before: before(), after: source(), sheet: field.sheet,
      onPick: item => item.command ? command(item) : pick(item.value),
      onKey: (event, { item }) => {
        if (matchesShortcut('lookup-preview', event) && item && !item.command) { closeListbox(true); pick(item.value, true); return true; }
        if (matchesShortcut('autofill-ids', event) && schema.format === 'uuid') { closeListbox(true); pick(newUuid()); return true; }
        return false;
      },
      onSearch: query => {
        if (!metadata.searchParam) return;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => load(query), 200);
      },
      onClose: () => clearTimeout(searchTimer),
    });
    const search = box.pop.querySelector('.lb-search input');
    // Paste works in every state: an ID pasted into the search box is used as the value.
    search?.addEventListener('paste', event => {
      const text = event.clipboardData?.getData('text/plain')?.trim();
      if (!text || options.some(option => String(option.label).toLowerCase().includes(text.toLowerCase()))) return;
      event.preventDefault();
      paste(text);
    });
    box.pop.addEventListener('click', event => {
      if (event.target.closest('[data-lookup-refresh]')) load('', true);
      else if (event.target.closest('[data-lookup-retry]')) load('', true);
      else if (event.target.closest('[data-lookup-signin]')) { closeListbox(); context.onSignIn?.(); }
      else if (event.target.closest('a[href^="#op/"]')) closeListbox();
    });
    if (state === 'idle' || state === 'error') load('');
  }

  control.addEventListener('click', () => {
    if (control.getAttribute('aria-expanded') === 'true') closeListbox(true);
    else show();
  });
  control.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    paste(text);
  });
  control.addEventListener('keydown', event => {
    if (control.getAttribute('aria-expanded') === 'true') return;
    if (matchesShortcut('autofill-ids', event) && schema.format === 'uuid') pick(newUuid());
    else if ((event.key === 'Delete' || event.key === 'Backspace') && context.get(path) !== undefined) pick(undefined);
    else if (matchesShortcut('lookup-open', event) || ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) show();
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      show();
      const search = box?.pop.querySelector('.lb-search input');
      if (search) { search.value = event.key; search.dispatchEvent(new Event('input')); }
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  control.focusControl = () => control.focus();
  control.openOptions = () => { if (control.getAttribute('aria-expanded') !== 'true') show(); };
  /** Chooses a record (or any ID) as if it had been picked from the list. */
  control.choose = value => pick(value);
  /** What the status line says about this lookup: "Sends e25dbc9d…e3dd" or how many it offers. */
  control.lookupStatus = () => {
    const value = context.get(path);
    if (value !== undefined) return th('field.sends', { value: `<code>${esc(shortId(value))}</code>` });
    if (signedOut) return esc(t('lookup.outTitle'));
    if (state === 'error') return esc(loadError.status ? t('lookup.errorTitle') : loadError.message || t('lookup.errorTitle'));
    if (state === 'ok' && options.length) return esc(context.actor ? t('lookup.countAs', { n: options.length, name: context.actor }) : t('lookup.count', { n: options.length }));
    return esc(t('lookup.hint'));
  };
  renderSelection();
  // Load right away (the request is cached per URL): the control names the chosen record and the
  // status line says how many records there are to choose from.
  if (!signedOut && metadata.url) queueMicrotask(() => load(''));
  else if (Array.isArray(metadata.options)) load('');
  return control;
}
