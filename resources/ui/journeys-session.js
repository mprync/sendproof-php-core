// A Preview session for one journey run (spec/README.md, "Preview sessions"): every step of a
// Preview run previews inside it, so a later step sees an earlier step's uncommitted rows, and
// nothing is ever written. One session per run: opened when the run starts, rewound when a step
// is run again, ended (rolled back) when the run finishes or is cancelled. `fetch` and the
// workbench's base URL are injectable so tests drive it without a host.

/** The header a Preview carries to run inside a session. */
export const SESSION_HEADER = 'Sendproof-Session';

/**
 * A session problem: the RFC 9457 `code` (session_not_found, session_busy, session_failed,
 * session_limit, store_busy), status, `title` and `detail`. `idleSeconds` is the idle timeout a
 * `store_busy` refusal says the holder ends by.
 */
export class SessionError extends Error {
  constructor(message, { status, code, title, detail, idleSeconds } = {}) {
    super(message);
    this.name = 'SessionError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.idleSeconds = idleSeconds;
  }
}

/** True when opening was refused because another Preview session holds the store (`store_busy`, 409). */
export const storeBusy = error => error?.code === 'store_busy';

/**
 * True when a session call's error says the session is gone: unknown, expired, ended or foreign
 * (`session_not_found`, 404), or closed by its store (`session_failed`). A busy session
 * (`session_busy`, 409) is still there. A host that sends no `code` is read from the status.
 */
export function sessionGone(error) {
  if (error?.code) return error.code === 'session_not_found' || error.code === 'session_failed';
  return error?.status === 404 || /HTTP 404\b/.test(error?.message ?? '');
}

async function problem(response, fallback) {
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  const idle = Number(body?.idleTimeoutSeconds);
  return new SessionError(body?.title || body?.detail || fallback, {
    status: response.status, code: body?.code, title: body?.title, detail: body?.detail, idleSeconds: idle > 0 ? idle : undefined,
  });
}

const SESSION_ID = /^[a-f\d]{30,}$/i;

/**
 * This tab's held sessions are remembered in sessionStorage, per mount: it survives a reload and a
 * crash-reload of the same tab, so the next load can end what the closed page left holding the
 * store. `storage` is injectable; a missing or full one forgets nothing it needs to.
 */
const defaultStorage = () => { try { return globalThis.sessionStorage; } catch { return undefined; } };
const sessionsUrl = (base, path = '') => new URL(`./_api/sessions${path}`, base).href;
export const heldSessionsKey = (base = globalThis.document?.baseURI) => `sendproof-held-sessions:${sessionsUrl(base)}`;

function heldIds(storage, key) {
  try {
    const ids = JSON.parse(storage?.getItem(key) ?? '[]');
    return Array.isArray(ids) ? ids.filter(id => SESSION_ID.test(String(id))) : [];
  } catch { return []; }
}

function keepIds(storage, key, ids) {
  try { if (ids.length) storage?.setItem(key, JSON.stringify(ids)); else storage?.removeItem(key); } catch { /* Nothing to remember with. */ }
}

/** Rolls a session back. A 404 means it is already gone; any other failure leaves it to the idle timeout. */
async function deleteSession(send, href, keepalive) {
  try { await send(href, { method: 'DELETE', credentials: 'include', redirect: 'error', keepalive }); }
  catch { /* The idle timeout rolls it back anyway. */ }
}

/**
 * Ends every session this tab remembers (an orphan of a closed or crashed page, or all of them on
 * `pagehide` with `keepalive`) and forgets them. Resolves to how many it asked the host to end.
 */
export async function endHeldSessions({ base = globalThis.document?.baseURI, fetch: send = globalThis.fetch, storage = defaultStorage(), keepalive = false } = {}) {
  const key = heldSessionsKey(base);
  const ids = heldIds(storage, key);
  keepIds(storage, key, []);
  await Promise.all(ids.map(id => deleteSession(send, sessionsUrl(base, `/${id}`), keepalive)));
  return ids.length;
}

/**
 * Opens a session. Resolves to a handle with `id`, `header()`, `rewind(step)`, `end()` and the
 * `kept` count: how many steps the session holds, so the next Preview is step `kept + 1`. The
 * tab remembers the ID until the session ends (see `endHeldSessions`).
 */
export async function openSession({ base = globalThis.document?.baseURI, fetch: send = globalThis.fetch, storage = defaultStorage() } = {}) {
  const url = path => sessionsUrl(base, path);
  const response = await send(url(''), { method: 'POST', credentials: 'include', redirect: 'error', headers: { Accept: 'application/json' } });
  if (response.status !== 201) throw await problem(response, `The Preview session couldn't be opened (HTTP ${response.status}).`);
  const opened = await response.json();
  if (!SESSION_ID.test(String(opened?.id ?? ''))) throw new SessionError('The Preview session answered without an ID.', { status: response.status });
  const key = heldSessionsKey(base);
  keepIds(storage, key, [...heldIds(storage, key).filter(id => id !== opened.id), opened.id]);
  let ended = false;
  const session = {
    id: opened.id,
    idleTimeoutSeconds: opened.idleTimeoutSeconds ?? null,
    maxLifetimeSeconds: opened.maxLifetimeSeconds ?? null,
    /** Steps the session holds; a refused step leaves it unchanged. */
    kept: 0,
    get ended() { return ended; },
    header: () => ({ [SESSION_HEADER]: opened.id }),
    /** Notes a Preview's envelope: `session.step` is the step it ran as, which the session now keeps. */
    record(envelope) {
      const step = envelope?.session?.step;
      if (Number.isInteger(step) && envelope?.rolledBack === true && !envelope.blocked && envelope.status < 500) session.kept = step;
      return step;
    },
    /** Rolls back to the savepoint before session step `step` (from 1); that step and later are discarded. */
    async rewind(step) {
      if (step > session.kept) return;
      const reply = await send(url(`/${opened.id}/rewind`), {
        method: 'POST', credentials: 'include', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step }),
      });
      if (reply.status !== 204) throw await problem(reply, `The Preview session couldn't rewind (HTTP ${reply.status}).`);
      session.kept = step - 1;
    },
    /** Rolls everything back and ends the session. Safe to call twice; a gone session is already ended. */
    async end({ keepalive = false } = {}) {
      if (ended) return;
      ended = true;
      keepIds(storage, key, heldIds(storage, key).filter(id => id !== opened.id));
      await deleteSession(send, url(`/${opened.id}`), keepalive);
    },
  };
  return session;
}
