// What the Journeys dialogs (dialog.js, journeys-dialogs.js) say, read from the real run and the
// journey's expectations, never made up. Pure: no DOM, so ui/journeys-dialog-model.test.mjs runs it
// in Node. Every number here is a count of something the run or the expectations really hold.
import { evaluate } from './journeys/expressions.js';
import { securityRequirements } from './security.js';
import { sqlSystem, storeKind } from './stores.js';

/** The place a write goes, as the store names it: a table, a collection or a key. */
const placeOf = write => write.table ?? write.collection ?? (typeof write.key === 'string' ? write.key : undefined);

const normal = system => String(system ?? '').trim().toLowerCase();

/** A recipient written as a literal or as `$inputs.x`; anything the run can't resolve yet is left out. */
function recipient(raw, inputs) {
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('$')) return raw;
  try {
    const value = evaluate(raw, { inputs: inputs ?? {}, steps: {} });
    return typeof value === 'string' && value ? value : null;
  } catch { return null; }
}

/**
 * What a Send of `journey` keeps, per store, from its steps' expected writes and effects:
 * `[{ system, kind, database?, records, places: [names] }]` for stores, then
 * `{ system: 'email', emails, recipients }` and `{ system: 'effect', effect: kind, count }`.
 * `records` counts expected writes (a row, a document or a key each), so it is what the run would
 * commit, not a guess. A store with no written place named (Redis keys) lists none.
 */
export function sendTargets(journey, capabilities = {}, { inputs } = {}) {
  const sql = sqlSystem(capabilities);
  const database = typeof capabilities.database === 'string' ? capabilities.database : capabilities.database?.name;
  const stores = new Map();
  const emails = { system: 'email', emails: 0, recipients: [] };
  const effects = new Map();
  for (const step of journey?.steps ?? []) {
    for (const write of step.expected?.writes ?? []) {
      const system = write.store ? normal(write.store) : sql;
      const entry = stores.get(system) ?? { system, kind: storeKind(system), records: 0, places: [], ...(system === sql && database ? { database } : {}) };
      entry.records++;
      const place = placeOf(write);
      if (place && entry.kind !== 'key' && !entry.places.includes(place)) entry.places.push(place);
      stores.set(system, entry);
    }
    for (const effect of step.expected?.effects ?? []) {
      if (effect.kind === 'email') {
        emails.emails++;
        const to = recipient(effect.to, inputs);
        if (to && !emails.recipients.includes(to)) emails.recipients.push(to);
      } else effects.set(effect.kind, (effects.get(effect.kind) ?? 0) + 1);
    }
  }
  return [...stores.values(), ...(emails.emails ? [emails] : []), ...[...effects].map(([effect, count]) => ({ system: 'effect', effect, count }))];
}

/** What one step's recorded changes and effects hold, by store: `{ stores: [{ system, count }], emails, effects }`. */
export function heldBy(envelope, sqlStore = 'sql') {
  const stores = new Map();
  for (const change of envelope?.changes ?? []) {
    const system = normal(change.store) || sqlStore;
    stores.set(system, (stores.get(system) ?? 0) + 1);
  }
  const all = envelope?.effects ?? [];
  const emails = all.filter(effect => effect.kind === 'email').length;
  const kinds = new Map();
  for (const effect of all) if (effect.kind !== 'email') kinds.set(String(effect.kind || ''), (kinds.get(String(effect.kind || '')) ?? 0) + 1);
  return { stores: [...stores].map(([system, count]) => ({ system, count })), emails, effects: all.length - emails, kinds: [...kinds].map(([kind, count]) => ({ kind, count })) };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The fields a person would name a record by, best first. */
const KEY_FIELDS = ['number', 'code', 'sku', 'email', 'name', 'title', 'reference', 'slug'];
const lowered = row => Object.fromEntries(Object.entries(row && typeof row === 'object' ? row : {}).map(([key, value]) => [key.toLowerCase(), value]));
/** A short, readable value: a string or number, not an ID, no longer than a line. */
const human = value => (typeof value === 'string' || typeof value === 'number') && !GUID.test(String(value)) && String(value).length <= 40 ? String(value) : '';

/** An ID cut to its first eight characters ("4ef4416e…") when it is a GUID or long; a short ID stays whole. */
export const shortId = id => {
  const text = String(id ?? '');
  return GUID.test(text) || text.length > 14 ? `${text.slice(0, 8)}…` : text;
};

/**
 * What a recorded change is called: the first business key its row has (Number, Code, Sku, Email,
 * Name, Title…), else a short ID. Never a full GUID and never a status. `{ ref, field }`; `field`
 * is the row's own field name when a business key was used.
 */
export function changeRef(change) {
  const row = lowered(change?.after ?? change?.before);
  for (const field of KEY_FIELDS) {
    const value = human(row[field]);
    if (value) return { ref: value, field };
  }
  const id = Object.values(change?.key ?? {})[0] ?? row.id ?? row._id;
  return { ref: id == null || id === '' ? '' : shortId(id), field: null };
}

/**
 * What to call the record an ID points at, from the changes a run recorded: the business key of the
 * change whose own key is that ID (an order's Number), else of a change that holds it, else a short ID.
 */
export function refForId(changes, id) {
  if (id == null || id === '') return '';
  const wanted = String(id).toLowerCase();
  const holds = values => Object.values(values && typeof values === 'object' ? values : {}).some(value => String(value).toLowerCase() === wanted);
  const hit = changes.find(change => holds(change.key)) ?? changes.find(change => holds(change.after ?? change.before));
  return (hit ? changeRef(hit).ref : '') || shortId(id);
}

/**
 * One or two telling facts about a change, never the field used as its name: the status ("Pending"),
 * the SKU, a quantity. `{ kind: 'text', value }` or `{ kind: 'units', n }`, for the caller to word.
 */
export function changeFacts(change, usedField = null) {
  const row = lowered(change?.after ?? change?.before);
  const facts = [];
  const status = human(row.status);
  if (status) facts.push({ kind: 'text', value: status.charAt(0).toUpperCase() + status.slice(1) });
  const sku = human(row.sku);
  if (sku && usedField !== 'sku') facts.push({ kind: 'text', value: sku });
  const quantity = row.quantity ?? row.qty ?? row.units;
  if (typeof quantity === 'number' && Number.isFinite(quantity)) facts.push({ kind: 'units', n: quantity });
  return facts.slice(0, 2);
}

/**
 * Where the changes beyond the first few went, grouped for one line: the tables (SQL and item
 * stores), a count of collections per other store, emails and other effects. Items are
 * `{ store, target }`; an email effect has `store: 'effect'` and `target: 'email'`.
 */
export function moreIn(items) {
  const tables = new Set();
  const collections = new Map();
  let emails = 0, effects = 0;
  for (const item of items) {
    if (item.store === 'effect') { if (item.target === 'email') emails++; else effects++; continue; }
    const kind = storeKind(item.store);
    if (kind === 'sql' || kind === 'item') tables.add(String(item.target ?? ''));
    else {
      if (!collections.has(item.store)) collections.set(item.store, new Set());
      collections.get(item.store).add(String(item.target ?? ''));
    }
  }
  return { tables: [...tables], stores: [...collections].map(([system, set]) => ({ system, count: set.size })), emails, effects };
}

/** Whether a held or sent step left nothing: no changes and no effects (it only read). */
export const readsOnly = held => !held.stores.length && !held.emails && !held.effects;

/** The roles a persona entry names: `roles` (a list) or `role` (one), as the personas source sends them. */
export const personaRoles = user => (Array.isArray(user?.roles) ? user.roles : user?.role ? [user.role] : []).map(String).filter(Boolean);

/**
 * Which of a journey's steps a persona may call, when the OpenAPI document says so: an operation's
 * security alternatives name the roles (scopes) that may call it, so a step is allowed when the
 * operation needs no role or one alternative's roles are all the persona's. Resolves to
 * `{ allowed: boolean[], refused: number[] }`, or null when it can't be known (the persona has no
 * known role, or no step's operation names a role), so callers show nothing rather than guess.
 */
export function stepAccess(journey, roles, document) {
  const mine = new Set((roles ?? []).map(role => String(role).toLowerCase()));
  if (!mine.size) return null;
  let known = false;
  const allowed = (journey?.steps ?? []).map(step => {
    const alternatives = step.op ? securityRequirements(step.op, document).map(alternative => alternative.flatMap(item => item.scopes)) : [];
    if (!alternatives.length || alternatives.some(scopes => !scopes.length)) return true;
    known = true;
    return alternatives.some(scopes => scopes.every(scope => mine.has(String(scope).toLowerCase())));
  });
  if (!known) return null;
  return { allowed, refused: allowed.flatMap((ok, index) => ok ? [] : [index]) };
}
