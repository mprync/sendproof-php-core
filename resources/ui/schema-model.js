// Reading components.schemas for people: what kind each schema is, how big, which operations
// use it, how its properties merge, and a representative example. Pure data, no markup: the
// property tree (schema-tree.js) and the model page build on it. Port of mocks/schema.js.
import { dereference } from './api.js';
import { formatNumber, t } from './i18n.js';

const PREFIX = '#/components/schemas/';

/** The model name of a `$ref` into components.schemas, or '' for anything else. */
export const refName = raw => raw?.$ref?.startsWith(PREFIX) ? decodeURIComponent(raw.$ref.slice(PREFIX.length)) : '';

/** Follows `$ref` chains to the target schema (cycle-safe). */
export function resolve(raw, document) {
  let current = raw;
  const seen = new Set();
  while (current?.$ref && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    current = dereference(current, document);
  }
  return current ?? {};
}

const typesOf = schema => Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
const isNull = schema => schema && (schema.type === 'null' || (Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === 'null'));
const omit = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

/** Splits "string | null" style schemas into the real schema and a nullable flag. */
export function unwrapNull(raw) {
  if (!raw) return { schema: {}, nullable: false };
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(raw[key]) && raw[key].some(isNull)) {
      const rest = raw[key].filter(option => !isNull(option));
      if (rest.length === 1) return { schema: { ...rest[0], ...omit(raw, [key]) }, nullable: true };
      return { schema: { ...raw, [key]: rest }, nullable: true };
    }
  }
  if (Array.isArray(raw.type) && raw.type.includes('null')) {
    const types = raw.type.filter(type => type !== 'null');
    return { schema: { ...raw, type: types.length === 1 ? types[0] : types }, nullable: true };
  }
  return { schema: raw, nullable: raw.nullable === true };
}

/**
 * An enum's values and what each means: x-enum-descriptions ({ value: text }), or a oneOf of
 * `const` schemas with descriptions. `values` is undefined when the schema isn't an enum.
 * Arrays of enums report their items' values.
 */
export function enumOf(raw, document) {
  const { schema } = unwrapNull(raw || {});
  const resolved = resolve(schema, document);
  const items = resolved.items ? resolve(resolved.items, document) : undefined;
  const own = resolved.enum ? resolved : items?.enum ? items : undefined;
  const consts = (resolved.oneOf || resolved.anyOf || []).map(option => resolve(option, document));
  if (!own && !(consts.length && consts.every(option => option && Object.hasOwn(option, 'const')))) return undefined;
  const values = own ? own.enum.filter(value => value !== null) : consts.map(option => option.const);
  const desc = own ? (own['x-enum-descriptions'] || own['x-enumDescriptions'] || schema['x-enum-descriptions'] || {})
    : Object.fromEntries(consts.filter(option => option.description).map(option => [String(option.const), option.description]));
  return { values, desc, described: values.some(value => desc[String(value)]) };
}

/** oneOf, anyOf, allOf, or the JSON type of a schema ('any' when nothing says). */
export function typeOf(raw, document) {
  const schema = resolve(raw, document);
  if (schema.oneOf) return 'oneOf';
  if (schema.anyOf) return 'anyOf';
  if (schema.allOf && !schema.properties) return 'allOf';
  const types = typesOf(schema).filter(type => type !== 'null');
  return types[0] || (schema.properties ? 'object' : schema.items ? 'array' : schema.enum ? 'string' : 'any');
}

/** Properties of an object with allOf parts merged: `{ props, required, sources }`. */
export function propertiesOf(raw, document, seen = new Set()) {
  const schema = resolve(typeof raw === 'string' ? { $ref: PREFIX + encodeURIComponent(raw) } : raw, document);
  let props = { ...(schema.properties || {}) };
  const required = new Set(schema.required || []);
  const sources = [];
  for (const part of schema.allOf || []) {
    if (part.$ref && seen.has(part.$ref)) continue;
    const merged = propertiesOf(part, document, new Set([...seen, part.$ref]));
    if (refName(part)) sources.push(refName(part));
    props = { ...merged.props, ...props };
    merged.required.forEach(name => required.add(name));
  }
  return { props, required, sources };
}

/** The non-null options of a oneOf or anyOf. */
export const variantsOf = (raw, document) => {
  const schema = resolve(raw, document);
  return (schema.oneOf || schema.anyOf || []).filter(option => !isNull(option));
};

/** The discriminator of a union: `{ prop, map: [[value, modelName], …] }`, or undefined. */
export function discriminatorOf(raw, document) {
  const schema = resolve(raw, document);
  if (!schema.discriminator) return undefined;
  const map = Object.entries(schema.discriminator.mapping || {}).map(([value, ref]) => [value, decodeURIComponent(String(ref).split('/').at(-1))]);
  if (!map.length) for (const option of variantsOf(schema, document)) if (refName(option)) map.push([refName(option), refName(option)]);
  return { prop: schema.discriminator.propertyName, map };
}

/** The schema's kind for lists and chips: enum, oneOf, anyOf, allOf, array, object or scalar. */
export function modelKind(raw, document) {
  const schema = resolve(raw, document);
  if (schema.enum) return { id: 'enum', glyph: 'enum' };
  if (schema.oneOf) return { id: 'oneOf', glyph: '1 of' };
  if (schema.anyOf) return { id: 'anyOf', glyph: 'any' };
  if (schema.allOf && !schema.properties) return { id: 'allOf', glyph: 'all' };
  if (typesOf(schema).includes('array')) return { id: 'array', glyph: '[ ]' };
  if (schema.properties || schema.allOf || typesOf(schema).includes('object')) return { id: 'object', glyph: '{ }' };
  return { id: 'scalar', glyph: typesOf(schema)[0] || 'any' };
}

/** Properties for objects, members for enums, variants for compositions. */
export function modelSize(raw, document) {
  const schema = resolve(raw, document);
  if (schema.enum) return schema.enum.length;
  const variants = variantsOf(schema, document);
  if (variants.length) return variants.length;
  return Object.keys(propertiesOf(schema, document).props).length;
}

/**
 * Models grouped by what they are, so a long list stays scannable: resources, request bodies,
 * list pages, enums and errors. Empty groups are left out. Each group is `[key, names]`.
 */
export function modelGroups(document) {
  const schemas = document?.components?.schemas || {};
  const names = Object.keys(schemas).sort((a, b) => a.localeCompare(b));
  const bucket = name => modelKind(schemas[name], document).id === 'enum' ? 'enums'
    : /^PagedListOf/.test(name) ? 'lists'
    : /Problem|Error/.test(name) ? 'errors'
    : /(Request|Input|Command)$/.test(name) ? 'requests' : 'resources';
  return ['resources', 'requests', 'lists', 'enums', 'errors'].map(key => [key, names.filter(name => bucket(name) === key)]).filter(([, list]) => list.length);
}

/** The group key of a model (see {@link modelGroups}). */
export const modelGroupOf = (name, document) => modelGroups(document).find(([, names]) => names.includes(name))?.[0] ?? 'resources';

/** Whether a schema has something to show underneath its row: properties, items or variants. */
export function isExpandable(raw, document) {
  const { schema } = unwrapNull(raw);
  const type = typeOf(schema, document);
  if (type === 'object') return Object.keys(propertiesOf(schema, document).props).length > 0;
  if (type === 'array') return isExpandable(resolve(schema, document).items || {}, document);
  return ['oneOf', 'anyOf', 'allOf'].includes(type);
}

/** The schema whose properties are a tree's top-level rows: an array's items, else the schema itself. */
export function rowSchema(raw, document) {
  const schema = resolve(raw, document);
  return typeOf(schema, document) === 'array' && schema.items ? schema.items : raw;
}

/** The label after a property name: `{ text, ref? }` where ref is the model a link should open. */
export function typeLabel(raw, document) {
  const { schema } = unwrapNull(raw);
  const name = refName(schema);
  if (name) return { text: name, ref: name };
  const resolved = resolve(schema, document);
  if (resolved.oneOf || resolved.anyOf) return { text: t('schema.oneOf', { n: variantsOf(resolved, document).length }) };
  if (resolved.allOf && !resolved.properties) {
    const base = resolved.allOf.map(refName).find(Boolean);
    return base ? { text: base, ref: base } : { text: 'object' };
  }
  const type = typeOf(resolved, document);
  if (type === 'array') {
    const inner = typeLabel(resolved.items || {}, document);
    return { text: inner.text + '[]', ref: inner.ref, array: true };
  }
  return { text: type === 'number' && resolved.format === 'decimal' ? 'decimal' : type };
}

/** The referenced model name of a schema, or "Name[]" for arrays of a model. */
export function schemaName(raw, document) {
  const name = refName(raw);
  if (name) return name;
  const item = refName(resolve(raw, document).items);
  return item ? `${item}[]` : '';
}

/** Model names referenced anywhere under a schema node (it does not look inside the models). */
function refsIn(node, out = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return out;
  if (node.$ref) { if (refName(node)) out.add(refName(node)); return out; }
  for (const value of Object.values(node)) if (value && typeof value === 'object') refsIn(value, out, depth + 1);
  return out;
}

/** Schemas this one references directly, for the References card. */
export const references = (raw, document) => [...refsIn(resolve(raw, document))];

const bodySchema = (operation, document) => Object.values(resolve(operation.requestBody, document).content || {}).map(media => media.schema).filter(Boolean);
const responseSchemas = (operation, document) => Object.entries(operation.responses || {}).map(([code, raw]) => [code, Object.values(resolve(raw, document).content || {})[0]?.schema]).filter(([, schema]) => schema);

/**
 * Where operations use a model. `operations` are the direct users, each with the places it
 * appears: `{ op, request, codes }`. When nothing uses the model directly, `via` lists the
 * operations of the models that contain it (`{ op, request, codes, model }`, the model being the
 * one the operation uses), so the page still answers "where does this appear?". `models` are the
 * schemas that reference it ("Referenced by").
 */
export function usedBy(name, ops, document) {
  const schemas = document?.components?.schemas || {};
  const direct = target => {
    const rows = [];
    for (const op of ops) {
      const request = bodySchema(op.operation, document).some(schema => refsIn(schema).has(target));
      const codes = responseSchemas(op.operation, document).filter(([, schema]) => refsIn(schema).has(target)).map(([code]) => code);
      if (request || codes.length) rows.push({ op, request, codes });
    }
    return rows;
  };
  const containers = target => Object.keys(schemas).filter(other => other !== target && refsIn(schemas[other]).has(target));
  const operations = direct(name);
  const models = containers(name);
  const via = [];
  if (!operations.length) {
    // Breadth first through the models that contain this one, so the nearest container wins.
    const seen = new Set([name]);
    let level = models;
    for (let depth = 0; depth < 4 && level.length; depth++) {
      const next = [];
      for (const model of level) {
        if (seen.has(model)) continue;
        seen.add(model);
        for (const row of direct(model)) if (!via.some(item => item.op === row.op)) via.push({ ...row, model });
        next.push(...containers(model));
      }
      level = next;
    }
  }
  return { operations, via, models };
}

const hintCache = new WeakMap();
/**
 * Property values from every example in the document, by property name. A generated example
 * reuses them, so a Payment example shows the amount and IDs the API author already wrote.
 */
function exampleHints(document) {
  if (!document || typeof document !== 'object') return new Map();
  if (hintCache.has(document)) return hintCache.get(document);
  const hints = new Map();
  const collect = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value)) if (!hints.has(key) && item !== null) hints.set(key, item);
  };
  for (const schema of Object.values(document.components?.schemas || {})) {
    collect(schema?.example);
    (Array.isArray(schema?.examples) ? schema.examples : []).forEach(collect);
  }
  hintCache.set(document, hints);
  return hints;
}

/** A representative example: the schema's own example, else one generated from its shape. */
export function exampleFor(raw, document, depth = 0, seen = new Set(), name) {
  const schema = resolve(unwrapNull(raw).schema, document);
  const hint = name !== undefined ? exampleHints(document).get(name) : undefined;
  if (hint !== undefined && schema.example === undefined && !schema.properties) return hint;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if ((raw?.$ref && seen.has(raw.$ref)) || depth > 5) return {};
  const nextSeen = raw?.$ref ? new Set([...seen, raw.$ref]) : seen;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const variants = variantsOf(schema, document);
  if (variants.length) return exampleFor(variants[0], document, depth + 1, nextSeen);
  const types = typesOf(schema).filter(type => type !== 'null');
  if (schema.properties || schema.allOf || types.includes('object')) {
    const { props } = propertiesOf(schema, document);
    return Object.fromEntries(Object.entries(props).filter(([, child]) => !resolve(child, document).writeOnly)
      .map(([key, child]) => [key, exampleFor(child, document, depth + 1, nextSeen, key)]));
  }
  if (types.includes('array')) return [exampleFor(schema.items, document, depth + 1, nextSeen)];
  if (schema.format === 'date-time') return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (types.includes('integer') || types.includes('number')) return schema.minimum ?? 0;
  if (types.includes('boolean')) return true;
  return { uuid: '00000000-0000-4000-8000-000000000000', date: '2026-01-01', 'date-time': '2026-01-01T00:00:00Z', email: 'name@example.test', uri: 'https://example.test' }[schema.format] ?? 'string';
}

/**
 * A real captured value that fits a schema: the first object, anywhere in `samples`, that has
 * every required property (or any property when none is required) and nothing the schema
 * doesn't declare. Returns undefined when nothing fits, so callers fall back to the
 * schema's example or a generated one.
 */
export function findSample(raw, document, samples) {
  const keys = Object.keys(propertiesOf(raw, document).props);
  if (!keys.length) return undefined;
  const queue = [...(samples || [])];
  for (let seen = 0; queue.length && seen < 2000; seen++) {
    const value = queue.shift();
    if (fitsSchema(value, raw, document)) return value;
    if (value && typeof value === 'object') queue.push(...Object.values(value));
  }
  return undefined;
}

/**
 * Whether a captured value has the shape of an object schema: its required keys, no keys the
 * schema doesn't declare, and (one level down) the first item of each array of objects fits the
 * item schema too, so a page of payments never passes for a page of accounts.
 */
function fitsSchema(value, raw, document, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { props, required } = propertiesOf(raw, document);
  const keys = Object.keys(props);
  if (!keys.length) return true;
  const need = required.size ? [...required] : keys;
  if (!need.every(key => key in value) || !Object.keys(value).every(key => keys.includes(key))) return false;
  if (depth > 1) return true;
  return Object.entries(props).every(([key, child]) => {
    const schema = resolve(unwrapNull(child).schema, document);
    if (typeOf(schema, document) !== 'array' || !Array.isArray(value[key]) || !value[key].length) return true;
    const item = resolve(schema.items || {}, document);
    return typeOf(item, document) !== 'object' || !Object.keys(propertiesOf(schema.items, document).props).length || fitsSchema(value[key][0], schema.items, document, depth + 1);
  });
}

export function modelExample(name, document, samples = []) {
  const raw = { $ref: PREFIX + encodeURIComponent(name) };
  const schema = resolve(raw, document);
  const kind = modelKind(schema, document).id;
  if (kind === 'enum') return { value: schema.enum?.[0], source: schema.example !== undefined ? 'spec' : 'generated' };
  const real = kind === 'object' ? findSample(raw, document, samples) : undefined;
  if (real) return { value: real, source: 'real' };
  const own = schema.example ?? (Array.isArray(schema.examples) ? schema.examples[0] : undefined);
  if (own !== undefined) return { value: own, source: 'spec' };
  return { value: exampleFor(raw, document), source: 'generated' };
}

export const countLabel = (n, key) => t(key, { n: formatNumber(n) });
