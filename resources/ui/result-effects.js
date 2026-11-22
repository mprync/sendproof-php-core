import { esc, icon } from './components.js';
import { t, th } from './i18n.js';

// Each kind of side effect: its icon, the message keys for its label and status, and the data
// fields shown as metadata (anything else is listed under "Data").
const effectKinds = new Map([
  ['email', { glyph: 'mail', fields: ['from', 'to', 'cc', 'subject', 'text', 'html'] }],
  ['http', { glyph: 'globe', fields: ['method', 'url', 'status', 'body'] }],
  ['job', { glyph: 'clock', fields: ['name', 'queue', 'runAt', 'arguments'] }],
  ['message', { glyph: 'send', fields: ['topic', 'key', 'payload'] }],
]);
const otherKind = { glyph: 'send', fields: [] };

const present = value => value != null && value !== '';
const addresses = value => Array.isArray(value) ? value.join(', ') : value;
const display = value => typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
const chevron = () => `<span class="capture-chevron">${icon('chevron-right', true, 'faint')}</span>`;

/** A definition list of labelled values. Each field is [label id, captured value]; empty values are skipped. */
function metadata(fields) {
  const entries = fields.filter(([, value]) => present(value));
  return entries.length ? `<dl class="mail-meta">${entries.map(([id, value]) =>
    `<dt>${esc(t('fx.field.' + id))}</dt><dd>${id === 'subject' ? `<strong>${esc(value)}</strong>` : esc(value)}</dd>`).join('')}</dl>` : '';
}

/** A labelled block of captured data, shown as received (objects as indented JSON). */
function payload(id, body) {
  return body == null ? '' : `<div class="fx-payload"><div class="faint">${esc(t('fx.field.' + id))}</div>
    <pre class="mail-preview">${esc(display(body))}</pre></div>`;
}

function emailMarkup(data, id) {
  const html = typeof data.html === 'string' && data.html.trim();
  const text = typeof data.text === 'string' && data.text.trim();
  return metadata([['from', data.from], ['to', addresses(data.to)], ['cc', addresses(data.cc)], ['subject', data.subject]]) +
    (text ? `<div class="mail-preview" aria-label="${esc(t('fx.emailPreview'))}">${data.text.trim().split(/\r?\n[ \t]*\r?\n+/).map(
      paragraph => `<p>${esc(paragraph)}</p>`).join('')}</div>` : '') +
    (html ? `<div class="fx-acts">
      <button type="button" class="btn btn-sm" data-mail-view="html" aria-controls="${id}-html" aria-expanded="false">${icon('eye', true)}${esc(t('fx.openHtml'))}</button>
      <button type="button" class="btn btn-ghost btn-sm" data-mail-view="source" aria-controls="${id}-source" aria-expanded="false">${icon('code', true)}${esc(t('fx.source'))}</button></div>
      <div id="${id}-html" data-mail-panel hidden></div>
      <pre id="${id}-source" class="mail-preview mail-source" data-mail-panel aria-label="${esc(t('fx.htmlSource'))}" hidden>${esc(data.html)}</pre>` : '');
}

function effectContent(kind, data, description, id) {
  switch (kind) {
    case 'email':
      return {
        title: description || data.subject,
        sub: addresses(data.to) ? t('fx.to', { to: addresses(data.to) }) : '',
        details: emailMarkup(data, id),
      };
    case 'http':
      return {
        title: [data.method, data.url].filter(present).join(' ') || description,
        sub: description,
        details: metadata([['method', data.method], ['url', data.url], ['status', data.status]]) + payload('body', data.body),
      };
    case 'job':
      return {
        title: data.name || description,
        sub: [description === data.name ? '' : description, data.queue ? t('fx.queue', { queue: data.queue }) : ''].filter(present).join(' · '),
        details: metadata([['name', data.name], ['queue', data.queue], ['runAt', data.runAt]]) + payload('arguments', data.arguments),
      };
    case 'message':
      return {
        title: data.topic || description,
        sub: [description === data.topic ? '' : description, data.key].filter(present).join(' · '),
        details: metadata([['topic', data.topic], ['key', data.key]]) + payload('payload', data.payload),
      };
    default:
      return { title: description };
  }
}

function effectCard(effect, preview, index) {
  const id = `capture-effect-${index}`;
  const kind = String(effect.kind ?? '').toLowerCase();
  const config = effectKinds.get(kind) ?? otherKind;
  const group = effectKinds.has(kind) ? kind : 'other';
  const label = effectKinds.has(kind) ? t('fx.kind.' + kind) : effect.kind || t('fx.kind.other');
  const data = effect.data ?? {};
  const { title, sub, details } = effectContent(kind, data, effect.description, id);
  const extra = details && Object.entries(data).filter(([key]) => !config.fields.includes(key));
  const body = details ? details + (extra.length ? payload('data', Object.fromEntries(extra)) : '') : payload('data', effect.data);
  const delivered = !preview && effect.delivered === true;
  const status = preview ? t('fx.held.' + group) : delivered ? t('fx.sent.' + group) : t('fx.captured');
  const badge = delivered && kind === 'http' && present(data.status) ? `${status} · ${data.status}` : status;
  const content = `<span class="fx-ico">${icon(config.glyph, true)}</span>
    <span class="stack"><span class="kind">${esc(label)}</span>
    <span class="title" title="${esc(title)}">${esc(title || label)}</span>
    ${sub && sub !== title ? `<span class="sub" title="${esc(sub)}">${esc(sub)}</span>` : ''}</span>
    <span class="tag${delivered ? ' tag-ok' : ''}">${esc(badge)}</span>`;

  const open = index === 0 && kind === 'email' && !!details;
  return body ? `<article class="fx${open ? ' is-open' : ''}" data-captured-effect="${index}">
    <button class="fx-head" type="button" aria-expanded="${open}" aria-controls="${id}">${content}${chevron()}</button>
    <div class="fx-body" id="${id}"${open ? '' : ' hidden'}>${body}</div></article>` :
    `<article class="fx"><div class="fx-head fx-static">${content}</div></article>`;
}

function effectsBanner(effects, preview) {
  const delivered = preview ? 0 : effects.filter(effect => effect.delivered === true).length;
  const allDelivered = delivered === effects.length;
  const message = preview
    ? th('fx.heldBanner', { n: effects.length })
    : allDelivered ? `<strong>${th('fx.ran', { n: delivered })}</strong>` :
      `<strong>${th('fx.capturedCount', { n: effects.length })}</strong>${delivered ? ` ${th('fx.ran', { n: delivered })}` : ''}`;
  return `<div class="banner${allDelivered ? ' banner-ok' : ''}">${icon(preview ? 'undo' : allDelivered ? 'check' : 'info')}<div>${message}</div></div>`;
}

/** The side effects pane: a summary banner and one expandable card per captured effect. */
export function effectsMarkup(result) {
  const effects = (result.effects ?? []).filter(effect => effect && typeof effect === 'object');
  const truncated = result.effectsTruncated ? `<p class="faint capture-note">${esc(t('fx.truncated'))}</p>` : '';
  if (!effects.length) return `<p class="faint capture-note">${esc(t('fx.none'))}</p>` + truncated;
  return effectsBanner(effects, result.preview) + truncated +
    `<div class="fx-list">${effects.map((effect, index) => effectCard(effect, result.preview, index)).join('')}</div>`;
}

const emailElements = new Set('a abbr b blockquote br caption center code col colgroup dd div dl dt em font h1 h2 h3 h4 h5 h6 hr i img li ol p pre s small span strong style sub sup table tbody td th thead tfoot tr u ul'.split(' '));
const emailAttributes = new Set('alt aria-label align bgcolor border cellpadding cellspacing class colspan dir height id lang role rowspan style title valign width'.split(' '));

/** Preserve email formatting in an inert, isolated document without active content or remote assets. */
function mountEmailPreview(panel, html) {
  const doc = panel.ownerDocument;
  const template = doc.createElement('template');
  template.innerHTML = html;
  for (const el of template.content.querySelectorAll('*')) {
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !emailElements.has(el.localName)) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const embeddedImage = el.localName === 'img' && attr.name === 'src' &&
        /^data:image\/(?:png|gif|jpeg|webp);base64,/i.test(attr.value);
      if (!emailAttributes.has(attr.name) && !embeddedImage) el.removeAttributeNode(attr);
    }
  }
  const frame = doc.createElement('iframe');
  frame.className = 'mail-frame';
  frame.title = t('fx.htmlFrame');
  frame.setAttribute('sandbox', '');
  frame.referrerPolicy = 'no-referrer';
  const policy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">${template.innerHTML}`;
  panel.append(frame);
}

/** Wires the effect cards: expand and collapse, and the email's HTML and source panels. */
export function bindEffects(container, result) {
  const effects = (result.effects ?? []).filter(effect => effect && typeof effect === 'object');
  for (const card of container.querySelectorAll('[data-captured-effect]')) {
    const head = card.querySelector('.fx-head');
    const body = card.querySelector('.fx-body');
    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
      card.classList.toggle('is-open', !body.hidden);
      head.setAttribute('aria-expanded', String(!body.hidden));
    });

    const buttons = card.querySelectorAll('[data-mail-view]');
    const panels = card.querySelectorAll('[data-mail-panel]');
    for (const [index, button] of buttons.entries()) {
      button.addEventListener('click', () => {
        const panel = panels[index];
        const opening = panel.hidden;
        buttons.forEach(item => item.setAttribute('aria-expanded', String(item === button && opening)));
        panels.forEach(item => { item.hidden = item !== panel || !opening; });
        if (opening && button.dataset.mailView === 'html' && !panel.firstChild) {
          mountEmailPreview(panel, effects[Number(card.dataset.capturedEffect)].data.html);
        }
      });
    }
  }
}
