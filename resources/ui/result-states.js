// Every state of the result pane that isn't captured data (mock: results.js). All five tabs
// always exist and are always clickable; each shows content, a zero state, or why nothing was
// captured. The head row says what ran, how it ended and how long it took.
import { esc, ghostRows, icon, stateBlock, statusTone } from './components.js';
import { formatBytes, formatDuration, formatNumber, formatTime, t, th } from './i18n.js';
import { shortcutAttrs, shortcutHint } from './shortcuts.js';
import { inline } from './markdown.js';
import { blockedSkeleton } from './result-blocked.js';
import { storeMark, storeName, storeNames } from './stores.js';

export const RESULT_TABS = ['Response', 'Database', 'Side effects', 'Logs', 'Headers'];
export const resultTabLabel = tab => t('res.tab.' + tab);

const statusNames = new Map([
  [200, 'OK'], [201, 'Created'], [202, 'Accepted'], [204, 'No Content'], [301, 'Moved Permanently'],
  [302, 'Found'], [304, 'Not Modified'], [400, 'Bad Request'], [401, 'Unauthorized'], [403, 'Forbidden'],
  [404, 'Not Found'], [405, 'Method Not Allowed'], [409, 'Conflict'], [412, 'Precondition Failed'],
  [415, 'Unsupported Media Type'], [422, 'Unprocessable Content'], [429, 'Too Many Requests'],
  [500, 'Internal Server Error'], [502, 'Bad Gateway'], [503, 'Service Unavailable'], [504, 'Gateway Timeout'],
]);
/** "201 Created": the code with its standard reason phrase, which is protocol text, not UI text. */
export const statusText = status => [status, statusNames.get(status)].filter(Boolean).join(' ');

const header = (result, name) => Object.entries(result?.headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
/** A rejection before any handler ran: Sendproof can say nothing was read or changed. */
export const rejectedEarly = result => result?.status === 401 || result?.status === 403;
/** Whether this result carries captured changes, effects and logs. */
export const captured = result => !!result && (result.preview || !!result.traceId);

/** Counts for the five tabs: a number, or '–' when not known. Response has no badge. */
export function resultCounts(result) {
  if (!result || result.error) return [undefined, '–', '–', '–', '–'];
  const headers = Object.keys(result.headers || {}).length;
  // A blocked Preview kept nothing, so its capture tabs are not known rather than zero.
  if (result.blocked) return [undefined, '–', '–', '–', headers];
  if (captured(result)) return [undefined, result.changes?.length ?? 0, result.effects?.length ?? 0, result.logs?.length ?? 0, headers];
  if (rejectedEarly(result)) return [undefined, 0, 0, '–', headers];
  return [undefined, '–', '–', '–', headers];
}

const pill = preview => preview
  ? `<span class="pill pill-accent">${icon('flask', true)}${esc(t('res.preview'))}</span>`
  : `<span class="pill pill-ok">${icon('send', true)}${esc(t('res.sent'))}</span>`;

// The size gives way first in a very narrow result pane (views.css), so the line never wraps.
const metrics = result => `<span class="metric"><bdi>${esc(formatDuration(result.duration ?? 0))}</bdi><span class="size"> · <bdi>${esc(formatBytes(result.size ?? 0))}</bdi></span></span>`;

/** The head row before anything has run. */
export const idleHeader = () => `<span class="faint">${esc(t('res.none'))}</span><span class="spacer"></span>`;

/**
 * The result bar under the result pane: when and how the shown result was produced, and the way
 * to older runs (History). `result` is the current result, `running` the run in flight, if any.
 */
export function resultBar(result, { running, identity } = {}) {
  let glyph = 'clock';
  let text = t('bar.noRuns');
  if (running) text = t('bar.runningShort');
  else if (result?.network || result?.error) text = t('bar.noResponse');
  else if (result) {
    const traced = !result.preview && result.traceId;
    glyph = result.blocked ? 'ban' : result.preview ? 'undo' : 'send';
    const what = t(result.blocked ? 'bar.previewBlocked' : result.preview ? 'bar.previewRun' : traced ? 'bar.sendTraced' : 'bar.sendRun');
    const time = formatTime(result.finishedAt ?? Date.now());
    text = identity ? t('bar.lastRunAs', { what, time, name: identity }) : t('bar.lastRun', { what, time });
  }
  return `<span class="bar-text">${icon(glyph, true)}<span>${esc(text)}</span></span>
    <button type="button" class="btn btn-ghost btn-sm" data-action="history" ${shortcutAttrs('history')}>${icon('history', true)}${esc(t('shell.history'))}${shortcutHint('history')}</button>`;
}

/** The head row while a request runs, with Cancel. */
export const runningHeader = (preview, identity) =>
  `<span class="pill pill-accent"><span class="spinner" aria-hidden="true"></span>${esc(t(preview ? 'res.preview' : 'res.sending'))}</span>
   <span class="faint running-label">${esc(identity ? t('res.runningAs', { name: identity }) : t('res.running'))}</span>
   <span class="metric" data-elapsed aria-hidden="true">${esc(formatDuration(0))}</span><span class="spacer"></span>
   <button type="button" class="btn btn-ghost btn-sm" data-action="cancel-request" ${shortcutAttrs('escape')}>${esc(t('bar.cancel'))} ${shortcutHint('escape')}</button>`;

/** The head row for a response, with Copy as cURL and the next step. */
export function responseHeader(result, { resourceLabel, match = '', plain = false } = {}) {
  const ok = result.status < 400;
  const location = header(result, 'location');
  let resource;
  if (!result.preview && location) {
    try {
      const url = new URL(location, result.requestUrl);
      if (/^https?:$/.test(url.protocol)) resource = url.href;
    } catch { /* Skip malformed Location values. */ }
  }
  const tracedPill = !result.preview && result.traceId
    ? `<span class="pill pill-ok">${icon('send', true)}${esc(t('res.traced'))}</span>` : pill(result.preview);
  const action = plain ? '' : result.preview && ok
    ? `<button type="button" class="btn btn-sm" data-action="send" ${shortcutAttrs('send')}>${icon('send', true)}${esc(t('res.sendForReal'))}</button>`
    : resource ? `<a class="btn btn-sm result-open" href="${esc(resource)}" target="_blank" rel="noopener noreferrer" data-location-open ${shortcutAttrs('follow-response')}>${esc(resourceLabel || t('res.openResource'))} ${shortcutHint('follow-response')}</a>` : '';
  return `${tracedPill}<span class="status-code ${statusTone(result.status)}">${icon(ok ? 'check' : result.status === 401 ? 'lock' : 'alert', true)}<bdi class="ltr">${esc(statusText(result.status))}</bdi></span>${metrics(result)}${match}<span class="spacer"></span>
    ${result.wireRequest ? `<button type="button" class="btn btn-ghost btn-icon btn-sm copy" data-action="copy-curl" aria-label="${esc(t('shortcut.copy-curl'))}" title="${esc(t('shortcut.copy-curl'))}" ${shortcutAttrs('copy-curl')}>${icon('copy', true, 'i-idle')}${icon('check', true, 'i-done')}</button>` : ''}
    ${action}`;
}

/** The head row when nothing came back. */
export const networkHeader = result =>
  `<span class="pill pill-danger">${icon('wifi-off', true)}${esc(t('res.noResponse'))}</span><span class="metric">${esc(t('res.after', { time: formatDuration(result.seconds * 1000) }))}</span><span class="spacer"></span>`;

/** The head row when the request couldn't be made or acknowledged. */
export const errorHeader = () =>
  `<span class="status-code err">${icon('alert', true)}${esc(t('res.failed'))}</span><span class="spacer"></span>`;

const previewButton = () => `<button type="button" class="btn btn-primary btn-sm" data-action="preview" ${shortcutAttrs('preview')}>${icon('flask', true)}${esc(t('bar.preview'))} ${shortcutHint('preview')}</button>`;
const sendButton = readOnly => `<button type="button" class="btn btn-sm" data-action="send" ${shortcutAttrs(readOnly ? 'send-read-only' : 'send')}>${icon('send', true)}${esc(t('bar.send'))} ${shortcutHint(readOnly ? 'send-read-only' : 'send')}</button>`;
const runButton = context => context.canPreview ? previewButton() : sendButton(context.readOnly);

/** The documented responses of the operation, each linking to its schema. */
function documentedResponses(context) {
  const entries = Object.entries(context.op?.operation.responses || {});
  if (!entries.length) return '';
  return `<div class="expect"><div class="expect-h">${esc(t('res.documented'))}</div>${entries.map(([code, response]) => {
    const media = Object.values(response?.content || {})[0];
    const name = context.schemaName(media?.schema);
    return `<div class="expect-row"><span class="code ${statusTone(code)}">${esc(code)}</span><span lang="en">${response?.description ? inline(String(response.description).replace(/\s*\n\s*/g, ' ')) : esc(statusNames.get(Number(code)) || '')}</span><span class="spacer"></span>${name
      ? `<a class="type-link" href="#model/${encodeURIComponent(name.replace(/\[\]$/, ''))}" data-model="${esc(name.replace(/\[\]$/, ''))}">${esc(name)}</a>`
      : `<span class="faint">${esc(t('res.noBody'))}</span>`}</div>`;
  }).join('')}</div>`;
}

/** What each tab will show before anything has run, and how to fill it. */
export function beforeRun(tab, context) {
  const { readOnly, canPreview, unavailable } = context;
  // An operation marked preview: false says why in the body, and keeps Preview's step, marked off.
  const offBody = unavailable && (unavailable.stores.length
    ? t('res.before.response.previewOff', { stores: storeNames(unavailable.stores) })
    : t('res.before.response.previewOffNoStore'));
  const offStep = unavailable ? `<li class="step-off">${icon('flask-off', true)}<span>${esc(t('res.step.previewOff'))}</span><span class="spacer"></span>${unavailable.stores.map(store => `<span class="step-tag">${storeMark(store)}${esc(storeName(store))}</span>`).join('')}</li>` : '';
  if (tab === 'Response') return stateBlock({
    glyph: 'braces', title: esc(t('res.before.response.title')),
    body: esc(offBody || t(readOnly ? 'res.before.response.readOnly' : canPreview ? 'res.before.response.body' : 'res.before.response.noPreview')),
    extra: `<ol class="steps">
      ${context.fillable ? `<li>${icon('wand', true)}${esc(t('shortcut.autofill-required'))}${shortcutHint('autofill-required')}</li>` : ''}
      ${canPreview ? `<li>${icon('flask', true)}${esc(t('res.step.preview'))}${shortcutHint('preview')}</li>` : offStep}
      <li>${icon('send', true)}${esc(t(readOnly ? 'res.step.sendReadOnly' : 'res.step.send'))}${shortcutHint(readOnly ? 'send-read-only' : 'send')}</li>
    </ol>${documentedResponses(context)}`,
  });
  const spec = {
    Database: ['db', readOnly ? 'res.before.database.readOnly' : canPreview ? 'res.before.database.body' : 'res.before.database.noPreview', [['plus', '30%', '12%'], ['edit', '42%', '18%']]],
    'Side effects': ['mail', canPreview ? 'res.before.effects.body' : 'res.before.effects.noPreview', [['mail', '38%', '14%'], ['globe', '52%', '20%'], ['clock', '30%', '16%']]],
    Logs: ['list', 'res.before.logs.body', [['info', '64%', '8%'], ['db', '48%', '8%'], ['info', '56%', '8%']]],
    Headers: ['list', 'res.before.headers.body', [['hash', '28%', '40%'], ['hash', '22%', '34%']]],
  }[tab];
  return stateBlock({
    glyph: spec[0], title: esc(t('res.before.' + tab + '.title')), body: esc(t(spec[1])),
    extra: ghostRows(spec[2]), actions: [runButton(context)],
  });
}

/** Send without a trace: say what isn't captured, and how to capture it. */
export function notCaptured(tab, context) {
  const turnOn = context.traceAvailable
    ? `<button type="button" class="btn btn-sm" data-action="traced-on">${esc(t('res.tracedOn'))}</button>` : '';
  const actions = [context.canPreview ? previewButton() : '', turnOn].filter(Boolean);
  const why = context.traceAvailable ? esc(t('res.tracedWhy')) : '';
  if (tab === 'Database') return stateBlock({ glyph: 'db', title: esc(t('res.notCaptured.database')), body: esc(t(context.traceAvailable ? 'res.notCaptured.databaseBody' : 'res.notCaptured.databaseNoTrace')), actions, why });
  if (tab === 'Side effects') return stateBlock({ glyph: 'mail', title: esc(t('res.notCaptured.effects')), body: esc(t(context.traceAvailable ? 'res.notCaptured.effectsBody' : 'res.notCaptured.effectsNoTrace')), actions });
  return stateBlock({ glyph: 'list', title: esc(t('res.notCaptured.logs')), body: esc(t(context.traceAvailable ? 'res.notCaptured.logsBody' : 'res.notCaptured.logsNoTrace')), actions });
}

/** A tab with nothing in it after a captured run. */
export function zeroState(tab, result) {
  const status = result.status;
  if (tab === 'Database') return stateBlock({ glyph: 'db', title: esc(t('res.zero.database')), body: esc(rejectedEarly(result) ? t('res.zero.databaseRejected', { status }) : t('res.zero.databaseBody')) });
  if (tab === 'Side effects') return stateBlock({ glyph: 'check', title: esc(t('res.zero.effects')), body: esc(rejectedEarly(result) ? t('res.zero.effectsRejected') : t('res.zero.effectsBody')) });
  if (tab === 'Logs') return stateBlock({ glyph: 'list', title: esc(t('res.zero.logs')), body: esc(t('res.zero.logsBody')) });
  return stateBlock({ glyph: 'list', title: esc(t('res.zero.headers')), body: esc(t('res.zero.headersBody')) });
}

/** A 401 explains what happened and offers sign-in and retry, instead of a bare empty body. */
export function unauthorized(result, context) {
  const challenge = header(result, 'www-authenticate');
  const schemes = context.schemes?.length ? context.schemes.map(name => `<code>${esc(name)}</code>`).join(', ') : '';
  return `<div class="problem" role="alert">
    <div class="problem-head">${icon('lock')}<div><h3>${esc(t('res.unauthorized.title'))}</h3><p>${th(schemes ? 'res.unauthorized.body' : 'res.unauthorized.bodyNoScheme', { op: `<span lang="en">${esc(context.op?.title || '')}</span>`, schemes })}</p></div></div>
    ${context.canSignIn ? `<div class="actions"><button type="button" class="btn btn-primary" data-action="signin-retry" ${shortcutAttrs('signin')}>${icon('log-in', true)}${esc(t('res.unauthorized.signIn'))} ${shortcutHint('signin')}</button></div>` : ''}
    <dl class="facts problem-facts"><dt>${esc(t('res.unauthorized.bodyLabel'))}</dt><dd class="plain">${esc(result.raw ? t('res.unauthorized.bodySize', { size: formatBytes(result.size) }) : t('res.unauthorized.empty', { size: formatBytes(0) }))}</dd>${challenge ? `<dt>WWW-Authenticate</dt><dd>${esc(challenge)}</dd>` : ''}<dt>${esc(t('res.unauthorized.retry'))}</dt><dd class="plain">${th('res.unauthorized.retryBody', { op: `<span lang="en">${esc(context.op?.title || '')}</span>` })}</dd></dl>
  </div>`;
}

/** Nothing came back: the API may be down. The request stays as it was. */
export const networkError = result => stateBlock({
  glyph: 'wifi-off', tone: 'danger', title: esc(t('res.network.title')), role: 'alert',
  body: th('res.network.body', { origin: `<code class="ltr">${esc(result.origin || result.host)}</code>` }),
  why: esc(t('res.network.why')),
  actions: [
    `<button type="button" class="btn btn-primary btn-sm" data-action="retry-request">${icon('refresh', true)}${esc(t('res.tryAgain'))}</button>`,
    `<button type="button" class="btn btn-ghost btn-sm copy" data-action="copy-failed-curl">${icon('copy', true, 'i-idle')}${icon('check', true, 'i-done')}<span class="copy-label"><span>${esc(t('res.copyCurl'))}</span><span aria-hidden="true">${esc(t('copy.copied'))}</span></span></button>`,
  ],
});

/** The request couldn't be prepared or the preview wasn't acknowledged. */
export const requestError = result => stateBlock({
  glyph: 'alert', tone: 'danger', title: esc(t('res.error.title')), role: 'alert',
  body: esc(result.error), why: esc(t('res.error.why')),
});

/**
 * Skeletons that mirror the final layout of each tab while a request runs. `blocked`: this
 * operation's last Preview was stopped by the write guard, so the Response tab waits in the shape
 * of the blocked state instead of the JSON viewer.
 */
export function loadingBody(tab, preview, { blocked = false } = {}) {
  if (blocked && tab === 'Response') return blockedSkeleton();
  const sk = (width, height = '0.7rem', extra = '') => `<span class="sk" style="display:block;inline-size:${width};block-size:${height};${extra}"></span>`;
  if (tab === 'Database' && preview) return `<div class="result-body" aria-hidden="true">${sk('100%', '3.25rem', 'border-radius:var(--r-lg)')}
    ${[5, 2].map(rows => `<div class="table-change"><div class="tc-head">${sk('4.5rem', '1.25rem')}${sk('7rem', '0.8rem')}</div><div class="kv">${Array.from({ length: rows }, (_, i) => `<div>${sk(`${40 + (i * 7) % 30}%`)}</div><div>${sk(`${50 + (i * 11) % 40}%`)}</div>`).join('')}</div></div>`).join('')}</div>`;
  return `<div class="result-body" aria-hidden="true"><div class="viewer"><div class="viewer-bar">${sk('11rem', '1.6rem')}</div><div class="code-view">${[30, 62, 40, 48, 36, 70, 74, 55, 30].map((width, index) =>
    `<div class="ln"><span class="no">${formatNumber(index + 1)}</span><span></span><span class="src" style="--d:${index ? 1 : 0}">${sk(width + '%')}</span></div>`).join('')}</div></div></div>`;
}
