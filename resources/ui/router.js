// Hash routes and history for the workbench. Every page has an address, every navigation pushes
// a history entry, and Back/Forward restore the page and its scroll position.
//
//   #overview
//   #op/<operationId>                      Try it
//   #docs/<operationId>                    the Docs view of an operation
//   #model/<Name>                          a model picked in the Models tab
//   #model/<Name>?from=docs/<operationId>&via=<Model>,<Model>
//                                          a model opened from an operation (`from` is docs/… or
//                                          op/…) or from a $ref followed through other models (`via`)
//
// Expanding a schema inline is not navigation and never changes the address.

/**
 * @typedef {object} Route
 * @property {'overview'|'op'|'docs'|'model'} kind
 * @property {string} [id]     operation id (or "METHOD /path") for op and docs
 * @property {string} [name]   model name for model
 * @property {{kind: 'op'|'docs', id: string}} [from]  the operation a model was opened from
 * @property {string[]} [via]  models followed on the way, nearest to the operation first
 */

const OVERVIEW = Object.freeze({ kind: 'overview' });

/** Parses a location hash ("#model/Payment?from=docs/Op") into a route. Unknown hashes mean the overview. */
export function parseRoute(hash) {
  const text = String(hash ?? '').replace(/^#/, '');
  const split = text.indexOf('?');
  const path = split < 0 ? text : text.slice(0, split);
  const query = new URLSearchParams(split < 0 ? '' : text.slice(split + 1));
  const slash = path.indexOf('/');
  const kind = slash < 0 ? path : path.slice(0, slash);
  let key = '';
  try { key = decodeURIComponent(slash < 0 ? '' : path.slice(slash + 1)); } catch { return OVERVIEW; }
  if ((kind === 'op' || kind === 'docs') && key) return { kind, id: key };
  if (kind === 'model' && key) {
    const route = { kind, name: key };
    const from = /^(op|docs)\/(.+)$/.exec(query.get('from') ?? '');
    if (from) route.from = { kind: from[1], id: from[2] };
    const via = (query.get('via') ?? '').split(',').filter(Boolean);
    if (via.length) route.via = via;
    return route;
  }
  return OVERVIEW;
}

/** The hash for a route, the inverse of {@link parseRoute}. */
export function formatRoute(route) {
  const encode = encodeURIComponent;
  if (route.kind === 'op' || route.kind === 'docs') return `#${route.kind}/${encode(route.id)}`;
  if (route.kind !== 'model') return '#overview';
  const query = [];
  if (route.from) query.push(`from=${route.from.kind}/${encode(route.from.id)}`);
  if (route.via?.length) query.push(`via=${route.via.map(encode).join(',')}`);
  return `#model/${encode(route.name)}${query.length ? '?' + query.join('&') : ''}`;
}

/** Whether two routes are the same page. */
export const sameRoute = (a, b) => formatRoute(a) === formatRoute(b);

/**
 * Where Back goes from a model page: the last model followed, else the operation it was opened
 * from (in the view it came from). Models opened from the Models tab have nowhere to go back to.
 * @returns {{route: Route, label: {kind: 'model'|'op', name?: string, id?: string}} | null}
 */
export function backTarget(route) {
  if (route.kind !== 'model' || !route.from) return null;
  const via = route.via ?? [];
  if (via.length) {
    const name = via.at(-1);
    const rest = via.slice(0, -1);
    return { route: { kind: 'model', name, from: route.from, ...(rest.length ? { via: rest } : {}) }, label: { kind: 'model', name } };
  }
  return { route: { kind: route.from.kind, id: route.from.id }, label: { kind: 'op', id: route.from.id } };
}

/** The route of a model followed from the current page, one step deeper than `route`. */
export function followModel(route, name) {
  if (route.kind === 'model') {
    const via = route.from ? [...(route.via ?? []), route.name] : [];
    return { kind: 'model', name, ...(route.from ? { from: route.from, via } : {}) };
  }
  if (route.kind === 'op' || route.kind === 'docs') return { kind: 'model', name, from: { kind: route.kind, id: route.id } };
  return { kind: 'model', name };
}

/**
 * Keeps history entries in step with navigation. Each entry's state is `{ idx, prev, scroll }`:
 * its position in this session, the address of the page before it, and the scroll offsets saved
 * when the user left it. `idx` and `prev` let Back know whether the browser's previous entry is
 * really the parent page, which a deep link or a reload may break.
 *
 * @param {{ history?: History, location?: Location }} [env] replaceable in tests
 */
export function createHistory({ history: h = globalThis.history, location: where = globalThis.location } = {}) {
  const url = () => where.hash || '#overview';
  const read = () => (h.state && typeof h.state === 'object' ? h.state : {});
  if (!Number.isInteger(read().idx)) h.replaceState({ ...read(), idx: 0 }, '', url());
  return {
    /** The current entry's saved state. */
    get state() { return read(); },
    /** The address of the page now shown. */
    get url() { return url(); },
    /** Saves scroll offsets on the entry being left. */
    saveScroll(scroll) { h.replaceState({ ...read(), scroll }, '', url()); },
    /** Pushes (or replaces) an entry for `route`; returns false when it is already the current page. */
    go(route, { replace = false } = {}) {
      const hash = formatRoute(route);
      if (hash === url()) return false;
      if (replace) h.replaceState({ ...read(), scroll: undefined }, '', hash);
      else h.pushState({ idx: (read().idx ?? 0) + 1, prev: url() }, '', hash);
      return true;
    },
    /** True when the browser's previous entry is `hash`, so `history.back()` lands on it. */
    previousIs(hash) { return (read().idx ?? 0) > 0 && read().prev === hash; },
    back: () => h.back(),
  };
}
