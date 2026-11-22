// Deprecated operations (mocks 88–90, m23): one notice in Try it and Docs that names the
// replacement, says when the operation stops working, and offers one action that opens the
// replacement with the matching parameters carried over.
//
//   x-replaced-by  an operationId string, or a list of { operationId, parameters, description }
//                  where parameters map the replacement's parameters to OpenAPI runtime
//                  expressions ($request.path.id), as an OpenAPI Link object does
//   x-sunset       the date the operation stops working; else the last response's Sunset header
//                  (RFC 8594); else "No sunset date in the spec"
import { dereference } from './api.js';
import { esc, icon, method } from './components.js';
import { current, formatDate, formatList, t, th } from './i18n.js';
import { shortcutAttrs } from './shortcuts.js';

/** Sunset headers seen in responses, by operation, for operations whose spec has no x-sunset. */
const seenSunset = new Map();

/** Remembers a response's Sunset header (an HTTP-date) for its operation. */
export function noteSunsetHeader(operation, headers) {
  const value = typeof headers?.get === 'function' ? headers.get('sunset') : Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'sunset')?.[1];
  const date = value ? new Date(value) : undefined;
  if (operation && date && Number.isFinite(date.valueOf())) seenSunset.set(operation, date.toISOString().slice(0, 10));
}

const PARAMETER = /^\$request\.(path|query|header)\.(.+)$/;

/**
 * What replaces a deprecated operation: [{ op, description, carry: [{ to, from, in }] }].
 * Without a mapping, parameters carry over by the same name, or by the same format and lookup.
 */
export function replacements(op, ops, document) {
  const raw = op.operation['x-replaced-by'];
  const list = !raw ? [] : Array.isArray(raw) ? raw : [raw];
  const parameters = target => (target.parameters || []).map(item => dereference(item, document)).filter(item => item?.name);
  const own = parameters(op);
  return list.map(item => {
    const entry = typeof item === 'string' ? { operationId: item } : item || {};
    const target = ops.find(candidate => candidate.operation.operationId === entry.operationId);
    if (!target) return undefined;
    const theirs = parameters(target);
    let carry;
    if (entry.parameters && typeof entry.parameters === 'object') {
      carry = Object.entries(entry.parameters).flatMap(([to, expression]) => {
        const match = PARAMETER.exec(String(expression));
        const destination = theirs.find(parameter => parameter.name === to);
        const source = match && own.find(parameter => parameter.in === match[1] && parameter.name === match[2]);
        return destination && source ? [{ to: destination.name, toIn: destination.in, from: source.name, fromIn: source.in }] : [];
      });
    } else {
      const lookupOf = parameter => (parameter.schema && dereference(parameter.schema, document))?.['x-lookup']?.url;
      const formatOf = parameter => (parameter.schema && dereference(parameter.schema, document))?.format;
      carry = theirs.flatMap(destination => {
        const source = own.find(parameter => parameter.name === destination.name && parameter.in !== 'header')
          ?? own.find(parameter => parameter.in !== 'header' && formatOf(parameter) && formatOf(parameter) === formatOf(destination) && lookupOf(parameter) && lookupOf(parameter) === lookupOf(destination));
        return source ? [{ to: destination.name, toIn: destination.in, from: source.name, fromIn: source.in }] : [];
      });
    }
    return { op: target, description: entry.description, carry };
  }).filter(Boolean);
}

/** The values to open a replacement with, from the deprecated operation's current inputs. */
export function carriedValues(replacement, values = {}) {
  const out = {};
  for (const { to, toIn, from, fromIn } of replacement.carry) {
    const value = values[`${fromIn}:${from}`];
    if (value !== undefined && value !== '') out[`${toIn}:${to}`] = value;
  }
  return out;
}

/** When the operation stops working: { iso, long, short, relative, past } or undefined. */
export function sunsetOf(op) {
  const iso = op.operation['x-sunset'] ? String(op.operation['x-sunset']).slice(0, 10) : seenSunset.get(op);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return undefined;
  const today = new Date();
  const days = Math.round((Date.parse(iso + 'T00:00:00Z') - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5);
  const months = Math.round(days / 30.44);
  const rtf = new Intl.RelativeTimeFormat(current().locale, { numeric: 'auto' });
  const relative = Math.abs(days) < 45 ? rtf.format(days, 'day') : Math.abs(months) < 24 ? rtf.format(months, 'month') : rtf.format(Math.round(days / 365.25), 'year');
  return {
    iso, relative, past: days < 0,
    long: formatDate(iso, { day: 'numeric', month: 'long', year: 'numeric' }),
    short: formatDate(iso, { day: 'numeric', month: 'short', year: 'numeric' }),
  };
}

/**
 * The notice. `where` is 'try' ("Open Get balance") or 'docs' ("Try Get balance"); `index`
 * finds an operation's position for the action's data-op attribute.
 */
export function deprecationNotice(op, { ops, document, where = 'try', index = item => ops.indexOf(item) }) {
  const reps = replacements(op, ops, document);
  const sunset = sunsetOf(op);
  const first = reps[0];
  const code = text => `<code>${esc(text)}</code>`;
  const carry = first?.carry.length ? formatList(first.carry.map(({ to, from }) => '\u0000' + (to === from ? code(from) : th('dep.carryAs', { from: code(from), to: code(to) })) + '\u0000'))
    .replace(/\u0000([^\u0000]*)\u0000/g, '$1') : '';
  const when = sunset
    ? `<span class="dep-sunset">${th(sunset.past ? 'dep.sunsetPast' : 'dep.sunset', { date: `<time datetime="${sunset.iso}">${esc(sunset.long)}</time>`, relative: esc(sunset.relative) })}</span>`
    : `<span class="dep-sunset">${esc(t('dep.noSunset'))}</span>`;
  // An explicit message from the spec (x-deprecation) leads; the replacements follow it.
  const message = op.operation['x-deprecation'] || op.operation['x-deprecated-message'];
  const said = message ? `<p class="dep-lede" lang="en">${esc(message)}</p>` : '';
  const body = said + (reps.length ? `<p class="dep-lede">${esc(t('dep.useInstead'))}</p>
      <ul class="dep-list">${reps.map(item => `<li><a class="dep-op" href="#${where === 'docs' ? 'docs' : 'op'}/${encodeURIComponent(item.op.operation.operationId)}" data-op="${index(item.op)}"${where === 'docs' ? ' data-op-view="docs"' : ''}>${method(item.op.method)}<span lang="en">${esc(item.op.title)}</span></a>${item.description ? `<span class="dep-why" lang="en">${esc(item.description)}</span>` : ''}</li>`).join('')}</ul>
      <div class="dep-actions"><button type="button" class="btn btn-sm" data-replace-op="${index(first.op)}" ${shortcutAttrs('open-replacement')}><span>${th(where === 'docs' ? 'dep.try' : 'dep.open', { name: `<span lang="en">${esc(first.op.title)}</span>` })}</span>${icon('arrow-right', true)}</button>${carry ? `<span class="dep-carry">${th('dep.carries', { list: carry })}</span>` : ''}</div>`
    : message ? '' : `<p class="dep-lede">${esc(t('dep.noReplacement'))}</p>`);
  return `<section class="dep" role="note" aria-labelledby="dep-h-${where}">
      <div class="dep-head">${icon('warn', true)}<strong id="dep-h-${where}">${esc(t('dep.title'))}</strong>${when}</div>
      ${body}
    </section>`;
}

/** The sidebar tooltip of a deprecated row: "Deprecated · sunset 30 Jun 2027 · Use Get balance or List balances." */
export function deprecationTip(op, ops, document) {
  const { head, use } = deprecationTipParts(op, ops, document);
  return [head, use].filter(Boolean).join(' · ');
}

/** The tooltip's two lines: "Deprecated · sunset 30 Jun 2027" and "Use Get balance or List balances." */
export function deprecationTipParts(op, ops, document) {
  const sunset = sunsetOf(op);
  const names = replacements(op, ops, document).map(item => item.op.title);
  return {
    head: [t('dep.title'), sunset ? t('dep.sunsetShort', { date: sunset.short }) : ''].filter(Boolean).join(' · '),
    use: names.length ? t('dep.tipUse', { list: formatList(names, 'disjunction') }) : '',
  };
}

let tipsBound = false;

/**
 * Shows the tooltip of a deprecated sidebar row on hover and keyboard focus, beside the row (the
 * inline-end side, mirrored in RTL). The row's accessible description carries the same text.
 */
export function bindDeprecationTips() {
  if (tipsBound || typeof document === 'undefined') return;
  tipsBound = true;
  let tip;
  const hide = () => { tip?.remove(); tip = undefined; };
  const show = row => {
    hide();
    const [title, ...rest] = row.dataset.depTip.split(' · ');
    const use = row.dataset.depUse || '';
    tip = document.createElement('div');
    tip.className = 'tooltip dep-tip';
    tip.setAttribute('role', 'tooltip');
    tip.id = 'dep-tip';
    tip.innerHTML = `<div class="row">${icon('warn', true)}<strong>${esc(title)}</strong>${rest.length ? `<span class="dim">· ${esc(rest.join(' · '))}</span>` : ''}</div>${use ? `<div class="sub">${esc(use)}</div>` : ''}`;
    document.body.append(tip);
    const box = row.getBoundingClientRect();
    const rtl = getComputedStyle(row).direction === 'rtl';
    tip.style.position = 'fixed';
    tip.style.left = `${Math.max(8, Math.min(rtl ? box.left - tip.offsetWidth - 8 : box.right + 8, innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${Math.max(8, box.top + box.height / 2 - tip.offsetHeight / 2)}px`;
    row.setAttribute('aria-describedby', tip.id);
  };
  document.addEventListener('pointerover', event => { const row = event.target.closest?.('.nav-item[data-dep-tip]'); if (row && event.pointerType !== 'touch') show(row); });
  document.addEventListener('pointerout', event => { if (event.target.closest?.('.nav-item[data-dep-tip]') && !event.relatedTarget?.closest?.('.nav-item[data-dep-tip]')) hide(); });
  document.addEventListener('focusin', event => { const row = event.target.closest?.('.nav-item[data-dep-tip]'); if (row) show(row); else hide(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && tip) hide(); });
  document.addEventListener('scroll', hide, true);
}
