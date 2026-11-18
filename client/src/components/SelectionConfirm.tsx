import { useLayoutEffect, useRef } from 'react';
import { Icon } from './Icon';

export function SelectionConfirm({ text, count, onCancel, onConfirm }: {
  text: string; count: number; onCancel: () => void; onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    titleRef.current?.focus({ preventScroll: true });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { dialog.close(); document.body.style.overflow = overflow; };
  }, []);

  return <dialog ref={dialogRef} className="selection-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-help" onCancel={event => { event.preventDefault(); onCancel(); }} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]');
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
      event.preventDefault(); last?.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first?.focus({ preventScroll: true });
    }
  }}>
    <div className="confirm-header"><h2 id="confirm-title" ref={titleRef} tabIndex={-1}>이 문장을 교정할까요?</h2><button className="confirm-close" aria-label="닫기" onClick={onCancel}><Icon name="close" size={20} /></button></div>
    <p id="confirm-help">선택한 부분만 교정합니다. 수정하려면 원문으로 돌아가세요.</p>
    <p className="confirm-count">선택한 글 {count.toLocaleString()}자 · 최대 1,000자까지 교정할 수 있어요 · 읽기 전용</p>
    <div className="confirm-text" role="region" aria-label="선택한 문장" tabIndex={0} data-testid="selected-text">{text}</div>
    <div className="confirm-actions"><button className="secondary-button" onClick={onCancel}>원문으로 돌아가기</button><button className="primary-button" onClick={onConfirm}>교정 시작<Icon name="arrow" size={17} /></button></div>
  </dialog>;
}
