// Manual evaluation only. No application import, environment access or model call.
// Run consumers with `node --import tsx` so the existing TypeScript prompt is used.
import { explanationInstruction } from '../../server/llm/prompt.ts';

// Preserve the current product instruction, including the 1–2-sentence / 400-character
// limit and the candidateId/explanation-only JSON contract, without replacement.
export const baselineInstruction = explanationInstruction;

// Reuse the four synthetic examples verbatim from PR #34's experiment module:
// 54c1bd416f3873622a83a3bc3ab03b0dac1adf8e:scripts/lib/explanation-contrast-experiment.mjs.
// This tests the same contrast principle under today's free-form output contract;
// it is not a new prompting principle or evidence that the previous trial succeeded.
// No evaluation cases, expected answers, residual-error rules, or new spacing examples
// are added here. The example block is the only difference between the two arms.
export const contrastExamples = `
아래는 설명 범위와 표현 수준의 예시다. 예시의 단어나 수치를 실제 입력의 설명에 복사하지 않는다. 출력 형식과 정확한 인용 규칙은 앞의 지침을 따른다.

예시 1 — 여러 중요한 정보가 함께 바뀜
원문: 결제가 확인되면 화요일에 8명에게 발송합니다.
후보: 결제 확인 없이 나중에 발송합니다.
부족한 설명: 발송 시점이 불분명해졌습니다.
적절한 설명: 결제 확인이 필요하다는 조건이 없어지고, 화요일이라는 일정과 8명이라는 대상 인원이 빠졌습니다. 결제 확인 후 정해진 날에 정해진 인원에게 보내려는 뜻이라면 세 정보를 유지하는 표현이 맞습니다.

예시 2 — 표기만 달라지고 정보는 유지됨
원문: 접수가 끝난 경우에만 수요일에 열두 명에게 답합니다.
후보: 접수가 끝나야 수요일에 12명에게 답합니다.
부적절한 설명: 접수 조건과 대상 인원이 없어졌습니다.
적절한 설명: 접수가 끝나야 답한다는 조건과 수요일, 열두 명이라는 정보는 그대로이며 조건과 인원의 표기만 바뀌었습니다.

예시 3 — 오타와 띄어쓰기를 구분
원문: 답을 적어 주세오.
후보: 답을 적어주세요.
부적절한 설명: 더 정중한 종결 어미로 고쳐 문법이 완벽해졌습니다.
적절한 설명: 주세오의 오타를 주세요로 고치고, 적어와 주세요 사이의 공백을 없앴습니다.

예시 4 — 시간 상태를 지어내지 않음
원문: 다음 달에 상담을 시작합니다.
후보: 다음 달에 상담을 진행합니다.
부적절한 설명: 상담을 이미 하고 있다는 뜻이 되었습니다.
적절한 설명: 상담을 시작한다는 표현을 상담을 한다는 표현으로 바꿨습니다. 시작 시점을 강조하려는 뜻이라면 시작합니다를 유지할 수 있습니다.
`;

export const contrastInstruction = `${baselineInstruction}\n${contrastExamples}`;
