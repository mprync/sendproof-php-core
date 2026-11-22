// The attribute list used by model pages, Docs (parameters, request bodies, responses) and the
// response Schema view: Stripe's reading style on our tokens (mocks 91–99, 102, 103, m21).
//
//   name  type  Required|Optional  [path|query|header|cookie] [Deprecated]
//   The description, flush with the name, at a readable measure.
//   Format uuid   Max length 42   Pattern ^…$   Default 25        (quiet text, tinted values)
//   Possible enum values: each with its description, or a compact list of code chips
//   [Show child attributes] → a bordered, inset child list headed "Hide child attributes"
//
// Rows are flat on hairlines; leaf rows have no toggle column and no indent. Child lists start
// open three levels deep (deeper with Expand all); what the user closes is remembered per API
// and list in local storage. $ref types are links to the model page; $ref cycles stop at
// "recursive". A oneOf child list starts with "Chosen by `scheme`" and a tab per variant. In
// compact mode (the response Schema view) rows keep only their head line, with a presence mark
// at the line end and the schema check's reason on the rows that failed it.
import { esc, icon, tab } from './components.js';
import { t } from './i18n.js';
import { inline } from './markdown.js';
import {
  discriminatorOf, enumOf, isExpandable, propertiesOf, refName, resolve, rowSchema, typeLabel, typeOf, unwrapNull, variantsOf,
} from './schema-model.js';

const OPEN_DEPTH = 3;
const MAX_DEPTH = 8;
const ENUM_SHOWN = 6;
const STORAGE_KEY = 'sendproof-attrs';
const trees = new Map();
const bound = new WeakSet();
let treeCounter = 0;

/**
 * The state a list keeps while the user opens and closes child lists. `mode` is 'default'
 * (open three levels deep), 'all' (Expand all) or 'none' (Collapse all). Callers keep it across
 * renders; `persist` names it in local storage so closed child lists stay closed after a reload.
 */
export function newTreeState(persist) {
  const state = { expanded: new Set(), collapsed: new Set(), mode: 'default', variant: {}, allValues: new Set(), persist };
  if (persist) {
    const saved = readStore()[persist];
    if (saved) { state.collapsed = new Set(saved.collapsed || []); state.mode = saved.mode === 'none' || saved.mode === 'all' ? saved.mode : 'default'; }
  }
  return state;
}

function readStore() {
  try { return JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '{}') || {}; } catch { return {}; }
}
function save(state) {
  if (!state.persist) return;
  const store = readStore();
  if (!state.collapsed.size && state.mode === 'default') delete store[state.persist];
  else store[state.persist] = { collapsed: [...state.collapsed], mode: state.mode };
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* Private mode can refuse storage. */ }
}

/** The colour family of a type, for its quiet tint: string, number, boolean, object or enum. */
function family(schema, document) {
  if (enumOf(schema, document)) return 'enum';
  const type = typeOf(schema, document);
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'string') return 'string';
  return 'object';
}

/** The type after a name: "string", "nullable string", "array of AccountReference" (a link). */
function typeText(schema, nullable, document) {
  const label = typeLabel(schema, document);
  const resolved = resolve(schema, document);
  const link = name => `<a class="attr-type is-ref" href="#model/${encodeURIComponent(name)}" data-model="${esc(name)}" title="${esc(t('schema.openModel', { name }))}">${esc(name)}</a>`;
  const plain = (text, kind) => `<span class="attr-type t-${kind}">${esc(text)}</span>`;
  let html;
  if (label.array) {
    const inner = resolve(resolved.items || {}, document);
    html = `<span class="attr-type">${esc(t('attr.arrayOf'))}</span> ${label.ref ? link(label.ref) : plain(label.text.replace(/\[\]$/, ''), family(inner, document))}`;
  } else if (label.ref) html = link(label.ref);
  else if (resolved.oneOf || resolved.anyOf) html = plain(t('attr.oneOfN', { n: variantsOf(resolved, document).length }), 'object');
  else html = plain(label.text === 'string' && enumOf(schema, document) ? 'enum' : label.text, family(schema, document));
  return nullable ? `<span class="attr-type">${esc(t('attr.nullable'))}</span> ${html}` : html;
}

/** Constraints as quiet inline text: "Format uuid   Max length 42   Pattern ^…$". */
function facts(raw, extra = []) {
  const schema = { ...resolve(raw), ...Object.fromEntries(Object.entries(raw || {}).filter(([key]) => key !== '$ref')) };
  const out = [...extra];
  const fact = (key, value) => out.push(value === undefined ? `<span>${esc(key)}</span>` : `<span>${esc(key)} <code>${esc(value)}</code></span>`);
  const type = typeOf(schema);
  if (schema.format && type !== 'array' && schema.format !== 'decimal') fact(t('attr.f.format'), schema.format);
  // Platform limits such as .NET decimal's maximum say nothing useful, so they're left out.
  const max = schema.maximum !== undefined && Math.abs(schema.maximum) < 1e15 ? schema.maximum : undefined;
  if (schema.minimum !== undefined && max !== undefined) fact(t('attr.f.range'), `${schema.minimum}–${max}`);
  else if (schema.minimum !== undefined) fact(t('attr.f.min'), schema.minimum);
  else if (max !== undefined) fact(t('attr.f.max'), max);
  if (typeof schema.exclusiveMinimum === 'number') fact(t('attr.f.gt'), schema.exclusiveMinimum);
  if (typeof schema.exclusiveMaximum === 'number') fact(t('attr.f.lt'), schema.exclusiveMaximum);
  if (schema.multipleOf !== undefined) fact(t('attr.f.step'), schema.multipleOf);
  if (schema.minLength !== undefined && schema.maxLength !== undefined) fact(t('attr.f.length'), schema.minLength === schema.maxLength ? schema.minLength : `${schema.minLength}–${schema.maxLength}`);
  else if (schema.maxLength !== undefined) fact(t('attr.f.maxLength'), schema.maxLength);
  else if (schema.minLength !== undefined) fact(t('attr.f.minLength'), schema.minLength);
  if (schema.pattern) out.push(`<span>${esc(t('attr.f.pattern'))} <code class="pat">${esc(schema.pattern)}</code></span>`);
  if (schema.minItems !== undefined || schema.maxItems !== undefined) fact(t('attr.f.items'), schema.minItems !== undefined && schema.maxItems !== undefined ? `${schema.minItems}–${schema.maxItems}` : schema.maxItems !== undefined ? `≤ ${schema.maxItems}` : `≥ ${schema.minItems}`);
  if (schema.uniqueItems) fact(t('attr.f.unique'));
  if (schema.default !== undefined) fact(t('attr.f.default'), typeof schema.default === 'string' ? schema.default : JSON.stringify(schema.default));
  if (schema.readOnly) fact(t('attr.f.readOnly'));
  if (schema.writeOnly) fact(t('attr.f.writeOnly'));
  return out;
}

/** "Possible enum values": described values as a list, others as compact code chips. */
function enumBlock(en, ctx, path) {
  const all = ctx.state.allValues.has(path);
  const long = en.values.length > ENUM_SHOWN + 1;
  const shown = long && !all ? en.values.slice(0, ENUM_SHOWN - 1) : en.values;
  const more = en.values.length - shown.length;
  const list = en.described
    ? `<dl class="enum-dl">${shown.map(value => `<div><dt><code>${esc(value)}</code></dt>${en.desc[String(value)] ? `<dd lang="en">${inline(en.desc[String(value)])}</dd>` : '<dd></dd>'}</div>`).join('')}</dl>`
    : `<ul class="enum-inline">${shown.map(value => `<li><code>${esc(value)}</code></li>`).join('')}</ul>`;
  const toggle = more ? `<button type="button" class="link-btn" data-attr-values="${esc(path)}" aria-expanded="false">${esc(t('attr.moreValues', { n: more }))}</button>`
    : long && all ? `<button type="button" class="link-btn" data-attr-values="${esc(path)}" aria-expanded="true">${esc(t('attr.fewerValues'))}</button>` : '';
  return `<div class="attr-enum"><p class="attr-enum-h">${esc(t('attr.enumValues'))}</p>${list}${toggle}</div>`;
}

/** The presence mark at the end of a row in the Schema view. */
const mark = kind => `<span class="attr-mark is-${kind}" role="img" aria-label="${esc(t('attr.mark.' + kind))}"></span>`;

function isOpen(ctx, path, depth) {
  const { state } = ctx;
  if (state.collapsed.has(path)) return false;
  if (state.expanded.has(path)) return true;
  if (state.mode === 'none') return false;
  return state.mode === 'all' || depth < OPEN_DEPTH;
}

/** One attribute row and, when open, its child list. `path` is the dotted path used for state. */
function attrRow(name, raw, required, ctx, depth, path, seen) {
  const { document, options } = ctx;
  const { schema, nullable } = unwrapNull(raw);
  const resolved = resolve(schema, document);
  const target = typeLabel(schema, document).ref;
  const recursive = !!target && seen.has(target);
  const canOpen = isExpandable(schema, document) && !recursive && depth < MAX_DEPTH;
  const open = canOpen && isOpen(ctx, path, depth);
  const description = raw.description || schema.description || (target ? undefined : resolved.description);
  const en = enumOf(schema, document);
  const extra = [];
  // A one-value enum is a constant (a discriminator inside its variant): say it once, as a fact.
  if (en?.values.length === 1 && !String(description || '').includes(String(en.values[0]))) extra.push(`<span>${esc(t('attr.always', { value: '\u0000' })).replace('\u0000', `<code>${esc(en.values[0])}</code>`)}</span>`);
  const example = (() => { const merged = { ...resolved, ...raw }; const value = merged.example ?? merged.examples?.[0]; return value !== undefined && typeof value !== 'object' ? value : undefined; })();
  const factList = options.compact ? [] : facts(schema, extra);
  if (!options.compact && example !== undefined && !en) factList.push(`<span>${esc(t('attr.f.example'))} <code>${esc(String(example).length > 48 ? String(example).slice(0, 47) + '…' : example)}</code></span>`);
  const id = `${ctx.id}-${path.replace(/[^\w]/g, '-')}`;
  const present = options.present ? options.present.has(path) : undefined;
  const issue = options.issues?.[path];
  const deprecated = raw.deprecated || resolved.deprecated;
  const where = options.locations?.[name];

  let kids = '';
  if (canOpen) {
    const toggle = `<button type="button" class="attr-toggle" data-attr-toggle="${esc(path)}" aria-expanded="${open}"${open ? ` aria-controls="${id}-kids"` : ''}>${icon(open ? 'minus' : 'plus', true)}<span>${esc(t(open ? 'attr.hideKids' : 'attr.showKids'))}</span></button>`;
    if (!open) kids = toggle;
    else {
      const next = new Set(seen);
      if (target) next.add(target);
      const array = typeOf(resolved, document) === 'array';
      const innerRaw = array ? resolved.items : schema;
      const inner = resolve(innerRaw, document);
      const childPath = array ? path + '[]' : path;
      const body = inner.oneOf || inner.anyOf ? variants(innerRaw, ctx, depth + 1, childPath, next) : attrs(innerRaw, ctx, depth + 1, childPath, next);
      kids = `<div class="attr-kids" id="${id}-kids">${toggle}${body}</div>`;
    }
  }
  const state = issue ? 'issue' : present === false ? 'off' : present ? 'on' : '';
  return `<li class="attr${state ? ' is-' + state : ''}${options.highlight === path ? ' is-hl' : ''}" id="${id}" data-path="${esc(path)}">
      <div class="attr-head">
        <code class="attr-name">${esc(name)}</code>${typeText(schema, nullable, document)}
        ${recursive ? `<span class="attr-note">${esc(t('schema.recursive'))}</span>` : ''}
        ${where ? `<span class="attr-in in-${esc(where)}" lang="en" title="in: ${esc(where)}">${esc(where)}</span>` : ''}
        <span class="attr-req${required ? ' is-req' : ''}">${esc(t(required ? 'attr.required' : 'attr.optional'))}</span>
        ${deprecated ? `<span class="attr-dep">${icon('warn', true)}${esc(t('attr.deprecated'))}</span>` : ''}
        ${present !== undefined || issue ? `<span class="spacer"></span>${mark(state || 'off')}` : ''}
      </div>
      ${issue ? `<p class="attr-issue">${icon('warn', true)}<span>${esc(issue)}</span></p>` : ''}
      ${options.compact ? '' : `${description ? `<p class="attr-desc" lang="en">${inline(String(description).replace(/\s*\n\s*/g, ' '))}</p>` : target ? '' : `<p class="attr-desc is-quiet">${esc(t('schema.noDesc'))}</p>`}
      ${factList.length ? `<p class="attr-facts">${factList.join('')}</p>` : ''}
      ${en && en.values.length > 1 ? enumBlock(en, ctx, path) : ''}`}
      ${kids}
    </li>`;
}

/** The rows of an object schema, plus (at the top of the Schema view) undocumented properties. */
function attrs(raw, ctx, depth, path, seen) {
  const { props, required } = propertiesOf(raw, ctx.document);
  const rows = Object.entries(props).map(([name, child]) => attrRow(name, child, required.has(name), ctx, depth, path ? `${path}.${name}` : name, seen));
  if (depth === 0 && ctx.options.extra?.length) {
    rows.push(...ctx.options.extra.map(item => `<li class="attr is-extra" data-path="${esc(item.name)}"><div class="attr-head"><code class="attr-name">${esc(item.name)}</code><span class="attr-type">${esc(Array.isArray(item.value) ? 'array' : item.value === null ? 'null' : typeof item.value)}</span><span class="attr-req is-undoc">${esc(t('attr.undocumented'))}</span><span class="spacer"></span>${mark('issue')}</div>${item.issue ? `<p class="attr-issue">${icon('warn', true)}<span>${esc(item.issue)}</span></p>` : ''}</li>`));
  }
  return `<ul class="attrs${ctx.options.compact ? ' is-compact' : ''}" role="list">${rows.join('')}</ul>`;
}

/** A oneOf inside a list: how the variant is chosen, a tab per variant, then its rows. */
function variants(raw, ctx, depth, path, seen) {
  const { document, state } = ctx;
  const list = variantsOf(raw, document);
  const discriminator = discriminatorOf(raw, document);
  const key = path || '';
  const chosen = state.variant[key] || refName(list[0]) || '0';
  const pick = list.find(variant => refName(variant) === chosen) || list[0];
  const chosenName = refName(pick) || chosen;
  return `<div class="attr-variants">
      <span class="k">${discriminator ? esc(t('attr.chosenBy', { prop: '\u0000' })).replace('\u0000', `<code>${esc(discriminator.prop)}</code>`) : esc(t('attr.exactlyOne'))}</span>
      <div class="tabs v-tabs" role="tablist" aria-label="${esc(t('schema.variant'))}">${list.map((variant, index) => {
        const name = refName(variant) || String(index);
        const value = discriminator?.map.find(([, target]) => target === name)?.[0];
        return tab(value || name, { selected: name === chosenName, data: `data-variant="${esc(name)}" data-variant-path="${esc(key)}"`, lang: 'en' });
      }).join('')}</div>
      ${refName(pick) ? `<a class="attr-type is-ref" href="#model/${encodeURIComponent(chosenName)}" data-model="${esc(chosenName)}">${esc(chosenName)}</a>` : ''}
    </div>${attrs(pick, ctx, depth, path, seen)}`;
}

function renderList(model) {
  const { raw, document, options } = model;
  const ctx = { document, state: model.state, options, id: model.prefix };
  const schema = resolve(raw, document);
  const seen = new Set([refName(raw)]);
  if (schema.oneOf || schema.anyOf) return `<div class="attr-top">${variants(raw, ctx, 0, '', seen)}</div>`;
  if (typeOf(schema, document) === 'array') return attrs(schema.items, ctx, 0, '[]', new Set([refName(schema.items)]));
  return attrs(raw, ctx, 0, '', seen);
}

/**
 * The attribute list of a schema (a `$ref`, an inline object, an array of objects or a union).
 * Options: `id` (unique prefix for DOM ids), `state` (a {@link newTreeState} the caller keeps),
 * `compact` (head lines only), `present` (a Set of paths a response returned), `issues`
 * ({ path: reason }), `extra` ([{ name, value, issue }] returned but undocumented),
 * `highlight` (a path), `label` (accessible name), `locations` ({ name: 'query' | … }).
 * Call {@link bindTrees} on the container once the markup is in the document.
 */
export function propertyTree(raw, document, options = {}) {
  const id = options.id || `tree${++treeCounter}`;
  const model = { raw, document, options, state: options.state || newTreeState(), prefix: id };
  const key = `${id}:${++treeCounter}`;
  trees.set(key, model);
  const label = options.label || refName(raw) || t('model.schema');
  return `<div class="stree" role="region" aria-label="${esc(t('schema.treeLabel', { name: label }))}" data-tree="${esc(key)}">${renderList(model)}</div>`;
}

/** Parameters (path, query, header, cookie) in the same list, each with its location pill. */
export function parameterTree(parameters, document, options = {}) {
  const properties = Object.fromEntries(parameters.map(parameter => [parameter.name, {
    ...(parameter.schema || Object.values(parameter.content || {})[0]?.schema || {}),
    ...(parameter.description ? { description: parameter.description } : {}),
    ...(parameter.example !== undefined ? { example: parameter.example } : {}),
    ...(parameter.deprecated ? { deprecated: true } : {}),
  }]));
  const schema = { type: 'object', properties, required: parameters.filter(parameter => parameter.required).map(parameter => parameter.name) };
  const locations = Object.fromEntries(parameters.map(parameter => [parameter.name, parameter.in]));
  return propertyTree(schema, document, { ...options, locations, label: options.label || t('docs.parameters') });
}

/** Whether a list has any child list, for showing Collapse all. */
export function hasNested(raw, document) {
  const { props } = propertiesOf(rowSchema(raw, document), document);
  return Object.values(props).some(child => isExpandable(child, document));
}

/** Re-renders one list after its state changed and keeps the scroll position and focus. */
function redraw(tree, focus) {
  const model = tree.treeModel;
  if (!model) return;
  const scroller = tree.closest('.pane-scroll');
  const top = scroller?.scrollTop;
  tree.innerHTML = renderList(model);
  if (focus) tree.querySelector(focus)?.focus({ preventScroll: true });
  if (scroller && top !== undefined) scroller.scrollTop = top;
}

/** Opens (`all` true) or closes every child list. */
export function setAllOpen(tree, all) {
  const model = tree.treeModel;
  if (!model) return;
  model.state.expanded.clear();
  model.state.collapsed.clear();
  model.state.mode = all ? 'all' : 'none';
  save(model.state);
  redraw(tree);
}

/** Whether a list shows its child lists (so its head offers Collapse all). */
export const isAllOpen = tree => !!tree.treeModel && tree.treeModel.state.mode !== 'none' && !tree.treeModel.state.collapsed.size;

/**
 * Wires every list under a container: the child-list toggles, "Show N more values" and the
 * variant tabs. Safe to call again after the container's markup changes.
 */
export function bindTrees(container) {
  for (const tree of container.querySelectorAll('[data-tree]')) {
    const model = trees.get(tree.dataset.tree);
    if (!model) continue;
    trees.delete(tree.dataset.tree);
    tree.treeModel = model;
  }
  if (bound.has(container)) return;
  bound.add(container);
  container.addEventListener('click', event => {
    const tree = event.target.closest?.('.stree');
    const model = tree?.treeModel;
    if (!model || !container.contains(tree)) return;
    const toggle = event.target.closest('[data-attr-toggle]');
    if (toggle) {
      const path = toggle.dataset.attrToggle;
      const open = toggle.getAttribute('aria-expanded') === 'true';
      model.state.expanded.delete(path);
      model.state.collapsed.delete(path);
      (open ? model.state.collapsed : model.state.expanded).add(path);
      save(model.state);
      redraw(tree, `[data-attr-toggle="${CSS.escape(path)}"]`);
      tree.dispatchEvent(new CustomEvent('tree-change', { bubbles: true }));
      return;
    }
    const values = event.target.closest('[data-attr-values]');
    if (values) {
      const path = values.dataset.attrValues;
      if (model.state.allValues.has(path)) model.state.allValues.delete(path); else model.state.allValues.add(path);
      redraw(tree, `[data-attr-values="${CSS.escape(path)}"]`);
      return;
    }
    const pick = event.target.closest('[data-variant]');
    if (pick) {
      model.state.variant[pick.dataset.variantPath] = pick.dataset.variant;
      redraw(tree, `[data-variant="${CSS.escape(pick.dataset.variant)}"][data-variant-path="${CSS.escape(pick.dataset.variantPath)}"]`);
    }
  });
  // Variant tabs: one tab stop per tab list, arrows move between variants.
  container.addEventListener('keydown', event => {
    const current = event.target.closest?.('.v-tabs [role="tab"]');
    if (!current || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...current.parentElement.querySelectorAll('[role="tab"]')];
    const rtl = getComputedStyle(current).direction === 'rtl';
    const at = tabs.indexOf(current);
    const step = event.key === 'Home' ? -at : event.key === 'End' ? tabs.length - 1 - at : (event.key === 'ArrowRight') !== rtl ? 1 : -1;
    event.preventDefault();
    tabs[(at + step + tabs.length) % tabs.length].click();
  });
}
