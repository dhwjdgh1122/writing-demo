import { useId, useState } from 'react';
import type { ActivityApi } from '../hooks/useActivity';
import { activityRequirementStats, activityStats } from '../lib/activity';
import type { HistoryRecord } from '../lib/history';

export function ActivityPanel({ activity, historyRecords }: { activity: ActivityApi; historyRecords: HistoryRecord[] }) {
  const headingId = useId();
  const codeId = useId();
  const [code, setCode] = useState(activity.participantCode);
  const [includeContent, setIncludeContent] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const stats = activityStats(activity.events);
  const requirementStats = activityRequirementStats(activity.events).filter(row => row.requested > 0);
  const saveCode = () => {
    setFeedback(activity.setParticipantCode(code)
      ? '앞으로 발생하는 행동 기록에 새 참여자 코드를 사용합니다. 이전 기록은 바뀌지 않습니다.'
      : '참여자 코드는 영문·숫자·밑줄·하이픈으로 1~40자 입력해주세요.');
  };
  const download = (format: 'json' | 'csv') => {
    let url: string | null = null;
    let link: HTMLAnchorElement | null = null;
    try {
      const data = format === 'json' ? activity.exportJson(historyRecords, includeContent) : activity.exportCsv(historyRecords, includeContent);
      url = URL.createObjectURL(new Blob([data], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' }));
      link = document.createElement('a'); link.href = url;
      link.download = `writing-demo-activity-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(link); link.click();
      setFeedback('행동 기록을 내보냈습니다. 공유 전에 파일 내용을 확인해주세요.');
    } catch { setFeedback('내보내지 못했습니다. 브라우저 다운로드 설정을 확인한 뒤 다시 시도해주세요.'); }
    finally { link?.remove(); if (url) { const value = url; setTimeout(() => URL.revokeObjectURL(value), 1_000); } }
  };
  const clear = () => {
    if (!window.confirm('이 브라우저의 행동 기록을 모두 삭제할까요? 교정 이력과 현재 글은 유지되며 삭제한 행동 기록은 복구할 수 없습니다.')) return;
    activity.clear();
  };
  const reset = () => {
    if (!window.confirm('읽지 못한 기존 저장 데이터와 현재 행동 기록을 초기화할까요? 교정 이력은 유지됩니다. 필요한 기록은 먼저 내보내세요.')) return;
    activity.reset();
  };
  return <section className="activity-panel panel" aria-labelledby={headingId}>
    <div className="history-heading"><h2 id={headingId}>행동 기록<span>{activity.events.length}개</span></h2></div>
    <p className="history-notice">참여자 코드·요구 유형·요청·적용·오류를 이 브라우저에 저장합니다. 문장 내용은 행동 기록에 저장하지 않으며 다른 기기와 동기화되지 않습니다. 참여자 코드는 로그인이나 실제 사용자 신원 확인이 아닙니다.</p>
    <div className="activity-participant">
      <label htmlFor={codeId}>참여자 코드</label>{' '}
      <input id={codeId} value={code} maxLength={40} autoComplete="off" spellCheck={false} onChange={event => setCode(event.target.value)} />{' '}
      <button className="secondary-button" type="button" onClick={saveCode}>참여자 코드 적용</button>
      <p className="history-explanation-note">현재 코드: {activity.participantCode}. 같은 브라우저에서 다음에 사용할 코드도 저장합니다. 변경은 현재 창의 이후 행동에만 반영되며, 이미 열린 다른 창과 과거 기록은 바뀌지 않습니다. 실명·연락처는 입력하지 마세요.</p>
      {activity.participantStorageError && <p className="history-storage-status" role="status">{activity.participantStorageError}</p>}
    </div>
    <p className="history-explanation-note">아래 통계는 이 브라우저에 남아 있는 모든 참여자 코드의 기록을 합산합니다. 재교정 요청 {stats.reruns}건 중 결과를 받은 요청 {stats.receivedReruns}건. 그중 후보를 적용한 요청 {stats.appliedReruns}/{stats.receivedReruns}건, 다시 재교정한 요청 {stats.rerequestedReruns}/{stats.receivedReruns}건입니다. 모두 요청 ID 기준이며 두 항목은 겹칠 수 있습니다.</p>
    {requirementStats.length > 0 && <div className="activity-stats-scroll"><table className="activity-stats-table">
      <caption>요구 유형별 재교정 기록</caption>
      <thead><tr><th scope="col">요구</th><th scope="col">요청</th><th scope="col">결과 받음</th><th scope="col">실패</th><th scope="col">취소</th><th scope="col">후보 적용 / 결과 받음</th></tr></thead>
      <tbody>{requirementStats.map(row => <tr key={row.key}><th scope="row">{row.label}</th><td>{row.requested}</td><td>{row.received}</td><td>{row.failed}</td><td>{row.cancelled}</td><td>{row.applied} / {row.received}</td></tr>)}</tbody>
    </table></div>}
    {requirementStats.length > 0 && <p className="history-explanation-note">요청 기록이 남아 있는 재교정만 집계합니다. 후보 적용의 분모는 해당 요구로 결과를 받은 요청이며, 실패·취소·결과 수신 기록이 한 요청에 함께 남으면 각 항목에 집계됩니다.</p>}
    <p className="history-notice">후보 적용은 만족이나 요구 충족을 확정하지 않습니다. 요구가 해결됐는지와 교정 설명이 판단에 도움이 됐는지는 별도로 검증해야 합니다. 기록이 없는 행동이나 다른 브라우저의 행동은 알 수 없습니다.</p>
    <label className="activity-content-option"><input type="checkbox" checked={includeContent} onChange={event => setIncludeContent(event.target.checked)} /> 문장 내용 포함</label>
    <p className="history-explanation-note">기본 내보내기는 행동 정보만 포함합니다. 문장 내용 포함을 선택하면 현재 교정 이력에 남아 있는 원문·후보·받아 둔 설명을 함께 내보냅니다. 삭제한 이력의 문장은 포함하지 않습니다.</p>
    <div className="history-actions">
      <button type="button" className="secondary-button" disabled={!activity.events.length} onClick={() => download('json')}>행동 JSON 내보내기</button>
      <button type="button" className="secondary-button" disabled={!activity.events.length} onClick={() => download('csv')}>행동 CSV 내보내기</button>
      <button type="button" className="secondary-button history-delete" disabled={!activity.events.length} onClick={clear}>행동 기록 전체 삭제</button>
    </div>
    {activity.error && <div className="history-storage-status" role="status"><p>{activity.error}</p>
      {activity.status === 'corrupt' ? <button className="secondary-button" type="button" onClick={reset}>행동 기록 저장소 초기화</button>
        : <button className="secondary-button" type="button" onClick={activity.retry}>행동 기록 저장 다시 시도</button>}
    </div>}
    <p className="history-feedback" role="status" aria-live="polite">{feedback ?? (activity.status === 'saving' ? '행동 기록을 저장하고 있습니다.' : activity.status === 'saved' ? '이 브라우저에 행동 기록이 저장되었습니다.' : '')}</p>
  </section>;
}
