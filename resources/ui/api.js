import { blockedPreview } from './stores.js';

const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

/** Resolve a local OpenAPI Reference Object without requesting external documents. */
export function dereference(value, document) {
  if (!value?.$ref?.startsWith('#/')) return value;
  const parts = value.$ref.slice(2).split('/');
  return parts.reduce((node, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return node && Object.hasOwn(node, key) ? node[key] : undefined;
  }, document);
}

/** Operation parameters override path-level parameters with the same name and location. */
export function operations(document) {
  const discovered = [];
  for (const [path, rawItem] of Object.entries(document.paths || {})) {
    const item = dereference(rawItem, document);
    for (const verb of methods) {
      const operation = item?.[verb];
      if (!operation) continue;
      const parameters = new Map();
      for (const raw of [...(item.parameters || []), ...(operation.parameters || [])]) {
        const parameter = dereference(raw, document);
        if (parameter) parameters.set(parameter.in + ':' + parameter.name, parameter);
      }
      const method = verb.toUpperCase();
      discovered.push({
        method, path, operation, parameters: [...parameters.values()],
        title: operation.summary || operation.operationId || method + ' ' + path,
        group: operation.tags?.[0] || 'Operations',
      });
    }
  }
  return discovered;
}

/**
 * Prepare the browser body and its matching media type together. The caller
 * passes the same mutable headers object to makeRequest. For multipart bodies
 * fetch supplies the boundary and Content-Type itself.
 */
export function encodeRequestBody(value, mediaType = 'application/json', headers = {}) {
  if (value === undefined) return undefined;
  const type = mediaType.split(';')[0].trim().toLowerCase();
  const multipart = type === 'multipart/form-data';
  if (headers instanceof Headers) {
    headers.delete('Content-Type');
    if (!multipart) headers.set('Content-Type', mediaType);
  } else {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') delete headers[key];
    }
    if (!multipart) headers['Content-Type'] = mediaType;
  }
  if (type === 'application/json' || type.endsWith('+json')) return JSON.stringify(value);
  if (multipart || type === 'application/x-www-form-urlencoded') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Form-encoded requests require named fields.');
    }
    const data = multipart ? new FormData() : new URLSearchParams();
    for (const [name, field] of Object.entries(value)) {
      for (const item of Array.isArray(field) ? field : [field]) {
        if (item === undefined) continue;
        if (item instanceof Blob) {
          if (!multipart) throw new Error('File uploads require multipart/form-data.');
          data.append(name, item);
        } else {
          data.append(name, item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item ?? ''));
        }
      }
    }
    return data;
  }
  if (value instanceof Blob || typeof value === 'string') return value;
  throw new Error('Supply text or a file for ' + mediaType + '.');
}

function scalarParts(value, explode) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => explode ? [key + '=' + item] : [key, String(item)]);
  }
  return [String(value)];
}

function addQuery(query, parameter) {
  const { name, value, style = 'form', explode = style === 'form' } = parameter;
  if (!Array.isArray(value) && typeof value === 'object' && (explode || style === 'deepObject')) {
    for (const [key, item] of Object.entries(value)) {
      query.append(style === 'deepObject' ? name + '[' + key + ']' : key, String(item));
    }
  } else if (Array.isArray(value) && explode) {
    for (const item of value) query.append(name, String(item));
  } else {
    const separator = { spaceDelimited: ' ', pipeDelimited: '|' }[style] ?? ',';
    query.append(name, scalarParts(value, false).join(separator));
  }
}

function pathParameter({ name, value, style = 'simple', explode = false }) {
  const isObject = typeof value === 'object' && !Array.isArray(value);
  const parts = isObject && explode
    ? Object.entries(value).map(([key, item]) => encodeURIComponent(key) + '=' + encodeURIComponent(item))
    : scalarParts(value, false).map(encodeURIComponent);
  if (style === 'label') return '.' + parts.join(explode ? '.' : ',');
  if (style === 'matrix') {
    if (explode && isObject) return ';' + parts.join(';');
    const prefix = ';' + encodeURIComponent(name) + '=';
    return prefix + parts.join(explode ? prefix : ',');
  }
  return parts.join(',');
}

/** Construct a same-origin request relative to the mounted application's PathBase. */
export function makeRequest(op, parameters, body, extraHeaders, basePath) {
  let path = op.path;
  const query = new URLSearchParams();
  const headers = new Headers(extraHeaders);
  for (const parameter of parameters) {
    const { name, value } = parameter;
    if (value === undefined || value === null || value === '') {
      if (parameter.required) throw new Error(name + ' is required');
      continue;
    }
    switch (parameter.in) {
      case 'path': path = path.replace('{' + name + '}', () => pathParameter(parameter)); break;
      case 'query': addQuery(query, parameter); break;
      case 'header': headers.set(name, scalarParts(value, parameter.explode).join(',')); break;
      case 'cookie': throw new Error('Cookie parameter ' + name + ' must be supplied by the browser session.');
    }
  }
  if (/\{[^}]+\}/.test(path)) throw new Error('Complete all path parameters.');
  if (!path.startsWith('/') || path.startsWith('//') || /[\\?#]/.test(path)) {
    throw new Error('The operation must have an application-relative path.');
  }
  const url = new URL(basePath + path.slice(1), location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith(basePath)) {
    throw new Error('The operation is outside the application path.');
  }
  url.search = query.toString();
  return { method: op.method, url: url.href, headers, body };
}

/** Resolve the same-origin wire request for execution or export, including rollback intent. */
export function transportRequest(request, preview, basePath, { observedSend = false } = {}) {
  const target = new URL(request.url);
  if (target.origin !== location.origin || !target.pathname.startsWith(basePath)) {
    throw new Error('The request is outside the application path.');
  }
  const headers = new Headers(request.headers);
  let url = target.href;
  if (preview) {
    url = new URL('./_preview/' + target.pathname.slice(basePath.length) + target.search, document.baseURI).href;
    headers.set('Prefer', 'tx=rollback');
  } else if (observedSend) {
    const preferences = (headers.get('Prefer') || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!preferences.some(value => /^trace(?:\s*;|$)/i.test(value))) preferences.push('trace');
    headers.set('Prefer', preferences.join(', '));
  }
  return { ...request, url, headers };
}

export class RequestTransportError extends Error {}

async function readTrace(id, signal) {
  if (!/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id || '')) return {};
  try {
    const url = new URL('./_api/traces/' + id, document.baseURI);
    const response = await fetch(url.href, { signal, credentials: 'include', redirect: 'error' });
    if (!response.ok) return {};
    const trace = await response.json();
    if (!trace || typeof trace !== 'object') return {};
    const evidence = { traceId: id };
    for (const name of ['changes', 'effects', 'logs']) {
      if (Array.isArray(trace[name])) evidence[name] = trace[name];
      if (trace[name + 'Truncated'] === true) evidence[name + 'Truncated'] = true;
    }
    if (trace.timing && typeof trace.timing === 'object') evidence.timing = trace.timing;
    return evidence;
  } catch (error) {
    if (signal?.aborted) throw error;
    // The original request may have committed. Optional trace loss never changes its outcome.
    return {};
  }
}

export async function execute(request, preview, basePath, signal, { observedSend = false } = {}) {
  const wireRequest = transportRequest(request, preview, basePath, { observedSend });
  const { url, method, headers, body: payload } = wireRequest;
  const started = performance.now();
  let response, raw;
  try {
    response = await fetch(url, {
      method, headers, body: payload, signal,
      credentials: 'include', redirect: 'error',
    });
    raw = await response.text();
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw error;
    const failure = new RequestTransportError(error.message, { cause: error });
    failure.wireRequest = wireRequest;
    throw failure;
  }
  let body = raw || null;
  if (raw) {
    try { body = JSON.parse(raw); } catch { /* Keep text responses as received. */ }
  }
  const duration = Math.round(performance.now() - started);
  const byteCount = value => new TextEncoder().encode(value).length;
  const metadata = {
    duration, wireRequest, requestUrl: request.url, requestHeaders: Object.fromEntries(headers),
    serverTiming: response.headers.get('Server-Timing') || undefined,
  };
  if (preview) {
    // The write guard stopped the Preview (spec/data-stores.md): a designed result, not an error.
    // Nothing ran to completion, so there are no captured changes, effects or logs to show.
    const blocked = blockedPreview(response.status, body);
    if (blocked) {
      return {
        status: response.status, headers: Object.fromEntries(response.headers), body, raw, blocked,
        changes: [], effects: [], logs: [], ...metadata, size: byteCount(raw), preview: true,
      };
    }
    if (!response.ok || body?.rolledBack !== true || !Number.isInteger(body.status)) {
      throw new Error('Preview was not acknowledged as rolled back (HTTP ' + response.status + '). ' + (body?.title || ''));
    }
    const type = Object.entries(body.headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
    const content = body.body == null ? '' :
      typeof body.body === 'string' && !/json/i.test(type) ? body.body : JSON.stringify(body.body);
    return { ...body, ...metadata, raw: content, size: byteCount(content), preview: true };
  }
  const trace = observedSend ? await readTrace(response.headers.get('X-Sendproof-Trace'), signal) : {};
  return {
    status: response.status, headers: Object.fromEntries(response.headers), body, raw,
    changes: [], effects: [], logs: [], ...trace, ...metadata, size: byteCount(raw), preview: false,
  };
}
