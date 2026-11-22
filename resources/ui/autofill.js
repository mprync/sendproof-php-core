import { esc, icon } from './components.js';
import { formatTime, t } from './i18n.js';
import { randomValid } from './generate.js';
import { resolveSchema, sampleValue } from './schema.js';
import { inferLookup } from './fields/infer.js';
import { fromLastResponse, getLookupOptions } from './fields/lookup-source.js';
import { newUuid } from './uuid.js';
import { matchesShortcut, shortcutAttrs, shortcutHint } from './shortcuts.js';

function type(schema) {
  return (Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type) ||
    (schema.properties ? 'object' : schema.items ? 'array' : undefined);
}

/** Fill a draft from documented examples, in-scope lookup records, and schema samples. */
export async function fillDraft(raw, draft, example, context, { all = false, regenerate = false } = {}, path = [], refs = new Set()) {
  if (raw?.$ref && refs.has(raw.$ref)) return draft;
  const schema = context.resolve(raw);
  if (schema.readOnly) return draft;
  const nextRefs = raw?.$ref ? new Set([...refs, raw.$ref]) : refs;
  if (schema.properties && (draft == null || typeof draft === 'object' && !Array.isArray(draft))) {
    const fields = Object.entries(schema.properties).filter(([key, child]) =>
      !context.resolve(child).readOnly && (regenerate || all || schema.required?.includes(key)));
    const values = await Promise.all(fields.map(async ([key, child]) => [
      key,
      await fillDraft(child, draft?.[key], example?.[key], context, { all, regenerate }, [...path, key], nextRefs),
    ]));
    return Object.fromEntries([...Object.entries(draft ?? {}), ...values.filter(([, value]) => value !== undefined)]);
  }
  if (type(schema) === 'array' && Array.isArray(draft) && regenerate) {
    return Promise.all(draft.map((child, index) =>
      fillDraft(schema.items, child, undefined, context, { regenerate }, [...path, index], nextRefs)));
  }
  const lookup = inferLookup(context, schema, String(path.at(-1) || ''));
  if (regenerate) {
    if (lookup || schema.format !== 'uuid' || draft == null) return draft;
    return newUuid();
  }
  if (draft !== undefined && draft !== null && draft !== '') return draft;
  let value;
  let source;
  if (lookup) {
    try {
      const last = fromLastResponse(context.lastResponse, lookup);
      const records = await getLookupOptions(context, lookup);
      value = records.find(option => Object.is(option.value, example))?.value ?? last?.value ?? records[0]?.value;
      source = context.actor ? t('gen.realRecordAs', { name: context.actor }) : t('gen.realRecord');
    } catch {
      // A failed lookup leaves its ID editable instead of inventing a record.
    }
  } else if (example !== undefined) {
    value = example;
    source = t('gen.fromExample');
  } else {
    // Random within the schema's constraints, so repeated previews don't all look the same.
    const generated = randomValid(schema, draft);
    value = generated ? generated.value : sampleValue(raw, context.document);
    source = generated?.source ?? t('gen.fromSchema');
  }
  if (value !== undefined) context.filled.set(JSON.stringify(path), source);
  return value;
}

export function autofillContext(document, basePath, operationPath, lastResponse, lookupCache, filled, actor) {
  return { document, basePath, operationPath, lastResponse, lookupCache, filled, actor, resolve: schema => resolveSchema(schema, document), kind: type };
}

const items = [
  ['required', 'wand', 'shortcut.autofill-required', 'fill.requiredSub'],
  ['all', 'list', 'shortcut.autofill-all', 'fill.allSub'],
  ['reuse', 'history', 'shortcut.autofill-reuse', ''],
  ['ids', 'refresh', 'fill.ids', 'fill.idsSub'],
  ['clear', 'trash', 'shortcut.autofill-clear', ''],
];

/** Open a keyboard-operable menu without adding anything to the form's flow. */
export function showAutofillMenu(anchor, { history, onSelect, canRegenerate, lookupActor, optionalCount = 0 }) {
  const request = anchor.closest('.request');
  if (!request) return;
  const previous = request.querySelector('.autofill-pop');
  if (previous) { previous.closeMenu(true); return; }
  function markup([id, glyph, text, hint]) {
    if ((id === 'reuse' && !history) || (id === 'ids' && !canRegenerate)) return '';
    const secondary = id === 'reuse' ? `${history.op.title} · ${formatTime(history.when)}` : hint ? t(hint, { n: optionalCount }) : '';
    return `<button type="button" class="opt-row" role="menuitem" data-fill="${id}" ${shortcutAttrs('autofill-' + id)}>${icon(glyph, true)}<span class="stack">
        <span class="main"${id === 'clear' ? ' style="font-weight:400"' : ''}>${esc(t(text))}</span>${secondary ? `<span class="sub">${esc(secondary)}</span>` : ''}
      </span><span class="end">${shortcutHint('autofill-' + id)}</span></button>`;
  }
  request.insertAdjacentHTML('beforeend', `<div class="pop autofill-pop" id="autofill-menu" role="menu" aria-label="${esc(t('req.autofill'))}">
    <div class="pop-group">${items.slice(0, -1).map(markup).join('')}</div>
    <div class="pop-group">${markup(items.at(-1))}</div>
    ${lookupActor ? `<div class="pop-foot">${icon('db', true)}<span>${esc(t('fill.realIds', { name: lookupActor }))}</span></div>` : ''}
  </div>`);
  const menu = request.querySelector('.autofill-pop');
  const bounds = request.getBoundingClientRect();
  const trigger = anchor.getBoundingClientRect();
  const rtl = document.documentElement.dir === 'rtl';
  menu.style.top = `${trigger.bottom - bounds.top + 4}px`;
  menu.style.insetInlineEnd = `${rtl ? trigger.left - bounds.left : bounds.right - trigger.right}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const controllers = new AbortController();
  const signal = controllers.signal;
  const close = (restore = false) => {
    controllers.abort();
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (restore) anchor.focus();
  };
  menu.closeMenu = close;
  const buttons = [...menu.querySelectorAll('button')];
  const focus = index => {
    buttons.forEach((button, i) => button.classList.toggle('is-active', index === i));
    buttons[index]?.focus();
  };
  focus(0);
  menu.addEventListener('keydown', event => {
    const key = ['down', 'up', 'home', 'end', 'escape'].find(id => matchesShortcut(id, event));
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    if (key === 'escape') return close(true);
    const index = buttons.indexOf(document.activeElement);
    const next = key === 'home' ? 0 : key === 'end' ? buttons.length - 1 :
      (index + (key === 'down' ? 1 : -1) + buttons.length) % buttons.length;
    focus(next);
  }, { signal });
  menu.addEventListener('click', event => {
    const choice = event.target.closest('[data-fill]')?.dataset.fill;
    if (!choice) return;
    close(true);
    onSelect(choice);
  }, { signal });
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
  }, { signal });
  request.querySelector('.pane-scroll').addEventListener('scroll', () => close(), { once: true, signal });
}
