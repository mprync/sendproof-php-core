// User preferences that live in this browser only: density, theme, language, digits and traced
// Send. applySettings() writes them to <html> so the stylesheet and i18n follow.
import { configure, current, detectPlatform, LANGUAGES, matchLanguage, runButtonWidths } from './i18n.js';

const STORAGE_KEY = 'sendproof-settings';
const DENSITIES = ['compact', 'default', 'comfortable'];
const THEMES = ['system', 'light', 'dark'];

/** Settings with defaults filled in. tracedSend is null until the user chooses. */
export function loadSettings(storage = globalThis.localStorage, preferences = globalThis.navigator?.languages) {
  let saved = {};
  try { saved = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}') || {}; } catch { /* Ignore an unreadable value. */ }
  // Earlier versions stored only the theme.
  const legacyTheme = (() => { try { return storage?.getItem('sendproof-theme'); } catch { return null; } })();
  return {
    density: DENSITIES.includes(saved.density) ? saved.density : 'default',
    theme: THEMES.includes(saved.theme) ? saved.theme : ['light', 'dark'].includes(legacyTheme) ? legacyTheme : 'system',
    language: LANGUAGES.some(language => language.id === saved.language) ? saved.language : matchLanguage(preferences || []),
    digits: saved.digits === 'arab' ? 'arab' : 'latn',
    tracedSend: typeof saved.tracedSend === 'boolean' ? saved.tracedSend : null,
  };
}

let settings = loadSettings();
const listeners = new Set();

export const getSettings = () => settings;

/** Merges a change, stores it and re-applies every setting. */
export function updateSettings(change, storage = globalThis.localStorage) {
  settings = { ...settings, ...change };
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* Private mode can refuse storage. */ }
  applySettings();
  listeners.forEach(listener => listener(settings, change));
}

/** Calls back after every change. Returns an unsubscribe function. */
export function onSettingsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Traced Send is on by default in Development and off elsewhere, unless the user chose. */
export function tracedSendEnabled(capabilities) {
  if (capabilities?.observedSend !== true) return false;
  return settings.tracedSend ?? /^development$/i.test(capabilities.environment || '');
}

const darkQuery = () => globalThis.matchMedia?.('(prefers-color-scheme: dark)');

/** The theme actually shown: System follows the operating system. */
export const resolvedTheme = () => settings.theme === 'system' ? (darkQuery()?.matches ? 'dark' : 'light') : settings.theme;

/** Writes density, theme, language, direction, platform and run-button widths to <html>. */
export function applySettings(root = globalThis.document?.documentElement) {
  configure({ language: settings.language, digits: settings.digits, platform: detectPlatform() });
  if (!root) return;
  const { dir, platform } = current();
  if (settings.density === 'default') delete root.dataset.density;
  else root.dataset.density = settings.density;
  root.dataset.theme = resolvedTheme();
  root.dataset.platform = platform;
  root.lang = settings.language;
  root.dir = dir;
  loadScriptFont(settings.language, root.ownerDocument);
  const widths = runButtonWidths();
  root.style.setProperty('--w-preview', widths.preview);
  root.style.setProperty('--w-send', widths.send);
}

/**
 * Faces for scripts Geist doesn't cover, loaded only for the active language: Noto Sans JP, KR,
 * SC and TC for CJK, Hebrew, Devanagari and Thai (Arabic and Persian use IBM Plex Sans Arabic,
 * which styles.css loads with Geist). The stylesheet's :lang() rules put the face after Geist.
 */
const SCRIPT_FONTS = {
  ja: 'Noto+Sans+JP', ko: 'Noto+Sans+KR', 'zh-Hans': 'Noto+Sans+SC', 'zh-Hant': 'Noto+Sans+TC',
  he: 'Noto+Sans+Hebrew', hi: 'Noto+Sans+Devanagari', th: 'Noto+Sans+Thai',
};
function loadScriptFont(language, document) {
  const catalogue = LANGUAGES.find(item => item.id === language)?.catalogue;
  const family = SCRIPT_FONTS[catalogue];
  if (!family || !document?.head || document.querySelector(`link[data-script-font="${family}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${family}:wght@400;500;600&display=swap`;
  link.dataset.scriptFont = family;
  document.head.append(link);
}

darkQuery()?.addEventListener?.('change', () => {
  if (settings.theme === 'system') applySettings();
});
