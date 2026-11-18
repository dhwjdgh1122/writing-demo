// Measure the active selection edge in a hidden mirror of the textarea.
// A textarea does not expose a DOM Range for its text contents.
export function selectionAnchor(editor: HTMLTextAreaElement): { left: number; top: number } | null {
  if (editor.selectionStart === editor.selectionEnd) return null;
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const mirror = document.createElement('div');
  const properties = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;
  for (const property of properties) mirror.style[property] = style[property];
  Object.assign(mirror.style, { position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden', boxSizing: 'border-box', width: `${editor.clientWidth}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  const offset = editor.selectionDirection === 'backward' ? editor.selectionStart : editor.selectionEnd;
  mirror.textContent = editor.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = editor.value.slice(offset) || '\u200b';
  mirror.append(marker);
  document.body.append(mirror);
  const markerRect = marker.getClientRects()[0];
  const mirrorRect = mirror.getBoundingClientRect();
  const x = rect.left + editor.clientLeft + markerRect.left - mirrorRect.left - editor.scrollLeft;
  const y = rect.top + editor.clientTop + markerRect.top - mirrorRect.top - editor.scrollTop;
  const lineHeight = parseFloat(style.lineHeight);
  mirror.remove();
  const visibleTop = Math.max(rect.top, 8);
  const visibleBottom = Math.min(rect.bottom, window.innerHeight - 8);
  if (y + lineHeight < visibleTop || y > visibleBottom || visibleBottom - visibleTop < 96) return null;
  const left = Math.max(Math.max(rect.left + 8, 8), Math.min(x, rect.right - 132, window.innerWidth - 140));
  const below = y + lineHeight + 6;
  const top = below + 44 <= visibleBottom ? below : Math.max(visibleTop, y - 50);
  return { left, top };
}
