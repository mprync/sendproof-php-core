// Schema-driven fields. Every field has the same four-part anatomy (mocks 76, 84, 87):
//
//   label row     name, "i" toggletip, "optional" … [Clear] type
//   control       input, select, radio group or lookup
//   description   the spec's description, flush with the control (always present, maybe empty,
//                 so paired fields on a subgrid keep their rows aligned)
//   status line   one reserved line: the constraints, what will be sent, or the character
//                 count. An error or "Generated: … Undo" replaces it, so nothing moves.
import { element, svg, title, typeDescription } from './dom.js';
import { scalarControl } from './controls.js';
import { selectControl, useRadio } from './select.js';
import { inferCurrency, inferLookup } from './infer.js';
import { shortcutAria, shortcutHintNode } from '../shortcuts.js';
import { formatNumber, formatRelativeDays, t, th } from '../i18n.js';
import { openGenerateMenu } from '../generate-menu.js';
import { randomValid } from '../generate.js';
import { displayNumber } from './controls.js';
import { esc } from '../components.js';
import { inline } from '../markdown.js';
import { enumDescriptions } from './select.js';

function variantName(raw, resolved, index) {
  return resolved.title || raw.$ref?.split('/').at(-1) || `Option ${index + 1}`;
}

function discriminatorValue(schema, raw, resolved, index) {
  const property = schema.discriminator?.propertyName;
  const mapped = Object.entries(schema.discriminator?.mapping || {}).find(([, ref]) => ref === raw.$ref)?.[0];
  const constraint = resolved.properties?.[property];
  return mapped ?? constraint?.const ?? constraint?.enum?.[0] ?? raw.$ref?.split('/').at(-1) ?? String(index);
}

/** Pick a variant without discarding fields from the supplied value. */
export function selectedVariant(context, schema, path) {
  const variants = schema.oneOf || schema.anyOf;
  if (!variants?.length) return null;
  const options = variants.map((raw, index) => {
    const resolved = context.resolve(raw);
    return { raw, resolved, name: variantName(raw, resolved, index), discriminator: discriminatorValue(schema, raw, resolved, index) };
  });
  const key = JSON.stringify(path);
  const discriminator = schema.discriminator?.propertyName;
  const value = context.get(path);
  let index = context.variants.get(key);
  if (index === undefined && discriminator && value && typeof value === 'object') {
    index = options.findIndex(option => option.discriminator === value[discriminator]);
  }
  if (index === undefined || index < 0 || !options[index]) {
    index = options.findIndex(option => (option.resolved.required || []).some(name => value?.[name] !== undefined));
  }
  if (index < 0 || index === undefined) index = 0;
  return { options, index, discriminator };
}

function objectFields(context, schema, path, refs, depth) {
  const fields = element('div', 'fields');
  const entries = inferCurrency(context, Object.entries(schema.properties || {}).filter(([, child]) => !child.readOnly));
  const paired = new Set(entries.map(([, child]) => child['x-currency-field']).filter(Boolean));
  const eligible = entries.filter(([name]) => !paired.has(name));
  const chips = element('div', 'optional-props');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', t('field.addOptional'));
  chips.append(element('span', 'lead-label', t('field.add')));
  let rowName, rowCount = 0;
  for (const [name, child] of eligible) {
    const resolved = context.resolve(child);
    const currencyName = child['x-currency-field'];
    const currency = currencyName && schema.properties[currencyName];
    const needed = schema.required?.includes(name);
    const pinned = needed || schema.required?.includes(currencyName) || resolved['x-sendproof-visible'] === true;
    const fieldPath = [...path, name];
    const key = JSON.stringify(fieldPath);
    const fieldLabel = resolved.title || title(name);
    const current = context.get(fieldPath);
    if (!pinned && current === undefined && !context.expanded.has(key)) {
      const chip = element('button', 'prop-chip');
      chip.type = 'button';
      chip.dataset.optionalPath = key;
      const type = typeDescription(resolved, context.kind(resolved));
      chip.append(svg('plus'), element('span', 'sr-only', t('field.addNamed', { name: '' })), element('span', 'ltr', name), element('span', 't', type));
      chip.addEventListener('click', () => {
        context.expanded.add(key);
        context.render(key);
      });
      chips.append(chip);
      continue;
    }
    const options = currency ? { name: currencyName, schema: currency, required: schema.required?.includes(currencyName) } : undefined;
    const field = renderField(context, child, fieldPath, name, needed, refs, depth + 1, options);
    const group = resolved['x-sendproof-row'];
    rowCount = group && group === rowName ? rowCount + 1 : 0;
    rowName = group;
    if (group && eligible.some(([other, candidate]) => other !== name && context.resolve(candidate)['x-sendproof-row'] === group)) {
      field.classList.add('half');
      if (rowCount === 0) field.classList.add('row-start');
    }
    if (!pinned) {
      const remove = element('button', 'btn btn-ghost btn-icon btn-xs field-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', t('field.remove', { name: fieldLabel }));
      remove.append(svg('x'));
      remove.addEventListener('click', () => {
        context.expanded.delete(key);
        context.set(fieldPath, undefined);
        context.render(key, true);
      });
      // Removing an added optional field sits at the end of its label row, beside the type.
      (field.querySelector(':scope > .label > .end') || field).prepend(remove);
    }
    fields.append(field);
  }
  if (chips.children.length > 1) fields.append(chips);
  return fields;
}

function arrayFields(context, schema, path, refs, depth, label) {
  const list = element('div', 'list-input');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', title(label));
  const values = Array.isArray(context.get(path)) ? context.get(path) : [];
  values.forEach((_, index) => {
    const row = element('div', 'li');
    const number = element('span', 'idx', String(index + 1));
    number.setAttribute('aria-hidden', 'true');
    row.append(number);
    const item = renderField(context, schema.items || {}, [...path, index], t('field.item', { n: index + 1 }), true, refs, depth + 1);
    const val = element('div', 'val');
    val.append(item);
    row.append(val);
    const remove = element('button', 'btn btn-ghost btn-icon btn-xs');
    remove.type = 'button';
    remove.setAttribute('aria-label', t('field.removeLine', { n: index + 1 }));
    remove.append(svg('x'));
    remove.addEventListener('click', () => {
      const updated = [...context.get(path)];
      updated.splice(index, 1);
      context.set(path, updated);
      for (const key of context.parseErrors.keys()) {
        const segments = JSON.parse(key);
        if (path.every((part, index) => segments[index] === part) && segments[path.length] >= index)
          context.parseErrors.delete(key);
      }
      context.render(JSON.stringify(path));
    });
    row.append(remove);
    list.append(row);
  });
  const add = element('button', 'add');
  add.type = 'button';
  add.disabled = values.length >= (schema.maxItems ?? Infinity);
  add.append(svg('plus'), element('span', '', t('field.addLine')), shortcutHintNode('add-row'));
  add.setAttribute('aria-keyshortcuts', shortcutAria('add-row'));
  add.dataset.shortcut = 'add-row';
  add.addEventListener('click', () => {
    context.set(path, [...values, undefined]);
    context.render(JSON.stringify([...path, values.length]));
  });
  list.append(add);
  return list;
}

function renderVariant(context, schema, path, refs, depth, selection) {
  const container = element('div', 'fields');
  const selector = selectControl({
    id: `variant-${context.nextId()}`, label: t('field.variant'), required: true,
    options: selection.options.map(option => ({ value: option.name, label: option.name })),
    value: selection.options[selection.index].name,
    onChange: name => {
      const index = selection.options.findIndex(option => option.name === name);
      if (index < 0) return;
      context.variants.set(JSON.stringify(path), index);
      if (selection.discriminator) {
        const current = context.get(path);
        const value = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
        value[selection.discriminator] = selection.options[index].discriminator;
        context.set(path, value);
      }
      context.render();
    },
  });
  container.append(selector);
  const base = { ...schema };
  delete base.oneOf;
  delete base.anyOf;
  const combined = context.resolve({ allOf: [base, selection.options[selection.index].raw] });
  if (combined.properties) container.append(objectFields(context, combined, path, refs, depth));
  else container.append(renderField(context, selection.options[selection.index].raw, path, selection.options[selection.index].name, false, refs, depth + 1));
  return container;
}

/** The type at the end of the label row: the enum's model name, the format, or the type. */
function typeName(raw, schema, type) {
  if (typeof schema['x-sendproof-type-label'] === 'string') return schema['x-sendproof-type-label'];
  const ref = raw?.$ref?.startsWith('#/components/schemas/') ? decodeURIComponent(raw.$ref.split('/').at(-1)) : '';
  if (schema.enum) return ref || 'enum';
  if (type === 'array') return `${schema.items?.$ref ? decodeURIComponent(schema.items.$ref.split('/').at(-1)) : schema.items?.format || schema.items?.type || 'value'}[]`;
  if (ref && type === 'object') return ref;
  return schema.format || type;
}

/** What kind of control a schema gets, which decides the label element and the status line. */
function controlKind(schema, type) {
  if (schema['x-lookup']) return 'lookup';
  if (schema.enum) return useRadio(schema.enum.filter(value => value !== null)) ? 'radio' : 'select';
  if (type === 'boolean') return 'radio';
  if (schema.format === 'date') return 'date';
  return 'input';
}

/** Render one schema node; recursive references fall back to editable JSON. */
export function renderField(context, raw, path, label, required, refs = new Set(), depth = 0, currency) {
  const repeated = raw?.$ref && refs.has(raw.$ref);
  const nextRefs = raw?.$ref ? new Set([...refs, raw.$ref]) : refs;
  let schema = context.resolve(raw);
  const lookup = inferLookup(context, schema, label);
  if (lookup && !Object.hasOwn(schema, 'x-lookup')) schema = { ...schema, 'x-lookup': lookup };
  const variant = !repeated && selectedVariant(context, schema, path);
  const type = repeated || depth > 12 ? 'json' : context.kind(schema);
  const custom = context.customRenderer(schema, path, label);
  const structuredObject = type === 'object' && schema.properties && !schema.additionalProperties;
  const objectVariant = variant && variant.options.every(option => context.kind(option.resolved) === 'object');
  const flattened = context.flattenRoot && path.length === 0 && !custom && (structuredObject || objectVariant);
  const field = element('div', flattened ? '' : 'field');
  field.dataset.schemaPath = JSON.stringify(path);
  const id = `schema-field-${context.nextId()}`;
  const fieldLabel = schema.title || title(label);
  const kind = custom || variant || type === 'object' || type === 'array' ? 'group' : controlKind(schema, type);
  if (!flattened) field.dataset.kind = kind;
  const labelNode = element('div', 'label');
  // A <label for> only names real inputs; comboboxes and radio groups are named by aria-labelledby.
  const labelText = element(['input', 'date'].includes(kind) || custom ? 'label' : 'span', 'name', fieldLabel);
  labelText.id = `${id}-label`;
  if (labelText.tagName === 'LABEL') labelText.htmlFor = id;
  else labelText.addEventListener('click', () => field.querySelector(`[id="${id}"]`)?.focusControl?.());
  labelText.lang = 'en';
  labelNode.append(labelText);
  // The "i" toggletip trigger explains the field from the spec (24 px target).
  const info = element('button', 'info-btn');
  info.type = 'button';
  info.setAttribute('aria-label', t('field.about', { name: fieldLabel }));
  info.setAttribute('aria-expanded', 'false');
  info.setAttribute('aria-keyshortcuts', shortcutAria('field-info'));
  info.dataset.shortcut = 'field-info';
  info.append(svg('info'));
  info.fieldInfo = { schema, label: fieldLabel, required, path, parameter: context.parameter, example: context.exampleAt?.(path),
    currency: currency && { name: currency.name, values: context.resolve(currency.schema).enum } };
  labelNode.append(info);
  if (!required) labelNode.append(element('span', 'opt', t('field.optional')));
  // The end of the label row: Clear (an optional choice that has a value), then the type.
  const end = element('span', 'end');
  const value = context.get(path);
  if (!required && value !== undefined && ['radio', 'select', 'lookup', 'date'].includes(kind)) {
    const clear = element('button', 'field-clear', t('field.clear'));
    clear.type = 'button';
    clear.setAttribute('aria-label', t('field.clearName', { name: fieldLabel }));
    clear.addEventListener('click', () => {
      context.set(path, undefined);
      context.render(JSON.stringify(path));
    });
    end.append(clear);
  }
  const typeLabel = element('span', 'type', typeName(raw, schema, type));
  typeLabel.title = typeDescription(schema, type);
  end.append(typeLabel);
  labelNode.append(end);
  // The phone sheet of a select or lookup: the field's name and description as its title.
  const sheet = { title: esc(fieldLabel), sub: schema.description ? inline(String(schema.description).replace(/\s*\n\s*/g, ' ')) : '' };
  const controlField = { labelledBy: `${id}-label`, sheet, unsetHint: context.parameter?.in === 'query' ? t('field.anyHintQuery') : t('field.anyHint') };
  if (!flattened) field.append(labelNode);
  if (custom) {
    const node = custom({ schema, path, name: label, value: context.get(path), setValue: value => context.set(path, value), document: context.document, id, required });
    if (node) field.append(node);
  } else if (variant) field.append(renderVariant(context, schema, path, nextRefs, depth, variant));
  else if (type === 'object' && schema.properties && !schema.additionalProperties) field.append(objectFields(context, schema, path, nextRefs, depth));
  else if (type === 'array') field.append(arrayFields(context, schema, path, nextRefs, depth, label));
  else {
    const control = scalarControl(context, schema, type, path, id, required, label, controlField);
    if (currency && control.classList && kind === 'input') {
      control.classList.add('control-split');
      const amount = element('span', 'part');
      while (control.firstChild) amount.append(control.firstChild);
      const currencyPath = [...path.slice(0, -1), currency.name];
      const currencySchema = context.resolve(currency.schema);
      const values = currencySchema.enum;
      let currencyControl;
      if (values) {
        // The currency starts from the spec's default or example instead of "Choose a value…".
        if (context.get(currencyPath) === undefined) {
          const preset = currencySchema.default ?? context.exampleAt?.(currencyPath);
          if (values.includes(preset)) context.setQuietly(currencyPath, preset);
        }
        // A joined segment of the amount: the same select and listbox as any other enum.
        const descriptions = enumDescriptions(currencySchema, context.resolve);
        currencyControl = selectControl({
          id: `${id}-currency`, segment: true, label: title(currency.name), required: currency.required, optional: !currency.required,
          options: values.map(code => ({ value: code, label: String(code), description: descriptions[code] })), value: context.get(currencyPath),
          sheet: { title: esc(title(currency.name)), sub: currencySchema.description ? inline(currencySchema.description) : '' },
          onChange: code => context.set(currencyPath, code),
        });
      } else {
        currencyControl = element('span', 'part');
        const input = element('input');
        input.id = `${id}-currency`;
        input.value = context.get(currencyPath) ?? '';
        input.setAttribute('aria-label', title(currency.name));
        input.addEventListener('input', () => context.set(currencyPath, input.value || undefined));
        currencyControl.append(input);
      }
      currencyControl.dataset.schemaPath = JSON.stringify(currencyPath);
      control.append(amount, currencyControl);
    }
    const slot = control.querySelector?.('.slot');
    if (slot && generatable(schema, type)) addWand(context, control, slot, schema, path, fieldLabel);
    else if (['radio', 'select', 'lookup'].includes(kind)) addChoiceGenerator(context, control, schema, path);
    field.append(control);
  }
  if (!flattened) addAssistance(field, schema, type, id, context, path, required);
  return field;
}

/**
 * ⌥G on a select, radio group or lookup: a random documented value (or a real record), with the
 * same "Generated: … Undo" status line as the wand. ⌥⇧G opens the list to pick one.
 */
function addChoiceGenerator(context, control, schema, path) {
  control.dataset.generate = '';
  control.generateNow = async () => {
    if (schema['x-lookup']) {
      const { getLookupOptions } = await import('./lookup-source.js');
      try {
        const options = await getLookupOptions(context, schema['x-lookup']);
        const choices = options.filter(option => !Object.is(option.value, context.get(path)));
        const pick = choices[Math.floor(Math.random() * choices.length)];
        if (pick) context.generate(path, pick.value, context.actor ? t('gen.realRecordAs', { name: context.actor }) : t('gen.realRecord'));
      } catch { /* The lookup's own error state explains the failure when it opens. */ }
      return;
    }
    const values = (schema.enum || [true, false]).filter(value => value !== null && !Object.is(value, context.get(path)));
    if (values.length) context.generate(path, values[Math.floor(Math.random() * values.length)], t('gen.enumPick'));
  };
}

const generatable = (schema, type) => !schema['x-lookup'] && !schema.enum && ['string', 'number', 'integer'].includes(type) && schema.format !== 'binary' && schema.format !== 'password';

/** The Generate button in a control's status slot (mock 31): click opens the menu, ⌥G fills. */
function addWand(context, control, slot, schema, path, label) {
  const key = JSON.stringify(path);
  const generated = context.autofilled.get?.(key);
  const wand = element('button', `slot wand${generated ? ' gen' : ''}`);
  wand.type = 'button';
  wand.setAttribute('aria-label', t('field.generate', { name: label }));
  wand.setAttribute('aria-haspopup', 'menu');
  wand.setAttribute('aria-expanded', 'false');
  wand.setAttribute('aria-keyshortcuts', shortcutAria('generate', 'generate-menu'));
  wand.dataset.shortcut = 'generate generate-menu';
  wand.title = t('field.generateTip');
  wand.append(svg('wand'));
  slot.hidden = true;
  slot.after(wand);
  if (generated) control.classList.add('is-generated');
  const apply = (option, source) => {
    if (option.text !== undefined) {
      const input = control.querySelector('input');
      input.value = option.text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      context.markGenerated(path, source);
      context.render(key);
    } else context.generate(path, option.value, source);
  };
  wand.addEventListener('click', () => openGenerateMenu(wand, {
    schema, label, current: context.get(path),
    apply: option => apply(option, option.sub || t('gen.chosen')),
  }));
  wand.generateNow = () => {
    const option = randomValid(schema, context.get(path));
    if (option) apply({ value: option.value }, option.source);
  };
}

/** A hint for every field, so the reserved assist line is never visually empty (mock 07). */
function typeHint(schema, type) {
  if (schema.format === 'date') return t('hint.date');
  if (schema.format === 'date-time') return t('hint.dateTime');
  if (schema.format === 'email') return t('hint.email');
  if (schema.format === 'uuid') return t('hint.uuid');
  if (schema.format === 'uri' || schema.format === 'url') return t('hint.url');
  if (type === 'integer') return schema.minimum !== undefined ? t('hint.integerMin', { min: schema.minimum }) : t('hint.integer');
  if (type === 'number') return schema.minimum !== undefined ? t('hint.numberMin', { min: displayNumber(schema.minimum, schema) }) : t('hint.number');
  if (type === 'boolean') return t('hint.boolean');
  if (type === 'array') return schema.maxItems !== undefined ? t('hint.arrayMax', { n: schema.maxItems }) : t('hint.array');
  if (schema.enum) return t('hint.enum');
  if (schema.maxLength !== undefined) return t('hint.maxLength', { n: schema.maxLength });
  if (type === 'json') return t('hint.json');
  return t('hint.text');
}

/** Days from today to an ISO date, for "In 3 days". */
function daysFromToday(iso) {
  const today = new Date();
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.parse(iso + 'T00:00:00Z') - start) / 864e5);
}

/** How a value is sent, for the status line: status=Open in a query, "Normal" in a JSON body. */
function sentForm(context, value) {
  const parameter = context.parameter;
  if (parameter?.in === 'query' || parameter?.in === 'cookie') return `${parameter.name}=${value}`;
  if (parameter) return String(value);
  return JSON.stringify(value);
}

/**
 * The status line's resting text (HTML): what will be sent, the constraints, or a type hint.
 * Errors and "Generated" replace it; schema.js puts it back.
 */
function statusHtml(field, schema, type, context, path, required) {
  const value = context.get(path);
  const kind = field.dataset.kind;
  const optionalQuery = !required && context.parameter && context.parameter.in !== 'path';
  if (kind === 'lookup') return field.querySelector('.control.lk')?.lookupStatus?.() ?? '';
  if (kind === 'radio' || kind === 'select') {
    if (value !== undefined) return required ? '' : th('field.sends', { value: `<code>${esc(sentForm(context, value))}</code>`, n: 0 });
    return required ? esc(t('hint.enum')) : esc(t('field.notSent'));
  }
  const parts = [];
  if (type === 'number' || type === 'integer') {
    const show = number => displayNumber(number, schema);
    if (schema.minimum !== undefined && schema.maximum !== undefined && Math.abs(schema.maximum) < 1e15) parts.push(esc(t('field.between', { min: show(schema.minimum), max: show(schema.maximum) })));
    else if (schema.minimum !== undefined) parts.push(esc(t('field.atLeast', { min: show(schema.minimum) })));
    else if (schema.maximum !== undefined && Math.abs(schema.maximum) < 1e15) parts.push(esc(t('field.atMost', { max: show(schema.maximum) })));
    if (schema.default !== undefined) parts.push(th('field.defaultIs', { value: `<code>${esc(show(schema.default))}</code>` }));
  } else if (type === 'string' && schema.maxLength != null && !schema.format) parts.push(esc(t('field.upTo', { n: schema.maxLength })));
  if (schema.format === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const relative = formatRelativeDays(daysFromToday(value));
    parts.push(esc(relative.charAt(0).toUpperCase() + relative.slice(1)));
  }
  if (!parts.length && optionalQuery && value === undefined) parts.push(esc(t('field.notSent')));
  return parts.length ? parts.join(' · ') : esc(typeHint(schema, type));
}

function addAssistance(field, schema, type, id, context, path, required) {
  const value = context.get(path);
  const key = JSON.stringify(path);
  const input = field.querySelector(`[id="${id}"]`);
  // The description has its own line, from the spec; it always exists so subgrid rows line up.
  const description = element('p', 'f-desc');
  description.id = `${id}-desc`;
  if (schema.description) {
    description.lang = 'en';
    description.innerHTML = inline(String(schema.description).replace(/\s*\n\s*/g, ' '));
  }
  field.append(description);
  const assist = element('div', 'assist');
  assist.id = `${id}-assist`;
  const status = element('span', 'assist-icon');
  status.hidden = true;
  status.append(svg('alert'));
  const msg = element('span', 'msg');
  const hint = element('span', 'field-hint');
  hint.innerHTML = statusHtml(field, schema, type, context, path, required);
  hint.dataset.base = hint.innerHTML;
  const error = element('span', 'field-error');
  error.hidden = true;
  msg.append(hint, error);
  assist.append(status, msg);
  // Generated values say where they came from, with Undo (mock 32).
  const generated = context.autofilled.get?.(key);
  if (generated) {
    assist.classList.add('is-generated');
    status.replaceChildren(svg('wand'));
    status.hidden = false;
    status.dataset.generated = '';
    hint.textContent = t('field.generated', { source: generated });
    if (context.canUndo(path)) {
      const undo = element('button', 'undo', t('field.undo'));
      undo.type = 'button';
      undo.title = t('field.undoTip');
      undo.addEventListener('click', () => context.undo(path));
      assist.append(undo);
    }
  }
  if (type === 'string' && schema.maxLength != null && input?.tagName === 'INPUT') {
    const count = element('span', 'count');
    const update = () => { count.textContent = `${formatNumber([...input.value].length)} / ${formatNumber(schema.maxLength)}`; };
    update();
    input.addEventListener('input', update);
    assist.append(count);
  } else if (type === 'array' && schema.maxItems != null) {
    assist.append(element('span', 'count', `${formatNumber(value?.length ?? 0)} / ${formatNumber(schema.maxItems)}`));
  }
  if (input) {
    input.setAttribute('aria-describedby', `${schema.description ? description.id + ' ' : ''}${assist.id}`);
    if (input.getAttribute('role') === 'group') input.setAttribute('aria-labelledby', `${id}-label`);
  }
  field.append(assist);
}
