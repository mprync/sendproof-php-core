import { formatNumber, t } from "./i18n.js";
import { newUuid } from "./uuid.js";

/** HTTP header names use the RFC 9110 token grammar. */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const variablePattern = /\{\{\s*([^{}]*?)\s*\}\}/g;
const sampleUuid = "00000000-0000-4000-8000-000000000000";
let nextHeaderId = 1;

/** Create a stable, editable custom-header row. */
export function createHeaderRow(name = "", value = "", enabled = true) {
  return { id: `custom-header-${nextHeaderId++}`, name: String(name), value: String(value), enabled };
}

function objectRows(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return [];
  return Object.entries(value).map(([name, headerValue]) => createHeaderRow(name, headerValue));
}

/** Normalize the persisted value, including the old JSON-object representation. */
export function normalizeHeaderRows(value) {
  if (typeof value === "string") {
    if (!value.trim()) return [];
    try {
      return objectRows(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    for (const row of value) {
      const serial = Number(/^custom-header-(\d+)$/.exec(row?.id)?.[1]);
      if (Number.isSafeInteger(serial) && serial < Number.MAX_SAFE_INTEGER) {
        nextHeaderId = Math.max(nextHeaderId, serial + 1);
      }
    }
    if (value.every((row) => row && typeof row.id === "string" && typeof row.name === "string" && typeof row.value === "string")) return value;
    return value.map((row) => ({
      id: row?.id || `custom-header-${nextHeaderId++}`,
      name: String(row?.name ?? ""),
      value: String(row?.value ?? ""),
      enabled: row?.enabled !== false,
    }));
  }
  return objectRows(value);
}

function error(row, message, field = "name") {
  return { id: row.id, field, message };
}

/** Share the token syntax between the display, validation, and request preparation. */
export function headerVariables(value) {
  return [...String(value ?? "").matchAll(variablePattern)];
}

function resolveHeaderValue(value, { uuid, now, lastId }) {
  return value.replace(variablePattern, (_, name) => {
    if (name === "now") return now;
    if (name === "uuid") {
      const id = uuid();
      if (id) return id;
      throw new Error(t("kv.err.uuidUnavailable", { token: "{{uuid}}" }));
    }
    if (name === "last.id") {
      if ((typeof lastId === "string" && lastId.trim()) || Number.isFinite(lastId)) return String(lastId);
      throw new Error(t("kv.err.lastId", { token: "{{last.id}}" }));
    }
    throw new Error(t("kv.err.unknownVariable", { name: `{{${name}}}`, uuid: "{{uuid}}", now: "{{now}}", last: "{{last.id}}" }));
  });
}

/**
 * Validate and resolve enabled rows together. By default, inspection uses a
 * representative UUID so typing and live validation leave the draft intact.
 */
export function inspectHeaderRows(rows, { uuid = () => sampleUuid, now = new Date().toISOString(), lastId } = {}) {
  const errors = [];
  const names = new Map();
  const enabled = [];
  for (const row of rows) {
    if (row?.enabled === false) continue;
    const name = String(row?.name ?? "").trim();
    const rawValue = String(row?.value ?? "");
    let value = rawValue;
    if (!name) {
      errors.push(error(row, t("kv.err.nameRequired")));
      continue;
    }
    if (!HEADER_NAME_PATTERN.test(name)) {
      const fixed = headerNameFix(name);
      errors.push(error(row, fixed ? t("kv.err.nameSpaces", { fixed }) : t("kv.err.nameToken")));
    }
    try {
      value = resolveHeaderValue(value, { uuid, now, lastId });
    } catch (failure) {
      errors.push(error(row, failure.message, "value"));
    }
    if (/[\r\n]/.test(rawValue) || /[\r\n]/.test(value)) {
      errors.push(error(row, t("kv.err.lineBreak"), "value"));
    } else if (/[\x00-\x08\x0a-\x1f\x7f\u0100-\uffff]/.test(value)) {
      errors.push(error(row, t("kv.err.valueChars"), "value"));
    }
    const key = name.toLowerCase();
    const first = names.get(key);
    if (first) {
      errors.push(error(row, t("kv.err.duplicate", { first })));
    } else {
      names.set(key, name);
    }
    enabled.push({ ...row, name, value });
  }
  return { valid: errors.length === 0, errors, rows: enabled };
}

/** Validate the active header set against HTTP syntax and variable availability. */
export function validateHeaderRows(rows, context) {
  const { valid, errors } = inspectHeaderRows(rows, context);
  return { valid, errors };
}

export function headerNameFix(name) {
  const fixed = name.trim().replace(/\s+/g, "-");
  return fixed !== name.trim() && HEADER_NAME_PATTERN.test(fixed) ? fixed : undefined;
}

/** Keep values edited in the headers view compatible with declared schemas. */
export function coerceHeaderValue(value, schema = {}) {
  const text = String(value ?? "");
  if (!text) return undefined;
  if (schema.enum) {
    const match = schema.enum.find((choice) => String(choice) === text);
    if (match !== undefined) return match;
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((item) => item !== "null")
    : schema.type;
  if (type === "integer" || type === "number") {
    const number = Number(text);
    return Number.isNaN(number) ? text : number;
  }
  if (type === "boolean") {
    if (text === "true") return true;
    if (text === "false") return false;
  }
  if (type === "object" || type === "array") {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

/** Convert validated custom rows to the object accepted by the request API. */
export function headerRowsToObject(rows, context) {
  const validation = inspectHeaderRows(rows, { uuid: newUuid, ...context });
  if (!validation.valid) {
    const error = new Error(validation.errors.map(({ message }) => message).join("\n"));
    error.validation = true;
    error.headerErrors = validation.errors;
    throw error;
  }
  return Object.fromEntries(validation.rows.map(({ name, value }) => [name, value]));
}

/** Retain disabled rows in bulk edit with a reversible comment prefix. */
export function formatHeaderLines(rows) {
  return rows.map(row => `${row.enabled === false ? "# " : ""}${row.name}: ${row.value}`).join("\n");
}

export function parseHeaderLines(text, previous = []) {
  const rows = [];
  const errors = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const enabled = !line.startsWith("# ");
    const entry = enabled ? line : line.slice(2);
    const colon = entry.indexOf(":");
    if (colon === -1) {
      errors.push(t("kv.err.noColon", { n: formatNumber(index + 1) }));
      continue;
    }
    const name = entry.slice(0, colon).trim();
    const value = entry.slice(colon + 1).replace(/^ /, "");
    const id = previous[rows.length]?.id ?? createHeaderRow().id;
    rows.push({ id, name, value, enabled });
  }
  return { rows, errors };
}
