// Syntax colouring for JSON and for the request samples in every language we export.
//
// A sample is plain text in, HTML out: the text is cut into tokens by a small per-language lexer
// and each token becomes `<span class="tok-KIND">` (classes live in views.css and app.css, with
// light and dark colours that meet WCAG AA). Every piece of text goes through esc(), so nothing a
// request contains can become markup. There is no parser: a lexer is an ordered list of sticky
// regular expressions, and the first rule that matches at the current position wins. Text no rule
// claims (spaces, an unterminated quote) passes through uncoloured.
//
// Token kinds
//   k  JSON/object key         s  string (any quoting form, incl. raw, verbatim, heredoc)
//   n  number                  b  literal: true, false, null, None, nil ...
//   p  punctuation             kw keyword
//   c  comment                 f  function or method call, command, cmdlet
//   fl shell flag (-X)         u  URL inside a string
//   v  variable ($name)        t  type or class name (Capitalised identifier)
//
// A string whose content is a JSON document (a --data-raw body, a Python r"""...""", a Rust
// r#"..."#, a PHP nowdoc, a PowerShell here-string, ...) is not painted as one green block: its
// delimiters stay string-coloured and the JSON inside is coloured like the response viewer does.
import { esc } from './components.js';

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b|([{}[\],])/g;
// The same, for JSON written inside a string that escapes its backslashes (a Java text block):
// there a JSON \" appears as \\" and a JSON backslash as four, so an escape is two backslashes and a character.
const DOUBLED_TOKEN = /("(?:\\\\[\s\S]|[^"\\])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b|([{}[\],])/g;

/**
 * Colours JSON text (or JSON inside a snippet). The input is plain text; the output is HTML.
 * `doubled` reads JSON whose backslashes are doubled, as inside a Java text block.
 */
export function highlightJson(text, { doubled = false } = {}) {
  let out = '';
  let last = 0;
  for (const match of String(text).matchAll(doubled ? DOUBLED_TOKEN : TOKEN)) {
    out += esc(text.slice(last, match.index));
    const [whole, string, colon, number, literal, punctuation] = match;
    if (string) out += colon ? `<span class="tok-k">${esc(string)}</span><span class="tok-p">${esc(colon)}</span>` : `<span class="tok-s">${esc(string)}</span>`;
    else if (number) out += `<span class="tok-n">${esc(number)}</span>`;
    else if (literal) out += `<span class="tok-b">${literal}</span>`;
    else out += `<span class="tok-p">${esc(punctuation)}</span>`;
    last = match.index + whole.length;
  }
  return out + esc(String(text).slice(last));
}

// ---------------------------------------------------------------------------------------------
// Building blocks for the lexers
// ---------------------------------------------------------------------------------------------

const span = (kind, text) => text ? `<span class="tok-${kind}">${esc(text)}</span>` : '';

/** A rule: a sticky regex plus a function turning its match into HTML. */
const rule = (pattern, emit) => ({ re: new RegExp(pattern.source, pattern.flags.replace('y', '') + 'y'), emit });
/** A rule that paints the whole match one kind. */
const simple = (pattern, kind) => rule(pattern, match => span(kind, match[0]));

const URL_IN_TEXT = /https?:\/\/[^\s"'`\\)]+/g;

/** Splits text into plain and URL pieces so a URL inside a string gets its own colour. */
function withUrls(text, kind) {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    html += span(kind, text.slice(last, match.index)) + span('u', match[0]);
    last = match.index + match[0].length;
  }
  return html + span(kind, text.slice(last));
}

const looksLikeJson = text => {
  if (!/^\s*[[{]/.test(text) || !/[\]}]\s*$/.test(text)) return false;
  try { JSON.parse(text); return true; } catch { return false; }
};

/**
 * A string rule. `groups` names the capture groups holding the opening delimiter, the content
 * and the closing delimiter (1, 2, 3 unless the pattern says otherwise). With `keys`, a string
 * that is followed by a colon is an object key, as in a JavaScript or Python dictionary literal.
 * `unescape` turns the content into the text it stands for, only to decide whether it is JSON;
 * `doubled` colours that JSON with doubled backslashes (see highlightJson).
 */
function string(pattern, { open = 1, content = 2, close = 3, keys = false, unescape, doubled = false } = {}) {
  return rule(pattern, match => {
    const [whole, before, inner, after] = [match[0], match[open], match[content], match[close]];
    if (keys && /^\s*:/.test(match.input.slice(match.index + whole.length, match.index + whole.length + 16))) return span('k', whole);
    if (looksLikeJson(unescape ? unescape(inner) : inner)) return span('s', before) + highlightJson(inner, { doubled }) + span('s', after);
    return withUrls(whole, 's');
  });
}

/**
 * A heredoc (Ruby `<<~'JSON'`, PHP `<<<'JSON'`): the tag, whatever else is on that line
 * (`.chomp`, which is lexed like code), the body, then the closing line. Groups: 1 tag, 4 rest of
 * the tag's line, 5 body.
 */
const heredoc = pattern => rule(pattern, (match, lex) => {
  const [whole, tag, , , rest, body] = match;
  const head = tag.length + rest.length + 1;
  const closing = whole.slice(head + body.length + 1);
  return span('s', tag) + tokenize(rest, lex) + '\n' + (looksLikeJson(body) ? highlightJson(body) : span('s', body)) + '\n' + span('s', closing);
});

const doubleQuoted = (keys = false) => string(/(")((?:\\[\s\S]|[^"\\])*)(")/, { keys });
const singleQuoted = (keys = false) => string(/(')((?:\\[\s\S]|[^'\\])*)(')/, { keys });
const lineComment = prefix => simple(new RegExp(`${prefix}.*`), 'c');
const blockComment = simple(/\/\*[\s\S]*?\*\//, 'c');
const number = simple(/0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'n');
const punctuation = simple(/[{}()[\],;:.<>=+\-?!&|@\\~^%]+/, 'p');

/** An identifier: a keyword, a literal, a call, a Capitalised type, or plain text. */
const identifier = rule(/[A-Za-z_$][\w$]*/, (match, lex) => {
  const word = match[0];
  const next = match.input.slice(match.index + word.length, match.index + word.length + 2);
  if (lex.keywords.has(word)) return span('kw', word);
  if (lex.literals.has(word)) return span('b', word);
  if (lex.builtins.has(word) || /^!?\(/.test(next)) return span('f', word);
  if (/^[A-Z]/.test(word) && /[a-z]/.test(word)) return span('t', word);
  return esc(word);
});

const words = text => new Set(text.split(' ').filter(Boolean));

/** A lexer: its rules in priority order, plus the word lists the identifier rule consults. */
const defineLexer = ({ rules, keywords = '', literals = '', builtins = '' }) => ({
  rules: [...rules, number, identifier, punctuation], keywords: words(keywords), literals: words(literals), builtins: words(builtins),
});

const cStyleComments = [lineComment('//'), blockComment];
const hashComment = rule(/(?<![^\s])#.*/, match => span('c', match[0]));
const backtickString = string(/(`)((?:\\[\s\S]|[^`\\])*)(`)/);

// ---------------------------------------------------------------------------------------------
// The lexers
// ---------------------------------------------------------------------------------------------

const LEXERS = {
  // cURL: single quotes are verbatim, so a JSON body is one multi-line string.
  bash: defineLexer({
    rules: [hashComment, string(/(')((?:[^']|'\\'')*)(')/, { unescape: text => text.replaceAll("'\\''", "'") }), doubleQuoted(), simple(/(?<=\s)--?[A-Za-z][\w-]*/, 'fl'), simple(/\$\{?\w+\}?/, 'v')],
    builtins: 'curl echo',
  }),
  javascript: defineLexer({
    rules: [...cStyleComments, doubleQuoted(true), singleQuoted(true), backtickString],
    keywords: 'const let var await async function return if else new import from export class of typeof',
    literals: 'true false null undefined',
  }),
  python: defineLexer({
    rules: [hashComment,
      string(/([rRbBfFuU]{0,2}""")([\s\S]*?)(""")/), string(/([rRbBfFuU]{0,2}''')([\s\S]*?)(''')/),
      string(/([rRbBfFuU]{0,2}")((?:\\[\s\S]|[^"\\\n])*)(")/, { keys: true }), string(/([rRbBfFuU]{0,2}')((?:\\[\s\S]|[^'\\\n])*)(')/, { keys: true })],
    keywords: 'import from as def return if elif else with await async class for in not and or is lambda pass try except raise while',
    literals: 'True False None',
  }),
  csharp: defineLexer({
    rules: [...cStyleComments,
      string(/("{3,})([\s\S]*?)(\1)/), string(/(@\$?"|\$@")((?:""|[^"])*)(")/), string(/(\$?")((?:\\[\s\S]|[^"\\\n])*)(")/), singleQuoted()],
    keywords: 'using var new await async public static void class return if else namespace string int bool object foreach in',
    literals: 'true false null',
  }),
  go: defineLexer({
    rules: [...cStyleComments, string(/(`)([^`]*)(`)/), doubleQuoted(), singleQuoted()],
    keywords: 'package import func return if else defer var const type struct for range go select switch case',
    literals: 'true false nil',
  }),
  java: defineLexer({
    rules: [...cStyleComments, string(/(""")((?:\\[\s\S]|(?!""")[\s\S])*)(""")/, { unescape: text => text.replace(/\\([\\"])/g, '$1'), doubled: true }), doubleQuoted(), singleQuoted()],
    keywords: 'import public private class static void throws new final return if else try catch throw extends implements package',
    literals: 'true false null',
  }),
  kotlin: defineLexer({
    rules: [...cStyleComments, string(/(""")([\s\S]*?)(""")/), doubleQuoted(), singleQuoted()],
    keywords: 'import fun val var return if else class object suspend package for in when',
    literals: 'true false null',
  }),
  php: defineLexer({
    rules: [...cStyleComments, hashComment, simple(/<\?php|\?>/, 'kw'),
      heredoc(/(<<<(['"]?)(\w+)\2)([^\n]*)\n([\s\S]*?)\n[ \t]*\3\b/), singleQuoted(), doubleQuoted(), simple(/\$\w+/, 'v')],
    keywords: 'use new echo require require_once return if else foreach function class namespace',
    literals: 'true false null',
  }),
  ruby: defineLexer({
    rules: [hashComment, heredoc(/(<<[~-]?(['"]?)(\w+)\2)([^\n]*)\n([\s\S]*?)\n[ \t]*\3\b/), doubleQuoted(), singleQuoted(), simple(/@\w+/, 'v')],
    keywords: 'require def end do if elsif else class module unless begin rescue return',
    literals: 'true false nil',
    builtins: 'puts print p',
  }),
  rust: defineLexer({
    rules: [...cStyleComments, string(/(r(#*)")([\s\S]*?)("\2)/, { open: 1, content: 3, close: 4 }), doubleQuoted()],
    keywords: 'use fn let mut pub struct impl match return if else for in mod const static',
    literals: 'true false',
  }),
  powershell: defineLexer({
    rules: [simple(/<#[\s\S]*?#>/, 'c'), hashComment,
      string(/(@')(\r?\n[\s\S]*?\r?\n)('@)/), string(/(@")(\r?\n[\s\S]*?\r?\n)("@)/),
      string(/(')((?:''|[^'])*)(')/), string(/(")((?:`[\s\S]|""|[^"`])*)(")/),
      rule(/\$(?:true|false|null)\b/i, match => span('b', match[0])), simple(/\$\{[^}]*\}|\$\w+/, 'v'),
      simple(/(?<=^[ \t]*)[A-Za-z]+(?=[ \t]*=)/m, 'k'), simple(/[A-Za-z]+-[A-Za-z]+(?![\w-])/, 'f'), simple(/(?<![\w])-[A-Za-z]\w*/, 'fl')],
    keywords: 'if else elseif foreach function param return',
  }),
};

/** Cuts source into tokens with a lexer and returns HTML. */
function tokenize(source, lex) {
  let html = '';
  let plain = '';
  let position = 0;
  scan: while (position < source.length) {
    for (const { re, emit } of lex.rules) {
      re.lastIndex = position;
      const match = re.exec(source);
      if (!match || !match[0]) continue;
      html += esc(plain);
      plain = '';
      html += emit(match, lex);
      position += match[0].length;
      continue scan;
    }
    plain += source[position++];
  }
  return html + esc(plain);
}

/**
 * The .http format: request line, header lines, then a body. Names are keys, the URL is
 * highlighted as one, and a JSON body is coloured like the response viewer does.
 */
function highlightHttp(text) {
  const [head, ...rest] = text.split('\n\n');
  const lines = head.split('\n').map((line, index) => {
    if (index === 0) {
      const request = /^(\S+)(\s+)(\S+)(.*)$/.exec(line);
      return request ? span('kw', request[1]) + esc(request[2]) + span('u', request[3]) + esc(request[4]) : esc(line);
    }
    const header = /^([^:\s]+)(:)(.*)$/.exec(line);
    return header ? span('k', header[1]) + span('p', header[2]) + span('s', header[3]) : esc(line);
  });
  const body = rest.join('\n\n');
  return lines.join('\n') + (rest.length ? '\n\n' + (looksLikeJson(body) ? highlightJson(body) : esc(body)) : '');
}

/**
 * Colours a request snippet. `lexerId` is the format's lexer (bash, javascript, python, csharp,
 * go, java, kotlin, php, ruby, rust, powershell or http). Without one only the JSON body found in
 * the text is coloured, which is how snippets were shown before they had grammars.
 */
export function highlightSnippet(text, lexerId) {
  const source = String(text);
  if (lexerId === 'http') return highlightHttp(source);
  if (Object.hasOwn(LEXERS, lexerId ?? '')) return tokenize(source, LEXERS[lexerId]);
  const start = source.search(/[{[]\s*\n|[{[]"|[{[]\s*$/m);
  return start < 0 ? esc(source) : esc(source.slice(0, start)) + highlightJson(source.slice(start));
}
