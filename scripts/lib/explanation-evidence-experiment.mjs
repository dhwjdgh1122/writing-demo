// Offline/manual experiment only. Not imported by the application or server startup.
// Unlike PR #23's advisory diff input, returned IDs resolve to server-owned text.
export function buildEvidenceInput(sourceText, candidates) {
  return { sourceText, candidates: candidates.map((candidate, index) => {
    const beforeLines = sourceText.split('\n');
    const afterLines = candidate.text.split('\n');
    let pairs = beforeLines.length === afterLines.length
      ? beforeLines.flatMap((before, line) => before === afterLines[line] ? [] : [{ before, after: afterLines[line] }])
      : [{ before: sourceText, after: candidate.text }];
    // Never truncate evidence. Changed line counts or many lines use a whole-text pair.
    // This prototype is not a linguistic diff and may exceed the existing display budget.
    if (pairs.length > 12) pairs = [{ before: sourceText, after: candidate.text }];
    return { ...candidate, evidence: pairs.map((pair, i) => ({ id: `c${index + 1}-e${i + 1}`, ...pair })) };
  }) };
}

export function evidenceInstruction(base) {
  return base.split('\n').filter(line => ![
    '실제 변경 근거는', '삭제는 after를', 'explanation에는', '예를 들어 후보의', '띄어쓰기 변경은',
    '최종 표시되는', 'JSON 객체',
  ].some(prefix => line.startsWith(prefix))).join('\n') + `
각 후보의 evidence는 서버가 원문과 후보에서 그대로 가져온 변경 행 쌍이다. 의미나 올바름을 판정한 결과가 아니다.
원문과 후보 전체를 읽고 실제 표현·중요 정보의 차이를 판단한다. 같은 기본 뜻의 하나였다와 유일했다만으로 의미가 달라졌다고 단정하지 않는다.
근거 문자열을 새로 생성하지 않는다. 해당 후보 evidence의 모든 id를 evidenceIds에 한 번씩 그대로 반환한다. 다른 후보의 id는 쓰지 않는다.
원문과 완전히 동일한 후보만 evidenceIds가 빈 배열이다. 의미가 같아도 표현이 바뀌었다면 변경이 없다고 하지 않는다.
explanation에는 변화의 영향과 선택에 참고할 내용을 한국어 1~2문장으로 적는다. 직접 인용·따옴표·줄바꿈은 넣지 않는다. 단어의 기본형을 풀이할 수 있지만 실제 인용으로 쓰지 않는다.
화면에는 서버가 근거와 설명을 합쳐 표시하므로 before/after와 explanation을 합쳐 400자 이내가 되도록 설명을 간결하게 쓴다.
JSON 객체 {"explanations":[{"candidateId":"입력 id","evidenceIds":["해당 후보의 근거 id"],"explanation":"인용 없는 설명"}]}만 반환한다.`;
}

export function evidenceResponseSchema(input) {
  return { type: 'object', properties: { explanations: { type: 'array', minItems: 1, maxItems: 3,
    items: { type: 'object', properties: {
      candidateId: { type: 'string', enum: input.candidates.map(c => c.id) },
      evidenceIds: { type: 'array', items: { type: 'string' } },
      explanation: { type: 'string' },
    }, required: ['candidateId', 'evidenceIds', 'explanation'], additionalProperties: false },
  } }, required: ['explanations'], additionalProperties: false };
}

export function resolveEvidence(input, decoded) {
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.keys(decoded).length !== 1
    || !Array.isArray(decoded.explanations)) return decoded;
  return { explanations: decoded.explanations.map(draft => {
    const candidate = input.candidates.find(c => c.id === draft?.candidateId);
    if (!candidate || !draft || typeof draft !== 'object') return draft;
    const ids = draft.evidenceIds;
    const valid = Object.keys(draft).sort().join(',') === 'candidateId,evidenceIds,explanation'
      && Array.isArray(ids) && ids.length === candidate.evidence.length && new Set(ids).size === ids.length
      && ids.every(id => candidate.evidence.some(e => e.id === id));
    // Preserve the candidate association; the production parser marks only this draft invalid.
    // Do not repair missing/foreign IDs, infer evidence, strip prose quotes or relax validation.
    if (!valid) return { candidateId: draft.candidateId, explanation: draft.explanation };
    return { candidateId: draft.candidateId, references: candidate.evidence.map(({ before, after }) => ({ before, after })),
      explanation: draft.explanation };
  }) };
}
