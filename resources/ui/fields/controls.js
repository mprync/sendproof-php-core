import { element, svg } from './dom.js';
import { newUuid } from '../uuid.js';
import { lookupControl } from './lookup.js';
import { enumDescriptions, radioGroup, selectControl, useRadio } from './select.js';
import { matchesShortcut, shortcutAria } from '../shortcuts.js';
import { current, datePattern, nativeDigits, formatDate, formatDayMonthYear, formatNumber, formatWeekday, parseLocalDate, t } from '../i18n.js';

/** Decimals shown for a number field: from multipleOf, two for decimal formats, else as typed. */
export function shownDecimals(schema) {
  if (typeof schema.multipleOf === 'number' && schema.multipleOf < 1) return (String(schema.multipleOf).split('.')[1] || '').length;
  return schema.format === 'decimal' || /decimal/.test(schema['x-sendproof-type-label'] || '') ? 2 : undefined;
}

/** A number as this locale writes it in an input: 50,000.00 or 50.000,00. */
export function displayNumber(value, schema) {
  if (typeof value !== 'number') return value ?? '';
  const digits = shownDecimals(schema);
  return formatNumber(value, digits === undefined ? { maximumFractionDigits: 20 } : { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Reads a number typed in this locale or in plain JSON form. Returns NaN when it isn't one. */
export function parseLocalNumber(text) {
  const parts = new Intl.NumberFormat(current().locale).formatToParts(12345.6);
  const group = parts.find(part => part.type === 'group')?.value ?? ',';
  const decimal = parts.find(part => part.type === 'decimal')?.value ?? '.';
  let value = nativeDigits(String(text).trim()).replace(/[\u00a0\u202f\s]/g, '');
  if (!value) return NaN;
  // A lone '.' in a comma-decimal locale is a decimal point unless it groups thousands.
  const plainDecimal = decimal !== '.' && !value.includes(decimal) && /^[+-]?\d+\.\d+$/.test(value) && !/^[+-]?\d{1,3}\.\d{3}$/.test(value);
  if (!plainDecimal) value = value.split(group).join('').replace(decimal, '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return NaN;
  return Number(value);
}

/**
 * An enum: a radio group when every value is visible at a glance (useRadio), else a select.
 * `field` carries the label id, the sheet title and whether the field is optional.
 */
export function enumControl(context, schema, path, id, required, field = {}) {
  const descriptions = enumDescriptions(schema, context.resolve);
  const options = schema.enum.filter(value => value !== null && typeof value !== 'object')
    .map(value => ({ value, label: String(value), description: descriptions[String(value)] }));
  // A choice re-renders its field, so the status line ("Sends status=Open") and Clear follow it.
  const set = value => { context.set(path, value); context.render(JSON.stringify(path)); };
  const common = { id, options, value: context.get(path), optional: !required, onChange: set, labelledBy: field.labelledBy, required };
  if (useRadio(options.map(option => option.value))) return radioGroup(common);
  return selectControl({ ...common, sheet: field.sheet, unsetHint: field.unsetHint, mono: ['number', 'integer'].includes(context.kind(schema)) });
}

/** The control for a scalar: lookup, enum, boolean, file or a text input. `field` is enumControl's. */
export function scalarControl(context, schema, type, path, id, required, label, field = {}) {
  if (schema['x-lookup']) return lookupControl(context, schema['x-lookup'], schema, path, id, required, schema.title || label, field);
  if (schema.enum) return enumControl(context, schema, path, id, required, field);
  const control = element('div', 'control');
  const slot = element('span', 'slot');
  slot.setAttribute('aria-hidden', 'true');
  if (schema.format === 'binary') {
    const input = element('input');
    input.id = id;
    input.type = 'file';
    if (required) input.setAttribute('aria-required', 'true');
    input.addEventListener('change', () => {
      context.set(path, input.files?.[0]);
    });
    control.append(input, slot);
    const value = context.get(path);
    if (value && typeof value.name === 'string') control.append(element('span', 'trail', value.name));
    return control;
  }
  // Two short values: a radio group, like any short enum.
  if (type === 'boolean') return radioGroup({ id, options: [true, false].map(value => ({ value, label: String(value) })), value: context.get(path), optional: !required, onChange: value => { context.set(path, value); context.render(JSON.stringify(path)); }, labelledBy: field.labelledBy, required });
  const input = element(type === 'json' ? 'textarea' : 'input');
  input.id = id;
  if (required) input.setAttribute('aria-required', 'true');
  if (type !== 'json') {
    input.type = schema.format === 'password' ? 'password' : schema.format === 'date-time' ? 'datetime-local' : 'text';
    if (type === 'integer' || type === 'number') input.inputMode = type === 'integer' ? 'numeric' : 'decimal';
  }
  if (schema.format === 'date') { input.placeholder = datePattern(); input.inputMode = 'numeric'; input.size = Math.max(datePattern().length, 10); }
  if (schema.format === 'email') { input.placeholder = 'name@example.com'; input.inputMode = 'email'; }
  // The placeholder shows the value the API would use: its default, else its minimum, else 0.
  if (type === 'number' || type === 'integer') { const hint = schema.default ?? schema.minimum ?? 0; input.placeholder = displayNumber(hint, schema) || String(hint); input.className = 'num'; }
  if (schema.format === 'uuid' || /id$/i.test(label)) input.classList.add('mono-val');
  if (type === 'number') input.step = 'any';
  if (schema.format === 'date-time') input.step = 'any';
  const value = context.get(path);
  if (type === 'json') input.value = value === undefined ? '' : JSON.stringify(value, null, 2);
  else if (schema.format === 'date-time' && value) {
    const date = new Date(value);
    input.value = Number.isNaN(date.valueOf()) ? '' : new Date(date.valueOf() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  } else input.value = schema.format === 'date' ? dateDisplay(value) : type === 'number' || type === 'integer' ? displayNumber(value, schema) : value ?? '';
  if (['date', 'date-time', 'email'].includes(schema.format)) {
    const lead = element('span', 'lead');
    lead.append(svg(schema.format === 'email' ? 'at' : 'calendar'));
    control.append(lead);
  }
  input.addEventListener('input', () => {
    const text = input.value;
    const key = JSON.stringify(path);
    const setError = (message, json = false) => {
      if (message) context.parseErrors.set(key, { path: path.join('.'), message, json });
      else context.parseErrors.delete(key);
    };
    if (type === 'json') {
      try {
        const parsed = text.trim() ? JSON.parse(text) : undefined;
        setError();
        context.set(path, parsed);
      } catch {
        setError(t('field.fixJson'), true);
        context.validate?.(path);
      }
    } else if (type === 'number' || type === 'integer') {
      const trimmed = text.trim();
      const number = parseLocalNumber(trimmed);
      setError(trimmed && !Number.isFinite(number)
        ? (type === 'integer' ? t('field.wholeNumber', { example: formatNumber(1250) }) : t('field.number', { example: displayNumber(1250, { format: 'decimal' }) }))
        : undefined);
      // Keep an invalid draft as text so a tab switch cannot turn `g` into an
      // empty value or JSON null before validation gets a chance to report it.
      context.set(path, trimmed === '' ? undefined : Number.isFinite(number) ? number : text);
    }
    else if (schema.format === 'date') {
      const parsed = parseLocalDate(text);
      setError(parsed.invalid === 'day' ? t('field.noSuchDate', { date: formatDayMonthYear(parsed.year, parsed.month, parsed.day) })
        : parsed.invalid ? t('field.dateFormat', { pattern: datePattern() }) : undefined);
      context.set(path, parsed.iso ?? (text || undefined));
      updateWeekday();
    }
    else if (schema.format === 'date-time') {
      const date = new Date(text);
      context.set(path, text ? (Number.isFinite(date.valueOf()) ? date.toISOString() : text) : undefined);
    }
    else context.set(path, text === '' && !required ? undefined : text);
  });
  // A date shows its weekday at the end, so weekends are easy to spot.
  const weekday = schema.format === 'date' ? element('span', 'trail') : null;
  function updateWeekday() {
    if (!weekday) return;
    const iso = context.get(path);
    weekday.textContent = typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? formatWeekday(iso) : '';
  }
  if (schema.format === 'date') {
    input.addEventListener('blur', () => { if (/^\d{4}-\d{2}-\d{2}$/.test(context.get(path) || '')) input.value = dateDisplay(context.get(path)); });
    const shortcuts = ['date-today', 'date-tomorrow', 'date-yesterday'];
    input.setAttribute('aria-keyshortcuts', shortcutAria(...shortcuts));
    input.dataset.shortcut = shortcuts.join(' ');
    input.addEventListener('keydown', event => {
      const key = shortcuts.find(id => matchesShortcut(id, event));
      if (!key) return;
      event.preventDefault();
      const current = context.get(path);
      let date = key === 'date-today' || !current ? new Date() : new Date(current + 'T00:00:00');
      if (!Number.isFinite(+date)) date = new Date();
      date.setDate(date.getDate() + (key === 'date-tomorrow' ? 1 : key === 'date-yesterday' ? -1 : 0));
      input.value = dateDisplay(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  control.append(input);
  if (weekday) { updateWeekday(); control.append(weekday); }
  control.append(slot);
  if (/^idempotency[-_ ]?key$/i.test(label)) {
    input.className = 'mono';
    const regenerate = element('button', 'btn btn-ghost', t('field.regenerate'));
    regenerate.type = 'button';
    regenerate.addEventListener('click', () => {
      const uuid = newUuid();
      if (uuid) { input.value = uuid; context.set(path, uuid); }
    });
    control.append(regenerate);
  }
  return control;
}

/** An ISO date as this locale writes it in an input (23/11/2026, 23.11.2026); other text as is. */
function dateDisplay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value) : value ?? '';
}
