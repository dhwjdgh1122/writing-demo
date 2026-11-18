import { useLayoutEffect, useRef } from 'react';

// Visual mirror only: the textarea remains the sole editor and the dialog owns focus.
export function SelectionHighlight({ editor, text, start, end }: {
  editor: HTMLTextAreaElement | null; text: string; start: number; end: number;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const mirror = mirrorRef.current;
    if (!editor || !mirror) return;
    const sync = () => {
      const style = getComputedStyle(editor);
      const properties = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'textAlign', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;
      for (const property of properties) mirror.style[property] = style[property];
      Object.assign(mirror.style, { left: `${editor.offsetLeft + editor.clientLeft}px`, top: `${editor.offsetTop + editor.clientTop}px`, width: `${editor.clientWidth}px`, height: `${editor.clientHeight}px` });
      mirror.scrollTop = editor.scrollTop;
      mirror.scrollLeft = editor.scrollLeft;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(editor);
    editor.addEventListener('scroll', sync);
    return () => { observer.disconnect(); editor.removeEventListener('scroll', sync); };
  }, [editor, text, start, end]);

  return <div ref={mirrorRef} className="selection-highlight" aria-hidden="true">
    {text.slice(0, start)}<mark>{text.slice(start, end)}</mark>{text.slice(end)}{'\u200b'}
  </div>;
}
