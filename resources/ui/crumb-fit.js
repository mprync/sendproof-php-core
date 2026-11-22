// Fits the head row's earlier crumbs to their text, in every browser.
//
// An earlier crumb may be squeezed down to a readable stub (--crumb-parent-min, 5rem; see .ctx-bar
// in app.css) but must never reserve more room than its own text needs, or a short crumb leaves a
// gap before the next chevron. CSS cannot say "min(5rem, my natural width)" (min() takes no
// max-content, and calc-size() is not in Firefox or Safari), so this measures each earlier crumb's
// natural width and sets it as `--nat` on its <li>; the stylesheet's
// `min-inline-size: min(var(--crumb-parent-min), var(--nat, var(--crumb-parent-min)))` does the rest.
// Until a crumb is measured the flat stub applies, which is the same layout minus the gap.
//
// The width of a label can change without its box changing (a clamped crumb at a larger text
// size), so observing the labels is not enough. The head row is re-measured whenever one is added
// (every page and locale switch renders it afresh), when density, language or direction change on
// <html>, when the root font size changes (a probe one rem wide is observed, which also catches the
// browser's own text-size setting and zoom), when a web font finishes loading, and when the window
// resizes (a phone hides the earlier crumbs, which have no width then).

const SELECTOR = '.ctx-bar .crumbs li:not(:last-child)';

/** The outer inline size an earlier crumb's text needs: its label plus the link's padding and negative margin. */
function naturalWidth(item) {
  const label = item.firstElementChild;
  if (!label) return undefined;
  const range = document.createRange();
  range.selectNodeContents(label);
  const style = getComputedStyle(label);
  const sides = ['paddingInlineStart', 'paddingInlineEnd', 'marginInlineStart', 'marginInlineEnd'];
  const extra = sides.reduce((sum, side) => sum + (parseFloat(style[side]) || 0), 0);
  return range.getBoundingClientRect().width + extra;
}

/**
 * Measures every earlier crumb under `root` and sets `--nat` on it. All reads come before any write,
 * so the row lays out once. A crumb that is not shown (a phone hides them) keeps no measurement.
 * @param {ParentNode} [root]
 */
export function fitCrumbs(root = document) {
  const items = [...root.querySelectorAll(SELECTOR)];
  const widths = items.map(item => item.getClientRects().length ? naturalWidth(item) : undefined);
  items.forEach((item, index) => {
    // Round up to a whole pixel so subpixel text never ends in an ellipsis for want of 0.3px.
    if (widths[index] === undefined) item.style.removeProperty('--nat');
    else item.style.setProperty('--nat', `${Math.ceil(widths[index])}px`);
  });
}

const addsHeadRow = mutation => [...mutation.addedNodes].some(node =>
  node.nodeType === 1 && (node.matches('.ctx-bar') || node.querySelector('.ctx-bar')));

/**
 * Keeps the measurements current for the life of the page. Call once at startup.
 * @returns {() => void} stops watching
 */
export function watchCrumbs() {
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fitCrumbs(); });
  };
  const rows = new MutationObserver(mutations => { if (mutations.some(addsHeadRow)) schedule(); });
  rows.observe(document.body, { childList: true, subtree: true });
  // Density, script font, language and direction all live on <html>.
  const root = new MutationObserver(schedule);
  root.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'lang', 'dir', 'data-density'] });
  // A box one rem wide: it resizes exactly when the root font size does (text size, zoom, density).
  const probe = Object.assign(document.createElement('span'), { ariaHidden: 'true' });
  probe.style.cssText = 'position:fixed;inset-block-start:0;inset-inline-start:0;inline-size:1rem;block-size:0;visibility:hidden;pointer-events:none';
  document.body.append(probe);
  const rem = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : undefined;
  rem?.observe(probe);
  document.fonts?.addEventListener?.('loadingdone', schedule);
  addEventListener('resize', schedule);
  schedule();
  return () => {
    rows.disconnect(); root.disconnect(); rem?.disconnect(); probe.remove();
    document.fonts?.removeEventListener?.('loadingdone', schedule);
    removeEventListener('resize', schedule);
  };
}
