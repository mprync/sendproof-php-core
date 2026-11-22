// Whether the host lets this browser use its `personas` (seeded accounts) source. A host may
// refuse it, for example the Acme Store example answers 403 when the workbench is opened from another
// machine. A refusal (401, 403, 404) means "this option does not exist here": every place that
// offers seeded accounts hides it and points to password sign-in instead, with no error. Any other
// failure (network error, 5xx) says nothing about access, so those places keep their own handling.
//
// The answer is found once while the workbench boots, before the first paint, so nothing appears
// and then disappears.

/** Statuses that mean the seeded-account list is not offered to this caller. */
const REFUSALS = new Set([401, 403, 404]);

/** True when `status` is a refusal rather than a failure. */
export const isPersonaRefusal = status => REFUSALS.has(status);

/** The personas provider advertised by discovery, if any. */
export const personasProvider = capabilities =>
  (capabilities?.authProviders || []).find(provider => provider.kind?.toLowerCase() === 'personas' && provider.url);

/**
 * Asks the personas source whether it answers this caller. Resolves to `'available'` (2xx),
 * `'refused'` (401, 403 or 404) or `'unknown'` (network error, timeout, 5xx or anything else).
 * It never rejects, and gives up after `timeout` ms so a slow host cannot hold the first paint.
 */
export async function probePersonas(provider, { timeout = 3000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  signal?.addEventListener?.('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetch(provider.url, { credentials: 'include', redirect: 'error', signal: controller.signal });
    if (response.ok) return 'available';
    return isPersonaRefusal(response.status) ? 'refused' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the capabilities to use for the session. When the host refuses the personas source the
 * provider is removed from `authProviders` (so the sidebar notice, the request editor, the
 * sign-in page and the seeded menu all stop offering it) and `personasRefused` is set so the
 * sign-in page can say where to go instead. Otherwise the capabilities are returned unchanged.
 */
export async function resolvePersonaAccess(capabilities, options) {
  const provider = personasProvider(capabilities);
  if (!provider) return capabilities;
  return withPersonasRefused(capabilities, (await probePersonas(provider, options)) === 'refused');
}

/** Removes the personas provider from `capabilities` when `refused`, and says so. */
export function withPersonasRefused(capabilities, refused = true) {
  if (!refused) return capabilities;
  return {
    ...capabilities, personasRefused: true,
    authProviders: (capabilities.authProviders || []).filter(provider => provider.kind?.toLowerCase() !== 'personas'),
  };
}
