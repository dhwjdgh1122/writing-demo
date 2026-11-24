// Textareas expose selection offsets but no DOM Range. Measure the full text
// with the same wrapping before scrolling; a character/line ratio loses the
// location when Korean text or a long paragraph wraps onto multiple lines.
export function revealTextRange(editor: HTMLTextAreaElement, start: number, end: number, viewportTop = 16) {
  const style = getComputedStyle(editor);
  const mirror = document.createElement('div');
  const properties = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing',
    'textIndent', 'textTransform', 'textAlign', 'direction', 'tabSize', 'wordBreak',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;
  for (const property of properties) mirror.style[property] = style[property];
  Object.assign(mirror.style, { position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden',
    boxSizing: 'border-box', width: `${editor.clientWidth}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  mirror.setAttribute('aria-hidden', 'true');
  mirror.textContent = editor.value;
  document.body.append(mirror);
  try {
    const text = mirror.firstChild;
    if (!text || start < 0 || end > editor.value.length || start >= end) return;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    const rect = range.getBoundingClientRect();
    const top = rect.top - mirror.getBoundingClientRect().top;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const availableHeight = Math.max(1, Math.min(editor.clientHeight - 32, viewportHeight - viewportTop - 16));
    // Center a short replacement. If it cannot fit, show its beginning rather
    // than the caret at the end of a long selection.
    const inset = rect.height <= availableHeight ? (availableHeight - rect.height) / 2 + 16 : 16;
    editor.scrollTo({ top: Math.max(0, top - inset), left: 0, behavior: 'instant' });
    const editorRect = editor.getBoundingClientRect();
    const selectedTop = editorRect.top + editor.clientTop + top - editor.scrollTop;
    const selectedBottom = selectedTop + Math.min(rect.height, availableHeight);
    if (selectedTop < viewportTop || selectedBottom > viewportHeight - 16) {
      const pageInset = viewportTop + Math.max(0, (viewportHeight - viewportTop - 16 - rect.height) / 2);
      window.scrollBy({ top: selectedTop - pageInset, behavior: 'instant' });
    }
  } finally { mirror.remove(); }
}
