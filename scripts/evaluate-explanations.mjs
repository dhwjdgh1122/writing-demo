// Historical free-text prompt comparison. Preserved evaluations remain in docs/evaluations.
// The old runner is available at main baseline fab6adec; it cannot fairly compare
// its free-text baseline with the current structured-evidence response contract.
console.error('이전 자유문 프롬프트 비교는 새 응답 형식과 호환되지 않습니다. 현재 버전 평가는 node --import tsx scripts/evaluate-explanation-criteria.mjs로 시작하세요. 과거 결과는 docs/evaluations에 보존되어 있습니다. 모델은 호출하지 않았습니다.');
process.exitCode = 1;
