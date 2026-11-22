import { renderField } from './fields/render.js';
import { validateSchema } from './fields/validate.js';
import { newUuid } from './uuid.js';
import { unwrapNull } from './schema-model.js';

// Schema-driven controls for OpenAPI request bodies and parameters.
const renderers = [];
let nextId = 0;

/**
 * Register a renderer for a schema. The predicate receives (schema, {path, name}).
 * The renderer receives {schema, path, name, value, setValue, document, id, required}
 * and returns a DOM node. Last registration wins; the returned function unregisters it.
 *
 * Built-in extensions: x-lookup accepts {url, valueField, labelField, detailField}
 * or {options: [{value, label, detail}]}. URL lookups are same-origin credentialed GETs
 * returning an array. x-currency-field names a sibling property paired with a number.
 */
export function registerFieldRenderer(predicate, render) {
  const entry = { predicate, render };
  renderers.unshift(entry);
  return () => {
    const index = renderers.indexOf(entry);
    if (index >= 0) renderers.splice(index, 1);
  };
}

/**
 * A `oneOf`/`anyOf` that offers `null` next to real options is how OpenAPI 3.1 writes "optional":
 * ASP.NET emits `oneOf: [{type: null}, {$ref}]` for a nullable body or property. That is one schema
 * that may also be null, not a choice between alternatives, so the null option is dropped (and
 * `nullable: true` set, which validation honours) and a single remaining option is merged in.
 * Without this the form showed a "Value · json" field and an "Option 1" select for the wrapper.
 */
function collapseNullOption(schema, document, seen) {
  for (const key of ['oneOf', 'anyOf']) {
    if (!Array.isArray(schema[key])) continue;
    const { schema: rest, nullable } = unwrapNull(schema);
    if (!nullable || rest === schema) continue;
    const merged = rest[key] ? rest : resolveSchema(rest, document, seen);
    return { ...merged, nullable: true };
  }
  return schema;
}

/** Resolve local JSON pointers; unresolved and recursive references remain usable as JSON. */
export function resolveSchema(schema, document = {}, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return {};
  if (schema.$ref) {
    const ref = schema.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) return { ...schema, 'x-unresolved': true };
    const target = ref.slice(2).split('/').reduce((node, part) => node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], document);
    if (!target) return { ...schema, 'x-unresolved': true };
    const siblings = { ...schema };
    delete siblings.$ref;
    return { ...resolveSchema(target, document, new Set([...seen, ref])), ...siblings };
  }
  if (Array.isArray(schema.allOf)) {
    const merged = { ...schema };
    delete merged.allOf;
    for (const part of schema.allOf) {
      const resolved = resolveSchema(part, document, seen);
      Object.assign(merged, resolved, {
        properties: { ...merged.properties, ...resolved.properties },
        required: [...new Set([...(merged.required || []), ...(resolved.required || [])])]
      });
    }
    return merged;
  }
  return collapseNullOption(schema, document, seen);
}

function kind(schema) {
  if (schema['x-unresolved'] || schema.oneOf || schema.anyOf) return 'json';
  const type = Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type;
  return type || (schema.properties ? 'object' : schema.items ? 'array' : 'json');
}

function sampleNumber(schema, integer) {
  const exclusiveMin = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : schema.exclusiveMinimum === true ? schema.minimum : undefined;
  const exclusiveMax = typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : schema.exclusiveMaximum === true ? schema.maximum : undefined;
  const min = exclusiveMin ?? schema.minimum ?? -Infinity;
  const max = exclusiveMax ?? schema.maximum ?? Infinity;
  if (integer) {
    const lower = exclusiveMin === undefined ? Math.ceil(min) : Math.floor(min) + 1;
    const upper = exclusiveMax === undefined ? Math.floor(max) : Math.ceil(max) - 1;
    return Math.max(lower, Math.min(0, upper));
  }
  const step = 0.01;
  let value = Math.max(min, Math.min(0, max));
  if (exclusiveMin !== undefined && value <= exclusiveMin) value = min + step;
  if (exclusiveMax !== undefined && value >= exclusiveMax) value = max - step;
  if (min < max && (value < min || value > max || (exclusiveMin !== undefined && value <= min) || (exclusiveMax !== undefined && value >= max))) {
    value = min + (max - min) / 2;
  }
  return value;
}

/** Build a sample from schema metadata, never from application-specific data. */
export function sampleValue(schema, document = {}, refs = new Set(), depth = 0) {
  if (depth > 12) return null;
  if (schema?.$ref) {
    if (refs.has(schema.$ref)) return null;
    refs = new Set([...refs, schema.$ref]);
  }
  schema = resolveSchema(schema, document);
  if (schema.example !== undefined) return structuredClone(schema.example);
  if (Array.isArray(schema.examples) && schema.examples.length) return structuredClone(schema.examples[0]);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (schema.enum?.length) return schema.enum[0];
  const variants = schema.oneOf || schema.anyOf;
  if (variants?.length) {
    const base = { ...schema };
    delete base.oneOf;
    delete base.anyOf;
    const merged = resolveSchema({ allOf: [base, variants[0]] }, document);
    const result = sampleValue(merged, document, refs, depth + 1);
    if (schema.discriminator?.propertyName && result && typeof result === 'object' && !Array.isArray(result)) {
      const property = schema.discriminator.propertyName;
      const mapped = Object.entries(schema.discriminator.mapping || {}).find(([, ref]) => ref === variants[0].$ref)?.[0];
      result[property] ??= mapped ?? variants[0].$ref?.split('/').at(-1);
    }
    return result;
  }
  switch (kind(schema)) {
    case 'object':
      return Object.fromEntries(Object.entries(schema.properties || {})
        .filter(([, property]) => !property.readOnly)
        .map(([name, property]) => [name, sampleValue(property, document, refs, depth + 1)]));
    case 'array':
      return Array.from({ length: Math.min(schema.minItems || 1, schema.maxItems ?? Infinity, 10) },
        () => sampleValue(schema.items || {}, document, refs, depth + 1));
    case 'integer': return sampleNumber(schema, true);
    case 'number': return sampleNumber(schema, false);
    case 'boolean': return false;
    case 'string':
      if (schema.format === 'date') return new Date().toISOString().slice(0, 10);
      if (schema.format === 'date-time') return new Date().toISOString();
      if (schema.format === 'uuid') return newUuid() || '00000000-0000-4000-8000-000000000000';
      if (schema.format === 'binary') return undefined; // Browsers require a user-selected file.
      {
        const examples = {
          email: 'person@example.com', uri: 'https://example.com/resource',
          url: 'https://example.com/resource', hostname: 'example.com',
          ipv4: '192.0.2.1', ipv6: '2001:db8::1', time: '12:00:00Z',
          duration: 'PT1H', password: 'Example123!', byte: 'ZXhhbXBsZQ==',
        };
        const example = examples[schema.format] ?? 'value';
        return example.padEnd(schema.minLength || 0, 'x').slice(0, schema.maxLength);
      }
    default: return null;
  }
}

// Files are immutable and must remain File instances when handed to FormData.
function copy(value) {
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  return value;
}

/** Validate a value without mounting controls, for raw JSON request bodies. */
export function validateSchemaValue({ schema, value, document = {}, required = false }) {
  let current = value;
  const context = {
    document,
    parseErrors: new Map(),
    variants: new Map(),
    resolve: raw => resolveSchema(raw, document),
    kind,
    get: path => path.reduce((item, key) => item?.[key], current)
  };
  return validateSchema(context, schema, current, required);
}

/** Mount a typed form. onChange receives JSON-compatible values and binary File values.
 * basePath is the application's URL path base (for example, /tenant), not /sendproof.
 * flattenRoot removes the decorative label for a structured object at the root.
 */
export function createSchemaForm({ container, schema, document: spec = {}, value, onChange = () => {},
  name = 'Value', required = false, basePath = '', flattenRoot = false,
  lookupCache = new Map(), operationPath, lastResponse, onLookupPreview, autofilled = new Map(),
  example, parameter, actor, signedIn = true, onSignIn,
}) {
  // Earlier callers passed a Set of filled paths; generated sources are labelled in a Map.
  if (!(autofilled instanceof Map)) autofilled = new Map([...autofilled].map(key => [key, '']));
  const previous = new Map();
  let current = copy(value);
  let errors = [];
  let formApi;
  let submitted = false;
  const touched = new Set();
  const parseErrors = new Map();
  const expanded = new Set();
  const variants = new Map();

  function get(path) {
    return path.reduce((value, key) => value != null && Object.hasOwn(value, key) ? value[key] : undefined, current);
  }
  /** A typed edit replaces a generated value: its "Generated" note and Undo go away. */
  function clearGenerated(key) {
    previous.delete(key);
    const field = [...container.querySelectorAll('[data-schema-path]')].find(node => node.dataset.schemaPath === key);
    if (!field) return;
    const assist = field.querySelector(':scope > .assist');
    const hint = assist?.querySelector('.field-hint');
    if (hint && hint.dataset.base !== undefined) hint.innerHTML = hint.dataset.base;
    const icon = assist?.querySelector('.assist-icon[data-generated]');
    if (icon) { icon.removeAttribute('data-generated'); icon.hidden = !assist.classList.contains('is-error'); }
    assist?.classList.remove('is-generated');
    assist?.querySelector('.undo')?.remove();
    field.querySelector('.control.is-generated')?.classList.remove('is-generated');
    field.querySelector('.slot.wand.gen')?.classList.remove('gen');
  }
  let generating = false;
  function set(path, value) {
    const key = JSON.stringify(path);
    if (autofilled.delete(key) && !generating) clearGenerated(key);
    if (!path.length) current = value;
    else {
      if (current === undefined || current === null || typeof current !== 'object') current = typeof path[0] === 'number' ? [] : {};
      let target = current;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== 'object')
          Object.defineProperty(target, key, { value: typeof path[i + 1] === 'number' ? [] : {}, enumerable: true, configurable: true, writable: true });
        target = target[key];
      }
      if (value === undefined && !Array.isArray(target)) delete target[path.at(-1)];
      else Object.defineProperty(target, path.at(-1), { value, enumerable: true, configurable: true, writable: true });
    }
    onChange(copy(current));
    formApi?.validate(path);
  }
  /** Sets a value without counting it as an edit, for defaults taken from the spec. */
  function setQuietly(path, value) {
    let target = current && typeof current === 'object' ? current : (current = {});
    for (const key of path.slice(0, -1)) target = target[key] ??= {};
    target[path.at(-1)] = value;
    onChange(copy(current));
  }
  const context = {
    document: spec,
    basePath,
    flattenRoot,
    expanded,
    variants,
    lookupCache,
    operationPath,
    lastResponse,
    onLookupPreview,
    autofilled,
    parseErrors,
    parameter,
    actor,
    signedIn,
    onSignIn,
    get,
    set,
    setQuietly,
    exampleAt: path => path.reduce((value, key) => value?.[key], example),
    /** Puts a generated value in a field, remembering the old value for Undo. */
    generate(path, value, source) {
      const key = JSON.stringify(path);
      if (!previous.has(key)) previous.set(key, get(path));
      generating = true;
      try { set(path, value); } finally { generating = false; }
      autofilled.set(key, source);
      render(key);
    },
    markGenerated(path, source) {
      const key = JSON.stringify(path);
      autofilled.set(key, source);
    },
    canUndo: path => previous.has(JSON.stringify(path)),
    undo(path) {
      const key = JSON.stringify(path);
      if (!previous.has(key)) return;
      const value = previous.get(key);
      previous.delete(key);
      parseErrors.delete(key);
      generating = true;
      try { set(path, value); } finally { generating = false; }
      render(key);
    },
    resolve: raw => resolveSchema(raw, spec),
    kind,
    sample: raw => sampleValue(raw, spec),
    validate: path => formApi?.validate(path),
    nextId: () => ++nextId,
    customRenderer: (resolved, path, label) =>
      renderers.find(entry => entry.predicate(resolved, { path, name: label }))?.render,
    render
  };

  function render(focusKey, removed = false) {
    container.replaceChildren(renderField(context, schema, [], name, required));
    if (submitted) formApi?.validate();
    if (focusKey) {
      const target = [...container.querySelectorAll(removed ? '[data-optional-path]' : '[data-schema-path]')]
        .find(node => (removed ? node.dataset.optionalPath : node.dataset.schemaPath) === focusKey);
      // Focus the field's own control, not the "i" button in its label row.
      (removed ? target : target?.querySelector('input, textarea, [role="combobox"], [role="radio"][tabindex="0"]') ?? target?.querySelector('.control button'))?.focus?.();
    }
  }
  function fieldControl(field) {
    const direct = [...(field.children || [])].find(child => child.classList?.contains?.('control'));
    if (direct) return direct;
    for (const child of field.children || []) {
      const nested = child.querySelector?.(':scope > .control');
      if (nested) return nested;
    }
    return null;
  }
  render();
  formApi = {
    getValue: () => copy(current),
    setValue(value) {
      current = copy(value);
      parseErrors.clear();
      variants.clear();
      render();
    },
    validate(changedPath) {
      if (changedPath) touched.add(JSON.stringify(changedPath));
      else submitted = true;
      errors = validateSchema(context, schema, current, required);
      for (const field of container.querySelectorAll('[data-schema-path]')) {
        if (!submitted && !touched.has(field.dataset.schemaPath)) continue;
        const path = JSON.parse(field.dataset.schemaPath).join('.');
        const error = errors.find(entry => entry.path === path);
        // Lookup controls wrap their actual .control one level deeper. Only
        // inspect direct descendants so an object field cannot clear a nested
        // field's invalid border while its own error state is being updated.
        const control = fieldControl(field);
        const candidate = field.querySelector('input,textarea,[role="combobox"],[role="radiogroup"],[role="group"]:not(.optional-props)');
        const input = candidate?.closest('[data-schema-path]') === field ? candidate : null;
        setFieldIssue(field, input, error?.message, control);
      }
      return { valid: errors.length === 0, errors: errors.map(({ path, message }) => ({ path, message })) };
    },
    hasParseErrors: () => [...parseErrors.values()].some(error => error.json),
    fillSample() {
      current = sampleValue(schema, spec);
      parseErrors.clear();
      variants.clear();
      render();
      onChange(copy(current));
      return copy(current);
    },
    destroy() { container.replaceChildren(); }
  };
  return formApi;
}

/** Reuse the field's reserved assistance and status slots for local or API errors. */
export function setFieldIssue(field, input, message, control) {
  const assist = field.querySelector(':scope > .assist');
  if (assist) {
    const invalid = !!message;
    const error = assist.querySelector('.field-error');
    const icon = assist.querySelector('.assist-icon');
    const hint = assist.querySelector('.field-hint');
    const generated = icon?.hasAttribute('data-generated');
    if (hint) hint.hidden = invalid;
    error.hidden = !invalid;
    if (icon) {
      icon.hidden = !invalid && !generated;
      icon.innerHTML = `<svg class="i i-sm" aria-hidden="true"><use href="#i-${invalid ? 'alert' : 'wand'}"/></svg>`;
    }
    error.textContent = message || '';
    error.title = message || '';
    assist.classList.toggle('is-error', invalid);
    assist.classList.toggle('is-generated', !invalid && generated);
    assist.querySelector('.undo')?.toggleAttribute('hidden', invalid);
    // The description stays in the accessible description; the status line follows it.
    const description = field.querySelector(':scope > .f-desc');
    input?.setAttribute('aria-describedby', `${description?.childNodes.length ? description.id + ' ' : ''}${assist.id}`);
  }
  if (input && message) input.setAttribute('aria-invalid', 'true');
  else input?.removeAttribute('aria-invalid');
  control ??= input?.closest('.control');
  control?.classList.toggle('is-invalid', !!message);
  // A radio group has no single control: its options take the danger border.
  field.querySelector(':scope > .rg')?.classList.toggle('is-invalid', !!message);
  // The status slot shows the error icon; the Generate button shares its place.
  const slot = control?.querySelector('.slot:not(.wand)');
  const wand = control?.querySelector('.slot.wand');
  if (slot) {
    slot.classList.toggle('err', !!message);
    slot.innerHTML = message ? '<svg class="i i-sm" aria-hidden="true"><use href="#i-alert"/></svg>' : '';
    slot.hidden = !message && !!wand;
  }
  if (wand) wand.hidden = !!message;
}
