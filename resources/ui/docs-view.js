// The Docs view of an operation (mocks/docs.js): summary, meta chips, deprecation, markdown
// description, every parameter, the request body, every documented response and the
// authentication requirement in the main column; the page outline and code samples in the right
// column. Try it and Docs fill the same three columns, so D swaps content, never layout.
import { dereference, encodeRequestBody } from './api.js';
import { copyButton, esc, icon, method, statusTone, tab } from './components.js';
import { copyText } from './copy.js';
import { t, th } from './i18n.js';
import { inline, linkOperationIds, markdown } from './markdown.js';
import { deprecationNotice } from './deprecation.js';
import { contextBar } from './context-bar.js';
import { bindJsonViews, jsonView } from './json-view.js';
import { exampleFor, modelExample, refName, resolve, rowSchema, schemaName, propertiesOf } from './schema-model.js';
import { bindTrees, hasNested, isAllOpen, newTreeState, parameterTree, propertyTree, setAllOpen } from './schema-tree.js';
import { isPublic, primarySchemes, requiredScopes, scopeText, securityRequirements } from './security.js';
import { formatRequest, snippetFormats } from './snippets.js';
import { shortcutAttrs, shortcutHint } from './shortcuts.js';
import { highlightSnippet } from './highlight.js';
import { bindCodePicker, codePicker, getCodeFormat, updateCodePicker } from './code-picker.js';
import { opKey } from './operations.js';

/** A soft callout when the operation takes an Idempotency-Key: it's safe to retry with the same key. */
function idempotencyCallout(op, document) {
  const parameter = op.parameters.map(raw => dereference(raw, document)).find(item => item?.in === 'header' && /^idempotency[-_]?key$/i.test(item.name || ''));
  if (!parameter) return '';
  return `<div class="callout info" role="note">${icon('repeat', true)}<div><strong>${esc(t('docs.idempotency'))}</strong> ${th('docs.idempotencyBody', { header: `<code>${esc(parameter.name)}</code>` })}</div></div>`;
}

const firstSentence = text => String(text ?? '').split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ').replace(/[*_`]/g, '').trim().replace(/^(.{0,180}?[.!?])\s.*$/, '$1');

/**
 * What the Docs page remembers about an operation while the session lasts, so coming Back from
 * a model page finds the same responses open and the same rows expanded.
 */
export function newDocsState() {
  return { openResponses: null, trees: new Map(), bodyView: 'schema', example: null };
}

/** A list's state, remembered for the session in `ui` and, for closed child lists, per API in local storage. */
const treeState = (ui, key, scope) => { if (!ui.trees.has(key)) ui.trees.set(key, newTreeState(scope ? `${scope}|${key}` : undefined)); return ui.trees.get(key); };

/** The server base URL shown in the bar: the document's first absolute server, else this origin. */
export function baseUrl(document) {
  const server = document?.servers?.[0]?.url;
  return /^https?:/.test(server || '') ? server.replace(/\/$/, '') : globalThis.location.origin;
}

/** A request built from the spec's examples, for the samples. Credentials stay placeholders. */
function sampleRequest(op, document, media, type, samples) {
  const parameters = op.parameters.map(raw => dereference(raw, document)).filter(Boolean);
  const path = op.path.replace(/\{([^}]+)\}/g, (match, name) => {
    const parameter = parameters.find(item => item.in === 'path' && item.name === name);
    const example = parameter?.example ?? exampleFor(parameter?.schema, document);
    return encodeURIComponent(typeof example === 'string' && example !== 'string' ? example : `{${name}}`);
  });
  const url = new URL(path.replace(/^\//, ''), location.origin + new URL('../', globalThis.document.baseURI).pathname);
  for (const parameter of parameters.filter(item => item.in === 'query' && item.required)) url.searchParams.set(parameter.name, String(parameter.example ?? exampleFor(parameter.schema, document)));
  const headers = {};
  for (const parameter of parameters.filter(item => item.in === 'header' && item.required)) headers[parameter.name] = parameter.name.toLowerCase() === 'idempotency-key' ? '$(uuidgen)' : String(parameter.example ?? exampleFor(parameter.schema, document));
  let body = null;
  if (media?.schema) {
    headers['Content-Type'] = type;
    body = encodeRequestBody(documentedExample(media, document, samples), type, headers);
  }
  return { method: op.method, url: url.href, headers, body };
}

/** The documented example of a media type: its own example, a named one, a real record, else generated. */
export function documentedExample(media, document, samples = []) {
  if (media.example !== undefined) return media.example;
  const named = Object.values(media.examples || {})[0]?.value;
  if (named !== undefined) return named;
  const name = refName(media.schema);
  return name ? modelExample(name, document, samples).value : exampleFor(media.schema, document);
}

/** Status codes take their class's hue (components.js statusTone). */
const statusClass = statusTone;

/** The deprecation text: an explicit extension, else the description's first paragraph after "Deprecated." */
function deprecation(operation) {
  const description = String(operation.description || '');
  const lead = /^\s*\**deprecated\.?\**\s*/i.exec(description);
  const rest = lead ? description.slice(lead[0].length) : description;
  const paragraphs = rest.trim().split(/\n\s*\n/).filter(Boolean);
  const explicit = operation['x-deprecation'] || operation['x-deprecated-message'];
  // The notice carries the first paragraph, so the prose below it doesn't repeat it.
  // The notice says "Deprecated" and what to use, so the prose keeps everything after the lead.
  return { notice: explicit || (lead ? paragraphs[0] || '' : ''), prose: lead ? rest.trim() : description };
}

function parameterGroups(op, document) {
  const parameters = op.parameters.map(raw => dereference(raw, document)).filter(parameter => parameter?.name);
  return [['path', 'docs.pathParams'], ['query', 'docs.queryParams'], ['header', 'docs.headers'], ['cookie', 'docs.cookies']]
    .map(([where, key]) => ({ where, key, items: parameters.filter(parameter => parameter.in === where) })).filter(group => group.items.length);
}

function treeHead(raw, document, { id, extra = '' }) {
  const { props, required } = propertiesOf(rowSchema(raw, document), document);
  const count = Object.keys(props).length;
  // Child lists start open, so the head offers Collapse all (syncTreeButtons keeps the label true).
  return `<div class="card-head"><span>${esc(t('docs.props', { n: count }))} · ${esc(t('docs.requiredN', { n: required.size }))}</span><span class="end">${extra}${hasNested(raw, document) ? `<button type="button" class="btn btn-ghost btn-xs" data-tree-all="${esc(id)}">${icon('chevrons-ud', true)}<span>${esc(t('tree.collapseAll'))}</span></button>` : ''}</span></div>`;
}

function authentication(op, document, ctx) {
  if (isPublic(op, document)) return `<p class="lede">${esc(t('docs.publicLede'))}</p>`;
  const signedOut = !ctx.state.cap?.identity?.name;
  const canSignIn = (ctx.state.cap?.authProviders || []).length > 0;
  const scheme = primarySchemes(op, document)[0];
  const roles = requiredScopes(op, document);
  const alternatives = securityRequirements(op, document).filter(alternative => alternative.some(item => item.scopes.length)).length || 1;
  return `<div class="req-list">
    <div class="req"><span class="req-ico">${icon('lock', true)}</span><div class="grow"><div class="t">${esc(t('docs.signin'))} <span class="tag tag-mono">${esc(scheme?.name ?? '')}</span>${signedOut ? `<span class="tag tag-accent">${esc(t('docs.youreOut'))}</span>` : ''}</div>
      <div class="s" lang="en">${scheme?.scheme?.description ? inline(String(scheme.scheme.description).replace(/\s*\n\s*/g, ' ')) : esc(t('auth.schemeBody', { name: ctx.state.cap?.apiName || '' }))}</div></div>
      ${signedOut && canSignIn ? `<button type="button" class="btn btn-sm btn-primary" data-action="signin">${icon('log-in', true)}${esc(t('shell.signIn'))}</button>` : ''}</div>
    ${roles.length ? `<div class="req"><span class="req-ico">${icon('shield', true)}</span><div class="grow"><div class="t">${esc(t('docs.roles'))} ${roles.map(role => `<span class="tag tag-mono">${esc(role)}</span>`).join(' ')}</div><div class="s">${esc(t('docs.rolesBody', { n: roles.length > 1 || alternatives > 1 ? 2 : 1 }))}</div></div></div>` : ''}
  </div>`;
}

/** The main column: head row, scrolling page and bottom bar. */
function mainPane(ctx, parts) {
  const { state, ui } = ctx;
  const { op, document, groups, media, type, responses, firstOk } = parts;
  const operation = op.operation;
  const signedOut = !state.cap?.identity?.name;
  const dep = operation.deprecated ? deprecation(operation) : null;
  const description = dep ? dep.prose : operation.description;
  const roles = requiredScopes(op, document);
  const securityTag = isPublic(op, document)
    ? `<span class="tag">${icon('globe', true)}${esc(t('op.public'))}</span>`
    : `<span class="tag">${icon(signedOut ? 'lock' : 'shield', true)}${esc(signedOut ? t('docs.needsSignin') : roles.length ? scopeText(op, document) : t('docs.signedInUsers'))}</span>`;
  const bodyName = media?.schema ? schemaName(media.schema, document) : '';
  const openSet = ui.openResponses ??= new Set(firstOk ? [firstOk] : []);

  const bodyCard = media ? `<h3 id="doc-body">${esc(t('docs.body'))} <span class="faint">· ${esc(type)}${bodyName ? ' ·' : ''}</span> ${bodyName ? `<a class="type-link" href="#model/${encodeURIComponent(bodyName.replace(/\[\]$/, ''))}" data-model="${esc(bodyName.replace(/\[\]$/, ''))}">${esc(bodyName)}</a>` : ''}</h3>
    <div class="card flat" data-body-card>
      ${treeHead(media.schema, document, { id: 'body', extra: `<div class="segmented" role="group" aria-label="${esc(t('docs.bodyView'))}"><button type="button" data-body-view="schema" aria-pressed="${ui.bodyView !== 'example'}">${esc(t('docs.schema'))}</button><button type="button" data-body-view="example" aria-pressed="${ui.bodyView === 'example'}">${esc(t('docs.example'))}</button></div>` })}
      <div data-body-content></div>
    </div>` : '';

  const responseItems = responses.map(([code, response]) => {
    const media2 = Object.values(response.content || {})[0];
    const schema = media2?.schema;
    const open = !!schema && openSet.has(code);
    const name = schema ? schemaName(schema, document) || resolve(schema, document).type : '';
    const id = `doc-response-${code}`;
    const head = `<span class="slot" aria-hidden="true">${schema ? icon(open ? 'chevron-down' : 'chevron-right', true) : ''}</span>
      <span class="code ${statusClass(code)}">${esc(code)}</span><span class="d" lang="en">${esc(firstSentence(response.description || ''))}</span><span class="spacer"></span>
      ${schema ? `<span class="type-link">${esc(name)}</span>` : `<span class="faint" style="font-size:var(--fs-sm)">${esc(t('res.noBody'))}</span>`}`;
    return `<div class="resp-item${open ? ' is-open' : ''}">${schema
      ? `<button type="button" class="head" aria-expanded="${open}" aria-controls="${id}" data-response-toggle="${esc(code)}">${head}</button>`
      : `<div class="head">${head}</div>`}
      ${schema ? `<div class="body" id="${id}" ${open ? '' : 'hidden'}><div class="media"><span>${esc(Object.keys(response.content)[0])}</span><span class="spacer"></span>${hasNested(schema, document) ? `<button type="button" class="btn btn-ghost btn-xs" data-tree-all="r${esc(code)}" data-all="off">${icon('chevrons-ud', true)}<span>${esc(t('tree.expandAll'))}</span></button>` : ''}</div><div data-response-tree="${esc(code)}"></div></div>` : ''}
    </div>`;
  }).join('');

  return `${contextBar({ kind: 'op', op, view: 'docs' })}
    <div class="pane-scroll" id="doc-main"><div class="doc-inner">
      <h1 id="doc-title" tabindex="-1" lang="en">${esc(op.title)}</h1>
      <div class="doc-meta">${method(op.method)}<code class="ltr">${esc(op.path)}</code>${securityTag}${operation.deprecated ? `<span class="tag tag-warn">${esc(t('side.deprecated'))}</span>` : ''}<span class="tag tag-mono" title="operationId">${esc(opKey(op))}</span></div>
      ${dep ? deprecationNotice(op, { ops: state.ops, document, where: 'docs' }) : ''}
      <div class="prose" lang="en">${description?.trim() ? linkOperationIds(markdown(description), state.ops) : dep ? '' : `<p class="faint">${esc(t('docs.noDesc'))}</p>`}</div>
      ${idempotencyCallout(op, document)}
      <h2 id="doc-request">${esc(t('docs.request'))}</h2>
      ${groups.map(group => `<h3 id="doc-params-${group.where}">${esc(t(group.key))} <span class="faint">· ${group.items.length}</span></h3><div class="card flat" data-params="${group.where}"></div>`).join('')}
      ${bodyCard}
      ${!groups.length && !media ? `<p class="lede">${esc(t('docs.noInputs'))}</p>` : ''}
      <h2 id="doc-responses">${esc(t('docs.responses'))} <span class="count">${esc(t('docs.documented', { n: responses.length }))}</span></h2>
      <div class="resp-list">${responseItems}</div>
      <h2 id="doc-auth">${esc(t('docs.authentication'))}</h2>
      ${authentication(op, document, ctx)}
    </div></div>
    <div class="pane-bar"><span class="bar-text">${icon('info', true)}<span>${esc(t('docs.bar'))}</span></span>
      <button type="button" class="btn btn-primary btn-sm" data-action="docs-try" ${shortcutAttrs('docs')}>${icon('flask', true)}${esc(t('op.tryIt'))}${shortcutHint('docs')}</button></div>`;
}

/** The right column: outline, request sample and response examples, then the base URL bar. */
function asidePane(ctx, parts) {
  const { op, document, groups, media, responses, firstOk, sample } = parts;
  const { samples } = ctx;
  const outline = [['doc-title', t('docs.overview')], ['doc-request', t('docs.request')],
    ...groups.map(group => [`doc-params-${group.where}`, t(group.key), true]), ...(media ? [['doc-body', t('docs.body'), true]] : []),
    ['doc-responses', t('docs.responses')], ['doc-auth', t('docs.authentication')]];
  const withBody = responses.filter(([, response]) => Object.values(response.content || {})[0]?.schema).slice(0, 4);
  const selected = withBody.some(([code]) => code === firstOk) ? firstOk : withBody[0]?.[0];
  const examples = withBody.map(([code, response]) => {
    const media2 = Object.values(response.content)[0];
    return { code, view: jsonView(documentedExample(media2, document, samples), { label: t('docs.responseExample') }) };
  });
  return `<div class="aside-head">${esc(t('docs.onThisPage'))}</div>
    <div class="pane-scroll" id="aside-scroll"><div class="aside-inner">
      <nav class="outline" aria-label="${esc(t('docs.onThisPage'))}">${outline.map(([id, label, sub], index) => `<a href="#${id}" data-outline="${id}" class="${sub ? 'sub' : ''}"${index === 0 ? ' aria-current="location"' : ''}>${esc(label)}</a>`).join('')}</nav>
      <p class="aside-label">${esc(t('docs.requestSample'))}</p>
      <div class="sample-card card">
        <div class="viewer-bar">${codePicker({ id: 'docs-code-picker' })}<span class="spacer"></span>${copyButton(t('docs.copySample'), { action: 'copy-sample' })}</div>
        <pre class="ltr" data-sample tabindex="0" aria-label="${esc(t('docs.requestSample'))}"></pre>
      </div>
      ${examples.length ? `<p class="aside-label">${esc(t('docs.responseExample'))}</p>
      <div class="sample-card card">
        <div class="tabs" role="tablist" aria-label="${esc(t('docs.responseExample'))}">${examples.map(({ code }) => tab(code, { selected: code === selected, id: `doc-example-tab-${code}`, controls: `doc-example-${code}`, data: `data-example="${esc(code)}"`, labelClass: `code-label ${statusClass(code)}` })).join('')}</div>
        ${examples.map(({ code, view }) => `<div id="doc-example-${code}" role="tabpanel" aria-labelledby="doc-example-tab-${code}" ${code === selected ? '' : 'hidden'}>${view.html}</div>`).join('')}
      </div>` : ''}
    </div></div>
    <div class="pane-bar"><span class="bar-text">${icon('server', true)}<span>${esc(t('docs.base'))} <code class="ltr">${esc(baseUrl(document))}</code></span></span>${copyButton(t('docs.copyBase'), { action: 'copy-base', size: 'btn-xs' })}</div>`;
}

/**
 * Renders the Docs view into the two reading panes.
 * @param {HTMLElement} main the `.doc-pane`
 * @param {HTMLElement} aside the `.aside-pane`
 * @param {{ state: object, ui: object, samples: unknown[] }} ctx `ui` is {@link newDocsState} for this operation
 */
export function renderDocs(main, aside, ctx) {
  const { state, ui } = ctx;
  const op = state.op;
  const document = state.doc;
  if (!op) { main.innerHTML = aside.innerHTML = ''; return; }
  const groups = parameterGroups(op, document);
  const body = dereference(op.operation.requestBody, document);
  const type = Object.hasOwn(body?.content || {}, 'application/json') ? 'application/json' : Object.keys(body?.content || {})[0];
  const media = body?.content?.[type];
  const responses = Object.entries(op.operation.responses || {}).map(([code, raw]) => [code, dereference(raw, document) || {}]);
  const hasBody = ([, response]) => !!Object.values(response.content || {})[0]?.schema;
  // The response that matters most opens first: 201 for a create, otherwise the first 2xx.
  const created = op.method === 'POST' ? responses.find(entry => entry[0] === '201' && hasBody(entry)) : undefined;
  const firstOk = (created ?? responses.find(entry => /^2/.test(entry[0]) && hasBody(entry)))?.[0];
  const sample = sampleRequest(op, document, media, type, ctx.samples);
  const parts = { op, document, groups, media, type, responses, firstOk, sample };
  main.innerHTML = mainPane(ctx, parts);
  aside.innerHTML = asidePane(ctx, parts);

  // Trees render after the markup so each keeps its own open/closed state in `ui`.
  const place = (selector, html) => { const holder = main.querySelector(selector); if (holder) holder.innerHTML = html; };
  const scope = `${state.documentUrl}#docs/${opKey(op)}`;
  for (const group of groups) place(`[data-params="${group.where}"]`, parameterTree(group.items, document, { id: `params-${group.where}`, state: treeState(ui, `params-${group.where}`, scope), label: t(group.key) }));
  const drawBody = () => {
    if (!media) return;
    place('[data-body-content]', ui.bodyView === 'example'
      ? jsonView(documentedExample(media, document, ctx.samples), { label: t('docs.example') }).html
      : propertyTree(media.schema, document, { id: 'body', state: treeState(ui, 'body', scope), label: schemaName(media.schema, document) }));
    for (const button of main.querySelectorAll('[data-body-view]')) button.setAttribute('aria-pressed', String(button.dataset.bodyView === ui.bodyView));
    main.querySelector('[data-tree-all="body"]')?.toggleAttribute('hidden', ui.bodyView === 'example');
    bindTrees(main);
    bindJsonViews(main);
  };
  const drawResponse = code => {
    const response = responses.find(([c]) => c === code)?.[1];
    const media2 = Object.values(response?.content || {})[0];
    const holder = main.querySelector(`[data-response-tree="${code}"]`);
    if (holder && media2?.schema && !holder.hasChildNodes()) {
      holder.innerHTML = propertyTree(media2.schema, document, { id: `r${code}`, state: treeState(ui, `r${code}`, scope), label: schemaName(media2.schema, document) });
      bindTrees(main);
    }
  };
  drawBody();
  for (const code of ui.openResponses) drawResponse(code);
  bindTrees(main);
  bindJsonViews(aside);
  syncTreeButtons(main);

  const pre = aside.querySelector('[data-sample]');
  // The language is the one remembered for Docs and Try it alike (code-picker.js).
  const draw = () => {
    const format = getCodeFormat();
    pre.innerHTML = highlightSnippet(formatRequest(format, sample, []), snippetFormats.find(item => item.id === format)?.lexer);
    pre.dataset.format = format;
    updateCodePicker(aside.querySelector('[data-code-trigger]'), format);
  };
  draw();
  bindCodePicker(aside, { onChange: draw });

  if (!main.dataset.treeSync) { main.dataset.treeSync = ''; main.addEventListener('tree-change', () => syncTreeButtons(main)); }
  main.onclick = event => {
    const toggle = event.target.closest('[data-response-toggle]');
    if (toggle) {
      const code = toggle.dataset.responseToggle;
      const panel = globalThis.document.getElementById(toggle.getAttribute('aria-controls'));
      const open = panel.hidden;
      panel.hidden = !open;
      if (open) { ui.openResponses.add(code); drawResponse(code); } else ui.openResponses.delete(code);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.closest('.resp-item').classList.toggle('is-open', open);
      toggle.querySelector('use').setAttribute('href', open ? '#i-chevron-down' : '#i-chevron-right');
      syncTreeButtons(main);
      return;
    }
    const view = event.target.closest('[data-body-view]');
    if (view) { ui.bodyView = view.dataset.bodyView; drawBody(); return; }
    const all = event.target.closest('[data-tree-all]');
    if (all) {
      const holder = all.dataset.treeAll === 'body' ? main.querySelector('[data-body-content] .stree') : main.querySelector(`[data-response-tree="${all.dataset.treeAll.slice(1)}"] .stree`);
      if (holder) { setAllOpen(holder, !isAllOpen(holder)); syncTreeButtons(main); }
    }
  };
  aside.onclick = event => {
    const copy = event.target.closest('[data-action="copy-sample"]');
    if (copy) { event.stopPropagation(); copyText(pre.textContent, { button: copy, what: t('copy.what.sample'), select: pre, notice: pre }); return; }
    const base = event.target.closest('[data-action="copy-base"]');
    if (base) { event.stopPropagation(); copyText(baseUrl(document), { button: base, what: t('copy.what.url') }); return; }
    const example = event.target.closest('[data-example]');
    if (example) {
      for (const item of example.parentElement.children) {
        const selected = item === example;
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected ? 0 : -1;
        globalThis.document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
      }
      return;
    }
    const link = event.target.closest('[data-outline]');
    if (link) {
      event.preventDefault();
      const target = main.querySelector('#' + CSS.escape(link.dataset.outline));
      const scroller = main.querySelector('#doc-main');
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (target) scroller.scrollTo({ top: link.dataset.outline === 'doc-title' ? 0 : target.offsetTop - scroller.querySelector('.doc-inner').offsetTop - 12, behavior: reduce ? 'auto' : 'smooth' });
      target?.focus?.({ preventScroll: true });
    }
  };

  // The outline follows the section in view.
  const scroller = main.querySelector('#doc-main');
  const links = [...aside.querySelectorAll('[data-outline]')];
  const follow = () => {
    const top = scroller.getBoundingClientRect().top + 32;
    let current = links[0];
    for (const link of links) {
      const target = main.querySelector('#' + CSS.escape(link.dataset.outline));
      if (target && target.getBoundingClientRect().top <= top) current = link;
    }
    // At the end of the page the last section is current even when it is too short to reach the top.
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2 && scroller.scrollTop > 0) current = links.at(-1);
    for (const link of links) link === current ? link.setAttribute('aria-current', 'location') : link.removeAttribute('aria-current');
  };
  scroller.addEventListener('scroll', follow, { passive: true });
  follow();
}

/** Keeps the Expand all / Collapse all buttons' labels in step with their trees. */
function syncTreeButtons(main) {
  for (const button of main.querySelectorAll('[data-tree-all]')) {
    const holder = button.dataset.treeAll === 'body' ? main.querySelector('[data-body-content] .stree') : main.querySelector(`[data-response-tree="${button.dataset.treeAll.slice(1)}"] .stree`);
    const all = !!holder && isAllOpen(holder);
    button.querySelector('span').textContent = t(all ? 'tree.collapseAll' : 'tree.expandAll');
  }
}

