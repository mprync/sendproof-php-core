// The "mark this route preview: false" snippet, in the language of the host application.
//
// An API author marks an operation `preview: false` so Preview explains itself before anyone runs
// it (spec/data-stores.md). Every binding spells that mark in its own idiom, taken from the
// binding's route metadata (docs/plans/data-stores.md, adapters/*). Capabilities `binding`
// ({ language, framework }) says which binding serves the page, so the workbench writes the one
// snippet that applies; without it the 409 result offers a small language switch instead.
import { authorReason } from './stores.js';

const FALLBACK_REASON = 'Writes to a store that can’t roll back';

/** The bindings' language ids (spec/capabilities.schema.json `binding.language`) with their display names. */
export const PREVIEW_FALSE_LANGUAGES = [
  { id: 'dotnet', name: '.NET' },
  { id: 'node', name: 'Node.js' },
  { id: 'python', name: 'Python' },
  { id: 'java', name: 'Java' },
  { id: 'kotlin', name: 'Kotlin' },
  { id: 'go', name: 'Go' },
  { id: 'php', name: 'PHP' },
  { id: 'ruby', name: 'Ruby' },
  { id: 'rust', name: 'Rust' },
];

/** What the switch shows first when discovery names no binding and nothing was chosen before. */
export const DEFAULT_LANGUAGE = 'dotnet';

const STORAGE_KEY = 'sendproof-preview-false-language';
const known = id => PREVIEW_FALSE_LANGUAGES.some(language => language.id === id);

/**
 * The host's binding from capabilities: `{ language, framework }` when `binding.language` is one
 * the workbench knows, otherwise null (an older binding, or a language added later). `framework`
 * is the binding's own free-text name for the web framework ("ASP.NET Core", "Express"), or ''.
 */
export function bindingOf(capabilities) {
  const binding = capabilities?.binding;
  if (!binding || typeof binding !== 'object' || !known(binding.language)) return null;
  return { language: binding.language, framework: typeof binding.framework === 'string' ? binding.framework.trim() : '' };
}

/** The language the switch starts on: the one chosen before, else .NET (the first binding). */
export function chosenLanguage() {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return known(stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE; // Storage can be blocked; the choice then lasts only for this page.
  }
}

/** Remembers the switch's language for the next 409. */
export function chooseLanguage(id) {
  if (!known(id)) return;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, id); } catch { /* Blocked storage: keep going. */ }
}

/** The display name of a language id. */
export const languageName = id => PREVIEW_FALSE_LANGUAGES.find(language => language.id === id)?.name ?? id;

// String literals, as each language reads them. A double-quoted literal escapes backslash, quote
// and newline, and `$` (Kotlin templates) or `#{` (Ruby interpolation) where the language has them.
const double = (text, { dollar = false, hash = false } = {}) => {
  let out = JSON.stringify(text);
  if (dollar) out = out.replace(/\$/g, '\\$');
  if (hash) out = out.replace(/#\{/g, '\\#{');
  return out;
};
const single = text => `'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;

const has = (framework, pattern) => pattern.test(framework || '');

/**
 * The snippet that marks one operation `preview: false` with a reason, for one language.
 * `framework` picks between a language's frameworks where they differ (Express and Fastify, Laravel
 * and Symfony, minimal APIs and MVC); `method` and `path` (the OpenAPI template) fill the bindings
 * that name the route in the mark, and read `POST /path` placeholders when the operation is unknown.
 * @param {{ language?: string, framework?: string, reason?: string, method?: string, path?: string }} options
 */
export function previewFalseSnippet({ language = DEFAULT_LANGUAGE, framework = '', reason, method, path } = {}) {
  const why = authorReason(reason) || FALLBACK_REASON;
  const verb = String(method || 'POST').toUpperCase();
  const route = path || '/path';
  switch (language) {
    case 'node':
      if (has(framework, /nest/i)) return `@SendproofPreview(${single(verb)}, ${single(route)}, { enabled: false, reason: ${single(why)} })`;
      if (has(framework, /fastify/i)) return `app.sendproof.unavailable(${single(verb)}, ${single(route)}, { reason: ${single(why)} }, handler);`;
      return `bench.unavailable(${single(verb)}, ${single(route)}, { reason: ${single(why)} }, handler);`;
    case 'python': return `@preview(False, reason=${double(why)})`;
    case 'java': return `@SendproofPreview(enabled = false, reason = ${double(why)})`;
    case 'kotlin': return `sendproofPreview(enabled = false, reason = ${double(why, { dollar: true })}) { ${verb.toLowerCase()}(${double(route, { dollar: true })}) { … } }`;
    case 'go':
      // net/http registers the route and marks it; chi, Gin and Echo register their own routes, so the mark is separate.
      return has(framework, /chi|gin|echo/i)
        ? `bench.Unavailable(${double(verb)}, ${double(route)}, ${double(why)})`
        : `bench.HandleUnavailable(mux, ${double(`${verb} ${route}`)}, ${double(why)}, handler)`;
    case 'php':
      return has(framework, /symfony/i)
        ? `#[AllowPreview(false, reason: ${single(why)})]`
        : `Route::${verb.toLowerCase()}(${single(route)}, $action)->sendproofPreview(false, ${single(why)});`;
    case 'ruby': return `sendproof_no_preview only: :action, reason: ${double(why, { hash: true })}`;
    case 'rust': return `.preview_unavailable(${double(verb)}, ${double(route)}, ${double(why)})`;
    default: // dotnet
      return has(framework, /minimal/i)
        ? `.WithSendproofPreview(enabled: false, reason: ${double(why)})`
        : `[SendproofPreview(Enabled = false, Reason = ${double(why)})]`;
  }
}
