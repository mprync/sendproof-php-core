// A model page (mocks/models.js), in the same two columns as Try it and Docs. The main column is
// the property tree (or a union with its discriminator and variants, or an enum's values); the
// right column lists the operations and models that use it, then an example or the raw JSON
// Schema. Where the user came from decides the breadcrumbs and the one Back control, not the
// sidebar tab.
import { dereference } from './api.js';
import { copyButton, esc, icon, method, tab } from './components.js';
import { contextBar } from './context-bar.js';
import { copyText } from './copy.js';
import { formatNumber, t } from './i18n.js';
import { bindJsonViews, hasCollapsed, jsonView, setAllFolded } from './json-view.js';
import { inline, markdown } from './markdown.js';
import {
  discriminatorOf, enumOf, isExpandable, modelExample, modelKind, modelSize, propertiesOf, refName, resolve, typeLabel, usedBy, variantsOf,
} from './schema-model.js';
import { bindTrees, hasNested, isAllOpen, newTreeState, propertyTree, setAllOpen } from './schema-tree.js';
import { opKey } from './operations.js';

/** What a model page remembers while the session lasts: the chosen variant, the tree state and the right column's view. */
const memory = new Map();
const remembered = (name, scope) => { if (!memory.has(name)) memory.set(name, { variant: null, tree: newTreeState(scope ? `${scope}#model/${name}` : undefined), aside: 'example' }); return memory.get(name); };

const where = row => [row.request ? t('used.request') : '', row.codes.length ? t('used.response', { code: row.codes.join(' · ') }) : ''].filter(Boolean).join(' · ');
const rowTitle = op => op.operation.deprecated ? ' style="text-decoration:line-through"' : '';

/** The kind chip: "object · 12 properties", "enum · 9 values", "one of 2 types". */
function kindLabel(schema, kind, document, size) {
  if (kind.id === 'object') return t('kind.objectN', { n: size });
  if (kind.id === 'enum') return t('kind.enumN', { n: size });
  if (kind.id === 'oneOf' || kind.id === 'anyOf') return t('kind.oneOfN', { n: size });
  return t('kind.' + kind.id);
}

/** An enum's page (mock 96): "Possible enum values", each with its description. */
function enumBody(schema, document) {
  const en = enumOf(schema, document) || { values: schema.enum || [], desc: {}, described: false };
  const list = en.described
    ? `<dl class="enum-dl is-page">${en.values.map(value => `<div><dt><code>${esc(value)}</code></dt>${en.desc[String(value)] ? `<dd lang="en">${inline(en.desc[String(value)])}</dd>` : `<dd class="is-quiet">${esc(t('schema.noDesc'))}</dd>`}</div>`).join('')}</dl>`
    : `<p class="attr-desc is-quiet">${esc(t('model.valuesUndescribed'))}</p><ul class="enum-inline is-page">${en.values.map(value => `<li><code>${esc(value)}</code></li>`).join('')}</ul>`;
  return `<h2>${esc(t('attr.enumValues'))} <span class="count">${formatNumber(en.values.length)} · ${esc(schema.type || 'string')}</span></h2>
    <div class="attr-enum is-page">${list}</div>`;
}

function unionBody(name, schema, document, mem) {
  const variants = variantsOf(schema, document);
  const discriminator = discriminatorOf(schema, document);
  const options = variants.map((variant, index) => ({ raw: variant, name: refName(variant) || resolve(variant, document).title || t('model.option', { n: index + 1 }) }));
  const chosen = options.find(option => option.name === mem.variant) || options[0];
  mem.variant = chosen.name;
  const { props, required } = propertiesOf(chosen.raw, document);
  const count = Object.keys(props).length;
  return {
    chosen,
    html: `${discriminator ? `<h2>${esc(t('model.discriminator'))} <span class="count">${esc(t('model.discBy'))} <code>${esc(discriminator.prop)}</code></span></h2>
      <div class="card disc-table">${discriminator.map.map(([value, target]) => `<div class="row"><code>${esc(discriminator.prop)} = "${esc(value)}"</code><span class="faint" aria-hidden="true">${icon('arrow-right', true)}</span><a class="type-link" href="#model/${encodeURIComponent(target)}" data-model="${esc(target)}">${esc(target)}</a><span class="faint" style="font-size:var(--fs-sm)">${esc(t('docs.props', { n: modelSize({ $ref: `#/components/schemas/${encodeURIComponent(target)}` }, document) }))}</span></div>`).join('')}</div>` : ''}
      <h2>${esc(t('model.variants'))} <span class="count">${esc(t('model.exactlyOne', { n: options.length }))}</span></h2>
      <div class="card">
        <div class="tabs" role="tablist" aria-label="${esc(t('schema.variant'))}" style="padding-inline:0.25rem">${options.map((option, index) => tab(option.name, { selected: option === chosen, count: modelSize(option.raw, document), id: `variant-tab-${index}`, controls: 'variant-panel', data: `data-variant-tab="${esc(option.name)}"`, lang: 'en' })).join('')}</div>
        <div id="variant-panel" role="tabpanel" aria-labelledby="variant-tab-${options.indexOf(chosen)}">
          <div class="card-head"><span>${esc(t('docs.props', { n: count }))} · ${esc(t('docs.requiredN', { n: required.size }))}</span><span class="end">${refName(chosen.raw) ? `<a class="btn btn-ghost btn-xs" href="#model/${encodeURIComponent(chosen.name)}" data-model="${esc(chosen.name)}">${esc(t('model.open', { name: chosen.name }))}${icon('arrow-right', true)}</a>` : ''}</span></div>
          <div data-tree-slot></div>
        </div>
      </div>`,
  };
}

/**
 * Renders a model page into the two reading panes.
 * @param {HTMLElement} main the `.doc-pane`
 * @param {HTMLElement} aside the `.aside-pane`
 * @param {{ state: object, route: object, samples: unknown[], bases?: object }} ctx
 */
export function renderModel(main, aside, ctx) {
  const { state, route, samples } = ctx;
  const name = route.name;
  const document = state.doc;
  const raw = { $ref: '#/components/schemas/' + encodeURIComponent(name) };
  const schema = dereference(raw, document) || {};
  const kind = modelKind(schema, document);
  const mem = remembered(name, state.documentUrl);
  const size = modelSize(schema, document);
  const from = state.modelFrom?.op;
  let body = '';
  let treeTarget = raw;
  let chosen;
  if (kind.id === 'oneOf' || kind.id === 'anyOf') {
    const union = unionBody(name, schema, document, mem);
    body = union.html;
    chosen = union.chosen;
    treeTarget = chosen.raw;
  } else if (kind.id === 'enum') body = enumBody(schema, document);
  else {
    const { props, required, sources } = propertiesOf(raw, document);
    const count = Object.keys(props).length;
    const label = typeLabel(raw, document);
    body = count || kind.id === 'object' ? `${sources.length ? `<p class="lede">${esc(t('model.includes'))} ${sources.map(source => `<a class="type-link" href="#model/${encodeURIComponent(source)}" data-model="${esc(source)}">${esc(source)}</a>`).join(', ')}</p>` : ''}
      <h2>${esc(t('model.propertiesTitle'))} <span class="count">${esc(t('docs.props', { n: count }))} · ${esc(t('docs.requiredN', { n: required.size }))}</span></h2>
      <div class="card flat">
        ${hasNested(raw, document) ? `<div class="card-head"><span>${esc(t('model.nested', { n: Object.values(props).filter(child => isExpandable(child, document)).length }))}</span>
          <span class="end"><button type="button" class="btn btn-ghost btn-xs" data-tree-all>${icon('chevrons-ud', true)}<span>${esc(t('tree.collapseAll'))}</span></button></span></div>` : ''}
        <div data-tree-slot></div>
      </div>` : `<p class="lede"><span class="type">${esc(label.text)}</span></p><div data-tree-slot hidden></div>`;
  }
  const description = schema.description;
  main.innerHTML = `${contextBar({ kind: 'model', route, from, document })}
    <div class="pane-scroll" id="doc-main"><div class="doc-inner">
      <h1 id="model-title" tabindex="-1" lang="en">${esc(name)}</h1>
      <div class="doc-meta"><span class="tag">${esc(kindLabel(schema, kind, document, size))}</span><span class="tag tag-mono">#/components/schemas/${esc(name)}</span>${copyButton(t('model.copyRef'), { action: 'copy-ref', size: 'btn-xs' })}</div>
      <div class="prose" lang="en">${description ? markdown(description) : `<p class="faint">${esc(t('schema.noDescModel'))}</p>`}</div>
      ${body}
    </div></div>
    <div class="pane-bar"><span class="bar-text">${icon('box', true)}<span>${esc(t('model.bar'))}</span></span>
      <button type="button" class="btn btn-ghost btn-sm" data-action="copy-schema">${icon('braces', true)}${esc(t('model.copySchema'))}</button></div>`;
  const slot = main.querySelector('[data-tree-slot]');
  if (slot && !slot.hidden) slot.innerHTML = propertyTree(treeTarget, document, { id: 'm', state: mem.tree, label: chosen?.name || name, highlight: route.highlight });
  bindTrees(main);
  // The list head says Collapse all while child lists are open, and Expand all once they're closed.
  const syncAll = () => { const tree = main.querySelector('.stree'); const label = main.querySelector('[data-tree-all] span'); if (tree && label) label.textContent = t(isAllOpen(tree) ? 'tree.collapseAll' : 'tree.expandAll'); };
  syncAll();
  if (!main.dataset.treeSync) { main.dataset.treeSync = ''; main.addEventListener('tree-change', () => syncAll()); }

  // ---- Right column ----
  const usage = usedBy(name, state.ops, document);
  const list = usage.operations.length ? usage.operations : usage.via;
  const exampleName = chosen && refName(chosen.raw) ? refName(chosen.raw) : name;
  const drawAside = () => {
    const example = modelExample(exampleName, document, samples);
    const schemaView = mem.aside === 'schema';
    const view = schemaView ? jsonView(schema, { label: t('model.jsonSchema') }) : jsonView(example.value, { label: t('docs.example') });
    const row = (op, place, extra = '') => `<a href="#docs/${encodeURIComponent(opKey(op))}" data-op-docs="${state.ops.indexOf(op)}" class="${from === op ? 'is-here' : ''}">${method(op.method)}<span class="label-text" lang="en"${rowTitle(op)}>${esc(op.title)}</span><span class="where">${esc(place)}</span></a>${extra}`;
    aside.innerHTML = `<div class="aside-head">${esc(t('model.usedBy'))} <span class="count">${esc(t('overview.operations', { n: list.length }))}</span></div>
      <div class="pane-scroll" id="aside-scroll"><div class="aside-inner">
        ${usage.operations.length ? `<div class="card used-list">${usage.operations.map(item => row(item.op, where(item))).join('')}</div>`
          : usage.via.length ? `<p class="aside-label">${esc(t('used.viaHead'))}</p><div class="card used-list">${usage.via.slice(0, 8).map(item => row(item.op, t('used.via', { name: item.model }))).join('')}</div>`
          : `<p class="faint" style="margin:0;font-size:var(--fs-md)">${esc(t('model.unused'))}</p>`}
        ${usage.models.length ? `<p class="aside-label">${esc(t('model.referencedBy'))}</p><div class="card used-list">${usage.models.slice(0, 6).map(other => `<a href="#model/${encodeURIComponent(other)}" data-model="${esc(other)}"><span class="model-ico" style="inline-size:2.125rem;block-size:1.25rem;display:grid;place-items:center;border-radius:var(--r-sm);font:600 0.65625rem/1 var(--mono);color:var(--text-2);background:var(--sunken);border:1px solid var(--line)">${esc(modelKind(document.components.schemas[other], document).glyph)}</span><span class="label-text" lang="en">${esc(other)}</span></a>`).join('')}</div>` : ''}
        <div class="sample-card card" data-viewer>
          <div class="viewer-bar"><div class="segmented" role="group" aria-label="${esc(t('model.show'))}"><button type="button" data-aside="example" aria-pressed="${!schemaView}">${esc(t('docs.example'))}</button><button type="button" data-aside="schema" aria-pressed="${schemaView}">${esc(t('model.jsonSchema'))}</button></div>
            <span class="spacer"></span><span class="lines">${esc(t('json.lines', { n: view.lines }))}</span>
            ${view.foldable ? `<button type="button" class="btn btn-ghost btn-xs" data-json-fold-all>${icon('chevrons-ud', true)}<span>${esc(t(view.large ? 'tree.expandAll' : 'tree.collapseAll'))}</span></button>` : ''}
            ${copyButton(t(schemaView ? 'model.copySchema' : 'model.copyExample'), { action: 'copy-viewer' })}</div>
          ${view.html}
        </div>
      </div></div>
      <div class="pane-bar"><span class="bar-text">${icon('info', true)}<span>${esc(schemaView ? t('model.schemaNote') : t(example.source === 'real' ? 'model.exampleReal' : example.source === 'spec' ? 'model.exampleSpecNote' : 'model.exampleNote'))}</span></span></div>`;
    bindJsonViews(aside);
    aside.dataset.copyText = schemaView ? JSON.stringify(schema, null, 2) : JSON.stringify(example.value, null, 2);
  };
  drawAside();

  main.onclick = event => {
    const variant = event.target.closest('[data-variant-tab]');
    if (variant) {
      mem.variant = variant.dataset.variantTab;
      renderModel(main, aside, ctx);
      main.querySelector(`[data-variant-tab="${CSS.escape(mem.variant)}"]`)?.focus();
      return;
    }
    const ref = event.target.closest('[data-action="copy-ref"]');
    if (ref) { event.stopPropagation(); copyText(`#/components/schemas/${name}`, { button: ref, what: '$ref' }); return; }
    const copySchema = event.target.closest('[data-action="copy-schema"]');
    if (copySchema) { event.stopPropagation(); copyText(JSON.stringify(schema, null, 2), { button: copySchema, what: t('model.jsonSchema') }); return; }
    const all = event.target.closest('[data-tree-all]');
    if (all) {
      const tree = main.querySelector('.stree');
      if (tree) { setAllOpen(tree, !isAllOpen(tree)); all.querySelector('span').textContent = t(isAllOpen(tree) ? 'tree.collapseAll' : 'tree.expandAll'); }
    }
  };
  aside.onclick = event => {
    const pick = event.target.closest('[data-aside]');
    if (pick) { mem.aside = pick.dataset.aside; drawAside(); aside.querySelector(`[data-aside="${pick.dataset.aside}"]`)?.focus(); return; }
    const fold = event.target.closest('[data-json-fold-all]');
    if (fold) {
      const element = aside.querySelector('[data-json-view]');
      setAllFolded(element, !hasCollapsed(element));
      fold.querySelector('span').textContent = t(hasCollapsed(element) ? 'tree.expandAll' : 'tree.collapseAll');
      return;
    }
    const copy = event.target.closest('[data-action="copy-viewer"]');
    if (copy) { event.stopPropagation(); copyText(aside.dataset.copyText, { button: copy, what: t(mem.aside === 'schema' ? 'model.jsonSchema' : 'copy.what.example'), select: aside.querySelector('.code-view'), notice: aside.querySelector('.sample-card') }); }
  };
}
