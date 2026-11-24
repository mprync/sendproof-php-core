// The five questions and notices of Journeys mode, each a dialog (dialog.js; mocks v8, screens
// 160–167, m43–m45) built from the real run and the journey's expectations. The workbench never
// opens a native browser dialog. Each function resolves like openDialog: the chosen value, or null
// when the person dismissed it (Esc, the close button, a swipe). The numbers come from
// journeys-dialog-model.js; nothing here is invented, and a line the data can't support is left out.
import { dialogEnv, dialogHint, dialogLabel, dialogList, dialogMark, dialogNote, dialogOffer, dialogRow, ltr, openDialog } from './dialog.js';
import { esc, icon } from './components.js';
import { formatCommaList, formatDuration, formatList, formatNumber, formatShortDateTime, formatTime, formatUnit, has, t, th } from './i18n.js';
import { dataStores, recordCount, sqlSystem, storeMark, storeName } from './stores.js';
import { heldBy, moreIn, personaRoles, readsOnly, sendTargets, shortId, stepAccess } from './journeys-dialog-model.js';
import { initials } from './view.js';
import { storeBusy } from './journeys-session.js';

/** The name a step goes by on screen: its operation's title, else its description, else its ID. */
const stepTitle = step => step.op?.title || step.def?.description || step.stepId;

const databaseOf = capabilities => typeof capabilities?.database === 'string' ? capabilities.database : capabilities?.database?.name;
const ran = run => (run?.steps ?? []).flatMap((step, index) => ['pending', 'skipped'].includes(step.status) ? [] : [index]);

/** Step numbers (from 1) as people say them: "1 and 2", "1 to 3 and 5". Three or more in a row are a range. */
export function stepList(indexes) {
  const groups = [];
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const last = groups.at(-1);
    if (last && index === last.at(-1) + 1) last.push(index); else groups.push([index]);
  }
  return formatList(groups.flatMap(group => group.length >= 3
    ? [t('dlg.range', { from: formatNumber(group[0] + 1), to: formatNumber(group.at(-1) + 1) })]
    : group.map(index => formatNumber(index + 1))));
}

/** A length of time in words, in the largest sensible unit: "12 seconds", "2 minutes". */
export function spanText(ms) {
  return ms < 60_000 ? formatUnit(Math.max(1, Math.round(ms / 1000)), 'second', 0, 'long') : formatUnit(Math.round(ms / 60_000), 'minute', 0, 'long');
}

const cancel = () => ({ label: t('dlg.cancel'), value: false });

/* ---------- Send a run for real ---------- */

function targetRow(target) {
  if (target.system === 'email') {
    const to = target.recipients.length && target.recipients.length <= 2 ? formatList(target.recipients.map(ltr)) : '';
    return dialogRow({ mark: dialogMark('mail'), name: t('dlg.email'), sub: to ? th('dlg.email.to', { n: target.emails, to }) : esc(t('dlg.email.sent', { n: target.emails })) });
  }
  if (target.system === 'effect') return dialogRow({ mark: dialogMark('send'), name: target.effect, sub: esc(t('dlg.effect.sent', { n: target.count })) });
  const count = recordCount(target.system, target.records);
  let sub = esc(count);
  if (target.places.length) {
    const shown = target.places.slice(0, 3);
    const more = target.places.length - shown.length;
    const noun = target.kind === 'sql' || target.kind === 'item' ? 'table' : 'collection';
    const places = formatList(shown.map(esc));
    sub = more > 0 ? th(`dlg.store.inMore.${noun}`, { count: esc(count), places, n: more }) : th('dlg.store.in', { count: esc(count), places });
  }
  return dialogRow({ mark: storeMark(target.system, 16), name: storeName(target.system), code: target.database ?? '', sub });
}

/**
 * Starting a Send run: the environment and database, a row per store the journey's expectations
 * write to, and the reminder that a Preview run rolls back. Resolves true to send.
 */
export function confirmSendRun({ journey, capabilities, inputs, preview }) {
  const targets = sendTargets(journey, capabilities, { inputs });
  const content = [
    targets.length ? dialogLabel(t('dlg.sendrun.kept'), dialogEnv(capabilities?.environment, databaseOf(capabilities))) + dialogList(targets.map(targetRow))
      : dialogHint('info', t('dlg.sendrun.unknown')),
    preview ? dialogHint('flask', t('dlg.sendrun.hint')) : '',
  ].join('');
  return openDialog({
    tone: 'warn', glyph: 'send', title: esc(t('dlg.sendrun.title')),
    body: esc(t('dlg.sendrun.body', { name: journey.name, n: journey.steps.length })), content,
    actions: [cancel(), { label: t('dlg.sendrun.go'), kind: 'primary', value: true, icon: 'send', shortcut: 'send' }],
  });
}

/* ---------- End a Preview run partway ---------- */

/**
 * What a step's envelope wrote, in words: "7 rows, 3 documents, 1 email", or "reads only". Other
 * effects (a webhook, a message) are named only when nothing else was written, so the line stays short.
 */
export function heldText(envelope, sqlStore) {
  const held = heldBy(envelope, sqlStore);
  if (readsOnly(held)) return t('dlg.readsOnly');
  const parts = [...held.stores.map(item => recordCount(item.system, item.count)), ...(held.emails ? [t('dlg.held.emails', { n: held.emails })] : [])];
  if (!parts.length) parts.push(...held.kinds.map(item => item.kind ? t('dlg.held.effect', { n: formatNumber(item.count), kind: item.kind }) : t('dlg.held.effects', { n: item.count })));
  return formatCommaList(parts);
}

/** The End run body: the step, both steps, or all N steps (a language with its own dual still gets "both" here). */
export const endRunBody = n => t(n === 2 ? 'dlg.endrun.bodyTwo' : 'dlg.endrun.body', { n });

/**
 * Ending a Preview run that has run steps: the held session rolls them all back. One row per step
 * run, with its status, time and what it held. Resolves true to end the run.
 */
export function confirmEndRun({ journey, run, envelopes = [], heldMs, capabilities }) {
  const indexes = ran(run);
  const rows = indexes.map(index => {
    const step = run.steps[index];
    const good = ['passed'].includes(step.status);
    const status = step.httpStatus != null ? `${ltr(step.httpStatus)} · ` : '';
    return dialogRow({
      mark: good ? dialogMark('check', 'ok') : dialogMark('x', 'danger'), name: stepTitle(journey.steps[index]),
      sub: `${status}${esc(formatDuration(step.durationMs ?? 0))} · ${esc(heldText(envelopes[index], sqlSystem(capabilities)))}`,
    });
  });
  return openDialog({
    tone: 'neutral', glyph: 'flask', title: esc(t('dlg.endrun.title')),
    body: esc(endRunBody(indexes.length)), content: dialogList(rows),
    foot: heldMs != null ? dialogNote('clock', t('dlg.endrun.held', { time: spanText(heldMs) })) : '',
    actions: [{ label: t('dlg.endrun.keep'), value: false }, { label: t('dlg.endrun.end'), kind: 'primary', value: true }],
  });
}

/* ---------- Stop a Send run partway ---------- */

const MAX_LEFT = 4;

/** A fact about a change in words: "Pending", "NPK-JKT-BLK-M", "2 units". */
export const factText = fact => fact.kind === 'units' ? t('dlg.units', { n: formatNumber(fact.n) }) : String(fact.value);

/**
 * One line of what a Send left behind: the table and the record's business key (or a short ID),
 * then "Inserted by step 1" and one or two telling facts. `item` comes from the run's recorded
 * changes (`ref` and `facts` are worked out when the run is read, see journeys-dialog-model.js).
 */
export function leftParts(item) {
  const effect = item.store === 'effect';
  const what = effect ? t('dlg.op.email') : has(`dlg.op.${item.op}`) ? t(`dlg.op.${item.op}`) : String(item.op || t('dlg.op.write'));
  const detail = ['string', 'number'].includes(typeof item.detail) && String(item.detail).length <= 40 ? String(item.detail) : '';
  const facts = effect ? (detail ? [esc(detail)] : []) : (item.facts ?? []).map(fact => esc(factText(fact)));
  return {
    effect, name: effect && item.target === 'email' ? t('dlg.email') : String(item.target ?? ''), code: effect ? '' : item.ref ?? '',
    sub: [esc(t('dlg.stopsend.by', { what, n: formatNumber(item.step) })), ...facts].join(' · '),
  };
}

export function leftRow(item) {
  const { effect, name, code, sub } = leftParts(item);
  return dialogRow({ mark: effect ? dialogMark('mail') : storeMark(item.store, 16), name, code, sub });
}

/** "10 more in Stock, Payments, AuditEvents and 2 MongoDB collections": the rest, on one line. */
export function moreText(rest) {
  const where = moreIn(rest);
  const tables = where.tables.length > 3 ? [...where.tables.slice(0, 3), t('dlg.stopsend.moreTables', { n: where.tables.length - 3 })] : where.tables;
  const parts = [
    ...tables,
    ...where.stores.map(item => t('dlg.stopsend.moreStore', { n: item.count, store: storeName(item.system) })),
    ...(where.emails ? [t('dlg.held.emails', { n: where.emails })] : []),
    ...(where.effects ? [t('dlg.held.effects', { n: where.effects })] : []),
  ];
  return parts.length ? t('dlg.stopsend.moreIn', { n: formatNumber(rest.length), where: formatList(parts) }) : t('dlg.stopsend.more', { n: rest.length });
}

/** The undo row's line about itself: "Undoes step 1 for AS-2026-004641". */
export const undoSub = undo => undo.value != null && undo.value !== '' && undo.step
  ? t('dlg.stopsend.undoes', { n: formatNumber(undo.step), ref: undo.ref || shortId(undo.value) })
  : undo.step ? t('dlg.stopsend.undoesStep', { n: formatNumber(undo.step) }) : '';

/**
 * Stopping a Send run partway: steps already sent keep what they wrote. Lists what they left and,
 * when the journey's operations include an obvious undo (a cancel, void or refund of what a step
 * created), a row that opens it. Resolves true to stop, 'undo' to stop and open the undo.
 */
export function confirmStopSend({ journey, run, left, undo, capabilities }) {
  const sent = ran(run);
  const pending = (run?.steps ?? []).flatMap((step, index) => step.status === 'pending' ? [index] : []);
  const shown = left.slice(0, MAX_LEFT);
  const rest = left.length - shown.length;
  const rows = shown.map(item => leftRow(item));
  if (rest > 0) rows.push(dialogRow({ mark: dialogMark('more'), name: moreText(left.slice(MAX_LEFT)) }));
  const offer = undo ? dialogOffer({ value: 'undo', httpMethod: undo.op.method, name: undo.op.title || undo.op.operation?.summary || undo.op.path, sub: undoSub(undo) }) : '';
  const body = `${t('dlg.stopsend.sent', { steps: stepList(sent), n: sent.length })}${pending.length ? ` ${t('dlg.stopsend.skipped', { steps: stepList(pending), n: pending.length })}` : ''}`;
  return openDialog({
    tone: 'danger', glyph: 'stop', title: esc(t('dlg.stopsend.title')), body: esc(body),
    content: dialogLabel(t('dlg.stopsend.left'), dialogEnv(capabilities?.environment, databaseOf(capabilities))) + dialogList(rows) + offer,
    actions: [{ label: t('dlg.stopsend.keep'), value: false }, { label: t('dlg.stopsend.stop'), kind: 'danger', value: true, icon: 'stop' }],
  });
}

/* ---------- Switch persona while a Preview session is held ---------- */

const firstName = name => String(name ?? '').trim().split(/\s+/)[0] ?? '';
const roleText = roles => roles.join(', ');

/**
 * Switching persona while a Preview session is held ends it, so the question is who the person
 * becomes. Two cards (the held persona quiet, the next lifted); when the OpenAPI document says
 * which roles may call each step's operation, each card also shows one segment per step and the
 * steps the new persona would be refused are named. Without that, nothing is guessed.
 * `from` is the signed-in `{ name, role }`; `to` is the personas entry `{ name, role | roles }`;
 * `held` is how many steps the session holds. Resolves true to switch and end the run.
 */
export function confirmPersonaSwitch({ journey, from, to, held, document }) {
  const fromRoles = personaRoles(from);
  const toRoles = personaRoles(to);
  const fromAccess = stepAccess(journey, fromRoles, document);
  const toAccess = stepAccess(journey, toRoles, document);
  const showBars = !!(fromAccess && toAccess);
  const steps = journey.steps.map(stepTitle);
  const bar = access => {
    const total = steps.length;
    const ok = total - access.refused.length;
    const segments = steps.map((title, index) => `<span class="dl-seg${access.refused.includes(index) ? ' is-no' : ''}" title="${esc(t(access.refused.includes(index) ? 'dlg.persona.segRefused' : 'dlg.persona.seg', { n: formatNumber(index + 1), step: title }))}"></span>`).join('');
    return `<span class="dl-pc-access"><span class="dl-steps" role="img" aria-label="${esc(t('dlg.persona.access', { ok: formatNumber(ok), total: formatNumber(total), n: total }))}">${segments}</span><span class="dl-pc-count">${esc(t('dlg.persona.count', { ok: formatNumber(ok), total: formatNumber(total) }))}</span></span>`;
  };
  const card = ({ person, roles, alt, now, access }) => `<div class="dl-pc ${now ? 'is-now' : 'is-next'}">
      <span class="dl-pc-tag">${now ? `${icon('flask', true)}${esc(t('dlg.persona.held'))}` : esc(t('dlg.persona.next'))}</span>
      <span class="dl-pc-who"><span class="avatar dl-av${alt ? ' is-alt' : ''}" aria-hidden="true">${esc(initials(person.name))}</span>
        <span class="dl-text"><span class="dl-name" title="${esc(person.name)}">${esc(person.name)}</span>${roles.length ? `<span class="dl-sub"><span class="dl-role">${esc(roleText(roles))}</span></span>` : ''}</span></span>
      ${showBars ? bar(access) : ''}
    </div>`;
  const refused = toAccess?.refused ?? [];
  const refusedRow = refused.length ? dialogList([dialogRow({
    mark: dialogMark('lock', 'warn'), name: t('dlg.persona.refused', { n: refused.length }),
    sub: esc(t('dlg.persona.refusedSub', { n: refused.length, steps: formatList(refused.map(index => steps[index])), role: roleText(toRoles) })),
  })]) : '';
  const stay = from?.name ? t('dlg.persona.stay', { name: firstName(from.name) }) : t('dlg.persona.stayAnon');
  return openDialog({
    tone: 'neutral', glyph: 'user',
    head: `<span class="dl-pair" aria-hidden="true"><span class="avatar dl-av is-alt">${esc(initials(to.name))}</span><span class="dl-pair-badge">${icon('refresh')}</span></span>`,
    title: esc(t('dlg.persona.title', { name: to.name })),
    body: esc(from?.name ? t('dlg.persona.body', { from: from.name, n: held }) : t('dlg.persona.bodyAnon', { n: held })),
    content: `<div class="dl-people">${card({ person: from ?? { name: '' }, roles: fromRoles, now: true, access: fromAccess })}<span class="dl-hop" aria-hidden="true">${icon('arrow-right', true)}</span>${card({ person: to, roles: toRoles, alt: true, access: toAccess })}</div>${refusedRow}`,
    foot: dialogNote('undo', t('dlg.persona.foot', { n: held })),
    actions: [{ label: stay, value: false }, { label: t('dlg.persona.switch'), kind: 'primary', value: true }],
  });
}

/* ---------- The Preview session ended on its own ---------- */

/**
 * The stores a Preview session rolls back, each by its kind and, where it has one, its name, as
 * trusted HTML for a list: "SQLite store.db" and "MongoDB store".
 */
export function sessionStores(capabilities) {
  const database = databaseOf(capabilities);
  const sql = sqlSystem(capabilities);
  return [`${esc(storeName(sql))}${database ? ` ${ltr(database)}` : ''}`,
    ...dataStores(capabilities).filter(store => store.mode === 'preview' && store.system !== sql)
      .map(store => `${esc(storeName(store.system))}${store.name && store.name !== storeName(store.system) ? ` ${ltr(store.name)}` : ''}`)];
}

/**
 * A Preview session couldn't open because another one holds the SQL store (`store_busy`): another
 * tab's, or one a closed tab left behind. It ends by itself after `idleSeconds` (the problem says
 * how long). Resolves true to try again.
 */
export function confirmStoreBusy({ capabilities, idleSeconds }) {
  const system = sqlSystem(capabilities);
  const database = databaseOf(capabilities);
  const store = database || storeName(system);
  return openDialog({
    tone: 'warn', glyph: 'db', title: esc(t('dlg.busy.title', { store })),
    body: esc(idleSeconds > 0 ? t('dlg.busy.body', { time: spanText(idleSeconds * 1000) }) : t('dlg.busy.bodyNoTime')),
    content: dialogList([dialogRow({ mark: storeMark(system, 16), name: storeName(system), code: database ?? '', sub: esc(t('dlg.busy.held')) })]),
    actions: [{ label: t('dlg.close'), value: false }, { label: t('dlg.busy.again'), kind: 'primary', value: true, icon: 'refresh', focus: true }],
  });
}

/**
 * A Preview session couldn't open for any other reason: the problem's title and, when it has one,
 * its detail. Resolves true to try again.
 */
export function confirmOpenFailed({ title, detail }) {
  return openDialog({
    tone: 'warn', glyph: 'alert', title: esc(t('dlg.openfail.title')), body: esc(title),
    content: detail && detail !== title ? dialogHint('alert', detail) : '',
    actions: [{ label: t('dlg.close'), value: false }, { label: t('dlg.busy.again'), kind: 'primary', value: true, icon: 'refresh', focus: true }],
  });
}

/** The dialog for a refused or failed session open: the busy store's, else the problem's own title and detail. */
export function confirmSessionOpenFailed({ error, capabilities }) {
  if (storeBusy(error)) return confirmStoreBusy({ capabilities, idleSeconds: error.idleSeconds });
  return confirmOpenFailed({ title: error?.title || error?.message || '', detail: error?.detail });
}

/**
 * The held session was rolled back without the person asking (idle timeout, its maximum lifetime,
 * the host restarting). Says what is safe: steps that had run keep their results, nothing was
 * written. `idleSeconds` and `lastActivity` (ms) are used only when they explain it; an
 * unexplained end says so plainly. Resolves true to start the run again.
 */
export function confirmSessionEnded({ journey, run, capabilities, idleSeconds, lastActivity, now = Date.now() }) {
  const indexes = ran(run);
  const idle = idleSeconds > 0 && lastActivity != null && now - lastActivity >= idleSeconds * 900;
  const stores = sessionStores(capabilities);
  const rows = [
    ...(indexes.length ? [dialogRow({ mark: dialogMark('check', 'ok'), name: t('dlg.expired.ran', { steps: stepList(indexes), n: indexes.length }), sub: esc(t('dlg.expired.ranSub', { n: indexes.length })) })] : []),
    dialogRow({ mark: dialogMark('undo'), name: idle ? t('dlg.expired.rolledAt', { time: formatTime(lastActivity + idleSeconds * 1000) }) : t('dlg.expired.rolledBy', { time: formatTime(now) }), sub: formatList(stores) }),
  ];
  return openDialog({
    tone: 'warn', glyph: 'clock', title: esc(t('dlg.expired.title')),
    body: esc(idle ? t('dlg.expired.idle', { time: spanText(idleSeconds * 1000) }) : t('dlg.expired.gone')), content: dialogList(rows),
    actions: [{ label: t('dlg.close'), value: false }, { label: t('dlg.expired.again'), kind: 'primary', value: true, icon: 'refresh', focus: true }],
  });
}
