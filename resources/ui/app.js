// Sendproof workbench entry point. It loads the capabilities and OpenAPI document, renders the
// shell, and routes between the four views of the approved design: the API overview, Try it,
// Docs and a model page. Feature modules own their own markup; this file wires events to them.
import { showSignIn } from './signin.js';
import { loadFieldModules } from './field-modules.js';
import { createRequestEditor } from './request-editor.js';
import { createNavigation } from './navigation.js';
import { createSidebar } from './sidebar.js';
import { createResults } from './results.js';
import { operations, dereference } from './api.js';
import { esc, shell } from './view.js';
import { stateBlock, icon, copyTextButton } from './components.js';
import { formatRequest } from './snippets.js';
import { createLayout } from './layout.js';
import { createIssues } from './issues.js';
import { matchesShortcut, shortcutAttrs, shortcutHint } from './shortcuts.js';
import { showShortcuts } from './shortcuts-sheet.js';
import { createCommands } from './commands.js';
import { applySettings, getSettings, resolvedTheme, tracedSendEnabled, updateSettings } from './settings.js';
import { current, loadLanguage, t, th } from './i18n.js';
import { copyText } from './copy.js';
import { openDisplaySettings } from './display-settings.js';
import { openHistory } from './history-popover.js';
import { closePopover } from './popover.js';
import { openCoverage } from './coverage-popover.js';
import { documentedExample, newDocsState, renderDocs } from './docs-view.js';
import { renderModel } from './model-view.js';
import { renderOverview } from './overview-view.js';
import { schemaName as nameOfSchema } from './schema-model.js';
import { bindToggletips } from './toggletip.js';
import { backTarget, createHistory, followModel, formatRoute, isJourneyRoute, parseRoute } from './router.js';
import { createJourneys } from './journeys.js';
import { findOperation, opKey } from './operations.js';
import { contextBar } from './context-bar.js';
import { watchCrumbs } from './crumb-fit.js';
import { watchBars } from './bar-fit.js';
import { openSeededMenu } from './seeded-menu.js';
import { resolvePersonaAccess } from './personas.js';
import { carriedValues, replacements } from './deprecation.js';

applySettings();
watchCrumbs();
watchBars();
const root = document.querySelector('#app');
for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
const loadingShell = root.firstElementChild.cloneNode(true);
const basePath = new URL('../', document.baseURI).pathname;
const state = {
  cap: null, doc: null, ops: [], op: null, forms: [], bodyForm: null, body: undefined,
  tab: 'Form', resultTab: 'Response', result: null, history: [], headers: [], documentUrl: null,
  view: 'overview', model: null, modelFrom: null, route: { kind: 'overview' }, samples: [], mode: 'spec',
};
const $ = selector => document.querySelector(selector);
let documentLoad = 0;
let startup = 0;
let layout;
let signInEntry = location.pathname.endsWith('/signin.html');
/** Browser history for the workbench's routes (see router.js). */
let nav;
/** What each operation's Docs page remembers (open responses, expanded rows) while the session lasts. */
const docsMemory = new Map();
const issues = createIssues({ $, selectTab: selectRequestTab });

const {
  renderOperation, readRequest, fillSample, autofill, addHeader, removeHeader, showBulkHeaders, toggleHeader,
  generateField, fieldCount,
} = createRequestEditor({
  state, basePath, $, updateSnippet: () => {}, onLookupPreview: () => run(true), onHeadersChange: refreshIssues,
  sensitiveNames, onFilled: count => renderBarStatus(count), onRendered: () => journeys?.decorateStep(),
});
const {
  renderResult, renderBar, run, showError, copyFailedRequest, copyCurl, cancel, cancelConfirmation, previewAvailable,
} = createResults({
  state, basePath, $, readRequest, sensitiveNames, renderOperation, issues, selectView: setPane, onFollowUp: followUp,
  schemaName: schema => nameOfSchema(schema, state.doc), fillable: () => fieldCount() > 0,
  onCompleted: (result, { preview }) => { if (!preview && state.op?.method !== 'GET') refreshIdentity(); },
  journey: () => journeys?.hooks(), databaseExtra: () => journeys?.copyCSharpButton() ?? '',
});
/** Journeys mode (journeys.js): only when capabilities list journeys or Preview sessions. */
const journeys = createJourneys({
  state, $, basePath, results: { run, renderResult, renderBar }, navigate: (route, options) => navigate(route, options),
  openOperation: openJourneyOperation, announce: text => { const slot = $('[data-request-announcement]'); if (slot) slot.textContent = text; },
  refreshIdentity: () => refreshIdentity(),
});
journeys.setReadRequest(() => readRequest());
journeys.setRedraw(() => redrawJourneys());
const sidebar = createSidebar({ state, $, journeys: journeys.sidebar });
const { palette } = createNavigation({
  state, $, selectOperation, run, renderOperation, openModel: name => openModel(name), commands: () => commandRegistry.available(),
});
const commandRegistry = createCommands({
  state, $, chooseTab: selectRequestTab, chooseResult: selectResultTab, chooseOperation: selectOperation,
  fill: async mode => { cancelConfirmation(); await fillSample(mode); refreshIssues(); },
  preview: () => runRequest(true), send: () => runRequest(false, !!$('[data-action="confirm-send"]')), journeys,
  copyResponse: () => $('.response [data-action="copy-response"]')?.click(),
  openPalette: palette, openSheet: () => showShortcuts($('#overlay')), openSidebar: toggleNavigation,
  changePane: setPane, issues, addHeader, bulkEdit: showBulkHeaders, toggleHeader,
  openDisplay: () => $('#display-btn') && openDisplaySettings($('#display-btn'), { onLanguage: rerender }),
  openHistory: () => showHistory(),
  toggleTheme: () => updateSettings({ theme: resolvedTheme() === 'dark' ? 'light' : 'dark' }),
  toggleDocs: () => setView(state.view === 'docs' ? 'try' : 'docs'),
  sidebarTab: tab => { if (matchMedia('(max-width: 56rem)').matches) setNavigation(true); sidebar.selectTab(tab, { focusFilter: true }); },
  modelBack: () => modelBack(),
  generate: (target, menu) => generateField(target, menu),
  toggleTrace: () => setTraced(!tracedSendEnabled(state.cap)),
  traceAvailable: () => state.cap?.observedSend === true && previewAvailable(),
  reloadSpec: () => start(),
  canReload: () => !state.doc,
});

/**
 * After a committing Send (such as signing in or out through the API's own endpoints), ask
 * discovery who we are now, so the top bar, locks and notices never describe a stale session.
 */
async function refreshIdentity() {
  try {
    const response = await fetch('./_api/capabilities', { credentials: 'include', redirect: 'error' });
    if (!response.ok) return;
    const capabilities = await response.json();
    if (JSON.stringify(capabilities.identity ?? null) === JSON.stringify(state.cap.identity ?? null)) return;
    state.cap = { ...state.cap, identity: capabilities.identity };
    const focused = document.activeElement?.id;
    renderShell();
    setPane('response');
    if (focused) document.getElementById(focused)?.focus();
  } catch { /* Discovery is advisory here; the result stays as it is. */ }
}

/** Settings that change text (language, digits) re-render the shell in place. */
function rerender() {
  if (!state.doc) return;
  const focused = document.activeElement?.id;
  renderShell();
  if (focused) document.getElementById(focused)?.focus();
}

async function start() {
  const generation = ++startup;
  // The UI language's catalogue loads before anything is drawn in it (English is bundled).
  if (!current().loaded) {
    await loadLanguage(getSettings().language);
    applySettings();
    for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  }
  if (!root.firstElementChild?.classList.contains('loading-shell')) {
    layout?.destroy();
    root.replaceChildren(loadingShell.cloneNode(true));
  }
  try {
    const response = await fetch('./_api/capabilities', { credentials: 'include', redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error(t('boot.capabilitiesStatus', { status: response.status })), { status: response.status, url: './_api/capabilities' });
    const capabilities = await response.json();
    if (generation !== startup) return;
    if (capabilities.protocolVersion !== 1 || !capabilities.openApiUrl) throw new Error(t('boot.unsupported'));
    state.cap = capabilities;
    // Ask the host whether it offers seeded accounts to this browser while the document loads, so
    // the shell is drawn once with the answer and the option never appears and then vanishes.
    const personaAccess = resolvePersonaAccess(capabilities);
    // A login entry point must also work when the OpenAPI document requires a session.
    if (signInEntry) {
      signInEntry = false;
      state.cap = await personaAccess;
      if (generation !== startup) return;
      const back = () => { history.replaceState(null, '', new URL('./', location.href)); return start(); };
      showSignIn(root, state.cap, back, back);
      return;
    }
    await loadFieldModules(capabilities.fieldModules);
    if (generation !== startup) return;
    if (!(await loadDocument(state.cap.openApiUrl)) || generation !== startup) return;
    state.cap = await personaAccess;
    if (generation !== startup) return;
    routeFromAddress();
    renderShell();
    // "Sign in and retry" runs the same request again once the session exists.
    if (state.retryAfterSignIn && state.cap.identity && state.view === 'try') {
      state.retryAfterSignIn = false;
      run(false);
    }
  } catch (error) {
    if (generation !== startup) return;
    showBootError(error);
  }
}

/** The OpenAPI document (or capabilities) failed to load (mock 40). */
function showBootError(error) {
  const canSignIn = [401, 403].includes(error.status) && state.cap?.authProviders?.length;
  const url = error.url || state.cap?.openApiUrl;
  const details = `${error.message}${url ? `\nGET ${url}` : ''}`;
  root.innerHTML = `<div class="app">
    <header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">${icon('mark')}</span><span class="desktop-only">${esc(t('app.name'))}</span></div>
      <span class="crumb-sep desktop-only" aria-hidden="true">/</span><span class="api-switch"><span class="name" lang="en">${esc(state.cap?.apiName || '')}</span></span><span class="spacer"></span></header>
    <div class="workspace">
      <nav class="sidebar" aria-label="${esc(t('side.operations'))}"><div class="nav">${stateBlock({ glyph: 'list', compact: true, title: esc(t('boot.noOperations')), body: esc(t('boot.noOperationsBody')) })}</div><div class="pane-bar side-bar"></div></nav>
      <main class="pane request" id="request" style="grid-column: 2 / -1"><div class="pane-scroll">${stateBlock({
        glyph: 'alert', tone: 'danger', center: true, heading: 'h1', role: 'alert', title: esc(t('boot.title')),
        body: th(error.status ? 'boot.bodyStatus' : 'boot.body', { request: `<code class="ltr">GET ${esc(url ? new URL(url, location.href).pathname : '')}</code>`, status: `<strong>${esc(error.status ?? '')}</strong>`, message: esc(error.message) }),
        why: esc(t(error.status === 401 || error.status === 403 ? 'boot.whyAuth' : 'boot.why')),
        actions: [
          `<button type="button" class="btn btn-primary" data-action="restart" ${shortcutAttrs('reload-spec')}>${icon('refresh', true)}${esc(t('res.tryAgain'))} ${shortcutHint('reload-spec')}</button>`,
          canSignIn ? `<button type="button" class="btn" data-action="signin">${icon('log-in', true)}${esc(t('shell.signIn'))}</button>` : '',
          url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(t('boot.open', { url: new URL(url, location.href).pathname }))}</a>` : '',
          copyTextButton(t('boot.copy'), { action: 'copy-boot-error', cls: '', data: `data-copy="${esc(details)}"` }),
        ].filter(Boolean),
      })}</div></main>
    </div>
    <div class="sr-only" role="status" aria-live="polite" data-request-announcement></div>
  </div>`;
}

async function loadDocument(url) {
  cancel();
  const generation = ++documentLoad;
  const response = await fetch(url, { credentials: 'include', redirect: 'error' });
  if (!response.ok) throw Object.assign(new Error(t('boot.documentStatus', { status: response.status })), { status: response.status, url });
  const document = await response.json();
  if (generation !== documentLoad) return false;
  Object.assign(state, {
    doc: document, documentUrl: url, ops: operations(document), body: undefined, paramValues: {}, json: undefined,
    headers: [], tab: 'Form', bodyMode: 'Form', history: [], lastResponse: undefined, lookupCache: new Map(),
    autofilled: undefined, canUndoAutofill: false, result: null, view: 'overview', model: null, modelFrom: null,
    route: { kind: 'overview' }, samples: [],
  });
  docsMemory.clear();
  state.op = state.ops[0] || null;
  return true;
}

/**
 * Makes `state` show a route: the operation, the model and where the model came from. A route
 * that names something missing from this document falls back to the overview. Returns the
 * route that is really shown. Operation inputs are kept when the route stays on the same
 * operation (Try it ⇄ Docs) and reset when it moves to another one.
 */
function applyRoute(route, { reset } = {}) {
  if (isJourneyRoute(route)) {
    if (journeys.enabled()) return (state.route = journeys.applyRoute(route));
    route = { kind: 'overview' };
  }
  // Leaving Journeys mode from a step starts a fresh draft, so no bound value or journey bar stays behind.
  if (state.mode === 'journeys') { state.mode = 'spec'; if (state.view === 'try') reset ??= {}; }
  let shown = route;
  if (route.kind === 'op' || route.kind === 'docs') {
    const op = findOperation(state.ops, route.id);
    if (!op) shown = { kind: 'overview' };
    else {
      if (op !== state.op || reset) resetOperation(op, reset ?? {});
      state.view = route.kind === 'docs' ? 'docs' : 'try';
    }
  } else if (route.kind === 'model') {
    if (!state.doc.components?.schemas?.[route.name]) shown = { kind: 'overview' };
    else {
      const origin = route.from && findOperation(state.ops, route.from.id);
      state.view = 'model';
      state.model = route.name;
      state.modelFrom = origin ? { op: origin, kind: route.from.kind } : null;
      // A model opened from an operation keeps that operation as its context.
      if (origin && origin !== state.op) resetOperation(origin, {});
      // With no operation to mark, the Models tab is where the model is listed.
      if (!origin) { shown = { kind: 'model', name: route.name }; sidebar.setTab('models'); }
    }
  }
  if (shown.kind === 'overview') { state.view = 'overview'; state.modelFrom = null; }
  state.route = shown;
  return shown;
}

/** Starts a fresh draft for an operation (inputs, result, issues). */
function resetOperation(op, parameters) {
  if ($('#context')) cancel();
  Object.assign(state, {
    op, body: undefined, autofilled: undefined, canUndoAutofill: false, json: undefined,
    paramValues: { ...parameters }, headers: [], bodyMode: 'Form', result: null,
    tab: Object.keys(parameters).some(key => /^(path|query|cookie):/.test(key)) ? 'Params' : 'Form',
  });
  // Before the shell exists (a deep link on load) renderShell draws everything from state.
  if (!$('#context')) return;
  renderOperation();
  issues.clear();
  renderBar();
  renderResult();
}

/** The scroll offsets of the main and right columns of the page on screen. */
function currentScroll() {
  const read = name => document.querySelector(`.workspace > .pane:not([hidden]) [data-scroll="${name}"]`)?.scrollTop ?? 0;
  return { main: read('main'), aside: read('aside') };
}

function restoreScroll(scroll) {
  const write = (name, value) => { const node = document.querySelector(`.workspace > .pane:not([hidden]) [data-scroll="${name}"]`); if (node) node.scrollTop = value ?? 0; };
  write('main', scroll?.main);
  write('aside', scroll?.aside);
}

/**
 * Goes to a route: pushes a history entry (saving where the page being left was scrolled) and
 * shows it from the top. `reset` starts a fresh draft of the operation with those parameters.
 */
function navigate(route, { reset, focus = true, replace = false } = {}) {
  closePopover();
  nav.saveScroll(currentScroll());
  nav.go(route, { replace });
  const shown = applyRoute(route, { reset });
  if (shown.kind !== route.kind || shown.name !== route.name) nav.go(shown, { replace: true });
  if ((route.kind === 'op' || route.kind === 'docs') && state.mode !== 'journeys') { if (sidebar.tab !== 'operations') sidebar.selectTab('operations'); }
  applyView();
  restoreScroll();
  if (focus) focusPage();
}

/** Moves focus to the page's heading, so keyboard and screen reader users land on the new page. */
function focusPage() {
  const heading = state.view === 'try' ? $('#op-title') || $('#request') : $('#doc-pane h1') || $('#doc-pane');
  heading?.focus?.({ preventScroll: true });
}

/** The route a view change on the current operation means. */
function routeFor(view) {
  if (view === 'overview' || !state.op) return { kind: 'overview' };
  return { kind: view === 'docs' ? 'docs' : 'op', id: opKey(state.op) };
}

/** Browser Back and Forward: show the entry's page and put its scroll position back. */
function onPopState(event) {
  if (!state.doc) return;
  closePopover();
  applyRoute(parseRoute(location.hash));
  applyView();
  restoreScroll(event.state?.scroll);
  setNavigation(false);
}

/** Reads the address on load and shows that page (deep links and reloads). */
function routeFromAddress() {
  nav = createHistory();
  const route = parseRoute(location.hash);
  const shown = applyRoute(route);
  if (shown.kind !== route.kind || shown.name !== route.name) nav.go(shown, { replace: true });
}

function renderShell() {
  layout?.destroy();
  root.innerHTML = shell(state.cap, state.doc.info);
  layout = createLayout($('.workspace'), state.documentUrl);
  if ((state.cap.documents || []).length > 1) {
    $('.api-switch').outerHTML = `<select class="api-switch" aria-label="${esc(t('shell.apiDocument'))}">${state.cap.documents.map(d =>
      `<option value="${esc(d.url)}" ${d.url === state.documentUrl ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`;
    $('.api-switch').addEventListener('change', async event => {
      const expectedLoad = documentLoad + 1;
      try {
        if (!(await loadDocument(event.target.value))) return;
        renderShell();
      } catch (error) {
        if (documentLoad === expectedLoad) showBootError(error);
      }
    });
  }
  $('#filter').addEventListener('input', () => sidebar.render());
  $('#filter').addEventListener('keydown', event => {
    if (event.key === 'Escape' && event.target.value) { event.preventDefault(); event.stopPropagation(); clearFilter(); }
  });
  bindToggletips(root);
  sidebar.render();
  renderOperation();
  issues.clear();
  renderBar();
  renderResult();
  applyView();
  journeys.load();
}

/** A journey step opens its operation's own screen with its bound values (journeys.js). */
function openJourneyOperation(op, parameters, body) {
  resetOperation(op, parameters);
  state.body = body;
  state.tab = Object.keys(parameters).some(key => /^(path|query|cookie):/.test(key)) ? 'Params' : 'Form';
  if ($('#context')) renderOperation();
}

/** Preview and Send: a journey step runs as a step of its run; anything else as before. */
async function runRequest(preview, confirmed = false) {
  // ⌘↵ and ⇧⌘↵ press the bar's own buttons in Journeys mode: Preview run or Send run on an
  // overview or summary (Send run when the journey is Send only), Preview step N+1 after a step.
  if (state.view === 'journey' || state.view === 'jrun') {
    const bar = $('#doc-pane .actionbar');
    (bar?.querySelector(preview ? '[data-action="journey-preview-run"]' : '[data-action="journey-send-run"]:not(.btn-primary)')
      ?? (preview ? bar?.querySelector('[data-action="journey-send-run"].btn-primary') : null))?.click();
    return;
  }
  const next = preview && journeys.stepActive() && $('.actionbar [data-action="journey-next-run"]:not(:disabled)');
  if (next) { next.click(); return; }
  if (!confirmed && journeys.stepActive() && (await journeys.runStep(preview))) return;
  return run(preview, confirmed);
}

/** After a journey run changes: the sidebar's rail, the step's strip, bar and result, or the reading panes. */
function redrawJourneys() {
  if (!$('.workspace')) return;
  if (state.view === 'journey' || state.view === 'jrun') {
    const scroll = currentScroll();
    journeys.renderReading($('#doc-pane'), $('#aside-pane'));
    for (const pane of [$('#doc-pane'), $('#aside-pane')]) for (const node of pane.querySelectorAll('.pane-scroll')) node.dataset.scroll = pane.id === 'doc-pane' ? 'main' : 'aside';
    restoreScroll(scroll);
  } else if (state.view === 'try') {
    const context = journeys.stepChrome();
    if (context) $('#context').innerHTML = context;
    renderBar();
    renderResult();
  }
  sidebar.render();
}

/**
 * Shows the page in state.view. Try it keeps its request and result panes; Docs, Models and the
 * overview fill the same two columns with a reading pane and an aside pane, so the sidebar, the
 * dividers and the head and bottom lines never move between views.
 */
function applyView() {
  const workspace = $('.workspace');
  const reading = state.view !== 'try';
  const main = $('#doc-pane');
  const aside = $('#aside-pane');
  workspace.classList.toggle('docs-mode', reading);
  $('#request').hidden = reading;
  $('.response').hidden = reading;
  main.hidden = aside.hidden = !reading;
  // Journeys' reading views keep the phone's pane switch (mock m33): the journey or summary, then its runs.
  const journeyReading = state.view === 'journey' || state.view === 'jrun';
  $('.mobile-switch').hidden = reading && !journeyReading;
  workspace.classList.toggle('j7-reading', journeyReading);
  // A new journey page starts at its top: on a phone the workspace itself scrolls.
  if (journeyReading && (state.shownView !== state.view || state.shownRoute !== formatRoute(state.route))) { setPane('request'); workspace.scrollTop = 0; }
  state.shownRoute = formatRoute(state.route);
  state.shownView = state.view;
  const paneNames = journeys.paneNames(state.view);
  for (const button of document.querySelectorAll('.mobile-switch [data-view]')) button.textContent = paneNames[button.dataset.view === 'request' ? 0 : 1];
  const route = state.route;
  const ui = state.op ? docsMemory.get(opKey(state.op)) ?? docsMemory.set(opKey(state.op), newDocsState()).get(opKey(state.op)) : newDocsState();
  const context = { state, route, ui, samples: state.samples, $, basePath };
  if (state.view === 'docs') { renderDocs(main, aside, context); main.setAttribute('aria-labelledby', 'doc-title'); aside.setAttribute('aria-label', t('docs.aside')); }
  else if (state.view === 'model') { renderModel(main, aside, context); main.setAttribute('aria-labelledby', 'model-title'); aside.setAttribute('aria-label', t('model.aside')); }
  else if (state.view === 'overview') { renderOverview(main, aside, context); main.setAttribute('aria-labelledby', 'ov-title'); aside.setAttribute('aria-label', t('overview.start')); }
  else if (state.view === 'journey' || state.view === 'jrun') { journeys.renderReading(main, aside); main.setAttribute('aria-labelledby', 'jr-title'); aside.setAttribute('aria-label', t('jr.runs')); }
  else {
    main.replaceChildren();
    aside.replaceChildren();
    $('#context').innerHTML = journeys.stepChrome() ?? contextBar(state.op ? { kind: 'op', op: state.op, view: 'try' } : { kind: 'overview' });
  }
  if (state.view !== 'try') journeys.stepChrome();
  // A journey step draws its own bar and Expected tab; leaving one puts the operation's back.
  if (state.view === 'try') { renderBar(); renderResult(); }
  journeys.markMode();
  for (const pane of [main, aside]) for (const node of pane.querySelectorAll('.pane-scroll')) node.dataset.scroll = pane === main ? 'main' : 'aside';
  $('#request .pane-scroll').dataset.scroll = 'main';
  $('.skip-link').setAttribute('href', reading ? '#doc-pane' : '#request');
  layout?.refresh();
  sidebar.render();
}

/** Switches between the overview, Try it and Docs of the current operation. */
function setView(view, { focus = false } = {}) {
  closePopover();
  navigate(routeFor(view), { focus });
}

/** Opens a model page from the Models tab, the palette or a link without an operation. */
function openModel(name) {
  if (!state.doc.components?.schemas?.[name]) return;
  navigate({ kind: 'model', name });
}

/** Back from a model page: to the page it was opened from, restoring that page's scroll position. */
function modelBack() {
  const target = state.view === 'model' ? backTarget(state.route) : null;
  if (!target) return false;
  // When the browser's previous entry is that page, going back restores its scroll position;
  // after a reload or a deep link there is no such entry, so Back pushes the page instead.
  if (nav.previousIs(formatRoute(target.route))) nav.back();
  else navigate(target.route);
}

function sensitiveNames() {
  return Object.values(state.doc?.components?.securitySchemes || {})
    .map(scheme => dereference(scheme, state.doc))
    .filter(scheme => scheme?.type === 'apiKey' && scheme.name)
    .map(scheme => scheme.name);
}

/**
 * Opens an operation in Try it or Docs. `parameters` start a fresh draft with those values (used
 * by "open in" follow-ups); without them the draft is kept when the operation is already open.
 */
function selectOperation(index, parameters, view = 'try') {
  const op = state.ops[index];
  if (!op) return;
  cancel();
  setNavigation(false);
  setPane('request');
  navigate({ kind: view === 'docs' ? 'docs' : 'op', id: opKey(op) }, { reset: parameters });
}

function followUp(operation, parameters) {
  const index = state.ops.findIndex(item => item.method === operation.method && item.path === operation.path);
  if (index < 0) return;
  selectOperation(index, parameters);
  $('#request').focus();
}

/** On mobile, one pane at a time: the Request/Result switch. */
function setPane(view, focus = false) {
  const workspace = $('.workspace');
  if (!workspace) return;
  // The mock's mobile rule hides the other pane by data-view="request" | "result".
  workspace.dataset.view = view === 'response' ? 'result' : view;
  for (const button of document.querySelectorAll('.mobile-switch button'))
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  if (focus) (view === 'request' ? $('#request') : $('.response')).focus();
}

/** Opens or closes the sidebar drawer on a phone. The drawer is the same sidebar. */
function setNavigation(open) {
  const side = $('.sidebar');
  if (!side) return;
  side.classList.toggle('is-drawer', open);
  $('.drawer-scrim')?.remove();
  if (open) side.after(Object.assign(document.createElement('div'), { className: 'drawer-scrim' }));
  const button = $('[data-action="navigation"]');
  button?.setAttribute('aria-expanded', String(open));
  button?.setAttribute('aria-label', t(open ? 'shell.closeOperations' : 'shell.openOperations'));
  if (open) $('#filter').focus();
}

function toggleNavigation(open) {
  if (matchMedia('(max-width: 56rem)').matches) {
    setNavigation(open ?? !$('.sidebar').classList.contains('is-drawer'));
  } else {
    const workspace = $('.workspace');
    const show = open ?? workspace.dataset.sidebar === 'closed';
    workspace.dataset.sidebar = show ? 'open' : 'closed';
    layout.refresh();
    if (show && open === true) $('#filter').focus();
  }
}

function selectRequestTab(next, { focus = false, report = true } = {}) {
  if (next === 'Body') next = state.bodyMode || 'Form';
  const nextBody = next === 'Form' || next === 'JSON';
  if (state.forms.some(form => form.hasParseErrors())) {
    $('#editor textarea[aria-invalid=true]')?.focus();
    return;
  }
  if (next === 'Form' && state.json !== undefined) {
    try {
      state.body = state.json.trim() ? JSON.parse(state.json) : undefined;
      state.json = undefined;
    } catch {
      if (state.tab !== 'JSON') { state.tab = 'JSON'; renderOperation(); }
      issues.show([{ path: '$', message: t('req.fixJson') }]);
      $('#json').focus();
      return;
    }
  }
  state.tab = next;
  if (nextBody) state.bodyMode = next;
  if (state.view !== 'try') setView('try');
  renderOperation();
  if (report) refreshIssues();
  if (focus) (nextBody ? $(`[data-body-mode="${next}"]`) : $(`[data-request-tab="${next}"]`))?.focus();
}

function selectResultTab(tab, focus = false) {
  if ($('.response').getAttribute('aria-busy') === 'true' && !state.running) return;
  state.resultTab = tab;
  renderResult();
  if (focus) $(`[data-result-tab="${tab}"]`)?.focus();
}

function refreshIssues() {
  if (!issues.active) return;
  if (issues.server) { issues.annotate(); return; }
  try {
    readRequest();
    issues.clear();
  } catch (error) {
    if (error.validation) issues.show(error.issues);
  }
}

/** After generated values, the status line says how many and offers Undo. */
function renderBarStatus(count) {
  if (count) $('.actionbar .status')?.replaceWith(Object.assign(document.createElement('template'), {
    innerHTML: `<span class="status is-ok" role="status">${icon('wand', true)}<span>${esc(t('bar.filled', { n: count }))}</span><button type="button" class="btn btn-ghost btn-xs" data-action="undo-fill" ${shortcutAttrs('autofill-undo')}>${esc(t('bar.undo'))} ${shortcutHint('autofill-undo')}</button></span>`,
  }).content.firstElementChild);
  else renderBar();
}

function setTraced(on) {
  updateSettings({ tracedSend: on });
  renderResult();
  $('[data-request-announcement]').textContent = t(on ? 'res.tracedOnDone' : 'res.tracedOffDone');
}

function clearFilter() {
  const input = $('#filter');
  input.value = '';
  sidebar.render();
  input.focus();
}

function showHistory(button) {
  const anchor = button?.isConnected ? button : $('#history-btn')?.getClientRects().length ? $('#history-btn') : $('.result-bar [data-action="history"]');
  if (!anchor) return palette(true);
  openHistory(anchor, { state, replay: replayHistory });
}

function replayHistory(entry) {
  const index = state.ops.findIndex(op => op.method === entry.op.method && op.path === entry.op.path);
  if (index < 0) return;
  selectOperation(index);
  state.body = structuredClone(entry.body);
  state.paramValues = structuredClone(entry.params);
  state.headers = structuredClone(entry.headers || []);
  renderOperation();
}

function openSignIn() {
  cancel();
  closePopover();
  layout?.destroy();
  startup++;
  documentLoad++;
  state.history = [];
  state.result = null;
  const back = () => start();
  showSignIn(root, state.cap, back, back, { confirmPersona: user => journeys.confirmPersona(user) });
}

/**
 * "Try it" in the Docs bar: opens the operation with the documented example in the request body,
 * unless the user already typed something there.
 */
function openDocumentedExample() {
  const op = state.op;
  navigate(routeFor('try'));
  const body = op && dereference(op.operation.requestBody, state.doc);
  const media = body?.content?.['application/json'] ?? Object.values(body?.content || {})[0];
  if (media?.schema && state.body === undefined && state.json === undefined) {
    state.body = structuredClone(documentedExample(media, state.doc, state.samples));
    renderOperation();
  }
}

/** Copies the URL with path parameters shown as {name}, exactly as documented. */
function copyUrl(button) {
  const source = $('.urlbar .url');
  const url = [...source.childNodes].map(node => node.dataset?.pathParam ? '{' + node.dataset.pathParam + '}' : node.textContent).join('');
  return copyText(url, { button, what: t('copy.what.url'), select: source, notice: $('.urlbar') });
}

const handlers = {
  restart: () => start(),
  navigation: () => toggleNavigation(),
  palette: () => palette(),
  history: button => showHistory(button),
  coverage: button => openCoverage(button, { capabilities: state.cap }),
  // On a phone the docked Preview reason shows its title and the author's reason; "Why?" adds the rest.
  'dock-why': button => { const open = button.getAttribute('aria-expanded') !== 'true'; button.setAttribute('aria-expanded', String(open)); button.closest('[data-preview-dock]')?.classList.toggle('is-open', open); },
  shortcuts: () => showShortcuts($('#overlay')),
  display: button => openDisplaySettings(button, { onLanguage: rerender }),
  close: () => { $('#overlay').innerHTML = ''; },
  signin: () => openSignIn(),
  'signin-retry': () => { state.retryAfterSignIn = true; openSignIn(); },
  'cancel-request': () => cancel(),
  'retry-request': () => state.result?.network && run(state.result.preview),
  'copy-failed-curl': button => copyFailedRequest(button),
  'copy-curl': button => copyCurl(button),
  'copy-url': button => copyUrl(button),
  'copy-boot-error': button => copyText(button.dataset.copy, { button, what: t('copy.what.error') }),
  'cancel-confirm': () => cancelConfirmation(),
  'confirm-send': () => run(false, true),
  issues: () => issues.toggle(),
  sample: button => autofill(button, refreshIssues),
  'undo-fill': async () => { await fillSample('undo'); refreshIssues(); },
  send: () => runRequest(false),
  preview: () => runRequest(true),
  'view-try': () => setView('try', { focus: true }),
  'view-docs': () => setView('docs', { focus: true }),
  'docs-try': () => openDocumentedExample(),
  'seeded-menu': button => openSeededMenu(button, { capabilities: state.cap, onSignedIn: () => refreshIdentity(), confirmPersona: user => journeys.confirmPersona(user) }),
  'toggle-groups': () => sidebar.toggleAll(),
  'traced-on': () => setTraced(true),
  'traced-off': () => setTraced(false),
  'clear-filter': () => clearFilter(),
  overview: () => setView('overview', { focus: true }),
  'model-back': () => modelBack(),
  'add-header': () => addHeader(),
  'remove-header': button => removeHeader(button.closest('[data-header-row]')?.dataset.headerId),
};

root.addEventListener('click', async event => {
  if (event.target.closest('#editor') || event.target.closest('[data-action="sample"]')) cancelConfirmation();
  if (journeys.click(event)) return;
  // Links that are plain navigation keep the browser's own behaviour for new tabs and windows.
  const plain = !(event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  const crumb = event.target.closest('[data-crumb-route]');
  if (crumb && plain) { event.preventDefault(); navigate(parseRoute(new URL(crumb.href).hash)); return; }
  const tag = event.target.closest('[data-crumb-tag]');
  if (tag) { event.preventDefault(); sidebar.reveal('ops', tag.dataset.crumbTag); return; }
  const modelsCrumb = event.target.closest('[data-crumb-models]');
  if (modelsCrumb) { event.preventDefault(); sidebar.selectTab('models'); $('#side-tab-models')?.focus(); return; }
  const modelGroup = event.target.closest('[data-crumb-model-group]');
  if (modelGroup) { event.preventDefault(); sidebar.reveal('models', modelGroup.dataset.crumbModelGroup); return; }
  // "Open Get balance" on a deprecated operation: the replacement, with matching inputs carried over.
  const replace = event.target.closest('[data-replace-op]');
  if (replace) {
    event.preventDefault();
    const target = state.ops[Number(replace.dataset.replaceOp)];
    const replacement = state.op && replacements(state.op, state.ops, state.doc).find(item => item.op === target);
    selectOperation(Number(replace.dataset.replaceOp), replacement ? carriedValues(replacement, state.paramValues || {}) : undefined, 'try');
    $('#request')?.focus();
    return;
  }
  const op = event.target.closest('[data-op], [data-op-docs]');
  if (op && !(op.matches('a') && !plain)) {
    event.preventDefault();
    const fromDrawer = $('.sidebar').classList.contains('is-drawer');
    const docs = op.dataset.opDocs !== undefined || op.dataset.opView === 'docs' || (state.view === 'docs' && op.closest('.sidebar'));
    selectOperation(Number(op.dataset.op ?? op.dataset.opDocs), undefined, docs ? 'docs' : 'try');
    if (fromDrawer && !docs) $('#request').focus();
    return;
  }
  const picked = event.target.closest('[data-pick-model]');
  if (picked && plain) {
    event.preventDefault();
    setNavigation(false);
    openModel(picked.dataset.pickModel);
    return;
  }
  const model = event.target.closest('[data-model]');
  if (model && plain) {
    event.preventDefault();
    navigate(followModel(state.route, model.dataset.model));
    return;
  }
  const sideTab = event.target.closest('[data-side-tab]');
  if (sideTab) { sidebar.selectTab(sideTab.dataset.sideTab); sideTab.focus(); return; }
  const suggestion = event.target.closest('[data-filter-suggestion]');
  if (suggestion) { $('#filter').value = suggestion.dataset.filterSuggestion; sidebar.render(); $('#filter').focus(); return; }
  const heading = event.target.closest('.nav-heading');
  if (heading) { sidebar.toggleGroup(heading); return; }
  if (event.target.classList?.contains('drawer-scrim')) { setNavigation(false); $('[data-action="navigation"]')?.focus(); return; }
  const pane = event.target.closest('.mobile-switch [data-view]');
  if (pane) { setPane(pane.dataset.view); return; }
  const pathToken = event.target.closest('[data-path-param]');
  if (pathToken) {
    selectRequestTab('Params');
    const parameter = [...document.querySelectorAll('[data-parameter-name]')].find(node => node.dataset.parameterName === pathToken.dataset.pathParam);
    // A path token focuses its field; a lookup or select opens its list too.
    const control = parameter?.querySelector('input, textarea, [role="combobox"], [role="radio"][tabindex="0"]') ?? parameter?.querySelector('.control button');
    control?.focus();
    control?.openOptions?.();
    return;
  }
  const requestTab = event.target.closest('[data-request-tab]');
  if (requestTab) { selectRequestTab(requestTab.dataset.requestTab); $(`[data-request-tab="${requestTab.dataset.requestTab}"]`)?.focus(); return; }
  const bodyMode = event.target.closest('[data-body-mode]');
  if (bodyMode) { selectRequestTab(bodyMode.dataset.bodyMode, { focus: true }); return; }
  const resultTab = event.target.closest('[data-result-tab]');
  if (resultTab) { selectResultTab(resultTab.dataset.resultTab, true); return; }
  const button = event.target.closest('[data-action]');
  const handler = handlers[button?.dataset.action];
  if (handler) {
    if (button.tagName === 'A') event.preventDefault();
    await handler(button);
  }
});
root.addEventListener('input', event => {
  if (!event.target.closest('#editor')) return;
  cancelConfirmation();
  if (issues.server) issues.edit(event.target);
  else refreshIssues();
});
root.addEventListener('change', event => {
  if (!event.target.closest('#editor')) return;
  cancelConfirmation();
  refreshIssues();
});
addEventListener('popstate', onPopState);

document.addEventListener('keydown', event => {
  if (journeys.keydown(event)) return;
  if (!state.doc && matchesShortcut('reload-spec', event) && $('[data-action="restart"]')) { event.preventDefault(); start(); return; }
  if (!$('.workspace') || event.defaultPrevented || event.isComposing) return;
  const tab = event.target.closest?.('[role="tab"]');
  const rtl = document.documentElement.dir === 'rtl';
  const tabKey = ['left', 'right', 'home', 'end'].find(id => matchesShortcut(id, event));
  if (tab && tabKey) {
    const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(tab);
    const forward = (tabKey === 'right') !== rtl;
    const next = tabKey === 'home' ? 0 : tabKey === 'end' ? tabs.length - 1 : (index + (forward ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next].click();
    tabs[next].focus();
    return;
  }
  if (matchesShortcut('escape', event)) {
    if ($('#issues')) issues.close(true);
    else if ($('.sidebar')?.classList.contains('is-drawer')) { setNavigation(false); $('[data-action="navigation"]').focus(); }
    else cancel();
    return;
  }
  commandRegistry.handle(event);
});

start();
