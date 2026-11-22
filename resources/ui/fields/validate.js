import { formatDate, formatList, formatNumber, t } from '../i18n.js';
import { title } from './dom.js';
import { createReferenceResolver } from './validation-references.js';
import {
  compilePattern, createValueKey, displayValue, isNumber, isObject, typeError,
  validateNumber, validateRange, validateString,
} from './validation-values.js';

const emptySet = new Set();
const withArticle = noun => /^[aeiou]/.test(noun) ? 'an' : 'a';
const hasValue = (object, key) => Object.hasOwn(object, key) && object[key] !== undefined;

/** Validate a request or response against its original schema and applicator scopes. */
export function validateSchema(context, schema, value, required) {
  const findReference = createReferenceResolver(context.document, schema);
  const resolveReference = ref => {
    const target = findReference(ref);
    if (target === undefined && typeof ref === 'string') context.unresolvedReferences?.add(ref);
    return target;
  };
  const excludedAnnotation = context.response ? 'writeOnly' : 'readOnly';
  const openApiVersion = context.document?.openapi;
  const legacyReferences = typeof openApiVersion === 'string' && openApiVersion.startsWith('3.0.');
  const allowNullable = legacyReferences || !(openApiVersion || schema?.$schema);
  const valueKey = createValueKey();
  const active = new Map();
  const shapes = new WeakMap();
  // Mounted controls treat a blank required control as missing. JSON strings have their supplied length.
  const isBlank = value => value === undefined || (value === '' && typeof context.set === 'function');

  function isExcluded(raw, seen = new Set()) {
    if (!raw || typeof raw !== 'object' || seen.has(raw)) return false;
    seen.add(raw);
    if (raw.$ref && isExcluded(resolveReference(raw.$ref), seen)) return true;
    if (raw.$ref && legacyReferences) return false;
    return raw[excludedAnnotation] === true || raw.allOf?.some(child => isExcluded(child, seen));
  }

  function schemaShape(raw) {
    if (!raw || typeof raw !== 'object') return { required: emptySet, properties: new Map(), excluded: emptySet };
    if (shapes.has(raw)) return shapes.get(raw);
    const shape = { required: new Set(), properties: new Map(), excluded: new Set() };
    const seen = new Set();

    function collect(part) {
      if (!part || typeof part !== 'object' || seen.has(part)) return;
      seen.add(part);
      if (part.$ref) {
        collect(resolveReference(part.$ref));
        if (legacyReferences) return;
      }
      for (const child of part.allOf ?? []) collect(child);
      for (const name of part.required ?? []) shape.required.add(name);
      for (const [name, child] of Object.entries(part.properties ?? {})) {
        shape.properties.set(name, child);
        if (isExcluded(child)) shape.excluded.add(name);
      }
    }

    collect(raw);
    shapes.set(raw, shape);
    return shape;
  }

  /** The type, format, enum, lookup and title of a field, read through $ref and allOf. */
  function describeField(raw) {
    const field = {};
    const seen = new Set();
    (function collect(part) {
      if (!part || typeof part !== 'object' || seen.has(part)) return;
      seen.add(part);
      if (part.$ref) collect(resolveReference(part.$ref));
      for (const child of part.allOf ?? []) collect(child);
      for (const key of ['title', 'type', 'format', 'enum', 'x-lookup', 'minItems']) {
        if (part[key] !== undefined) field[key] = part[key];
      }
    })(raw);
    return field;
  }

  /** Says what to enter for a missing required value, by the kind of field it is. */
  function requiredMessage(raw, path) {
    const field = describeField(raw);
    const last = path.at(-1);
    const label = typeof last === 'string' && last ? last : field.title;
    const noun = label ? title(label).toLowerCase().replace(/ id$/, '') : t('valid.missing.valueNoun');
    const type = [].concat(field.type ?? []).find(item => item !== 'null');
    if (field['x-lookup']) return t('valid.missing.lookup', { article: withArticle(noun), name: noun });
    if (Array.isArray(field.enum) && field.enum.length) {
      const choices = field.enum.slice(0, 5).map(option => typeof option === 'string' ? option : displayValue(option));
      return field.enum.length > 5
        ? t('valid.missing.enumMore', { list: formatList(choices, 'unit') })
        : t('valid.missing.enum', { list: formatList(choices, 'disjunction') });
    }
    if (type === 'boolean') return t('valid.missing.boolean');
    if (type === 'array') return t('valid.missing.array', { n: Math.max(1, Number(field.minItems) || 1) });
    if (type === 'integer') return t('valid.missing.integer', { example: formatNumber(1250) });
    if (type === 'number') {
      return t('valid.missing.number', { example: formatNumber(1250, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) });
    }
    if (field.format === 'date') return t('valid.missing.date', { example: formatDate('2026-11-23') });
    if (field.format === 'email' || field.format === 'idn-email') return t('valid.missing.email');
    return t('valid.missing.text', { article: withArticle(noun), name: noun });
  }

  function missing(raw, path, errors, seen = new Set()) {
    const { required, properties, excluded } = schemaShape(raw);
    const children = [...required].filter(name => !excluded.has(name));
    if (!children.length || seen.has(raw)) {
      errors.push({ path: path.join('.'), message: requiredMessage(raw, path) });
      return;
    }
    seen.add(raw);
    for (const name of children) missing(properties.get(name), [...path, name], errors, seen);
    seen.delete(raw);
  }

  function visit(raw, current, path, inheritedExcluded = emptySet) {
    const errors = [];
    const evaluated = new Set();
    const add = (message, location = path) => errors.push({ path: location.join('.'), message });
    const result = { errors, evaluated };
    if (raw === false) add(t('valid.notAllowed'));
    if (!raw || typeof raw !== 'object') return result;

    // Recursive references can reapply a schema to the same instance without descending.
    let instances = active.get(raw);
    if (instances?.has(current)) return result;
    if (!instances) active.set(raw, instances = new Set());
    instances.add(current);

    function merge(child) {
      if (child.errors.length) errors.push(...child.errors);
      else for (const key of child.evaluated) evaluated.add(key);
    }

    try {
      const excluded = isObject(current) && schemaShape(raw).excluded.size
        ? new Set([...inheritedExcluded, ...schemaShape(raw).excluded])
        : inheritedExcluded;
      const apply = part => visit(part, current, path, excluded);

      if (raw.$ref) {
        merge(apply(resolveReference(raw.$ref)));
        if (legacyReferences) return result;
      }

      const mismatch = typeError(raw, current, allowNullable);
      if (mismatch) {
        add(mismatch);
        return result;
      }
      if (raw.const !== undefined && valueKey(raw.const) !== valueKey(current)) {
        add(t('valid.const', { value: displayValue(raw.const) }));
      }
      if (Array.isArray(raw.enum)) {
        const key = valueKey(current);
        if (!raw.enum.some(option => valueKey(option) === key)) {
          const choices = raw.enum.slice(0, 5).map(displayValue).join(', ');
          add(!choices ? t('valid.enum') : t(raw.enum.length > 5 ? 'valid.enumMore' : 'valid.enumChoices', { choices }));
        }
      }

      for (const part of raw.allOf ?? []) merge(apply(part));
      for (const keyword of ['anyOf', 'oneOf']) {
        if (!Array.isArray(raw[keyword])) continue;
        const choices = raw[keyword].map(apply);
        const matches = choices.filter(choice => !choice.errors.length);
        if (!matches.length) {
          const names = raw[keyword].map((option, index) => variantName(option, index));
          const preferred = preferredVariant(raw, keyword, current, path);
          const fewestErrors = Math.min(...choices.map(choice => choice.errors.length));
          const closest = choices.filter(choice => choice.errors.length === fewestErrors);
          if (choices[preferred]) merge(choices[preferred]);
          else if (closest.length === 1) merge(closest[0]);
          add(t(keyword === 'oneOf' ? 'valid.oneOf' : 'valid.anyOf', { names: formatList(names, 'unit') }));
        } else if (keyword === 'oneOf' && matches.length > 1) {
          const names = raw[keyword].flatMap((option, index) => choices[index].errors.length ? [] : [variantName(option, index)]);
          add(t('valid.oneOfMany', { names: formatList(names, 'unit') }));
        } else {
          for (const match of matches) merge(match);
        }
      }
      if (raw.not !== undefined && !apply(raw.not).errors.length) {
        const name = schemaName(raw.not);
        add(name ? t('valid.notNamed', { name }) : t('valid.notSchema'));
      }
      if (raw.if !== undefined) {
        const condition = apply(raw.if);
        if (!condition.errors.length) {
          merge(condition);
          if (raw.then !== undefined) merge(apply(raw.then));
        } else if (raw.else !== undefined) {
          merge(apply(raw.else));
        }
      }

      if (isObject(current)) {
        validateObject(raw, current, path, excluded, evaluated, errors, add, merge, apply);
      } else if (Array.isArray(current)) {
        validateArray(raw, current, path, evaluated, errors, add);
      } else if (typeof current === 'string') {
        validateString(raw, current, add);
      } else if (isNumber(current)) {
        validateNumber(raw, current, add);
      }
      return result;
    } finally {
      instances.delete(current);
      if (!instances.size) active.delete(raw);
    }
  }

  function schemaName(option) {
    return option?.title ?? resolveReference(option?.$ref)?.title;
  }

  function variantName(option, index) {
    return schemaName(option) ?? option?.$ref?.split('/').at(-1) ?? option?.type?.toString() ?? t('valid.option', { n: index + 1 });
  }

  function preferredVariant(raw, keyword, current, path) {
    const renderedKeyword = raw.oneOf?.length ? 'oneOf' : 'anyOf';
    const selected = keyword === renderedKeyword ? context.variants?.get(JSON.stringify(path)) : undefined;
    if (selected !== undefined) return selected;
    const discriminator = raw.discriminator;
    if (!discriminator?.propertyName || !isObject(current)) return;
    const value = current[discriminator.propertyName];
    if (value === undefined) return;
    return raw[keyword].findIndex(option => {
      const mapped = discriminator.mapping && Object.hasOwn(discriminator.mapping, value) && discriminator.mapping[value];
      if (mapped) return option?.$ref === mapped || option?.$ref === '#/components/schemas/' + mapped;
      const property = schemaShape(option).properties.get(discriminator.propertyName);
      return property?.const === value || property?.enum?.includes(value) || option?.$ref?.split('/').at(-1) === value;
    });
  }

  function validateObject(raw, current, path, excluded, evaluated, errors, add, merge, apply) {
    const keys = Object.keys(current).filter(key => hasValue(current, key));
    const properties = raw.properties ?? {};
    const patterns = Object.entries(raw.patternProperties ?? {}).map(([pattern, child]) => [compilePattern(pattern), child]);
    validateRange(keys.length, raw.minProperties, raw.maxProperties, 'property', add);
    for (const name of raw.required ?? []) {
      if (!excluded.has(name) && (!hasValue(current, name) || isBlank(current[name]))) {
        missing(Object.hasOwn(properties, name) ? properties[name] : undefined, [...path, name], errors);
      }
    }

    for (const key of keys) {
      const childPath = [...path, key];
      const named = Object.hasOwn(properties, key);
      const matching = patterns.filter(([pattern]) => pattern?.test(key));
      if (named || matching.length || raw.additionalProperties !== undefined) evaluated.add(key);
      if (!excluded.has(key)) {
        if (named && !(raw.required?.includes(key) && isBlank(current[key]))) {
          errors.push(...visit(properties[key], current[key], childPath).errors);
        }
        for (const [, child] of matching) errors.push(...visit(child, current[key], childPath).errors);
        if (!named && !matching.length) validateExtraProperty(raw.additionalProperties, current[key], childPath, errors, add);
      }

      if (raw.propertyNames !== undefined) {
        for (const error of visit(raw.propertyNames, key, childPath).errors) {
          add(t('valid.renameProperty', { name: displayValue(key), reason: error.message }), childPath);
        }
      }
    }

    for (const [trigger, dependency] of Object.entries(raw.dependencies ?? {})) {
      if (!hasValue(current, trigger)) continue;
      if (Array.isArray(dependency)) requireDependencies(trigger, dependency);
      else merge(apply(dependency));
    }
    for (const [trigger, names] of Object.entries(raw.dependentRequired ?? {})) {
      if (hasValue(current, trigger)) requireDependencies(trigger, names);
    }
    for (const [trigger, child] of Object.entries(raw.dependentSchemas ?? {})) {
      if (hasValue(current, trigger)) merge(apply(child));
    }

    if (!errors.length && raw.unevaluatedProperties !== undefined) {
      for (const key of keys) {
        if (evaluated.has(key)) continue;
        evaluated.add(key);
        if (!excluded.has(key)) validateExtraProperty(raw.unevaluatedProperties, current[key], [...path, key], errors, add);
      }
    }

    function requireDependencies(trigger, names) {
      for (const name of names) {
        if (!excluded.has(name) && (!hasValue(current, name) || isBlank(current[name]))) {
          add(t('valid.requiredWhen', { trigger: displayValue(trigger) }), [...path, name]);
        }
      }
    }
  }

  function validateExtraProperty(raw, current, path, errors, add) {
    if (raw === false) add(t('valid.removeProperty', { name: displayValue(path.at(-1)) }), path);
    else if (raw !== undefined) errors.push(...visit(raw, current, path).errors);
  }

  function validateArray(raw, current, path, evaluated, errors, add) {
    validateRange(current.length, raw.minItems, raw.maxItems, 'item', add);
    const seen = new Map();
    const prefix = raw.prefixItems ?? (Array.isArray(raw.items) ? raw.items : []);
    const rest = Array.isArray(raw.items) ? raw.additionalItems : raw.items;
    let contains = 0;
    for (let index = 0; index < current.length; index++) {
      const item = current[index];
      const childPath = [...path, index];
      if (raw.uniqueItems === true) {
        const key = valueKey(item);
        if (seen.has(key)) {
          add(t('valid.duplicateItem', { n: seen.get(key) + 1 }), childPath);
        } else {
          seen.set(key, index);
        }
      }
      const child = index < prefix.length ? prefix[index] : rest;
      if (child !== undefined) {
        evaluated.add(index);
        validateItem(child, item, childPath, errors, add);
      }
      if (raw.contains !== undefined && !visit(raw.contains, item, childPath).errors.length) {
        evaluated.add(index);
        contains++;
      }
    }
    if (raw.contains !== undefined) {
      const name = schemaName(raw.contains);
      const expected = name ? t('valid.contains.name', { name })
        : raw.contains?.const !== undefined ? t('valid.contains.const', { value: displayValue(raw.contains.const) })
        : raw.contains?.type ? t('valid.contains.type', { type: raw.contains.type })
        : t('valid.contains.schema');
      validateRange(contains, raw.minContains ?? 1, raw.maxContains, 'contains', add, { expected });
    }
    if (!errors.length && raw.unevaluatedItems !== undefined) {
      for (let index = 0; index < current.length; index++) {
        if (evaluated.has(index)) continue;
        evaluated.add(index);
        validateItem(raw.unevaluatedItems, current[index], [...path, index], errors, add);
      }
    }
  }

  function validateItem(raw, item, path, errors, add) {
    if (raw === false) add(t('valid.removeItem'), path);
    else if (isBlank(item)) missing(raw, path, errors);
    else errors.push(...visit(raw, item, path).errors);
  }

  const errors = [...context.parseErrors.values()];
  if (isBlank(value) && required) missing(schema, [], errors);
  else if (value !== undefined) errors.push(...visit(schema, value, []).errors);
  const reported = new Set();
  return errors.filter(error => {
    const key = JSON.stringify([error.path, error.message]);
    if (reported.has(key)) return false;
    reported.add(key);
    return true;
  });
}
