// Anchored popovers: Display settings, History, field toggletips and the Generate menu. One is
// open at a time. It is placed below its anchor (or above when there isn't room), stays inside
// the viewport, closes on Esc or a click outside, and returns focus to its opener.
let open;

/** Positions a fixed popover next to an anchor, mirroring the mock's placement. */
export function place(anchor, pop, { align = 'start', above = false, gap = 6, arrow = false } = {}) {
  const a = anchor.getBoundingClientRect();
  const rtl = document.documentElement.dir === 'rtl';
  pop.style.position = 'fixed';
  pop.style.insetInlineStart = 'auto';
  const width = pop.offsetWidth;
  let left = align === 'end' ? (rtl ? a.left : a.right - width) : align === 'center' ? a.left + a.width / 2 - width / 2 : (rtl ? a.right - width : a.left);
  left = Math.max(12, Math.min(left, innerWidth - width - 12));
  pop.style.left = left + 'px';
  pop.classList.remove('is-above');
  pop.style.top = pop.style.bottom = '';
  if (!above && a.bottom + gap + pop.offsetHeight > innerHeight - 12 && a.top - gap - pop.offsetHeight > 12) above = true;
  if (above) { pop.classList.add('is-above'); pop.style.bottom = (innerHeight - a.top + gap) + 'px'; }
  else pop.style.top = (a.bottom + gap) + 'px';
  if (arrow) pop.style.setProperty('--arrow', (rtl ? left + width - (a.left + a.width / 2) - 6 : a.left + a.width / 2 - left - 6) + 'px');
}

/** Closes the open popover. `restore` puts focus back on its opener. */
export function closePopover(restore = false) {
  if (!open) return;
  const { pop, anchor, onClose } = open;
  open = undefined;
  pop.remove();
  anchor?.setAttribute('aria-expanded', 'false');
  onClose?.();
  if (restore) anchor?.focus();
}

/** The popover that is open now, if any. */
export const openPopover = () => open;

/**
 * Opens `html` anchored to `anchor`. Returns the popover element. `hover` popovers (toggletips
 * opened by pointer) close when the pointer leaves both the anchor and the popover.
 */
export function openPopoverAt(anchor, html, { align, above, gap, arrow, onClose, focus = true, kind = '' } = {}) {
  closePopover();
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const pop = template.content.firstElementChild;
  pop.dataset.popover = kind;
  document.body.append(pop);
  place(anchor, pop, { align, above, gap, arrow });
  anchor.setAttribute('aria-expanded', 'true');
  open = { pop, anchor, onClose, kind };
  if (focus) (pop.querySelector('[autofocus], [aria-checked="true"], [aria-selected="true"], .is-active, button, select, input, a[href]') || pop).focus?.();
  return pop;
}

// Global listeners are added once, in a browser only (unit tests import this module in Node).
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', event => {
    if (open && event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      closePopover(true);
    }
  }, true);
  document.addEventListener('pointerdown', event => {
    // A listbox opened from inside this popover (the language picker) is a layer above it.
    if (event.target.closest?.('[data-layer]')) return;
    if (open && !open.pop.contains(event.target) && !open.anchor.contains(event.target)) closePopover();
  }, true);
  addEventListener('resize', () => { if (open) place(open.anchor, open.pop); });
}
