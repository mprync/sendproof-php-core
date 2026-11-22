// Display settings (mock: overlays.js "display"), opened from the top bar or with ⌘,: density,
// theme, a note on text size, language and, for Arabic and Persian, the digits to use. Each
// change applies at once; nothing in the layout moves except sizes.
//
// The language picker (mocks 107, 108, m25) is a listbox beside the panel: 34 languages in six
// groups, each by its autonym with the English name and region, a check on the current one, and
// that language's own number and date format. Search covers autonyms, English names, regions and
// codes. A right-to-left language previews a real field, mirrored, while it's the active row.
import { esc, icon } from './components.js';
import { catalogueFor, LANGUAGES, loadLanguage, t, th, tIn } from './i18n.js';
import { getSettings, updateSettings } from './settings.js';
import { shortcutHint } from './shortcuts.js';
import { openPopoverAt } from './popover.js';
import { openListbox } from './listbox.js';

/** A language's own number and date format: "1.250,00 · 23.11.2026". */
function sample(language, digits = getSettings().digits) {
  const native = ['ar', 'fa'].includes(language.catalogue);
  const locale = native ? `${language.id}-u-nu-${digits === 'arab' ? (language.catalogue === 'fa' ? 'arabext' : 'arab') : 'latn'}` : language.id;
  try {
    return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(1250)} · ${new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date('2026-11-23T00:00:00Z'))}`;
  } catch { return ''; }
}

/** The English name of a language's region, for search and the second line: "Netherlands". */
function regionEnglish(language) {
  const region = language.id.split('-')[1];
  try { return region && region.length === 2 ? new Intl.DisplayNames(['en'], { type: 'region' }).of(region) : ''; } catch { return ''; }
}

/**
 * The RTL preview: a real radio field in the language about to be picked, mirrored, with that
 * language's own strings (its catalogue is loaded when the row becomes active).
 */
function rtlPreview(language) {
  const say = key => esc(tIn(language.id, key));
  const options = ['Open', 'Frozen', 'Closed'].map((value, index) => `<span class="rg-opt" role="presentation" aria-checked="${index === 0}"><span class="rg-dot"></span><span data-label="${value}" lang="en">${value}</span></span>`).join('');
  return `<div class="lang-preview" role="group" aria-label="${esc(t('lang.preview'))}">
      <div class="lp-h">${icon('eye', true)}${esc(t('lang.previewRtl'))}</div>
      <div class="lp-box" dir="rtl" lang="${esc(language.id)}" aria-hidden="true">
        <div class="field" data-kind="radio"><div class="label"><span class="name" lang="en">status</span><span class="info-btn">${icon('info')}</span><span class="opt">${say('field.optional')}</span><span class="end"><span class="field-clear">${say('field.clear')}</span><span class="type">AccountStatus</span></span></div>
          <div class="rg">${options}</div>
          <p class="f-desc" lang="en">Only accounts with this status.</p>
          <div class="assist"><span class="msg"><span class="field-hint">${esc(tIn(language.id, 'field.sends', { value: '\u0000' })).replace('\u0000', '<code>status=Open</code>')}</span></span></div></div>
      </div>
    </div>`;
}

/** Opens the language picker for the Language control in Display settings. */
function openLanguagePicker(control, panel, { onLanguage }) {
  const settings = getSettings();
  const items = LANGUAGES.map(language => {
    const english = [language.english !== language.autonym ? language.english : '', regionEnglish(language)].filter(Boolean).join(' · ');
    return {
      value: language.id, label: language.autonym, group: esc(t('lang.group.' + language.group)), lang: language.id,
      html: `<bdi>${esc(language.autonym)}</bdi>`,
      description: english || language.english, descriptionLang: 'en',
      keywords: [language.id, language.english, language.region, regionEnglish(language)],
      end: `${language.dir === 'rtl' ? `<span class="rtl-tag" title="${esc(t('lang.rtlTitle'))}">${esc(t('lang.rtl'))}</span>` : ''}${language.review ? `<span class="review-tag" title="${esc(t('lang.reviewTitle'))}">${esc(t('lang.review'))}</span>` : ''}<span class="sample">${esc(sample(language))}</span>`,
    };
  });
  let shown;
  const box = openListbox(control, {
    label: t('lang.label'), items, value: settings.language, search: true, className: 'lang-pop',
    searchLabel: t('lang.search', { n: LANGUAGES.length }),
    sheet: { title: esc(t('lang.label')), sub: esc(t('lang.sub')) },
    foot: `<span>${esc(t('lang.foot'))}</span><span class="spacer"></span><span>${shortcutHint('escape')}</span>`,
    place: { align: 'end', width: 'auto' },
    onActive: item => {
      const language = LANGUAGES.find(entry => entry.id === item?.value);
      if (!language || language.dir !== 'rtl') { if (shown) { shown = undefined; box?.setAfter(''); } return; }
      shown = language.id;
      const draw = () => { if (shown === language.id) box?.setAfter(rtlPreview(language)); };
      if (catalogueFor(language.id)) draw(); else loadLanguage(language.id).then(draw);
    },
    onPick: async item => {
      await loadLanguage(item.value);
      updateSettings({ language: item.value });
      onLanguage?.();
    },
  });
  // A submenu of Display settings: it opens beside the panel, top-aligned, so the list and the
  // RTL preview have the panel's whole height rather than the space under the Language row.
  const pop = box.pop;
  const area = panel.getBoundingClientRect();
  if (!pop.classList.contains('is-sheet') && innerWidth > 900) {
    const rtl = document.documentElement.dir === 'rtl';
    const left = rtl ? area.right + 8 : area.left - pop.offsetWidth - 8;
    if (left >= 12 && left + pop.offsetWidth <= innerWidth - 12) {
      Object.assign(pop.style, { top: area.top + 'px', bottom: '', left: left + 'px' });
      const list = pop.querySelector('.lb-list');
      list.style.maxBlockSize = '';
      const over = pop.getBoundingClientRect().bottom - (innerHeight - 12);
      if (over > 0) list.style.maxBlockSize = Math.max(160, list.offsetHeight - over) + 'px';
    }
  }
  return box;
}

const radios = (name, label, options, value) =>
  `<div class="segmented" role="radiogroup" aria-label="${esc(label)}">${options.map(([id, text, glyph]) =>
    `<button type="button" role="radio" data-setting="${name}" data-value="${id}" aria-checked="${id === value}" tabindex="${id === value ? 0 : -1}">${glyph ? icon(glyph, true) : ''}${esc(text)}</button>`).join('')}</div>`;

function panel() {
  const settings = getSettings();
  const language = LANGUAGES.find(item => item.id === settings.language) || LANGUAGES[0];
  const nativeDigits = ['ar', 'fa'].includes(language.catalogue);
  return `<div class="pop settings" role="dialog" aria-labelledby="display-title" id="display-settings">
    <div class="pop-head"><span id="display-title">${esc(t('shell.display'))}</span><span class="spacer"></span>${shortcutHint('display')}</div>
    <div class="row">
      <div class="row-h">${esc(t('display.density'))}<span class="faint">${esc(t('display.densityNote'))}</span></div>
      ${radios('density', t('display.density'), [['compact', t('display.compact')], ['default', t('display.default')], ['comfortable', t('display.comfortable')]], settings.density)}
      <p class="note">${esc(t('display.densityHelp'))}</p>
    </div>
    <div class="row">
      <div class="row-h">${esc(t('display.theme'))}</div>
      ${radios('theme', t('display.theme'), [['system', t('display.system'), 'monitor'], ['light', t('display.light'), 'sun'], ['dark', t('display.dark'), 'moon']], settings.theme)}
    </div>
    <div class="row">
      <div class="row-h">${esc(t('display.textSize'))}<span class="faint" data-text-size></span></div>
      <p class="note">${th('display.textSizeHelp', { in: shortcutHint('zoom-in'), out: shortcutHint('zoom-out') })}</p>
    </div>
    <div class="row">
      <div class="row-h"><span id="display-language-label">${esc(t('display.language'))}</span><span class="faint">${esc(t('display.languageNote'))}</span></div>
      <div class="control sel lang-btn" id="display-language" role="combobox" tabindex="0" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="display-language-label display-language-value">
        <span class="sel-value" id="display-language-value"><bdi lang="${esc(language.id)}">${esc(language.name)}</bdi><span class="sub">${esc(sample(language))}</span></span>
        <span class="sel-trigger" aria-hidden="true">${icon('chevron-down', true)}</span></div>
    </div>
    ${nativeDigits ? `<div class="row">
      <div class="row-h">${esc(t('display.digits'))}</div>
      ${radios('digits', t('display.digits'), [['latn', `${t('display.latin')} 123`], ['arab', `${t('display.arabicIndic')} ${language.catalogue === 'fa' ? '۱۲۳' : '١٢٣'}`]], settings.digits)}
      <p class="note">${esc(t('display.digitsHelp'))}</p>
    </div>` : ''}
  </div>`;
}

/** Opens Display settings under its top-bar button. `onLanguage` re-renders the workbench. */
export function openDisplaySettings(anchor, { onLanguage } = {}) {
  const pop = openPopoverAt(anchor, panel(), { align: 'end', kind: 'display' });
  const percent = Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 * 100);
  pop.querySelector('[data-text-size]').textContent = `${percent}%`;
  pop.addEventListener('click', event => {
    const radio = event.target.closest('[role="radio"]');
    if (!radio) return;
    choose(radio);
  });
  pop.addEventListener('keydown', event => {
    const radio = event.target.closest('[role="radio"]');
    if (!radio || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const group = [...radio.parentElement.children];
    const forward = (event.key === 'ArrowRight') !== (document.documentElement.dir === 'rtl') || event.key === 'ArrowDown';
    const next = group[(group.indexOf(radio) + (forward ? 1 : -1) + group.length) % group.length];
    event.preventDefault();
    choose(next);
  });
  const languageControl = pop.querySelector('#display-language');
  const openPicker = () => openLanguagePicker(languageControl, pop, { onLanguage });
  languageControl.addEventListener('click', openPicker);
  languageControl.addEventListener('keydown', event => {
    if (languageControl.getAttribute('aria-expanded') === 'true') return;
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); openPicker(); }
  });

  function choose(radio) {
    const name = radio.dataset.setting;
    updateSettings({ [name]: radio.dataset.value });
    if (name === 'digits') { onLanguage?.(); return; }
    for (const item of radio.parentElement.children) {
      const selected = item === radio;
      item.setAttribute('aria-checked', String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    radio.focus();
  }
}
