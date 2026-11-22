// Formats with request-side checks. Custom formats are treated as annotations.
import { t } from '../i18n.js';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:z|([+-])(\d{2}):(\d{2}))$/i;
const pointerPattern = /^(?:\/(?:[^~/]|~[01])*)*$/;
const relativePointerPattern = /^(?:0|[1-9]\d*)(?:#|(?:\/(?:[^~/]|~[01])*)*)$/;
const hostnamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const emailLocalPattern = /^(?:[a-z0-9!#$%&'*+/=?^_{}|~-]+(?:\.[a-z0-9!#$%&'*+/=?^_{}|~-]+)*|"(?:[^"\\\r\n]|\\[ -~])*")$/i;

function isDate(value) {
  if (!datePattern.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isTime(value, date) {
  const match = timePattern.exec(value);
  if (!match) return false;
  const [, hours, minutes, seconds, sign, zoneHours = '0', zoneMinutes = '0'] = match;
  if (+hours > 23 || +minutes > 59 || +seconds > 60 || +zoneHours > 23 || +zoneMinutes > 59) return false;
  if (+seconds < 60) return true;
  const offset = (sign === '-' ? -1 : 1) * (+zoneHours * 60 + +zoneMinutes);
  const utcMinute = +hours * 60 + +minutes - offset;
  if ((utcMinute + 1440) % 1440 !== 1439) return false;
  if (!date) return true;
  const nextDay = new Date(date + 'T00:00:00Z');
  nextDay.setUTCDate(nextDay.getUTCDate() + 1 + Math.floor(utcMinute / 1440));
  return nextDay.getUTCDate() === 1;
}

function isDateTime(value) {
  const [date, time, ...rest] = value.split(/t/i);
  return time !== undefined && rest.length === 0 && isDate(date) && isTime(time, date);
}

function isIPv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && +part <= 255);
}

function isIPv6(value) {
  if (!/^[a-f0-9:.]+$/i.test(value) || !value.includes(':')) return false;
  try {
    return Boolean(new URL('http://[' + value + ']').hostname);
  } catch {
    return false;
  }
}

function isHostname(value) {
  const name = value.endsWith('.') ? value.slice(0, -1) : value;
  return name.length <= 253 && name.split('.').every(label => hostnamePattern.test(label));
}

function isInternationalHostname(value) {
  if (/^[\x00-\x7f]*$/.test(value)) return isHostname(value);
  if (/[\s:/?#@[\]\\%]/u.test(value)) return false;
  const labels = value.normalize('NFKC').replace(/[。｡．]/gu, '.');
  if (/(?:^|\.)-|-($|\.)/u.test(labels)) return false;
  try {
    return isHostname(new URL('http://' + value).hostname);
  } catch {
    return false;
  }
}

function isEmail(value, international = false) {
  const separator = value.lastIndexOf('@');
  const local = value.slice(0, separator);
  const host = value.slice(separator + 1);
  const normalizedLocal = international ? local.replace(/[^\x00-\x7f\s]/gu, 'a') : local;
  if (separator <= 0 || local.length > 64 || !emailLocalPattern.test(normalizedLocal)) return false;
  if (!international && /[^\x00-\x7f]/.test(local)) return false;
  if (host.startsWith('[') && host.endsWith(']')) {
    const address = host.slice(1, -1);
    return /^ipv6:/i.test(address) ? isIPv6(address.slice(5)) : isIPv4(address);
  }
  return !host.endsWith('.') && (international ? isInternationalHostname(host) : isHostname(host));
}

function isUri(value, relative, international = false) {
  if (/\s|%(?![a-f0-9]{2})|[\x00-\x1f\x7f]/i.test(value)) return false;
  if (!international && /[^\x21-\x7e]/.test(value)) return false;
  if (/[<>"{}|\\^\x60]/.test(value)) return false;

  const match = /^(?:([a-z][a-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#([^#]*))?$/i.exec(value);
  if (!match) return false;
  const [, scheme, authority, path, query = '', fragment = ''] = match;
  const requiresHost = /^(?:https?|wss?|ftp)$/i.test(scheme ?? '');
  if (!scheme && (!relative || (authority === undefined && path.split('/')[0].includes(':')))) return false;
  if (/[[\]]/.test(path + query + fragment)) return false;
  if (authority === undefined) return !requiresHost;

  const parts = /^(?:([^@[\]]*)@)?(\[[^\]]+\]|[^:[\]@]*)(?::\d*)?$/.exec(authority);
  if (!parts) return false;
  const host = parts[2];
  if (!host.startsWith('[')) return !requiresHost || host.length > 0;
  const address = host.slice(1, -1);
  return isIPv6(address) || /^v[0-9a-f]+\.[a-z0-9._~!$&'()*+,;=:-]+$/i.test(address);
}

function isUrl(value) {
  if (!isUri(value, false)) return false;
  try {
    return Boolean(new URL(value).href);
  } catch {
    return false;
  }
}

function isUriTemplate(value) {
  const variable = /^(?:[a-z0-9_]|%[0-9a-f]{2})+(?:\.(?:[a-z0-9_]|%[0-9a-f]{2})+)*(?:\*|:[1-9]\d{0,3})?$/i;
  const literal = /[\s<>"{}|\\^\x60]|%(?![a-f0-9]{2})/i;
  const remainder = value.replace(/\{([+#./;?&]?)([^{}]+)\}/g, (expression, _operator, variables) =>
    variables.split(',').every(name => variable.test(name)) ? '' : expression);
  return !literal.test(remainder);
}

function isDuration(value) {
  // RFC 3339 durations allow weeks alone or ordered date and time components.
  return /^P\d+W$/.test(value) ||
    /^P(?=\d|T)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/.test(value);
}

function isRegex(value) {
  try {
    new RegExp(value, 'u');
    return true;
  } catch {
    return false;
  }
}

// Each check is [test, message key]. Messages live in ui/locales/en-capture.js under valid.format.*.
const checks = new Map([
  ['email', [isEmail, 'valid.format.email']],
  ['idn-email', [value => isEmail(value, true), 'valid.format.email']],
  ['date', [isDate, 'valid.format.date']],
  ['time', [isTime, 'valid.format.time']],
  ['date-time', [isDateTime, 'valid.format.dateTime']],
  ['duration', [isDuration, 'valid.format.duration']],
  ['uuid', [value => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value), 'valid.format.uuid']],
  ['hostname', [isHostname, 'valid.format.hostname']],
  ['idn-hostname', [isInternationalHostname, 'valid.format.hostname']],
  ['ipv4', [isIPv4, 'valid.format.ipv4']],
  ['ipv6', [isIPv6, 'valid.format.ipv6']],
  ['url', [isUrl, 'valid.format.url']],
  ['uri', [value => isUri(value, false), 'valid.format.uri']],
  ['uri-reference', [value => isUri(value, true), 'valid.format.uriReference']],
  ['iri', [value => isUri(value, false, true), 'valid.format.iri']],
  ['iri-reference', [value => isUri(value, true, true), 'valid.format.iriReference']],
  ['uri-template', [isUriTemplate, 'valid.format.uriTemplate']],
  ['json-pointer', [value => pointerPattern.test(value), 'valid.format.jsonPointer']],
  ['relative-json-pointer', [value => relativePointerPattern.test(value), 'valid.format.relativeJsonPointer']],
  ['regex', [isRegex, 'valid.format.regex']],
  ['byte', [value => /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(value), 'valid.format.byte']],
]);

/** The message for a value that breaks its `format`, or undefined when it passes or the format is unchecked. */
export function formatError(format, value) {
  const check = checks.get(format);
  return check && !check[0](value) ? t(check[1], { example: '/items/{id}' }) : undefined;
}
