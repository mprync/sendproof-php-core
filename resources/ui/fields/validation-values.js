import { formatList, t } from '../i18n.js';
import { formatError } from './validation-formats.js';

export const isFile = value => typeof Blob !== 'undefined' && value instanceof Blob;
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !isFile(value);
export const isNumber = value => typeof value === 'number' && Number.isFinite(value);

const typeChecks = new Map([
  ['null', value => value === null],
  ['boolean', value => typeof value === 'boolean'],
  ['object', isObject],
  ['array', Array.isArray],
  ['number', isNumber],
  ['integer', Number.isInteger],
  ['string', (value, schema) => typeof value === 'string' || (schema.format === 'binary' && isFile(value))],
]);

// Messages live in ui/locales/en-capture.js as valid.type.<type>.
const typeMessages = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

/** The message for a value of the wrong type, or undefined when its type fits the schema. */
export function typeError(schema, value, allowNullable) {
  if (schema.type === undefined) return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null && allowNullable && schema.nullable === true && typeof schema.type === 'string') return;
  if (types.some(type => !typeChecks.has(type) || typeChecks.get(type)(value, schema))) return;
  if (value === null) return t('valid.type.nullValue');
  if (schema.format === 'binary' && types.includes('string') && types.length === 1) return t('valid.type.file');
  return types.length === 1 && typeMessages.has(types[0])
    ? t('valid.type.' + types[0])
    : t('valid.type.oneOf', { types: formatList(types, 'unit') });
}

export function compilePattern(pattern) {
  if (typeof pattern !== 'string') return;
  try {
    return new RegExp(pattern, 'u');
  } catch {
    // A malformed schema pattern cannot give the user a reliable constraint.
    return undefined;
  }
}

export function displayValue(value) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 48 ? text.slice(0, 47) + '…' : text;
}

/** Produce comparable keys for JSON values, with File identity preserved for uploads. */
export function createValueKey() {
  const files = new WeakMap();
  let nextFile = 0;

  function key(value) {
    if (isFile(value)) {
      if (!files.has(value)) files.set(value, ++nextFile);
      return 'file:' + files.get(value);
    }
    if (Array.isArray(value)) return '[' + Array.from(value, key).join(',') + ']';
    if (isObject(value)) {
      return '{' + Object.keys(value).sort().map(name =>
        JSON.stringify(name) + ':' + key(value[name])).join(',') + '}';
    }
    // JSON.stringify treats both positive and negative zero as the same number.
    return JSON.stringify(value) ?? 'undefined';
  }

  return key;
}

function decimalParts(value) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  return [BigInt(whole + fraction), +exponent - fraction.length];
}

function isMultipleOf(value, step) {
  // Use the decimal representation sent in JSON to avoid floating-point remainder artifacts.
  const [coefficient, scale] = decimalParts(value);
  const [divisor, divisorScale] = decimalParts(step);
  const commonScale = Math.min(scale, divisorScale);
  return coefficient * 10n ** BigInt(scale - commonScale) %
    (divisor * 10n ** BigInt(divisorScale - commonScale)) === 0n;
}

/**
 * Reports a count outside its bounds. `unit` is 'property', 'item', 'character' or 'contains'
 * and picks the plural message valid.atLeast.<unit> / valid.atMost.<unit>; `vars` fills extra
 * placeholders such as {expected}.
 */
export function validateRange(value, minimum, maximum, unit, add, vars = {}) {
  if (typeof minimum === 'number' && value < minimum) add(t('valid.atLeast.' + unit, { ...vars, n: minimum }));
  if (typeof maximum === 'number' && value > maximum) add(t('valid.atMost.' + unit, { ...vars, n: maximum }));
}

/** Checks a number against minimum, maximum, multipleOf and the integer and float formats. */
export function validateNumber(schema, value, add) {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema;
  // Bounds come from the spec and are shown as written, so the user can type exactly that.
  if (typeof minimum === 'number' && (value < minimum || (exclusiveMinimum === true && value === minimum))) {
    add(t(exclusiveMinimum === true ? 'valid.number.greaterThan' : 'valid.number.atLeast', { n: minimum }));
  }
  if (typeof maximum === 'number' && (value > maximum || (exclusiveMaximum === true && value === maximum))) {
    add(t(exclusiveMaximum === true ? 'valid.number.lessThan' : 'valid.number.atMost', { n: maximum }));
  }
  if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) add(t('valid.number.greaterThan', { n: exclusiveMinimum }));
  if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) add(t('valid.number.lessThan', { n: exclusiveMaximum }));
  if (isNumber(multipleOf) && multipleOf > 0 && !isMultipleOf(value, multipleOf)) {
    add(t('valid.number.multipleOf', { n: multipleOf }));
  }
  if (schema.format === 'int32' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
    add(t('valid.number.int32'));
  }
  if (schema.format === 'int64' && (!Number.isInteger(value) || BigInt(value) < -(2n ** 63n) || BigInt(value) >= 2n ** 63n)) {
    add(t('valid.number.int64'));
  }
  if (schema.format === 'float' && !Number.isFinite(Math.fround(value))) add(t('valid.number.float'));
}

/** Checks a string's length, format and pattern. */
export function validateString(schema, value, add) {
  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    validateRange([...value].length, schema.minLength, schema.maxLength, 'character', add, { current: [...value].length });
  }
  const message = formatError(schema.format, value);
  if (message) add(message);
  const pattern = compilePattern(schema.pattern);
  if (!message && pattern && !pattern.test(value)) {
    const decimal = ['decimal', 'double', 'float'].includes(schema.format) ||
      (Array.isArray(schema.type) && schema.type.includes('number')) ||
      schema.pattern.includes('(?:0|[1-9]');
    const example = schema.example ?? schema.examples?.[0];
    // A spec description of the pattern is shown as written; it is the API's own wording.
    add(decimal ? t('valid.type.number') : schema.description ||
      (typeof example === 'string' ? t('valid.pattern.example', { example: displayValue(example) }) : t('valid.pattern.generic')));
  }
}
