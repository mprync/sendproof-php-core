import { copyButton, esc, icon } from './components.js';
import { formatNumber, t } from './i18n.js';
import { shortcutAttrs, shortcutHint } from './shortcuts.js';

const headerNames = new Map([
  ['etag', 'ETag'], ['x-request-id', 'X-Request-ID'], ['www-authenticate', 'WWW-Authenticate'],
  ['traceparent', 'traceparent'], ['tracestate', 'tracestate'], ['x-sendproof-trace', 'X-Sendproof-Trace'],
]);

function headerName(name) {
  if (headerNames.has(name.toLowerCase())) return headerNames.get(name.toLowerCase());
  return name === name.toLowerCase() ? name.replace(/(^|-)[a-z]/g, part => part.toUpperCase()) : name;
}

function headerEntries(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers;
  if (typeof headers.entries !== 'function') return Object.entries(headers);
  const entries = [...headers.entries()];
  const cookies = headers.getSetCookie?.();
  return cookies?.length ? [
    ...entries.filter(([name]) => name.toLowerCase() !== 'set-cookie'), ['Set-Cookie', cookies],
  ] : entries;
}

function headerValues(entries, name) {
  return entries.filter(([key]) => key.toLowerCase() === name)
    .flatMap(([, value]) => value);
}

function parseUrl(value, base) {
  try {
    return new URL(value, base);
  } catch { /* Keep invalid locations as plain text. */ }
}

function locationUrl(value, requestUrl, basePath) {
  if (typeof value !== 'string' || !value.trim()) return;
  const pageUrl = globalThis.location?.href;
  const base = (basePath && parseUrl(basePath, pageUrl)) || pageUrl;
  const request = (requestUrl && parseUrl(requestUrl, base)) || base;
  const target = parseUrl(value, request);
  if (target?.protocol === 'http:' || target?.protocol === 'https:') return target.href;
}

function responseHeaderAction(name, values, requestHeaders, result, context) {
  const value = values[0];
  if (name === 'location' && values.length === 1) {
    const href = locationUrl(value, result.requestUrl, context.basePath);
    return href ? `<a class="btn btn-xs" href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-location-open ${shortcutAttrs('follow-response')}>${esc(t('hdrs.open'))} ${shortcutHint('follow-response')}</a>` : '';
  }
  if (name === 'x-request-id') {
    const requestIds = headerValues(requestHeaders, name);
    if (requestIds.length === 1 && values.length === 1 && value && value === requestIds[0]) {
      return `<span class="tag tag-ok">${icon('check', true)}${esc(t('hdrs.matchesRequest'))}</span>`;
    }
  }
  if (name === 'idempotency-replayed') {
    if (value === 'false') return `<span class="faint hdr-note">${esc(t('hdrs.firstUse'))}</span>`;
    if (value === 'true') return `<span class="faint hdr-note">${esc(t('hdrs.replayed'))}</span>`;
  }
  return '';
}

function headerList(entries, extra = () => '') {
  return `<dl class="hdr-list">${entries.map(([key, value]) => {
    const name = headerName(key);
    const values = [value].flat();
    return `<div class="hdr"><dt>${esc(name)}</dt><dd>
      <span class="hdr-values">${values.map(item => `<span class="v" title="${esc(item)}">${esc(item)}</span>`).join('')}</span>
      ${extra(key.toLowerCase(), values)}</dd></div>`;
  }).join('')}</dl>`;
}

function section(label, summary, body) {
  return `<details class="capture-section"><summary class="fx-head collapsed-section">
    <span class="capture-chevron">${icon('chevron-right', true, 'faint')}</span><span class="title">${label}</span>
    <span class="faint">${summary}</span></summary><div class="capture-section-body">${body}</div></details>`;
}

/** The headers pane: response headers, then the request headers as sent and any cookies. */
export function headersMarkup(result, context) {
  const response = headerEntries(result.headers);
  const request = headerEntries(result.requestHeaders);
  const sent = headerValues(request, 'cookie').map(value => ['Cookie', value]);
  const received = headerValues(response, 'set-cookie').map(value => ['Set-Cookie', value]);
  const cookies = [...received, ...sent];
  return `<div class="hdr-section">
    <div class="section-label">${esc(t('hdrs.response'))} <span class="schema">${formatNumber(response.length)}</span><span class="rule" aria-hidden="true"></span>
      ${response.length ? copyButton(t('hdrs.copyAll'), { size: 'btn-xs', data: 'data-copy-response-headers' }) : ''}</div>
    ${response.length ? headerList(response, (name, values) => responseHeaderAction(name, values, request, result, context)) :
      `<p class="faint capture-note">${esc(t('hdrs.none'))}</p>`}
  </div>
  ${request.length ? section(esc(t('hdrs.request')), esc(t('hdrs.requestSummary', { n: formatNumber(request.length) })), headerList(request)) : ''}
  ${cookies.length ? section(esc(t('hdrs.cookies')), formatNumber(cookies.length), headerList(cookies)) : ''}`;
}

/** Wires "Copy all headers": copies `Name: value` lines exactly as the API sent them. */
export function bindHeaders(container, result, copy) {
  container.querySelector('[data-copy-response-headers]')?.addEventListener('click', event => {
    const lines = headerEntries(result.headers).flatMap(([name, values]) =>
      [values].flat().map(value => `${name}: ${value}`));
    const list = container.querySelector('.hdr-list');
    return copy(lines.join('\n'), { button: event.currentTarget, what: t('copy.what.headers'), select: list, notice: list });
  });
}
