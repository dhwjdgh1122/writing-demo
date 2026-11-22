import { useId, useRef, useEffect } from 'react';
import type { RetryRequirement } from '../../../shared/contracts';
import { Icon } from './Icon';

export type RerunSelection = RetryRequirement | '';
const options: { value: RerunSelection; label: string }[] = [
  { value: '', label: '선택 안 함' }, { value: 'alternative', label: '다른 표현' },
  { value: 'polite', label: '더 정중하게' }, { value: 'plain', label: '더 담백하게' },
  { value: 'meaning', label: '원래 뜻 유지' }, { value: 'errors', label: '남은 오류 수정' },
];

export function RerunControls({ phase, open, requirement, disabled, pending, problem, error, onToggle, onChange, onRun }: {
  phase: 'before_apply' | 'after_apply'; open: boolean; requirement: RerunSelection;
  disabled: boolean; pending: boolean; problem: string | null; error: string | null;
  onToggle: () => void; onChange: (value: RerunSelection) => void; onRun: () => void;
}) {
  const id = useId();
  const submitRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && error && open) submitRef.current?.focus({ preventScroll: true });
    wasPending.current = pending;
  }, [pending, error, open]);
  return <div className={`rerun-entry ${phase === 'after_apply' ? 'rerun-after-apply' : ''}`}>
    <button type="button" className={phase === 'before_apply' ? 'apply-button rerun-toggle' : 'secondary-button rerun-toggle'}
      disabled={pending} aria-expanded={open} aria-controls={id} onClick={onToggle}>
      다시 교정하기<span className={`rerun-chevron ${open ? 'is-open' : ''}`}><Icon name="back" size={17} /></span>
    </button>
    {open && <section id={id} className="rerun-controls" aria-label="재교정 요청" aria-busy={pending}>
      <fieldset disabled={pending}>
        <legend>이번에는 어떤 점을 바꾸고 싶나요? <span>(선택 사항)</span></legend>
        <p id={`${id}-help`}>{phase === 'after_apply' ? '적용된 현재 문장을 기준으로 후보 3개를 다시 만듭니다.' : '처음 선택한 원문을 기준으로 후보 3개를 다시 만듭니다.'}</p>
        <div className="rerun-options" aria-describedby={`${id}-help`}>
          {options.map(option => <label className="rerun-option" key={option.value}>
            <input type="radio" name={`${id}-requirement`} value={option.value} checked={requirement === option.value} onChange={() => onChange(option.value)} />
            <span>{option.label}</span>
          </label>)}
        </div>
      </fieldset>
      {problem && <p className="over-limit">{problem}</p>}
      {error && <p className="rerun-error" role="alert">{error} 선택한 요구를 유지했습니다.</p>}
      <div className="rerun-submit-row"><button ref={submitRef} type="button" className="secondary-button" disabled={disabled} onClick={onRun}>
        {pending ? <><span className="spinner" />교정 중</> : error ? '다시 시도' : '교정 시작'}
      </button></div>
    </section>}
  </div>;
}
