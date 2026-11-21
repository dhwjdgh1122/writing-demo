import { useId, useState } from 'react';
import type { RetryRequirement } from '../../../shared/contracts';

export function RerunControls({ phase, disabled, pending, problem, onRun }: {
  phase: 'before_apply' | 'after_apply'; disabled: boolean; pending: boolean;
  problem: string | null; onRun: (requirement?: RetryRequirement) => void;
}) {
  const [requirement, setRequirement] = useState<RetryRequirement | ''>('');
  const selectId = useId();
  return <section className="rerun-controls" aria-label="재교정 요청">
    <h3>다시 다듬기</h3>
    <p>{phase === 'after_apply' ? '방금 적용한 현재 문장을 기준으로 다시 교정합니다.' : '아직 적용하지 않은 원문을 기준으로 다른 후보를 만듭니다.'}</p>
    <label htmlFor={selectId}>이번에는 어떤 점을 바꾸고 싶나요? (선택 사항)</label>
    <select id={selectId} value={requirement} disabled={pending} onChange={event => setRequirement(event.target.value as RetryRequirement | '')}>
      <option value="">선택 안 함 · 일반 재교정</option>
      <option value="alternative">다른 표현을 보고 싶어요</option>
      <option value="polite">더 정중하게 바꾸고 싶어요</option>
      <option value="plain">더 담백하게 바꾸고 싶어요</option>
      <option value="meaning">원래 뜻을 유지하고 싶어요</option>
      <option value="errors">오류가 남았어요</option>
    </select>
    <p className="rerun-help">선택한 요구와 이전 선택 원문·후보를 새 교정에 전달합니다. 선택하지 않으면 일반 교정을 실행합니다.</p>
    {problem && <p className="over-limit">{problem}</p>}
    <button type="button" className="secondary-button" disabled={disabled} onClick={() => onRun(requirement || undefined)}>{pending ? '교정 중' : '다시 교정하기'}</button>
  </section>;
}
