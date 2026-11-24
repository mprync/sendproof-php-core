// Priority fitting of the top bar and the journey action bars: what gives way, in what order, when
// a row is too narrow for its content (a long translation, a larger text size, a narrow window).
// Media queries cannot see the text size (they read rem against the browser's own size, not the
// page's), so these are measured.
//
// The top bar gives way in this order, one step at a time, until nothing wraps or truncates: the
// Specification | Journeys switch shows icons, the search trigger shows its icon, the API version
// goes, the signed-in role goes, the database name goes (classes fit-mode, fit-search, fit-ver,
// fit-role, fit-db on .topbar; see app.css). Each keeps its title or accessible name.
//
// A journey action bar's priority order is: the status line shows its sentence, then only its icon (CSS, see
// .actionbar.j7-actions .status in app.css), then the buttons drop their shortcut hints. CSS cannot
// tell "the buttons need more than the bar has" in every locale and at every text size, so this
// measures it: a bar whose content overflows with the status already down to its icon gets
// `is-tight`, which hides the hints. It re-measures when the bar's width, the root font size, the
// language or a web font changes, and whenever a bar is rendered afresh.

const SELECTOR = '.actionbar.j7-actions';
const TOPBAR = '.topbar';
const STEPS = ['fit-mode', 'fit-search', 'fit-ver', 'fit-role', 'fit-db'];
// The topbar's elements that ellipsize when squeezed.
const SQUEEZABLE = '.api-switch .name, .env .ltr, .env strong, .persona .name, .search-trigger .grow';

/** Whether the top bar overflows its row or any text in it is cut off. */
function squeezed(bar) {
  if (bar.scrollWidth > bar.clientWidth + 1) return true;
  return [...bar.querySelectorAll(SQUEEZABLE)].some(item => item.clientWidth > 8 && item.scrollWidth > item.clientWidth + 1);
}

/**
 * Applies the top bar's give-way steps in order, stopping at the first that leaves nothing cut off.
 * @param {ParentNode} [root]
 */
export function fitTopbar(root = document) {
  const bar = root.querySelector(TOPBAR);
  if (!bar || !bar.getClientRects().length) return;
  bar.classList.remove(...STEPS);
  for (const step of STEPS) {
    if (!squeezed(bar)) break;
    bar.classList.add(step);
  }
}

/**
 * Sets `is-tight` on every journey action bar under `root` whose content overflows. The class is
 * removed first so the measurement is of the full hints each time; all reads come before any write.
 * @param {ParentNode} [root]
 */
export function fitBars(root = document) {
  const bars = [...root.querySelectorAll(SELECTOR)];
  bars.forEach(bar => bar.classList.remove('is-tight'));
  const overflowing = bars.map(bar => bar.scrollWidth > bar.clientWidth + 1);
  bars.forEach((bar, index) => bar.classList.toggle('is-tight', overflowing[index]));
  fitTopbar(root);
}

const addsBar = mutation => [...mutation.addedNodes].some(node =>
  node.nodeType === 1 && [SELECTOR, TOPBAR].some(selector => node.matches?.(selector) || node.querySelector?.(selector) || node.parentElement?.matches?.(selector)));

/**
 * Keeps the bars fitted for the life of the page. Call once at startup.
 * @returns {() => void} stops watching
 */
export function watchBars() {
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fitBars(); });
  };
  // A bar is re-rendered by replacing its children, or the whole pane is replaced.
  const added = new MutationObserver(mutations => { if (mutations.some(addsBar)) schedule(); });
  added.observe(document.body, { childList: true, subtree: true });
  const root = new MutationObserver(schedule);
  root.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'lang', 'dir', 'data-density'] });
  // A box one rem wide: it resizes exactly when the root font size does (text size, zoom, density).
  const probe = Object.assign(document.createElement('span'), { ariaHidden: 'true' });
  probe.style.cssText = 'position:fixed;inset-block-start:0;inset-inline-start:0;inline-size:1rem;block-size:0;visibility:hidden;pointer-events:none';
  document.body.append(probe);
  const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : undefined;
  sizes?.observe(probe);
  sizes?.observe(document.body);
  document.fonts?.addEventListener?.('loadingdone', schedule);
  addEventListener('resize', schedule);
  schedule();
  return () => {
    added.disconnect(); root.disconnect(); sizes?.disconnect(); probe.remove();
    document.fonts?.removeEventListener?.('loadingdone', schedule);
    removeEventListener('resize', schedule);
  };
}
