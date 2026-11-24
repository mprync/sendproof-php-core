// Comparing a step's captured writes and effects with its expectations (journeys.md, "Comparing
// and reporting"): nothing in Arazzo or a runtime-expression library knows about this, since it's
// entirely Sendproof's own companion-document format, so this module is all our own code. It
// resolves expected values (literals, runtime expressions, and the `type`/`pattern`/`from,to`
// matchers) with expressions.js, matches each expected write to a captured change by store,
// table or collection, op and key, applies approved differences, and produces one finding per
// expected write, extra change and expected effect.
import { evaluate, interpolate } from './expressions.js';

/** MongoDB changes arrive as Extended JSON ({ "$date": … }, { "$oid": … }, { "$numberLong": … });
 *  compare them as the plain values they stand for, so a date matches `date-time` and a number
 *  matches its literal. Anything else is returned as it is. */
function plainValue(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1) return value;
  const [name] = keys;
  const inner = value[name];
  if (name === '$date') {
    if (typeof inner === 'string') return inner;
    const millis = typeof inner === 'number' ? inner : Number(inner?.$numberLong);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : value;
  }
  if (name === '$oid' && typeof inner === 'string') return inner;
  if (['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'].includes(name) && typeof inner === 'string') {
    const number = Number(inner);
    return Number.isFinite(number) ? number : value;
  }
  return value;
}

const resolveScalar = (value, context) => (typeof value === 'string' && value.startsWith('$') ? evaluate(value, context) : value);

/** A raw expectation value as one of: a matcher ({type}, {pattern} or {from,to}), a runtime
 *  expression, or a literal. `from`/`to` and matcher fields are themselves literal-or-expression. */
function describeExpected(raw, context) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && ('type' in raw || 'pattern' in raw || 'from' in raw || 'to' in raw)) {
    if ('from' in raw || 'to' in raw) return { matcher: 'changed', from: resolveScalar(raw.from, context), to: resolveScalar(raw.to, context) };
    if ('pattern' in raw) return { matcher: 'pattern', pattern: raw.pattern };
    return { matcher: 'type', type: raw.type };
  }
  if (typeof raw === 'string' && raw.startsWith('$')) return { matcher: 'expression', expression: raw, value: evaluate(raw, context) };
  return { matcher: 'literal', value: raw };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function matchesType(type, actual) {
  switch (type) {
    case 'string': return typeof actual === 'string';
    case 'number': return typeof actual === 'number';
    case 'integer': return typeof actual === 'number' && Number.isInteger(actual);
    case 'boolean': return typeof actual === 'boolean';
    case 'uuid': return typeof actual === 'string' && UUID.test(actual);
    case 'date-time': return typeof actual === 'string' && DATE_TIME.test(actual) && !Number.isNaN(Date.parse(actual));
    case 'any': return actual !== undefined;
    default: return false;
  }
}

const looseEqual = (a, b) => a === b || (a != null && b != null && JSON.stringify(a) === JSON.stringify(b));

/** Whether `actual` (with `before`, for a "changed" matcher) satisfies a described expectation. */
function matches(descriptor, rawActual, rawBefore) {
  const actual = plainValue(rawActual);
  const before = plainValue(rawBefore);
  switch (descriptor.matcher) {
    case 'literal':
    case 'expression': return looseEqual(actual, descriptor.value);
    case 'type': return matchesType(descriptor.type, actual);
    case 'pattern': return typeof actual === 'string' && new RegExp(descriptor.pattern).test(actual);
    case 'changed': return looseEqual(before, descriptor.from) && looseEqual(actual, descriptor.to);
    default: return false;
  }
}

const displayExpected = descriptor => (descriptor.matcher === 'changed' ? { from: descriptor.from, to: descriptor.to }
  : descriptor.matcher === 'pattern' ? { pattern: descriptor.pattern } : descriptor.matcher === 'type' ? { type: descriptor.type }
  : descriptor.value);

/** The target an approved-difference record names: the store/table (and field, for a `value`
 *  difference); `kind` is `value`, `missing` or `extra`, matching the finding it covers. An
 *  expired record (per `clock`) covers nothing, whatever else matches. */
function findApproved(approved, target, kind, expected, actual, clock) {
  const now = clock();
  return approved.find(record => record.kind === kind
    // A record names its target the way the write does: a SQL table, a document collection or a key.
    && record.target?.store === target.store
    && (record.target?.table ?? record.target?.collection ?? record.target?.key) === target.table
    && (target.field === undefined || record.target?.field === target.field)
    && !(record.expires && new Date(record.expires) < now)
    && (record.expected === undefined || looseEqual(record.expected, expected))
    && (record.actual === undefined || looseEqual(record.actual, actual)));
}

/** The write's target name and, when it has one, its resolved row key. Redis-style writes name
 *  their target with a bare `key` string/expression instead of `table`/`collection`, and have no
 *  separate row key: the whole write is the one record at that key. */
function describeTarget(write, context) {
  // A key is often a template with embedded expressions ("quote:{$steps.priceCart.outputs.quoteId}").
  if (typeof write.key === 'string') return { target: interpolate(write.key, context), key: undefined };
  const target = write.table ?? write.collection;
  if (!write.key) return { target, key: undefined };
  return { target, key: Object.fromEntries(Object.entries(write.key).map(([field, value]) => [field, resolveScalar(value, context)])) };
}

/** Whether a `Db` log entry (`{ level: "Db", db: { system, operation, target } }`) is the command a
 *  write expects: the same store, the same operation (case-insensitive) and the same target (a
 *  Redis key, or a collection or table). */
function dbEntryMatches(entry, store, target, op) {
  const db = entry?.level === 'Db' ? entry.db : undefined;
  return !!db && db.system === store && String(db.operation ?? '').toLowerCase() === String(op ?? '').toLowerCase() && db.target === target;
}

const keyMatches =(resolvedKey, changeKey) => Object.entries(resolvedKey).every(([field, value]) => looseEqual(plainValue(changeKey?.[field]), value));

const findingId = (kind, index) => `${kind}:${index}`;

/** Compares one expected write against the change it matches, field by field, applying approved
 *  differences. `change` is null for a write nothing matched (a "missing" finding). */
function compareWrite(write, change, target, key, context, approved, clock, index) {
  const base = { store: write.store, target, op: write.op, key };
  if (!change) {
    const approvedRecord = findApproved(approved, { store: write.store, table: target }, 'missing', undefined, undefined, clock);
    return { id: findingId('missing', index), kind: approvedRecord ? 'approved' : 'missing', ...base, fields: [], record: approvedRecord?.id };
  }
  const fields = Object.entries(write.values ?? {}).map(([name, raw]) => {
    const descriptor = describeExpected(raw, context);
    const actual = change.after?.[name];
    const before = change.before?.[name];
    if (matches(descriptor, actual, before)) return { name, state: 'match', expected: displayExpected(descriptor), actual, source: descriptor.matcher };
    const approvedRecord = findApproved(approved, { store: write.store, table: target, field: name }, 'value', displayExpected(descriptor), actual, clock);
    if (approvedRecord) return { name, state: 'approved', expected: displayExpected(descriptor), actual, source: descriptor.matcher, record: approvedRecord.id };
    return { name, state: 'differs', expected: displayExpected(descriptor), actual, source: descriptor.matcher };
  });
  const bad = fields.filter(field => field.state === 'differs');
  const kind = bad.length ? 'differs' : fields.some(field => field.state === 'approved') ? 'approved' : 'match';
  return { id: findingId('write', index), kind, ...base, fields };
}

/** An effect's data field against an expectation: a list (an email's `to`, `cc`) matches a single
 *  expected value when one of its entries does, as hosts report recipients as arrays. */
function matchesEffectField(descriptor, actual) {
  if (matches(descriptor, actual)) return true;
  return Array.isArray(actual) && !Array.isArray(descriptor.value) && actual.some(item => matches(descriptor, item));
}

function compareEffect(expectedEffect, actualEffects, claimed, context, approved, clock, index) {
  const field = (effect, name) => effect.data?.[name] ?? effect[name];
  const toDescriptor = expectedEffect.to !== undefined ? describeExpected(expectedEffect.to, context) : undefined;
  const candidates = actualEffects.map((effect, position) => ({ effect, position })).filter(({ effect, position }) =>
    !claimed.has(position) && effect.kind === expectedEffect.kind && (!toDescriptor || matchesEffectField(toDescriptor, field(effect, 'to'))));
  const chosen = candidates[0];
  const base = { store: 'effect', target: expectedEffect.kind, op: 'send', key: undefined };
  if (!chosen) return { id: findingId('effect', index), kind: 'missing', ...base, fields: [] };
  claimed.add(chosen.position);
  const fields = Object.entries(expectedEffect).filter(([name]) => name !== 'kind').map(([name, raw]) => {
    const descriptor = describeExpected(raw, context);
    const actual = field(chosen.effect, name);
    if (matchesEffectField(descriptor, actual)) return { name, state: 'match', expected: displayExpected(descriptor), actual, source: descriptor.matcher };
    return { name, state: 'differs', expected: displayExpected(descriptor), actual, source: descriptor.matcher };
  });
  const kind = fields.some(f => f.state === 'differs') ? 'differs' : 'match';
  return { id: findingId('effect', index), kind, ...base, fields };
}

/**
 * Compares one step's captured `changes` and `effects` with its `expected` writes and effects
 * (journeys.md's expectations document, "writes" and "effects" arrays). `store` is the SQL
 * system id (e.g. "sqlite"): a captured change with no `store` field is that database. `ignore`
 * lists `{ store?, table }` pairs excused from `unlisted`. `logs` are the step's log entries: an
 * expected write no change matches is also matched against its `Db` entries (store, op, key). `clock` (default the real clock) ages
 * approved-difference records. Returns `{ verdict: 'passed' | 'passed-approved' | 'failed',
 * findings }`; a finding's `record`, when set, is the approved-difference id it used.
 */
export function compareStep({ expected = {}, changes = [], effects = [], logs = [], context = {}, approved = [], ignore = [], unlisted = 'fail', store, clock = () => new Date() } = {}) {
  const writes = expected.writes ?? [];
  const expectedEffects = expected.effects ?? [];
  const claimedChanges = new Set();
  const claimedLogs = new Set();
  const findings = [];

  writes.forEach((write, index) => {
    const { target, key } = describeTarget(write, context);
    const candidates = changes
      .map((change, position) => ({ change, position }))
      .filter(({ change, position }) => !claimedChanges.has(position)
        && (change.store ?? store) === write.store && change.table === target && change.operation === write.op);
    const chosen = key ? candidates.find(({ change }) => keyMatches(key, change.key)) : candidates[0];
    if (chosen) claimedChanges.add(chosen.position);
    // A traced Send records data-store commands only as Db log entries (spec/data-stores.md): no
    // change matched, so look for the command itself. The log carries no values, so a command
    // match checks the store, target and operation only.
    const logged = chosen ? undefined : logs
      .map((entry, position) => ({ entry, position }))
      .find(({ entry, position }) => !claimedLogs.has(position) && dbEntryMatches(entry, write.store, target, write.op));
    if (logged) {
      claimedLogs.add(logged.position);
      findings.push({ id: findingId('write', index), kind: 'match', store: write.store, target, op: write.op, key, fields: [], via: 'log' });
      return;
    }
    findings.push(compareWrite(write, chosen?.change ?? null, target, key, context, approved, clock, index));
  });

  changes.forEach((change, position) => {
    if (claimedChanges.has(position)) return;
    const effectiveStore = change.store ?? store;
    if (ignore.some(rule => (rule.store ?? store) === effectiveStore && rule.table === change.table)) return;
    if (unlisted !== 'fail') return;
    const approvedRecord = findApproved(approved, { store: effectiveStore, table: change.table }, 'extra', undefined, undefined, clock);
    findings.push({
      id: findingId('extra', position), kind: approvedRecord ? 'approved' : 'extra',
      store: effectiveStore, target: change.table, op: change.operation, key: change.key, fields: [], record: approvedRecord?.id,
    });
  });

  const claimedEffects = new Set();
  expectedEffects.forEach((expectedEffect, index) => findings.push(compareEffect(expectedEffect, effects, claimedEffects, context, approved, clock, index)));

  const bad = findings.some(finding => finding.kind === 'differs' || finding.kind === 'missing' || finding.kind === 'extra');
  const hasApproved = findings.some(finding => finding.kind === 'approved' || finding.fields.some(field => field.state === 'approved'));
  const verdict = bad ? 'failed' : hasApproved ? 'passed-approved' : 'passed';
  return { verdict, findings };
}
