/** DOM helpers shared by the schema field renderers. */
export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function title(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ').replace(/^./, character => character.toUpperCase());
}

export function svg(icon) {
  const graphic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  graphic.setAttribute('class', 'i i-sm');
  graphic.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${icon}`);
  graphic.append(use);
  return graphic;
}

export function typeDescription(schema, type) {
  if (typeof schema['x-sendproof-type-label'] === 'string') return schema['x-sendproof-type-label'];
  const parts = [type === 'array' && schema.items?.type ? schema.items.type + '[]' : schema.format || (schema.enum ? 'enum' : type)];
  if (schema.minimum != null) parts.push(`${schema.exclusiveMinimum === true ? '>' : '≥'} ${schema.minimum}`);
  if (schema.maximum != null && Math.abs(schema.maximum) < 1e15) parts.push(`${schema.exclusiveMaximum === true ? '<' : '≤'} ${schema.maximum}`);
  if (typeof schema.exclusiveMinimum === 'number') parts.push(`> ${schema.exclusiveMinimum}`);
  if (typeof schema.exclusiveMaximum === 'number') parts.push(`< ${schema.exclusiveMaximum}`);
  if (schema.minLength != null) parts.push(`min ${schema.minLength}`);
  if (schema.maxLength != null) parts.push(`max ${schema.maxLength}`);
  if (schema.minItems != null) parts.push(`min ${schema.minItems}`);
  if (schema.maxItems != null) parts.push(`max ${schema.maxItems}`);
  return parts.join(' · ');
}
