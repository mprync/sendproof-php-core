// The Generate menu opened from a field's wand (mock 31, m06): valid values within the schema's
// constraints, then invalid values to test the API's errors. ↑↓ pick, ↵ use, Esc closes.
import { esc, icon } from './components.js';
import { t } from './i18n.js';
import { generateOptions } from './generate.js';
import { shortcutHint } from './shortcuts.js';
import { closePopover, openPopoverAt } from './popover.js';

/** Opens the menu under a field's control. `apply(option)` puts the chosen value in the field. */
export function openGenerateMenu(button, { schema, label, current, apply }) {
  const { valid, invalid, rule } = generateOptions(schema, current);
  const options = [...valid, ...invalid];
  const row = (option, index) => `<button type="button" class="opt-row${index === 0 ? ' is-active' : ''}" role="menuitem" tabindex="-1" data-option="${index}" style="inline-size:100%;border:0;background-color:transparent;text-align:start;font:inherit">
    <span class="stack"><span class="main num"${option.text === undefined ? ' lang="en"' : ''}>${esc(option.main)}</span>${option.sub ? `<span class="sub">${esc(option.sub)}</span>` : ''}</span>${index === 0 ? `<span class="end">${shortcutHint('generate')}</span>` : ''}</button>`;
  const anchor = button.closest('.control') || button;
  const pop = openPopoverAt(anchor, `<div class="pop gen-menu" id="gen-menu" role="menu" aria-label="${esc(t('gen.menuLabel', { name: label }))}">
      <div class="pop-group"><div class="pop-label">${esc(rule ? t('gen.validRule', { rule }) : t('gen.valid'))}</div>${valid.map((option, index) => row(option, index)).join('')}</div>
      ${invalid.length ? `<div class="pop-group"><div class="pop-label">${icon('alert', true)}${esc(t('gen.invalid'))}</div>${invalid.map((option, index) => row(option, valid.length + index)).join('')}</div>` : ''}
      <div class="pop-foot"><span>${shortcutHint('updown')} ${esc(t('gen.pick'))}</span><span>${shortcutHint('enter')} ${esc(t('gen.use'))}</span><span class="spacer"></span><span>${shortcutHint('escape')}</span></div>
    </div>`, { align: 'start', focus: false, kind: 'generate', onClose: () => button.classList.remove('is-active') });
  button.classList.add('is-active');
  button.setAttribute('aria-expanded', 'true');
  const items = [...pop.querySelectorAll('[role="menuitem"]')];
  const focus = index => {
    items.forEach((item, i) => item.classList.toggle('is-active', i === index));
    items[index]?.focus();
  };
  focus(0);
  pop.addEventListener('keydown', event => {
    const index = items.indexOf(document.activeElement);
    const keys = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 };
    if (event.key in keys) {
      event.preventDefault();
      focus((keys[event.key] + items.length) % items.length);
    }
  });
  pop.addEventListener('click', event => {
    const item = event.target.closest('[data-option]');
    if (!item) return;
    closePopover();
    apply(options[Number(item.dataset.option)]);
    button.focus();
  });
}
