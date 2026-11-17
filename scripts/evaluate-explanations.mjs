// Historical before/after tool retired: its baseline uses the old free-text output.
// Do not send incompatible prompts through the new referenced-explanation parser.
console.error('이전 프롬프트 비교 도구는 출력 형식 변경으로 중단했습니다. 실제 API는 호출하지 않았습니다.');
console.error('현재 평가: node --import tsx scripts/evaluate-explanation-criteria.mjs (입력 확인), --live (명시적 실제 호출). 과거 결과는 docs/evaluations에 보존돼 있습니다.');
process.exitCode = 1;
