/** Conservative defaults derived only from the supplied OpenAPI document. */
function singular(segment) {
  const word = segment.toLowerCase();
  if (word.endsWith('ies') && word.length > 3) return `${word.slice(0, -3)}y`;
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 1) return word.slice(0, -1);
  return null;
}

function matchesProperty(name, collection) {
  const stem = name.replace(/(?:_id|Id|ID)$/, '');
  if (stem === name) return false;
  const match = stem.slice(-collection.length);
  const boundary = stem.length === collection.length || /[_-]/.test(stem.at(-collection.length - 1)) || /^[A-Z]/.test(match);
  return boundary && match.toLowerCase() === collection;
}

/** Infer a lookup only when exactly one documented collection fits the field. */
export function inferLookup(context, schema, name) {
  if (Object.hasOwn(schema, 'x-lookup') || schema.enum) return schema['x-lookup'];
  const fieldType = context.kind(schema);
  if (!['string', 'integer'].includes(fieldType)) return undefined;
  const candidates = [];
  const directCollection = context.operationPath?.endsWith('/{' + name + '}') ?
    context.operationPath.slice(0, -name.length - 3) : undefined;
  for (const [path, rawPath] of Object.entries(context.document.paths || {})) {
    if (!path.startsWith('/') || /[{}?#]/.test(path)) continue;
    const collection = singular(path.split('/').filter(Boolean).at(-1) || '');
    if (path !== directCollection && (!collection || !matchesProperty(name, collection))) continue;
    const pathItem = context.resolve(rawPath);
    const operation = pathItem.get;
    if (!operation) continue;
    const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])]
      .map(parameter => context.resolve(parameter));
    if (parameters.some(parameter => parameter.required || parameter.in === 'path')) continue;
    const search = parameters.find(parameter => parameter.in === 'query' && /^(search|q|query)$/i.test(parameter.name));
    const options = [];
    for (const [status, rawResponse] of Object.entries(operation.responses || {})) {
      if (!/^2\d\d$/.test(status)) continue;
      const response = context.resolve(rawResponse);
      for (const [mediaType, media] of Object.entries(response.content || {})) {
        if (!/^application\/(?:[^;]+\+)?json(?:;|$)/i.test(mediaType)) continue;
        const array = context.resolve(media.schema);
        if (context.kind(array) !== 'array') continue;
        const item = context.resolve(array.items);
        const properties = item.properties || {};
        const idNames = Object.keys(properties).filter(key => key.toLowerCase() === 'id');
        const labelNames = Object.keys(properties).filter(key => ['name', 'label'].includes(key.toLowerCase()));
        if (idNames.length !== 1 || (labelNames.length !== 1 && path !== directCollection)) continue;
        const valueField = idNames[0];
        const labelField = labelNames[0] || (['reference', 'title', 'description'].find(key => properties[key])) || valueField;
        if (context.kind(context.resolve(properties[valueField])) !== fieldType) continue;
        if (labelField !== valueField && context.kind(context.resolve(properties[labelField])) !== 'string') continue;
        options.push({ url: path, valueField, labelField, ...(search ? { searchParam: search.name } : {}) });
      }
    }
    if (options.length === 1) candidates.push(options[0]);
    else if (options.length > 1) return undefined;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Pair amount with currency only for one clearly named, type-compatible pair. */
export function inferCurrency(context, entries) {
  const amounts = entries.filter(([name, schema]) => name.toLowerCase() === 'amount' && ['number', 'integer'].includes(context.kind(context.resolve(schema))));
  const currencies = entries.filter(([name, schema]) => name.toLowerCase() === 'currency' && context.kind(context.resolve(schema)) === 'string');
  if (amounts.length !== 1 || currencies.length !== 1) return entries;
  if (entries.some(([, schema]) => Object.hasOwn(context.resolve(schema), 'x-currency-field'))) return entries;
  const [amountName] = amounts[0];
  const [currencyName] = currencies[0];
  return entries.map(([name, schema]) => name === amountName ? [name, { ...context.resolve(schema), 'x-currency-field': currencyName }] : [name, schema]);
}
