// The "Seeded account" menu of the signed-out notice: sign in as one of the API's seeded users
// in a click, without leaving the page. The accounts come from the same `personas` provider the
// sign-in page uses; the menu is arrow-key navigable and Esc closes it.
import { esc, icon } from './components.js';
import { t } from './i18n.js';
import { closePopover, openPopoverAt } from './popover.js';
import { isPersonaRefusal, personasProvider } from './personas.js';

const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';

/**
 * Opens the menu under `button`. `onSignedIn()` runs after the API accepted the sign-in; failures
 * are shown inside the menu and nothing else changes.
 */
export async function openSeededMenu(button, { capabilities, onSignedIn }) {
  const provider = personasProvider(capabilities);
  if (!provider) return;
  const pop = openPopoverAt(button, `<div class="pop seeded-pop" role="menu" aria-label="${esc(t('auth.out.seeded'))}">
      <div class="pop-group"><div class="pop-label">${esc(t('signin.seeded'))}</div><div data-seeded-list role="none"><div class="opt-row" role="status"><span class="faint">${esc(t('signin.loadingAccounts'))}</span></div></div></div>
    </div>`, { align: 'start', focus: false, kind: 'seeded', onClose: () => button.setAttribute('aria-expanded', 'false') });
  const list = pop.querySelector('[data-seeded-list]');
  let users;
  try {
    const response = await fetch(provider.url, { credentials: 'include', redirect: 'error' });
    if (isPersonaRefusal(response.status)) {
      // The host does not offer seeded accounts to this caller: drop the option, show no error.
      closePopover();
      button.hidden = true;
      return;
    }
    if (!response.ok) throw new Error(t('signin.accountsStatus', { status: response.status }));
    users = await response.json();
    if (!Array.isArray(users)) throw new Error(t('signin.accountsInvalid'));
  } catch (failure) {
    list.innerHTML = `<div class="opt-row" role="alert"><span style="color:var(--danger)">${esc(failure.message)}</span></div>`;
    return;
  }
  list.innerHTML = users.map((user, index) => {
    const roles = (Array.isArray(user.roles) ? user.roles : user.role ? [user.role] : []).join(', ');
    return `<button type="button" class="opt-row" role="menuitem" tabindex="-1" data-seeded="${index}" style="inline-size:100%;border:0;background:none;text-align:start;font:inherit">
      <span class="avatar" aria-hidden="true">${esc(initials(user.name || user.email))}</span>
      <span class="stack"><span class="main">${esc(user.name || user.email || '')}${roles ? ` <span class="tag tag-mono">${esc(roles)}</span>` : ''}</span><span class="sub ltr">${esc(user.email || '')}</span></span></button>`;
  }).join('') || `<div class="opt-row"><span class="faint">${esc(t('signin.noAccounts'))}</span></div>`;
  const items = [...list.querySelectorAll('[role="menuitem"]')];
  items[0]?.focus();
  pop.addEventListener('keydown', event => {
    const index = items.indexOf(document.activeElement);
    const keys = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 };
    if (event.key in keys && items.length) {
      event.preventDefault();
      items[(keys[event.key] + items.length) % items.length].focus();
    }
  });
  pop.addEventListener('click', async event => {
    const item = event.target.closest('[data-seeded]');
    const user = item && users[Number(item.dataset.seeded)];
    if (!user?.email) return;
    item.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(`${provider.url.replace(/\/$/, '')}/${encodeURIComponent(user.email)}`, { method: 'POST', credentials: 'include', redirect: 'error' });
      if (!response.ok) throw new Error(t('signin.failedStatus', { status: response.status }));
      closePopover();
      onSignedIn();
    } catch (failure) {
      item.removeAttribute('aria-busy');
      list.insertAdjacentHTML('afterbegin', `<div class="opt-row" role="alert">${icon('alert', true)}<span style="color:var(--danger)">${esc(failure.message)}</span></div>`);
    }
  });
}
