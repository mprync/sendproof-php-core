// Enum controls (mocks 76–80, 82, 112, m18, m19): a radio group for short enums and a
// field-styled select for everything else. Both replace the native <select> and the segmented
// enum of v4.
//
//   radio group  up to 4 values of up to 12 characters. Separate options with a radio dot; the
//                chosen one has a filled dot, an accent border and a tint (three cues, none of
//                them colour alone). WAI-ARIA radio group: one tab stop, arrows move and choose,
//                Delete or Backspace clears an optional field.
//   select       looks like an input: the value fills the control and the trigger is a joined
//                segment behind a divider. Its popover is the shared listbox (ui/listbox.js):
//                "Any" first for optional fields, a check on the chosen value, each value's
//                description (x-enum-descriptions), search past 8 values and type-ahead.
import { element, svg } from './dom.js';
import { closeListbox, openListbox } from '../listbox.js';
import { t } from '../i18n.js';

/** A radio group fits short enums; anything longer is a select. The one place the rule lives. */
export const useRadio = values => values.length > 0 && values.length <= 4 && values.every(value => value !== null && typeof value !== 'object' && String(value).length <= 12);

/** The descriptions an enum documents for its values: x-enum-descriptions, or oneOf of const + description. */
export function enumDescriptions(schema, resolve = value => value) {
  const own = schema?.['x-enum-descriptions'] ?? schema?.['x-enumDescriptions'];
  if (own && typeof own === 'object') return own;
  const variants = (schema?.oneOf || schema?.anyOf || []).map(resolve);
  if (variants.length && variants.every(variant => variant && Object.hasOwn(variant, 'const'))) {
    return Object.fromEntries(variants.filter(variant => variant.description).map(variant => [String(variant.const), variant.description]));
  }
  return {};
}

const isDelete = event => event.key === 'Delete' || event.key === 'Backspace';

/**
 * A radio group. `options` are { value, label, description }; `onChange(value)` gets undefined
 * when an optional group is cleared.
 */
export function radioGroup({ id, options, value, optional, onChange, labelledBy, required, disabled }) {
  const group = element('div', 'rg');
  group.id = id;
  group.setAttribute('role', 'radiogroup');
  if (labelledBy) group.setAttribute('aria-labelledby', labelledBy);
  if (required) group.setAttribute('aria-required', 'true');
  if (disabled) { group.setAttribute('aria-disabled', 'true'); group.classList.add('is-disabled'); }
  const chosen = options.findIndex(option => Object.is(option.value, value));
  const radios = options.map((option, index) => {
    const radio = element('span', 'rg-opt');
    radio.setAttribute('role', 'radio');
    radio.setAttribute('aria-checked', String(index === chosen));
    radio.tabIndex = disabled ? -1 : index === (chosen < 0 ? 0 : chosen) ? 0 : -1;
    radio.lang = 'en';
    radio.dataset.value = String(option.value);
    if (option.description) radio.title = option.description;
    const dot = element('span', 'rg-dot');
    dot.setAttribute('aria-hidden', 'true');
    const text = element('span', '', option.label ?? String(option.value));
    text.dataset.label = text.textContent;
    radio.append(dot, text);
    radio.addEventListener('click', () => { if (!disabled) pick(index); });
    return radio;
  });
  group.append(...radios);
  function pick(index, focus = true) {
    radios.forEach((radio, i) => {
      radio.setAttribute('aria-checked', String(i === index));
      radio.tabIndex = i === (index < 0 ? 0 : index) ? 0 : -1;
    });
    if (focus && radios[index]) radios[index].focus?.();
    onChange(index < 0 ? undefined : options[index].value);
  }
  group.addEventListener('keydown', event => {
    if (disabled) return;
    const at = radios.indexOf(document.activeElement);
    if (at < 0) return;
    const rtl = getComputedStyle(group).direction === 'rtl';
    const forward = { ArrowDown: 1, ArrowUp: -1, ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    if (forward) pick((at + forward + radios.length) % radios.length);
    else if (event.key === ' ' || event.key === 'Enter') pick(at);
    else if (event.key === 'Home') pick(0);
    else if (event.key === 'End') pick(radios.length - 1);
    else if (isDelete(event) && optional && radios.some(radio => radio.getAttribute('aria-checked') === 'true')) { pick(-1, false); radios[at].focus(); }
    else return;
    event.preventDefault();
  });
  /** Focuses the checked option, or the first. */
  group.focusControl = () => (radios.find(radio => radio.tabIndex === 0) || radios[0])?.focus();
  return group;
}

/**
 * A field-styled select. Returns the `.control` element (role="combobox").
 * @param {object} o
 * @param {Array<{value: *, label?: string, description?: string}>} o.options
 * @param {*} o.value
 * @param {boolean} o.optional    adds "Any", which clears the field
 * @param {string} o.labelledBy   id of the field's label
 * @param {{title: string, sub?: string}} o.sheet the phone sheet's title
 * @param {boolean} [o.segment]   a joined segment of another control (the currency of an amount)
 * @param {string} [o.unsetHint]  the description of "Any"
 */
export function selectControl({ id, options, value, optional, onChange, labelledBy, label, required, placeholder, mono = false, sheet, segment = false, unsetHint, disabled }) {
  const control = element(segment ? 'span' : 'div', segment ? 'part sel-seg' : 'control sel');
  control.id = id;
  control.tabIndex = disabled ? -1 : 0;
  control.setAttribute('role', 'combobox');
  control.setAttribute('aria-haspopup', 'listbox');
  control.setAttribute('aria-expanded', 'false');
  if (labelledBy) control.setAttribute('aria-labelledby', labelledBy);
  if (label) control.setAttribute('aria-label', label);
  if (required) control.setAttribute('aria-required', 'true');
  if (disabled) { control.setAttribute('aria-disabled', 'true'); control.classList.add('is-disabled'); }
  const shown = element('span', 'sel-value');
  shown.lang = 'en';
  const slot = element('span', 'slot');
  slot.setAttribute('aria-hidden', 'true');
  const trigger = element('span', segment ? 'sel-chev' : 'sel-trigger');
  trigger.setAttribute('aria-hidden', 'true');
  trigger.append(svg('chevron-down'));
  control.append(shown, ...(segment ? [] : [slot]), trigger);
  let current = value;

  function paint() {
    const option = options.find(item => Object.is(item.value, current));
    shown.classList.toggle('placeholder', !option);
    shown.classList.toggle('mono-val', !!option && mono);
    shown.textContent = option ? option.label ?? String(option.value) : placeholder ?? (optional ? t('field.any') : t('field.choose'));
  }
  paint();

  function set(next) {
    current = next;
    paint();
    onChange(next);
  }

  function items() {
    const list = options.map(option => ({ value: option.value, label: option.label ?? String(option.value), description: option.description, mono, valueLang: 'en', descriptionLang: 'en' }));
    return optional ? [{ unset: true, value: undefined, label: t('field.any'), description: unsetHint ?? t('field.anyHint') }, ...list] : list;
  }

  function show(extra = {}) {
    if (disabled) return undefined;
    return openListbox(control, {
      label: label || document.getElementById(labelledBy)?.textContent || '',
      items: items(), value: current, search: 'auto', sheet, ...extra,
      onPick: item => set(item.unset ? undefined : item.value),
    });
  }
  control.addEventListener('click', event => {
    if (control.getAttribute('aria-expanded') === 'true') closeListbox(true);
    else { event.preventDefault(); show(); }
  });
  control.addEventListener('keydown', event => {
    if (control.getAttribute('aria-expanded') === 'true' || disabled) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key) || (event.altKey && event.key === 'ArrowDown')) {
      event.preventDefault();
      const active = event.key === 'ArrowUp' && current === undefined ? options.at(-1)?.value : undefined;
      show(active !== undefined ? { active } : {});
    } else if (isDelete(event) && optional && current !== undefined) {
      event.preventDefault();
      set(undefined);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typing on a closed select opens it and starts type-ahead with that character.
      event.preventDefault();
      const search = show()?.pop.querySelector('.lb-search input');
      if (search) { search.value = event.key; search.dispatchEvent(new Event('input')); }
      else control.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, bubbles: true }));
    }
  });
  control.setValue = next => { current = next; paint(); };
  /** Chooses a value as if it had been picked from the list. */
  control.choose = next => set(next);
  control.openOptions = () => show();
  control.focusControl = () => control.focus();
  return control;
}
