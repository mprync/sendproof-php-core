import { operations as discoverOperations } from './api.js';
import { validateSchema } from './fields/validate.js';
import { createReferenceResolver } from './fields/validation-references.js';
import { t } from './i18n.js';

// Server-Timing metrics the workbench names itself: [label key, colour]. Any other metric
// keeps the name the API sent.
const knownTimings = new Map([
  ['auth', ['resp.timing.auth', 'var(--text-3)']],
  ['handler', ['resp.timing.handler', 'var(--accent)']],
  ['db', ['resp.timing.db', 'var(--ok)']],
  ['serialize', ['resp.timing.serialize', 'var(--warn)']],
]);

function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) ?? undefined;
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function timingMetric(name, duration, description) {
  const known = knownTimings.get(name.toLowerCase());
  const [label, color] = known ? [t(known[0]), known[1]] : [name, 'var(--text-3)'];
  return { label, color, duration, description };
}

/** Split HTTP list fields without treating punctuation in a quoted description as a separator. */
function splitTiming(value, separator) {
  const parts = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted && char === '\\') index++;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && char === separator) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/** Prefer measured Server-Timing metrics, falling back to the preview or trace durations. */
export function responseTimings(result) {
  const fields = splitTiming(result.serverTiming ?? header(result.headers, 'Server-Timing') ?? '', ',');
  const timings = fields.flatMap(field => {
    const [name, ...parameters] = splitTiming(field, ';').map(part => part.trim());
    if (!name || !/^[!#$%&'*+.^_`|~\w-]+$/.test(name)) return [];
    const values = new Map();
    for (const parameter of parameters) {
      const match = /^([^=\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s"]+))$/.exec(parameter);
      if (!match || values.has(match[1].toLowerCase())) continue;
      values.set(match[1].toLowerCase(), match[2]?.replace(/\\(.)/g, '$1') ?? match[3]);
    }
    const duration = values.get('dur');
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(duration ?? '') || !Number.isFinite(Number(duration))) return [];
    return [timingMetric(name, Number(duration), values.get('desc'))];
  });
  if (timings.length) return timings;
  const trace = result.timing;
  return [...knownTimings.keys()].flatMap(name => {
    const duration = trace?.[name];
    const count = trace?.queryCount;
    const description = name === 'db' && Number.isInteger(count) && count >= 0
      ? t('resp.queries', { n: count }) : undefined;
    return Number.isFinite(duration) && duration >= 0 ? [timingMetric(name, duration, description)] : [];
  });
}

function resolveComponent(value, document) {
  const resolve = createReferenceResolver(document);
  const visited = new Set();
  while (value?.$ref) {
    if (visited.has(value)) return;
    visited.add(value);
    value = resolve(value.$ref);
  }
  return value;
}

/** Select the response documented for the wire status and content type. */
export function responseDefinition(result, { document, operation }) {
  const responses = operation?.operation?.responses;
  const status = String(result.status ?? '');
  return resolveComponent(responses?.[status] ?? responses?.[status[0] + 'XX'] ?? responses?.default, document);
}

/** The response's media type without parameters, lowercased; empty when none was sent. */
export function responseMediaType(result) {
  return header(result.headers, 'Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
}

/** Whether the body matches its documented schema, as { name, matches }; undefined when it can't be told. */
export function responseSchema(result, context, definition, body) {
  const content = definition?.content;
  if (!content || body === undefined) return;
  const type = responseMediaType(result);
  const available = Object.keys(content);
  const candidate = type
    ? [type, type.split('/')[0] + '/*', '*/*'].find(key => available.some(media => media.toLowerCase() === key))
    : available.length === 1 ? available[0].toLowerCase() : undefined;
  const schema = content[available.find(media => media.toLowerCase() === candidate)]?.schema;
  if (schema === undefined) return;

  const resolve = createReferenceResolver(context.document, schema);
  const target = schema?.$ref ? resolve(schema.$ref) : schema;
  if (target === undefined) return;
  const unresolvedReferences = new Set();
  const errors = validateSchema({ document: context.document, parseErrors: new Map(), response: true, unresolvedReferences }, schema, body, true);
  if (unresolvedReferences.size) return;
  const name = schema?.title || target?.title || schema?.$ref?.split('/').at(-1)?.replace(/~1/g, '/').replace(/~0/g, '~') || t('resp.schemaFallback');
  const extra = undocumented(body, target, resolve);
  // A required property the body left out reads as a fact about the response, not a form prompt.
  const missing = path => { const parts = String(path).split('.'); const parent = parts.slice(0, -1).reduce((node, key) => node?.[key], body); return parts.length && parent && typeof parent === 'object' && !Object.hasOwn(parent, parts.at(-1)); };
  const issues = [...errors.map(({ path, message }) => ({ path, message: path && missing(path) ? t('match.missing') : message })), ...extra.map(item => ({ path: item.name, message: t('match.extra', { model: name }), extra: true }))];
  return {
    name, matches: issues.length === 0, raw: schema, issues, extra, properties: countProperties(target, resolve),
    ref: schema?.$ref?.startsWith('#/components/schemas/') ? decodeURIComponent(schema.$ref.split('/').at(-1)) : '',
  };
}

/** Properties a body returned at its top level that the (object) schema doesn't declare. */
function undocumented(body, schema, resolve) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !schema?.properties || schema.additionalProperties === true) return [];
  const declared = new Set(Object.keys(schema.properties));
  for (const part of schema.allOf || []) for (const key of Object.keys((part.$ref ? resolve(part.$ref) : part)?.properties || {})) declared.add(key);
  return Object.keys(body).filter(key => !declared.has(key)).map(name => ({ name, value: body[name] }));
}

/** How many properties a schema documents, counting one level into objects and list items. */
function countProperties(schema, resolve, depth = 0) {
  const target = schema?.$ref ? resolve(schema.$ref) : schema;
  if (!target || depth > 2) return 0;
  const props = Object.values(target.properties || {});
  return props.length + props.reduce((sum, child) => {
    const inner = child?.$ref ? resolve(child.$ref) : child;
    const items = inner?.items?.$ref ? resolve(inner.items.$ref) : inner?.items;
    return sum + (inner?.properties ? countProperties(inner, resolve, depth + 1) : items?.properties ? countProperties(items, resolve, depth + 1) : 0);
  }, 0);
}

function pointerPath(pointer) {
  if (pointer === '') return [];
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return;
  return pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function pointerValue(value, path) {
  return path?.reduce((item, key) => item !== null && typeof item === 'object' && Object.hasOwn(item, key) ? item[key] : undefined, value);
}

function parseUrl(value, base) {
  try { return value ? new URL(value, base) : undefined; }
  catch { return undefined; }
}

const pathParts = path => path.replace(/\/$/, '').split('/').slice(1);
const pathKey = part => /^\{([^{}]+)\}$/.exec(part)?.[1];
const supplied = value => value !== undefined && value !== null && value !== '';
const scalar = value => supplied(value) && ['string', 'number', 'boolean'].includes(typeof value);
const pathNames = path => [...path.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);

function matchPath(operation, path) {
  if (!path) return;
  const template = pathParts(operation.path);
  const actual = pathParts(path);
  if (template.length !== actual.length) return;
  const values = Object.create(null);
  for (const [index, part] of template.entries()) {
    const names = pathNames(part);
    try {
      if (!names.length) {
        if (decodeURIComponent(part) !== decodeURIComponent(actual[index])) return;
        continue;
      }
      const pattern = part.split(/\{[^{}]+\}/).map(literal => literal.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')).join('(.+?)');
      const matched = new RegExp('^' + pattern + '$').exec(actual[index]);
      if (!matched) return;
      names.forEach((name, i) => { values[name] = decodeURIComponent(matched[i + 1]); });
    } catch {
      return;
    }
  }
  return values;
}

function operationPath(url, basePath = '/') {
  const mount = basePath.endsWith('/') ? basePath : basePath + '/';
  return url?.pathname.startsWith(mount) ? '/' + url.pathname.slice(mount.length) : undefined;
}

function runtimeExpression(expression, result, context, body, requestUrl, requestPath) {
  if (expression === '$url') return { value: result.requestUrl };
  if (expression === '$method') return { value: context.operation.method };
  if (expression === '$statusCode') return { value: result.status === undefined ? undefined : String(result.status) };
  const responseBody = /^\$response\.body(?:#(.*))?$/.exec(expression);
  if (responseBody) {
    const path = pointerPath(responseBody[1] ?? '');
    return { value: pointerValue(body, path), path };
  }
  if (expression.startsWith('$response.header.')) {
    return { value: header(result.headers, expression.slice('$response.header.'.length)) };
  }
  const requestBody = /^\$request\.body(?:#(.*))?$/.exec(expression);
  if (requestBody && typeof result.wireRequest?.body === 'string') {
    const raw = result.wireRequest.body;
    const type = header(result.requestHeaders, 'Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
    const path = pointerPath(requestBody[1] ?? '');
    if (!(type.endsWith('/json') || type.endsWith('+json'))) return { value: pointerValue(raw, path) };
    try { return { value: pointerValue(JSON.parse(raw), path) }; }
    catch { return { value: undefined }; }
  }
  const request = /^\$request\.(path|query|header)\.(.+)$/.exec(expression);
  if (request && context.operation.parameters?.some(parameter => parameter.in === request[1] &&
    (request[1] === 'header' ? parameter.name.toLowerCase() === request[2].toLowerCase() : parameter.name === request[2]))) {
    const [, location, name] = request;
    if (location === 'path') return { value: requestPath?.[name] };
    if (location === 'header') return { value: header(result.requestHeaders, name) };
    const values = requestUrl?.searchParams.getAll(name) ?? [];
    return { value: values.length > 1 ? values : values[0] };
  }
  return { value: undefined };
}

function resolveParameter(value, result, context, body, requestUrl, requestPath) {
  if (typeof value !== 'string') return { value };
  const evaluate = expression => runtimeExpression(expression, result, context, body, requestUrl, requestPath);
  if (/^\$(?:url$|method$|statusCode$|request\.|response\.)/.test(value)) return evaluate(value);
  const paths = [];
  let complete = true;
  const interpolated = value.replace(/\{(\$[^{}]+)\}/g, (_, expression) => {
    const { value, path } = evaluate(expression);
    if (value === undefined) complete = false;
    if (path) paths.push(path);
    return value;
  });
  return { value: complete ? interpolated : undefined, path: paths.length === 1 ? paths[0] : undefined };
}

function linkOperation(link, operations, document) {
  if (typeof link?.operationRef === 'string' && link.operationRef.startsWith('#/')) {
    const target = createReferenceResolver(document)(link.operationRef);
    // A Path Item can be a reference, so the discovered path and method are also checked.
    let parts;
    try { parts = pointerPath(decodeURIComponent(link.operationRef.slice(1))); }
    catch { return; }
    if (parts?.length === 3 && parts[0] === 'paths') {
      return operations.find(operation => operation.path === parts[1] && operation.method.toLowerCase() === parts[2]);
    }
    return operations.find(operation => operation.operation === target);
  }
  if (link?.operationId) return operations.find(operation => operation.operation?.operationId === link.operationId);
}

function findParameter(operation, key) {
  const parameters = operation.parameters ?? [];
  const qualified = /^(path|query|header|cookie)[.:](.+)$/.exec(key);
  if (qualified) return parameters.find(parameter => parameter.in === qualified[1] && parameter.name === qualified[2]);
  const matches = parameters.filter(parameter => parameter.name === key);
  return matches.length === 1 ? matches[0] : undefined;
}

function missingPathParams(operation, values) {
  return pathNames(operation.path).filter(key => !supplied(values['path:' + key]));
}

function documentedFollowUps(definition, result, context, operations, body, requestUrl, requestPath) {
  return Object.entries(definition?.links ?? {}).flatMap(([name, raw]) => {
    const link = resolveComponent(raw, context.document);
    const operation = linkOperation(link, operations, context.document);
    if (!operation) return [];
    const values = {};
    const paths = [];
    for (const [key, expression] of Object.entries(link.parameters ?? {})) {
      const parameter = findParameter(operation, key);
      if (!parameter || parameter.in === 'cookie') continue;
      const { value, path } = resolveParameter(expression, result, context, body, requestUrl, requestPath);
      if (!supplied(value)) continue;
      values[parameter.in + ':' + parameter.name] = value;
      if (path) paths.push(path);
    }
    return missingPathParams(operation, values).length ? [] : [{ name, operation, values, paths }];
  });
}

function isRelated(source, target) {
  const from = pathParts(source.path);
  const to = pathParts(target.path);
  return to.length >= from.length && from.every((part, index) =>
    pathKey(part) ? Boolean(pathKey(to[index])) : part === to[index]
  ) && (to.length === from.length || Boolean(pathKey(to[from.length])));
}

function inferredFollowUp(operation, source, body, requestPath, locationPath, locationUrl) {
  if (operation.path === source.path && operation.method === source.method) return;
  const fromLocation = matchPath(operation, locationPath);
  if (!fromLocation && !isRelated(source, operation)) return;
  const targetParts = pathParts(operation.path);
  const sourceParts = pathParts(source.path);
  const values = {};
  const paths = [];
  const pending = [];
  for (const [index, part] of targetParts.entries()) {
    for (const key of pathNames(part)) {
      const exact = pointerValue(body, [key]);
      const carried = requestPath?.[pathKey(sourceParts[index]) ?? ''] ?? requestPath?.[key];
      const value = fromLocation?.[key] ?? carried ?? exact;
      if (scalar(value)) {
        values['path:' + key] = value;
        if (scalar(exact) && String(value) === String(exact)) paths.push([key]);
        else if (fromLocation && key !== 'id' && String(value) === String(pointerValue(body, ['id']))) paths.push(['id']);
      } else {
        pending.push(key);
      }
    }
  }
  const id = pointerValue(body, ['id']);
  if (pending.length === 1 && scalar(id) && !paths.some(path => path[0] === 'id')) {
    values['path:' + pending.pop()] = id;
    paths.push(['id']);
  }
  if (fromLocation) {
    for (const { in: where, name } of operation.parameters ?? []) {
      if (where !== 'query') continue;
      const entries = locationUrl.searchParams.getAll(name);
      if (entries.length) values['query:' + name] = entries.length === 1 ? entries[0] : entries;
    }
  }
  if (pending.length || (!paths.length && !Object.keys(values).length && !fromLocation)) return;
  return { operation, values, paths };
}

/** Open documented operations with values from this result or its original URL. */
export function responseFollowUps(result, context, definition, body) {
  const source = context.operation;
  if (!source || typeof context.onFollowUp !== 'function') return [];
  const operations = context.operations ?? discoverOperations(context.document ?? {});
  const requestUrl = parseUrl(result.requestUrl, globalThis.location?.origin);
  const requestPath = matchPath(source, operationPath(requestUrl, context.basePath));
  const explicit = documentedFollowUps(definition, result, context, operations, body, requestUrl, requestPath);
  if (!(result.status >= 200 && result.status < 300)) return explicit;

  const origin = requestUrl?.origin ?? globalThis.location?.origin;
  const location = parseUrl(header(result.headers, 'Location'), requestUrl ?? origin);
  const locationPath = origin && location?.origin === origin ? operationPath(location, context.basePath) : undefined;
  const handled = new Set(explicit.map(item => item.operation));
  const inferred = operations.flatMap(operation => {
    if (handled.has(operation)) return [];
    const item = inferredFollowUp(operation, source, body, requestPath, locationPath, location);
    return item ? [item] : [];
  });
  return [...explicit, ...inferred];
}
