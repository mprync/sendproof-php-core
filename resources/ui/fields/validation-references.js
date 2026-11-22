function pointerTarget(root, fragment) {
  let target = root;
  for (const part of fragment.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (target == null || !Object.hasOwn(target, key)) return;
    target = target[key];
  }
  return target;
}

const schemaMaps = ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas', 'dependencies'];
const schemaLists = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const subschemas = [
  'not', 'if', 'then', 'else', 'items', 'contains', 'additionalItems', 'unevaluatedItems',
  'additionalProperties', 'unevaluatedProperties', 'propertyNames',
];

function anchorTarget(schema, fragment, visited = new Set()) {
  if (!schema || typeof schema !== 'object' || visited.has(schema)) return;
  visited.add(schema);
  if (schema.$anchor === fragment) return schema;
  if (Array.isArray(schema)) {
    for (const child of schema) {
      const found = anchorTarget(child, fragment, visited);
      if (found) return found;
    }
    return;
  }

  const children = [
    ...schemaMaps.flatMap(key => Object.values(schema[key] ?? {})),
    ...schemaLists.flatMap(key => schema[key] ?? []),
    ...subschemas.map(key => schema[key]),
  ];
  for (const child of children) {
    const found = anchorTarget(child, fragment, visited);
    if (found) return found;
  }
}

/** Resolve references supplied with the schema or OpenAPI document. */
export function createReferenceResolver(document, schema) {
  const cache = new Map();
  return ref => {
    if (typeof ref !== 'string' || !ref.startsWith('#')) return;
    if (!cache.has(ref)) {
      let target;
      try {
        const fragment = decodeURIComponent(ref.slice(1));
        if (!fragment) target = document?.openapi ? document : schema;
        else if (fragment.startsWith('/')) target = pointerTarget(document, fragment) ?? pointerTarget(schema, fragment);
        else {
          target = anchorTarget(schema, fragment) ?? anchorTarget(document, fragment);
          if (!target) {
            for (const component of Object.values(document?.components?.schemas ?? {})) {
              target = anchorTarget(component, fragment);
              if (target) break;
            }
          }
        }
      } catch {
        // Invalid URI fragments are unresolved references.
      }
      cache.set(ref, target);
    }
    return cache.get(ref);
  };
}
