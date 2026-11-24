// Journeys mode (docs/plans/journeys.md; mocks v7, screens 132–151, m32–m40). The controller
// app.js wires in: the mode switch, the journeys sidebar and its rail, the overview, runs step by
// step and to the end in Preview (one Preview session per run, rewound when a step runs again,
// ended when the run finishes or is cancelled) and in Send (traced Sends), each step on its
// operation's own Try it screen with its bound fields marked, the Expected tab and the
// comparison, the summary, Run all, and the runs kept in this browser.
//
// The journey engine (ui/journeys/) binds steps, checks criteria and compares writes; this file
// only runs it against the host and draws what it says. Nothing here exists, and nothing in the
// workbench changes, unless capabilities list journeys or Preview sessions.
import { createRun, exportRun, recordStep, toJUnit, bindStep } from './journeys/index.js';
import { fixedValues, inputControls, journeysEnabled, journeyGroups, loadJourneys, inputUsage } from './journeys-model.js';
import { findingCounts, lastStatusOf, loadRuns, saveRun, recentRuns, tallyEnvelope } from './journeys-runs.js';
import { endHeldSessions, openSession, SESSION_HEADER, sessionGone } from './journeys-session.js';
import { changeFacts, changeRef, refForId } from './journeys-dialog-model.js';
import { showToast } from './toast.js';
import { confirmEndRun, confirmPersonaSwitch, confirmSendRun, confirmSessionEnded, confirmSessionOpenFailed, confirmStopSend } from './journeys-dialogs.js';
import { draftApprovedDifference, expectWritesCode, refsFor } from './journeys-code.js';
import * as view from './journeys-view.js';
import { encodeRequestBody, execute, makeRequest } from './api.js';
import { createSchemaForm } from './schema.js';
import { copyText } from './copy.js';
import { esc, icon } from './components.js';
import { current, formatNumber, t } from './i18n.js';
import { opKey } from './operations.js';
import { personasProvider } from './personas.js';
import { sqlSystem } from './stores.js';
import { captured } from './result-states.js';
import { shortcutAttrs, shortcutHint } from './shortcuts.js';

/** Steps whose writes go to a store this host didn't hook (or a Send that wasn't traced) can't be compared. */
function uncheckedReason(write, capabilities, traced) {
  if (!traced) return t('jr.unchecked.noTrace');
  const system = write.store;
  const sql = sqlSystem(capabilities);
  const hooked = system === sql || system === 'sql' || (capabilities.dataStores ?? []).some(store => store.system === system);
  return hooked ? null : t('jr.unchecked.notHooked', { store: system });
}

/**
 * The expectations a step can be compared with on this host: writes to stores it didn't hook,
 * and everything after an untraced Send, become "Not checked" findings instead of "Missing".
 */
export function checkableExpectations(expectations, journeyId, capabilities, { traced = true } = {}) {
  const copy = structuredClone(expectations ?? {});
  const unchecked = {};
  const steps = copy.journeys?.[journeyId]?.steps ?? {};
  for (const [stepId, expected] of Object.entries(steps)) {
    const kept = [];
    for (const [index, write] of (expected.writes ?? []).entries()) {
      const reason = uncheckedReason(write, capabilities, traced);
      if (reason) (unchecked[stepId] ??= []).push({ id: `unchecked:${index}`, kind: 'unchecked', store: write.store, target: write.table ?? write.collection ?? write.key, op: write.op, key: undefined, fields: [], note: reason });
      else kept.push(write);
    }
    expected.writes = kept;
    if (!traced && expected.effects?.length) {
      for (const [index, effect] of expected.effects.entries()) (unchecked[stepId] ??= []).push({ id: `unchecked-effect:${index}`, kind: 'unchecked', store: 'effect', target: effect.kind, op: 'send', fields: [], note: t('jr.unchecked.noTrace') });
      expected.effects = [];
    }
  }
  return { expectations: copy, unchecked };
}

/** The value a request field holds at a binding's target ("path.id", "body/items/0/sku"). */
function valueAt(target, { paramValues = {}, body }) {
  const param = /^(path|query|header|cookie)\.(.+)$/.exec(target);
  if (param) return paramValues[`${param[1]}:${param[2]}`];
  const tokens = target.replace(/^body\/?/, '').split('/').filter(Boolean).map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  return tokens.reduce((node, key) => node == null ? undefined : node[key], body);
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || String(a ?? '') === String(b ?? '');

export function createJourneys({ state, $, basePath, results, openOperation, navigate, announce, refreshIdentity, storage = globalThis.localStorage }) {
  const j = {
    status: 'idle', journeys: [], sources: [], problems: [], open: null, view: 'overview', live: null, filter: 'all',
    summaryOpen: -1, runTab: 'approved', inputs: {}, lastSpec: null, lastJourneys: null, runningAll: false, loadedFor: null, opening: false,
  };
  let inputsForm = null;

  const enabled = () => journeysEnabled(state.cap);
  const journey = id => j.journeys.find(item => item.id === id);
  const runs = () => loadRuns(storage, state.documentUrl);
  const lastStatus = id => {
    if (j.live?.journey.id === id && j.live.run.status !== 'running') return j.live.run.status;
    return lastStatusOf(recentRuns(runs(), id));
  };
  const stepRoute = () => state.route?.kind === 'jstep';
  const liveStep = () => stepRoute() && j.live && j.live.journey.id === state.route.journey ? j.live.journey.steps.findIndex(step => step.stepId === state.route.step) : -1;

  /* ---------- Loading ---------- */

  async function load() {
    if (!enabled() || j.loadedFor === state.documentUrl) return;
    j.loadedFor = state.documentUrl;
    // A session this tab opened before it was closed or crashed still holds the store: end it, unless a run here owns it.
    if (state.cap.previewSessions === true && !j.live && !j.runningAll && !j.opening) endHeldSessions();
    j.status = 'loading';
    const fetchJson = async url => {
      const response = await fetch(new URL(url, location.href), { credentials: 'include', redirect: 'error' });
      if (!response.ok) throw new Error(t('jr.loadStatus', { status: response.status, url }));
      return response.json();
    };
    try {
      const loaded = await loadJourneys({ capabilities: state.cap, document: state.doc, ops: state.ops, fetchJson });
      Object.assign(j, loaded, { status: 'ready' });
    } catch (error) {
      Object.assign(j, { journeys: [], problems: [{ message: error.message }], status: 'ready' });
    }
    if (state.mode === 'journeys') {
      // The route may name a journey that has just loaded: show it in place of the skeleton.
      if (state.route?.kind === 'journeys' || state.route?.kind === 'journey') navigate(state.route, { replace: true, focus: false });
      else navigate(state.route, { replace: true, focus: false });
    }
  }

  /* ---------- Routes ---------- */

  /**
   * Makes `state` show a journey route. Returns the route really shown. The step of a run opens
   * its operation's own screen (state.view 'try'); the overview and a run's summary use the
   * reading panes.
   */
  function applyRoute(route) {
    state.mode = 'journeys';
    j.lastJourneys = route;
    if (j.status !== 'ready') { state.view = 'journey'; return route; }
    if (route.kind === 'journeys') {
      const id = j.open && journey(j.open) ? j.open : j.journeys[0]?.id;
      state.view = 'journey';
      if (!id) return route;
      j.open = id;
      return { kind: 'journey', journey: id };
    }
    const target = journey(route.journey);
    if (!target) { state.view = 'journey'; j.open = j.journeys[0]?.id ?? null; return j.open ? { kind: 'journey', journey: j.open } : { kind: 'journeys' }; }
    if (j.open !== target.id) j.filter = 'all';
    j.open = target.id;
    if (route.kind === 'journey') { state.view = 'journey'; return route; }
    if (route.kind === 'jrun') {
      const stored = route.run === j.live?.run.runId ? j.live.run : recentRuns(runs(), target.id).find(run => run.runId === route.run);
      if (!stored) { state.view = 'journey'; return { kind: 'journey', journey: target.id }; }
      j.summary = stored;
      state.view = 'jrun';
      return route;
    }
    // A step: of the open run, or of a stored run reviewed from its summary.
    const index = target.steps.findIndex(step => step.stepId === route.step);
    if (index < 0 || !target.steps[index].op) { state.view = 'journey'; return { kind: 'journey', journey: target.id }; }
    if (!j.live || j.live.journey.id !== target.id) {
      const stored = j.summary?.journeyId === target.id ? j.summary : recentRuns(runs(), target.id)[0];
      if (!stored) { state.view = 'journey'; return { kind: 'journey', journey: target.id }; }
      j.live = { journey: target, run: stored, review: true, envelopes: [], responses: [], contentTypes: [], drafts: [], results: [] };
    }
    // The editor marks bound fields as it draws, so the step is the current route before it does.
    state.route = route;
    showStep(index);
    state.view = 'try';
    return route;
  }

  /** Opens step `index` of the live run on its operation's screen, with its bound values. */
  function showStep(index) {
    const live = j.live;
    const step = live.journey.steps[index];
    const draft = live.drafts[index];
    let paramValues, body;
    if (draft) ({ paramValues, body } = structuredClone(draft));
    else {
      const bound = bindStep(step.def, contextFor(live.run));
      paramValues = {};
      for (const [where, values] of [['path', bound.path], ['query', bound.query], ['header', bound.headers]]) {
        for (const [name, value] of Object.entries(values)) if (value !== undefined) paramValues[`${where}:${name}`] = value;
      }
      ({ body } = bound);
    }
    live.index = index;
    openOperation(step.op, paramValues, body);
    // The step's result, when it ran in this run, stays on its screen.
    state.result = live.results[index] ?? null;
    state.resultTab = 'Expected';
  }

  /** The runtime-expression context of a run: its inputs and each step's outputs so far. */
  function contextFor(run) {
    return { inputs: run.inputs ?? {}, steps: Object.fromEntries((run.steps ?? []).filter(step => step.status !== 'pending' && step.status !== 'skipped').map(step => [step.stepId, { outputs: step.outputs ?? {} }])) };
  }

  /* ---------- Mode ---------- */

  function switchMode(mode) {
    if (!enabled()) return;
    if (mode === state.mode) return;
    if (mode === 'journeys') {
      j.lastSpec = state.route;
      navigate(j.lastJourneys ?? { kind: 'journeys' });
    } else {
      navigate(j.lastSpec ?? { kind: 'overview' });
    }
  }

  /** Marks the current mode in every mode switch (top bar and drawer). */
  function markMode() {
    for (const item of document.querySelectorAll('[data-mode]')) {
      if (item.dataset.mode === (state.mode === 'journeys' ? 'journeys' : 'spec')) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    document.querySelector('.app')?.classList.toggle('jm', state.mode === 'journeys');
  }

  /* ---------- Sidebar provider ---------- */

  const sidebarProvider = {
    active: () => state.mode === 'journeys',
    filterable: () => j.status === 'ready' && j.journeys.length > 0,
    head: () => view.sidebarHead({ journeys: j.journeys, loading: j.status !== 'ready', sources: j.sources }),
    names: () => j.journeys.map(item => item.name),
    groupKeys: () => journeyGroups(j.journeys).map(([name, , inferred]) => inferred ? '__inferred' : name),
    list(query, isCollapsed) {
      if (j.status !== 'ready') return view.journeysNavLoading();
      if (!j.journeys.length) return view.journeysNavEmpty();
      const live = j.live && !j.live.review ? j.live : j.live?.review && stepRoute() ? j.live : null;
      return view.journeysNav({
        journeys: j.journeys, query, open: j.open, run: live?.journey.id === j.open ? live.run : null,
        here: live?.journey.id === j.open && stepRoute() ? liveStep() : -1, running: live?.running ?? -1, lastStatus, isCollapsed,
      });
    },
    foot: allCollapsed => view.journeysFoot({ disabled: j.status !== 'ready' || !j.journeys.length, allCollapsed: allCollapsed(sidebarProvider.groupKeys()), runningAll: j.runningAll }),
  };

  /* ---------- Reading views: overview, summary, empty, loading ---------- */

  function renderReading(main, aside) {
    inputsForm?.destroy?.();
    inputsForm = null;
    const target = j.open && journey(j.open);
    if (j.status !== 'ready') { main.innerHTML = view.loadingMain(); aside.innerHTML = view.loadingAside(); return; }
    if (!target) {
      main.innerHTML = view.emptyMain({ apiName: state.cap.apiName, dotnet: state.cap.binding?.language === 'dotnet' || !state.cap.binding });
      aside.innerHTML = view.emptyAside();
      return;
    }
    if (state.view === 'jrun') { renderSummary(main, aside, target, j.summary); return; }
    const stored = recentRuns(runs(), target.id);
    const body = j.view === 'arazzo' ? view.arazzoView(target) : `<div class="form j7-body">
        <h2 class="section-label j7-sl"><span>${esc(t('jr.steps'))}</span><span class="rule" aria-hidden="true"></span></h2>
        ${view.stepsTimeline(target)}
        ${target.inputs?.properties && Object.keys(target.inputs.properties).length ? `<h2 class="section-label j7-sl"><span>${esc(t('jr.inputs'))}</span><span class="rule" aria-hidden="true"></span>${target.definedIn?.type ? `<span class="j7-sl-end">${esc(t('jr.from'))} <bdi dir="ltr"><code>${esc(target.definedIn.type.replace(/Journey$/, 'Inputs'))}</code></bdi></span>` : ''}</h2>
        <div class="j7-inputs" data-journey-inputs></div>` : ''}
        ${target.outputs.length || target.steps.length ? `<h2 class="section-label j7-sl"><span>${esc(t('jr.endsWith'))}</span><span class="rule" aria-hidden="true"></span></h2>${view.endsWith(target)}` : ''}
      </div>`;
    main.innerHTML = `${view.overviewContext(target, j.view)}<div class="pane-scroll">${view.overviewHead(target, { capabilities: state.cap })}${body}</div>
      <div class="actionbar j7-actions">${view.overviewBar(target, { previewSessions: state.cap.previewSessions === true, opening: j.opening })}</div>`;
    aside.innerHTML = view.overviewAside(target, stored);
    const holder = main.querySelector('[data-journey-inputs]');
    if (holder) renderInputs(holder, target);
  }

  /** The journey's inputs as the workbench's real fields, each saying which steps use it. */
  function renderInputs(holder, target) {
    const values = j.inputs[target.id] ??= Object.fromEntries(Object.entries(target.inputs.properties).filter(([, schema]) => schema.default !== undefined).map(([name, schema]) => [name, structuredClone(schema.default)]));
    // An input bound to a step field with a lookup, an enum or a format uses that field's control.
    const controls = inputControls(target, state.doc);
    // Inputs keep their own names as labels, and each has a value (its default), so none reads as optional.
    const schema = { ...target.inputs, required: target.inputs.required ?? Object.keys(target.inputs.properties),
      properties: Object.fromEntries(Object.entries(target.inputs.properties).map(([name, property]) => [name, { title: name, ...controls[name], ...property }])) };
    inputsForm = createSchemaForm({
      container: holder, schema, document: state.doc, value: values, name: 'inputs', flattenRoot: true, basePath,
      lookupCache: state.lookupCache ??= new Map(), actor: state.cap.identity?.name, signedIn: !!state.cap.identity?.name,
      onChange: value => { j.inputs[target.id] = value; },
    });
    const usage = inputUsage(target);
    for (const field of holder.querySelectorAll('[data-schema-path]')) {
      const path = JSON.parse(field.dataset.schemaPath);
      if (path.length !== 1) continue;
      const hint = field.querySelector(':scope > .assist .field-hint');
      if (hint) { hint.textContent = view.usedIn(usage[path[0]]); hint.dataset.base = hint.innerHTML; }
    }
  }

  function renderSummary(main, aside, target, run) {
    main.innerHTML = `${view.summaryMain(target, run, { capabilities: state.cap, open: j.summaryOpen })}
      <div class="actionbar j7-actions">${view.summaryBar(target, run, { previewSessions: state.cap.previewSessions === true, opening: j.opening })}</div>`;
    const inputs = Object.entries(run.inputs ?? {});
    const inputsHtml = inputs.length ? `<dl class="j7-inputs-list">${inputs.map(([name, value]) => `<div><dt dir="ltr">${esc(name)}</dt><dd><bdi dir="ltr"><code>${esc(view.display(value))}</code></bdi></dd></div>`).join('')}</dl>` : `<p class="faint">${esc(t('jr.noInputs'))}</p>`;
    aside.innerHTML = view.summaryAside(target, run, { tab: j.runTab, inputsHtml });
  }

  /* ---------- A step on its operation's screen ---------- */

  /** The context bar and strip of a step; app.js draws the rest of Try it. */
  function stepChrome() {
    const index = liveStep();
    const strip = $('#journey-strip');
    if (index < 0) { if (strip) { strip.hidden = true; strip.innerHTML = ''; } return null; }
    const live = j.live;
    if (strip) { strip.hidden = false; strip.innerHTML = view.stepStrip(live.journey, live.run, index, { capabilities: state.cap, end: live.review ? '' : endRunButton(), sessionEnded: !!live.ending }); }
    return view.stepContext(live.journey, index);
  }
  const endRunButton = () => `<button type="button" class="btn btn-ghost btn-icon btn-xs j7-end" data-action="journey-end-run" aria-label="${esc(t('jr.endRun'))}" title="${esc(t('jr.endRunTip'))}">${icon('x', true)}</button>`;

  /** After the request editor draws: chips on bound fields, their status lines, bound URL tokens. */
  function decorateStep() {
    const index = liveStep();
    if (index < 0) return;
    const live = j.live;
    const step = live.journey.steps[index];
    const bound = bindStep(step.def, contextFor(live.run)).bound;
    // Values the journey sets itself: parameters, and top-level body fields (nested ones sit inside a group).
    const fixed = fixedValues(step.def).filter(item => !item.target.startsWith('body/') || item.target.split('/').length === 2).map(item => ({ ...item, from: 'fixed' }));
    for (const binding of [...bound, ...fixed]) {
      const field = fieldFor(binding.target);
      if (!field || field.querySelector('.bind7')) continue;
      field.dataset.bound = '';
      const end = field.querySelector(':scope > .label > .end');
      end?.insertAdjacentHTML('beforebegin', view.bindChip(binding, live.journey));
      const hint = field.querySelector(':scope > .assist .field-hint');
      if (hint) { hint.innerHTML = view.bindStatus(binding); hint.dataset.base = hint.innerHTML; }
    }
    for (const binding of bound.filter(item => item.target.startsWith('path.'))) {
      const token = document.querySelector(`.urlbar [data-path-param="${CSS.escape(binding.target.slice(5))}"]`);
      if (token && !token.classList.contains('is-bound7')) {
        token.classList.add('is-bound7');
        // The token's own glyph gives way to the bind arrow: the value comes from an earlier step.
        const glyph = token.querySelector('svg');
        if (glyph) glyph.outerHTML = icon('bind', true); else token.insertAdjacentHTML('afterbegin', icon('bind', true));
        token.title = view.display(binding.value) || binding.expression;
      }
    }
  }

  function fieldFor(target) {
    const param = /^(path|query|header|cookie)\.(.+)$/.exec(target);
    if (param) return document.querySelector(`#editor [data-parameter-name="${CSS.escape(param[2])}"] [data-schema-path]`);
    const tokens = target.replace(/^body\/?/, '').split('/').filter(Boolean);
    const candidates = [JSON.stringify(tokens), JSON.stringify(tokens.map(token => /^\d+$/.test(token) ? Number(token) : token))];
    return [...document.querySelectorAll('#editor [data-schema-path]')].find(node => candidates.includes(node.dataset.schemaPath)) ?? null;
  }

  /** How many bound values the person changed on this step's screen. */
  function editedTargets(index) {
    const live = j.live;
    const step = live.journey.steps[index];
    const bound = bindStep(step.def, contextFor(live.run)).bound;
    return bound.filter(binding => !same(valueAt(binding.target, { paramValues: state.paramValues, body: state.body }), binding.value)).map(binding => binding.target);
  }

  /** The hooks results.js asks for on a journey step: the bar, the Expected tab, the run options. */
  function hooks() {
    const index = liveStep();
    if (index < 0) return null;
    const live = j.live;
    const step = live.journey.steps[index];
    const result = live.run.steps[index];
    const ran = result && !['pending', 'skipped'].includes(result.status);
    const problems = ran ? findingCounts(result).problems : 0;
    const stopped = ran && ['refused', 'blocked'].includes(result.status);
    const expectedCount = (step.expected?.writes?.length ?? 0) + (step.expected?.effects?.length ?? 0) + (step.def.successCriteria?.length ?? 0);
    return {
      bar: () => view.stepBar(live.journey, live.run, index, { running: live.running ?? -1, edited: live.review ? 0 : editedTargets(index).length, opening: j.opening, canPreview: live.run.mode !== 'send' || step.op.method !== 'GET' }),
      idleHead: () => `<strong class="j7-rh-t">${esc(t('jr.stepN', { n: formatNumber(index + 1) }))}</strong><span class="metric">${esc(t('jr.rail.notRun'))}</span><span class="spacer"></span>`,
      plainHead: true,
      headExtra: () => live.review || live.run.mode === 'send' ? '' : `<button type="button" class="btn btn-ghost btn-icon btn-sm j7-rerun" data-action="preview" aria-label="${esc(t('jr.rerun', { n: formatNumber(index + 1) }))}" title="${esc(t('jr.rerun', { n: formatNumber(index + 1) }))}">${icon('refresh', true)}</button>`,
      resultBar: (shown, { running }) => {
        const text = running ? t('bar.runningShort') : shown?.finishedAt
          ? t(shown.preview ? 'jr.rb.previewed' : 'jr.rb.sent', { time: new Intl.DateTimeFormat(current().locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(shown.finishedAt)), run: live.run.runId.slice(0, 4) })
          : live.review ? t('jr.rb.review', { run: live.run.runId.slice(0, 4) }) : index > 0 && live.run.steps[index - 1]?.at ? t(live.run.mode === 'send' ? 'jr.rb.prevSent' : 'jr.rb.prevPreviewed', { n: formatNumber(index), time: new Intl.DateTimeFormat(current().locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(live.run.steps[index - 1].at)) }) : t(live.run.mode === 'send' ? 'jr.rb.sendRun' : 'jr.rb.held');
        // Once the session is gone nothing is held any more, so the bar must not say so.
        const gone = live.ending && live.run.mode === 'preview' && !running && !shown?.finishedAt;
        const shownText = gone ? t('jr.rb.ended') : text;
        return `<span class="bar-text is-fit" title="${esc(shownText)}">${icon(gone ? 'undo' : shown ? (shown.preview ? 'undo' : 'send') : 'clock', true, gone ? 'i-dir' : '')}<span>${esc(shownText)}</span></span>
          <button type="button" class="btn btn-ghost btn-sm" data-action="history" ${shortcutAttrs('history')}>${icon('history', true)}${esc(t('shell.history'))}${shortcutHint('history')}</button>`;
      },
      expected: {
        label: t('jr.expected'), count: expectedCount, flag: stopped ? t('jr.stopped') : problems ? t('jr.problems', { n: problems }) : undefined,
        render: () => !ran ? view.expectList(live.journey, index, { capabilities: state.cap })
          : stopped ? view.stoppedView(live.journey, index, { ...live.run, responses: live.responses, envelopes: live.envelopes, contentTypes: live.contentTypes }, { capabilities: state.cap, leftBehind: leftBehind(index), undo: undoFor(index) })
          : view.comparison(live.journey, index, { ...live.run, envelopes: live.envelopes }, { filter: j.filter, capabilities: state.cap }),
        loading: () => `<div class="result-body" aria-hidden="true"><div class="vd7"><span class="sk vd7-ico"></span><div class="vd7-text"><span class="sk sk-line" style="inline-size:9rem"></span><span class="sk sk-line" style="inline-size:16rem;margin-block-start:0.5rem"></span></div></div>${[0, 1].map(() => '<span class="sk" style="display:block;block-size:9rem;border-radius:var(--r-lg)"></span>').join('')}</div>`,
      },
      run: preview => live.review ? null : ({
        headers: preview && live.run.mode === 'preview' && live.session ? live.session.header() : {},
        allowPreview: preview && live.run.mode === 'preview',
        skipConfirm: live.run.mode === 'send',
        observedSend: state.cap.observedSend === true,
        onResult: (result, { preview: wasPreview }) => record(index, result, { preview: wasPreview, edited: editedTargets(index) }),
        onError: error => {
          live.running = -1;
          // The session timed out while the person was away, or the host ended it: say so, and end the run.
          if (live.run.mode === 'preview' && sessionGone(error)) { sessionEnded(live); return; }
          refresh();
        },
      }),
    };
  }

  /** What earlier steps of a Send run committed: one line per change, with the step that made it. */
  function leftBehind(index) {
    const live = j.live;
    if (live.run.mode !== 'send') return [];
    const rows = [];
    // Every Send that committed, including an earlier attempt at a step sent again.
    for (const { step, envelope } of live.sent ?? []) {
      for (const change of envelope.changes ?? []) {
        const after = change.after ?? change.before ?? {};
        const detail = after.Number ?? after.number ?? after.Status ?? after.status ?? Object.values(change.key ?? {})[0];
        const { ref, field } = changeRef(change);
        rows.push({ step, store: change.store || sqlSystem(state.cap), target: change.table, op: change.operation, detail, ref, facts: changeFacts(change, field) });
      }
      for (const effect of envelope.effects ?? []) rows.push({ step, store: 'effect', target: effect.kind, op: effect.kind, detail: effect.description });
    }
    return rows;
  }

  /** The operation that undoes what a stopped Send left: a cancel on the first resource an earlier step created. */
  function undoFor(index) {
    const live = j.live;
    if (live.run.mode !== 'send') return null;
    for (let i = index - 1; i >= 0; i--) {
      const created = live.journey.steps[i].op;
      if (!created || created.method !== 'POST') continue;
      const id = Object.values(live.run.steps[i].outputs ?? {})[0];
      const base = created.path.replace(/\/$/, '');
      const cancel = state.ops.find(op => op.method === 'POST' && op.path.startsWith(`${base}/{`) && /\/(cancel|void|refund)/i.test(op.path));
      if (cancel) return { op: cancel, index: state.ops.indexOf(cancel), value: id, ref: refForId((live.sent ?? []).flatMap(item => item.envelope.changes ?? []), id), param: /\{([^}]+)\}/.exec(cancel.path)?.[1], step: i + 1 };
    }
    return null;
  }

  /** What a stopped Send run left and how to undo it, kept with the run so its summary can still show it. */
  function leftOver(live) {
    if (live.run.mode !== 'send') return {};
    const left = leftBehind();
    if (!left.length) return {};
    const undo = undoFor(live.run.steps.length);
    return { left, ...(undo ? { undo: { id: opKey(undo.op), method: undo.op.method, title: undo.op.title || undo.op.operation?.summary || undo.op.path, param: undo.param, value: undo.value, ref: undo.ref, step: undo.step } } : {}) };
  }

  /* ---------- Running ---------- */

  /**
   * Starts a run of the open journey in `mode`, opening its Preview session, and shows step 1.
   * A Preview that can't open says why in a dialog, which can try again.
   */
  async function startRun(mode) {
    if (j.opening) return;
    const failure = await beginRun(mode);
    if (failure && (await openFailed(failure)) === true) await startRun(mode);
  }

  /** Resolves to the error that stopped a Preview session opening, or nothing. */
  async function beginRun(mode) {
    const target = journey(j.open);
    if (!target) return;
    if (mode === 'preview' && (target.sendOnly || state.cap.previewSessions !== true)) return;
    if (mode === 'send' && !(await confirmSend(target))) return;
    // While the session opens the bars show it (journeys-view.js, `opening`): a re-render, such as the persona sign-in's, keeps it.
    if (mode === 'preview') { j.opening = true; refresh(); announce(t('jr.opening')); }
    let started = false;
    try {
      await endLive();
      await signInAs(target);
      const inputs = structuredClone(j.inputs[target.id] ?? defaults(target));
      const traced = mode === 'preview' || state.cap.observedSend === true;
      const { expectations, unchecked } = checkableExpectations(target.expectations, target.id, state.cap, { traced });
      const run = createRun({ journey: target.def, expectations, mode, inputs, persona: target.runAs ?? state.cap.identity?.name ?? null, store: sqlSystem(state.cap) });
      Object.assign(run, { by: state.cap.identity?.name ?? null, tally: { stores: {}, effects: 0 } });
      const live = { journey: target, run, mode, unchecked, envelopes: [], responses: [], contentTypes: [], drafts: [], results: [], sessionSteps: [], running: -1, started: performance.now(), lastActivity: Date.now() };
      if (mode === 'preview') {
        try { live.session = await openSession(); } catch (error) { return error; }
      }
      j.live = live;
      started = true;
      // Opened: the step draws as ready, not as still opening.
      j.opening = false;
      navigate({ kind: 'jstep', journey: target.id, step: target.steps[0].stepId });
    } finally {
      const wasOpening = j.opening;
      j.opening = false;
      // A run that opened navigates, which draws the step; one that didn't goes back to the journey, whose run has ended.
      if (wasOpening && !started) { if (stepRoute()) navigate({ kind: 'journey', journey: target.id }); else refresh(); }
    }
  }

  /** A Preview session that couldn't open: the busy store, or any other problem, as a dialog. Resolves true to try again. */
  const openFailed = error => confirmSessionOpenFailed({ error, capabilities: state.cap });

  const defaults = target => Object.fromEntries(Object.entries(target.inputs?.properties ?? {}).filter(([, schema]) => schema.default !== undefined).map(([name, schema]) => [name, schema.default]));

  /** A Send run asks once, before anything is sent: what each store keeps, in which environment (dialogs v8). */
  async function confirmSend(target) {
    return (await confirmSendRun({
      journey: target, capabilities: state.cap, inputs: j.inputs[target.id] ?? defaults(target),
      preview: !target.sendOnly && state.cap.previewSessions === true,
    })) === true;
  }

  /** The steps a run has run so far (not pending, not skipped). */
  const stepsRun = run => run.steps.filter(step => !['pending', 'skipped'].includes(step.status)).length;

  /** The held Preview session of the live run, when it holds steps: ending it would roll them back. */
  const heldSteps = () => {
    const live = j.live;
    return live && !live.review && live.run.mode === 'preview' && live.run.status === 'running' && live.session && !live.session.ended ? stepsRun(live.run) : 0;
  };

  /**
   * Ending the live run asks first when that throws something away: a Preview run's held steps
   * roll back; a Send run's earlier steps keep what they wrote, and the run won't finish. While it
   * asks, Run to end waits before its next step, so the answer is about the run as it is.
   * Resolves `{ go, undo }`: whether to end the run, and the undo operation if the person chose it.
   */
  async function confirmEnd() {
    const live = j.live;
    if (!live || live.review || live.run.status !== 'running' || !stepsRun(live.run)) return { go: true };
    const send = live.run.mode === 'send';
    const left = send ? leftBehind() : [];
    if (send && !left.length) return { go: true };
    live.hold = new Promise(resolve => { live.release = resolve; });
    try {
      if (!send) return { go: (await confirmEndRun({ journey: live.journey, run: live.run, envelopes: live.envelopes, heldMs: Math.round(performance.now() - live.started), capabilities: state.cap })) === true };
      const next = live.run.steps.findIndex(step => step.status === 'pending');
      const undo = undoFor(next < 0 ? live.run.steps.length : next);
      const choice = await confirmStopSend({ journey: live.journey, run: live.run, left, undo, capabilities: state.cap });
      return { go: choice === true || choice === 'undo', undo: choice === 'undo' ? undo : null };
    } finally {
      live.release();
      live.hold = null;
    }
  }

  /** Switching persona ends a held Preview session. Asks first, and rolls it back when confirmed; resolves whether to go on. */
  async function confirmPersona(user) {
    const held = heldSteps();
    if (!held) return true;
    const live = j.live;
    const choice = await confirmPersonaSwitch({ journey: live.journey, from: state.cap.identity, to: user, held, document: state.doc });
    if (choice !== true) return false;
    await endLive();
    return true;
  }

  /** The held session ended on its own: say what is safe, then end the run, and start it again if asked. */
  async function sessionEnded(live) {
    if (live.ending) return;
    live.ending = true;
    live.running = -1;
    const journeyId = live.journey.id;
    const noticed = Date.now();
    // The step that found the session gone goes back to not run: the failed request isn't a result,
    // so its raw error ("Request failed … HTTP 404") doesn't stay on screen behind the notice.
    if (state.result?.error) { state.result = undefined; state.resultTab = 'Expected'; }
    refresh();
    // The run's steps stay on screen behind the notice; the run ends (and is kept as stopped) when it closes.
    const again = await confirmSessionEnded({ journey: live.journey, run: live.run, capabilities: state.cap, idleSeconds: live.session?.idleTimeoutSeconds, lastActivity: live.lastActivity, now: noticed });
    if (j.live === live) await endLive();
    navigate({ kind: 'journey', journey: journeyId });
    if (again === true) await startRun('preview');
  }

  /** A journey that runs as a persona signs in as it first, through the personas source, so its session is that persona's. */
  async function signInAs(target, { notify = true } = {}) {
    const provider = personasProvider(state.cap);
    if (!target.runAs || !provider) return;
    try {
      const list = await (await fetch(provider.url, { credentials: 'include', redirect: 'error' })).json();
      const user = Array.isArray(list) ? list.find(item => item.email === target.runAs) : null;
      if (!user || user.name === state.cap.identity?.name) return;
      const response = await fetch(`${provider.url.replace(/\/$/, '')}/${encodeURIComponent(user.email)}`, { method: 'POST', credentials: 'include', redirect: 'error' });
      if (response.ok) {
        await refreshIdentity();
        // The sign-in is silent by design; this says it happened, so the byline and the next requests aren't a surprise.
        if (notify) showToast(t('jr.signedInAs', { name: user.name }), { glyph: 'user' });
      }
    } catch { /* The run goes ahead as whoever is signed in; the byline says who. */ }
  }

  /** Records one step's result in the run; rewinds or ends the session as the run requires. */
  function record(index, result, { preview, edited = [], onScreen = true }) {
    const live = j.live;
    if (!live || live.review) return;
    const step = live.journey.steps[index];
    const envelope = { changes: result.changes ?? [], effects: result.effects ?? [], logs: result.logs ?? [], blocked: result.blocked };
    const response = { statusCode: result.status, body: result.body, headers: result.headers };
    if (preview && live.run.mode === 'send') {
      // Previewing a step of a Send run on its own shows its result but records nothing.
      return;
    }
    if (preview) { live.session?.record(result); live.lastActivity = Date.now(); }
    const traced = preview || captured(result);
    const recorded = recordStep(live.run, step.stepId, { response, envelope: traced ? envelope : {}, durationMs: result.duration });
    // Stores this host doesn't hook, or an untraced Send, give "Not checked" in place of Missing.
    const unchecked = new Map((live.unchecked[step.stepId] ?? []).map(item => [item.id, item]));
    if (!traced) {
      for (const [i, write] of (step.expected?.writes ?? []).entries()) unchecked.set(`unchecked:${i}`, { id: `unchecked:${i}`, kind: 'unchecked', store: write.store, target: write.table ?? write.collection ?? write.key, op: write.op, fields: [], note: t('jr.unchecked.noTrace') });
      recorded.findings = [];
    }
    recorded.findings.push(...unchecked.values());
    // A traced Send carries the stores it hooks as changes (SQL, MongoDB in a transaction) or as
    // `Db` log entries (Redis and the other stores' commands), and compareStep matches both, so a
    // write that's still missing for a hooked store really is missing. Stores this host doesn't
    // hook were already turned into Not checked above.
    const bad = recorded.findings.some(finding => ['differs', 'missing', 'extra'].includes(finding.kind));
    if (recorded.status === 'failed' && !bad && recorded.criteria.every(criterion => criterion.passed)) {
      recorded.status = 'passed';
      recorded.verdict = recorded.findings.some(finding => finding.kind === 'approved' || finding.fields?.some(field => field.state === 'approved')) ? 'passed-approved' : 'passed';
    }
    if (live.run.status === 'failed' && live.run.steps.every(item => item.status === 'passed')) live.run.status = 'passed';
    Object.assign(recorded, { at: new Date().toISOString(), edited, preview: !!preview });
    live.envelopes[index] = envelope;
    if (!preview && (envelope.changes.length || envelope.effects.length)) (live.sent ??= []).push({ step: index + 1, envelope });
    live.responses[index] = result.body;
    live.contentTypes[index] = Object.entries(result.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    live.results[index] = result;
    // The form is this step's only when it was on screen; a step Run to end sent from its bindings
    // reopens with those, not with the form of the step that was showing.
    if (onScreen) live.drafts[index] = { paramValues: structuredClone(state.paramValues ?? {}), body: structuredClone(state.body) };
    else delete live.drafts[index];
    live.run.tally = tallyEnvelope(live.run.tally, traced ? envelope : {});
    if (live.run.status !== 'running') finishRun();
    refresh();
  }

  /** Before a step that ran already runs again: rewind the session to before it and forget later steps. */
  async function prepareRerun(index) {
    const live = j.live;
    const already = live.run.steps[index].status !== 'pending' && live.run.steps[index].status !== 'skipped';
    if (!already && live.run.status === 'running') return true;
    if (live.run.status !== 'running') {
      // A finished Preview run's session has rolled back: start the run again. A Send run that
      // stopped carries on from the step it stopped at; what earlier steps committed stays.
      if (live.run.mode === 'preview') { await startRun('preview'); return false; }
      Object.assign(live.run, { status: 'running', finishedAt: null, durationMs: null });
    }
    if (live.run.mode === 'preview' && live.session) {
      const sessionStep = live.run.steps.slice(0, index).filter(step => step.status === 'passed' || step.status === 'failed').length + 1;
      try { await live.session.rewind(sessionStep); } catch (error) {
        if (sessionGone(error)) sessionEnded(live); else showProblem(error.message);
        return false;
      }
    }
    for (let i = index; i < live.run.steps.length; i++) {
      Object.assign(live.run.steps[i], { status: 'pending', httpStatus: null, durationMs: null, criteria: [], outputs: {}, findings: [], verdict: null, bound: null });
      if (i > index) { live.results[i] = undefined; live.envelopes[i] = undefined; }
    }
    live.run.tally = live.envelopes.slice(0, index).reduce((tally, envelope) => tallyEnvelope(tally, envelope), { stores: {}, effects: 0 });
    return true;
  }

  /** Preview or Send the current step from its screen. */
  async function runStep(preview) {
    const index = liveStep();
    const live = j.live;
    if (index < 0 || !live) return false;
    if (live.review) { await startRun(live.run.mode === 'send' || live.journey.sendOnly ? 'send' : 'preview'); return true; }
    if (live.run.mode === 'preview' && !preview) return true;
    if (live.run.mode === 'send' && preview && live.journey.steps[index].op.method === 'GET') return true;
    if (!(preview && live.run.mode === 'send') && !(await prepareRerun(index))) return true;
    await results.run(preview);
    return true;
  }

  /** "Preview step 5" after step 4: open the next step and preview it. */
  async function runNext() {
    const index = liveStep();
    const next = j.live?.journey.steps[index + 1];
    if (!next) return;
    navigate({ kind: 'jstep', journey: j.live.journey.id, step: next.stepId });
    await results.run(j.live.run.mode !== 'send');
  }

  /** The request a step sends when it runs without its screen (Run to end, Run all). */
  function boundRequest(step, run) {
    const bound = bindStep(step.def, contextFor(run));
    const parameters = step.op.parameters.map(parameter => ({ ...parameter, value: { path: bound.path, query: bound.query, header: bound.headers }[parameter.in]?.[parameter.name] }));
    const headers = {};
    return makeRequest(step.op, parameters, encodeRequestBody(bound.body, step.def.requestBody?.contentType || 'application/json', headers), headers, basePath);
  }

  /** Runs the rest of the live run without stopping at each screen, then shows the summary or the stop. */
  async function runToEnd() {
    const live = j.live;
    const from = liveStep();
    if (!live || live.review || from < 0) return;
    if (!(await prepareRerun(from))) return;
    for (let index = from; index < live.journey.steps.length && live.run.status === 'running'; index++) {
      // An open "End run?" question holds the run before its next step, so what it says stays true.
      await live.hold;
      if (live.run.status !== 'running') break;
      const step = live.journey.steps[index];
      if (live.run.steps[index].status !== 'pending') continue;
      live.running = index;
      refresh();
      let result;
      try {
        const request = index === from ? readRequest() : boundRequest(step, live.run);
        if (live.run.mode === 'preview' && live.session) request.headers.set(SESSION_HEADER, live.session.id);
        result = await execute(request, live.run.mode === 'preview', basePath, undefined, { observedSend: live.run.mode === 'send' && state.cap.observedSend === true });
        result.finishedAt = Date.now();
      } catch (error) {
        live.running = -1;
        if (live.run.mode === 'preview' && sessionGone(error)) { sessionEnded(live); return; }
        showProblem(error.message);
        refresh();
        return;
      }
      record(index, result, { preview: live.run.mode === 'preview', edited: index === from ? editedTargets(index) : [], onScreen: index === from });
    }
    live.running = -1;
    if (j.live !== live) return;
    const stoppedAt = live.run.steps.findIndex(step => ['refused', 'blocked'].includes(step.status) || (step.status === 'failed' && live.run.status === 'stopped'));
    if (live.run.status === 'stopped' && stoppedAt >= 0) navigate({ kind: 'jstep', journey: live.journey.id, step: live.journey.steps[stoppedAt].stepId });
    else navigate({ kind: 'jrun', journey: live.journey.id, run: live.run.runId });
  }

  /** The current screen's request, as Send or Preview would make it. */
  let readRequest = () => { throw new Error('No request'); };

  /** Runs and the end of a run: the session rolls back, the run is kept in this browser. */
  function finishRun() {
    const live = j.live;
    live.session?.end();
    live.run.durationMs = view.runTime(live.run);
    const stored = { ...exportRun(live.run), by: live.run.by, tally: live.run.tally, ...(live.run.status === 'stopped' ? leftOver(live) : {}) };
    saveRun(storage, state.documentUrl, stored);
    announce(t('jr.finished', { name: live.journey.name, verdict: view.runVerdict(live.run).short }));
  }

  /** Ends the live run (Cancel, a new run, leaving): rolls its session back. A partial run is kept as stopped. */
  async function endLive({ keep = true } = {}) {
    const live = j.live;
    if (!live || live.review) { j.live = null; return; }
    if (live.run.status === 'running') {
      const ran = live.run.steps.some(step => step.status !== 'pending');
      for (const step of live.run.steps) if (step.status === 'pending') step.status = 'skipped';
      live.run.status = 'stopped';
      live.run.finishedAt = new Date().toISOString();
      if (keep && ran) { live.run.durationMs = view.runTime(live.run); saveRun(storage, state.documentUrl, { ...exportRun(live.run), by: live.run.by, tally: live.run.tally, ...leftOver(live), cancelled: true }); }
    }
    await live.session?.end();
    j.live = null;
  }

  /** Run all: previews every journey that can Preview, one after another, each in its own session. */
  async function runAll() {
    if (j.runningAll || state.cap.previewSessions !== true) return;
    j.runningAll = true;
    refresh();
    let passed = 0, failed = 0;
    // Inferred journeys carry no inputs or expectations: they're a starting point to fill in, not a check.
    for (const target of j.journeys.filter(item => !item.sendOnly && !item.inferred && item.steps.every(step => step.op))) {
      await signInAs(target, { notify: false });
      const inputs = structuredClone(j.inputs[target.id] ?? defaults(target));
      const { expectations, unchecked } = checkableExpectations(target.expectations, target.id, state.cap);
      const run = createRun({ journey: target.def, expectations, mode: 'preview', inputs, persona: target.runAs, store: sqlSystem(state.cap) });
      Object.assign(run, { by: state.cap.identity?.name ?? null, tally: { stores: {}, effects: 0 } });
      let session;
      while (!session) {
        try { session = await openSession(); } catch (error) { if (await openFailed(error) !== true) break; }
      }
      if (!session) break;
      for (const [index, step] of target.steps.entries()) {
        if (run.status !== 'running') break;
        try {
          const request = boundRequest(step, run);
          request.headers.set(SESSION_HEADER, session.id);
          const result = await execute(request, true, basePath);
          session.record(result);
          const envelope = { changes: result.changes ?? [], effects: result.effects ?? [], logs: result.logs ?? [], blocked: result.blocked };
          const recorded = recordStep(run, step.stepId, { response: { statusCode: result.status, body: result.body, headers: result.headers }, envelope, durationMs: result.duration });
          recorded.findings.push(...(unchecked[step.stepId] ?? []));
          recorded.at = new Date().toISOString();
          run.tally = tallyEnvelope(run.tally, envelope);
        } catch (error) {
          for (const item of run.steps.slice(index)) if (item.status === 'pending') item.status = 'skipped';
          run.status = 'stopped';
          run.finishedAt = new Date().toISOString();
          break;
        }
      }
      await session.end();
      run.durationMs = view.runTime(run);
      saveRun(storage, state.documentUrl, { ...exportRun(run), by: run.by, tally: run.tally });
      if (run.status === 'passed') passed++; else failed++;
      refresh();
    }
    j.runningAll = false;
    refresh();
    announce(t('jr.allDone', { passed: formatNumber(passed), failed: formatNumber(failed) }));
  }

  /* ---------- Drafts and copies ---------- */

  async function draft(button) {
    const live = j.live;
    const index = liveStep();
    if (!live || index < 0) return;
    const step = live.run.steps[index];
    const finding = step.findings.find(item => item.id === button.dataset.finding);
    if (!finding) return;
    const fields = (finding.fields ?? []).filter(field => field.state === 'differs');
    const field = fields.length ? fields[0] : undefined;
    const { text } = draftApprovedDifference({ journey: live.journey, stepId: step.stepId, finding, field, approvedBy: '', sqlStore: sqlSystem(state.cap) });
    await copyText(text, { button, what: t('jr.copy.draft') });
  }

  /** Copy as C# on the Database tab: this Preview's writes as an ExpectWrites block. */
  async function copyCSharp(button) {
    const result = state.result;
    if (!result?.preview) return;
    const index = liveStep();
    const refs = index >= 0 ? refsFor(j.live.journey, j.live.run, index - 1) : [];
    const stepVariable = index >= 0 ? j.live.journey.steps[index].stepId : 'step';
    await copyText(expectWritesCode({ changes: result.changes ?? [], effects: result.effects ?? [], refs, stepVariable }), { button, what: t('jr.copy.csharp') });
  }

  function download(name, type, text) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showProblem(message) {
    const slot = document.querySelector('[data-request-announcement]');
    if (slot) slot.textContent = message;
    const bar = document.querySelector('.workspace > .pane:not([hidden]) .actionbar .status');
    if (bar) bar.innerHTML = `${icon('alert', true)}<span>${esc(message)}</span>`;
  }

  /** Redraws what a run changes: the sidebar rail, the strip, the bar and the result pane (or the reading panes). */
  let redraw = () => {};
  function refresh() { redraw(); }

  /* ---------- Events ---------- */

  const actions = {
    'journey-preview-run': () => startRun('preview'),
    'journey-send-run': () => startRun('send'),
    'journey-run-to-end': () => runToEnd(),
    'journey-next-run': () => runNext(),
    'journey-summary': () => j.live && navigate({ kind: 'jrun', journey: j.live.journey.id, run: j.live.run.runId }),
    'journey-run-all': () => runAll(),
    'journey-end-run': async () => {
      const id = j.live?.journey.id;
      const { go, undo } = await confirmEnd();
      if (!go) return;
      await endLive();
      if (undo) {
        const parameters = undo.param && undo.value !== undefined ? { [`path:${undo.param}`]: undo.value } : {};
        navigate({ kind: 'op', id: opKey(undo.op) }, { reset: parameters });
      } else if (id) navigate({ kind: 'journey', journey: id });
    },
    'journey-back': () => navigate({ kind: 'journey', journey: j.open }),
    'journey-step-prev': () => stepBy(-1),
    'journey-step-next': () => stepBy(1),
    'journey-view': button => { j.view = button.dataset.viewKind; refresh(); },
    'journey-draft': button => draft(button),
    'journey-copy-csharp': button => copyCSharp(button),
    'journey-copy-json': button => j.summary && copyText(JSON.stringify(exportRun(j.summary), null, 2), { button, what: t('jr.copy.run') }),
    'journey-junit': () => j.summary && download(`${j.summary.journeyId}-${j.summary.runId.slice(0, 8)}.xml`, 'application/xml', toJUnit(j.summary)),
    'journey-copy-output': button => copyText(button.dataset.copy, { button, what: t('jr.copy.output') }),
    'journey-copy-cli': button => copyText(button.dataset.copy, { button, what: t('jr.copy.command') }),
    'journey-copy-snippet': button => copyText(button.dataset.copy, { button, what: t('jr.copy.code') }),
    'journey-copy-prompt': button => copyText(button.dataset.copy, { button, what: t('jr.copy.prompt') }),
    // From a stopped Send run's summary: the undo kept with the run, which opens its operation with the ID filled in.
    'journey-undo-run': button => {
      const { undoOp, undoParam, undoValue } = button.dataset;
      const parameters = undoParam && undoValue ? { [`path:${undoParam}`]: undoValue } : {};
      navigate({ kind: 'op', id: undoOp }, { reset: parameters });
    },
    'journey-undo': button => {
      const undo = undoFor(liveStep());
      if (!undo) return;
      const parameters = undo.param && undo.value !== undefined ? { [`path:${undo.param}`]: undo.value } : {};
      navigate({ kind: 'op', id: opKey(undo.op) }, { reset: parameters });
    },
  };

  function stepBy(delta) {
    const index = liveStep();
    const next = j.live?.journey.steps[index + delta];
    if (index < 0 || !next?.op) return;
    if (!j.live.review) j.live.drafts[index] = { paramValues: structuredClone(state.paramValues ?? {}), body: structuredClone(state.body) };
    navigate({ kind: 'jstep', journey: j.live.journey.id, step: next.stepId });
  }

  /** Clicks inside the workbench that belong to Journeys mode. Returns true when handled. */
  function click(event) {
    const plain = !(event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
    const mode = event.target.closest('[data-mode]');
    if (mode && plain) { event.preventDefault(); switchMode(mode.dataset.mode); return true; }
    if (!plain) return false;
    const filter = event.target.closest('[data-cmp-filter]');
    if (filter) { j.filter = filter.dataset.cmpFilter; results.renderResult(); document.querySelector(`[data-cmp-filter="${j.filter}"]`)?.focus(); return true; }
    const runTab = event.target.closest('[data-run-tab]');
    if (runTab) { j.runTab = runTab.dataset.runTab; refresh(); document.querySelector(`[data-run-tab="${j.runTab}"]`)?.focus(); return true; }
    const summaryStep = event.target.closest('[data-summary-step]');
    if (summaryStep) { event.preventDefault(); const index = Number(summaryStep.dataset.summaryStep); j.summaryOpen = j.summaryOpen === index ? -2 : index; refresh(); document.querySelector(`[data-summary-step="${index}"]`)?.focus(); return true; }
    const ad = event.target.closest('[data-ad-jump]');
    if (ad) { event.preventDefault(); document.getElementById(`ad-${ad.dataset.adJump}`)?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return true; }
    const stepLink = event.target.closest('[data-journey-step]');
    if (stepLink) {
      event.preventDefault();
      const id = stepLink.closest('[data-journey]')?.dataset.journey ?? j.open;
      if (stepLink.dataset.fromRun && j.live?.run.runId !== stepLink.dataset.fromRun) {
        const stored = j.summary?.runId === stepLink.dataset.fromRun ? j.summary : null;
        if (stored) j.live = { journey: journey(stored.journeyId), run: stored, review: true, envelopes: [], responses: [], contentTypes: [], drafts: [], results: [] };
      }
      if (!j.live || j.live.journey.id !== (id ?? j.open)) { navigate({ kind: 'journey', journey: j.open }); return true; }
      navigate({ kind: 'jstep', journey: j.live.journey.id, step: stepLink.dataset.journeyStep });
      return true;
    }
    const runLink = event.target.closest('[data-journey-run]');
    if (runLink) { event.preventDefault(); j.summaryOpen = -1; navigate({ kind: 'jrun', journey: j.open, run: runLink.dataset.journeyRun }); return true; }
    const item = event.target.closest('[data-journey]');
    if (item && item.matches('a')) { event.preventDefault(); j.view = 'overview'; navigate({ kind: 'journey', journey: item.dataset.journey }); return true; }
    const history = event.target.closest('.hr7-link');
    if (history) { event.preventDefault(); const run = /\/run\/([^/]+)$/.exec(history.getAttribute('href'))?.[1]; if (run) { j.summaryOpen = -1; navigate({ kind: 'jrun', journey: j.open, run: decodeURIComponent(run) }); } return true; }
    const button = event.target.closest('[data-action]');
    if (button && actions[button.dataset.action]) { if (button.tagName === 'A') event.preventDefault(); actions[button.dataset.action](button); return true; }
    return false;
  }

  // A closing page ends every session the tab holds (a live run's, or Run all's), so none is left to its idle timeout.
  globalThis.addEventListener?.('pagehide', () => { endHeldSessions({ keepalive: true }); });

  /** Arrow keys move along the comparison filter, a radio group (WAI-ARIA radio pattern). */
  function keydown(event) {
    const radio = event.target.closest?.('[data-cmp-filter]');
    if (!radio || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return false;
    const radios = [...radio.closest('[role="radiogroup"]').querySelectorAll('[data-cmp-filter]:not(:disabled)')];
    const rtl = document.documentElement.dir === 'rtl';
    const step = ['ArrowDown', rtl ? 'ArrowLeft' : 'ArrowRight'].includes(event.key) ? 1 : -1;
    const index = radios.indexOf(radio);
    const next = event.key === 'Home' ? radios[0] : event.key === 'End' ? radios.at(-1) : radios[(index + step + radios.length) % radios.length];
    event.preventDefault();
    next?.click();
    return true;
  }

  return {
    enabled, load, applyRoute, renderReading, keydown, stepChrome, decorateStep, hooks, click, switchMode, markMode, runStep, runToEnd,
    sidebar: sidebarProvider, endLive, confirmPersona,
    /** The phone's pane switch names what each side holds: Journey | Runs, Summary | Differences, Step | Result. */
    paneNames: view => view === 'journey' ? [t('jr.pane.journey'), t('jr.runs')] : view === 'jrun' ? [t('jr.pane.summary'), t('jr.pane.details')]
      : liveStep() >= 0 ? [t('jr.pane.step'), t('shell.result')] : [t('shell.request'), t('shell.result')],
    get mode() { return state.mode; },
    get ready() { return j.status === 'ready'; },
    /** True while Try it shows a journey step, so Preview and Send run it as a step. */
    stepActive: () => liveStep() >= 0,
    canRunToEnd: () => liveStep() >= 0 && !j.live.review && j.live.run.status === 'running',
    stepBy,
    setReadRequest(fn) { readRequest = fn; },
    setRedraw(fn) { redraw = fn; },
    copyCSharpButton: () => enabled() && state.result?.preview && state.result.changes?.length
      ? `<button type="button" class="btn btn-sm" data-action="journey-copy-csharp" title="${esc(t('jr.copyCSharpTip'))}">${icon('code', true)}${esc(t('jr.copyCSharp'))}</button>` : '',
  };

}
