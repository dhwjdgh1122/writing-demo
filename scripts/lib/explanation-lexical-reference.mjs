// Evaluation only: the same two definitions are placed in the instruction arm
// or as a fixed user-data field in the reference arm. No case-specific answers.
import { explanationInstruction } from '../../server/llm/prompt.ts';

// Korean definitions checked on the National Institute of Korean Language's
// Korean Basic Dictionary on 2026-11-22. URLs are provenance, not runtime fetches.
export const lexicalReferences = [
  {
    term: '결재하다',
    definition: '업무를 결정할 권한이 있는 윗사람이 아랫사람이 낸 안건을 허가하거나 승인하다.',
    sourceUrl: 'https://krdict.korean.go.kr/chn/dicSearch/SearchView?ParaWordNo=32128',
  },
  {
    term: '결제하다',
    definition: '물건값이나 내어 줄 돈을 주고 거래를 끝내다.',
    sourceUrl: 'https://krdict.korean.go.kr/eng/dicSearch/SearchView?ParaWordNo=32140',
  },
];

const common = `${explanationInstruction}
lexicalReferences는 단어 뜻의 참고 자료이며 특정 후보의 정답이나 사용자의 의도가 아니다. 현재 문장의 실제 문맥에 적용되는지 확인한다.
원문과 후보 사이의 실제 변경을 먼저 설명하고, 후보에 그대로 남은 단어라도 문맥상 명백히 맞지 않으면 그 한계를 짧게 덧붙인다. 참고 단어가 있다는 이유만으로 오류를 찾거나 모호한 상황을 지불·승인으로 단정하지 않는다.
참고 자료가 있더라도 날짜·숫자·조건·부정·확정 여부의 중요한 변화를 빠뜨리지 않는다. 사전 정의와 실제 변경 근거를 구분한다. 사전 뜻을 문장에 있었던 표현처럼 인용하지 않으며 URL이나 새 교정 후보를 출력하지 않는다.
인용은 현재 sourceText 또는 해당 후보에 실제로 존재하는 표현에만 사용하고, 원문·후보에 없는 용어 풀이에는 인용 부호를 쓰지 않는다.`;

export const definitionInstruction = `${common}\n${JSON.stringify({ lexicalReferences })}`;
export const referenceInstruction = common;
