// Binding a step's request from its Arazzo `parameters` and `requestBody`, checking its
// `successCriteria` and reading its `outputs`. Runtime-expression resolution is expressions.js;
// the "simple" success-criteria comparator grammar (`==`, `&&`, …) has no published library (the
// swaggerexpert and jsonpath-rfc9535 packages parse runtime expressions and JSONPath, not this
// small boolean grammar Arazzo defines for successCriteria), so it's hand-written here. The
// `jsonpath` criterion type uses the vendored jsonpath-rfc9535 (RFC 9535, Apache-2.0); `xpath`
// has no vendored library and always reports unmet, since the APIs this engine targets are JSON.
import { evaluate, interpolate } from './expressions.js';
import { query as jsonpathQuery } from '../vendor/jsonpath-rfc9535.js';

const escapePointer = token => String(token).replace(/~/g, '~0').replace(/\//g, '~1');

function classifyBinding(expression) {
  if (typeof expression !== 'string' || !expression.startsWith('$')) return { from: 'fixed' };
  if (expression === '$inputs' || expression.startsWith('$inputs.')) return { from: 'input' };
  const stepMatch = /^\$steps\.([^.]+)\./.exec(expression);
  if (stepMatch) return { from: 'step', stepId: stepMatch[1] };
  return { from: 'fixed' };
}

/** Interpolates a request-body value, recording a bound entry for every leaf that is itself a
 *  whole expression (an embedded "{$expr}" inside a literal string isn't separately tracked). */
function bindBody(value, context, pointer, bound) {
  if (Array.isArray(value)) return value.map((item, index) => bindBody(item, context, `${pointer}/${index}`, bound));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, bindBody(inner, context, `${pointer}/${escapePointer(key)}`, bound)]));
  }
  if (typeof value === 'string' && value.startsWith('$')) {
    const resolved = evaluate(value, context);
    bound.push({ target: `body${pointer}`, expression: value, value: resolved, ...classifyBinding(value) });
    return resolved;
  }
  return interpolate(value, context);
}

/**
 * Binds one Arazzo step's `parameters` and `requestBody` against a run context, following any
 * `requestBody.replacements`. Returns { path, query, headers, body, bound }, where `bound` lists
 * every value that came from an input or an earlier step's output, for the "From step 1 · x" UI.
 */
export function bindStep(step, context = {}) {
  const path = {}, query = {}, headers = {};
  const bound = [];
  for (const parameter of step.parameters ?? []) {
    const value = interpolate(parameter.value, context);
    const target = { path, query, header: headers, cookie: headers }[parameter.in];
    if (target) target[parameter.name] = value;
    if (typeof parameter.value === 'string' && parameter.value.startsWith('$')) {
      bound.push({ target: `${parameter.in}.${parameter.name}`, expression: parameter.value, value, ...classifyBinding(parameter.value) });
    }
  }
  let body;
  if (step.requestBody) {
    body = bindBody(step.requestBody.payload, context, '', bound);
    for (const replacement of step.requestBody.replacements ?? []) {
      const value = interpolate(replacement.value, context);
      body = writePointer(body, replacement.target, value);
      if (typeof replacement.value === 'string' && replacement.value.startsWith('$')) {
        bound.push({ target: `body${replacement.target}`, expression: replacement.value, value, ...classifyBinding(replacement.value) });
      }
    }
  }
  return { path, query, headers, body, bound };
}

/** Sets the value at an RFC 6901 JSON Pointer inside `root`, cloning only the path it walks. */
function writePointer(root, pointer, value) {
  const tokens = pointer.split('/').slice(1).map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (tokens.length === 0) return value;
  const clone = Array.isArray(root) ? [...root] : { ...root };
  let node = clone;
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = tokens[i];
    const next = node[key];
    node[key] = Array.isArray(next) ? [...next] : { ...next };
    node = node[key];
  }
  node[tokens[tokens.length - 1]] = value;
  return clone;
}

const looseEqual = (a, b) => a === b || (a != null && b != null && JSON.stringify(a) === JSON.stringify(b));

function parseOperand(token, response) {
  const trimmed = token.trim();
  if (trimmed.startsWith('$')) return evaluate(trimmed, { response });
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1);
  return trimmed;
}

const COMPARISON = /^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/;

/** Splits on a top-level "&&" or "||", ignoring one inside a quoted operand. */
function splitTop(text, token) {
  const parts = [];
  let quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (text.startsWith(token, i)) { parts.push(text.slice(start, i)); i += token.length - 1; start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

function evaluateSimple(condition, response) {
  const orParts = splitTop(condition, '||');
  if (orParts.length > 1) {
    const results = orParts.map(part => evaluateSimple(part, response));
    return { passed: results.some(result => result.passed), actual: results.map(result => result.actual) };
  }
  const andParts = splitTop(condition, '&&');
  if (andParts.length > 1) {
    const results = andParts.map(part => evaluateSimple(part, response));
    return { passed: results.every(result => result.passed), actual: results.map(result => result.actual) };
  }
  const match = COMPARISON.exec(condition.trim());
  if (!match) { const value = parseOperand(condition.trim(), response); return { passed: Boolean(value), actual: value }; }
  const [, leftToken, operator, rightToken] = match;
  const left = parseOperand(leftToken, response);
  const right = parseOperand(rightToken, response);
  const passed = operator === '==' ? looseEqual(left, right)
    : operator === '!=' ? !looseEqual(left, right)
    : operator === '<' ? left < right : operator === '<=' ? left <= right
    : operator === '>' ? left > right : left >= right;
  return { passed, actual: left };
}

/** Checks each Arazzo `successCriteria` entry against a step's response. `type` defaults to
 *  "simple" (the `==`/`!=`/`<`/`<=`/`>`/`>=`/`&&`/`||` grammar); "jsonpath" and "regex" apply the
 *  condition to `context` (a runtime expression, default "$response.body"); "xpath" always fails,
 *  unsupported. Returns [{ condition, passed, actual }]. */
export function checkCriteria(criteria = [], response) {
  return criteria.map(criterion => {
    const type = criterion.type ?? 'simple';
    if (type === 'simple') {
      const { passed, actual } = evaluateSimple(criterion.condition, response);
      return { condition: criterion.condition, passed, actual };
    }
    const data = criterion.context ? evaluate(criterion.context, { response }) : response?.body;
    if (type === 'jsonpath') {
      const result = jsonpathQuery(data, criterion.condition);
      return { condition: criterion.condition, passed: Array.isArray(result) && result.length > 0, actual: result };
    }
    if (type === 'regex') {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      return { condition: criterion.condition, passed: new RegExp(criterion.condition).test(text), actual: text };
    }
    return { condition: criterion.condition, passed: false, actual: undefined };
  });
}

/** Reads a step's Arazzo `outputs` (each value a runtime expression over its own response). */
export function stepOutputs(step, response) {
  const outputs = {};
  for (const [name, expression] of Object.entries(step.outputs ?? {})) outputs[name] = evaluate(expression, { response });
  return outputs;
}
