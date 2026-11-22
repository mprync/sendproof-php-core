// Runs requests and renders the result pane. All five tabs always exist; each shows captured
// data, a zero state, or why nothing was captured (mock: results.js). Clipboard problems are
// reported where the copy happened and never replace the pane.
import { esc, tab as tabButton } from './components.js';
import { dereference, execute, RequestTransportError, transportRequest } from './api.js';
import {
  RESULT_TABS, beforeRun, captured, errorHeader, idleHeader, loadingBody, networkError, networkHeader,
  notCaptured, rejectedEarly, requestError, responseHeader, resultBar, resultCounts, resultTabLabel, runningHeader,
  unauthorized, zeroState,
} from './result-states.js';
import { blockedHeader, blockedMarkup, blockedTab, bindBlocked } from './result-blocked.js';
import { previewUnavailable as unavailableEntry, storeName } from './stores.js';
import { bindDatabase, databaseMarkup } from './result-database.js';
import { bindMatch, bindResponseViewer, matchButton, responseMarkup } from './response-viewer.js';
import { captureMarkup, bindCapturePane } from './result-capture.js';
import { formatRequest } from './snippets.js';
import { copyText } from './copy.js';
import { formatDuration, formatNumber, t } from './i18n.js';
import { actionBar, confirmation as confirmationBar, isReadOnly, previewDock, runningStatus } from './action-bar.js';
import { tracedSendEnabled } from './settings.js';
import { isPublic, primarySchemes } from './security.js';
import { noteSunsetHeader } from './deprecation.js';

const CREDENTIAL = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;

/** Execute requests and render the result pane. */
export function createResults({
  state, basePath, $, readRequest, sensitiveNames, renderOperation, issues, onFollowUp, selectView,
  schemaName = () => '', fillable = () => false, onCompleted = () => {},
}) {
  let active;
  let confirmation;
  let restoreProgress;

  function previewAvailable() {
    return !!state.op && !isReadOnly(state.op) && (state.cap.previewOperations || []).some(operation =>
      operation.method.toUpperCase() === state.op.method && operation.path === state.op.path);
  }

  /** The operation's preview: false mark from discovery, unless it is read-only anyway. */
  const unavailable = () => isReadOnly(state.op) ? undefined : unavailableEntry(state.op, state.cap);

  /** Facts the result states need to explain themselves. */
  function context() {
    const canPreview = previewAvailable();
    return {
      op: state.op, document: state.doc, readOnly: isReadOnly(state.op), canPreview, fillable: fillable(),
      unavailable: unavailable(), capabilities: state.cap, traced: tracedSendEnabled(state.cap),
      traceAvailable: state.cap.observedSend === true && canPreview, schemaName,
      canSignIn: (state.cap.authProviders || []).length > 0,
      schemes: state.op ? primarySchemes(state.op, state.doc).map(item => item.name) : [],
    };
  }

  /**
   * The action bar and, for an operation marked preview: false, the reason docked above it. After
   * a Preview the write guard stopped, the status says so until the next run.
   */
  function renderBar() {
    const bar = $('.actionbar');
    const entry = unavailable();
    const dock = $('[data-preview-dock]');
    if (dock) {
      dock.hidden = !entry;
      dock.innerHTML = previewDock(entry);
    }
    const blocked = state.result?.blocked && state.result.operation === state.op ? storeName(state.result.blocked.store) : undefined;
    if (bar && !confirmation) bar.innerHTML = actionBar(state.op, previewAvailable(), { unavailable: entry, blocked });
  }

  /** Preview pressed (or ⌘↵) on an operation marked preview: false: point at the reason instead. */
  function nudgeDock() {
    const dock = $('[data-preview-dock]');
    if (!dock || dock.hidden) return false;
    dock.classList.remove('is-nudged');
    void dock.offsetWidth;
    dock.classList.add('is-nudged');
    dock.focus?.({ preventScroll: false });
    return true;
  }

  function showProgress(preview) {
    const button = $(`.actionbar [data-action="${preview ? 'preview' : 'send'}"]`);
    const status = $('.actionbar .status');
    const savedStatus = status?.innerHTML;
    const glyph = button?.querySelector('svg');
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    glyph?.replaceWith(spinner);
    button?.setAttribute('aria-busy', 'true');
    if (status) status.innerHTML = runningStatus(preview, state.cap.identity?.name);
    restoreProgress = () => {
      if (glyph) spinner.replaceWith(glyph);
      button?.removeAttribute('aria-busy');
      if (status) status.innerHTML = savedStatus;
      restoreProgress = undefined;
    };
  }

  function cancelConfirmation() {
    if (!confirmation) return;
    confirmation = undefined;
    renderBar();
  }

  function askForConfirmation(request) {
    const bar = $('.actionbar');
    confirmation = { request, operation: state.op, documentUrl: state.documentUrl };
    bar.innerHTML = confirmationBar(request.method, state.op.path, unavailable()?.stores ?? []);
    setView('request');
    bar.querySelector('[data-action="cancel-confirm"]').focus();
  }

  function setView(view) {
    if (selectView) selectView(view);
    else $('.workspace').dataset.view = view === 'response' ? 'result' : view;
  }

  function cancel() {
    cancelConfirmation();
    active?.abort();
    active = undefined;
    restoreProgress?.();
    if ($('#result')) {
      $('.response').removeAttribute('aria-busy');
      document.querySelectorAll('.actionbar [data-action="send"], .actionbar [data-action="preview"]').forEach(button => { button.disabled = false; });
      renderResult();
    }
  }

  function containsCredential(value, names) {
    if (!value || typeof value !== 'object') return false;
    if (typeof File !== 'undefined' && value instanceof File) return true;
    return Object.entries(value).some(([key, item]) => CREDENTIAL.test(key) ||
      names.has(key.toLowerCase().replace(/^(header|query|cookie|path):/, '')) || containsCredential(item, names));
  }

  function canStoreHistory(op, body, params, headers) {
    const names = new Set(sensitiveNames().map(name => name.toLowerCase()));
    function sensitiveSchema(schema, seen = new Set()) {
      if (!schema || typeof schema !== 'object' || seen.has(schema)) return false;
      seen.add(schema);
      if (schema.writeOnly || schema.format === 'password') return true;
      if (schema.$ref && sensitiveSchema(dereference(schema, state.doc), seen)) return true;
      return Object.values(schema).some(value => sensitiveSchema(value, seen));
    }
    return !/\b(auth|login|password|token|credentials)\b/i.test(op.path) &&
      !sensitiveSchema(op.operation.requestBody) && !sensitiveSchema(op.parameters) &&
      !containsCredential(body, names) && !containsCredential(params, names) &&
      !headers.some(row => CREDENTIAL.test(row.name) || names.has(row.name.toLowerCase()));
  }

  function showValidationErrors(body) {
    if (!body?.errors || typeof body.errors !== 'object' || Array.isArray(body.errors)) return;
    const errors = Object.entries(body.errors).flatMap(([path, messages]) =>
      (Array.isArray(messages) ? messages : [messages]).map(message => ({ path, message: String(message) })));
    if (!errors.length) return;
    if (state.tab === 'JSON') {
      state.tab = 'Form';
      renderOperation();
    }
    issues?.show(errors, { fromServer: true });
  }

  /** A request that couldn't be prepared or acknowledged. Shown in the Response tab only. */
  function showError(error) {
    state.result = { error: error.message };
    state.resultTab = 'Response';
    renderResult();
    setView('response');
  }

  async function copyFailedRequest(button) {
    if (!state.result?.network) return;
    const request = state.result.wireRequest || transportRequest(readRequest(), state.result.preview, basePath);
    await copyText(formatRequest('curl', request, sensitiveNames()), { button, what: t('copy.what.curl'), notice: button?.closest('.actions') });
  }

  async function copyCurl(button) {
    if (!state.result?.wireRequest) return;
    await copyText(formatRequest('curl', state.result.wireRequest, sensitiveNames()), { button, what: t('copy.what.curl') });
  }

  async function run(preview, confirmed = false) {
    if (active) return;
    let controller;
    let started;
    let target;
    try {
      let request;
      if (confirmed) {
        if (!confirmation || confirmation.operation !== state.op || confirmation.documentUrl !== state.documentUrl) return;
        request = confirmation.request;
        cancelConfirmation();
      } else {
        cancelConfirmation();
        request = readRequest();
      }
      if (preview && unavailable() && nudgeDock()) return;
      if (preview && !previewAvailable()) throw new Error(t('res.previewUnavailable'));
      if (!preview && !isReadOnly(state.op) && !confirmed) {
        issues?.clear();
        askForConfirmation(request);
        return;
      }
      const operation = state.op;
      const documentUrl = state.documentUrl;
      const recordHistory = canStoreHistory(operation, state.body, state.paramValues || {}, state.headers || []);
      const body = recordHistory ? structuredClone(state.body) : undefined;
      const params = recordHistory ? structuredClone(state.paramValues || {}) : undefined;
      const draftHeaders = recordHistory ? structuredClone(state.headers || []) : undefined;
      controller = new AbortController();
      started = performance.now();
      target = new URL(request.url);
      active = controller;
      issues?.clear();
      const buttons = document.querySelectorAll('.actionbar [data-action="send"], .actionbar [data-action="preview"]');
      buttons.forEach(button => { button.disabled = true; });
      showProgress(preview);
      $('.response').setAttribute('aria-busy', 'true');
      state.running = { preview };
      renderResult();
      const elapsed = $('[data-elapsed]');
      const timer = setInterval(() => {
        if (elapsed) elapsed.textContent = formatDuration(performance.now() - started);
      }, 250);
      try {
        const observedSend = !preview && previewAvailable() && tracedSendEnabled(state.cap);
        const result = await execute(request, preview, basePath, controller.signal, { observedSend });
        if (active !== controller || state.op !== operation || state.documentUrl !== documentUrl) return;
        state.running = undefined;
        state.result = result;
        result.finishedAt = Date.now();
        result.operation = operation;
        // A blocked Preview's loading state mirrors the blocked result the next time it runs.
        if (preview) state.blockedOps = { ...state.blockedOps, [`${operation.method} ${operation.path}`]: !!result.blocked };
        result.requestHeaders = redactRequestHeaders(result.requestHeaders, sensitiveNames());
        // A Sunset header (RFC 8594) dates a deprecated operation whose spec has no x-sunset.
        noteSunsetHeader(operation, result.headers);
        if (result.status < 400 && result.body && typeof result.body === 'object' && !Array.isArray(result.body))
          state.lastResponse = { path: operation.path, body: result.body };
        // Real responses feed the examples on model pages and in Docs.
        if (result.status < 400 && result.body && typeof result.body === 'object') {
          state.samples = [result.body, ...(state.samples || [])].slice(0, 20);
        }
        restoreProgress?.();
        if (result.status >= 400) showValidationErrors(result.body);
        if (state.resultTab !== 'Response' && !captured(result) && ['Database', 'Side effects', 'Logs'].includes(state.resultTab) && !rejectedEarly(result))
          state.resultTab = 'Response';
        else if (preview && result.status < 400 && result.changes?.length) state.resultTab = 'Database';
        if (recordHistory) state.history.unshift({ op: operation, body, params, headers: draftHeaders, preview, when: Date.now(), status: result.status });
        state.history.length = Math.min(state.history.length, 50);
        $('.response').removeAttribute('aria-busy');
        renderResult();
        if (result.blocked || preview) renderBar();
        setView('response');
        onCompleted(result, { preview, operation });
      } finally {
        clearInterval(timer);
        if (active === controller) {
          active = undefined;
          state.running = undefined;
          restoreProgress?.();
          buttons.forEach(button => { button.disabled = false; });
          $('.response')?.removeAttribute('aria-busy');
        }
      }
    } catch (error) {
      state.running = undefined;
      if (error.validation) {
        setView('request');
        issues?.show(error.issues ?? error.message.split('\n').map(message => ({ message })), { expand: true });
      } else if (error instanceof RequestTransportError && !controller.signal.aborted) {
        state.result = {
          network: true, error: error.message, preview, host: target.host, origin: target.origin,
          wireRequest: error.wireRequest, seconds: (performance.now() - started) / 1000,
        };
        state.resultTab = 'Response';
        renderResult();
        setView('response');
      } else if (error.name !== 'AbortError' && (!controller || !controller.signal.aborted)) showError(error);
    }
  }

  function renderTabs(result) {
    const counts = state.running ? resultCounts(null) : resultCounts(result);
    $('.response .tabs').innerHTML = RESULT_TABS.map((tab, index) => tabButton(resultTabLabel(tab), {
      selected: tab === state.resultTab, count: counts[index], id: `result-tab-${tab.replaceAll(' ', '-')}`,
      controls: 'result', shortcut: 'result-tab-' + index, data: `data-result-tab="${tab}"`,
    })).join('');
    $('.response .tabs [aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  /** The content of the selected tab for the current result. */
  function tabContent(tab, result, ctx) {
    if (!result) return beforeRun(tab, ctx);
    if (result.network) return tab === 'Response' ? networkError(result) : beforeRun(tab, ctx);
    if (result.error) return tab === 'Response' ? requestError(result) : beforeRun(tab, ctx);
    if (result.blocked && tab !== 'Headers') return tab === 'Response' ? blockedMarkup(result, ctx) : blockedTab(tab, result, ctx);
    const viewContext = {
      document: state.doc, operation: state.op, operations: state.ops, basePath, onFollowUp, capabilities: state.cap,
    };
    if (tab === 'Response') {
      const problem = result.status === 401 ? unauthorized(result, ctx) : '';
      return problem && !result.raw ? problem : problem + responseMarkup(result, viewContext);
    }
    if (tab === 'Headers') return captureMarkup(tab, result, viewContext);
    if (!captured(result)) return rejectedEarly(result) && tab !== 'Logs' ? zeroState(tab, result) : notCaptured(tab, ctx);
    if (tab === 'Database') return result.changes?.length || result.changesTruncated ? databaseMarkup(result, state.cap) : zeroState(tab, result);
    const items = tab === 'Logs' ? result.logs : result.effects;
    return items?.length ? captureMarkup(tab, result, viewContext) : zeroState(tab, result);
  }

  function renderResult() {
    const result = state.result;
    const head = $('.resp-head');
    if (state.running) head.innerHTML = runningHeader(state.running.preview, state.cap.identity?.name);
    else if (result?.network) head.innerHTML = networkHeader(result);
    else if (result?.error) head.innerHTML = errorHeader();
    else if (result?.blocked) head.innerHTML = blockedHeader(result);
    else {
      // The schema match sits in the status line, after status, time and size (mock 100).
      const viewContext = { document: state.doc, operation: state.op, operations: state.ops, basePath, onFollowUp, capabilities: state.cap };
      head.innerHTML = result ? responseHeader(result, { match: result.raw || result.body !== undefined ? matchButton(result, viewContext) : '' }) : idleHeader();
      if (result) bindMatch(head, result, viewContext);
    }
    renderTabs(result);
    const bar = $('.result-bar');
    if (bar) bar.innerHTML = resultBar(result, { running: !!state.running, identity: state.cap.identity?.name });
    const panel = $('#result');
    const tab = state.resultTab;
    const wasBlocked = !!state.op && !!state.blockedOps?.[`${state.op.method} ${state.op.path}`];
    if (state.running) panel.innerHTML = loadingBody(tab, state.running.preview, { blocked: state.running.preview && wasBlocked }) + `<span class="sr-only">${esc(t('res.loading'))}</span>`;
    else {
      panel.innerHTML = `<div class="result-body">${tabContent(tab, result, context())}</div>`;
      const container = panel.querySelector('.result-body');
      const viewContext = { document: state.doc, operation: state.op, operations: state.ops, basePath, onFollowUp, capabilities: state.cap };
      if (result?.blocked && tab === 'Response') bindBlocked(container, result, context());
      else if (result?.blocked && tab !== 'Headers') { /* A designed state with no captured data to bind. */ }
      else if (result && !result.error && tab === 'Response') bindResponseViewer(container, result, viewContext);
      else if (result && !result.error && tab === 'Database' && captured(result) && result.changes?.length) bindDatabase(container, result);
      else if (result && !result.error && showsCapture(tab, result)) bindCapturePane(container, tab, result, viewContext);
    }
    panel.scrollTop = 0;
    panel.setAttribute('aria-labelledby', `result-tab-${tab.replaceAll(' ', '-')}`);
    const mobileResult = $('.mobile-switch [data-view="response"]');
    if (mobileResult) mobileResult.textContent = result?.status
      ? `${t('shell.result')} · ${formatNumber(result.status, { useGrouping: false })}` : t('shell.result');
  }

  return {
    showError, copyFailedRequest, copyCurl, run, renderResult, renderBar, cancel, cancelConfirmation, previewAvailable,
    get confirming() { return !!confirmation; },
    requiresSignIn: () => !!state.op && !isPublic(state.op, state.doc),
  };
}

/** True when the tab renders captured items that need their interactive bindings. */
function showsCapture(tab, result) {
  if (tab === 'Headers') return true;
  if (!captured(result)) return false;
  return tab === 'Logs' ? !!result.logs?.length : tab === 'Side effects' ? !!result.effects?.length : false;
}

function redactRequestHeaders(headers, sensitiveNames) {
  const custom = new Set(sensitiveNames.map(name => name.toLowerCase()));
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name, custom.has(name.toLowerCase()) || CREDENTIAL.test(name) ? 'REDACTED' : value,
  ]));
}
