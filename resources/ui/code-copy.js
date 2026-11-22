// Copying from a code viewer puts only the code on the clipboard.
//
// A code view is a grid of lines: a line number, a fold button, the source and hover actions. The
// browser's own copy walks that grid and picks up the numbers and button labels, and the source
// text itself has lost its indentation because the viewer indents with padding (--d, in 2-space
// steps). So one `copy` listener on the document rebuilds the text: for each selected line, the
// selected part of its source, with the indentation put back wherever the selection starts at the
// beginning of a line, and lines joined by newlines. A collapsed node's "N keys" badge copies as an
// ellipsis. Selections outside a code view, or across several of them, keep the native copy
// (the gutter is user-select: none, so those carry no numbers either).

/** Spaces per nesting level in the viewer (matches JSON.stringify(value, null, 2)). */
export const INDENT = '  ';

/**
 * Joins selected lines into clipboard text.
 * @param {{ text: string, depth: number, whole: boolean }[]} parts `whole` is true when the line is
 *   selected from its first character, so its indentation belongs in the copy.
 */
export function joinCodeLines(parts) {
  return parts.map(({ text, depth, whole }) => (whole ? INDENT.repeat(depth) : '') + text).join('\n');
}

/** The text of a range of one source element, with collapsed badges written as an ellipsis. */
function textOf(range) {
  const fragment = range.cloneContents();
  for (const badge of fragment.querySelectorAll('.folded')) badge.replaceWith('…');
  return fragment.textContent;
}

/**
 * The code in the current selection, or null when it should be left to the browser. Line numbers,
 * fold buttons and line actions are not in `.src`, so they can never be included.
 */
export function selectedCode(selection = globalThis.getSelection?.()) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const anchor = range.commonAncestorContainer;
  const view = (anchor.nodeType === 1 ? anchor : anchor.parentElement)?.closest('.code-view');
  if (!view) return null;
  const parts = [];
  for (const line of view.querySelectorAll('.ln')) {
    const source = line.querySelector('.src');
    if (!source || !range.intersectsNode(source)) continue;
    const part = document.createRange();
    part.selectNodeContents(source);
    // Clip the line's range to the selection; the line is "whole" when the selection starts before it.
    const clippedStart = range.compareBoundaryPoints(Range.START_TO_START, part) > 0;
    if (clippedStart) part.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
    // A selection that starts exactly at the first character of the source still counts as whole.
    let atStart = false;
    if (clippedStart) {
      const before = document.createRange();
      before.selectNodeContents(source);
      before.setEnd(range.startContainer, range.startOffset);
      atStart = before.toString() === '';
    }
    parts.push({ text: textOf(part), depth: Number.parseInt(source.style.getPropertyValue('--d'), 10) || 0, whole: !clippedStart || atStart });
  }
  return parts.length ? joinCodeLines(parts) : null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('copy', event => {
    const text = selectedCode();
    if (text === null || !event.clipboardData) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  });
}
