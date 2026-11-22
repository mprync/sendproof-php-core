// "Preview unavailable", caught mid-request (mocks 124, 125, 129, 131, m30, m31): the write guard
// refused a command to a store that can't roll back, so the binding answered 409 with a
// problem+json body (spec/preview-unavailable.schema.json). It is a designed result in amber, not
// a red error: what was blocked, that nothing was written (store by store), what to do next, and
// the body itself. Data (commands, store ids, JSON) stays left to right in every language.
import { copyTextButton, esc, icon, stateBlock } from './components.js';
import { formatDuration, t, th } from './i18n.js';
import { shortcutAttrs, shortcutHint } from './shortcuts.js';
import { copyText } from './copy.js';
import { authorReason, dataStore, dataStores, sqlSystem, storeMark, storeName } from './stores.js';
import { PREVIEW_FALSE_LANGUAGES, bindingOf, chooseLanguage, chosenLanguage, languageName, previewFalseSnippet } from './preview-false.js';

const databaseName = capabilities => typeof capabilities?.database === 'string' ? capabilities.database : capabilities?.database?.name;

/** The head row: Preview, "409 Preview unavailable" in amber, the time, Copy as cURL and Send for real. */
export function blockedHeader(result) {
  return `<span class="pill pill-accent">${icon('flask', true)}${esc(t('res.preview'))}</span>
    <span class="status-code warn is-blocked">${icon('ban', true)}<bdi class="ltr">409</bdi> <span>${esc(t('blk.code'))}</span></span>
    <span class="metric"><bdi>${esc(formatDuration(result.duration ?? 0))}</bdi></span><span class="spacer"></span>
    <span class="resp-acts">${result.wireRequest ? `<button type="button" class="btn btn-ghost btn-icon btn-sm copy" data-action="copy-curl" aria-label="${esc(t('shortcut.copy-curl'))}" title="${esc(t('shortcut.copy-curl'))}" ${shortcutAttrs('copy-curl')}>${icon('copy', true, 'i-idle')}${icon('check', true, 'i-done')}</button>` : ''}
    <button type="button" class="btn btn-sm" data-action="send" ${shortcutAttrs('send')}>${icon('send', true)}${esc(t('res.sendForReal'))}</button></span>`;
}

/** The problem+json body, highlighted like the response viewer's JSON. */
function problemJson(body) {
  const literal = value => typeof value === 'string' ? `<span class="tok-s">"${esc(value)}"</span>` : `<span class="tok-n">${esc(JSON.stringify(value))}</span>`;
  return `<span class="tok-p">{</span>\n${Object.entries(body || {}).map(([key, value]) =>
    `  <span class="tok-k">"${esc(key)}"</span><span class="tok-p">: </span>${literal(value)}`).join('<span class="tok-p">,</span>\n')}\n<span class="tok-p">}</span>`;
}

/**
 * The language and framework the snippet is written for: the host's own when capabilities carry
 * `binding`, otherwise the switch's current choice (`switchable` tells the markup to offer it).
 */
function snippetTarget(capabilities, chosen) {
  const binding = bindingOf(capabilities);
  return binding ? { ...binding, switchable: false } : { language: chosen ?? chosenLanguage(), framework: '', switchable: true };
}

/** The snippet for a blocked Preview: the author's reason, the refused operation's route, the target's idiom. */
function blockedSnippet(result, context, target) {
  const { op } = context;
  return previewFalseSnippet({ language: target.language, framework: target.framework, reason: result.blocked.detail, method: op?.method, path: op?.path });
}

/**
 * The line above the snippet: the host's framework (or language) when discovery names it, otherwise
 * a native select, so the author can read the mark in their own language. Names stay left to right.
 */
function snippetLabel(target) {
  if (!target.switchable) return `<span class="blk-lang" data-blk-lang>${esc(target.framework || languageName(target.language))}</span>`;
  const options = PREVIEW_FALSE_LANGUAGES.map(({ id, name }) => `<option value="${id}"${id === target.language ? ' selected' : ''}>${esc(name)}</option>`).join('');
  return `<span class="blk-lang"><select class="blk-lang-select ltr" data-blk-lang-select aria-label="${esc(t('lang.label'))}">${options}</select></span>`;
}

/** Each store's outcome: the refused store, the SQL rollback, aborted transactions, side effects. */
function safeList(blocked, capabilities) {
  const code = `<code class="ltr">${esc(blocked.operation)}</code>`;
  const label = (system, name) => `<span class="nm">${esc(storeName(system))}${name ? ` <code class="ltr">${esc(name)}</code>` : ''}</span>`;
  const rows = [`<li>${storeMark(blocked.store, 16)}${label(blocked.store, dataStore(capabilities, blocked.store)?.name)}<span class="st is-block">${icon('ban', true)}<span>${th('blk.refused', { op: code })}</span></span></li>`];
  const database = databaseName(capabilities);
  if (database) rows.push(`<li>${storeMark(sqlSystem(capabilities), 16)}${label(sqlSystem(capabilities), database)}<span class="st">${icon('undo', true)}<span>${esc(t('stores.state.rolledBack'))}</span></span></li>`);
  for (const store of dataStores(capabilities).filter(item => item.mode === 'preview' && item.system !== blocked.store)) {
    rows.push(`<li>${storeMark(store.system, 16)}${label(store.system, store.name)}<span class="st">${icon('undo', true)}<span>${esc(t('stores.state.aborted'))}</span></span></li>`);
  }
  rows.push(`<li><span class="mk mk-16 mk-other" aria-hidden="true">${icon('mail', true)}</span><span class="nm">${esc(t('blk.effects'))}</span><span class="st">${icon('undo', true)}<span>${esc(t('blk.discarded'))}</span></span></li>`);
  return rows.join('');
}

/** The Response tab of a blocked Preview. `context` is results.js's context(). */
export function blockedMarkup(result, context = {}) {
  const { blocked } = result;
  const capabilities = context.capabilities || {};
  const store = storeName(blocked.store);
  const guarded = dataStore(capabilities, blocked.store)?.mode !== 'preview';
  const op = `<code class="ltr">${esc(blocked.operation)}</code>`;
  const target = snippetTarget(capabilities);
  // A guarded store can't roll back; a Preview-mode store refused a command it can't run in a
  // transaction, and the server's detail says which.
  const body = guarded ? th('blk.bodyGuard', { op, store: esc(store) })
    : th('blk.bodyRefused', { op, store: esc(store), detail: `<span lang="en">${esc(authorReason(blocked.detail).replace(/[.。]$/, ""))}</span>` });
  const traceOn = context.traceAvailable && !context.traced
    ? `<button type="button" class="btn btn-ghost btn-sm" data-action="traced-on">${esc(t('res.tracedOn'))}</button>` : '';
  return `<section class="blk" aria-labelledby="blk-title">
    <div class="blk-top">
      <span class="blk-tile">${storeMark(blocked.store, 28)}<span class="blk-badge">${icon('ban', true)}</span></span>
      <div class="blk-lede"><p class="blk-eyebrow">${esc(t('blk.eyebrow'))}</p><h3 id="blk-title">${esc(t('blk.title', { store }))}</h3><p>${body}</p></div>
    </div>
    <div class="blk-safe">
      <p class="blk-safe-h">${icon('shield', true)}<strong>${esc(t('blk.safe'))}</strong></p>
      <ul>${safeList(blocked, capabilities)}</ul>
      <p class="blk-note">${esc(t('blk.safeNote'))}</p>
    </div>
    <div class="blk-next">
      <h4>${esc(t('blk.next'))}</h4>
      <div class="blk-step"><span class="n" aria-hidden="true">1</span><div class="grow">
        <div class="blk-acts"><button type="button" class="btn btn-primary btn-sm" data-action="send" ${shortcutAttrs('send')}>${icon('send', true)}${esc(t('res.sendForReal'))}${shortcutHint('send')}</button>${traceOn}</div>
        <p>${esc(t(context.traceAvailable ? 'blk.sendNoteTraced' : 'blk.sendNote'))}</p></div></div>
      <div class="blk-step"><span class="n" aria-hidden="true">2</span><div class="grow">
        <p class="blk-author"><strong>${esc(t('blk.author'))}</strong> ${th('blk.authorBody', { mark: '<code class="ltr">preview: false</code>' })}</p>
        <div class="blk-code ltr">${snippetLabel(target)}<pre lang="en" data-blk-snippet>${esc(blockedSnippet(result, context, target))}</pre>${copyTextButton(t('blk.copy'), { cls: 'btn-xs', data: 'data-blk-copy="snippet"' })}</div>
      </div></div>
    </div>
    <div class="blk-raw"><div class="blk-raw-bar"><span>${esc(t('blk.raw'))}</span><code class="ltr">application/problem+json</code><span class="spacer"></span>${copyTextButton(t('blk.copy'), { cls: 'btn-xs', data: 'data-blk-copy="body"' })}</div>
      <pre class="code-text ltr" tabindex="0" data-blk-body>${problemJson(result.body)}</pre></div>
  </section>`;
}

/** Database, Side effects and Logs of a blocked Preview: it kept nothing, and why. */
export function blockedTab(tab, result, context = {}) {
  const glyph = tab === 'Database' ? 'db' : tab === 'Side effects' ? 'mail' : 'list';
  return stateBlock({
    glyph, title: esc(t('blk.tabTitle')), body: esc(t('blk.tabBody', { store: storeName(result.blocked.store) })),
    actions: [`<button type="button" class="btn btn-sm" data-action="send" ${shortcutAttrs('send')}>${icon('send', true)}${esc(t('res.sendForReal'))}</button>`,
      context.traceAvailable && !context.traced ? `<button type="button" class="btn btn-ghost btn-sm" data-action="traced-on">${esc(t('res.tracedOn'))}</button>` : ''].filter(Boolean),
  });
}

/**
 * Copy buttons for the snippet and the body copy exactly what is shown; the language switch (when
 * discovery names no binding) rewrites the snippet and is remembered for the next 409.
 * `context` is results.js's context(), as for blockedMarkup.
 */
export function bindBlocked(container, result, context = {}) {
  const capabilities = context.capabilities || {};
  let target = snippetTarget(capabilities);
  container.addEventListener('change', event => {
    const select = event.target.closest?.('[data-blk-lang-select]');
    if (!select) return;
    chooseLanguage(select.value);
    target = snippetTarget(capabilities, select.value);
    const pre = container.querySelector('[data-blk-snippet]');
    if (pre) pre.textContent = blockedSnippet(result, context, target);
  });
  container.addEventListener('click', event => {
    const button = event.target.closest('[data-blk-copy]');
    if (!button) return;
    const snippet = button.dataset.blkCopy === 'snippet';
    copyText(snippet ? blockedSnippet(result, context, target) : (result.raw || JSON.stringify(result.body, null, 2)), {
      button, what: t(snippet ? 'copy.what.snippet' : 'copy.what.body'),
      select: container.querySelector(snippet ? '[data-blk-snippet]' : '[data-blk-body]'),
      notice: button.closest('.blk-code, .blk-raw'),
    });
  });
}

/** The loading state of a Preview whose last run was blocked: the same blocks, as skeletons. */
export function blockedSkeleton() {
  const sk = (width, height = '0.7rem', extra = '') => `<span class="sk" style="display:block;inline-size:${width};block-size:${height};${extra}"></span>`;
  return `<div class="result-body" aria-hidden="true"><div class="blk">
    <div class="blk-top"><span class="blk-tile sk" style="border:0"></span><div class="blk-lede">${sk('9rem')}${sk('min(18rem, 80%)', '1.2rem')}${sk('min(24rem, 95%)')}${sk('min(20rem, 85%)')}</div></div>
    <div class="blk-safe"><p class="blk-safe-h">${sk('8rem')}</p><ul>${[0, 1, 2].map(() => `<li>${sk('1rem', '1rem')}${sk('6rem')}<span class="spacer"></span>${sk('7rem')}</li>`).join('')}</ul></div>
    <div class="blk-next">${sk('7rem', '0.9rem')}<div class="blk-step"><span class="n"></span><div class="grow">${sk('9rem', 'var(--btn-sm-h)', 'border-radius:var(--r)')}${sk('min(22rem, 90%)')}</div></div></div>
  </div></div>`;
}
