// Journeys mode's markup (mocks/v7-journeys.js, screens 132–151 and m32–m40): the mode switch,
// the journeys sidebar with its progress rail, the overview, the step strip and bound-field
// chips, the Expected tab before a step runs and the comparison after, the run summary, the
// stopped run, and the empty and loading states. Builders return HTML; everything the API
// publishes (journey, step and table names, values, reasons) is escaped and marked lang="en", and
// values and expressions stay left to right in right-to-left layouts.
import { copyButton, esc, icon, method, stateBlock, tab } from './components.js';
import { current, formatDuration, formatList, formatNumber, t, th } from './i18n.js';
import { shortcutAttrs, shortcutHint, shortcutLong } from './shortcuts.js';
import { storeMark, storeName, sqlSystem } from './stores.js';
import { criteriaOf, expectedStatus, journeyGroups, stepBindings, writeSummary } from './journeys-model.js';
import { leftParts, moreText, undoSub } from './journeys-dialogs.js';
import { findingCounts, lastRanStep, runEnded, stepProblems } from './journeys-runs.js';
import { highlightJson, highlightSnippet } from './highlight.js';

const ltr = html => `<bdi dir="ltr">${html}</bdi>`;
/** Isolated, with its own direction: localized text such as a duration ("12 ملي ث") reads in its language's order. */
const iso = html => `<bdi>${html}</bdi>`;
const en = text => `<span lang="en">${esc(text)}</span>`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** A captured value on one line: IDs shortened in the middle, date-times to the second; the full value in its title. */
/** MongoDB Extended JSON ({ "$date": "…" }, { "$oid": "…" }, { "$numberLong": "5" }) as the plain value it stands for. */
const unextend = value => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1) {
    const [key, inner] = Object.entries(value)[0];
    if (/^\$(date|oid|numberLong|numberInt|numberDouble|numberDecimal|uuid)$/.test(key)) return unextend(inner !== null && typeof inner === 'object' && '$numberLong' in inner ? inner.$numberLong : inner);
  }
  return value;
};
const compact = raw => {
  const value = unextend(raw);
  if (Array.isArray(value) && value.every(item => item === null || typeof item !== 'object')) return value.map(item => display(item ?? '')).join(', ');
  const text = display(value);
  if (UUID.test(text)) return `${text.slice(0, 8)}…${text.slice(-4)}`;
  const date = DATE_TIME.exec(text);
  if (date) return `${date[1]}\u00a0${date[2]}`;
  return text;
};
const v = value => { const text = display(unextend(value)); const shown = compact(value); return ltr(`<span class="j7-v"${shown !== text ? ` title="${esc(text)}"` : ''}>${esc(shown)}</span>`); };
const code = text => `<code dir="ltr">${esc(text)}</code>`;
/** A value as people read it: strings as they are, anything else as JSON. */
export const display = value => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
/** A long ID shortened in the middle, the full value in its title: 5e3a91c0…c2d1. */
export const short = value => { const text = display(value); return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text; };
const OP_BADGE = { insert: ['ins', '+ INSERT'], update: ['upd', '~ UPDATE'], delete: ['del', '− DELETE'] };
export const opBadge = op => OP_BADGE[op] ? `<span class="op-badge op-${OP_BADGE[op][0]}" dir="ltr">${OP_BADGE[op][1]}</span>` : `<span class="op-badge" dir="ltr">${esc(String(op || '').toUpperCase())}</span>`;
const sectionLabel = (label, end = '') => `<h2 class="section-label j7-sl"><span>${esc(label)}</span><span class="rule" aria-hidden="true"></span>${end}</h2>`;
const slEnd = (html, cls = '') => `<span class="j7-sl-end${cls ? ' ' + cls : ''}">${html}</span>`;
const stepNumber = (journey, stepId) => journey.steps.findIndex(step => step.stepId === stepId) + 1;
const stepTitle = step => step.op?.title || step.def.description || step.stepId;
const hhmm = when => new Intl.DateTimeFormat(current().locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(when));
const hhmmss = when => new Intl.DateTimeFormat(current().locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(when));
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
/** "Today, 14:02" or "20 Nov, 16:15". */
export function when(iso, now = Date.now()) {
  if (sameDay(iso, now)) return t('jr.todayAt', { time: hhmm(iso) });
  return new Intl.DateTimeFormat(current().locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
const fullDate = iso => new Intl.DateTimeFormat(current().locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
/** The time a run's steps took: the sum of their own times, not the minutes spent between them. */
export const runTime = run => (run?.steps ?? []).reduce((total, step) => total + (step.durationMs ?? 0), 0);

/* ---------- References: where a value came from ---------- */

/** "step 1 · orderId" or "input · shippingMethod" for a runtime expression; '' for a literal. */
export function refChip(expression, journey, { long = false } = {}) {
  const input = /^\$inputs\.([\w-]+)/.exec(expression ?? '');
  if (input) return `<span class="ref7 is-in">${icon('bind', true, 'i-dir')}${esc(long ? t('jr.bind.input') : t('jr.ref.input'))} · ${ltr(code(input[1]))}</span>`;
  const step = /^\$steps\.([^.]+)\.outputs\.([\w.-]+)/.exec(expression ?? '');
  if (step) {
    const n = journey ? stepNumber(journey, step[1]) : 0;
    return `<span class="ref7">${icon('bind', true, 'i-dir')}${esc(t(long ? 'jr.bind.fromStep' : 'jr.ref.step', { n: formatNumber(n) }))} · ${ltr(code(step[2]))}</span>`;
  }
  return '';
}

/** An expected value as recorded in a finding (a literal, or a matcher's description), as plain text for one-line rows. */
export function expectedPlain(expected) {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('from' in expected || 'to' in expected) return `${compact(expected.from)} → ${compact(expected.to)}`;
    if ('pattern' in expected) return `${t('jr.matches')} ${expected.pattern}`;
    if ('type' in expected) return expected.type === 'any' ? t('jr.anyValue') : t('jr.anyType', { type: expected.type });
  }
  return compact(expected);
}
const ev = expected => ltr(`<span class="j7-v">${esc(expectedPlain(expected))}</span>`);

/** One side of a "Paid → Shipped" change reads as the bare value. */
const changeSide = (raw, journey) => typeof raw === 'string' && !raw.startsWith('$') ? ltr(`<span class="j7-v">${esc(raw)}</span>`) : expectedValue(raw, journey);

/** An expected value from the expectations document, as people read it. */
export function expectedValue(raw, journey) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    if ('from' in raw || 'to' in raw) return `${changeSide(raw.from, journey)} → ${changeSide(raw.to, journey)}`;
    if ('pattern' in raw) return `${esc(t('jr.matches'))} ${ltr(code(raw.pattern))}`;
    if ('type' in raw) return esc(raw.type === 'any' ? t('jr.anyValue') : t('jr.anyType', { type: raw.type }));
  }
  if (typeof raw === 'string' && raw.startsWith('$')) return refChip(raw, journey) || ltr(code(raw));
  if (typeof raw === 'string') return ltr(`<span class="j-s">"${esc(raw)}"</span>`);
  return v(raw);
}

/* ---------- Mode switch ---------- */

/** Specification | Journeys: the app's segmented control, both modes one click apart. */
export function modeSwitch(mode, { drawer = false } = {}) {
  const item = (id, glyph, label, shortcut) => `<a href="#${id === 'spec' ? 'spec' : 'journeys'}" class="mode7-i" data-mode="${id}"${id === mode ? ' aria-current="page"' : ''} ${shortcutAttrs(shortcut)} title="${esc(`${label} · ${shortcutLong(shortcut)}`)}">${icon(glyph, true)}<span>${esc(label)}</span></a>`;
  return `<nav class="mode7" aria-label="${esc(t('jr.mode'))}"${drawer ? ' data-mode-drawer' : ''}>${item('spec', 'braces', t('jr.mode.spec'), 'mode-spec')}${item('journeys', 'route', t('jr.mode.journeys'), 'mode-journeys')}</nav>`;
}

/* ---------- Sidebar ---------- */

/** The head row in place of the tabs: where the journeys come from, opening the Arazzo document. */
export function sidebarHead({ journeys, loading, sources }) {
  if (loading) return `<span class="jh7-src">${icon('file-code', true)}<span class="sk sk-line" style="inline-size:7.5rem"></span></span>`;
  const published = journeys.filter(journey => !journey.inferred);
  if (!published.length) return `<span class="jh7-src is-none">${icon('braces', true)}<span>${esc(t(journeys.length ? 'jr.head.inferred' : 'jr.head.none'))}</span></span>`;
  const source = sources[0] ?? {};
  const fromCode = source.source !== 'file';
  const name = fromCode ? (published[0].definedIn?.type ? `${published[0].definedIn.namespace || source.name || ''}` : source.name) : String(source.arazzoUrl || '').split('/').pop();
  return `<a href="${esc(source.arazzoUrl || '#')}" target="_blank" rel="noopener noreferrer" class="jh7-src" title="${esc(t(fromCode ? 'jr.head.codeTip' : 'jr.head.fileTip'))}">${icon('braces', true)}<span>${esc(t(fromCode ? 'jr.head.code' : 'jr.head.file'))}</span><code dir="ltr">${esc(name || source.name || '')}</code></a>`;
}

const LAST = {
  passed: ['circle-check', 'ok', 'jr.last.passed'], failed: ['circle-x', 'danger', 'jr.last.failed'], stopped: ['circle-x', 'danger', 'jr.last.failed'],
  ended: ['stop', 'muted', 'jr.last.ended'],
  none: ['circle-dashed', 'muted', 'jr.last.none'], sendonly: ['flask-off', 'warn', 'jr.last.sendOnly'], running: ['circle-dashed', 'muted', 'jr.last.none'],
};
function lastMark(kind) {
  const [glyph, tone, key] = LAST[kind] ?? LAST.none;
  return `<span class="lr7 is-${tone}" title="${esc(t(key))}">${icon(glyph, true)}<span class="sr-only">${esc(t(key))}</span></span>`;
}

/** The rail: the open journey's steps under its row while a run is open. */
export function railList(journey, run, { here = -1, running = -1 } = {}) {
  const items = journey.steps.map((step, index) => {
    const result = run?.steps?.[index];
    const status = result?.status ?? 'pending';
    const kind = index === running ? 'current' : status === 'passed' ? 'done' : status === 'failed' ? 'fail' : ['refused', 'blocked'].includes(status) ? 'refused' : status === 'skipped' ? 'skipped' : index === here ? 'current' : 'pending';
    const node = { done: icon('check', true), fail: icon('x', true), refused: icon('x', true), skipped: icon('minus', true) }[kind] || esc(formatNumber(index + 1));
    let sub;
    if (index === running) sub = `<span class="spinner" aria-hidden="true"></span>${esc(t('jr.rail.running'))}`;
    else if (result && result.httpStatus != null) {
      const counts = findingCounts(result);
      const extra = kind === 'fail' && counts.problems ? ` · <span class="r7-bad">${esc(t('jr.problems', { n: counts.problems }))}</span>`
        : kind === 'refused' ? ` · <span class="r7-bad">${esc(t(status === 'blocked' ? 'jr.rail.blocked' : 'jr.rail.refused'))}</span>`
        : counts.approved ? ` · <span class="r7-ad">${esc(t('jr.approvedN', { n: counts.approved }))}</span>` : '';
      sub = `${ltr(esc(result.httpStatus))} · ${iso(esc(formatDuration(result.durationMs ?? 0)))}${extra}`;
    } else sub = esc(t(kind === 'current' ? (run?.mode === 'send' ? 'jr.rail.readySend' : 'jr.rail.ready') : kind === 'skipped' ? 'jr.rail.skipped' : 'jr.rail.notRun'));
    const sr = t({ done: 'jr.sr.passed', fail: 'jr.sr.failed', refused: 'jr.sr.refused', current: 'jr.sr.current', pending: 'jr.sr.pending', skipped: 'jr.sr.skipped' }[kind]);
    return `<li class="r7 is-${kind}"><a href="#journey/${encodeURIComponent(journey.id)}/step/${encodeURIComponent(step.stepId)}" class="r7-link" data-journey-step="${esc(step.stepId)}"${index === here ? ' aria-current="step"' : ''}>
      <span class="r7-node" aria-hidden="true">${node}</span>
      <span class="r7-text"><span class="r7-name" lang="en">${esc(stepTitle(step))}</span><span class="r7-sub">${sub}</span></span>
      <span class="sr-only">, ${esc(sr)}</span></a></li>`;
  }).join('');
  return `<ol class="rail7" aria-label="${esc(t('jr.steps'))}">${items}</ol>`;
}

/** The journeys list: groups from the Arazzo documents, the step count, the last result; the open run's rail. */
export function journeysNav({ journeys, query = '', open, run, here, running, lastStatus, isCollapsed }) {
  const matching = journeys.filter(journey => `${journey.name} ${journey.id} ${journey.group}`.toLowerCase().includes(query));
  if (!matching.length) return '';
  return journeyGroups(matching).map(([name, items, inferred], index) => {
    const key = inferred ? '__inferred' : name;
    const expanded = !!query || !isCollapsed(key);
    return `<div class="nav-group${inferred ? ' j7-inferred' : ''}">
      <button type="button" class="nav-heading" data-group="${esc(key)}" data-group-kind="journeys" aria-controls="jgrp-${index}" aria-expanded="${expanded}">${icon(expanded ? 'chevron-down' : 'chevron-right', true)}<span${inferred ? '' : ' lang="en"'}>${esc(inferred ? t('jr.inferred') : name)}</span><span class="count">${esc(formatNumber(items.length))}</span></button>
      <ul id="jgrp-${index}"${expanded ? '' : ' hidden'}>${items.map(journey => {
        const isOpen = journey.id === open;
        const rail = isOpen && run ? railList(journey, run, { here, running }) : '';
        const last = journey.sendOnly && !lastStatus(journey.id) ? 'sendonly' : lastStatus(journey.id) ?? 'none';
        return `<li><a class="nav-item jn7${isOpen ? ' is-here' : ''}${rail ? ' has-rail' : ''}" href="#journey/${encodeURIComponent(journey.id)}" data-journey="${esc(journey.id)}"${isOpen && here < 0 ? ' aria-current="page"' : isOpen ? ' aria-current="location"' : ''}${rail ? ' aria-expanded="true"' : ''} title="${esc(journey.name)}">
          <span class="jn7-n" title="${esc(t('jr.stepsN', { n: journey.steps.length }))}">${esc(formatNumber(journey.steps.length))}</span><span class="label-text" lang="en">${esc(journey.name)}</span>
          <span class="trail">${lastMark(last)}</span></a>${rail}</li>`;
      }).join('')}</ul></div>`;
  }).join('');
}

/** Skeleton groups in the shape of the real list, so nothing moves when it loads. */
export function journeysNavLoading() {
  const row = width => `<li><span class="nav-item j7-sk"><span class="sk j7-sk-box"></span><span class="sk sk-line" style="inline-size:${width}%"></span><span class="sk j7-sk-dot"></span></span></li>`;
  return `<div aria-busy="true" aria-label="${esc(t('jr.loading'))}">${[[72, 58, 64], [66, 48], [78], [70, 60]].map(widths =>
    `<div class="nav-group"><span class="nav-heading j7-sk-h"><span class="sk sk-line" style="inline-size:46%"></span></span><ul>${widths.map(row).join('')}</ul></div>`).join('')}</div>`;
}

/** No journeys and no links to infer one from. */
export const journeysNavEmpty = () => stateBlock({ glyph: 'route', compact: true, title: esc(t('jr.side.emptyTitle')), body: esc(t('jr.side.emptyBody')) });

/** The bar under the list: Run all, then Collapse all. */
export function journeysFoot({ disabled = false, allCollapsed = false, runningAll = false } = {}) {
  const runAll = `<button type="button" class="btn btn-sm run7-btn" data-action="journey-run-all" title="${esc(t('jr.runAllTip'))}"${disabled || runningAll ? ' disabled' : ''}>${runningAll ? '<span class="spinner" aria-hidden="true"></span>' : icon('play', true, 'i-dir')}${esc(t('jr.runAll'))}</button>`;
  if (disabled) return runAll;
  return `${runAll}<button type="button" class="btn btn-ghost btn-xs" data-action="toggle-groups" title="${esc(t(allCollapsed ? 'side.expandAll' : 'side.collapseAll'))}">${icon('chevrons-ud', true)}<span class="lbl">${esc(t(allCollapsed ? 'side.expandAll' : 'side.collapseAll'))}</span></button>`;
}

/* ---------- Context bars ---------- */

function crumbs(items, end = '') {
  return `<div class="ctx-bar"><nav class="crumbs" aria-label="${esc(t('crumbs'))}" style="--parents:${items.length - 1}"><ol>${items.map(item => item.here
    ? `<li><span aria-current="page"${item.lang ? ' lang="en"' : ''} title="${esc(item.label)}">${item.html ?? esc(item.label)}</span></li>`
    : `<li><a href="${esc(item.href)}"${item.lang ? ' lang="en"' : ''} title="${esc(item.label)}">${esc(item.label)}</a></li>`).join('')}</ol></nav><div class="end">${end}</div></div>`;
}

/** Journeys › Order to shipment, with Overview | Arazzo at the end. */
export function overviewContext(journey, view = 'overview') {
  const viewSwitch = journey.inferred ? '' : `<div class="segmented view-switch" role="group" aria-label="${esc(t('jr.view'))}">
    <button type="button" data-action="journey-view" data-view-kind="overview" aria-pressed="${view === 'overview'}">${icon('route', true)}${esc(t('jr.view.overview'))}</button>
    <button type="button" data-action="journey-view" data-view-kind="arazzo" aria-pressed="${view === 'arazzo'}">${icon('code', true)}Arazzo</button></div>`;
  return crumbs([{ label: t('jr.mode.journeys'), href: '#journeys' }, { label: journey.name, here: true, lang: true }], viewSwitch);
}

/** Order to shipment › 4 · Ship order, with previous and next step. */
export function stepContext(journey, index) {
  const step = journey.steps[index];
  const nav = `<div class="j7-stepnav">
    <button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="journey-step-prev" aria-label="${esc(t('jr.prevStep'))}" title="${esc(`${t('jr.prevStep')} · ${shortcutLong('step-previous')}`)}" ${shortcutAttrs('step-previous')}${index === 0 ? ' disabled' : ''}>${icon('chevron-left', true)}</button>
    <button type="button" class="btn btn-ghost btn-icon btn-sm" data-action="journey-step-next" aria-label="${esc(t('jr.nextStep'))}" title="${esc(`${t('jr.nextStep')} · ${shortcutLong('step-next')}`)}" ${shortcutAttrs('step-next')}${index === journey.steps.length - 1 ? ' disabled' : ''}>${icon('chevron-right', true)}</button></div>`;
  return crumbs([{ label: journey.name, href: `#journey/${encodeURIComponent(journey.id)}`, lang: true },
    { label: `${index + 1} · ${stepTitle(step)}`, here: true, lang: true, html: `${esc(formatNumber(index + 1))} · <span lang="en">${esc(stepTitle(step))}</span>` }], nav);
}

/* ---------- Step strip, chips and the step's action bar ---------- */

/** Step N of M, the run's mode, then one segment per step. */
export function stepStrip(journey, run, index, { capabilities = {}, end = '', sessionEnded = false } = {}) {
  const segments = journey.steps.map((step, i) => {
    const status = run?.steps?.[i]?.status;
    const kind = status === 'passed' ? 'done' : status === 'failed' ? 'fail' : ['refused', 'blocked'].includes(status) ? 'refused' : status === 'skipped' ? 'skipped' : i === index ? 'current' : 'pending';
    return `<span class="sh7-seg is-${kind}" title="${esc(t('jr.stepN', { n: formatNumber(i + 1) }))}"></span>`;
  }).join('');
  const done = (run?.steps ?? []).filter(step => step.status === 'passed').length;
  const send = run?.mode === 'send';
  const database = typeof capabilities.database === 'string' ? capabilities.database : capabilities.database?.name;
  const pill = send
    ? `<span class="pill j7-pill-send">${icon('send', true)}${esc(t('jr.sendRun'))}</span>`
    : `<span class="pill pill-accent">${icon('flask', true)}${esc(t('jr.previewRun'))}</span>`;
  const note = send
    ? `<span class="sh7-note">${icon('db', true)}<span>${database ? th('jr.strip.commits', { db: ltr(code(database)) }) : esc(t('jr.strip.commitsAny'))}</span></span>`
    : `<span class="sh7-note" title="${esc(t(sessionEnded ? 'jr.strip.ended' : 'jr.strip.held'))}">${icon(sessionEnded ? 'undo' : 'clock', true, sessionEnded ? 'i-dir' : '')}<span>${esc(t(sessionEnded ? 'jr.strip.ended' : 'jr.strip.held'))}</span></span>`;
  return `<div class="sh7"><div class="sh7-top"><strong class="sh7-step">${esc(t('jr.stepOf', { n: formatNumber(index + 1), total: formatNumber(journey.steps.length) }))}</strong>${pill}${note}${end}</div>
    <div class="sh7-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${journey.steps.length}" aria-valuenow="${done}" aria-label="${esc(t('jr.stepsDone', { n: formatNumber(done), total: formatNumber(journey.steps.length) }))}">${segments}</div></div>`;
}

/** The chip in a bound field's label row: "From step 1 · orderId", "Journey input" or "Fixed". */
export function bindChip(binding, journey) {
  if (binding.from === 'step') {
    const name = /\.outputs\.([\w.-]+)$/.exec(binding.expression)?.[1] ?? '';
    return `<span class="bind7" title="${esc(binding.expression)}">${icon('bind', true, 'i-dir')}${esc(t('jr.bind.fromStep', { n: formatNumber(stepNumber(journey, binding.stepId)) }))} · ${ltr(code(name))}</span>`;
  }
  if (binding.from === 'input') return `<span class="bind7 is-in" title="${esc(binding.expression)}">${icon('bind', true, 'i-dir')}${esc(t('jr.bind.input'))}</span>`;
  return `<span class="bind7 is-fixed">${esc(t('jr.bind.fixed'))}</span>`;
}

/** A bound field's status line: what it sends and the expression it came from. */
export function bindStatus(binding) {
  if (binding.from === 'fixed') return esc(t('jr.bind.setByJourney'));
  const value = binding.value === undefined ? '' : `${esc(t('jr.sends'))} ${ltr(code(short(binding.value)))} · `;
  return `${value}${ltr(code(binding.expression))}`;
}

/**
 * A journey action bar's status line: an icon and one natural sentence that never wraps or
 * truncates. When the buttons leave no room for the sentence the CSS collapses the line to its
 * icon (the sentence stays the tooltip and the accessible name).
 */
function statusLine(iconHtml, text, tone = '', tip = text) {
  return `<span class="status${tone ? ' ' + tone : ''}" title="${esc(tip)}">${iconHtml}<span>${esc(text)}</span></span>`;
}

/** The status while a Preview session opens, and the glyph a button that starts one shows meanwhile: a spinner of the glyph's size. */
const openingStatus = () => statusLine('<span class="spinner" aria-hidden="true"></span>', t('jr.opening'));
const openingGlyph = (opening, glyph, dir = '') => opening ? '<span class="spinner" aria-hidden="true"></span>' : icon(glyph, true, dir);

/** The action bar of a step: the status on the start, the run buttons at the end. */
export function stepBar(journey, run, index, { busy = false, running = -1, edited = 0, canPreview = true, opening = false } = {}) {
  const step = journey.steps[index];
  const result = run?.steps?.[index];
  const n = formatNumber(index + 1);
  const next = journey.steps[index + 1];
  const ran = result && result.status !== 'pending' && result.status !== 'skipped';
  const stoppedHere = run?.status === 'stopped' && ['refused', 'failed', 'blocked'].includes(result?.status) && run.steps.slice(index + 1).every(item => item.status === 'skipped');
  let status;
  if (opening) status = openingStatus();
  else if (running >= 0) status = statusLine('<span class="spinner" aria-hidden="true"></span>', t('jr.bar.running', { n: formatNumber(running + 1), total: formatNumber(journey.steps.length) }));
  else if (stoppedHere) status = statusLine(icon('ban', true), t('jr.bar.stopped', { n }), 'is-bad7');
  else if (ran && result.status !== 'passed') status = statusLine(icon('circle-x', true), t('jr.failed'), 'is-bad7');
  else if (ran) status = statusLine(icon('circle-check', true), t('jr.passed'));
  else if (edited) status = statusLine(icon('edit', true), t('jr.bar.edited', { n: edited }));
  else if (run?.mode === 'send') status = statusLine(icon('db', true), t('jr.bar.commits'));
  else status = statusLine(icon('bind', true, 'i-dir'), t(index ? 'jr.bar.fromEarlier' : 'jr.bar.fromInputs'));
  const disabled = busy || opening || running >= 0 ? ' disabled' : '';
  const kbd = id => shortcutHint(id);
  // The buttons that start a Preview session show a spinner in place of their glyph while it opens.
  const spin = (glyph, dir) => openingGlyph(opening, glyph, dir);
  const pending = opening ? ' aria-busy="true"' : '';
  const summary = `<button type="button" class="btn btn-run btn-send" data-action="journey-summary"${disabled}>${icon('arrow-right', true)}<span>${esc(t('jr.bar.summary'))}</span></button>`;
  if (run?.mode === 'send') {
    // A Send run: Preview the step on its own first, then Send it (mock 136); after it passed,
    // Send the next one; where the run stopped, Send again or Preview it (mock 143).
    const previewButton = `<button type="button" class="btn btn-run ${stoppedHere ? 'btn-primary btn-preview' : 'btn-send'}" data-action="preview" ${shortcutAttrs('preview')}${canPreview ? '' : ' aria-disabled="true" title="' + esc(t('jr.bar.noGetPreview')) + '"'}${disabled}>${icon('flask', true)}<span>${esc(t('jr.bar.previewStep', { n }))}</span>${kbd('preview')}</button>`;
    if (stoppedHere) return `${status}<button type="button" class="btn btn-run btn-send" data-action="send" ${shortcutAttrs('send')}${disabled}>${icon('send', true)}<span>${esc(t('jr.bar.sendAgain'))}</span>${kbd('send')}</button>${previewButton}`;
    if (run.status !== 'running' && ran) return `${status}<button type="button" class="btn btn-primary btn-run" data-action="journey-summary"${disabled}>${icon('arrow-right', true)}<span>${esc(t('jr.bar.summary'))}</span></button>`;
    if (ran && next && run.status === 'running') return `${status}<button type="button" class="btn btn-run btn-send" data-action="send" ${shortcutAttrs('send')}${disabled}>${icon('send', true)}<span>${esc(t('jr.bar.sendAgain'))}</span>${kbd('send')}</button>
      <button type="button" class="btn btn-primary btn-run" data-action="journey-next-run" ${shortcutAttrs('preview')}${disabled}>${icon('send', true)}<span>${esc(t('jr.bar.sendStep', { n: formatNumber(index + 2) }))}</span>${kbd('preview')}</button>`;
    return `${status}${previewButton}<button type="button" class="btn btn-primary btn-run" data-action="send" ${shortcutAttrs('send')}${disabled}>${icon('send', true)}<span>${esc(ran ? t('jr.bar.sendAgain') : t('jr.bar.sendStep', { n }))}</span>${kbd('send')}</button>`;
  }
  if (run?.status && run.status !== 'running' && (ran && index === journey.steps.length - 1 || stoppedHere)) {
    return `${status}${summary}<button type="button" class="btn btn-primary btn-run btn-preview" data-action="journey-preview-run" ${shortcutAttrs('preview')}${disabled}${pending}>${spin('refresh')}<span>${esc(t('jr.previewAgain'))}</span>${kbd('preview')}</button>`;
  }
  const primary = ran && next
    ? `<button type="button" class="btn btn-primary btn-run btn-preview" data-action="journey-next-run" ${shortcutAttrs('preview')}${disabled}${pending}>${spin('flask')}<span>${esc(t('jr.bar.previewStep', { n: formatNumber(index + 2) }))}</span>${kbd('preview')}</button>`
    : `<button type="button" class="btn btn-primary btn-run btn-preview" data-action="preview" ${shortcutAttrs('preview')}${disabled}${pending}>${spin('flask')}<span>${esc(t(ran ? 'jr.bar.previewAgain' : 'jr.bar.previewStep', { n }))}</span>${kbd('preview')}</button>`;
  const toEnd = next || !ran
    ? `<button type="button" class="btn btn-run btn-send" data-action="journey-run-to-end" ${shortcutAttrs('run-to-end')}${disabled}${pending}>${spin('forward', 'i-dir')}<span>${esc(t('jr.bar.runToEnd'))}</span>${kbd('run-to-end')}</button>` : '';
  return `${status}${toEnd}${primary}`;
}

/* ---------- The result pane before and after a step runs ---------- */

/** What a step should write, grouped by store, before it runs. */
export function expectList(journey, index, { capabilities = {} } = {}) {
  const step = journey.steps[index];
  const expected = step.expected;
  const n = formatNumber(index + 1);
  const criteria = criteriaOf(step);
  const sql = sqlSystem(capabilities);
  const sqlName = typeof capabilities.database === 'string' ? capabilities.database : capabilities.database?.name;
  const intro = `<div class="j7-intro"><h3>${esc(t('jr.exp.title', { n }))}</h3><p>${esc(t(expected ? 'jr.exp.body' : 'jr.exp.bodyNone'))}</p></div>`;
  const crit = criteria.map(condition => `<div class="crit7"><span class="crit7-l">${esc(t('jr.succeedsWhen'))}</span><code dir="ltr">${esc(condition)}</code>${journey.source === 'code' && /^\$statusCode == \d+$/.test(condition) ? `<span class="crit7-src">${ltr(code(`SucceedsWith(${condition.split('==')[1].trim()})`))}</span>` : ''}</div>`).join('');
  if (!expected) {
    return `${intro}${crit}${stateBlock({ glyph: 'db', compact: true, title: esc(t('jr.exp.noneTitle')), body: esc(t(journey.inferred ? 'jr.exp.inferredBody' : 'jr.exp.noneBody')) })}`;
  }
  const writes = expected.writes ?? [];
  const groups = new Map();
  for (const write of writes) {
    const system = write.store || sql;
    if (!groups.has(system)) groups.set(system, []);
    groups.get(system).push(write);
  }
  const row = write => {
    const target = write.table ?? write.collection ?? write.key;
    const keys = write.key && typeof write.key === 'object' ? Object.entries(write.key) : [];
    const fields = Object.entries(write.values ?? {});
    return `<li class="ex7"><div class="ex7-head">${opBadge(write.op)}<span class="ex7-t" dir="ltr">${esc(target)}</span>${keys.map(([name, raw]) => `<span class="ex7-key"><code dir="ltr">${esc(name)}</code> = ${expectedValue(raw, journey)}</span>`).join('')}</div>
      ${fields.length ? `<dl class="ex7-f">${fields.map(([name, raw]) => `<div><dt dir="ltr">${esc(name)}</dt><dd>${expectedValue(raw, journey)}</dd></div>`).join('')}</dl>` : ''}</li>`;
  };
  const storeGroup = (system, items) => {
    const isSql = system === sql || (!capabilities.dataStores?.some(store => store.system === system) && items.every(item => item.table));
    const name = isSql ? sqlName : capabilities.dataStores?.find(store => store.system === system)?.name;
    return `<section class="sg ex7-g"><header class="sg-head">${storeMark(system, 20)}<h3>${esc(storeName(system))}</h3>${name ? code(name) : ''}<span class="spacer"></span><span class="sg-count">${esc(t(items.some(item => item.collection) ? 'jr.count.documents' : items.some(item => typeof item.key === 'string') ? 'jr.count.keys' : 'jr.count.rows', { n: items.length }))}</span></header><ul class="ex7-list">${items.map(row).join('')}</ul></section>`;
  };
  const effects = expected.effects ?? [];
  const effectRows = effects.map(effect => {
    const parts = Object.entries(effect).filter(([key]) => key !== 'kind').map(([key, raw]) => `${esc(key === 'to' ? t('jr.exp.to') : key === 'subject' ? t('jr.exp.subjectMatches') : key)} ${expectedValue(raw, journey)}`);
    return `<li class="ex7"><div class="ex7-head"><span class="op-badge" dir="ltr">${esc(String(effect.kind).toUpperCase())}</span><span class="ex7-key">${parts.join(' · ')}</span></div></li>`;
  }).join('');
  const nothing = !writes.length && !effects.length
    ? `<p class="cov">${icon('shield', true)}<span>${esc(t('jr.exp.nothing'))}</span></p>` : '';
  const file = journey.definedIn?.file?.split('/').pop();
  const ignored = (journey.expectations.ignore ?? []).map(rule => rule.table).filter(Boolean);
  const foot = `<p class="cov j7-foot">${icon('file-code', true)}<span>${file ? `${esc(t('jr.from'))} ${ltr(code(file))}. ` : ''}${esc(t(expected.unlisted === 'ignore' ? 'jr.exp.unlistedIgnore' : 'jr.exp.unlistedFail'))}${ignored.length ? ` ${esc(t('jr.exp.ignored'))} ${ignored.map(name => ltr(code(name))).join(', ')}` : ''}</span></p>`;
  return `${intro}${crit}${[...groups].map(([system, items]) => storeGroup(system, items)).join('')}${effects.length ? `<section class="sg ex7-g"><header class="sg-head"><span class="lg-ico">${icon('mail', true)}</span><h3>${esc(t('res.tab.Side effects'))}</h3><span class="spacer"></span><span class="sg-count">${esc(t('jr.count.effects', { n: effects.length }))}</span></header><ul class="ex7-list">${effectRows}</ul></section>` : ''}${nothing}${foot}`;
}

const FIND = {
  match: ['check', 'ok', 'jr.find.match'], differs: ['ne', 'bad', 'jr.find.differs'], missing: ['minus-circle', 'bad', 'jr.find.missing'],
  extra: ['plus-circle', 'bad', 'jr.find.extra'], approved: ['badge-check', 'ad', 'jr.find.approved'], unchecked: ['circle-dashed', 'muted', 'jr.find.unchecked'],
};
export const findingTag = kind => `<span class="fd7 is-${FIND[kind][1]}">${icon(FIND[kind][0], true)}${esc(t(FIND[kind][2]))}</span>`;
const adChip = id => `<a href="#ad-${esc(id)}" class="adc7" data-ad-jump="${esc(id)}">${icon('badge-check', true)}${ltr(esc(id))}</a>`;

/** The raw expectation behind a finding's field: the runtime expression, when the value came from one. */
function rawExpected(step, finding, name) {
  const index = Number(String(finding.id).split(':')[1]);
  const list = finding.id?.startsWith('effect') ? step.expected?.effects : step.expected?.writes;
  return list?.[index]?.values?.[name] ?? list?.[index]?.[name];
}

function fieldExpected(field, raw, journey) {
  const shown = field.expected !== null && typeof field.expected === 'object' && !Array.isArray(field.expected)
    ? expectedValue(field.expected, journey) : v(field.expected);
  const source = typeof raw === 'string' && raw.startsWith('$') ? `<span class="src7">${refChip(raw, journey)}</span>` : '';
  return `${shown}${source}`;
}

/** One comparison card: an expected write against what was written, field by field. */
export function comparisonCard(finding, { journey, step, run, stepIndex, capabilities = {}, draft = true }) {
  const store = finding.store === 'effect' ? null : finding.store;
  const mark = store ? storeMark(store, 16) : `<span class="lg-ico">${icon('mail', true)}</span>`;
  const key = finding.key && typeof finding.key === 'object' ? Object.entries(finding.key)[0] : null;
  const head = `<header class="cf7-head">${mark}<span class="cf7-t" dir="ltr">${esc(finding.target)}</span>${opBadge(finding.op)}${key ? `<span class="faint tc-key"><span class="k">${esc(key[0])}</span> ${ltr(esc(short(key[1])))}</span>` : ''}<span class="spacer"></span>${findingTag(finding.kind)}</header>`;
  let body = '';
  if (finding.fields?.length) {
    const rows = [...finding.fields].sort((a, b) => ({ differs: 0, approved: 1, match: 2 }[a.state] - { differs: 0, approved: 1, match: 2 }[b.state]));
    body = `<div class="cf7-grid" role="table" aria-label="${esc(finding.target)}">
      <div class="cf7-row is-th" role="row"><span role="columnheader" class="cf7-mk"><span class="sr-only">${esc(t('jr.result'))}</span></span><span role="columnheader">${esc(t('jr.field'))}</span><span role="columnheader">${esc(t('jr.expected'))}</span><span role="columnheader">${esc(t('jr.written'))}</span></div>
      ${rows.map(field => {
        const state = field.state === 'differs' ? 'bad' : field.state === 'approved' ? 'ad' : 'ok';
        const glyph = state === 'bad' ? 'ne' : state === 'ad' ? 'badge-check' : 'check';
        const label = t(state === 'bad' ? 'jr.find.differs' : state === 'ad' ? 'jr.find.approved' : 'jr.find.match');
        const note = field.record ? `<span class="cf7-note">${adChip(field.record)}</span>` : '';
        const draftButton = draft && field.state === 'differs' ? ` data-draft-field="${esc(field.name)}"` : '';
        return `<div class="cf7-row is-${state}" role="row"${draftButton}><span class="cf7-mk" role="cell">${icon(glyph, true)}<span class="sr-only">${esc(label)}</span></span><code class="k" role="cell" dir="ltr">${esc(field.name)}</code><span class="e" role="cell">${fieldExpected(field, rawExpected(step, finding, field.name), journey)}</span><span class="a" role="cell">${field.actual === undefined ? `<span class="faint">${esc(t('jr.notWritten'))}</span>` : v(field.actual)}${note}</span></div>`;
      }).join('')}</div>`;
  } else if (finding.kind === 'missing' || (finding.kind === 'approved' && !finding.fields?.length && finding.id?.startsWith('missing'))) {
    const keyText = key ? th('jr.miss.keyed', { op: esc(t('jr.op.' + (finding.op in OP_BADGE ? finding.op : 'write'))), field: code(key[0]), value: v(short(key[1])) }) : esc(t('jr.miss.plain', { op: t('jr.op.' + (finding.op in OP_BADGE ? finding.op : 'write')) }));
    const raw = key ? step.expected?.writes?.[Number(String(finding.id).split(':')[1])]?.key?.[key[0]] : undefined;
    body = `<div class="cf7-miss"><div><span class="cf7-lbl">${esc(t('jr.expected'))}</span><p>${keyText}</p>${typeof raw === 'string' && raw.startsWith('$') ? `<p>${refChip(raw, journey)}</p>` : ''}</div>
      <div class="is-none"><span class="cf7-lbl">${esc(t('jr.written'))}</span><p><strong>${esc(t('jr.miss.none'))}</strong></p><p>${th(finding.store === 'effect' ? 'jr.miss.noEffect' : 'jr.miss.nothingIn', { target: code(finding.target) })}</p></div></div>`;
    if (finding.record) body += `<p class="cf7-cover">${icon('badge-check', true)}<span>${esc(t('jr.coveredBy'))}</span>${adChip(finding.record)}</p>`;
  } else if (finding.kind === 'extra' || finding.id?.startsWith('extra')) {
    body = `<div class="cf7-skip"><p><strong>${esc(t('jr.extra.title'))}</strong></p><p>${th('jr.extra.body', { target: code(finding.target) })}</p></div>`;
    if (finding.record) body += `<p class="cf7-cover">${icon('badge-check', true)}<span>${esc(t('jr.coveredBy'))}</span>${adChip(finding.record)}</p>`;
  } else if (finding.kind === 'unchecked') {
    body = `<div class="cf7-skip"><p><strong>${esc(t('jr.unchecked.title'))}</strong></p><p>${esc(finding.note || t('jr.unchecked.body', { store: storeName(finding.store) }))}</p></div>`;
  }
  const problem = ['differs', 'missing', 'extra'].includes(finding.kind);
  const canDraft = draft && problem && (journey.source !== 'code' || finding.kind === 'differs');
  const foot = problem ? `<footer class="cf7-foot">${canDraft ? `<button type="button" class="btn btn-sm" data-action="journey-draft" data-finding="${esc(finding.id)}">${icon('badge-check', true)}${esc(t('jr.draft'))}</button>` : ''}${store ? `<button type="button" class="btn btn-ghost btn-sm" data-result-tab="Database">${icon('db', true)}${esc(t('jr.showInDatabase'))}</button>` : `<button type="button" class="btn btn-ghost btn-sm" data-result-tab="Side effects">${icon('mail', true)}${esc(t('jr.showEffects'))}</button>`}</footer>` : '';
  return `<article class="cf7 is-${finding.kind}" data-finding-card="${esc(finding.id)}">${head}${body}${foot}</article>`;
}

/** An approved-difference record, as committed in the expectations document. */
export function approvedCard(record, journey, { unused = false, expired = false, now = Date.now() } = {}) {
  const target = record.target ?? {};
  const table = target.table ?? target.collection ?? '';
  const whatPlain = record.kind === 'value'
    ? `${table}${target.field ? '.' + target.field : ''}${record.expected !== undefined ? ` · ${compact(record.expected)} → ${compact(record.actual)}` : ''}`
    : `${table} · ${t(record.kind === 'extra' ? 'jr.ad.extraRow' : 'jr.ad.missingRow')}`;
  const what = record.kind === 'value'
    ? `${ltr(code(`${table}${target.field ? '.' + target.field : ''}`))}${record.expected !== undefined ? ` · ${v(record.expected)} → ${v(record.actual)}` : ''}`
    : `${ltr(code(table))} · ${esc(t(record.kind === 'extra' ? 'jr.ad.extraRow' : 'jr.ad.missingRow'))}`;
  const days = record.expires ? Math.ceil((new Date(record.expires + 'T23:59:59Z').getTime() - now) / 86_400_000) : null;
  const expiry = record.expires
    ? expired || days < 0 ? `<span class="is-exp" title="${esc(record.expires)}">${icon('warn', true)}${esc(t('jr.ad.expired'))}</span>`
      : `<span class="${days < 10 ? 'is-soon' : ''}" title="${esc(record.expires)}">${esc(t('jr.ad.expiresIn', { n: days }))}</span>` : '';
  const link = record.link ? `<a href="${esc(record.link)}" target="_blank" rel="noopener noreferrer" dir="ltr">${esc(/\/(\d+)$/.test(record.link) ? '#' + /\/(\d+)$/.exec(record.link)[1] : record.link.replace(/^https?:\/\//, ''))}</a>` : '';
  const meta = [record.approvedBy ? `<span title="${esc(record.approvedOn || '')}">${esc(t('jr.ad.by', { name: record.approvedBy }))}</span>` : '', expiry, link].filter(Boolean).join('<span class="sep" aria-hidden="true">·</span>');
  const file = String(journey.expectationsUrl || '').split('/').pop() || 'expectations';
  return `<article class="ad7${unused ? ' is-unused' : ''}${expired ? ' is-expired' : ''}" id="ad-${esc(record.id)}">
    <header class="ad7-head">${adChip(record.id)}<span class="spacer"></span><span class="ad7-step">${esc(t('jr.stepN', { n: formatNumber(Math.max(1, stepNumber(journey, record.step))) }))}</span></header>
    <p class="ad7-what row-sub" title="${esc(whatPlain)}">${what}</p>
    ${record.reason ? `<p class="ad7-reason" lang="en">${esc(record.reason)}</p>` : ''}
    <p class="ad7-meta">${meta}</p>
    ${unused ? `<p class="ad7-unused">${icon('info', true)}<span>${journey.source === 'code' ? esc(t('jr.ad.unusedCode')) : th('jr.ad.unused', { file: ltr(code(file)) })}</span></p>` : ''}
    ${expired ? `<p class="ad7-unused">${icon('warn', true)}<span>${esc(t('jr.ad.expiredBody'))}</span></p>` : ''}
  </article>`;
}

/** Problem phrases for a verdict line: "Shipments.ServiceLevel differs and nothing changed in StockReservations". */
export function problemSentence(step) {
  const phrases = [];
  for (const item of stepProblems(step).filter(problem => problem.kind !== 'approved')) {
    if (item.kind === 'differs') phrases.push(t('jr.p.differs', { field: `${item.finding.target}.${item.field.name}` }));
    else if (item.kind === 'missing') phrases.push(item.finding.store === 'effect' ? t('jr.p.noEffect', { kind: item.finding.target }) : t('jr.p.missing', { target: item.finding.target }));
    else phrases.push(t('jr.p.extra', { target: item.finding.target }));
  }
  for (const criterion of step.criteria ?? []) if (!criterion.passed) phrases.push(t('jr.p.criterion', { condition: criterion.condition, actual: display(criterion.actual) }));
  if (!phrases.length) return '';
  const sentence = formatList(phrases.slice(0, 3));
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + (phrases.length > 3 ? t('jr.p.more', { n: phrases.length - 3 }) : '') + '.';
}

/** A row's detail under its name: one line in the secondary colour, ellipsized, with the whole text in its title. */
const subtitle = (html, plain, attrs = '') => html ? `<span class="row-sub" title="${esc(plain)}"${attrs}>${html}</span>` : '';

/** A matched write's detail: its first two matching fields; an email as "to a@b.c · subject "…"". */
function matchDetail(finding) {
  const fields = (finding.fields ?? []).filter(field => field.state === 'match').slice(0, 2);
  if (finding.store === 'effect') {
    const text = fields.map(field => field.name === 'subject' ? `${field.name} "${compact(field.actual)}"` : `${field.name} ${compact(field.actual)}`).join(' · ');
    return subtitle(ltr(esc(text)), text);
  }
  return subtitle(ltr(fields.map(field => `${esc(field.name)} ${v(field.actual)}`).join(' · ')), fields.map(field => `${field.name} ${compact(field.actual)}`).join(' · '));
}

/** Step N's verdict, the filter, the problems, the approved differences used, then the matches. */
export function comparison(journey, index, run, { filter = 'all', capabilities = {} } = {}) {
  const step = journey.steps[index];
  const result = run.steps[index];
  const n = formatNumber(index + 1);
  const problems = result.findings.filter(finding => ['differs', 'missing', 'extra'].includes(finding.kind));
  const approvedIds = [...new Set(result.findings.flatMap(finding => [finding.record, ...(finding.fields ?? []).map(field => field.record)]).filter(Boolean))];
  const matches = result.findings.filter(finding => finding.kind === 'match');
  const unchecked = result.findings.filter(finding => finding.kind === 'unchecked');
  const approvedCount = result.findings.reduce((total, finding) => total + (finding.kind === 'approved' && !(finding.fields ?? []).length ? 1 : 0) + (finding.fields ?? []).filter(field => field.state === 'approved').length, 0);
  const failedCriteria = (result.criteria ?? []).filter(criterion => !criterion.passed);
  const failed = result.status !== 'passed';
  const tone = failed ? 'is-fail' : approvedCount ? 'is-ad' : 'is-pass';
  const title = failed ? t('jr.stepFailed', { n }) : approvedCount ? t('jr.stepPassedApproved', { n, count: formatNumber(approvedCount) }) : t('jr.stepPassed', { n });
  const lede = failed ? problemSentence(result) : t(approvedCount ? 'jr.v.approvedBody' : 'jr.v.passedBody');
  const verdict = `<div class="vd7 ${tone}" role="status"><span class="vd7-ico">${icon(failed ? 'circle-x' : approvedCount ? 'badge-check' : 'circle-check')}</span><div class="vd7-text"><h3>${esc(title)}</h3>${lede ? `<p>${esc(lede)}</p>` : ''}</div></div>`;
  const problemCount = findingCounts(result).problems;
  const total = problemCount + approvedCount + matches.length + unchecked.length;
  const expectedTotal = (step.expected?.writes?.length ?? 0) + (step.expected?.effects?.length ?? 0);
  const written = run.envelopes?.[index]?.changes ?? null;
  const pick = (id, dot, label, count) => `<button type="button" role="radio" aria-checked="${filter === id}" tabindex="${filter === id ? 0 : -1}" data-cmp-filter="${id}"${count || id === 'all' ? '' : ' disabled'}>${dot ? `<span class="tl7-dot is-${dot}" aria-hidden="true"></span>` : ''}${esc(label)}<span class="tl7-n">${esc(formatNumber(count))}</span></button>`;
  const tally = `<div class="tl7"><div class="segmented sm" role="radiogroup" aria-label="${esc(t('jr.show'))}">${pick('all', '', t('jr.f.all'), total)}${pick('problems', 'bad', t('jr.f.problems'), problemCount)}${pick('approved', 'ad', t('jr.f.approved'), approvedCount)}${pick('match', 'ok', t('jr.f.match'), matches.length)}</div>
    <span class="spacer"></span><span class="tl7-src">${esc(t('jr.expectedWritten', { expected: formatNumber(expectedTotal), written: formatNumber(written?.length ?? 0) }))}</span></div>`;
  const ctx = { journey, step, run, stepIndex: index, capabilities };
  const show = id => filter === 'all' || filter === id;
  const criteriaCard = failedCriteria.length ? `<article class="cf7 is-differs"><header class="cf7-head"><span class="lg-ico">${icon('check', true)}</span><span class="cf7-t">${esc(t('jr.succeedsWhen'))}</span><span class="spacer"></span>${findingTag('differs')}</header>
    <div class="cf7-grid" role="table"><div class="cf7-row is-th" role="row"><span class="cf7-mk" role="columnheader"></span><span role="columnheader">${esc(t('jr.condition'))}</span><span role="columnheader">${esc(t('jr.expected'))}</span><span role="columnheader">${esc(t('jr.actual'))}</span></div>
    ${failedCriteria.map(criterion => `<div class="cf7-row is-bad" role="row"><span class="cf7-mk" role="cell">${icon('ne', true)}</span><code class="k" role="cell" dir="ltr">${esc(criterion.condition.split(/\s*(==|!=|<=|>=|<|>)\s*/)[0])}</code><span class="e" role="cell">${ltr(code(criterion.condition))}</span><span class="a" role="cell">${v(criterion.actual)}</span></div>`).join('')}</div></article>` : '';
  const problemCards = problems.map(finding => comparisonCard(finding, ctx)).join('');
  const approvedRecords = approvedIds.map(id => journey.approved.find(record => record.id === id)).filter(Boolean);
  const approvedFindings = result.findings.filter(finding => finding.kind === 'approved');
  const matchedList = matches.length || (result.criteria ?? []).some(criterion => criterion.passed) ? `<ul class="mt7">${matches.map(finding => {
    const mark = finding.store === 'effect' ? `<span class="lg-ico">${icon('mail', true)}</span>` : storeMark(finding.store, 14);
    return `<li><span class="mt7-ok">${icon('check', true)}<span class="sr-only">${esc(t('jr.find.match'))}</span></span>${mark}<span class="mt7-main"><span class="mt7-l1"><span class="mt7-t" dir="ltr">${esc(finding.target)}</span>${opBadge(finding.op === 'send' ? finding.target : finding.op)}</span>${matchDetail(finding)}</span></li>`;
  }).join('')}${(result.criteria ?? []).filter(criterion => criterion.passed).map(criterion => `<li class="is-crit"><span class="mt7-ok">${icon('check', true)}</span><span class="mt7-main"><span class="mt7-l1"><span class="crit7-l">${esc(t('jr.succeedsWhen'))}</span><code dir="ltr">${esc(criterion.condition)}</code></span>${subtitle(`${esc(t('jr.got'))} ${v(criterion.actual)}`, `${t('jr.got')} ${compact(criterion.actual)}`)}</span></li>`).join('')}</ul>` : '';
  return `${verdict}${total ? tally : ''}
    ${show('problems') && (problemCards || criteriaCard) ? `${sectionLabel(t('jr.f.problems'))}${criteriaCard}${problemCards}` : ''}
    ${show('approved') && (approvedRecords.length || approvedFindings.length) ? `${sectionLabel(t('jr.approvedDifferences'))}${approvedFindings.map(finding => comparisonCard(finding, { ...ctx, draft: false })).join('')}${approvedRecords.map(record => approvedCard(record, journey)).join('')}` : ''}
    ${show('all') && unchecked.length ? `${sectionLabel(t('jr.find.unchecked'))}${unchecked.map(finding => comparisonCard(finding, ctx)).join('')}` : ''}
    ${show('match') && matchedList ? `${sectionLabel(t('jr.matched'))}${matchedList}` : ''}`;
}

/** A run stopped at this step: why, that it wrote nothing, what didn't run, and what earlier Sends left. */
export function stoppedView(journey, index, run, { capabilities = {}, leftBehind = [], undo = null } = {}) {
  const step = journey.steps[index];
  const result = run.steps[index];
  const n = formatNumber(index + 1);
  const status = result.httpStatus;
  const body = run.responses?.[index];
  const codeName = body && typeof body === 'object' ? body.code : undefined;
  const detail = body && typeof body === 'object' ? body.detail || body.title : undefined;
  const failedCriteria = (result.criteria ?? []).filter(criterion => !criterion.passed);
  const title = result.status === 'blocked' ? t('jr.stop.blockedTitle', { n })
    : body?.title ? t('jr.stop.refusedTitle', { n, reason: String(body.title).replace(/\.$/, '') }) : t('jr.stop.titlePlain', { n });
  const expects = failedCriteria.map(criterion => ltr(code(criterion.condition))).join(', ');
  const later = journey.steps.slice(index + 1).map((_, i) => formatNumber(index + 2 + i));
  const changes = run.envelopes?.[index]?.changes?.length ?? 0;
  const effects = run.envelopes?.[index]?.effects?.length ?? 0;
  const facts = [
    run.mode === 'send'
      ? `<li class="${changes ? '' : 'is-ok'}">${icon(changes ? 'warn' : 'shield-check', true)}<span><strong>${esc(t(changes ? 'jr.stop.wrote' : 'jr.stop.wroteNothing'))}</strong> ${esc(t('jr.stop.traced', { changes: formatNumber(changes), effects: formatNumber(effects) }))}</span></li>`
      : `<li class="is-ok">${icon('shield-check', true)}<span><strong>${esc(t('jr.stop.previewSafe'))}</strong> ${esc(t('jr.stop.previewSafeBody'))}</span></li>`,
    later.length ? `<li>${icon('skip', true, 'i-dir')}<span><strong>${esc(t('jr.stop.didntRun', { steps: formatList(later), n: later.length }))}</strong> ${esc(t('jr.stop.default'))}</span></li>` : '',
  ].join('');
  const leftSteps = [...new Set(leftBehind.map(item => item.step))].sort((a, b) => a - b);
  const left = run.mode === 'send' && leftBehind.length ? `${sectionLabel(t('jr.stop.left', { steps: formatList(leftSteps.map(n => formatNumber(n))), n: leftSteps.length }), slEnd(`${icon('warn', true)}${esc(t('jr.stop.sentForReal'))}`, 'is-warn'))}
    <ul class="mt7 j7-left">${leftBehind.map(item => {
      const effect = item.store === 'effect';
      const detail = item.detail ? (effect ? esc(item.detail) : v(item.detail)) : '';
      return `<li>${effect ? `<span class="lg-ico">${icon('mail', true)}</span>` : storeMark(item.store, 16)}<span class="mt7-main"><span class="mt7-l1">${effect ? '' : `<span class="mt7-t" dir="ltr">${esc(item.target)}</span>`}${opBadge(item.op)}</span>${subtitle(detail, display(item.detail), effect ? ' lang="en"' : '')}</span><span class="mt7-s">${esc(t('jr.stepN', { n: formatNumber(item.step) }))}</span></li>`;
    }).join('')}</ul>
    ${undo ?`<div class="stop7-next"><button type="button" class="btn btn-sm" data-action="journey-undo" data-undo-op="${esc(undo.index)}">${method(undo.op.method)}<span lang="en">${esc(undo.op.title)}</span>${undo.value ? `<span class="faint">${ltr(esc(short(undo.value)))}</span>` : ''}</button><p>${esc(t('jr.stop.undoBody'))}</p></div>` : ''}` : '';
  const raw = body !== undefined && body !== null ? `<div class="blk-raw"><div class="blk-raw-bar"><span>${esc(t('jr.responseBody'))}</span><code dir="ltr">${esc(run.contentTypes?.[index] || 'application/json')}</code><span class="spacer"></span>${copyButton(t('copy.response'), { action: 'copy-response', size: 'btn-xs' })}</div><pre class="sql" dir="ltr">${typeof body === 'string' ? esc(body) : highlightJson(JSON.stringify(body, null, 2))}</pre></div>` : '';
  return `<section class="stop7" aria-labelledby="stop7-h">
      <div class="stop7-top"><span class="vd7-ico is-danger">${icon('ban')}</span><div><p class="blk-eyebrow">${esc(t('jr.stop.eyebrow'))}</p><h3 id="stop7-h">${esc(title)}</h3>
        <p>${expects ? `${esc(t('jr.stop.expects'))} ${expects}. ` : ''}${status != null ? esc(t('jr.stop.answered', { status })) : ''}${codeName ? ` ${ltr(code(codeName))}` : ''}${detail ? `: <q lang="en">${esc(detail)}</q>` : status != null ? '.' : ''}</p></div></div>
      <ul class="stop7-facts">${facts}</ul>
    </section>${left}${raw}`;
}

/** The result pane's tabs in a journey step: Expected leads with its count; the others give up theirs. */
export function resultTabs(selected, { count, flag, tabs }) {
  return tabs.map((name, index) => tab(name === 'Expected' ? t('jr.expected') : t('res.tab.' + name), {
    selected: name === selected, count: name === 'Expected' ? count : undefined, flag: name === 'Expected' ? flag : undefined,
    id: `result-tab-${name.replaceAll(' ', '-')}`, controls: 'result', shortcut: index < 5 ? 'result-tab-' + index : undefined, data: `data-result-tab="${name}"`,
  })).join('');
}

/* ---------- Overview ---------- */

function writesText(step) {
  if (!step.expected) return step.op?.method === 'GET' ? `<span class="js7-reads">${esc(t('jr.readsOnly'))}</span>` : '';
  const counts = writeSummary(step.expected);
  const parts = [];
  if (counts.rows) parts.push(t('jr.count.rows', { n: counts.rows }));
  if (counts.documents) parts.push(t('jr.count.documents', { n: counts.documents }));
  if (counts.keys) parts.push(t('jr.count.keys', { n: counts.keys }));
  if (counts.emails) parts.push(t('jr.count.emails', { n: counts.emails }));
  if (counts.effects) parts.push(t('jr.count.effects', { n: counts.effects }));
  if (!parts.length) return `<span class="js7-reads">${esc(t(step.op?.method === 'GET' ? 'jr.readsOnly' : 'jr.writesNothing'))}</span>`;
  return `<span class="js7-writes">${esc(parts.join(' · '))}</span>`;
}

/** The steps as a timeline: what each should do, its endpoint, where its values come from. */
export function stepsTimeline(journey) {
  return `<ol class="js7">${journey.steps.map((step, index) => {
    const bindings = stepBindings(step.def);
    const fromSteps = bindings.filter(binding => binding.from === 'step');
    const inputs = bindings.filter(binding => binding.from === 'input');
    const status = expectedStatus(step);
    const extraCriteria = criteriaOf(step).filter(condition => !/^\s*\$statusCode\s*==/.test(condition));
    const name = binding => binding.target.replace(/^(path|query|header|cookie)\./, '').replace(/^body\//, '').split('/').pop();
    const chips = [
      ...fromSteps.map(binding => `<span class="js7-b" title="${esc(binding.expression)}">${icon('bind', true, 'i-dir')}<code dir="ltr">${esc(name(binding))}</code><span class="js7-from">${esc(t('jr.fromStep', { n: formatNumber(stepNumber(journey, binding.stepId)) }))}</span></span>`),
      inputs.length ? `<span class="js7-b is-in" title="${esc(inputs.map(name).join(', '))}">${inputs.length === 1 ? `<code dir="ltr">${esc(name(inputs[0]))}</code><span class="js7-from">${esc(t('jr.fromInputs'))}</span>` : esc(t('jr.valuesFromInputs', { n: inputs.length }))}</span>` : '',
      ...extraCriteria.map(condition => `<span class="js7-b is-crit" title="${esc(condition)}">${icon('check', true)}${esc(criterionText(condition))}</span>`),
    ].join('');
    const target = step.op
      ? `<a href="#journey/${encodeURIComponent(journey.id)}/step/${encodeURIComponent(step.stepId)}" class="js7-op" lang="en" data-journey-step="${esc(step.stepId)}">${esc(stepTitle(step))}</a>`
      : `<span class="js7-op" lang="en">${esc(step.stepId)}</span>`;
    return `<li class="js7-step">
      <span class="js7-node" aria-hidden="true">${esc(formatNumber(index + 1))}</span>
      <div class="js7-main">
        <div class="js7-l1">${target}<span class="js7-sum">${status ? `<code dir="ltr">${status}</code>` : ''}${writesText(step)}</span></div>
        <div class="js7-l2">${step.op ? `${method(step.op.method)}<code class="js7-path" dir="ltr">${esc(step.op.path)}</code>` : `<span class="faint">${esc(t('jr.notRunBySendproof'))}</span>`}</div>
        <div class="js7-l3">${chips}</div>
      </div></li>`;
  }).join('')}</ol>`;
}

/** "expects status Shipped" for `$response.body#/status == 'Shipped'`; the condition otherwise. */
export function criterionText(condition) {
  const match = /^\s*\$response\.body#\/([\w/]+)\s*==\s*['"]?([^'"]+)['"]?\s*$/.exec(condition);
  return match ? t('jr.expects', { field: match[1].split('/').pop(), value: match[2] }) : condition;
}

/** Journey header: title, description, who it runs as, the stores it touches and where it's defined. */
export function overviewHead(journey, { capabilities = {} } = {}) {
  const stores = [...new Set(journey.steps.flatMap(step => (step.expected?.writes ?? []).map(write => write.store || sqlSystem(capabilities))))];
  const pills = [
    journey.runAs ? `<span class="pill" title="${esc(t('jr.runsAs', { name: journey.runAs }))}">${icon('user', true)}<span class="ltr">${esc(journey.runAs)}</span></span>` : '',
    stores.length ? `<span class="pill j7-stores">${stores.map(store => `${storeMark(store, 14)}${esc(storeName(store))}`).join('')}</span>` : '',
    journey.sendOnly ? `<span class="pill" title="${esc(journey.sendOnlyReason)}">${icon('flask-off', true)}${esc(t('jr.sendOnly'))}</span>` : '',
    journey.definedIn?.type ? `<span class="pill j7-src-pill" title="${esc(t('jr.definedIn', { file: journey.definedIn.file || journey.definedIn.type }))}">${icon('braces', true)}${ltr(esc(journey.definedIn.type))}</span>`
      : journey.inferred ? `<span class="pill" title="${esc(t('jr.inferredTip'))}">${icon('link', true)}${esc(t('jr.inferredPill'))}</span>` : '',
  ].filter(Boolean).join('');
  return `<div class="op-head j7-head">
    <div class="op-title-row"><h1 class="op-title" id="jr-title" tabindex="-1" lang="en">${esc(journey.name)}</h1></div>
    ${journey.description ? `<p class="op-desc" lang="en">${esc(journey.description)}</p>` : ''}
    ${pills ? `<div class="op-meta">${pills}</div>` : ''}
  </div>`;
}

/** "Used in step 1", "Used in steps 1 and 4": each input's status line. */
export function usedIn(steps) {
  if (!steps?.length) return t('jr.usedNowhere');
  return steps.length === 1 ? t('jr.usedIn', { n: formatNumber(steps[0]) }) : t('jr.usedInMany', { steps: formatList(steps.map(n => formatNumber(n))) });
}

/** The overview's Ends with: the last step's criteria and the outputs. */
export function endsWith(journey) {
  const last = journey.steps.at(-1);
  const criteria = last ? criteriaOf(last).filter(condition => !/^\s*\$statusCode/.test(condition)) : [];
  const status = last ? expectedStatus(last) : null;
  const text = criteria.length
    ? th('jr.ends.criteria', { n: formatNumber(journey.steps.length), condition: criteria.map(condition => code(condition)).join(', ') })
    : status ? th('jr.ends.status', { n: formatNumber(journey.steps.length), status: code(String(status)) }) : '';
  return `<div class="j7-ends">${text ? `<p>${text}</p>` : ''}${journey.outputs.length ? `<dl class="j7-outs"><div><dt>${esc(t('jr.outputs'))}</dt><dd>${journey.outputs.map(name => code(name)).join('')}</dd></div></dl>` : ''}</div>`;
}

/** The overview's action bar: Preview run (or Send only) and Send run. */
export function overviewBar(journey, { previewSessions = true, busy = false, opening = false } = {}) {
  const previewBlocked = journey.sendOnly || !previewSessions;
  const reason = journey.sendOnly ? t('jr.bar.sendOnly') : !previewSessions ? t('jr.bar.noSessions') : t('jr.bar.rollsBack');
  const disabled = busy || opening ? ' disabled' : '';
  const status = opening ? openingStatus() : statusLine(icon(previewBlocked ? 'flask-off' : 'undo', true, previewBlocked ? '' : 'i-dir'), reason, '', journey.sendOnly ? journey.sendOnlyReason : previewBlocked ? reason : t('jr.bar.rollsBackTip'));
  return `${status}
    <button type="button" class="btn btn-run btn-send${previewBlocked ? ' btn-primary' : ''}" data-action="journey-send-run" ${shortcutAttrs(previewBlocked ? 'preview' : 'send')}${disabled}>${icon('send', true)}<span>${esc(t('jr.sendRun'))}</span>${shortcutHint(previewBlocked ? 'preview' : 'send')}</button>
    ${previewBlocked ? '' : `<button type="button" class="btn btn-primary btn-run btn-preview" data-action="journey-preview-run" ${shortcutAttrs('preview')}${disabled}${opening ? ' aria-busy="true"' : ''}>${openingGlyph(opening, 'play', 'i-dir')}<span>${esc(t('jr.previewRun'))}</span>${shortcutHint('preview')}</button>`}`;
}

/** The overview's right column: the last run, its problems, earlier runs. */
export function overviewAside(journey, runs, { now = Date.now() } = {}) {
  const [last, ...earlier] = runs;
  if (!last) {
    return `<div class="resp-head j7-rh"><strong class="j7-rh-t">${esc(t('jr.lastRun'))}</strong><span class="metric">${esc(t('jr.last.none'))}</span><span class="spacer"></span></div>
      <div class="pane-scroll"><div class="result-body">${stateBlock({ glyph: 'history', compact: true, title: esc(t('jr.runs.emptyTitle')), body: esc(t(journey.sendOnly ? 'jr.runs.emptySendOnly' : 'jr.runs.emptyBody')) })}</div></div>
      <div class="pane-bar result-bar">${runsBar(0)}</div>`;
  }
  const failedAt = last.steps.findIndex(step => step.status !== 'passed' && step.status !== 'skipped' && step.status !== 'pending');
  const verdict = runVerdict(last);
  const rows = journey.steps.map((step, index) => {
    const result = last.steps[index];
    const counts = findingCounts(result);
    const status = result?.status ?? 'pending';
    const bad = ['failed', 'refused', 'blocked'].includes(status);
    const chips = bad
      ? `<span class="fd7 is-bad">${icon('circle-x', true)}${esc(counts.problems ? t('jr.problems', { n: counts.problems }) : t('jr.rail.' + (status === 'blocked' ? 'blocked' : status === 'refused' ? 'refused' : 'failedShort')))}</span>`
      : status === 'passed' ? `${counts.approved ? `<span class="fd7 is-ad" title="${esc(t('jr.approvedN', { n: counts.approved }))}">${icon('badge-check', true)}${esc(formatNumber(counts.approved))}</span>` : ''}<span class="fd7 is-ok">${icon('check', true)}${esc(t('jr.passed'))}</span>`
      : `<span class="fd7 is-muted">${icon('minus', true)}${esc(t(status === 'skipped' ? 'jr.notRun' : 'jr.notRun'))}</span>`;
    return `<li class="lr7-row is-${bad ? 'fail' : status}"><span class="lr7-n">${esc(formatNumber(index + 1))}</span><span class="lr7-op" lang="en">${esc(stepTitle(step))}</span><span class="lr7-res">${chips}</span><span class="lr7-t">${result?.durationMs != null ? iso(esc(formatDuration(result.durationMs))) : ''}</span></li>`;
  }).join('');
  const failedStep = failedAt >= 0 ? last.steps[failedAt] : null;
  const problems = failedStep ? stepProblems(failedStep).filter(item => item.kind !== 'approved') : [];
  const problemsBox = failedStep && (problems.length || failedStep.criteria?.some(criterion => !criterion.passed)) ? `<div class="j7-probs"><h3>${esc(t('jr.problemsIn', { n: formatNumber(failedAt + 1) }))}</h3><ul>
    ${problems.slice(0, 4).map(item => {
      const name = item.field ? `${item.finding.target}.${item.field.name}` : item.finding.target;
      const opName = t('jr.op.' + (item.finding.op in OP_BADGE ? item.finding.op : 'write'));
      const detail = item.field ? th('jr.expectedWrittenPair', { expected: ev(item.field.expected), written: v(item.field.actual) }) : esc(t(item.kind === 'missing' ? 'jr.p.expectedNothing' : 'jr.p.unexpected', { op: opName }));
      const plain = item.field ? `${expectedPlain(item.field.expected)} → ${compact(item.field.actual)}` : t(item.kind === 'missing' ? 'jr.p.expectedNothing' : 'jr.p.unexpected', { op: opName });
      return `<li>${findingTag(item.kind)}<span class="sm8-main"><code dir="ltr" title="${esc(name)}">${esc(name)}</code><span class="row-sub" title="${esc(plain)}">${detail}</span></span></li>`;
    }).join('')}
    ${(failedStep.criteria ?? []).filter(criterion => !criterion.passed).map(criterion => `<li>${findingTag('differs')}<span class="sm8-main"><code dir="ltr" title="${esc(criterion.condition)}">${esc(criterion.condition)}</code><span class="row-sub" title="${esc(`${t('jr.got')} ${compact(criterion.actual)}`)}">${esc(t('jr.got'))} ${v(criterion.actual)}</span></span></li>`).join('')}
  </ul></div>` : '';
  const history = earlier.length ? `${sectionLabel(t('jr.earlierRuns'))}<ul class="hr7">${earlier.map(run => {
    const mark = verdictMark(run);
    const verdictText = runVerdict(run).short;
    return `<li><a href="#journey/${encodeURIComponent(journey.id)}/run/${encodeURIComponent(run.runId)}" class="hr7-link"><span class="hr7-ico is-${mark.tone}">${icon(mark.glyph, true)}</span><span class="hr7-l"><span class="hr7-a">${esc(verdictText)}</span><span class="hr7-b" title="${esc(`${t(run.mode === 'send' ? 'jr.send' : 'jr.preview')} · ${run.agent ? `${run.agent} ${t('jr.viaMcp')}` : run.by || t('jr.someone')} · ${when(run.startedAt, now)}`)}">${modeLabel(run)} · ${run.agent ? `${icon('bot', true)}<span lang="en">${esc(run.agent)}</span> ${esc(t('jr.viaMcp'))}` : `<span lang="en">${esc(run.by || t('jr.someone'))}</span>`} · ${esc(when(run.startedAt, now))}</span></span><span class="hr7-t">${iso(esc(formatDuration(runTime(run))))}</span></a></li>`;
  }).join('')}</ul>` : '';
  return `<div class="resp-head j7-rh"><strong class="j7-rh-t">${esc(t('jr.lastRun'))}</strong><span class="status-code ${verdictMark(last).tone}">${icon(verdictMark(last).glyph, true)}${esc(verdict.short)}</span><span class="metric">${iso(esc(formatDuration(runTime(last))))}</span><span class="spacer"></span><a class="btn btn-sm" href="#journey/${encodeURIComponent(journey.id)}/run/${encodeURIComponent(last.runId)}" data-journey-run="${esc(last.runId)}">${esc(t('jr.openRun'))}${icon('arrow-right', true)}</a></div>
    <div class="pane-scroll"><div class="result-body j7-last">
      <p class="j7-meta">${icon(last.mode === 'send' ? 'send' : 'flask', true)}<span>${esc(t(last.mode === 'send' ? 'jr.meta.send' : 'jr.meta.preview', { name: last.by || t('jr.someone'), when: `${when(last.startedAt, now)}` }))}</span></p>
      <ol class="lr7-list">${rows}</ol>
      ${problemsBox}
      ${history}
    </div></div>
    <div class="pane-bar result-bar">${runsBar(runs.length)}</div>`;
}

/** A result bar's note: an icon and a sentence that never wraps; the icon alone, with the sentence as its title, where there is no room (see .bar-text.is-fit). */
const barText = (iconHtml, text) => `<span class="bar-text is-fit" title="${esc(text)}">${iconHtml}<span>${esc(text)}</span></span>`;
const historyButton = () => `<button type="button" class="btn btn-ghost btn-sm" data-action="history" ${shortcutAttrs('history')}>${icon('history', true)}${esc(t('shell.history'))}${shortcutHint('history')}</button>`;
const runsBar = n => barText(icon('clock', true), n ? t('jr.runsKept', { n: formatNumber(n), max: formatNumber(20) }) : t('jr.noRuns')) + historyButton();
const modeLabel = run => run.mode === 'send' ? `${icon('send', true)}${esc(t('jr.send'))}` : `${icon('flask', true)}${esc(t('jr.preview'))}`;

/** A run's verdict: "Failed at step 4", "Passed · 1 approved", "Stopped at step 3". */
export function runVerdict(run) {
  const index = run.steps.findIndex(step => ['failed', 'refused', 'blocked'].includes(step.status));
  const approved = run.steps.reduce((total, step) => total + findingCounts(step).approved, 0);
  if (run.status === 'running') return { short: t('jr.v.running'), long: t('jr.v.running') };
  if (runEnded(run) && lastRanStep(run) >= 0) {
    const text = t(run.mode === 'send' ? 'jr.v.stoppedAfter' : 'jr.v.endedAfter', { n: formatNumber(lastRanStep(run) + 1) });
    return { short: text, long: text, ended: true };
  }
  if (index < 0 && run.status === 'stopped') return { short: t('jr.v.cancelled'), long: t('jr.v.cancelled'), ended: runEnded(run) };
  if (index < 0) return approved ? { short: t('jr.v.passedApproved', { n: approved }), long: t('jr.v.passedApproved', { n: approved }) } : { short: t('jr.passed'), long: t('jr.v.passedAll', { n: formatNumber(run.steps.length) }) };
  const n = formatNumber(index + 1);
  const stopped = run.status === 'stopped';
  return { short: t(stopped ? 'jr.v.stoppedAt' : 'jr.v.failedAt', { n }), long: t(stopped ? 'jr.v.stoppedAtOf' : 'jr.v.failedAtOf', { n, total: formatNumber(run.steps.length) }), index };
}

/** The icon and tone a run's verdict wears: a check, a quiet stop for a run that was ended early, else a red cross. */
const verdictMark = run => run.status === 'passed' ? { glyph: 'circle-check', tone: 'ok' } : runEnded(run) ? { glyph: 'stop', tone: 'muted' } : { glyph: 'circle-x', tone: 'danger' };

/* ---------- Summary ---------- */

export function summaryMain(journey, run, { capabilities = {}, open = -1 } = {}) {
  const verdict = runVerdict(run);
  const failed = verdict.index ?? -1;
  const total = runTime(run);
  const passedCount = run.steps.filter(step => step.status === 'passed').length;
  const failedCount = run.steps.filter(step => ['failed', 'refused', 'blocked'].includes(step.status)).length;
  const skipped = run.steps.filter(step => step.status === 'skipped').length;
  const ended = verdict.ended === true;
  const tone = ended ? 'stop' : failed >= 0 || run.status === 'stopped' ? 'circle-x' : 'circle-check';
  const lede = failed >= 0 ? `${stepTitle(journey.steps[failed])}: ${problemSentence(run.steps[failed]) || t('jr.v.refusedLede', { status: run.steps[failed].httpStatus ?? '' })}`
    : ended ? t(run.mode === 'send' ? 'jr.v.endedLedeSend' : 'jr.v.endedLedePreview')
    : t(run.mode === 'send' ? 'jr.v.sendLede' : 'jr.v.previewLede');
  // A waterfall of the steps' own time, packed end to end, so the run's minutes of thought between
  // steps don't flatten the bars.
  let offset = 0;
  const starts = run.steps.map(step => { const start = offset; offset += step.durationMs ?? 0; return start; });
  const rows = journey.steps.map((step, index) => {
    const result = run.steps[index];
    const counts = findingCounts(result);
    const bad = ['failed', 'refused', 'blocked'].includes(result.status);
    const ran = result.httpStatus != null;
    const chips = !ran ? `<span class="fd7 is-muted">${icon('minus', true)}${esc(t('jr.notRun'))}</span>`
      : !(step.expected?.writes?.length) && !(step.expected?.effects?.length) && step.op?.method === 'GET' ? `<span class="fd7 is-muted" title="${esc(t('jr.readsOnlyTip'))}">${icon('eye', true)}${esc(t('jr.reads'))}</span>`
      : [counts.problems || (bad && !counts.problems) ? `<span class="fd7 is-bad" title="${esc(t('jr.problems', { n: counts.problems || 1 }))}">${icon('circle-x', true)}${esc(formatNumber(counts.problems || 1))}</span>` : '',
        counts.approved ? `<span class="fd7 is-ad" title="${esc(t('jr.approvedN', { n: counts.approved }))}">${icon('badge-check', true)}${esc(formatNumber(counts.approved))}</span>` : '',
        counts.match ? `<span class="fd7 is-ok" title="${esc(t('jr.matchedN', { n: counts.match }))}">${icon('check', true)}${esc(formatNumber(counts.match))}</span>` : '',
        counts.unchecked ? `<span class="fd7 is-muted" title="${esc(t('jr.uncheckedN', { n: counts.unchecked }))}">${icon('circle-dashed', true)}${esc(formatNumber(counts.unchecked))}</span>` : ''].join('') || `<span class="fd7 is-ok">${icon('check', true)}${esc(t('jr.passed'))}</span>`;
    const isOpen = index === open || (open < 0 && index === failed);
    const detail = isOpen && ran ? summaryDetail(journey, index, run) : '';
    const width = total ? (result.durationMs ?? 0) / total * 100 : 0;
    const start = total ? starts[index] / total * 100 : 0;
    return `<li class="${bad ? 'is-fail' : ''}${!ran ? ' is-skipped' : ''}"><a href="#journey/${encodeURIComponent(journey.id)}/run/${encodeURIComponent(run.runId)}" class="sm8-row is-${bad ? 'fail' : ran ? 'done' : 'skipped'}" data-summary-step="${index}" aria-expanded="${isOpen}"${detail ? ` aria-controls="sm8-d${index}"` : ''}>
      <span class="sm8-node" aria-hidden="true">${esc(formatNumber(index + 1))}</span>
      <span class="sm8-op">${step.op ? method(step.op.method) : ''}<span class="sm8-name" lang="en">${esc(stepTitle(step))}</span><span class="sr-only">, ${esc(t('jr.stepN', { n: formatNumber(index + 1) }))}, ${esc(t(bad ? 'jr.sr.failed' : ran ? 'jr.sr.passed' : 'jr.sr.skipped'))}</span></span>
      <span class="sm8-chips">${chips}</span>
      <span class="sm8-wf" aria-hidden="true">${ran ? `<span style="inset-inline-start:${start.toFixed(2)}%;inline-size:${width.toFixed(2)}%"></span>` : ''}</span>
      <span class="sm8-t">${ran ? iso(esc(formatDuration(result.durationMs ?? 0))) : ''}</span>
      ${icon(isOpen ? 'chevron-down' : 'chevron-right', true, 'sm8-chev')}
    </a>${detail}</li>`;
  }).join('');
  const writesStopped = failed >= 0 && failed < run.steps.length - 1 && skipped === 0;
  const stores = Object.entries(run.tally?.stores ?? {});
  const sqlName = typeof capabilities.database === 'string' ? capabilities.database : capabilities.database?.name;
  const storeRows = stores.map(([system, n]) => {
    const isSql = system === 'sql';
    const mark = isSql ? sqlSystem(capabilities) : system;
    const name = isSql ? sqlName : capabilities.dataStores?.find(store => store.system === system)?.name;
    const state = run.mode === 'send' ? ['check', t('jr.sum.committed')] : isSql ? ['undo', t('jr.sum.rolledBack')] : ['undo', t('jr.sum.aborted')];
    const what = t(run.mode === 'send' ? 'jr.sum.changesKept' : 'jr.sum.changesUndone', { n });
    return `<li>${storeMark(mark, 16)}<span class="sm8-main"><span class="sm8-ln">${esc(storeName(mark))}${name ? ` ${ltr(code(name))}` : ''}</span><span class="sm8-lw row-sub" title="${esc(what)}">${esc(what)}</span></span><span class="sm8-tag">${icon(state[0], true, state[0] === 'undo' ? 'i-dir' : '')}${esc(state[1])}</span></li>`;
  });
  if (run.tally?.effects) storeRows.push(`<li><span class="lg-ico">${icon('mail', true)}</span><span class="sm8-main"><span class="sm8-ln">${esc(t('res.tab.Side effects'))}</span><span class="sm8-lw row-sub">${esc(t(run.mode === 'send' ? 'jr.sum.effectsSent' : 'jr.sum.effectsHeld', { n: run.tally.effects }))}</span></span><span class="sm8-tag">${icon(run.mode === 'send' ? 'send' : 'x', true)}${esc(t(run.mode === 'send' ? 'jr.sum.recorded' : 'jr.sum.discarded'))}</span></li>`);
  const outputs = Object.entries(Object.assign({}, ...run.steps.map(step => step.outputs ?? {}))).filter(([, value]) => value !== undefined);
  // A Send run that was stopped keeps what it left in the database, with the same undo as the stop dialog.
  const leftSection = run.mode === 'send' && run.left?.length ? (() => {
    const shown = run.left.slice(0, 6);
    const rest = run.left.slice(6);
    const rows = shown.map(item => {
      const part = leftParts(item);
      return `<li>${part.effect ? `<span class="lg-ico">${icon('mail', true)}</span>` : storeMark(item.store, 16)}<span class="sm8-main"><span class="sm8-ln" dir="auto">${esc(part.name)}${part.code ? ` ${ltr(code(part.code))}` : ''}</span><span class="sm8-lw row-sub" dir="auto">${part.sub}</span></span></li>`;
    });
    if (rest.length) rows.push(`<li><span class="lg-ico">${icon('more', true)}</span><span class="sm8-main"><span class="sm8-lw row-sub" title="${esc(moreText(rest))}">${esc(moreText(rest))}</span></span></li>`);
    const undo = run.undo;
    const sub = undo ? undoSub(undo) : '';
    const button = undo ? `<button type="button" class="btn sm8-undo" data-action="journey-undo-run" data-undo-op="${esc(undo.id)}" data-undo-param="${esc(undo.param ?? '')}" data-undo-value="${esc(undo.value ?? '')}">${method(undo.method)}<span class="sm8-undo-t"><strong lang="en">${esc(undo.title)}</strong>${sub ? `<span class="row-sub">${esc(sub)}</span>` : ''}</span>${icon('arrow-right', true, 'i-dir')}</button>` : '';
    return `${sectionLabel(t('jr.sum.leftTitle'), slEnd(esc(t('jr.sum.leftEnd'))))}<ul class="sm8-list">${rows.join('')}</ul>${button}`;
  })() : '';
  const byline = `<p class="by8"><span class="by8-in">
      <span class="by8-i"><span class="av8" aria-hidden="true">${esc(initials(run.by))}</span><strong lang="en">${esc(run.by || t('jr.someone'))}</strong>${esc(t('jr.by.ran'))}<strong class="by8-mode">${icon(run.mode === 'send' ? 'send' : 'flask', true)}${esc(t(run.mode === 'send' ? 'jr.send' : 'jr.preview'))}</strong></span>
      <span class="by8-i"><time datetime="${esc(run.startedAt)}" title="${esc(fullDate(run.startedAt))}">${esc(when(run.startedAt))}</time></span>
      <span class="by8-i"><span class="by8-dur" title="${esc(t('jr.by.durTip', { n: run.steps.length }))}">${icon('clock', true)}${iso(esc(formatDuration(total)))}</span></span>
      <span class="by8-i">${icon(run.mode === 'send' ? 'send' : 'undo', true, 'i-dir')}${esc(t(run.mode === 'send' ? 'jr.by.committed' : 'jr.by.rolledBack'))}</span>
    </span></p>`;
  const countsText = [passedCount ? t('jr.sum.passedN', { n: passedCount }) : '', failedCount ? t('jr.sum.failedN', { n: failedCount }) : '', skipped ? t('jr.sum.skippedN', { n: skipped }) : ''].filter(Boolean).join(' · ');
  return `${crumbs([{ label: journey.name, href: `#journey/${encodeURIComponent(journey.id)}`, lang: true }, { label: t('jr.runId', { id: run.runId.slice(0, 4) }), here: true }],
      `<button type="button" class="btn btn-ghost btn-xs back-btn" data-action="journey-back">${icon('arrow-left', true)}<span class="back-label">${esc(t('jr.backToJourney'))}</span></button>`)}
    <div class="pane-scroll"><div class="op-head sm8-head">
      <h1 class="op-title sm8-h${tone === 'circle-check' ? ' is-pass' : ended ? ' is-ended' : ''}" id="jr-title" tabindex="-1">${icon(tone)}<span>${esc(verdict.long)}</span></h1>
      <p class="op-desc">${esc(lede)}</p>
      ${byline}
    </div>
    <div class="form j7-body sm8-body">
      ${sectionLabel(t('jr.steps'), slEnd(esc(countsText)))}
      <ol class="sm8" aria-label="${esc(t('jr.steps'))}">${rows}</ol>
      ${failed >= 0 && run.status !== 'stopped' && failed < run.steps.length - 1 ? `<p class="sm8-note">${icon('info', true)}<span>${esc(t('jr.sum.kept', { n: formatNumber(failed + 2) }))}</span></p>` : writesStopped ? '' : ''}
      ${storeRows.length ? `${sectionLabel(t(run.mode === 'send' ? 'jr.sum.writtenTitle' : 'jr.sum.rolledTitle'), slEnd(esc(t(run.mode === 'send' ? 'jr.sum.writtenEnd' : 'jr.sum.rolledEnd'))))}<ul class="sm8-list">${storeRows.join('')}</ul>` : ''}
      ${leftSection}
      ${outputs.length ? `${sectionLabel(t('jr.outputs'), slEnd(esc(t(run.mode === 'send' ? 'jr.sum.outputsSend' : 'jr.sum.outputsPreview'))))}<ul class="sm8-list sm8-outs">${outputs.map(([name, value]) => `<li><code class="sm8-ok" dir="ltr">${esc(name)}</code><code class="sm8-ov" dir="ltr" title="${esc(display(value))}">${esc(display(value))}</code>${copyButton(t('jr.copyOutput', { name }), { action: 'journey-copy-output', size: 'btn-xs', data: `data-copy="${esc(display(value))}"` })}</li>`).join('')}</ul>` : ''}
    </div></div>`;
}

function summaryDetail(journey, index, run) {
  const result = run.steps[index];
  const items = stepProblems(result);
  const criteria = (result.criteria ?? []).filter(criterion => !criterion.passed);
  const lines = [
    ...items.map(item => {
      const what = item.field ? `${item.finding.target}.${item.field.name}` : item.finding.target;
      const value = item.field ? ltr(`${ev(item.field.expected)}<span class="sm8-arr" aria-hidden="true">→</span>${v(item.field.actual)}${item.field.record ? `<span class="sm8-by">${esc(item.field.record)}</span>` : ''}`)
        : esc(t(item.kind === 'missing' ? 'jr.sum.notDone' : item.kind === 'extra' ? 'jr.sum.unexpected' : 'jr.sum.covered', { op: t('jr.op.' + (item.finding.op in OP_BADGE ? item.finding.op : 'write')) })) + (item.finding.record ? `<span class="sm8-by">${esc(item.finding.record)}</span>` : '');
      const plain = item.field ? `${expectedPlain(item.field.expected)} → ${compact(item.field.actual)}` : '';
      return `<li>${findingTag(item.kind)}<span class="sm8-main"><code dir="ltr" title="${esc(what)}">${esc(what)}</code><span class="sm8-dv row-sub"${plain ? ` title="${esc(plain)}"` : ''}>${value}</span></span></li>`;
    }),
    ...criteria.map(criterion => `<li>${findingTag('differs')}<span class="sm8-main"><code dir="ltr" title="${esc(criterion.condition)}">${esc(criterion.condition)}</code><span class="sm8-dv row-sub" title="${esc(`${t('jr.got')} ${compact(criterion.actual)}`)}">${esc(t('jr.got'))} ${v(criterion.actual)}</span></span></li>`),
  ];
  if (!lines.length && result.httpStatus != null && ['refused', 'blocked'].includes(result.status)) lines.push(`<li>${findingTag('differs')}<span class="sm8-main"><code dir="ltr">$statusCode</code><span class="sm8-dv row-sub">${v(result.httpStatus)}</span></span></li>`);
  return `<div class="sm8-detail" id="sm8-d${index}">${lines.length ? `<ul>${lines.join('')}</ul>` : ''}
    <a href="#journey/${encodeURIComponent(journey.id)}/step/${encodeURIComponent(journey.steps[index].stepId)}" class="btn btn-sm sm8-open" data-journey-step="${esc(journey.steps[index].stepId)}" data-from-run="${esc(run.runId)}">${esc(t('jr.openStep', { n: formatNumber(index + 1) }))}${icon('arrow-right', true)}</a></div>`;
}

/** The summary's bar: the verdict, then Send run and Preview again. */
export function summaryBar(journey, run, { previewSessions = true, opening = false } = {}) {
  const failed = run.steps.filter(step => ['failed', 'refused', 'blocked'].includes(step.status)).length;
  const disabled = opening ? ' disabled' : '';
  const status = opening ? openingStatus() : failed ? statusLine(icon('circle-x', true), t('jr.sum.stepsFailed', { n: failed }), 'is-bad7')
    : runVerdict(run).ended ? statusLine(icon('stop', true), t(run.mode === 'send' ? 'jr.stopped' : 'jr.ended'), '', runVerdict(run).short)
    : statusLine(icon('circle-check', true), t('jr.sum.allPassed'));
  const previewBlocked = journey.sendOnly || !previewSessions;
  return `${status}<button type="button" class="btn btn-run btn-send${previewBlocked ? ' btn-primary' : ''}" data-action="journey-send-run" ${shortcutAttrs(previewBlocked ? 'preview' : 'send')}${disabled}>${icon('send', true)}<span>${esc(t(run.mode === 'send' && previewBlocked ? 'jr.sendAgain' : 'jr.sendRun'))}</span>${shortcutHint(previewBlocked ? 'preview' : 'send')}</button>
    ${previewBlocked ? '' : `<button type="button" class="btn btn-primary btn-run btn-preview" data-action="journey-preview-run" ${shortcutAttrs('preview')}${disabled}${opening ? ' aria-busy="true"' : ''}>${openingGlyph(opening, 'refresh')}<span>${esc(t('jr.previewAgain'))}</span>${shortcutHint('preview')}</button>`}`;
}

/** The summary's aside: approved differences used and not needed, the inputs, the timeline; exports. */
export function summaryAside(journey, run, { tab: selected = 'approved', inputsHtml = '' } = {}) {
  const used = journey.approved.filter(record => run.approvedUsed?.includes(record.id));
  const unused = journey.approved.filter(record => run.approvedUnused?.includes(record.id));
  const expired = journey.approved.filter(record => run.approvedExpired?.includes(record.id));
  const count = used.length + unused.length + expired.length;
  const tabs = `<div class="tabs scrolls" role="tablist" aria-label="${esc(t('jr.runDetails'))}">
    ${tab(t('jr.approvedDifferences'), { selected: selected === 'approved', count, id: 'jr-tab-approved', controls: 'jr-run-panel', data: 'data-run-tab="approved"' })}
    ${tab(t('jr.inputs'), { selected: selected === 'inputs', count: Object.keys(run.inputs ?? {}).length, id: 'jr-tab-inputs', controls: 'jr-run-panel', data: 'data-run-tab="inputs"' })}
    ${tab(t('jr.timeline'), { selected: selected === 'timeline', id: 'jr-tab-timeline', controls: 'jr-run-panel', data: 'data-run-tab="timeline"' })}</div>`;
  let panel;
  if (selected === 'inputs') panel = inputsHtml;
  else if (selected === 'timeline') {
    panel = `<ol class="hr7 j7-timeline">${[
      [run.startedAt, run.mode === 'send' ? t('jr.tl.startedSend') : t('jr.tl.startedPreview'), 'play'],
      ...run.steps.filter(step => step.httpStatus != null).map(step => [step.at || run.startedAt, `${stepTitle(journey.steps.find(item => item.stepId === step.stepId))} · ${step.httpStatus}`, ['failed', 'refused', 'blocked'].includes(step.status) ? 'circle-x' : 'circle-check', step]),
      ...(run.finishedAt ? [[run.finishedAt, t(run.mode === 'send' ? 'jr.tl.ended' : 'jr.tl.rolledBack'), run.mode === 'send' ? 'check' : 'undo']] : []),
    ].map(([time, label, glyph, step]) => `<li><span class="hr7-ico is-${glyph === 'circle-x' ? 'danger' : glyph === 'circle-check' ? 'ok' : 'muted'}">${icon(glyph, true)}</span><span class="hr7-l"><span class="hr7-a" lang="en">${esc(label)}</span>${step ? `<span class="hr7-b">${esc(formatDuration(step.durationMs ?? 0))}</span>` : ''}</span><span class="hr7-t">${ltr(esc(hhmmss(time)))}</span></li>`).join('')}</ol>`;
  } else {
    panel = `${used.length ? `${sectionLabel(t('jr.ad.used'), slEnd(esc(formatNumber(used.length))))}${used.map(record => approvedCard(record, journey)).join('')}` : ''}
      ${unused.length ? `${sectionLabel(t('jr.ad.notNeeded'), slEnd(esc(formatNumber(unused.length))))}${unused.map(record => approvedCard(record, journey, { unused: true })).join('')}` : ''}
      ${expired.length ? `${sectionLabel(t('jr.ad.expiredTitle'), slEnd(esc(formatNumber(expired.length))))}${expired.map(record => approvedCard(record, journey, { expired: true })).join('')}` : ''}
      ${!count ? stateBlock({ glyph: 'badge-check', compact: true, title: esc(t('jr.ad.noneTitle')), body: esc(t('jr.ad.noneBody')) }) : ''}`;
  }
  const cli = `npx sendproof journeys run ${journey.id} \\\n  --mode ${run.mode} --inputs inputs.json --junit report.xml`;
  return `<div class="resp-head j7-rh"><strong class="j7-rh-t">${esc(t('jr.runId', { id: run.runId.slice(0, 4) }))}</strong><span class="status-code ${verdictMark(run).tone}">${icon(verdictMark(run).glyph, true)}${esc(run.status === 'passed' ? t('jr.passed') : runEnded(run) ? t(run.mode === 'send' ? 'jr.stopped' : 'jr.ended') : run.status === 'stopped' ? t('jr.stopped') : t('jr.failed'))}</span><span class="spacer"></span>${copyButton(t('jr.copyJson'), { action: 'journey-copy-json' })}<button type="button" class="btn btn-sm" data-action="journey-junit">${icon('download', true)}JUnit XML</button></div>
    ${tabs}
    <div class="pane-scroll" role="tabpanel" id="jr-run-panel" aria-labelledby="jr-tab-${selected}"><div class="result-body j7-ads">
      ${panel}
      ${selected === 'approved' ? `${sectionLabel(t('jr.cli'))}<div class="blk-code j7-cli" dir="ltr"><pre lang="en">${esc(cli)}</pre>${copyButton(t('jr.copyCommand'), { action: 'journey-copy-cli', size: 'btn-xs', data: `data-copy="${esc(cli.replace(' \\\n  ', ' '))}"` })}</div>
      <p class="j7-mcp">${icon('bot', true)}<span>${esc(t('jr.mcp'))} ${['start_run', 'run_step', 'run_remaining', 'get_run'].map(name => code(name)).join(' ')}</span></p>` : ''}
    </div></div>
    <div class="pane-bar result-bar">${barText(icon('clock', true), t('jr.runKept', { id: run.runId.slice(0, 4) }))}${historyButton()}</div>`;
}

/* ---------- Empty and loading ---------- */

const csharp = {
  cls: `public sealed class OrderToShipmentJourney
    : Journey<OrderToShipmentInputs>
{
    protected override void Define(
        JourneyBuilder<OrderToShipmentInputs> journey)
    {
        var place = journey.Step("placeOrder",
            StoreOperations.Orders.Place);
        place.Set(r => r.Body.CustomerId,
            journey.Input(i => i.CustomerId));
        Ref<Guid> orderId = place.Output(o => o.Id);
        …
    }
}`,
  reg: 'sendproof.AddJourneys(typeof(Program).Assembly);',
  test: 'public sealed class JourneyTests : JourneyTestSuite<Program> { }',
};

/** The prompt "Copy a prompt for your agent" copies: what to write, where, and how to check it. */
export const agentPrompt = apiName => t('jr.empty.prompt', { api: apiName || 'this API' });

export function emptyMain({ apiName = '', dotnet = true } = {}) {
  const block = (text, label) => `<div class="blk-code" dir="ltr"><pre lang="en">${highlightSnippet(text, 'csharp')}</pre>${copyButton(label, { action: 'journey-copy-snippet', size: 'btn-xs', data: `data-copy="${esc(text)}"` })}</div>`;
  return `${crumbs([{ label: t('jr.mode.journeys'), here: true }])}
    <div class="pane-scroll"><div class="j7-empty">${stateBlock({ glyph: 'route', heading: 'h1', title: esc(t('jr.empty.title')), body: th('jr.empty.body', { test: '<code>dotnet test</code>' }) })}
      <div class="j7-cta"><button type="button" class="btn btn-primary btn-sm copy" data-action="journey-copy-prompt" data-copy="${esc(agentPrompt(apiName))}">${icon('bot', true, 'i-idle')}${icon('check', true, 'i-done')}<span class="copy-label"><span>${esc(t('jr.empty.prompt.copy'))}</span><span aria-hidden="true">${esc(t('copy.copied'))}</span></span></button><span>${esc(t('jr.empty.orByHand'))}</span></div>
      ${dotnet ? `<ol class="j7-how">
        <li><span class="n">1</span><div><strong>${esc(t('jr.empty.step1'))}</strong><p>${esc(t('jr.empty.step1Body'))}</p>${block(csharp.cls, t('jr.copyCode'))}</div></li>
        <li><span class="n">2</span><div><strong>${esc(t('jr.empty.step2'))}</strong><p>${esc(t('jr.empty.step2Body'))}</p>${block(csharp.reg, t('jr.copyCode'))}</div></li>
        <li><span class="n">3</span><div><strong>${esc(t('jr.empty.step3'))}</strong><p>${esc(t('jr.empty.step3Body'))}</p>${block(csharp.test, t('jr.copyCode'))}</div></li>
      </ol>` : ''}
      <p class="j7-empty-foot"><a href="https://spec.openapis.org/arazzo/v1.1.0.html" class="link" target="_blank" rel="noopener noreferrer">${esc(t('jr.empty.arazzo'))}</a></p>
    </div></div>
    <div class="actionbar j7-actions">${statusLine(icon('info', true), t('jr.empty.bar'))}</div>`;
}

export const emptyAside = () => `<div class="resp-head j7-rh"><strong class="j7-rh-t">${esc(t('jr.runs'))}</strong></div>
  <div class="pane-scroll"><div class="result-body">${stateBlock({ glyph: 'history', compact: true, title: esc(t('jr.runs.appear')), body: esc(t('jr.runs.appearBody')) })}</div></div>
  <div class="pane-bar result-bar">${runsBar(0)}</div>`;

const line = (width, extra = '') => `<span class="sk sk-line${extra}" style="inline-size:${width}"></span>`;
export function loadingMain() {
  return `${crumbs([{ label: t('jr.mode.journeys'), href: '#journeys' }, { label: '', here: true, html: '<span class="sk sk-line" style="inline-size:9rem;display:inline-block"></span>' }])}
    <div class="progress" role="progressbar" aria-label="${esc(t('jr.loadingJourney'))}"></div>
    <div class="pane-scroll" aria-busy="true"><div class="op-head j7-head j7-skel">${line('14rem', ' j7-sk-title')}${line('92%')}${line('64%')}
      <div class="op-meta">${['6rem', '8.5rem', '7rem', '11rem'].map(width => `<span class="sk j7-sk-pill" style="inline-size:${width}"></span>`).join('')}</div></div>
      <div class="form j7-body j7-skel">${sectionLabel(t('jr.steps'))}
        <ol class="js7">${[0, 1, 2, 3, 4].map(i => `<li class="js7-step"><span class="sk js7-node"></span><div class="js7-main"><div class="js7-l1">${line(['7.5rem', '6.5rem', '8.5rem', '6rem', '5.5rem'][i])}<span class="js7-sum">${line(['6.5rem', '4.5rem', '6.5rem', '9rem', '4.5rem'][i])}</span></div><div class="js7-l2">${line(['10rem', '9.5rem', '14rem', '16rem', '10.5rem'][i])}</div><div class="js7-l3"><span class="sk j7-sk-pill" style="inline-size:${['5.5rem', '8rem', '8rem', '8rem', '8rem'][i]};block-size:1.375rem"></span></div></div></li>`).join('')}</ol>
        ${sectionLabel(t('jr.inputs'))}
        <div class="j7-sk-fields">${['100%', '100%', '48%', '48%'].map(width => `<div class="j7-sk-field" style="inline-size:${width}">${line('5.5rem')}<span class="sk j7-sk-control"></span>${line('60%')}</div>`).join('')}</div>
      </div></div>
    <div class="actionbar j7-actions">${statusLine('<span class="spinner" aria-hidden="true"></span>', t('jr.loading'))}
      <button type="button" class="btn btn-run btn-send" disabled>${icon('send', true)}<span>${esc(t('jr.sendRun'))}</span></button>
      <button type="button" class="btn btn-primary btn-run btn-preview" disabled>${icon('play', true, 'i-dir')}<span>${esc(t('jr.previewRun'))}</span></button></div>`;
}

export const loadingAside = () => `<div class="resp-head j7-rh"><strong class="j7-rh-t">${esc(t('jr.lastRun'))}</strong>${line('7rem')}</div>
  <div class="pane-scroll" aria-busy="true"><div class="result-body j7-last j7-skel">${line('70%')}
    <ol class="lr7-list">${[0, 1, 2, 3, 4].map(() => `<li class="lr7-row"><span class="sk lr7-n"></span>${line('8rem')}${line('4.5rem')}${line('2.5rem')}</li>`).join('')}</ol></div></div>
  <div class="pane-bar result-bar">${barText(icon('clock', true), t('jr.loadingRuns'))}</div>`;

/** The Arazzo workflow as published, highlighted. */
export function arazzoView(journey) {
  const text = JSON.stringify(journey.def, null, 2);
  return `<div class="j7-body"><div class="blk-raw"><div class="blk-raw-bar"><span>${esc(t('jr.arazzoTitle'))}</span>${journey.arazzoUrl ? `<code dir="ltr">${esc(journey.arazzoUrl)}</code>` : ''}<span class="spacer"></span>${copyButton(t('jr.copyJson'), { action: 'journey-copy-snippet', size: 'btn-xs', data: `data-copy="${esc(text)}"` })}</div><pre class="sql" dir="ltr">${highlightJson(text)}</pre></div></div>`;
}

