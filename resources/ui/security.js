// What an operation needs before it can run, read from its OpenAPI security requirements.
import { dereference } from './api.js';
import { formatList } from './i18n.js';

/** The effective requirement list: the operation's own, else the document default. */
export function securityRequirements(op, document) {
  const raw = op?.operation?.security ?? document?.security ?? [];
  return raw.map(requirement => Object.entries(requirement || {}).map(([name, scopes]) => ({
    name, scopes: Array.isArray(scopes) ? scopes : [],
    scheme: dereference(document?.components?.securitySchemes?.[name], document) || {},
  })));
}

/** True when the operation can be called without signing in. */
export function isPublic(op, document) {
  const requirements = securityRequirements(op, document);
  return !requirements.length || requirements.some(alternative => !alternative.length);
}

/** Every scope the operation names, across its alternatives. */
export const requiredScopes = (op, document) =>
  [...new Set(securityRequirements(op, document).flatMap(alternative => alternative.flatMap(item => item.scopes)))];

/** The schemes of the first alternative, which is what the UI explains. */
export const primarySchemes = (op, document) => securityRequirements(op, document)[0] || [];

/** Scopes or roles as people read them: alternatives joined with "or", e.g. "admin or payments.approve". */
export function scopeText(op, document) {
  const alternatives = securityRequirements(op, document).map(alternative => alternative.flatMap(item => item.scopes)).filter(scopes => scopes.length);
  return alternatives.length ? formatList(alternatives.map(scopes => scopes.join(' + ')), 'disjunction') : '';
}
