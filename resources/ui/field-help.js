// The content of a field's "i" toggletip (mock 23): the description from the spec, the type and
// constraints, an example, and how the value is sent. Spec text keeps lang="en".
import { esc } from './components.js';
import { t, th } from './i18n.js';
import { inline } from './markdown.js';
import { schemaName } from './schema-model.js';
import { shortcutHint } from './shortcuts.js';

const typeOf = schema => (Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type) || (schema.properties ? 'object' : schema.items ? 'array' : 'string');

function sentAs(info, schema, example) {
  const parameter = info.parameter;
  const name = info.path.at(-1) ?? parameter?.name;
  if (parameter?.in === 'path') return th('help.sentPath', { name: `<code>{${esc(parameter.name)}}</code>` });
  if (parameter?.in === 'query') return th('help.sentQuery', { example: `<code>?${esc(parameter.name)}=…</code>` });
  const type = typeOf(schema);
  const sample = example !== undefined ? `<code>"${esc(name)}": ${esc(JSON.stringify(example))}</code>` : `<code>"${esc(name)}"</code>`;
  return th('help.sentJson.' + (['number', 'integer', 'boolean', 'array', 'object'].includes(type) ? type : 'string'), { example: sample });
}

/** HTML for the toggletip of an "i" button rendered by fields/render.js. */
export function describeField(button, { state, requestMedia }) {
  const info = button.fieldInfo;
  if (!info) return '';
  const schema = info.schema;
  const facts = [];
  const add = (label, value, plain = false) => facts.push(`<dt>${esc(label)}</dt><dd${plain ? ' class="plain"' : ''}>${value}</dd>`);
  add(t('help.type'), esc([typeOf(schema), schema.format].filter(Boolean).join(' · ')));
  if (schema.minimum !== undefined) add(t('help.minimum'), esc(schema.minimum));
  if (schema.exclusiveMinimum !== undefined && typeof schema.exclusiveMinimum === 'number') add(t('help.above'), esc(schema.exclusiveMinimum));
  if (schema.maximum !== undefined && Math.abs(schema.maximum) < 1e15) add(t('help.maximum'), esc(schema.maximum));
  if (schema.minLength !== undefined) add(t('help.minLength'), esc(t('help.chars', { n: schema.minLength })), true);
  if (schema.maxLength !== undefined) add(t('help.maxLength'), esc(t('help.chars', { n: schema.maxLength })), true);
  if (schema.maxItems !== undefined) add(t('help.maxItems'), esc(schema.maxItems));
  if (schema.pattern) add(t('help.pattern'), esc(schema.pattern));
  if (schema.enum) add(t('help.oneOf'), schema.enum.map(value => `<code>${esc(value)}</code>`).join(' '), true);
  if (info.currency) add(t('help.currency'), th('help.currencyFrom', { field: `<code>${esc(info.currency.name)}</code>`, values: (info.currency.values || []).map(esc).join(', ') }), true);
  const example = schema.example ?? (Array.isArray(schema.examples) ? schema.examples[0] : undefined) ?? info.example;
  if (example !== undefined) add(t('help.example'), esc(typeof example === 'string' ? example : JSON.stringify(example)));
  if (schema['x-lookup']?.url) add(t('help.options'), th('help.optionsFrom', { url: `<code>GET ${esc(schema['x-lookup'].url)}</code>` }), true);
  add(t('help.sentAs'), sentAs(info, schema, example ?? schema.enum?.[0]), true);
  const owner = info.parameter ? state.op?.operation.operationId || state.op?.title : schemaName(requestMedia().media?.schema, state.doc);
  const pointer = [owner, ...info.path].filter(item => item !== undefined && item !== '').join('.');
  return `<div class="pop toggletip" role="dialog" aria-label="${esc(t('help.about', { name: info.label }))}">
    <div class="tt-body">
      <h3 lang="en">${esc(info.label)}<span class="tag ${info.required ? 'tag-warn' : ''}">${esc(t(info.required ? 'help.required' : 'help.optional'))}</span></h3>
      ${schema.description ? `<p lang="en">${inline(schema.description)}</p>` : `<p>${esc(t('help.noDescription'))}</p>`}
      <dl class="facts">${facts.join('')}</dl>
    </div>
    <div class="tt-foot"><button type="button" class="link" data-action="view-docs">${esc(t('help.openDocs'))}</button>${pointer ? `<span class="ltr faint">${esc(pointer)}</span>` : ''}<span class="spacer"></span>${shortcutHint('escape')}</div>
  </div>`;
}
