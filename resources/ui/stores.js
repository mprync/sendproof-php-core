// Data stores (spec/data-stores.md): what each store is called, what it calls its parts, its mark,
// and what discovery says about it. Every view that names a store goes through here, so the store's
// name always sits beside its mark as text and no meaning depends on the logo (mock v6-icons.js).
import { esc, icon } from './components.js';
import { formatList, t } from './i18n.js';
import { MARKS } from './store-marks.js';

/**
 * Known stores by `system` id (capabilities `dataStores[].system`, change `store`, log `db.system`).
 * `kind` picks the nouns: sql (table, row), document (collection, document), item (table, item),
 * key (key prefix, key), index (index, document) and container (container, item).
 */
export const STORES = {
  sqlite: { name: 'SQLite', kind: 'sql' },
  postgresql: { name: 'PostgreSQL', kind: 'sql' },
  mysql: { name: 'MySQL', kind: 'sql' },
  mariadb: { name: 'MariaDB', kind: 'sql' },
  sqlserver: { name: 'SQL Server', kind: 'sql' },
  mongodb: { name: 'MongoDB', kind: 'document' },
  redis: { name: 'Redis', kind: 'key' },
  dynamodb: { name: 'DynamoDB', kind: 'item' },
  cassandra: { name: 'Cassandra', kind: 'sql' },
  elasticsearch: { name: 'Elasticsearch', kind: 'index' },
  opensearch: { name: 'OpenSearch', kind: 'index' },
  cosmosdb: { name: 'Cosmos DB', kind: 'container' },
  firestore: { name: 'Firestore', kind: 'document' },
};

/** The id the binding's own SQL database goes by: changes and logs without a store are SQL. */
export const SQL = 'sql';

// OpenTelemetry's db.system.name values that differ from Sendproof's ids (data-stores.md).
const ALIASES = { 'aws.dynamodb': 'dynamodb', 'azure.cosmosdb': 'cosmosdb', mssql: 'sqlserver', postgres: 'postgresql' };
const normal = system => {
  const id = String(system ?? '').trim().toLowerCase();
  return ALIASES[id] ?? id;
};

/** Whether an id can name the binding's SQL database: a known SQL provider, or one Sendproof has no mark for (oracle…). A document or key-value id is a binding mistake. */
const isSqlProvider = id => !!id && id !== SQL && (STORES[id] ? STORES[id].kind === 'sql' && id !== 'cassandra' : true);

/**
 * The SQL provider behind `capabilities.database`. A binding that reports `database.system` (the
 * provider id: sqlite, postgresql, mysql, mariadb, mssql…) is believed. Older bindings send only
 * the database's display name, so a file name ending in .db, .sqlite or .sqlite3 is guessed to be
 * a SQLite file; anything else is shown as a generic "SQL database".
 */
export function sqlSystem(capabilities = {}) {
  const database = capabilities.database;
  const reported = normal(typeof database === 'object' ? database?.system : '');
  if (isSqlProvider(reported)) return reported;
  const name = typeof database === 'string' ? database : database?.name;
  return /\.(db|sqlite3?)$/i.test(name || '') ? 'sqlite' : SQL;
}

/** A store's display name. Unknown ids are shown as the binding sent them. */
export function storeName(system) {
  const id = normal(system);
  if (id === SQL) return t('store.sql');
  return STORES[id]?.name ?? String(system ?? '');
}

/** The noun family for a store: sql, document, item, key, index or container. */
export const storeKind = system => STORES[normal(system)]?.kind ?? (normal(system) === SQL ? 'sql' : 'document');

/** "Collection", "Table", "Key prefix"…: what the store calls the place a record lives. */
export const containerNoun = system => t('store.container.' + storeKind(system));

/** "3 documents", "2 rows", "1 key": a record count in the store's own words. */
export const recordCount = (system, n) => t('store.count.' + storeKind(system), { n });

/**
 * The store's mark as inline SVG at 14, 16, 20 or 28 px. Stores without a usable mark (and ids
 * Sendproof doesn't know) get the generic store glyph at the same size, so layouts never change.
 */
export function storeMark(system, size = 14) {
  const id = normal(system);
  const mark = MARKS[id];
  if (!mark) return `<span class="mk mk-${size} mk-other" aria-hidden="true">${icon('db', true)}</span>`;
  return `<svg class="mk mk-${size} mk-${id}" viewBox="${mark.box}" aria-hidden="true" focusable="false">${mark.body}</svg>`;
}

/** The mark followed by the name: the one way a store is labelled inline. */
export const storeLabel = (system, size = 14) =>
  `<span class="store-label">${storeMark(system, size)}<span>${esc(storeName(system))}</span></span>`;

/** The hooked stores from discovery, normalised: [{ system, name, mode, reason }]. */
export function dataStores(capabilities = {}) {
  return (Array.isArray(capabilities.dataStores) ? capabilities.dataStores : [])
    .filter(store => store && typeof store.system === 'string')
    .map(store => ({ system: normal(store.system), name: typeof store.name === 'string' ? store.name : '', mode: store.mode === 'preview' ? 'preview' : 'guard', reason: typeof store.reason === 'string' ? store.reason : '' }));
}

/** The discovery entry for one store, if it is hooked. */
export const dataStore = (capabilities, system) => dataStores(capabilities).find(store => store.system === normal(system));

/**
 * The `previewUnavailable` entry for an operation (an API author marked it `preview: false`), or
 * undefined. Read-only methods never Preview anyway, so they never match.
 */
export function previewUnavailable(op, capabilities = {}) {
  if (!op) return undefined;
  const entry = (Array.isArray(capabilities.previewUnavailable) ? capabilities.previewUnavailable : [])
    .find(item => item && String(item.method).toUpperCase() === op.method && item.path === op.path);
  if (!entry) return undefined;
  return { reason: authorReason(entry.reason), stores: (Array.isArray(entry.stores) ? entry.stores : []).map(normal) };
}

/**
 * An author's reason without a leading "Preview unavailable:", which the UI already says in its
 * own words: "Preview unavailable: this operation writes to Redis" reads "This operation writes to Redis".
 */
export function authorReason(reason) {
  const text = String(reason ?? '').replace(/^\s*preview unavailable\s*[:·–-]\s*/i, '').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

/** "Redis", "Redis and DynamoDB": store names as a list in this locale. */
export const storeNames = systems => formatList([...new Set(systems)].map(storeName));

/**
 * The 409 body of a Preview the write guard stopped (spec/preview-unavailable.schema.json), or
 * undefined for any other response. Only `code` decides; the title is protocol text.
 */
export function blockedPreview(status, body) {
  if (status !== 409 || !body || typeof body !== 'object' || body.code !== 'preview_unavailable') return undefined;
  return {
    detail: String(body.detail ?? ''), store: normal(body.store), operation: String(body.operation ?? ''),
    title: String(body.title ?? ''), type: body.type,
  };
}
