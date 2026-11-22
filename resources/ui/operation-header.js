// The operation header above the request tabs (mock: request.js "Operation header"): title and
// summary from the spec, requirement pills, a notice for deprecation or a missing sign-in, and the
// URL bar with its copy button. The breadcrumbs and the Try it ⇄ Docs switch live in the head row
// above it (context-bar.js).
import { copyButton, esc, icon, method, statusTone } from './components.js';
import { t, th } from './i18n.js';
import { isPublic, primarySchemes, scopeText } from './security.js';
import { shortcutAttrs } from './shortcuts.js';
import { deprecationNotice } from './deprecation.js';
import { inline, linkOperationIds } from './markdown.js';

/**
 * Requirement pills: the permission or public access, idempotency and documented codes.
 * Colour carries meaning only: the access pill is green when the signed-in user may call the
 * operation, amber when it needs a sign-in, and accent for a public operation; each status code
 * takes its class's hue (statusTone), with its documented description as the tooltip.
 */
export function metaPills(op, document, signedIn) {
  const pills = [];
  if (isPublic(op, document)) pills.push(`<span class="pill access is-public">${icon('globe', true)}${esc(t('op.public'))}</span>`);
  else {
    const scopes = scopeText(op, document);
    const names = scopes ? [scopes] : primarySchemes(op, document).map(item => item.name);
    const state = signedIn ? 'is-met' : 'is-locked';
    for (const name of names) pills.push(`<span class="pill access ${state}">${icon(signedIn ? 'shield' : 'lock', true)}<span>${esc(name)}</span></span>`);
  }
  if (op.parameters?.some(p => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key'))
    pills.push(`<span class="pill">${esc(t('op.idempotent'))}</span>`);
  const responses = op.operation.responses || {};
  const codes = Object.keys(responses).filter(code => /^\d/.test(code)).sort();
  if (codes.length) {
    const items = codes.map(code => {
      const description = firstSentence(responses[code]?.description || '');
      return `<span class="sc sc-${statusTone(code)}"${description ? ` title="${esc(`${code} · ${description}`)}"` : ''}><i aria-hidden="true"></i>${esc(code)}</span>`;
    }).join('');
    pills.push(`<span class="pill codes" role="group" aria-label="${esc(t('docs.responses'))}"><bdi class="ltr">${items}</bdi></span>`);
  }
  return pills.length ? `<div class="op-meta">${pills.join('')}</div>` : '';
}

/** A deprecation notice (mock 88) wins over the sign-in notice; both sit above the URL bar. */
export function operationNotice(op, document, signedIn, canSignIn, ops = []) {
  const operation = op.operation;
  if (operation.deprecated) return deprecationNotice(op, { ops, document, where: 'try' });
  if (!signedIn && !isPublic(op, document)) {
    return `<div class="op-notice auth" role="note">${icon('lock', true)}<span class="grow">${th('op.needsSignIn')}</span>${canSignIn ? `<button type="button" class="btn btn-sm" data-action="signin" ${shortcutAttrs('signin')}>${icon('log-in', true)}${esc(t('shell.signIn'))}</button>` : ''}</div>`;
  }
  return '';
}

/** The URL bar. Path parameters are buttons that jump to their field. Always left to right. */
export function urlBar(op, base) {
  const path = op.path.split(/(\{[^{}]+\})/).map((part, index) => index % 2
    ? `<button type="button" class="token" data-path-param="${esc(part.slice(1, -1))}" aria-label="${esc(t('op.pathParameter', { name: part.slice(1, -1) }))}">${icon('link', true)}${esc(part.slice(1, -1))}</button>`
    : esc(part)).join('');
  return `<div class="urlbar">${method(op.method)}<span class="url"><span class="base">${esc(base)}</span>${path}</span>${copyButton(t('op.copyUrl'), { action: 'copy-url', size: 'btn-xs', shortcut: 'copy-url' })}</div>`;
}

/** The whole header for the Try it view. */
export function operationHeader(op, { base = '', document, signedIn = false, canSignIn = false, ops = [] } = {}) {
  return `<div class="op-head">
    <div class="op-title-row"><h1 class="op-title" id="op-title" lang="en">${esc(op.title)}</h1></div>
    ${op.operation.description || op.operation.summary && op.operation.summary !== op.title
      ? `<p class="op-desc" lang="en">${linkOperationIds(inline(firstSentence(op.operation.description || op.operation.summary, true)), ops, 'op')}</p>` : ''}
    ${metaPills(op, document, signedIn)}
    ${operationNotice(op, document, signedIn, canSignIn, ops)}
    ${urlBar(op, base)}
  </div>`;
}

/** The first paragraph of a markdown description, without markup, for the one-line summary. */
export function firstSentence(markdown, keepCode = false) {
  // The notice says "Deprecated" once, so the summary doesn't repeat it. Code spans may stay
  // (as `sort` in mono) when the caller renders inline markdown.
  return String(markdown).replace(/^\s*\**deprecated\.?\**\s*/i, '').split(/\n\s*\n/)[0].replace(keepCode ? /[*_]/g : /[*_`]/g, '').trim();
}
