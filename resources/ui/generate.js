// Values for the per-field Generate button (mocks 31, 32, m06). Valid values are random within
// the schema's constraints; invalid ones deliberately break one rule so the API's errors can be
// tested. Every option says what it is, so a generated value is never mistaken for real data.
import { newUuid } from './uuid.js';
import { formatDecimal, t } from './i18n.js';

const pick = list => list[Math.floor(random() * list.length)];
/** A uniformly random number in [0, 1) from the platform's secure generator when available. */
function random() {
  const array = new Uint32Array(1);
  globalThis.crypto?.getRandomValues?.(array);
  return array[0] ? array[0] / 2 ** 32 : Math.random();
}

const FIRST = ['ada', 'ben', 'cara', 'dev', 'elif', 'farah', 'goran', 'hana', 'ivan', 'jun', 'kemi', 'lior', 'maya', 'noor', 'oscar'];
const LAST = ['lovelace', 'okafor', 'novak', 'silva', 'tanaka', 'haddad', 'kowalski', 'moreau', 'ivanova', 'osei', 'park', 'reyes'];
const WORDS = ['freight', 'invoice', 'quarterly', 'supplier', 'payroll', 'refund', 'licence', 'deposit', 'retainer', 'shipment', 'services', 'rental', 'consulting', 'materials'];

const typeOf = schema => (Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type) || (schema.properties ? 'object' : schema.items ? 'array' : 'string');

/** Decimal places implied by multipleOf or a decimal format. */
function decimalsOf(schema, integer) {
  if (integer) return 0;
  if (typeof schema.multipleOf === 'number') return Math.max(0, (String(schema.multipleOf).split('.')[1] || '').length);
  return 2;
}

function numberRange(schema, integer) {
  const step = integer ? 1 : 10 ** -decimalsOf(schema, integer);
  const low = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + step
    : schema.minimum !== undefined ? schema.minimum + (schema.exclusiveMinimum === true ? step : 0) : integer ? 1 : 1;
  const high = typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum - step
    : schema.maximum !== undefined ? schema.maximum - (schema.exclusiveMaximum === true ? step : 0) : Infinity;
  // Huge documented maximums (such as .NET's decimal range) still give everyday values.
  const everyday = Math.max(low * 100, low + (integer ? 100 : 10000));
  return { low, high: Math.min(high, everyday), max: high, step };
}

const round = (value, decimals) => Number(value.toFixed(decimals));

function randomNumber(schema, integer) {
  const { low, high, step } = numberRange(schema, integer);
  const decimals = decimalsOf(schema, integer);
  const steps = Math.max(0, Math.floor((high - low) / step));
  return round(low + Math.floor(random() * (steps + 1)) * step, decimals);
}

/** The next weekday at least `from` days ahead, as ISO yyyy-mm-dd. */
export function businessDay(from = 1 + Math.floor(random() * 21)) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + from);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function words(min = 0, max = 40) {
  const target = Math.min(max, Math.max(min, Math.min(24, max)));
  let text = '';
  while (text.length < Math.max(min, Math.min(target, 12))) text = (text ? text + ' ' : '') + pick(WORDS);
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return text.length > max ? text.slice(0, max).trimEnd() : text.padEnd(min, 'x');
}

/** A string matching simple patterns made of character classes, quantifiers and literals. */
function fromPattern(pattern) {
  const source = String(pattern).replace(/^\^|\$$/g, '');
  const classes = { '\\d': '0123456789', '[A-Z]': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[a-z]': 'abcdefghijklmnopqrstuvwxyz', '[0-9]': '0123456789', '[A-Z0-9]': 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789', '[a-zA-Z]': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' };
  const token = /(\\d|\[[^\]]+\]|\\.|[^\\[{])(\{(\d+)(?:,(\d*))?\}|[+*?])?/g;
  let out = '';
  for (const match of source.matchAll(token)) {
    const [, atom, quantifier, min, max] = match;
    const set = classes[atom] ?? (atom.startsWith('\\') ? atom.slice(1) : atom.startsWith('[') ? null : atom);
    if (set === null || /[()|]/.test(atom)) return null;
    const count = quantifier === '?' ? 0 : quantifier === '*' ? 1 : quantifier === '+' ? 2 : min ? Number(min) + (max ? Math.floor(random() * (Number(max || min) - Number(min) + 1)) : 0) : 1;
    for (let i = 0; i < count; i++) out += set.length > 1 ? pick([...set]) : set;
  }
  try { return new RegExp(pattern).test(out) ? out : null; } catch { return null; }
}

/** One random valid value and its short description, or undefined when nothing fits. */
export function randomValid(schema, current) {
  const type = typeOf(schema);
  if (schema.const !== undefined) return { value: schema.const, source: t('gen.const') };
  if (schema.enum?.length) {
    const others = schema.enum.filter(value => !Object.is(value, current));
    return { value: pick(others.length ? others : schema.enum), source: t('gen.enumPick') };
  }
  if (type === 'integer' || type === 'number') return { value: randomNumber(schema, type === 'integer'), source: t('gen.inRange') };
  if (type === 'boolean') return { value: current === undefined ? true : !current, source: t('gen.toggled') };
  if (type !== 'string') return undefined;
  switch (schema.format) {
    case 'uuid': return { value: newUuid(), source: t('gen.uuid') };
    case 'date': return { value: businessDay(), source: t('gen.businessDay') };
    case 'date-time': return { value: new Date(Date.now() + Math.round((random() - 0.5) * 14 * 864e5)).toISOString().replace(/\.\d+Z$/, 'Z'), source: t('gen.nearNow') };
    case 'email': return { value: `${pick(FIRST)}.${pick(LAST)}@example.test`, source: t('gen.email') };
    case 'uri': case 'url': return { value: `https://example.test/${pick(WORDS)}/${Math.floor(random() * 1000)}`, source: t('gen.url') };
    case 'password': return { value: `${pick(WORDS)}-${Math.floor(random() * 9000 + 1000)}-${pick(WORDS).toUpperCase()}!`, source: t('gen.password') };
    default: break;
  }
  if (schema.pattern) {
    const value = fromPattern(schema.pattern);
    if (value) return { value, source: t('gen.pattern') };
  }
  return { value: words(schema.minLength ?? 0, schema.maxLength ?? 40), source: t('gen.words') };
}

/**
 * The Generate menu for a field: valid options first, then deliberately invalid ones.
 * Each option is { value, main, sub }. `text` is what goes into the input when the value is
 * not a plain JSON value (such as "abc" in a number field).
 */
export function generateOptions(schema, current) {
  const type = typeOf(schema);
  const valid = [];
  const invalid = [];
  const integer = type === 'integer';
  if (type === 'integer' || type === 'number') {
    const { low, high } = numberRange(schema, integer);
    const decimals = decimalsOf(schema, integer);
    const show = value => integer ? String(value) : formatDecimal(value, decimals);
    const randomValue = randomNumber(schema, integer);
    valid.push({ value: randomValue, main: show(randomValue), sub: t('gen.random') });
    valid.push({ value: round(low, decimals), main: show(low), sub: t('gen.minimum') });
    const roundNumber = Math.min(high, Math.max(low, 1000));
    if (roundNumber !== low) valid.push({ value: roundNumber, main: show(roundNumber), sub: t('gen.round') });
    if (schema.minimum !== undefined || schema.exclusiveMinimum !== undefined) {
      const below = round(low > 0 ? 0 : low - 1, decimals);
      invalid.push({ value: below, main: show(below), sub: t('gen.belowMinimum') });
    }
    if ((schema.maximum !== undefined || schema.exclusiveMaximum !== undefined) && numberRange(schema, integer).max < 1e15) {
      const above = round(numberRange(schema, integer).max + 1, decimals);
      invalid.push({ value: above, main: show(above), sub: t('gen.aboveMaximum') });
    }
    if (!integer && decimals < 6) invalid.push({ text: `10.${'0'.repeat(decimals)}5`, main: `10.${'0'.repeat(decimals)}5`, sub: t('gen.tooManyDecimals') });
    if (integer) invalid.push({ text: '1.5', main: '1.5', sub: t('gen.notWhole') });
    invalid.push({ text: 'abc', main: 'abc', sub: t('gen.notNumber') });
  } else if (schema.enum?.length) {
    for (const value of schema.enum.filter(item => !Object.is(item, current)).slice(0, 4)) valid.push({ value, main: String(value), sub: t('gen.member') });
    invalid.push({ value: 'NotAValue', main: 'NotAValue', sub: t('gen.outsideEnum') });
  } else if (type === 'boolean') {
    valid.push({ value: true, main: 'true', sub: '' }, { value: false, main: 'false', sub: '' });
  } else if (type === 'string') {
    const first = randomValid(schema, current);
    valid.push({ value: first.value, main: String(first.value), sub: first.source });
    if (schema.format === 'uuid') {
      invalid.push({ value: newUuid(), main: t('gen.unknownId'), sub: t('gen.unknownIdBody') });
      invalid.push({ value: 'not-a-uuid', main: 'not-a-uuid', sub: t('gen.badFormat') });
    } else if (schema.format === 'date') {
      valid.push({ value: businessDay(1), main: businessDay(1), sub: t('gen.nextBusinessDay') });
      invalid.push({ value: `${new Date().getUTCFullYear()}-02-31`, main: `${new Date().getUTCFullYear()}-02-31`, sub: t('gen.noSuchDay') });
      const past = new Date(Date.now() - 864e5 * 7).toISOString().slice(0, 10);
      invalid.push({ value: past, main: past, sub: t('gen.past') });
    } else if (schema.format === 'email') {
      valid.push({ value: `${pick(FIRST)}.${pick(LAST)}@example.test`, main: `${pick(FIRST)}.${pick(LAST)}@example.test`, sub: t('gen.email') });
      invalid.push({ value: 'not-an-email', main: 'not-an-email', sub: t('gen.badFormat') });
    } else if (schema.format === 'date-time') {
      invalid.push({ value: 'tomorrow', main: 'tomorrow', sub: t('gen.badFormat') });
    } else {
      if (schema.maxLength !== undefined) {
        const longest = words(schema.maxLength, schema.maxLength);
        valid.push({ value: longest, main: longest, sub: t('gen.longest', { n: schema.maxLength }) });
        invalid.push({ value: longest + 'x', main: t('gen.oneOver', { n: schema.maxLength + 1 }), sub: t('gen.tooLong') });
      }
      if (schema.pattern) invalid.push({ value: '!' + first.value, main: '!' + first.value, sub: t('gen.breaksPattern') });
      if (schema.minLength) invalid.push({ value: 'x'.repeat(schema.minLength - 1), main: t('gen.oneUnder', { n: schema.minLength - 1 }), sub: t('gen.tooShort') });
    }
    if (!schema.minLength || schema.minLength > 0) invalid.push({ value: '', main: t('gen.empty'), sub: t('gen.emptyBody') });
  }
  return { valid, invalid, rule: ruleSummary(schema, type) };
}

/** "within 0.01 and up to 2 decimals": the constraints the valid group respects. */
function ruleSummary(schema, type) {
  const parts = [];
  if (type === 'number' || type === 'integer') {
    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.maximum < 1e15) parts.push(t('gen.between', { min: schema.minimum, max: schema.maximum }));
    else if (schema.minimum !== undefined) parts.push(t('gen.atLeast', { min: schema.minimum }));
    else if (schema.maximum !== undefined) parts.push(t('gen.atMost', { max: schema.maximum }));
    if (type === 'number') parts.push(t('gen.decimals', { n: decimalsOf(schema, false) }));
  } else if (schema.maxLength !== undefined) parts.push(t('gen.maxChars', { n: schema.maxLength }));
  else if (schema.format) parts.push(schema.format);
  return parts.join(' · ');
}
