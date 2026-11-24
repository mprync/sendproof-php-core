// Code the workbench drafts for an author to commit (journeys.md, "Approved differences" and
// "Writing them, and running them"). The workbench never approves or writes a file: it copies
// text. Pure, so it's tested in Node.
//
//  - Draft approved difference: the C# ApprovedDifference<T> object for a journey defined in code
//    (Sendproof.Journeys relaxes one value with it), or the JSON record for a journey read from a
//    file, ready for the expectations document.
//  - Copy as C#: a Preview's actual writes as an ExpectWrites block, with values that came from
//    the journey's inputs or an earlier step's outputs written as the refs that hold them.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const csString = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
const pascal = name => String(name).replace(/^_+/, '').replace(/(^|[_\s-])([a-z0-9])/gi, (match, separator, letter) => letter.toUpperCase());
const camel = name => { const text = pascal(name); return text.charAt(0).toLowerCase() + text.slice(1); };
const isoDay = date => date.toISOString().slice(0, 10);
const addDays = (date, days) => new Date(date.getTime() + days * 86_400_000);

/** The C# type and literal for a captured value, as an ApprovedDifference<T> or a Set() value needs it. */
export function csharpValue(value) {
  if (value === null || value === undefined) return { type: 'string?', literal: 'null' };
  if (typeof value === 'boolean') return { type: 'bool', literal: String(value) };
  if (typeof value === 'number') return Number.isInteger(value) ? { type: 'int', literal: String(value) } : { type: 'decimal', literal: `${value}m` };
  if (typeof value === 'string' && UUID.test(value)) return { type: 'Guid', literal: `Guid.Parse(${csString(value)})` };
  if (typeof value === 'string' && DATE_TIME.test(value)) return { type: 'DateTimeOffset', literal: `DateTimeOffset.Parse(${csString(value)})` };
  if (typeof value === 'string') return { type: 'string', literal: csString(value) };
  return { type: 'string', literal: csString(JSON.stringify(value)) };
}

/** A C# identifier for a record: "Shipments.Carrier" → ShipmentsCarrierChanged. */
const recordName = (target, field) => `${pascal(target)}${field ? pascal(field) : ''}Changed`.replace(/[^\w]/g, '');

/**
 * A draft approved-difference record for one finding (and, for a `differs` finding, one field).
 * Returns `{ language: 'csharp' | 'json', text }`. A journey defined in code gets the C# object
 * when the difference is a value (that's what ApprovedDifference<T> relaxes); missing and extra
 * writes, and file journeys, get the JSON record.
 */
export function draftApprovedDifference({ journey, stepId, finding, field, approvedBy = '', today = new Date(), days = 90, sqlStore = 'sqlite' }) {
  const kind = field ? 'value' : finding.kind === 'extra' ? 'extra' : 'missing';
  const store = finding.store === 'sql' ? sqlStore : finding.store;
  const approvedOn = isoDay(today);
  const expires = isoDay(addDays(today, days));
  const reason = 'Why this difference is acceptable, and when the expectation will change.';
  if (journey.source === 'code' && kind === 'value') {
    const { type, literal } = csharpValue(field.actual);
    const [y, m, d] = approvedOn.split('-').map(Number);
    const [ey, em, ed] = expires.split('-').map(Number);
    const name = recordName(finding.target, field.name);
    const owner = journey.definedIn?.type ? `${journey.definedIn.type.replace(/Journey$/, '')}ApprovedDifferences` : 'ApprovedDifferences';
    return {
      language: 'csharp',
      text: [
        `// Pass it to the expectation it relaxes: .Set(r => r.${pascal(field.name)}, <expected>, ${owner}.${name})`,
        `public static readonly ApprovedDifference<${type}> ${name} = new()`,
        '{',
        '    Id = "AD-0000",',
        `    Actual = ${literal},`,
        `    Reason = ${csString(reason)},`,
        `    ApprovedBy = ${csString(approvedBy)},`,
        `    ApprovedOn = new DateOnly(${y}, ${m}, ${d}),`,
        `    Expires = new DateOnly(${ey}, ${em}, ${ed}),`,
        '    Link = "",',
        '};',
      ].join('\n'),
    };
  }
  const record = {
    id: 'AD-0000', journey: journey.id, step: stepId,
    target: { store, [finding.store === 'mongodb' || finding.target?.includes?.(':') ? 'collection' : 'table']: finding.target, ...(field ? { field: field.name } : {}) },
    kind,
    ...(field ? { expected: field.expected, actual: field.actual } : {}),
    reason, approvedBy, approvedOn, expires, link: '',
  };
  // The engine matches records by target.table for every store; keep `table` so the record covers the finding.
  if (record.target.collection !== undefined) { record.target.table = record.target.collection; delete record.target.collection; }
  return { language: 'json', text: JSON.stringify(record, null, 2) };
}

/**
 * The refs a step can use: each journey input and each earlier step's output, with the value it
 * held in this run, so a written value equal to one is written as that ref. Returns
 * `[{ name, value, code, expression }]`; longer values first, so an ID beats a coincidental 1.
 */
export function refsFor(journey, run, stepIndex) {
  const refs = [];
  for (const [name, value] of Object.entries(run?.inputs ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    refs.push({ name: camel(name), value, code: `journey.Input(i => i.${pascal(name)})`, expression: `$inputs.${name}` });
  }
  (run?.steps ?? []).slice(0, stepIndex + 1).forEach(step => {
    for (const [name, value] of Object.entries(step.outputs ?? {})) {
      if (value === undefined || value === null) continue;
      refs.push({ name: camel(name), value, code: camel(name), expression: `$steps.${step.stepId}.outputs.${name}` });
    }
  });
  return refs.filter(ref => typeof ref.value !== 'boolean' && String(ref.value).length > 1)
    .sort((a, b) => String(b.value).length - String(a.value).length);
}

/** MongoDB Extended JSON ({ "$date": … }, { "$oid": … }, { "$numberLong": … }) as the plain value it stands for. */
function plain(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && ['$oid', '$numberLong', '$numberInt', '$numberDecimal', '$numberDouble', '$uuid'].includes(keys[0])) return keys[0] === '$oid' || keys[0] === '$uuid' ? value[keys[0]] : Number(value[keys[0]]);
    if (keys.length === 1 && keys[0] === '$date') return { date: true };
  }
  return value;
}
const nested = value => value !== null && typeof value === 'object' && !value.date;

function valueCode(raw, refs) {
  const value = plain(raw);
  if (value?.date) return { code: 'Match.Any<DateTime>()' };
  const ref = refs.find(item => item.value === value || (typeof value === 'string' && String(item.value) === value));
  if (ref) return { code: ref.code, note: ref.expression };
  if (typeof value === 'string' && DATE_TIME.test(value)) return { code: 'Match.Any<DateTimeOffset>()' };
  return { code: csharpValue(value).literal };
}

const lambda = (table, prefix) => (prefix || String(table).charAt(0).toLowerCase() || 'r').replace(/[^a-z]/g, 'r');

/**
 * A Preview's changes and effects as an ExpectWrites block. `changes` and `effects` are the
 * envelope's; `refs` come from refsFor(); `sqlStore` is the capabilities' SQL system id and
 * `stepVariable` the step's C# variable (its stepId).
 */
export function expectWritesCode({ changes = [], effects = [], refs = [], stepVariable = 'step', dbContext = 'AppDbContext' }) {
  const lines = [`${stepVariable}.ExpectWrites(writes =>`, '{'];
  const sql = changes.filter(change => !change.store);
  const documents = changes.filter(change => change.store === 'mongodb');
  const others = changes.filter(change => change.store && change.store !== 'mongodb');
  const set = (indent, letter, name, value) => {
    const { code, note } = valueCode(value, refs);
    return `${indent}.Set(${letter} => ${letter}.${pascal(name)}, ${code})${note ? ` // ${note}` : ''}`;
  };
  const body = (change, indent, letter, keyFields) => {
    const out = [];
    for (const [name, value] of Object.entries(change.key ?? {})) {
      if (change.operation !== 'insert') out.push(`${indent}.Where(${letter} => ${letter}.${pascal(name)}, ${valueCode(value, refs).code})`);
    }
    if (change.operation === 'update') {
      for (const [name, rawAfter] of Object.entries(change.after ?? {})) {
        const before = plain(change.before?.[name]);
        const after = plain(rawAfter);
        // Nested documents and lists are left for the author: a field-by-field Set can't say them.
        if (JSON.stringify(change.before?.[name]) === JSON.stringify(rawAfter) || keyFields.has(name) || nested(after)) continue;
        out.push(after?.date || (typeof after === 'string' && DATE_TIME.test(after))
          ? `${indent}.Set(${letter} => ${letter}.${pascal(name)}, ${after?.date ? 'Match.Any<DateTime>()' : 'Match.Any<DateTimeOffset>()'})`
          : `${indent}.Set(${letter} => ${letter}.${pascal(name)}, Match.Changed(${csharpValue(before).literal}, ${valueCode(after, refs).code}))`);
      }
    } else if (change.operation === 'insert') {
      for (const [name, raw] of Object.entries(change.after ?? {})) {
        const value = plain(raw);
        if (value === null || value === undefined || nested(value)) continue;
        // A new row's own generated key isn't known in advance; its other values are.
        if (keyFields.has(name) && !refs.some(ref => ref.value === value)) continue;
        out.push(set(indent, letter, name, value));
      }
    }
    // The statement ends before its trailing comment: `.Set(s => s.OrderId, orderId); // $steps…`.
    if (out.length) { const last = out.length - 1; const at = out[last].indexOf(' // '); out[last] = at < 0 ? out[last] + ';' : out[last].slice(0, at) + ';' + out[last].slice(at); }
    else out.push(`${indent};`);
    return out;
  };
  if (sql.length) {
    lines.push(`    var sql = writes.Sql<${dbContext}>();`);
    for (const change of sql) {
      const verb = { insert: 'Insert', update: 'Update', delete: 'Delete' }[change.operation] ?? 'Update';
      const letter = lambda(change.table);
      lines.push('', `    sql.${verb}(db => db.${pascal(change.table)})`, ...body(change, '        ', letter, new Set(Object.keys(change.key ?? {}))));
    }
  }
  if (documents.length) {
    lines.push('', '    var mongo = writes.Mongo();');
    for (const change of documents) {
      const verb = { insert: 'Insert', update: 'Update', delete: 'Delete' }[change.operation] ?? 'Update';
      const type = `${pascal(String(change.table).replace(/s$/, ''))}Document`;
      lines.push('', `    mongo.${verb}<${type}>() // collection ${change.table}`, ...body(change, '        ', 'd', new Set(Object.keys(change.key ?? {}))));
    }
  }
  for (const change of others) lines.push('', `    // ${change.store}: ${change.operation} ${change.table}`);
  for (const effect of effects) {
    if (effect.kind === 'email') {
      const to = Array.isArray(effect.data?.to) ? effect.data.to[0] : effect.data?.to;
      lines.push('', `    writes.Email()${to !== undefined ? `\n        .To(${valueCode(to, refs).code})` : ''}${effect.data?.subject ? `\n        .Subject(${csString(effect.data.subject)})` : ''};`);
    } else lines.push('', `    // ${effect.kind}: ${effect.description ?? ''}`.trimEnd());
  }
  if (!changes.length && !effects.length) lines.push('    writes.Nothing();');
  lines.push('});');
  return lines.join('\n');
}
