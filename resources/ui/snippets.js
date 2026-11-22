// Request samples: one exporter per language, all fed the same prepared request. Keep formatting
// independent from the form so adding a language never affects execution.
//
// Every exporter
//   - receives credentials already replaced by REDACTED (see prepareRequest),
//   - writes code a person would write: one statement per line, JSON bodies indented,
//   - escapes each string for its own language (quotes, backslashes, newlines, control
//     characters and the language's interpolation sigils), and
//   - uses the language's raw/verbatim/heredoc form for multi-line bodies only when that form
//     reproduces the bytes exactly; otherwise it falls back to an escaped one-line string.

/**
 * The formats the picker offers, in display order. `label` is the language, `library` the client
 * it uses (shown muted beside it), `icon` the mark in lang-icons.js, `lexer` the grammar id in
 * highlight.js and `hidden` formats are exportable but not part of the picker (.http is only
 * copied, as before).
 */
export const snippetFormats = [
  { id: 'curl', label: 'cURL', library: 'bash', icon: 'curl', lexer: 'bash' },
  { id: 'fetch', label: 'JavaScript', library: 'fetch', icon: 'javascript', lexer: 'javascript' },
  { id: 'python', label: 'Python', library: 'requests', icon: 'python', lexer: 'python' },
  { id: 'csharp', label: 'C#', library: 'HttpClient', icon: 'csharp', lexer: 'csharp' },
  { id: 'go', label: 'Go', library: 'net/http', icon: 'go', lexer: 'go' },
  { id: 'java', label: 'Java', library: 'java.net.http', icon: 'java', lexer: 'java' },
  { id: 'kotlin', label: 'Kotlin', library: 'Ktor', icon: 'kotlin', lexer: 'kotlin' },
  { id: 'php', label: 'PHP', library: 'Guzzle', icon: 'php', lexer: 'php' },
  { id: 'ruby', label: 'Ruby', library: 'Net::HTTP', icon: 'ruby', lexer: 'ruby' },
  { id: 'rust', label: 'Rust', library: 'reqwest', icon: 'rust', lexer: 'rust' },
  { id: 'powershell', label: 'PowerShell', library: 'Invoke-RestMethod', icon: 'powershell', lexer: 'powershell' },
  { id: 'http', label: '.http', library: 'REST Client', icon: 'http', lexer: 'http', hidden: true },
];

/** The formats shown in the language picker. */
export const pickerFormats = snippetFormats.filter(format => !format.hidden);

const redacted = 'REDACTED';
const credentialName = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;

// ---------------------------------------------------------------------------------------------
// Request preparation
// ---------------------------------------------------------------------------------------------

function prepareRequest(request, sensitiveNames) {
  const custom = new Set(sensitiveNames.map(name => name.toLowerCase()));
  const sensitive = name => credentialName.test(name) || custom.has(name.toLowerCase());
  const method = request.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new Error('Unsupported HTTP method.');
  const url = new URL(request.url);
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const name of new Set(url.searchParams.keys())) {
    if (sensitive(name)) url.searchParams.set(name, redacted);
  }

  const headers = new Headers(request.headers);
  for (const name of headers.keys()) {
    if (sensitive(name)) headers.set(name, redacted);
  }
  let body = request.body ?? null;
  if (body instanceof URLSearchParams) body = body.toString();
  if (body !== null && typeof body !== 'string') {
    throw new Error('File and binary bodies cannot be copied as text.');
  }

  // Host schemes can use custom credential names in a query, header or body.
  const mediaType = headers.get('content-type') ?? '';
  if (body && /json/i.test(mediaType)) {
    const parsed = JSON.parse(body);
    let changed = false;
    const masked = JSON.stringify(parsed, (key, value) => {
      if (!sensitive(key)) return value;
      changed = true;
      return redacted;
    }, 2);
    // The exact bytes are kept unless a credential had to be masked.
    if (changed) body = masked;
  } else if (body && mediaType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(body);
    for (const name of new Set(form.keys())) {
      if (sensitive(name)) form.set(name, redacted);
    }
    body = form.toString();
  }
  return { method, url: url.href, headers, body };
}

/** Header names as they're conventionally written (Content-Type), since Headers lowercases them. */
const canonical = name => name.replace(/(^|-)([a-z])/g, (match, dash, letter) => dash + letter.toUpperCase());

/**
 * Code snippets are for reading and pasting: header names are canonical and JSON bodies are
 * indented. The .http export keeps the exact bytes, so it can be replayed byte for byte.
 * `json` says the body is valid JSON (so JavaScript can show it as an object literal) and `value`
 * is its parsed form, which exporters re-indent to match the code around the body.
 */
function readable(prepared) {
  const headers = [...prepared.headers].map(([name, value]) => [canonical(name), value]);
  let body = prepared.body;
  let json = false;
  let value;
  if (body && /json/i.test(prepared.headers.get('content-type') || '')) {
    try { value = JSON.parse(body); body = JSON.stringify(value, null, 2); json = true; } catch { /* Keep malformed JSON as typed. */ }
  }
  return { ...prepared, headers, body, json, value, contentType: prepared.headers.get('content-type') };
}

// ---------------------------------------------------------------------------------------------
// Shared string helpers
// ---------------------------------------------------------------------------------------------

const lower = name => name.toLowerCase();
/** Headers without the given (lower-case) names. */
const without = (headers, names) => headers.filter(([name]) => !names.includes(lower(name)));
/** Prefixes every non-empty line, so blank lines never gain trailing spaces. */
const indent = (text, pad) => text.split('\n').map(line => line ? pad + line : line).join('\n');
const isMultiline = text => text.includes('\n');

/**
 * The body text for code indented in steps of `unit`. Whitespace in JSON means nothing, so a JSON
 * body is re-serialised with the language's own indent unit; any other body is exact.
 */
const bodyText = (prepared, unit) => prepared.json ? JSON.stringify(prepared.value, null, unit) : prepared.body;
/**
 * Prefixes every line after the first, for a literal that opens on a statement's line: the body
 * then sits one level inside the statement and its closing line lines up with the statement.
 */
const hang = (text, pad) => text.split('\n').map((line, index) => index && line ? pad + line : line).join('\n');

const unicode4 = code => '\\u' + code.toString(16).padStart(4, '0');
const unicodeBraces = code => '\\u{' + code.toString(16) + '}';

/**
 * Quotes a string with `"` (or the given delimiter), escaping the backslash, the delimiter, line
 * breaks, control characters, lone surrogates and the line separators some compilers reject
 * (U+0085, U+2028, U+2029). `unicode(code)` writes one escape in the language's syntax and
 * `extra` maps further characters (such as `$` in Kotlin) to their escapes.
 */
function quote(value, { unicode = unicode4, extra = {}, delimiter = '"' } = {}) {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (Object.hasOwn(extra, char)) out += extra[char];
    else if (char === '\\') out += '\\\\';
    else if (char === delimiter) out += '\\' + delimiter;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029 || (code >= 0xd800 && code <= 0xdfff)) out += unicode(code);
    else out += char;
  }
  return delimiter + out + delimiter;
}

/**
 * Whether a multi-line body can sit in an indented block (Java text block, Kotlin trimIndent,
 * Ruby squiggly heredoc) and come back byte for byte: the compiler removes the smallest common
 * indent and trailing blanks, so some line must start at column 0 and none may end in a blank.
 */
function blockSafe(body) {
  if (!isMultiline(body) || body.includes('\r') || body.endsWith('\n')) return false;
  const rows = body.split('\n');
  return rows.some(row => /^\S/.test(row)) && rows.every(row => row === '' || (!/\s$/.test(row) && /\S/.test(row)));
}

/** Raw forms keep line breaks as `\n` only, so a body with a carriage return takes the escaped route. */
const hasCarriageReturn = text => text.includes('\r');

/** A heredoc marker no line of the body can end early: JSON, or BODY, BODY1, ... */
function uniqueMarker(body, preferred) {
  const clash = marker => new RegExp(`^\\s*${marker}\\b`, 'm').test(body);
  let marker = preferred;
  for (let n = 1; clash(marker); n++) marker = `BODY${n}`;
  return marker;
}

// ---------------------------------------------------------------------------------------------
// cURL
// ---------------------------------------------------------------------------------------------

const shellString = value => "'" + value.replaceAll("'", "'\\''") + "'";

function curl(request) {
  const { method, url, headers, body } = request;
  const parts = [`curl --request ${method} --url ${shellString(url)}`];
  for (const [name, value] of headers) {
    parts.push(`--header ${shellString(name + ': ' + value)}`);
  }
  // A JSON body hangs under its flag: keys one level in, the closing brace level with --data-raw.
  if (body !== null) parts.push(`--data-raw ${shellString(request.json ? hang(bodyText(request, 2), '  ') : body)}`);
  return parts.join(' \\' + '\n  ');
}

// ---------------------------------------------------------------------------------------------
// .http (REST Client): the exact bytes, never reformatted
// ---------------------------------------------------------------------------------------------

function httpFile({ method, url, headers, body }) {
  const lines = [method + ' ' + url];
  for (const [name, value] of headers) lines.push(name + ': ' + value);
  if (body !== null) lines.push('', body);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// JavaScript (fetch)
// ---------------------------------------------------------------------------------------------

function fetchCall({ method, url, headers, body, json }) {
  const options = [`  method: ${quote(method)},`];
  if (headers.length) {
    options.push(`  headers: {\n${headers.map(([name, value]) => `    ${quote(name)}: ${quote(value)},`).join('\n')}\n  },`);
  }
  if (body !== null) {
    // JSON is valid JavaScript, so a JSON body reads as an object. A "__proto__" key would set the
    // prototype in a literal, so that one stays a string.
    const asObject = json && !body.includes('"__proto__"');
    options.push(asObject ? `  body: JSON.stringify(${indent(body, '  ').trimStart()}),` : `  body: ${quote(body)},`);
  }
  options.push('  credentials: "include",');
  return `const response = await fetch(${quote(url)}, {\n${options.join('\n')}\n});\n\nconsole.log(response.status, await response.text());`;
}

// ---------------------------------------------------------------------------------------------
// Python (requests)
// ---------------------------------------------------------------------------------------------

function python(request) {
  const { method, url, headers } = request;
  const body = request.body === null ? null : bodyText(request, 4);
  const lines = ['# pip install requests', 'import requests', '', `url = ${quote(url)}`];
  if (headers.length) {
    lines.push('headers = {', ...headers.map(([name, value]) => `    ${quote(name)}: ${quote(value)},`), '}');
  }
  const call = [quote(method), 'url'];
  if (headers.length) call.push('headers=headers');
  if (body !== null) {
    // A raw triple-quoted string is verbatim, unless the body would end or break its quotes.
    const raw = isMultiline(body) && !hasCarriageReturn(body) && !body.includes('"""') && !/["\\]$/.test(body);
    lines.push(`payload = ${raw ? `r"""${body}"""` : quote(body)}`);
    call.push('data=payload.encode("utf-8")');
  }
  lines.push('', `response = requests.request(${call.join(', ')})`, 'print(response.status_code, response.text)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// C# (HttpClient)
// ---------------------------------------------------------------------------------------------

const csharpMethods = { GET: 'Get', POST: 'Post', PUT: 'Put', DELETE: 'Delete', PATCH: 'Patch', HEAD: 'Head', OPTIONS: 'Options', TRACE: 'Trace' };

/**
 * A C# 11 raw string literal (`"""`), long enough to hold any run of quotes in the body. JSON
 * hangs: its lines sit one level in and the closing fence lines up with the statement (the extra
 * indent is JSON whitespace). Other bodies are exact: the fence's indent is stripped from each line.
 */
function csharpRaw(body, hanging) {
  const longest = Math.max(0, ...(body.match(/"+/g) ?? []).map(run => run.length));
  const fence = '"'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${indent(body, '    ')}\n${hanging ? '' : '    '}${fence}`;
}

function csharp(request) {
  const { method, url, headers, contentType } = request;
  const body = request.body === null ? null : bodyText(request, 4);
  const verb = csharpMethods[method] ? `HttpMethod.${csharpMethods[method]}` : `new HttpMethod(${quote(method)})`;
  const lines = ['using System.Net.Http;', 'using System.Text;', '',
    'using var handler = new HttpClientHandler { AllowAutoRedirect = false };',
    'using var client = new HttpClient(handler);'];
  if (body !== null) {
    const raw = isMultiline(body) && !hasCarriageReturn(body);
    lines.push('', `var body = ${raw ? csharpRaw(body, request.json) : quote(body)};`);
  }
  lines.push('', `using var request = new HttpRequestMessage(${verb}, ${quote(url)});`);
  // Content-* headers belong to the content, so they only exist when there is a body.
  const ordinary = headers.filter(([name]) => !lower(name).startsWith('content-'));
  const content = without(headers.filter(([name]) => lower(name).startsWith('content-')), ['content-type', 'content-length']);
  for (const [name, value] of ordinary) lines.push(`request.Headers.TryAddWithoutValidation(${quote(name)}, ${quote(value)});`);
  if (body !== null) {
    // StringContent adds its own charset, so only the media type is passed; with no Content-Type
    // header the bytes go out without one.
    const mediaType = contentType?.split(';')[0].trim();
    lines.push(mediaType
      ? `request.Content = new StringContent(body, Encoding.UTF8, ${quote(mediaType)});`
      : 'request.Content = new ByteArrayContent(Encoding.UTF8.GetBytes(body));');
    for (const [name, value] of content) lines.push(`request.Content.Headers.TryAddWithoutValidation(${quote(name)}, ${quote(value)});`);
  }
  lines.push('', 'using var response = await client.SendAsync(request);', 'Console.WriteLine(await response.Content.ReadAsStringAsync());');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Go (net/http)
// ---------------------------------------------------------------------------------------------

const goMethods = { GET: 'Get', POST: 'Post', PUT: 'Put', DELETE: 'Delete', PATCH: 'Patch', HEAD: 'Head', OPTIONS: 'Options', TRACE: 'Trace' };

function go(request) {
  const { method, url, headers } = request;
  const body = request.body === null ? null : bodyText(request, '\t');
  const imports = ['"fmt"', '"io"', '"net/http"', ...(body !== null ? ['"strings"'] : [])];
  const lines = ['package main', '', 'import (', ...imports.map(name => `\t${name}`), ')', '', 'func main() {'];
  let reader = 'nil';
  if (body !== null) {
    // A backtick string is verbatim, except that Go drops carriage returns and cannot hold a
    // backtick: those are joined in as "`" so the rest of the body stays readable. The body is a
    // variable of its own; JSON hangs one tab inside it and closes level with the statement.
    const raw = isMultiline(body) && !hasCarriageReturn(body);
    const text = request.json ? hang(body, '\t') : body;
    const literal = raw ? text.split('`').map(part => '`' + part + '`').join(' + "`" + ') : quote(body);
    lines.push(`\tpayload := ${literal}`, '\tbody := strings.NewReader(payload)');
    reader = 'body';
  }
  const verb = goMethods[method] ? `http.Method${goMethods[method]}` : quote(method);
  lines.push(`\treq, err := http.NewRequest(${verb}, ${quote(url)}, ${reader})`, '\tif err != nil {', '\t\tpanic(err)', '\t}');
  // net/http sets Host from the URL and Content-Length from the body.
  for (const [name, value] of without(headers, ['host', 'content-length'])) lines.push(`\treq.Header.Set(${quote(name)}, ${quote(value)})`);
  lines.push('', '\tresp, err := http.DefaultClient.Do(req)', '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer resp.Body.Close()', '',
    '\tdata, err := io.ReadAll(resp.Body)', '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tfmt.Println(resp.Status, string(data))', '}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Java (java.net.http)
// ---------------------------------------------------------------------------------------------

/** Text block escapes: backslashes and any `"""` in the body. */
const escapeTextBlock = body => body.replaceAll('\\', '\\\\').replaceAll('"""', '""\\"');
/** A text block (Java 15+) for an exact body: it ends without a newline. */
const javaTextBlock = (body, pad) => `"""\n${indent(escapeTextBlock(body), pad)}"""`;

function java(request) {
  const { method, url, headers } = request;
  const body = request.body === null ? null : bodyText(request, 4);
  const pad = ' '.repeat(8);
  const lines = ['import java.net.URI;', 'import java.net.http.HttpClient;', 'import java.net.http.HttpRequest;',
    'import java.net.http.HttpRequest.BodyPublishers;', 'import java.net.http.HttpResponse;', 'import java.net.http.HttpResponse.BodyHandlers;', '',
    'public class Main {', '    public static void main(String[] args) throws Exception {', `${pad}HttpClient client = HttpClient.newHttpClient();`];
  if (body !== null) {
    // JSON hangs: one level in, the closing delimiter level with the statement (the leftover indent
    // and final newline are JSON whitespace). Other bodies are exact: they sit at the delimiter's indent.
    const hanging = request.json && isMultiline(body) && !hasCarriageReturn(body);
    const literal = hanging ? `"""\n${indent(escapeTextBlock(body), pad + '    ')}\n${pad}"""` : blockSafe(body) ? javaTextBlock(body, pad + '        ') : quote(body);
    lines.push('', `${pad}String body = ${literal};`);
  }
  const publisher = body !== null ? 'BodyPublishers.ofString(body)' : 'BodyPublishers.noBody()';
  const shortcuts = { GET: '.GET()', DELETE: '.DELETE()' };
  const verb = body !== null && (method === 'POST' || method === 'PUT') ? `.${method}(${publisher})`
    : body === null && shortcuts[method] ? shortcuts[method] : `.method(${quote(method)}, ${publisher})`;
  lines.push('', `${pad}HttpRequest request = HttpRequest.newBuilder()`, `${pad}        .uri(URI.create(${quote(url)}))`);
  // The JDK client refuses these; it sets them from the URI and the body.
  for (const [name, value] of without(headers, ['host', 'content-length', 'connection', 'expect', 'upgrade'])) {
    lines.push(`${pad}        .header(${quote(name)}, ${quote(value)})`);
  }
  lines.push(`${pad}        ${verb}`, `${pad}        .build();`, '',
    `${pad}HttpResponse<String> response = client.send(request, BodyHandlers.ofString());`,
    `${pad}System.out.println(response.statusCode() + " " + response.body());`, '    }', '}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Kotlin (Ktor client)
// ---------------------------------------------------------------------------------------------

const kotlinMethods = { GET: 'Get', POST: 'Post', PUT: 'Put', DELETE: 'Delete', PATCH: 'Patch', HEAD: 'Head', OPTIONS: 'Options' };
const kotlinString = value => quote(value, { extra: { $: '\\$' } });

function kotlin(request) {
  const { method, url, headers, contentType } = request;
  const body = request.body === null ? null : bodyText(request, 4);
  const lines = ['// Gradle: implementation("io.ktor:ktor-client-cio:3.0.0")', 'import io.ktor.client.HttpClient', 'import io.ktor.client.engine.cio.CIO',
    'import io.ktor.client.request.header', 'import io.ktor.client.request.request', ...(body !== null ? ['import io.ktor.client.request.setBody'] : []),
    'import io.ktor.client.statement.bodyAsText', ...(contentType ? ['import io.ktor.http.ContentType'] : []), 'import io.ktor.http.HttpMethod',
    ...(contentType ? ['import io.ktor.http.contentType'] : []), 'import kotlinx.coroutines.runBlocking', '', 'fun main() = runBlocking {'];
  if (body !== null) {
    // A raw string is verbatim, but `$` starts a template and `"""` would end it.
    // JSON hangs: lines one level in and the closing quotes level with the statement; trimIndent
    // removes the common indent, so the body comes back as written.
    const raw = (request.json ? isMultiline(body) && !hasCarriageReturn(body) : blockSafe(body)) && !body.includes('"""');
    const close = request.json ? '    ' : '        ';
    lines.push(raw ? `    val body = """\n${indent(body.replaceAll('$', () => "${'$'}"), '        ')}\n${close}""".trimIndent()` : `    val body = ${kotlinString(body)}`, '');
  }
  const verb = kotlinMethods[method] ? `HttpMethod.${kotlinMethods[method]}` : `HttpMethod.parse(${kotlinString(method)})`;
  lines.push('    val client = HttpClient(CIO)', `    val response = client.request(${kotlinString(url)}) {`, `        method = ${verb}`);
  // Ktor owns these: Content-Type has its own setter, the others are computed from the body.
  for (const [name, value] of without(headers, ['content-type', 'content-length', 'transfer-encoding', 'upgrade'])) {
    lines.push(`        header(${kotlinString(name)}, ${kotlinString(value)})`);
  }
  if (contentType) lines.push(`        contentType(ContentType.parse(${kotlinString(contentType)}))`);
  if (body !== null) lines.push('        setBody(body)');
  lines.push('    }', '    println("${response.status} ${response.bodyAsText()}")', '    client.close()', '}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// PHP (Guzzle)
// ---------------------------------------------------------------------------------------------

/** A single-quoted PHP string: only the backslash and the quote are special, and `$` stays literal. */
const phpString = value => "'" + value.replace(/[\\']/g, '\\$&') + "'";
const phpDouble = value => quote(value, { unicode: unicodeBraces, extra: { $: '\\$' } });

function php(request) {
  const { method, url, headers } = request;
  const body = request.body === null ? null : bodyText(request, 4);
  const lines = ['<?php', '', '// composer require guzzlehttp/guzzle', "require 'vendor/autoload.php';", '', 'use GuzzleHttp\\Client;', '', '$client = new Client();', '',
    `$response = $client->request(${phpString(method)}, ${phpString(url)}, [`];
  if (headers.length) {
    lines.push("    'headers' => [", ...headers.map(([name, value]) => `        ${phpString(name)} => ${phpString(value)},`), '    ],');
  }
  if (body !== null) {
    // A nowdoc is verbatim. Its closing marker may be indented (PHP 7.3+), which strips the indent.
    // A line that starts with a tab cannot sit under the space indent PHP requires.
    if (isMultiline(body) && !hasCarriageReturn(body) && !/^\t/m.test(body)) {
      const marker = uniqueMarker(body, 'JSON');
      // JSON hangs: lines one level in, the marker level with the statement (the leftover indent is JSON whitespace).
      lines.push(`    'body' => <<<'${marker}'`, indent(body, '        '), `${request.json ? '    ' : '        '}${marker},`);
    } else {
      lines.push(`    'body' => ${phpDouble(body)},`);
    }
  }
  // Without this Guzzle throws on 4xx and 5xx instead of returning the response.
  lines.push("    'http_errors' => false,", ']);', '', "echo $response->getStatusCode(), ' ', $response->getBody(), PHP_EOL;");
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Ruby (Net::HTTP)
// ---------------------------------------------------------------------------------------------

const rubyMethods = { GET: 'Get', POST: 'Post', PUT: 'Put', DELETE: 'Delete', PATCH: 'Patch', HEAD: 'Head', OPTIONS: 'Options', TRACE: 'Trace' };
/** A double-quoted Ruby string. `#` is escaped so "#{...}" can never interpolate. */
const rubyString = value => quote(value, { extra: { '#': '\\#' } });

function ruby(request) {
  const { method, url, headers } = request;
  const body = request.body === null ? null : bodyText(request, 2);
  const lines = ['require "net/http"', 'require "uri"', '', `uri = URI(${rubyString(url)})`, ''];
  lines.push(rubyMethods[method]
    ? `request = Net::HTTP::${rubyMethods[method]}.new(uri)`
    : `request = Net::HTTPGenericRequest.new(${rubyString(method)}, ${body !== null}, true, uri)`);
  for (const [name, value] of headers) lines.push(`request[${rubyString(name)}] = ${rubyString(value)}`);
  if (body !== null) {
    if (blockSafe(body)) {
      // A single-quoted squiggly heredoc is verbatim apart from its trailing newline, which chomp removes.
      const marker = uniqueMarker(body, 'JSON');
      lines.push(`request.body = <<~'${marker}'.chomp`, indent(body, '  '), marker);
    } else {
      lines.push(`request.body = ${rubyString(body)}`);
    }
  }
  lines.push('', 'response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") do |http|', '  http.request(request)', 'end', '',
    'puts response.code, response.body');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Rust (reqwest, blocking)
// ---------------------------------------------------------------------------------------------

const rustMethods = { GET: 'get', POST: 'post', PUT: 'put', DELETE: 'delete', PATCH: 'patch', HEAD: 'head' };
const rustString = value => quote(value, { unicode: code => `\\u{${code.toString(16)}}` });

/** A raw string with enough `#` to outlast any `"#` in the body. */
function rustRaw(body) {
  const longest = Math.max(0, ...(body.match(/"#*/g) ?? []).map(run => run.length - 1));
  const hashes = '#'.repeat(longest + 1);
  return `r${hashes}"${body}"${hashes}`;
}

function rust(request) {
  const { method, url, headers } = request;
  const body = request.body === null ? null : bodyText(request, 4);
  const lines = ['// Cargo.toml: reqwest = { version = "0.12", features = ["blocking"] }', 'use reqwest::blocking::Client;', '',
    'fn main() -> Result<(), reqwest::Error> {', '    let client = Client::new();'];
  if (body !== null) {
    // The body is a variable of its own: JSON hangs one level inside the statement and closes level with it.
    const raw = isMultiline(body) && !hasCarriageReturn(body);
    lines.push(`    let body = ${raw ? rustRaw(request.json ? hang(body, '    ') : body) : rustString(body)};`);
  }
  lines.push('    let response = client');
  lines.push(rustMethods[method]
    ? `        .${rustMethods[method]}(${rustString(url)})`
    : `        .request(reqwest::Method::from_bytes(${rustString(method)}.as_bytes()).unwrap(), ${rustString(url)})`);
  for (const [name, value] of without(headers, ['content-length'])) lines.push(`        .header(${rustString(name)}, ${rustString(value)})`);
  if (body !== null) lines.push('        .body(body)');
  lines.push('        .send()?;', '', '    println!("{} {}", response.status(), response.text()?);', '    Ok(())', '}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// PowerShell (Invoke-RestMethod)
// ---------------------------------------------------------------------------------------------

/** A single-quoted string: only the quote is special, and PowerShell also treats curly quotes as quotes. */
const powershellString = value => "'" + value.replace(/['\u2018\u2019\u201a\u201b]/g, match => match + match) + "'";

function powershell(request) {
  const { method, url, headers, contentType } = request;
  const body = request.body === null ? null : bodyText(request, 2);
  const lines = [];
  const plain = without(headers, ['content-type']);
  if (plain.length) lines.push('$headers = @{', ...plain.map(([name, value]) => `  ${powershellString(name)} = ${powershellString(value)}`), '}');
  if (body !== null) {
    // A single-quoted here-string is verbatim; it ends at the first line that begins with '@.
    const verbatim = isMultiline(body) && !hasCarriageReturn(body) && !/^'@/m.test(body);
    // The closing '@ must start its line, so JSON hangs two spaces inside the opening line instead.
    lines.push(verbatim ? `$body = @'\n${request.json ? indent(body, '  ') : body}\n'@` : `$body = ${powershellString(body)}`);
  }
  if (lines.length) lines.push('');
  const params = [['Method', powershellString(method)], ['Uri', powershellString(url)]];
  if (plain.length) params.push(['Headers', '$headers']);
  if (contentType) params.push(['ContentType', powershellString(contentType)]);
  if (body !== null) params.push(['Body', '$body']);
  const width = Math.max(...params.map(([name]) => name.length));
  lines.push('$params = @{', ...params.map(([name, value]) => `  ${name.padEnd(width)} = ${value}`), '}', 'Invoke-RestMethod @params');
  return lines.join('\n');
}

const exporters = new Map([['curl', curl], ['fetch', fetchCall], ['python', python], ['csharp', csharp], ['go', go], ['java', java],
  ['kotlin', kotlin], ['php', php], ['ruby', ruby], ['rust', rust], ['powershell', powershell], ['http', httpFile]]);

/** Export a prepared request, replacing recognized credentials before formatting. */
export function formatRequest(format, request, sensitiveNames = []) {
  const exportRequest = exporters.get(format);
  if (!exportRequest) throw new Error('Unsupported request format.');
  const prepared = prepareRequest(request, sensitiveNames);
  return exportRequest(format === 'http' ? prepared : readable(prepared));
}
