// Locale-aware text and formatting for Sendproof's own interface.
//
// Only the workbench's chrome is translated. Text from the OpenAPI document (summaries, titles,
// descriptions) and captured data (rows, JSON, SQL, headers) is shown exactly as written or
// stored; callers mark spec text with lang="en" so screen readers switch voice.
//
// Catalogues live in ./locales/<catalogue>.js (each spreads its <catalogue>-capture.js). English
// is bundled; every other catalogue is loaded on demand with loadLanguage(), so the workbench
// downloads one language, not 34. A missing key falls back to English, then to the key.
import en from './locales/en.js';

/** Catalogues loaded so far, by catalogue id. English is always present. */
const catalogues = { en };

/**
 * Every UI language (Display settings lists them in these groups). `id` is the BCP 47 tag that
 * drives Intl; `catalogue` names the strings file (English variants share `en` and differ only in
 * Intl formatting). `autonym` is the language in its own script, `english` its English name,
 * `region` the region in that language. `review` marks machine-translated catalogues that a native
 * speaker hasn't reviewed yet; the picker tags them "Preview" (see ui/locales/README.md).
 */
export const LANGUAGES = [
  ...[['en-IE', 'Ireland'], ['en-GB', 'United Kingdom'], ['en-US', 'United States'], ['en-CA', 'Canada'], ['en-AU', 'Australia'], ['en-IN', 'India']]
    .map(([id, region]) => ({ id, group: 'english', catalogue: 'en', autonym: 'English', english: 'English', region })),
  { id: 'de-DE', group: 'west', catalogue: 'de', autonym: 'Deutsch', english: 'German', region: 'Deutschland' },
  { id: 'fr-FR', group: 'west', catalogue: 'fr', autonym: 'Français', english: 'French', region: 'France', review: true },
  { id: 'es-ES', group: 'west', catalogue: 'es', autonym: 'Español', english: 'Spanish', region: 'España', review: true },
  { id: 'it-IT', group: 'west', catalogue: 'it', autonym: 'Italiano', english: 'Italian', region: 'Italia', review: true },
  { id: 'nl-NL', group: 'west', catalogue: 'nl', autonym: 'Nederlands', english: 'Dutch', region: 'Nederland', review: true },
  { id: 'pt-BR', group: 'west', catalogue: 'pt-BR', autonym: 'Português', english: 'Portuguese', region: 'Brasil', review: true },
  { id: 'pt-PT', group: 'west', catalogue: 'pt-PT', autonym: 'Português', english: 'Portuguese', region: 'Portugal', review: true },
  { id: 'da-DK', group: 'nordic', catalogue: 'da', autonym: 'Dansk', english: 'Danish', region: 'Danmark', review: true },
  { id: 'nb-NO', group: 'nordic', catalogue: 'nb', autonym: 'Norsk bokmål', english: 'Norwegian', region: 'Norge', review: true },
  { id: 'fi-FI', group: 'nordic', catalogue: 'fi', autonym: 'Suomi', english: 'Finnish', region: 'Suomi', review: true },
  { id: 'sv-SE', group: 'nordic', catalogue: 'sv', autonym: 'Svenska', english: 'Swedish', region: 'Sverige', review: true },
  { id: 'cs-CZ', group: 'central', catalogue: 'cs', autonym: 'Čeština', english: 'Czech', region: 'Česko', review: true },
  { id: 'el-GR', group: 'central', catalogue: 'el', autonym: 'Ελληνικά', english: 'Greek', region: 'Ελλάδα', review: true },
  { id: 'pl-PL', group: 'central', catalogue: 'pl', autonym: 'Polski', english: 'Polish', region: 'Polska', review: true },
  { id: 'ru-RU', group: 'central', catalogue: 'ru', autonym: 'Русский', english: 'Russian', region: 'Россия', review: true },
  { id: 'tr-TR', group: 'central', catalogue: 'tr', autonym: 'Türkçe', english: 'Turkish', region: 'Türkiye', review: true },
  { id: 'uk-UA', group: 'central', catalogue: 'uk', autonym: 'Українська', english: 'Ukrainian', region: 'Україна', review: true },
  { id: 'ar', group: 'rtl', catalogue: 'ar', autonym: 'العربية', english: 'Arabic', region: '' },
  { id: 'fa-IR', group: 'rtl', catalogue: 'fa', autonym: 'فارسی', english: 'Persian', region: 'ایران', review: true },
  { id: 'he-IL', group: 'rtl', catalogue: 'he', autonym: 'עברית', english: 'Hebrew', region: 'ישראל', review: true },
  { id: 'hi-IN', group: 'asia', catalogue: 'hi', autonym: 'हिन्दी', english: 'Hindi', region: 'भारत', review: true },
  { id: 'id-ID', group: 'asia', catalogue: 'id', autonym: 'Bahasa Indonesia', english: 'Indonesian', region: 'Indonesia', review: true },
  { id: 'ja-JP', group: 'asia', catalogue: 'ja', autonym: '日本語', english: 'Japanese', region: '日本', review: true },
  { id: 'ko-KR', group: 'asia', catalogue: 'ko', autonym: '한국어', english: 'Korean', region: '대한민국', review: true },
  { id: 'th-TH', group: 'asia', catalogue: 'th', autonym: 'ไทย', english: 'Thai', region: 'ไทย', review: true },
  { id: 'vi-VN', group: 'asia', catalogue: 'vi', autonym: 'Tiếng Việt', english: 'Vietnamese', region: 'Việt Nam', review: true },
  { id: 'zh-Hans', group: 'asia', catalogue: 'zh-Hans', autonym: '简体中文', english: 'Chinese, Simplified', region: '中国大陆', review: true },
  { id: 'zh-Hant', group: 'asia', catalogue: 'zh-Hant', autonym: '繁體中文', english: 'Chinese, Traditional', region: '台灣', review: true },
].map(language => ({ ...language, dir: ['ar', 'fa', 'he'].includes(language.catalogue) ? 'rtl' : 'ltr', name: languageName(language) }));

/** The order of the picker's groups; their headings are `lang.group.<id>`. */
export const LANGUAGE_GROUPS = ['english', 'west', 'nordic', 'central', 'rtl', 'asia'];

/** Every catalogue id, for tests and tools. */
export const CATALOGUES = [...new Set(LANGUAGES.map(language => language.catalogue))];

/** "English (Ireland)", "Deutsch (Deutschland)", "العربية": the autonym with its region. */
function languageName({ autonym, region }) {
  return region && region !== autonym ? `${autonym} (${region})` : autonym;
}

/**
 * Loads the catalogue a language needs (English is bundled). Resolves once `configure()` can use
 * it; a failed download leaves English in place, so the UI is never left without strings.
 */
export async function loadLanguage(language) {
  const entry = LANGUAGES.find(item => item.id === language);
  const id = entry?.catalogue;
  if (!id || catalogues[id]) return catalogues[id] ?? en;
  try { catalogues[id] = (await import(`./locales/${id}.js`)).default; }
  catch { return en; }
  return catalogues[id];
}

/** The loaded catalogue for a language, if any: for previews in a language that isn't active. */
export const catalogueFor = language => catalogues[LANGUAGES.find(item => item.id === language)?.catalogue];

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);

let active = {
  language: 'en-IE', locale: 'en-IE', catalogue: en, dir: 'ltr', digits: 'latn', platform: 'mac',
};

/** Picks the closest offered language for a list of BCP 47 preferences. */
export function matchLanguage(preferences = []) {
  for (const wanted of preferences) {
    const exact = LANGUAGES.find(language => language.id.toLowerCase() === String(wanted).toLowerCase());
    if (exact) return exact.id;
  }
  for (const wanted of preferences) {
    // zh-CN, zh-SG → Simplified; zh-TW, zh-HK, zh-MO → Traditional. Scripts win over regions.
    const tag = String(wanted).toLowerCase();
    if (/^zh-(hant|tw|hk|mo)\b/.test(tag)) return 'zh-Hant';
    if (/^zh\b/.test(tag)) return 'zh-Hans';
    const base = { no: 'nb', nn: 'nb', iw: 'he' }[tag.split('-')[0]] ?? tag.split('-')[0];
    const close = LANGUAGES.find(language => language.catalogue === base || language.id.toLowerCase().split('-')[0] === base);
    if (close) return close.id;
  }
  return 'en-IE';
}

/** The platform whose shortcut glyphs to show: macOS uses ⌘ ⌥, everything else Ctrl and Alt. */
export function detectPlatform(navigatorLike = globalThis.navigator) {
  const name = navigatorLike?.userAgentData?.platform || navigatorLike?.platform || '';
  return /mac|iphone|ipad/i.test(name) ? 'mac' : name ? 'win' : 'mac';
}

/** Switches language, digits (Arabic only) and platform for every later call. */
export function configure({ language = active.language, digits = active.digits, platform = active.platform } = {}) {
  const entry = LANGUAGES.find(item => item.id === language) || LANGUAGES[0];
  const catalogue = catalogues[entry.catalogue] || en;
  // Arabic and Persian default to Latin digits (what people type in an API tool); the Digits
  // setting switches to Arabic-Indic (ar) or Extended Arabic-Indic (fa) digits.
  const native = { ar: 'arab', fa: 'arabext' }[entry.catalogue];
  const locale = native ? `${entry.id}-u-nu-${digits === 'arab' ? native : 'latn'}` : entry.id;
  active = { language: entry.id, locale, catalogue, dir: entry.dir, digits, platform, loaded: !!catalogues[entry.catalogue] };
  pluralRules = new Intl.PluralRules(locale);
  return active;
}

/**
 * Text for a key in another, already loaded language: the language picker's RTL preview shows
 * a real field in the language you're about to pick. Falls back to the active language.
 */
export function tIn(language, key, vars = {}) {
  const catalogue = catalogueFor(language);
  const text = catalogue?.strings?.[key];
  if (typeof text !== 'string') return t(key, vars);
  return text.replace(/\{(\w+)\}/g, (match, name) => vars[name] ?? match);
}

/** Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹, Persian) digits as ASCII digits. */
export const nativeDigits = text => String(text).replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));

/** The current language, Intl locale, text direction, digits and platform. */
export const current = () => active;

let pluralRules = new Intl.PluralRules('en-IE');

function entryFor(key) {
  return active.catalogue.strings?.[key] ?? en.strings[key] ?? key;
}

function pick(entry, vars) {
  if (entry && typeof entry === 'object') {
    const n = Number(vars?.n ?? 0);
    const form = n === 0 && entry.zero ? 'zero' : pluralRules.select(n);
    return { text: entry[form] ?? entry.other, vars: { ...vars, n: formatNumber(n) } };
  }
  return { text: String(entry), vars };
}

/** Text for a key. Placeholders such as {name} are replaced with plain values. */
export function t(key, vars = {}) {
  const { text, vars: values } = pick(entryFor(key), vars);
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1').replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
}

/**
 * HTML for a key. The catalogue text is escaped and each placeholder value is inserted as
 * trusted HTML, so callers escape data and may pass markup such as <code>. Catalogue text may
 * mark **bold** and `code`, so translators can move emphasis with the words.
 */
export function th(key, vars = {}) {
  const { text, vars: values } = pick(entryFor(key), vars);
  // Marks may span placeholders ("**{n} values are missing.**"), so values go in last.
  const slots = [];
  const marked = escape(text.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? `\u0000${slots.push(String(values[name])) - 1}\u0000` : match))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
  return marked.replace(/\u0000(\d+)\u0000/g, (match, index) => slots[Number(index)]);
}

/** True when the active catalogue (or English) has the key. */
export const has = key => Object.hasOwn(active.catalogue.strings || {}, key) || Object.hasOwn(en.strings, key);

export const formatNumber = (n, options) => new Intl.NumberFormat(active.locale, options).format(n);
export const formatDecimal = (n, digits = 2) =>
  formatNumber(n, { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const formatMoney = (n, currency = 'EUR') => formatNumber(n, { style: 'currency', currency });
/** Units in the locale's short form, such as "84 ms" or "1.2 kB". */
export const formatUnit = (n, unit, digits = 0, display = 'short') =>
  formatNumber(n, { style: 'unit', unit, unitDisplay: display, maximumFractionDigits: digits });
/** Bytes as B, kB or MB in the locale's short form. */
export function formatBytes(bytes) {
  // Intl spells out "byte"; the short symbol B reads better next to kB.
  if (bytes < 1000) return t('unit.bytes', { n: formatNumber(bytes) });
  if (bytes < 1_000_000) return formatUnit(bytes / 1000, 'kilobyte', 1);
  return formatUnit(bytes / 1_000_000, 'megabyte', 1);
}
/** Milliseconds below a second, seconds above. */
export const formatDuration = ms => ms < 1000 ? formatUnit(Math.round(ms), 'millisecond') : formatUnit(ms / 1000, 'second', 1);

const isoDay = iso => new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
export const formatDate = (iso, options = { day: '2-digit', month: '2-digit', year: 'numeric' }) =>
  new Intl.DateTimeFormat(active.locale, { ...options, timeZone: 'UTC' }).format(isoDay(iso));
export const formatWeekday = iso =>
  new Intl.DateTimeFormat(active.locale, { weekday: 'short', timeZone: 'UTC' }).format(isoDay(iso));
export const formatTime = value =>
  new Intl.DateTimeFormat(active.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
export const formatDateTime = value =>
  new Intl.DateTimeFormat(active.locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
/** Items strung together without "and": "7 rows, 3 documents, 1 email". */
export const formatCommaList = items =>
  new Intl.ListFormat(active.locale, { style: 'short', type: 'unit' }).format(items.map(String));
export const formatShortDateTime = value =>
  new Intl.DateTimeFormat(active.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const ISO_DATE_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
/** Text with each ISO 8601 date-time (with a zone, as an API sends it) shown as a local short date-time. */
export const localizeDateTimes = text => String(text ?? '').replace(ISO_DATE_TIME, match => {
  const time = new Date(match);
  return Number.isNaN(time.getTime()) ? match : formatShortDateTime(time);
});
export const formatList = (items, type = 'conjunction') =>
  new Intl.ListFormat(active.locale, { style: 'long', type }).format(items.map(String));
export const formatRelativeDays = days =>
  new Intl.RelativeTimeFormat(active.locale, { numeric: 'auto' }).format(days, 'day');

/** The order and separators of a numeric date in this locale, as letters: dd/mm/yyyy, TT.MM.JJJJ. */
export function datePattern() {
  const letters = active.catalogue.dateLetters || en.dateLetters;
  return new Intl.DateTimeFormat(active.locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
    .formatToParts(new Date(Date.UTC(2006, 10, 22)))
    .map(part => part.type === 'literal' ? part.value.replace(/‏|‎/g, '') : ({ day: letters.day, month: letters.month, year: letters.year })[part.type] ?? '')
    .join('');
}

/**
 * Reads a date typed in the locale's own order ("23/11/2026", "23.11.2026") or ISO, and returns
 * { iso } or { invalid: 'format' | 'day' } so callers can say what is wrong.
 */
export function parseLocalDate(text) {
  const value = nativeDigits(String(text ?? '').trim());
  if (!value) return {};
  let year, month, day;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) [, year, month, day] = iso.map(Number);
  else {
    const numbers = value.split(/[^\d]+/).filter(Boolean).map(Number);
    if (numbers.length !== 3) return { invalid: 'format' };
    const order = new Intl.DateTimeFormat(active.locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
      .formatToParts(new Date(Date.UTC(2006, 10, 22))).filter(part => ['day', 'month', 'year'].includes(part.type)).map(part => part.type);
    const parts = Object.fromEntries(order.map((type, index) => [type, numbers[index]]));
    ({ year, month, day } = parts);
    if (year < 100) year += 2000;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || !year) return { invalid: 'format' };
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return { invalid: 'day', year, month, day };
  return { iso: date.toISOString().slice(0, 10) };
}

/** The name of a month in this locale, for messages such as "31 February 2026 doesn't exist". */
export const formatDayMonthYear = (year, month, day) => {
  const name = new Intl.DateTimeFormat(active.locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, 1)));
  return t('date.dayMonthYear', { day: formatNumber(day, { useGrouping: false }), month: name, year: formatNumber(year, { useGrouping: false }) });
};

/** Widths for the fixed Send and Preview buttons in this language and platform. */
export const runButtonWidths = () => (active.catalogue.widths || en.widths)[active.platform];
