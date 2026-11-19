// Manual evaluation only: separate visible prose roles without semantic categories,
// remaining-word review, extra model calls, or server-generated choice advice.
import { z } from 'zod';
import { explanationResponseSchema } from '../../server/llm/explanation-response.ts';

export function impactInstruction(base) {
  return base.split('\n').filter(line => !['후보마다', 'explanation에는', 'JSON 객체', '최종 표시되는']
    .some(prefix => line.startsWith(prefix))).join('\n') + `
explanation 대신 아래 세 필드에 사용자가 읽을 설명을 나누어 작성한다. 내부 사고 과정이나 분석 메모가 아니라 최종 표시 문장이다.
summary: 무엇을 어떻게 바꿨는지 쉬운 말로 한 문장. 단순 오타·공백 수정은 이 문장만으로 충분하다. references에 이미 있는 구절 쌍을 그대로 반복하지 않는다.
impact: 중요한 의미가 달라질 때, 후보를 읽는 사람이 원문과 다르게 이해하게 되는 내용을 한 문장으로 설명한다. 조건·일정·인원이 변경됐다는 분류명 나열로 끝내지 말고, 어떤 조건에서 무엇을 하게 되는지, 일정이나 대상이 어떻게 구체적이지 않게 되는지 등 실제 전달 내용의 차이를 풀어 쓴다. 제공되지 않은 현실의 허용·의무나 결과를 추측하지 않는다.
choice: 그 차이가 있을 때 어떤 정보를 전달하려는 사람에게 원래 표현을 유지하는 것이 맞는지 조건부로 한 문장 안내한다. 실제로 바뀐 핵심 정보에 연결하고 무조건 적용 금지·적용 권장은 하지 않는다.
중요한 뜻이 그대로이고 표기·표현만 달라진 경우 impact와 choice를 모두 빈 문자열로 반환한다. 정보가 유지된 표현 다듬기에 경고를 만들지 않는다. 하나만 비우지 않는다.
각 문장은 줄바꿈 없이 작성한다. 인용할 때는 해당 원문 또는 후보에 실제 있는 연속 문자열과 정확히 닫힌 따옴표만 쓴다. 기본형 풀이는 직접 인용과 구분한다.
화면에는 references와 summary·impact·choice를 순서대로 합친다. 전체 400자 이내가 되도록 근거를 짧게 잡고 서술은 최대 세 문장으로 간결하게 쓴다. 필수 의미 변화는 생략하지 않는다.
JSON 객체 {"explanations":[{"candidateId":"입력 id","references":[{"before":"원문 실제 구절","after":"후보 실제 구절"}],"summary":"변경 요약","impact":"전달 내용의 영향 또는 빈 문자열","choice":"조건부 선택 기준 또는 빈 문자열"}]}만 반환한다.`;
}

export function impactResponseSchema(ids) {
  const schema = explanationResponseSchema(ids);
  const entry = schema.properties.explanations.items;
  delete entry.properties.explanation;
  for (const key of ['summary', 'impact', 'choice']) entry.properties[key] = { type: 'string' };
  entry.required = ['candidateId', 'references', 'summary', 'impact', 'choice'];
  return schema;
}

const prose = z.string().refine(s => [...s].length <= 400 && !/[\r\n]/.test(s));
const draftSchema = z.object({
  candidateId: z.string(), references: z.array(z.object({ before: z.string(), after: z.string() }).strict()),
  summary: prose.refine(s => s.trim().length > 0),
  impact: prose.refine(s => s === '' || s.trim().length > 0),
  choice: prose.refine(s => s === '' || s.trim().length > 0),
}).strict().refine(d => (d.impact === '') === (d.choice === ''));

export function resolveImpact(decoded) {
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
    || Object.keys(decoded).length !== 1 || !Array.isArray(decoded.explanations)) return decoded;
  return { explanations: decoded.explanations.map(raw => {
    const result = draftSchema.safeParse(raw);
    // Preserve IDs (including invalid/foreign ones) so the production root check
    // still rejects ownership errors; malformed prose never becomes a good sibling.
    if (!result.success) return { candidateId: raw?.candidateId };
    const { candidateId, references, summary, impact, choice } = result.data;
    return { candidateId, references, explanation: [summary, impact, choice].filter(s => s !== '').join(' ') };
  }) };
}
