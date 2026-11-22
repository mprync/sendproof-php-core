import { effectsMarkup, bindEffects } from './result-effects.js';
import { logsMarkup, bindLogs } from './result-logs.js';
import { headersMarkup, bindHeaders } from './result-headers.js';
import { copyText } from './copy.js';

const panes = new Map([
  ['Side effects', { markup: effectsMarkup, bind: bindEffects }],
  ['Logs', { markup: logsMarkup, bind: bindLogs }],
  ['Headers', { markup: headersMarkup, bind: bindHeaders }],
]);

/** Render the captured data for the selected result tab. */
export function captureMarkup(tab, result = {}, context = {}) {
  return panes.get(tab)?.markup(result, context) ?? '';
}

/**
 * Bind a freshly rendered result pane to its capture. Panes receive `copy(text, target)`, where
 * target is { button, what, select, notice } for ui/copy.js: the clicked button, a short noun,
 * the element to select if the clipboard is blocked, and where the inline notice goes.
 */
export function bindCapturePane(container, tab, result = {}, context = {}) {
  const copy = (text, target) => copyText(text, target);
  panes.get(tab)?.bind(container, result, copy, context);
}
