import { localizeDateTimes } from '../i18n.js';

const read = (item, key) => item && Object.hasOwn(item, key) ? item[key] : undefined;

/** Resolve lookup URLs within the mounted application and use the current user's session. */
export function lookupSource(metadata, basePath) {
  const base = '/' + basePath.replace(/^\/+|\/+$/g, '');
  const prefix = base === '/' ? '' : base;
  const origin = globalThis.location.origin;
  const url = new URL(metadata.url, `${origin}${prefix}/`);
  if (url.origin !== origin || !/^https?:$/.test(url.protocol)) throw new Error('Lookup URL must be same-origin.');
  if (metadata.url.startsWith('/') && !metadata.url.startsWith('//') && prefix &&
    url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) url.pathname = prefix + url.pathname;
  return url;
}

export function lookupOption(metadata, item) {
  if (item === null || typeof item !== 'object') return { value: item, label: String(item) };
  const value = read(item, metadata.valueField || 'id');
  if (value === undefined || value === null || typeof value === 'object') return undefined;
  return {
    value,
    // An ISO date-time in a name or detail reads as a local short date-time; the value is untouched.
    label: localizeDateTimes(read(item, metadata.labelField || 'name') ?? value),
    detail: ((detail) => typeof detail === 'string' ? localizeDateTimes(detail) : detail)(read(item, metadata.detailField || 'detail')),
    status: read(item, metadata.statusField || 'status'),
    // A short code at the end of the row, such as the account's currency.
    end: typeof read(item, metadata.endField || 'currency') === 'string' ? read(item, metadata.endField || 'currency') : undefined,
  };
}

export async function getLookupOptions(context, metadata, query = '') {
  if (Array.isArray(metadata.options)) return metadata.options.map(option => ({
    value: option?.value ?? option,
    label: String(option?.label ?? option?.value ?? option),
    detail: option?.detail,
  }));
  if (!metadata.url) return [];
  const url = lookupSource(metadata, context.basePath);
  if (metadata.searchParam && query) url.searchParams.set(metadata.searchParam, query);
  const key = url.href;
  const cache = context.lookupCache;
  let request = cache.get(key);
  if (!request) {
    request = (async () => {
      const response = await fetch(key, { credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Lookup couldn’t load (HTTP ${response.status}). Try again or paste an ID.`);
      const data = await response.json();
      const list = Array.isArray(data) ? data : read(data, metadata.itemsField || 'items');
      if (!Array.isArray(list)) throw new Error('Lookup returned no list. Paste an ID to continue.');
      return list.map(item => lookupOption(metadata, item)).filter(Boolean);
    })();
    cache.set(key, request);
    request.catch(() => cache.delete(key));
  }
  return request;
}

export function fromLastResponse(last, metadata) {
  if (!last || !metadata.url) return undefined;
  let collection;
  try { collection = new URL(metadata.url, 'https://example.invalid/').pathname; }
  catch { return undefined; }
  if (last.path !== collection && !last.path?.startsWith(collection.replace(/\/$/, '') + '/{')) return undefined;
  return lookupOption(metadata, last.body);
}
