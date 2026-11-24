// Journeys mode's data (docs/plans/journeys.md, "Discovery"): the Arazzo documents and their
// expectations documents that capabilities list, read into journeys the workbench can show and
// run, plus the simple journeys inferred from OpenAPI `links` when an API publishes none. Pure:
// no DOM and no fetch (loading takes a `fetchJson`), so tests/ui and ui/*.test.mjs run it in Node.
import { bindStep } from './journeys/index.js';
import { opKey } from './operations.js';
import { dereference } from './api.js';
import { resolve } from './schema-model.js';

/** True when the workbench offers Journeys mode: the host lists journeys or holds Preview sessions. */
export const journeysEnabled = capabilities => (Array.isArray(capabilities?.journeys) && capabilities.journeys.length > 0) || capabilities?.previewSessions === true;

/** The operation an Arazzo step calls: an `operationId`, a `$sourceDescriptions.<name>.<id>` reference, or an `operationPath`. */
export function stepOperation(step, ops) {
  const id = String(step.operationId ?? '');
  if (id) {
    const bare = id.startsWith('$sourceDescriptions.') ? id.split('.').slice(2).join('.') : id;
    return ops.find(op => op.operation.operationId === bare) ?? null;
  }
  // operationPath: "{$sourceDescriptions.store.url}#/paths/~1orders~1{id}/get"
  const pointer = /#\/paths\/([^/]+)\/(\w+)$/.exec(String(step.operationPath ?? ''));
  if (pointer) {
    const path = pointer[1].replace(/~1/g, '/').replace(/~0/g, '~');
    return ops.find(op => op.path === path && op.method === pointer[2].toUpperCase()) ?? null;
  }
  return null;
}

/** "5 rows · 2 documents · 1 email": what a step's expectations say it writes, by kind. */
export function writeSummary(expected, sqlStore = 'sqlite') {
  const counts = { rows: 0, documents: 0, keys: 0, emails: 0, effects: 0 };
  for (const write of expected?.writes ?? []) {
    if (typeof write.key === 'string' || write.store === 'redis') counts.keys++;
    else if (write.collection !== undefined) counts.documents++;
    else if ((write.store ?? sqlStore) === sqlStore || write.table !== undefined) counts.rows++;
    else counts.documents++;
  }
  for (const effect of expected?.effects ?? []) {
    if (effect.kind === 'email') counts.emails++;
    else counts.effects++;
  }
  return counts;
}

/** Every value a step binds, classified without running it: `{ target, expression, from, stepId? }`. */
export function stepBindings(step) {
  try { return bindStep(step, { inputs: {}, steps: {} }).bound; } catch { return []; }
}

/** Fixed (literal) values a step sets in its body or parameters: targets with no expression. */
export function fixedValues(step) {
  const fixed = [];
  for (const parameter of step.parameters ?? []) {
    if (!(typeof parameter.value === 'string' && parameter.value.startsWith('$'))) fixed.push({ target: `${parameter.in}.${parameter.name}`, value: parameter.value });
  }
  const walk = (value, pointer) => {
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${pointer}/${index}`));
    else if (value !== null && typeof value === 'object') for (const [key, inner] of Object.entries(value)) walk(inner, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    else if (!(typeof value === 'string' && value.startsWith('$'))) fixed.push({ target: `body${pointer}`, value });
  };
  if (step.requestBody?.payload !== undefined) walk(step.requestBody.payload, '');
  return fixed;
}

/** For each journey input, the step numbers (from 1) that use it. */
export function inputUsage(journey) {
  const usage = {};
  journey.steps.forEach((step, index) => {
    const expressions = [...stepBindings(step.def).map(item => item.expression), ...JSON.stringify(step.expected ?? {}).match(/\$inputs\.[\w-]+/g) ?? []];
    for (const expression of expressions) {
      const match = /^\$inputs\.([\w-]+)/.exec(expression);
      if (!match) continue;
      usage[match[1]] ??= [];
      if (!usage[match[1]].includes(index + 1)) usage[match[1]].push(index + 1);
    }
  });
  return usage;
}

/** The schema a binding's target names on a step's operation: a parameter, or a spot in the JSON request body. */
function targetSchema(op, target, document) {
  const param = /^(path|query|header|cookie)\.(.+)$/.exec(target);
  if (param) {
    const parameter = (op.parameters ?? []).map(item => dereference(item, document)).find(item => item?.in === param[1] && item.name === param[2]);
    return parameter?.schema ? resolve(parameter.schema, document) : null;
  }
  const body = dereference(op.operation?.requestBody, document);
  const content = body?.content ?? {};
  let node = content['application/json']?.schema ?? Object.values(content)[0]?.schema;
  if (!node) return null;
  for (const token of target.replace(/^body\/?/, '').split('/').filter(Boolean).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    const schema = resolve(node, document);
    node = /^\d+$/.test(token) && schema.items ? schema.items : schema.properties?.[token];
    if (!node) return null;
  }
  return resolve(node, document);
}

/** What makes a field richer than plain text, and so is worth carrying to an input that feeds it. */
const RICH = ['enum', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'multipleOf'];

/**
 * The control keywords each journey input takes from the step fields it feeds, so an input bound to
 * a field with a lookup (x-lookup), an enum or a format is the same control as that field: the
 * customer picker for customerId, not a text box showing a UUID. The input keeps its own type,
 * description and default; the step's keywords only fill in what it lacks.
 */
export function inputControls(journey, document) {
  const controls = {};
  for (const step of journey.steps) {
    if (!step.op) continue;
    for (const binding of stepBindings(step.def)) {
      const name = /^\$inputs\.([\w-]+)$/.exec(binding.expression ?? '')?.[1];
      if (!name || controls[name]) continue;
      const schema = targetSchema(step.op, binding.target, document);
      if (!schema) continue;
      const picked = Object.fromEntries(Object.entries(schema).filter(([key]) => key.startsWith('x-') || RICH.includes(key)));
      if (Object.keys(picked).length) controls[name] = picked;
    }
  }
  return controls;
}

/** The criteria a step passes on: Arazzo successCriteria conditions, as written. */
export const criteriaOf = step => (step.def.successCriteria ?? []).map(criterion => criterion.condition).filter(Boolean);

/** The expected status a step's criteria name (`$statusCode == 201`), if any. */
export function expectedStatus(step) {
  for (const condition of criteriaOf(step)) {
    const match = /^\s*\$statusCode\s*==\s*(\d{3})\s*$/.exec(condition);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Whether a step's expectations hold Redis or another store Preview can't hold, or its operation is `preview: false`. */
function sendOnlyReasonOf(entry, steps, capabilities) {
  if (entry?.sendOnly) return entry.sendOnlyReason || '';
  const guarded = new Set((capabilities?.dataStores ?? []).filter(store => store.mode === 'guard').map(store => store.system));
  for (const step of steps) {
    for (const write of step.expected?.writes ?? []) if (write.store === 'redis' || guarded.has(write.store)) return `${step.stepId}: ${write.store}`;
  }
  return null;
}

/**
 * Reads one Arazzo document and its expectations into journeys. Each journey keeps the Arazzo
 * workflow as `def`, its expectations entry as `expect`, and per step the operation it calls.
 */
export function readJourneys({ source, arazzo, expectations, ops, capabilities }) {
  const workflows = Array.isArray(arazzo?.workflows) ? arazzo.workflows : [];
  return workflows.filter(workflow => workflow?.workflowId).map(workflow => {
    const entry = expectations?.journeys?.[workflow.workflowId] ?? {};
    const steps = (workflow.steps ?? []).map((def, index) => {
      const op = stepOperation(def, ops);
      return { stepId: def.stepId, index, def, op, opKey: op ? opKey(op) : null, expected: entry.steps?.[def.stepId] ?? null, runnable: !!op && !def.workflowId };
    });
    const sendOnlyReason = sendOnlyReasonOf(entry, steps, capabilities);
    return {
      id: workflow.workflowId, name: workflow.summary || workflow.workflowId, description: workflow.description || '',
      group: entry.group || source.name || 'Journeys', def: workflow, expect: entry, steps,
      inputs: workflow.inputs && typeof workflow.inputs === 'object' ? workflow.inputs : null,
      outputs: Object.keys(workflow.outputs ?? {}).length ? Object.keys(workflow.outputs) : [...new Set(steps.flatMap(step => Object.keys(step.def.outputs ?? {})))],
      runAs: entry.runAs || null, definedIn: entry.definedIn || null,
      sendOnly: sendOnlyReason !== null, sendOnlyReason: sendOnlyReason || '',
      source: source.source === 'file' ? 'file' : 'code', sourceName: source.name || '', arazzoUrl: source.arazzoUrl, expectationsUrl: source.expectationsUrl,
      expectations: expectations ?? { journeys: {}, approvedDifferences: [], ignore: [] },
      approved: (expectations?.approvedDifferences ?? []).filter(record => record.journey === workflow.workflowId),
      inferred: false,
    };
  });
}

/**
 * Simple journeys inferred from OpenAPI `links` (journeys.md, "Discovery"): a response link from
 * one operation to another becomes a two-step journey whose second step takes the first's
 * output. They carry no expectations.
 */
export function inferJourneys(document, ops) {
  const journeys = [];
  for (const op of ops) {
    for (const [status, rawResponse] of Object.entries(op.operation.responses ?? {})) {
      if (!/^2/.test(status)) continue;
      const response = rawResponse?.$ref ? resolveRef(document, rawResponse.$ref) : rawResponse;
      for (const [linkName, rawLink] of Object.entries(response?.links ?? {})) {
        const link = rawLink?.$ref ? resolveRef(document, rawLink.$ref) : rawLink;
        const target = link?.operationId ? ops.find(item => item.operation.operationId === link.operationId) : null;
        if (!target || !op.operation.operationId) continue;
        const outputs = {};
        const parameters = [];
        for (const [name, expression] of Object.entries(link.parameters ?? {})) {
          const [where, param] = name.includes('.') ? name.split('.', 2) : [target.parameters.find(p => p.name === name)?.in ?? 'path', name];
          if (typeof expression !== 'string' || !expression.startsWith('$response')) continue;
          outputs[param] = expression;
          parameters.push({ name: param, in: where, value: `$steps.first.outputs.${param}` });
        }
        const id = `${op.operation.operationId}→${linkName}`;
        const def = {
          workflowId: id, summary: `${op.title} → ${target.title}`, description: link.description || '',
          steps: [
            { stepId: 'first', operationId: op.operation.operationId, successCriteria: [{ condition: `$statusCode == ${status}` }], outputs },
            { stepId: 'second', operationId: target.operation.operationId, parameters, successCriteria: [{ condition: '$statusCode == 200' }] },
          ],
        };
        const steps = def.steps.map((step, index) => {
          const stepOp = index === 0 ? op : target;
          return { stepId: step.stepId, index, def: step, op: stepOp, opKey: opKey(stepOp), expected: null, runnable: true };
        });
        journeys.push({
          id, name: def.summary, description: def.description, group: '', def, expect: {}, steps, inputs: null, outputs: Object.keys(outputs),
          runAs: null, definedIn: null, sendOnly: false, sendOnlyReason: '', source: 'inferred', sourceName: '', arazzoUrl: null, expectationsUrl: null,
          expectations: { journeys: {}, approvedDifferences: [], ignore: [] }, approved: [], inferred: true,
        });
      }
    }
  }
  return journeys;
}

function resolveRef(document, ref) {
  if (!String(ref).startsWith('#/')) return undefined;
  return ref.slice(2).split('/').reduce((node, part) => node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], document);
}

/** Groups in the Arazzo documents' own order; the inferred ones last. Returns `[[name, journeys, inferred]]`. */
export function journeyGroups(journeys) {
  const groups = new Map();
  for (const journey of journeys.filter(item => !item.inferred)) {
    if (!groups.has(journey.group)) groups.set(journey.group, []);
    groups.get(journey.group).push(journey);
  }
  const result = [...groups].map(([name, items]) => [name, items, false]);
  const inferred = journeys.filter(item => item.inferred);
  if (inferred.length) result.push(['', inferred, true]);
  return result;
}

/**
 * Loads every journey the host lists. `fetchJson(url)` resolves to parsed JSON or throws. A
 * document that can't be read is reported in `problems` and leaves the others usable. Without
 * published journeys, the OpenAPI document's links give inferred ones.
 */
export async function loadJourneys({ capabilities, document, ops, fetchJson }) {
  const sources = Array.isArray(capabilities?.journeys) ? capabilities.journeys : [];
  const problems = [];
  const loaded = await Promise.all(sources.map(async source => {
    try {
      const [arazzo, expectations] = await Promise.all([fetchJson(source.arazzoUrl), source.expectationsUrl ? fetchJson(source.expectationsUrl) : null]);
      return { source, arazzo, expectations };
    } catch (error) {
      problems.push({ source, message: error.message });
      return null;
    }
  }));
  const published = loaded.filter(Boolean).flatMap(item => readJourneys({ ...item, ops, capabilities }));
  const ids = new Set(published.map(journey => journey.id));
  const inferred = inferJourneys(document, ops).filter(journey => !ids.has(journey.id));
  return { journeys: [...published, ...inferred], sources: loaded.filter(Boolean).map(item => item.source), problems };
}
