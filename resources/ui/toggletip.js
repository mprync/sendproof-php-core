// Field toggletips (mock 23, m05): the "i" button after a label opens a short description of the
// field from the spec: what it is, its type and constraints, an example, and how it is sent.
// It opens on hover, focus or click; Esc or a click outside closes it (WCAG 1.4.13).
import { closePopover, openPopover, openPopoverAt } from './popover.js';

let describe = () => '';

/** Registers the function that renders a toggletip's content for an "i" button. */
export function setToggletipContent(render) { describe = render; }

function show(button, { focus = false } = {}) {
  if (openPopover()?.anchor === button) return;
  const html = describe(button);
  if (!html) return;
  openPopoverAt(button, html, { gap: 10, arrow: true, focus, kind: 'toggletip' });
}

/** Wires every .info-btn inside a root. */
export function bindToggletips(root) {
  let hideTimer;
  root.addEventListener('click', event => {
    const button = event.target.closest('.info-btn');
    if (!button) return;
    event.preventDefault();
    if (openPopover()?.anchor === button && openPopover().kind === 'toggletip') closePopover();
    else show(button);
  });
  root.addEventListener('focusin', event => {
    const button = event.target.closest?.('.info-btn');
    if (button && button.matches(':focus-visible')) show(button);
  });
  root.addEventListener('pointerover', event => {
    const button = event.target.closest?.('.info-btn');
    if (!button || event.pointerType === 'touch') return;
    clearTimeout(hideTimer);
    show(button);
  });
  root.addEventListener('pointerout', event => {
    const button = event.target.closest?.('.info-btn');
    if (!button || event.pointerType === 'touch') return;
    hideTimer = setTimeout(() => {
      const open = openPopover();
      if (open?.kind === 'toggletip' && open.anchor === button && !open.pop.matches(':hover') && button !== document.activeElement) closePopover();
    }, 250);
  });
  document.addEventListener('pointerout', event => {
    const open = openPopover();
    if (open?.kind !== 'toggletip' || !open.pop.contains(event.target)) return;
    hideTimer = setTimeout(() => {
      if (!open.pop.matches(':hover') && !open.anchor.matches(':hover') && document.activeElement !== open.anchor) closePopover();
    }, 250);
  });
}
