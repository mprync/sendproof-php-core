// The request pane (mock: request.js): operation header, the request tabs (Body, Params,
// Headers, Auth, Code), the forms inside them, Autofill and per-field generation, and turning
// the drafts into a prepared request.
import { createSchemaForm, resolveSchema, validateSchemaValue } from './schema.js';
import { dereference, encodeRequestBody, makeRequest } from './api.js';
import { copyTextButton, esc, icon, inlineNote, tab as tabButton } from './components.js';
import { snippetFormats, formatRequest } from './snippets.js';
import { newUuid } from './uuid.js';
import { createHeaderEditor } from './header-editor.js';
import { autofillContext, fillDraft, showAutofillMenu } from './autofill.js';
import { shortcutAttrs, shortcutHint, shortcutLong } from './shortcuts.js';
import { t, th } from './i18n.js';
import { operationHeader } from './operation-header.js';
import { isPublic, primarySchemes, scopeText } from './security.js';
import { copyText } from './copy.js';
import { highlightSnippet } from './highlight.js';
import { bindCodePicker, codePicker, getCodeFormat } from './code-picker.js';
import { schemaName } from './schema-model.js';
import { describeField } from './field-help.js';
import { setToggletipContent } from './toggletip.js';

/**
 * Where a sample writes the redacted Cookie value, in every language: `Cookie: REDACTED` (cURL),
 * `"Cookie": "REDACTED"` (JavaScript, Python), `"Cookie", "REDACTED"` (C#, Go, Java, Kotlin, Rust),
 * `'Cookie' => 'REDACTED'` (PHP), `["Cookie"] = "REDACTED"` (Ruby), `'Cookie' = 'REDACTED'` (PowerShell).
 */
const COOKIE_VALUE = /(Cookie['"]?\s*(?:=>|[:=,]|\]\s*=)\s*['"]?)REDACTED/;
const bodyMode = tab => tab === 'Form' || tab === 'JSON';
/** Query parameters that cut and order a page rather than filter it. */
const PAGING = ['page', 'pagenumber', 'pageindex', 'pagesize', 'perpage', 'per_page', 'limit', 'offset', 'cursor', 'after', 'before', 'sort', 'sortby', 'order', 'orderby'];
const isPaging = name => PAGING.includes(String(name).toLowerCase());
const pagingRank = name => PAGING.indexOf(String(name).toLowerCase());
const TAB_LABELS = { Body: 'tab.body', Params: 'tab.params', Headers: 'tab.headers', Auth: 'tab.auth', Code: 'tab.code' };

/** Select an inline OpenAPI example, including a locally referenced Example Object. */
export function requestExample(source, document) {
  if (source && Object.hasOwn(source, 'example')) return source.example;
  for (const raw of Object.values(source?.examples || {})) {
    const example = dereference(raw, document);
    if (example && Object.hasOwn(example, 'value')) return example.value;
  }
  return undefined;
}

/** Own request editor rendering and conversion into a prepared request. */
export function createRequestEditor({ state, basePath, $, onLookupPreview, onHeadersChange, sensitiveNames = () => [], onFilled = () => {} }) {
  let includeCookie = true;

  function validationError(issues) {
    const error = new Error(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
    error.validation = true;
    error.issues = issues;
    return error;
  }

  const withPrefix = (issue, prefix) => ({
    path: prefix ? (issue.path ? `${prefix}.${issue.path}` : prefix) : issue.path || '$',
    message: issue.message,
  });

  function parameterSchema(parameter) {
    if (parameter.schema != null) return parameter.schema;
    return Object.values(parameter.content || {})[0]?.schema;
  }

  function validateValue(schema, value, required, prefix) {
    if (schema == null) return [];
    return validateSchemaValue({ schema, value, document: state.doc, required }).map(issue => withPrefix(issue, prefix));
  }

  const isIdempotencyKey = parameter => parameter.in === 'header' && parameter.name?.toLowerCase() === 'idempotency-key';

  function requestMedia() {
    const body = dereference(state.op?.operation.requestBody, state.doc);
    const content = body?.content || {};
    const type = Object.hasOwn(content, 'application/json') ? 'application/json' : Object.keys(content)[0];
    return { body, media: content[type], type };
  }

  const headerEditor = createHeaderEditor({
    state, $, parameterSchema, getMediaType: () => requestMedia().type,
    onChange: () => { updateHeaderCount(); onHeadersChange?.(); },
  });
  function updateHeaderCount() {
    const badge = $('[data-request-tab="Headers"] .n');
    if (badge) badge.textContent = String(headerEditor.count());
  }
  let autofillUndo;
  let fillGeneration = 0;

  async function fillSample(mode = 'all') {
    if (!state.op) return;
    const operation = state.op;
    const ticket = ++fillGeneration;
    const before = { body: state.body, json: state.json, paramValues: { ...state.paramValues }, headers: structuredClone(state.headers || []), autofilled: state.autofilled };
    const focused = globalThis.document?.activeElement;
    const announcement = $('[data-request-announcement]');
    const say = text => { if (announcement) announcement.textContent = text; };
    if (mode === 'undo') {
      if (!autofillUndo || autofillUndo.operation !== operation) return;
      Object.assign(state, autofillUndo.before);
      autofillUndo = undefined;
      state.canUndoAutofill = false;
      renderOperation();
      onFilled(0);
      say(t('fill.undone'));
      return;
    }
    let draft = before.body;
    if (before.json !== undefined && !['clear', 'reuse'].includes(mode)) {
      try { draft = before.json.trim() ? JSON.parse(before.json) : undefined; }
      catch { say(t('fill.fixJson')); return; }
    }
    const next = { body: draft, paramValues: { ...before.paramValues }, headers: before.headers };
    const filled = new Map();
    if (mode === 'clear') {
      next.body = undefined;
      next.paramValues = {};
      next.headers = [];
    } else if (mode === 'reuse') {
      const entry = state.history?.find(item => item.op === operation);
      if (!entry) return;
      next.body = structuredClone(entry.body);
      next.paramValues = structuredClone(entry.params || {});
      next.headers = structuredClone(entry.headers || []);
    } else {
      const { media } = requestMedia();
      const regenerate = mode === 'ids';
      const all = mode === 'all';
      const context = autofillContext(state.doc, basePath, operation.path, state.lastResponse, state.lookupCache ??= new Map(), filled, state.cap?.identity?.name);
      say(t('fill.filling'));
      const body = media && fillDraft(media.schema, draft, requestExample(media, state.doc), context, { all, regenerate });
      await Promise.all(operation.parameters.map(async parameter => {
        const key = `${parameter.in}:${parameter.name}`;
        if (isIdempotencyKey(parameter)) {
          if (regenerate) next.paramValues[key] = newUuid();
          return;
        }
        if (!all && !regenerate && !parameter.required) return;
        const schema = parameterSchema(parameter) ?? {};
        const value = await fillDraft(schema, next.paramValues[key], requestExample(parameter, state.doc),
          { ...context, filled: new Map() }, { all, regenerate }, [parameter.name]);
        if (value !== undefined) next.paramValues[key] = value;
      }));
      if (body) next.body = await body;
      if (operation !== state.op || ticket !== fillGeneration || state.body !== before.body || state.json !== before.json ||
        Object.keys({ ...state.paramValues, ...before.paramValues }).some(key => state.paramValues?.[key] !== before.paramValues[key])) return;
    }
    autofillUndo = { operation, before };
    state.canUndoAutofill = true;
    Object.assign(state, next, { json: undefined, autofilled: filled });
    renderOperation();
    if (focused?.matches?.('[data-action="sample"]')) $('.request-tools [data-action="sample"]')?.focus();
    onFilled(['required', 'all'].includes(mode) ? filled.size : 0);
    say(mode === 'clear' ? t('fill.cleared') : mode === 'reuse' ? t('fill.restored') : t('fill.done', { n: filled.size }));
  }

  function autofill(anchor, after = () => {}) {
    const { media } = requestMedia();
    const schema = media?.schema;
    const rendered = JSON.stringify(resolveSchema(schema, state.doc));
    const canRegenerate = state.op.parameters.some(isIdempotencyKey) ||
      JSON.stringify([schema, state.doc.components?.schemas]).includes('"uuid"');
    showAutofillMenu(anchor, {
      history: state.history?.find(item => item.op === state.op),
      canRegenerate,
      optionalCount: countOptional(),
      lookupActor: rendered.includes('"x-lookup"') ? state.cap?.identity?.name : undefined,
      onSelect: async mode => { await fillSample(mode); after(); },
    });
  }

  function countOptional() {
    const schema = resolveSchema(requestMedia().media?.schema, state.doc);
    return Object.keys(schema.properties || {}).filter(name => !schema.required?.includes(name) && !resolveSchema(schema.properties[name], state.doc).readOnly).length;
  }

  /** Number of inputs Autofill could fill: body properties and non-header parameters. */
  function fieldCount() {
    const schema = resolveSchema(requestMedia().media?.schema, state.doc);
    return Object.keys(schema.properties || {}).length + (state.op?.parameters || []).filter(p => p.in !== 'header').length;
  }

  function tabs() {
    const params = state.op.parameters.map(p => dereference(p, state.doc)).filter(p => p?.name);
    const { media } = requestMedia();
    // Query parameters split into what filters and how the page is cut and ordered (mock 76),
    // when the operation has paging parameters at all.
    const paging = params.some(p => p.in === 'query' && isPaging(p.name));
    const sections = [['path', 'req.path'], ...(paging ? [['query', 'req.filter', p => !isPaging(p.name)], ['paging', 'req.paging', p => isPaging(p.name)]] : [['query', 'req.query']]), ['cookie', 'req.cookies']]
      .map(([location, label, test = () => true]) => [location, label, p => (location === 'paging' ? p.in === 'query' : p.in === location) && test(p)])
      .filter(([, , test]) => params.some(test));
    const signIn = state.cap?.identity || state.cap?.authProviders?.length || !isPublic(state.op, state.doc);
    return {
      params, media, sections,
      list: [...(media ? ['Body'] : []), ...(sections.length ? ['Params'] : []), 'Headers', ...(signIn ? ['Auth'] : []), 'Code'],
    };
  }

  function renderTabs(list, current, params) {
    const counts = { Params: params.filter(p => p.in !== 'header').length, Headers: headerEditor.count() };
    $('.request-tabs').innerHTML = list.map((name, index) => tabButton(t(TAB_LABELS[name]), {
      selected: name === current, count: counts[name], id: `request-tab-${name}`, controls: 'editor',
      shortcut: 'request-tab-' + index, data: `data-request-tab="${name}"`, flagSlot: ['Body', 'Params', 'Headers'].includes(name),
    })).join('');
    const tools = $('.request-tools');
    if (tools) tools.innerHTML = ['Body', 'Params'].includes(current) && fieldCount()
      ? `<button type="button" class="btn btn-ghost btn-sm" id="autofill" data-action="sample" aria-label="${esc(t('req.autofill'))}" aria-haspopup="menu" aria-controls="autofill-menu" aria-expanded="false" title="${esc(t('shortcut.autofill-required') + ' · ' + shortcutLong('autofill-required'))}" ${shortcutAttrs('autofill-required')}>${icon('wand', true)}<span class="lbl">${esc(t('req.autofill'))}</span>${icon('chevron-down', true)}</button>`
      : '';
  }

  /** The Body section heading: schema link and the Form/JSON switch. */
  function bodyHeading(media, json) {
    const name = schemaName(media?.schema, state.doc);
    const switcher = media?.schema ? `<div class="segmented" role="group" aria-label="${esc(t('req.bodyEditor'))}" ${shortcutAttrs('editor-mode')}>
        <button type="button" data-body-mode="Form" aria-pressed="${!json}">${esc(t('req.form'))}</button>
        <button type="button" data-body-mode="JSON" aria-pressed="${json}">${esc(t('req.json'))}</button></div>` : '';
    return `<div class="section-label"><span id="body-legend">${esc(t('req.body'))} ${name ? `<a class="schema-link" href="#model/${encodeURIComponent(name.replace(/\[\]$/, ''))}" data-model="${esc(name.replace(/\[\]$/, ''))}" title="${esc(t('req.openModel', { name }))}">${esc(name)}</a>` : ''}</span><span class="rule" aria-hidden="true"></span>${switcher}</div>`;
  }

  function renderOperation() {
    state.forms.forEach(form => form.destroy());
    state.forms = [];
    state.bodyForm = null;
    if (!state.op) {
      $('#operation').innerHTML = `<div class="op-head"><h1 class="op-title" id="op-title">${esc(t('req.noOperations'))}</h1><p class="op-desc">${esc(t('req.noOperationsBody'))}</p></div>`;
      $('#editor').innerHTML = '';
      $('.request-tabs').innerHTML = '';
      return;
    }
    state.paramValues ||= {};
    for (const parameter of state.op.parameters) {
      const key = 'header:' + parameter.name;
      if (isIdempotencyKey(parameter) && !Object.hasOwn(state.paramValues, key)) state.paramValues[key] = newUuid();
    }
    $('#operation').innerHTML = operationHeader(state.op, {
      base: (globalThis.location?.origin || '') + basePath.replace(/\/$/, ''), document: state.doc,
      signedIn: !!state.cap?.identity?.name, canSignIn: !!state.cap?.authProviders?.length, ops: state.ops,
    });
    const { params, media, sections, list } = tabs();
    let tab = bodyMode(state.tab) ? 'Body' : state.tab;
    if (!list.includes(tab)) {
      tab = list[0];
      state.tab = tab === 'Body' ? (media.schema ? 'Form' : 'JSON') : tab;
    }
    if (tab === 'Body' && !media.schema) state.tab = 'JSON';
    renderTabs(list, tab, params);
    const editor = $('#editor');
    editor.setAttribute('aria-labelledby', `request-tab-${tab}`);
    if (state.tab === 'JSON') {
      editor.innerHTML = `<fieldset aria-labelledby="body-legend">${bodyHeading(media, true)}<div class="field"><label class="sr-only" for="json">${esc(t('req.jsonLabel'))}</label><textarea class="code" id="json" aria-describedby="json-assist" spellcheck="false">${esc(state.json ?? (state.body === undefined ? '' : JSON.stringify(state.body, null, 2)))}</textarea>
        <div class="assist" id="json-assist"><span class="assist-icon" hidden>${icon('alert', true)}</span><span class="msg"><span class="field-hint">${esc(t('req.jsonHint'))}</span><span class="field-error" hidden></span></span></div></div></fieldset>`;
      $('#json').addEventListener('input', event => { state.json = event.target.value; updateHeaderCount(); });
      return;
    }
    if (state.tab === 'Headers') { headerEditor.render(); return; }
    if (state.tab === 'Auth') { editor.innerHTML = authMarkup(); return; }
    if (state.tab === 'Code') { renderCode(editor); return; }
    if (tab === 'Params') editor.innerHTML = sections.map(([location, label]) =>
      `<fieldset><legend class="section-label">${esc(t(label))}<span class="rule" aria-hidden="true"></span></legend><div class="fields" id="parameters-${location}"></div></fieldset>`).join('');
    else editor.innerHTML = `<fieldset aria-labelledby="body-legend">${bodyHeading(media, false)}<p class="form-note">${esc(t('req.requiredNote'))}</p><div id="body-form"></div></fieldset>`;
    const shared = {
      document: state.doc, basePath: basePath.replace(/\/$/, ''), lastResponse: state.lastResponse,
      lookupCache: state.lookupCache ??= new Map(), onLookupPreview, autofilled: state.autofilled,
      actor: state.cap?.identity?.name, signedIn: !!state.cap?.identity?.name,
      // A signed-out lookup offers Sign in: the same flow as the top bar's button.
      onSignIn: state.cap?.authProviders?.length ? () => globalThis.document.querySelector('.topbar [data-action="signin"]')?.click() : undefined,
    };
    const sectionOf = p => sections.find(([, , test]) => test(p))?.[0];
    const ordered = tab === 'Params' ? params.filter(p => p.in !== 'header') : [];
    // Page, then page size, then sort: the order people read a paging control in.
    ordered.sort((a, b) => (isPaging(a.name) ? pagingRank(a.name) : -1) - (isPaging(b.name) ? pagingRank(b.name) : -1));
    for (const p of ordered) {
      const section = $(`#parameters-${sectionOf(p)}`);
      if (!section) continue;
      const holder = globalThis.document.createElement('div');
      holder.className = 'param-holder';
      holder.dataset.parameterName = p.name;
      holder.innerHTML = '<div></div>';
      section.append(holder);
      const schema = parameterSchema(p);
      const form = createSchemaForm({
        ...shared, container: holder.lastElementChild, name: p.name, required: p.required,
        // The parameter's own description says what it does here; the schema's is the fallback.
        schema: typeof schema === 'boolean' ? schema : { ...(schema || { type: 'string' }), title: schema?.title || p.name, description: p.description || resolveSchema(schema, state.doc).description },
        operationPath: p.in === 'path' ? state.op.path : undefined, value: state.paramValues?.[`${p.in}:${p.name}`], parameter: p,
        onChange: value => { state.paramValues ||= {}; state.paramValues[`${p.in}:${p.name}`] = value; },
      });
      form.parameter = p;
      state.forms.push(form);
    }
    if (tab === 'Params') pairShortFields(editor);
    if (tab === 'Body' && media?.schema) {
      state.bodyForm = createSchemaForm({
        ...shared, container: $('#body-form'), schema: media.schema, flattenRoot: true, value: state.body,
        required: requestMedia().body.required,
        example: requestExample(media, state.doc) ?? resolveSchema(media.schema, state.doc).examples?.[0] ?? resolveSchema(media.schema, state.doc).example,
        onChange: value => { state.body = value; state.json = undefined; updateHeaderCount(); },
      });
      state.forms.push(state.bodyForm);
      state.body = state.bodyForm.getValue();
    }
  }

  /**
   * Two short controls in a row share it (page and page size, type and currency): selects and
   * numbers, paired with the next one. A lone short field keeps the full width.
   */
  function pairShortFields(editor) {
    for (const section of editor.querySelectorAll('.fields')) {
      const fields = [...section.querySelectorAll(':scope > .param-holder > div > .field')];
      const short = field => field.dataset.kind === 'select' || !!field.querySelector(':scope > .control > input.num');
      for (let index = 0; index < fields.length - 1; index++) {
        // The pairing lives on the holders, which survive a field re-rendering itself.
        if (short(fields[index]) && short(fields[index + 1])) {
          fields[index].closest('.param-holder').dataset.half = 'start';
          fields[index + 1].closest('.param-holder').dataset.half = 'end';
          index++;
        }
      }
    }
  }

  /** The Auth tab: what this operation needs, from its security requirements, and whether you meet it. */
  function authMarkup() {
    const identity = state.cap?.identity;
    const signedIn = !!identity?.name;
    const providers = state.cap?.authProviders || [];
    if (isPublic(state.op, state.doc)) return `<section><h3 class="section-label">${esc(t('auth.requirements'))}<span class="rule" aria-hidden="true"></span></h3>
      <div class="req-list"><div class="req"><span class="req-ico">${icon('globe', true)}</span><div class="grow"><div class="t">${esc(t('docs.public'))}</div><div class="s">${esc(t('auth.publicBody'))}</div></div>${signedIn ? `<span class="tag tag-ok">${icon('check')}${esc(identity.name)}</span>` : ''}</div></div></section>`;
    const schemes = primarySchemes(state.op, state.doc);
    const scopes = scopeText(state.op, state.doc) ? [scopeText(state.op, state.doc)] : [];
    const label = scheme => t('auth.scheme.' + (scheme.type === 'apiKey' && scheme.in === 'cookie' ? 'cookie' : scheme.type || 'other'));
    const rows = [
      ...schemes.map(item => `<div class="req"><span class="req-ico">${icon('lock', true)}</span><div class="grow"><div class="t">${esc(label(item.scheme))} <span class="tag tag-mono">${esc(item.name)}</span></div><div class="s">${item.scheme.description ? `<span lang="en">${esc(item.scheme.description)}</span>` : esc(t('auth.sessionBody'))}</div></div>
        ${signedIn ? `<span class="tag tag-ok">${icon('check')}${esc(identity.name)}</span>` : `<span class="tag tag-warn">${esc(t('auth.notSignedIn'))}</span>`}</div>`),
      ...scopes.map(scope => `<div class="req"><span class="req-ico">${icon('shield', true)}</span><div class="grow"><div class="t">${esc(t('auth.permission'))} <span class="tag tag-mono">${esc(scope)}</span></div><div class="s">${esc(t('auth.permissionBody'))}</div></div>
        <span class="tag">${esc(t(signedIn ? 'auth.checkedOnSend' : 'auth.unknown'))}</span></div>`),
    ];
    if (!rows.length) rows.push(`<div class="req"><span class="req-ico">${icon('lock', true)}</span><div class="grow"><div class="t">${esc(t('auth.signInNeeded'))}</div><div class="s">${esc(t('auth.sessionBody'))}</div></div>${signedIn ? `<span class="tag tag-ok">${icon('check')}${esc(identity.name)}</span>` : `<span class="tag tag-warn">${esc(t('auth.notSignedIn'))}</span>`}</div>`);
    const personas = providers.some(provider => /persona/i.test(provider.kind || ''));
    return `<section class="auth-req"><h3 class="section-label">${esc(t('auth.requirements'))}<span class="rule" aria-hidden="true"></span></h3>
      <div class="req-list">${rows.join('')}</div>
      ${providers.length ? `<div class="actions" style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-block-start:1rem">
        <button type="button" class="btn ${signedIn ? '' : 'btn-primary'}" data-action="signin" ${shortcutAttrs('signin')}>${icon(signedIn ? 'user' : 'log-in', true)}${esc(t(signedIn ? 'shortcut.signin' : 'shell.signIn'))} ${shortcutHint('signin')}</button>
        ${!signedIn && personas ? `<button type="button" class="btn" data-action="signin">${esc(t('auth.seeded'))}</button>` : ''}</div>` : ''}
    </section>`;
  }

  /** Builds the request without validation, using typed placeholders for missing values. */
  function draftRequest() {
    const placeholders = [];
    const token = label => { placeholders.push(label); return `zzph${placeholders.length - 1}zz`; };
    let issues = [];
    try { return { request: readRequest(), placeholders }; }
    catch (error) { if (!error.validation) throw error; issues = error.issues || []; }
    const clone = value => value === undefined ? undefined : structuredClone(value);
    let body = clone(state.json !== undefined ? safeJson(state.json) : state.body);
    const params = { ...(state.paramValues || {}) };
    for (const issue of issues) {
      if (issue.tab === 'Headers') continue;
      const parts = String(issue.path || '').replace(/^\$\.?/, '').split('.').filter(Boolean);
      if (issue.tab === 'Params') {
        const parameter = state.op.parameters.find(p => p.name === parts[0]);
        if (parameter) params[`${parameter.in}:${parameter.name}`] = token(`${parameter.name}: ${typeLabel(parameterSchema(parameter))}`);
        continue;
      }
      if (!parts.length) continue;
      body = body && typeof body === 'object' ? body : {};
      let node = body;
      let schema = resolveSchema(requestMedia().media?.schema, state.doc);
      for (const [index, part] of parts.entries()) {
        schema = resolveSchema(schema.properties?.[part] ?? schema.items ?? {}, state.doc);
        if (index === parts.length - 1) node[part] = token(`${part}: ${typeLabel(schema)}`);
        else node = node[part] = node[part] && typeof node[part] === 'object' ? node[part] : {};
      }
    }
    const headers = headerEditor.values();
    const parameters = state.op.parameters.map(p => dereference(p, state.doc)).filter(p => p?.name && p.in !== 'header')
      .map(p => ({ ...p, value: params[`${p.in}:${p.name}`] ?? (p.in === 'path' ? token(`${p.name}: ${typeLabel(parameterSchema(p))}`) : undefined) }));
    parameters.push(...headerEditor.parameters());
    const { type } = requestMedia();
    return { request: makeRequest(state.op, parameters, encodeRequestBody(body, type, headers), headers, basePath), placeholders };
  }

  const safeJson = text => { try { return text.trim() ? JSON.parse(text) : undefined; } catch { return undefined; } };
  function typeLabel(raw) {
    const schema = resolveSchema(raw, state.doc);
    const type = Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type;
    const parts = [schema.format || type || 'value'];
    if (schema.minimum !== undefined) parts.push(`≥ ${schema.minimum}`);
    if (schema.maxLength !== undefined) parts.push(`≤ ${schema.maxLength}`);
    return parts.join(' ');
  }

  /** The Code tab: always a snippet. Missing values become typed placeholders. */
  function renderCode(editor) {
    // The remembered language is shared with the Docs sample card.
    const codeFormat = getCodeFormat();
    const format = snippetFormats.find(item => item.id === codeFormat);
    let snippet = '';
    let missing = 0;
    let failure = '';
    try {
      const { request, placeholders } = draftRequest();
      missing = placeholders.length;
      const cookieScheme = !isPublic(state.op, state.doc);
      const withCookie = includeCookie && cookieScheme ? { ...request, headers: new Headers(request.headers) } : request;
      if (withCookie !== request) withCookie.headers.set('Cookie', 'session');
      // The session cookie is HttpOnly, so the snippet shows a placeholder where it goes.
      const cookieToken = withCookie !== request ? `zzph${placeholders.push(t('code.cookiePlaceholder')) - 1}zz` : '';
      const text = formatRequest(codeFormat, withCookie, sensitiveNames()).replace(COOKIE_VALUE, `$1${cookieToken}`);
      snippet = highlightSnippet(text, format.lexer).replace(/(?:&quot;|&#39;|")?zzph(\d+)zz(?:&quot;|")?/g, (match, index) =>
        `<span class="ph" title="${esc(t('code.fillToReplace'))}">&lt;${esc(placeholders[Number(index)])}&gt;</span>`);
    } catch (error) {
      failure = error.message;
    }
    editor.innerHTML = `<div class="code-tools">
        ${codePicker({ id: 'editor-code-picker', value: codeFormat })}
        <span class="spacer"></span>
        ${!isPublic(state.op, state.doc) ? `<label class="switch-row"><button type="button" class="switch${includeCookie ? ' on' : ''}" role="switch" aria-checked="${includeCookie}" data-code-cookie aria-labelledby="code-cookie-label"></button><span id="code-cookie-label">${esc(t('code.includeCookie'))}</span></label>` : ''}
      </div>
      ${missing && !failure ? inlineNote(th('code.missing', { n: missing - (includeCookie && !isPublic(state.op, state.doc) ? 1 : 0) }), { extra: `<button type="button" class="btn btn-ghost btn-xs" data-fill-required ${shortcutAttrs('autofill-required')}>${esc(t('code.fillRequired'))} ${shortcutHint('autofill-required')}</button>` }) : ''}
      <div class="viewer">
        <div class="viewer-bar"><span class="faint ltr" style="font-size:var(--fs-sm);padding-inline-start:0.35rem">${esc(format.label)} · ${esc(t(missing ? 'code.withPlaceholders' : 'code.ready'))}</span><span class="spacer"></span>
          ${copyTextButton(t('code.copy'), { action: 'copy-code', cls: 'btn-sm btn-ghost' })}</div>
        <pre class="code-block ltr" id="snippet" tabindex="0" aria-label="${esc(t('code.snippetLabel', { language: format.label }))}">${failure ? esc(failure) : snippet}</pre>
      </div>`;
    // The picker stores the choice and re-renders; it returns focus to the (new) trigger itself.
    bindCodePicker(editor, { onChange: () => renderCode(editor) });
    editor.querySelector('[data-code-cookie]')?.addEventListener('click', () => {
      includeCookie = !includeCookie;
      renderCode(editor);
      editor.querySelector('[data-code-cookie]')?.focus();
    });
    editor.querySelector('[data-fill-required]')?.addEventListener('click', async () => { await fillSample('required'); });
    editor.querySelector('[data-action="copy-code"]').addEventListener('click', event => {
      event.stopPropagation();
      const pre = editor.querySelector('#snippet');
      copyText(pre.textContent, { button: event.currentTarget, what: t('copy.what.snippet'), select: pre, notice: pre });
    });
  }

  function readRequest() {
    if (!state.op) throw new Error(t('req.chooseOperation'));
    const issues = [];
    if (state.json !== undefined) {
      try { state.body = state.json.trim() ? JSON.parse(state.json) : undefined; }
      catch { throw validationError([{ path: '$', message: t('req.fixJsonThen') }]); }
    }
    for (const form of state.forms) {
      const prefix = form.parameter?.name || '';
      issues.push(...form.validate().errors.map(issue => ({ ...withPrefix(issue, prefix), ...(prefix ? { tab: 'Params' } : {}) })));
    }
    if (state.bodyForm) state.body = state.bodyForm.getValue();
    else if (state.tab !== 'Form' || state.forms.length === 0) {
      const { body, media } = requestMedia();
      issues.push(...validateValue(media?.schema, state.body, body?.required, ''));
    }
    const parameterForms = new Map(state.forms.filter(form => form.parameter).map(form => [`${form.parameter.in}:${form.parameter.name}`, form]));
    for (const raw of state.op.parameters || []) {
      const parameter = dereference(raw, state.doc);
      if (!parameter?.name || parameter.in === 'header') continue;
      const key = `${parameter.in}:${parameter.name}`;
      if (!parameterForms.has(key)) issues.push(...validateValue(parameterSchema(parameter), state.paramValues?.[key], parameter.required, parameter.name).map(issue => ({ ...issue, tab: 'Params' })));
    }
    issues.push(...headerEditor.issues().map(issue => ({ ...issue, tab: 'Headers' })));
    if (issues.length) throw validationError(issues);
    for (const form of state.forms) if (form.parameter) {
      state.paramValues ||= {};
      state.paramValues[`${form.parameter.in}:${form.parameter.name}`] = form.getValue();
    }
    const headers = headerEditor.values();
    const parameters = state.op.parameters.map(p => dereference(p, state.doc)).filter(p => p?.name && p.in !== 'header')
      .map(p => ({ ...p, value: state.paramValues?.[`${p.in}:${p.name}`] }));
    parameters.push(...headerEditor.parameters());
    const { type } = requestMedia();
    return makeRequest(state.op, parameters, encodeRequestBody(state.body, type, headers), headers, basePath);
  }

  /** ⌥G generates a value for the focused field; ⌥⇧G opens its Generate menu. */
  function generateField(target, menu) {
    const field = target?.closest?.('.field');
    const button = field?.querySelector('.slot.wand, [data-generate]');
    if (!button) return false;
    if (menu) button.click();
    else button.generateNow?.();
  }

  setToggletipContent(button => describeField(button, { state, requestMedia }));

  return {
    renderOperation, readRequest, fillSample, autofill, generateField, fieldCount,
    addHeader: headerEditor.add, removeHeader: headerEditor.remove, showBulkHeaders: headerEditor.showBulk, toggleHeader: headerEditor.toggleRow,
  };
}
