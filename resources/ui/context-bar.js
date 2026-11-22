// The head row of the main column, the same in Try it, Docs, Models and the overview: where you
// are (breadcrumbs) at the start, how to switch views or go back at the end. It is exactly one
// tab tall, so it lines up with the sidebar tabs and the right column's head row.
//
//   Operation:   Payments › Create payment                       [Try it | Docs]
//   From an op:  Payments › Create payment › Payment             [← Back to Create payment ⌥←]
//                with followed $refs: … › Payment › Counterparty [← Back to Payment ⌥←]
//   From Models: Models › Resources › Payment                    (no Back control)
//
// Earlier crumbs are links. On a phone CSS shows only the last crumb and the Back button. A row
// that is short of room wraps the view switch to a second line rather than squeezing the crumbs
// (see .ctx-bar in styles.css).
import { esc, icon } from './components.js';
import { t } from './i18n.js';
import { shortcutAttrs, shortcutHint, shortcutLong } from './shortcuts.js';
import { formatRoute, backTarget } from './router.js';
import { modelGroupOf } from './schema-model.js';

/** The Try it | Docs segmented switch. `view` is "try" or "docs". D toggles it. */
export function viewSwitch(view) {
  return `<div class="segmented view-switch" role="group" aria-label="${esc(t('op.view'))}">
    <button type="button" data-action="view-try" aria-pressed="${view === 'try'}" ${view === 'try' ? '' : shortcutAttrs('docs')}>${icon('flask', true)}${esc(t('op.tryIt'))}</button>
    <button type="button" data-action="view-docs" aria-pressed="${view === 'docs'}" ${view === 'docs' ? '' : shortcutAttrs('docs')}>${icon('book', true)}${esc(t('op.docs'))}</button>
  </div>`;
}

/** The ordered list of crumbs. Each is `{ label, href?, attrs?, here? }`; spec text carries lang="en". */
function crumbList(c) {
  const link = (label, href, attrs = '', lang = true) => ({ label, href, attrs, lang });
  if (c.kind === 'overview') return [{ label: t('overview.crumb'), here: true }];
  if (c.kind === 'op') {
    return [link(c.op.group, '#', `data-crumb-tag="${esc(c.op.group)}"`), { label: c.op.title, here: true, lang: true }];
  }
  // A model page.
  const route = c.route;
  const trail = (route.via ?? []).map((name, index) => link(name, formatRoute({ ...route, name, via: route.via.slice(0, index) }), `data-crumb-route`));
  if (c.from) {
    const fromRoute = { kind: route.from.kind, id: route.from.id };
    return [
      link(c.from.group, '#', `data-crumb-tag="${esc(c.from.group)}"`),
      link(c.from.title, formatRoute(fromRoute), 'data-crumb-route'),
      ...trail,
      { label: route.name, here: true, lang: true },
    ];
  }
  const group = modelGroupOf(route.name, c.document);
  return [
    link(t('side.models'), '#', 'data-crumb-models', false),
    link(t('models.group.' + group), '#', `data-crumb-model-group="${esc(group)}"`, false),
    ...trail,
    { label: route.name, here: true, lang: true },
  ];
}

/**
 * The one Back control of a model page opened from an operation, labelled with where it goes
 * ("Back to Payment") and the shortcut. Models picked in the Models tab have no Back.
 */
function backButton(c) {
  const target = c.route.kind === 'model' ? backTarget(c.route) : null;
  if (!target) return '';
  const name = target.label.kind === 'model' ? target.label.name : c.from?.title ?? target.label.id;
  const label = t('back.to', { name });
  return `<button type="button" class="btn btn-ghost btn-xs back-btn" data-action="model-back" ${shortcutAttrs('model-back')} title="${esc(`${label} (${shortcutLong('model-back')})`)}">${icon('arrow-left', true)}<span class="back-label" lang="en">${esc(label)}</span>${shortcutHint('model-back')}</button>`;
}

/**
 * The head row markup.
 * @param {{ kind: 'overview'|'op'|'model', view?: 'try'|'docs', op?: object, route?: object, from?: object, document?: object }} c
 *   `from` is the operation a model was opened from.
 */
export function contextBar(c) {
  const list = crumbList(c);
  // Every crumb carries its full text as a title: a long name ends in an ellipsis when the row is
  // short of room, and the title (hover, long-press, assistive technology) still gives all of it.
  const crumbs = list.map(item => item.here
    ? `<li><span aria-current="page"${item.lang ? ' lang="en"' : ''} title="${esc(item.label)}">${esc(item.label)}</span></li>`
    : `<li><a href="${esc(item.href)}" ${item.attrs}${item.lang ? ' lang="en"' : ''} title="${esc(item.label)}">${esc(item.label)}</a></li>`).join('');
  const end = c.kind === 'op' ? viewSwitch(c.view) : c.kind === 'model' ? backButton(c) : '';
  // `--parents` tells the stylesheet how much room the earlier crumbs need (see .ctx-bar in styles.css).
  return `<div class="ctx-bar"><nav class="crumbs" aria-label="${esc(t('crumbs'))}" style="--parents:${list.length - 1}"><ol>${crumbs}</ol></nav><div class="end">${end}</div></div>`;
}
