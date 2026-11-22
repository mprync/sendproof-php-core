// The API overview (mocks/docs.js overview): the landing page on first visit, built from info,
// servers and tags. It explains Preview, Send and Autofill before anything runs and suggests
// where to start. Same two columns and bars as every other view.
import { copyButton, esc, icon, method } from './components.js';
import { contextBar } from './context-bar.js';
import { copyText } from './copy.js';
import { baseUrl } from './docs-view.js';
import { t, th } from './i18n.js';
import { markdown } from './markdown.js';
import { opKey } from './operations.js';
import { shortcutAttrs, shortcutHint } from './shortcuts.js';

const firstSentence = text => String(text ?? '').split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ').replace(/[*_`]/g, '').trim().replace(/^(.{0,160}?[.!?])\s.*$/, '$1');

/**
 * Renders the overview into the two reading panes.
 * @param {HTMLElement} main the `.doc-pane`
 * @param {HTMLElement} aside the `.aside-pane`
 * @param {{ state: object }} ctx
 */
export function renderOverview(main, aside, { state }) {
  const { doc, ops, cap } = state;
  const info = doc.info || {};
  const signedIn = !!cap.identity?.name;
  const models = Object.keys(doc.components?.schemas || {}).length;
  const tags = new Map();
  for (const op of ops) tags.set(op.group, [...(tags.get(op.group) || []), op]);
  const tagInfo = name => (doc.tags || []).find(tag => tag.name === name)?.description;
  const firstRead = ops.find(op => op.method === 'GET');
  const firstPreview = ops.find(op => (cap.previewOperations || []).some(item => item.method.toUpperCase() === op.method && item.path === op.path));
  const how = [
    ['flask', t('overview.preview'), 'preview', t('overview.previewBody')],
    ['send', t('overview.send'), 'send', t('overview.sendBody')],
    ['wand', t('overview.autofill'), 'autofill-required', t('overview.autofillBody')],
  ];
  const start = (op, note) => `<a href="#op/${encodeURIComponent(opKey(op))}" data-op="${ops.indexOf(op)}">${method(op.method)}<span class="label-text" lang="en">${esc(op.title)}</span><span class="where">${esc(note)}</span></a>`;
  main.innerHTML = `${contextBar({ kind: 'overview' })}
    <div class="pane-scroll"><div class="doc-inner">
      <h1 id="ov-title" tabindex="-1" lang="en">${esc(cap.apiName || info.title || 'API')}${info.version ? ` <span class="faint" style="font-weight:400">${esc(/^\d/.test(info.version) ? 'v' + info.version : info.version)}</span>` : ''}</h1>
      <div class="doc-meta"><span class="tag tag-mono">${esc(baseUrl(doc))}</span>${doc.openapi ? `<span class="tag tag-mono">OpenAPI ${esc(doc.openapi)}</span>` : ''}<span class="tag">${esc(t('overview.operations', { n: ops.length }))}</span><span class="tag">${esc(t('overview.models', { n: models }))}</span></div>
      ${info.summary || info.description ? `<div class="prose" lang="en">${info.description ? markdown(info.description) : `<p>${esc(info.summary)}</p>`}</div>` : ''}
      <h2>${esc(t('overview.how'))}</h2>
      <div class="how">${how.map(([glyph, name, id, text]) => `<div class="how-card"><div class="how-h">${icon(glyph, true)}<strong>${esc(name)}</strong><span class="spacer"></span>${shortcutHint(id)}</div><p>${esc(text)}</p></div>`).join('')}</div>
      <h2>${esc(t('overview.byTag'))}</h2>
      <div class="card used-list">${[...tags].map(([name, items]) => `<a href="#op/${encodeURIComponent(opKey(items[0]))}" data-op="${ops.indexOf(items[0])}"><span class="label-text" lang="en"><strong style="font-weight:500">${esc(name)}</strong>${tagInfo(name) ? ` <span class="faint">· ${esc(firstSentence(tagInfo(name)))}</span>` : ''}</span><span class="where">${esc(t('overview.ops', { n: items.length }))}</span></a>`).join('')}</div>
    </div></div>
    <div class="pane-bar"><span class="bar-text">${icon('info', true)}<span>${esc(t('overview.bar'))}</span></span><button type="button" class="btn btn-sm" data-action="palette" ${shortcutAttrs('palette')}>${icon('search', true)}${esc(t('overview.find'))}${shortcutHint('palette')}</button></div>`;
  aside.innerHTML = `<div class="aside-head">${esc(t('overview.start'))}</div>
    <div class="pane-scroll"><div class="aside-inner">
      ${signedIn ? `<div class="card"><div class="card-head">${icon('check', true)}<strong>${esc(t('overview.signedIn', { name: cap.identity.name }))}</strong></div>
        <p style="margin:0;padding:0.875rem;font-size:var(--fs-md);color:var(--text-2)">${th(cap.identity.role ? 'overview.runsAsRole' : 'overview.runsAs', { name: esc(cap.identity.name), role: `<code>${esc(cap.identity.role || '')}</code>` })}</p></div>` : ''}
      <div class="card used-list">
        ${firstRead ? start(firstRead, t('overview.readOnly')) : ''}
        ${firstPreview ? start(firstPreview, t('overview.tryPreview')) : ''}
        <a href="#overview" data-action="shortcuts">${icon('keyboard', true)}<span class="label-text">${esc(t('overview.shortcuts'))}</span><span class="where">${shortcutHint('shortcuts')}</span></a>
      </div>
    </div></div>
    <div class="pane-bar"><span class="bar-text">${icon('server', true)}<span>${esc(t('docs.base'))} <code class="ltr">${esc(baseUrl(doc))}</code></span></span>${copyButton(t('docs.copyBase'), { action: 'copy-base', size: 'btn-xs' })}</div>`;
  aside.onclick = event => {
    const base = event.target.closest('[data-action="copy-base"]');
    if (base) { event.stopPropagation(); copyText(baseUrl(doc), { button: base, what: t('copy.what.url') }); }
  };
}
