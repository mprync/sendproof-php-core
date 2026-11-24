// Arazzo 1.1 runtime expressions, over two vendored libraries (ui/vendor/, both Apache-2.0):
// @swaggerexpert/arazzo-runtime-expression parses, validates and extracts the expressions, and
// its interpolate() splices a resolved value into a template string; @swaggerexpert/json-pointer
// evaluates the "#/a/b" suffix on $request.body and $response.body. Neither library knows what a
// Sendproof run context looks like, so this module is only that: a resolver over their parsed
// trees, for $inputs, $steps.<id>.outputs, $response.body (with the pointer), $response.header,
// $statusCode, $request.* and $url/$method.
import { extract, interpolate as interpolateTemplate, parse, test as isRuntimeExpression } from '../vendor/arazzo-runtime-expression.js';
import { evaluate as evaluatePointer } from '../vendor/json-pointer.js';

function readPath(object, dottedPath) {
  let value = object;
  for (const key of dottedPath.split('.')) {
    if (value == null) return undefined;
    value = value[key];
  }
  return value;
}

function lookupHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

/** A pointer into a body that doesn't have that shape (missing, the wrong type, no such index)
 *  resolves to undefined, the same as any other expression with nothing to read: a step whose
 *  response is an unexpected error, say, shouldn't throw just because its outputs don't apply. */
function readPointer(body, pointer) {
  try { return evaluatePointer(body, pointer); } catch { return undefined; }
}

/** $request.* or $response.* : header, query, path or body (optionally with a JSON Pointer). */
function resolveMessage(message, reference) {
  switch (reference.type) {
    case 'HeaderReference': return lookupHeader(message?.headers, reference.token);
    case 'QueryReference': return message?.query?.[reference.name];
    case 'PathReference': return message?.path?.[reference.name];
    case 'BodyReference': {
      const body = message?.body;
      return reference.jsonPointer ? readPointer(body, reference.jsonPointer.value) : body;
    }
    default: return undefined;
  }
}

/** Resolves one parsed expression tree (the `tree` from the vendored parse()) against a run
 *  context: { inputs, steps: { [stepId]: { outputs } }, workflows, request, response }. */
function resolveTree(tree, context) {
  switch (tree.type) {
    case 'StatusCodeExpression': return context.response?.statusCode;
    case 'UrlExpression': return context.request?.url;
    case 'MethodExpression': return context.request?.method;
    case 'InputsExpression': return readPath(context.inputs, tree.name);
    case 'StepsExpression': return readPath(context.steps?.[tree.stepId]?.[tree.field], tree.outputName);
    case 'WorkflowsExpression': return readPath(context.workflows?.[tree.workflowId]?.[tree.field], tree.fieldName);
    case 'RequestExpression': return resolveMessage(context.request, tree.source.reference);
    case 'ResponseExpression': return resolveMessage(context.response, tree.source.reference);
    default: return undefined;
  }
}

/** A bare `$…` expression (as used for a whole parameter, body or matcher value): $inputs.x,
 *  $steps.id.outputs.x, $response.body#/ptr, $response.header.Name, $statusCode, $request.*.
 *  A value that isn't a runtime expression (doesn't start with "$") passes through unchanged. */
export function evaluate(expression, context = {}) {
  if (typeof expression !== 'string' || !expression.startsWith('$')) return expression;
  const { result, tree } = parse(expression);
  if (!result.success || !tree) throw new RangeError(`Not a runtime expression: ${expression}`);
  return resolveTree(tree, context);
}

const isWholeExpression = value => typeof value === 'string' && value.startsWith('$') && isRuntimeExpression(value);
const hasEmbeddedExpression = value => typeof value === 'string' && extract(value, { strict: false }).length > 0;

/**
 * Interpolates one value against a run context, deeply: a string that is itself a whole
 * expression (no surrounding braces) evaluates to its raw, possibly non-string, value; a
 * "{$expr}" span embedded in a longer string is substituted, stringified, in place; arrays and
 * plain objects are walked; everything else (including a plain literal string) passes through.
 */
export function interpolate(value, context = {}) {
  if (Array.isArray(value)) return value.map(item => interpolate(item, context));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, interpolate(inner, context)]));
  if (isWholeExpression(value)) return evaluate(value, context);
  if (hasEmbeddedExpression(value)) return interpolateTemplate(value, expression => evaluate(expression, context), { strict: false });
  return value;
}
