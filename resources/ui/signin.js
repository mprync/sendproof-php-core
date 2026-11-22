// The sign-in page (mocks 14–16, m09). It keeps a way back to the workbench, offers every
// sign-in method the API reports, and explains failures: a 401 is "Wrong email or password",
// a 5xx says what happened, what to try and shows the technical details on request.
import { copyTextButton, esc, icon } from './components.js';
import { formatDateTime, formatDuration, t, th } from './i18n.js';
import { copyText } from './copy.js';
import { initials } from './view.js';
import { shortcutAttrs, shortcutHint } from './shortcuts.js';
import { isPersonaRefusal } from './personas.js';

function providerGlyph(provider) {
  const label = String(provider.label || provider.kind || '');
  const kind = String(provider.kind || '').toLowerCase();
  if (/microsoft|entra/i.test(label)) return '<span class="glyph g-ms" aria-hidden="true">ME</span>';
  if (/okta/i.test(label)) return '<span class="glyph g-okta" aria-hidden="true">OK</span>';
  if (kind.includes('saml')) return `<span class="glyph g-saml" aria-hidden="true">${icon('building', true)}</span>`;
  return `<span class="glyph g-saml" aria-hidden="true">${esc(initials(label))}</span>`;
}

const isSecondaryProvider = provider => /api.?key|client.?credentials|negotiate|windows/i.test(provider.kind || '');

function secondaryIcon(provider) {
  const kind = String(provider.kind || '').toLowerCase();
  if (/client.?credentials/.test(kind)) return 'code';
  if (/negotiate|windows/.test(kind)) return 'windows';
  return 'key';
}

const providerLinks = providers => providers.length ? `<div class="stack">${providers.map(provider => `
  <a class="btn sso" href="${esc(provider.url)}">${providerGlyph(provider)}<span class="grow">${esc(t('signin.continueWith', { name: provider.label }))}</span><span class="via">${esc(provider.kind)}</span></a>`).join('')}</div>` : '';

const otherProviders = providers => providers.length ? `<div class="others" role="group" aria-label="${esc(t('signin.otherMethods'))}">
  <span class="lbl">${esc(t('signin.alsoEnabled'))}</span>${providers.map(provider => `<a class="btn btn-sm" href="${esc(provider.url)}">${icon(secondaryIcon(provider), true)}${esc(provider.label)}</a>`).join('')}</div>` : '';

function passwordForm(provider) {
  if (!provider) return '';
  return `<form id="signin-form" class="form" style="padding:0;gap:0.25rem" novalidate>
    <div class="field"><span class="label"><label for="email">${esc(t('signin.email'))}</label></span>
      <div class="control"><span class="lead">${icon('at', true)}</span><input id="email" autocomplete="username" required aria-describedby="email-assist"><span class="slot" aria-hidden="true"></span></div>
      <div class="assist" id="email-assist"></div></div>
    <div class="field"><span class="label"><label for="password">${esc(t('signin.password'))}</label><span class="type">${esc(t('signin.via', { url: `POST ${provider.url}` }))}</span></span>
      <div class="control"><input id="password" type="password" autocomplete="current-password" required aria-describedby="password-assist">
        <button type="button" id="show-password" class="slot wand" aria-label="${esc(t('signin.show'))}" aria-pressed="false">${icon('eye', true)}</button></div>
      <div class="assist" id="password-assist"><span class="assist-icon" hidden>${icon('alert', true)}</span><span class="msg" id="auth-error" role="alert"></span></div></div>
    <button type="submit" class="btn btn-primary btn-block" style="margin-block-start:0.5rem">${icon('log-in', true)}${esc(t('shell.signIn'))}</button>
  </form>`;
}

function discovery(providers) {
  if (!providers.length) return '';
  const names = providers.map(provider => `<code>${esc(provider.kind || provider.label)}</code>`).join(', ');
  return `<p class="discovered">${th('signin.discovered', { names })}</p>`;
}

function personaPanel(provider, database) {
  if (!provider) return '';
  return `<section class="persona-card" aria-labelledby="h-seed">
    <div class="h"><strong id="h-seed">${icon('user', true)}${esc(t('signin.seeded'))}</strong><p>${database ? th('signin.seededBody', { db: `<code class="ltr">${esc(database)}</code>` }) : esc(t('signin.seededBodyHere'))}</p></div>
    <div id="personas"><div class="persona-row" role="status"><span class="faint">${esc(t('signin.loadingAccounts'))}</span></div></div>
  </section>`;
}

/**
 * Replaces the seeded-account panel when the host does not offer it to this caller (it answered
 * 401, 403 or 404): a quiet pointer to the other sign-in methods, in the panel's place, not an error.
 */
const personaRefusedNote = () => `<p class="inline-note persona-refused" id="personas-refused">${icon('info', true)}<span>${esc(t('signin.seededUnavailable'))}</span></p>`;

function personaMarkup(user, index) {
  const roles = (Array.isArray(user.roles) ? user.roles : user.role ? [user.role] : []).map(role => `<span class="tag tag-mono">${esc(role)}</span>`).join(' ');
  return `<button type="button" class="persona-row fx-head" data-persona="${index}" style="min-block-size:3.5rem">
    <span class="avatar" aria-hidden="true">${esc(initials(user.name || user.email))}</span>
    <span class="stack"><span><strong style="font-weight:500">${esc(user.name || user.email || '')}</strong> ${roles}</span><span class="sub ltr">${esc(user.email || '')}</span></span>
    ${icon('arrow-right', true, 'faint')}
  </button>`;
}

/** The first lines of a server error body, which usually name the exception. */
function errorExcerpt(text) {
  return String(text || '').split('\n').map(line => line.trimEnd()).filter(line => line && !/^\s+at /.test(line)).slice(0, 3).join('\n').slice(0, 600);
}

/** The explanation shown when the API fails while signing in (mock 14). */
function serverErrorPanel(failure) {
  const crypto = /CryptographicException|DataProtection|key ring/i.test(failure.body);
  return `<div class="err-panel" role="alert" aria-labelledby="err-title">
    <div class="top">${icon('alert')}<div><h2 id="err-title">${esc(t('signin.failedTitle'))}</h2><p>${th('signin.failedBody', { status: `<strong>${esc(failure.status)}</strong>` })}</p></div></div>
    <ol class="todo">
      <li>${esc(t('signin.todoRetry'))}</li>
      ${crypto ? `<li>${th('signin.todoKeys')}</li><li>${th('signin.todoKeysFix')}</li>` : `<li>${esc(t('signin.todoConsole'))}</li>`}
    </ol>
    <div class="acts"><button type="button" class="btn btn-primary btn-sm" data-signin-retry ${shortcutAttrs('preview')}>${icon('refresh', true)}${esc(t('res.tryAgain'))} ${shortcutHint('preview')}</button>${failure.personas ? `<button type="button" class="btn btn-sm" data-focus-personas>${esc(t('signin.useSeeded'))}</button>` : ''}</div>
    <details class="details">
      <summary>${icon('chevron-right', true)}${esc(t('signin.details'))}<span class="spacer"></span><span class="faint" style="font-weight:400">${esc(failure.status)}${failure.trace ? ` · ${esc(t('signin.trace', { id: failure.trace.slice(3, 11) }))}` : ''}</span></summary>
      <div class="details-acts">${copyTextButton(t('signin.copyDetails'), { cls: 'btn-xs', data: 'data-copy-details' })}</div>
      <dl class="facts">
        <dt>${esc(t('signin.request'))}</dt><dd class="ltr">${esc(`POST ${failure.url}`)}</dd>
        <dt>${esc(t('signin.status'))}</dt><dd class="ltr">${esc(`${failure.status} ${failure.statusText || ''}`.trim())} · <bdi>${esc(formatDuration(failure.ms))}</bdi></dd>
        ${failure.trace ? `<dt>${esc(t('signin.traceId'))}</dt><dd class="ltr">${esc(failure.trace)}</dd>` : ''}
        <dt>${esc(t('signin.time'))}</dt><dd class="plain">${esc(formatDateTime(failure.when))}</dd>
      </dl>
      ${failure.excerpt ? `<pre class="ltr">${esc(failure.excerpt)}</pre>` : ''}
    </details>
  </div>`;
}

/** Render configured authentication providers and optional development personas. */
export async function showSignIn(root, capabilities, onSignedIn, onCancel) {
  const controller = new AbortController();
  let active = true;
  const providers = Array.isArray(capabilities.authProviders) ? capabilities.authProviders : [];
  const password = providers.find(provider => provider.kind?.toLowerCase() === 'cookie' && provider.url);
  const personas = providers.find(provider => provider.kind?.toLowerCase() === 'personas' && provider.url);
  const links = providers.filter(provider => provider.url && provider !== password && provider !== personas);
  const primary = links.filter(provider => !isSecondaryProvider(provider));
  const secondary = links.filter(isSecondaryProvider);
  const database = typeof capabilities.database === 'string' ? capabilities.database : capabilities.database?.name;
  const api = capabilities.apiName || 'API';

  root.innerHTML = `<div class="sign-page">
    <header class="bar">
      <div class="brand"><span class="brand-mark" aria-hidden="true">${icon('mark')}</span><span class="desktop-only">${esc(t('app.name'))}</span></div>
      <span class="crumb-sep desktop-only" aria-hidden="true">/</span><span class="desktop-only" lang="en">${esc(api)}</span>
      <span class="spacer"></span>
      ${capabilities.environment ? `<span class="pill pill-ok desktop-only"><span class="dot" aria-hidden="true"></span>${esc(capabilities.environment)}${database ? ` · <span class="ltr">${esc(database)}</span>` : ''}</span>` : ''}
      <button type="button" class="btn btn-ghost btn-sm" id="cancel-signin" ${shortcutAttrs('escape')}>${icon('arrow-left', true)}<span class="desktop-only">${esc(t('signin.back'))}</span><span class="mobile-only">${esc(t('signin.backShort'))}</span> ${shortcutHint('escape')}</button>
    </header>
    <main class="sign-main">
      <div class="sign-layout">
        <section aria-labelledby="h-signin">
          <h1 id="h-signin" tabindex="-1">${esc(t('signin.title', { api }))}</h1>
          <p class="lede">${esc(t('signin.lede'))}</p>
          <div id="signin-problem"></div>
          ${providerLinks(primary)}
          ${password && primary.length ? `<div class="or" role="separator">${esc(t('signin.orPassword'))}</div>` : ''}
          ${passwordForm(password)}
          ${otherProviders(secondary)}
          ${!password && !links.length && !personas ? `<p class="faint">${esc(t('signin.noProvider'))}</p>` : ''}
        </section>
        ${personas || providers.length || capabilities.personasRefused ? `<div>${capabilities.personasRefused ? personaRefusedNote() : personaPanel(personas, database)}${discovery(providers)}</div>` : ''}
      </div>
    </main>
  </div>`;

  const cancel = () => {
    active = false;
    controller.abort();
    globalThis.document?.removeEventListener('keydown', onKey);
    onCancel();
  };
  const onKey = event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.target.closest?.('input')) cancel();
  };
  globalThis.document?.addEventListener('keydown', onKey);
  root.querySelector('#cancel-signin').onclick = cancel;
  const error = root.querySelector('#auth-error');
  const problem = root.querySelector('#signin-problem');
  root.querySelector('#show-password')?.addEventListener('click', event => {
    const input = root.querySelector('#password');
    const shown = input.type === 'password';
    input.type = shown ? 'text' : 'password';
    event.currentTarget.setAttribute('aria-label', t(shown ? 'signin.hide' : 'signin.show'));
    event.currentTarget.setAttribute('aria-pressed', String(shown));
  });

  /** Marks the password field with a message, or clears it. */
  function fieldError(message) {
    if (!error) return;
    error.innerHTML = message || '';
    const assist = error.closest?.('.assist');
    assist?.classList?.toggle('is-error', !!message);
    const iconNode = assist?.querySelector?.('.assist-icon');
    if (iconNode) iconNode.hidden = !message;
    const input = root.querySelector('#password');
    const control = input?.closest?.('.control');
    control?.classList?.toggle('is-invalid', !!message);
    if (message) input?.setAttribute('aria-invalid', 'true');
    else input?.removeAttribute?.('aria-invalid');
  }

  let lastAttempt;
  async function signIn(url, body, button) {
    lastAttempt = () => signIn(url, body, button);
    button.disabled = true;
    fieldError('');
    if (problem) problem.innerHTML = '';
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: 'POST', credentials: 'include', redirect: 'error', signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        const text = response.status >= 500 ? await response.text().catch(() => '') : '';
        throw Object.assign(new Error(t('signin.failedStatus', { status: response.status })), {
          status: response.status, statusText: response.statusText, url, body: text, ms: performance.now() - started,
          trace: response.headers?.get?.('traceparent') || '', when: Date.now(),
        });
      }
      if (active) { globalThis.document?.removeEventListener('keydown', onKey); await onSignedIn(); }
    } catch (failure) {
      if (!active) return;
      button.disabled = false;
      if (failure.status === 401 || failure.status === 400) {
        fieldError(esc(t(personas ? 'signin.wrongWithSeeded' : 'signin.wrong')));
        root.querySelector('#password')?.focus?.();
      } else if (failure.status >= 500 && problem) {
        problem.innerHTML = serverErrorPanel({ ...failure, excerpt: errorExcerpt(failure.body), personas: !!personas });
        bindProblem(failure);
      } else if (problem && failure.status) {
        problem.innerHTML = `<div class="inline-note danger" role="alert">${icon('alert', true)}<span>${esc(t('signin.otherStatus', { status: failure.status }))}</span></div>`;
      } else if (problem) {
        problem.innerHTML = `<div class="inline-note danger" role="alert">${icon('wifi-off', true)}<span>${esc(t('signin.network'))}</span></div>`;
      } else fieldError(esc(failure.message));
    }
  }

  function bindProblem(failure) {
    problem.querySelector('[data-signin-retry]')?.addEventListener('click', () => lastAttempt?.());
    problem.querySelector('[data-focus-personas]')?.addEventListener('click', () => root.querySelector('#personas [data-persona]')?.focus());
    problem.querySelector('[data-copy-details]')?.addEventListener('click', event => {
      const details = `POST ${failure.url}\n${failure.status} ${failure.statusText || ''}\n${failure.trace || ''}\n${new Date(failure.when).toISOString()}\n\n${errorExcerpt(failure.body)}`;
      copyText(details, { button: event.currentTarget, what: t('copy.what.error'), select: problem.querySelector('pre'), notice: problem.querySelector('.details-acts') });
    });
    problem.querySelector('.err-panel')?.focus?.();
  }

  root.querySelector('#signin-form')?.addEventListener('submit', event => {
    event.preventDefault();
    signIn(password.url, { email: root.querySelector('#email').value, password: root.querySelector('#password').value },
      event.currentTarget.querySelector('[type="submit"]'));
  });

  if (personas) {
    const container = root.querySelector('#personas');
    try {
      const response = await fetch(personas.url, { credentials: 'include', redirect: 'error', signal: controller.signal });
      if (active && isPersonaRefusal(response.status)) {
        // Not offered here: swap the panel for the pointer to password sign-in. No error.
        const card = container.closest?.('.persona-card');
        card?.insertAdjacentHTML('beforebegin', personaRefusedNote());
        card?.remove();
        return;
      }
      if (!response.ok) throw new Error(t('signin.accountsStatus', { status: response.status }));
      const users = await response.json();
      if (!Array.isArray(users)) throw new Error(t('signin.accountsInvalid'));
      if (!active) return;
      container.innerHTML = users.map(personaMarkup).join('') || `<div class="persona-row"><span class="faint">${esc(t('signin.noAccounts'))}</span></div>`;
      container.onclick = event => {
        const button = event.target.closest('[data-persona]');
        const user = button && users[Number(button.dataset.persona)];
        if (user?.email) signIn(`${personas.url.replace(/\/$/, '')}/${encodeURIComponent(user.email)}`, null, button);
      };
    } catch (failure) {
      if (active) container.innerHTML = `<div class="persona-row" role="alert"><span style="color:var(--danger)">${esc(failure.message)}</span></div>`;
    }
  }
}
