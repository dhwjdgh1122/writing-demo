// Reused from PR #34, commit d2d8c42, server/llm/explanation-spacing.ts.
// Count changed U+0020 characters, not the number of edited positions. Equal
// non-space text is NOT proof of equal meaning (아버지가 방 / 아버지 가방,
// or 1 5명 / 15명). This statement makes no grammar or meaning judgment.
export function spacingOnlyExplanation(source: string, candidate: string): string | undefined {
  if (source === candidate) return undefined;
  const split = (text: string) => {
    const characters: string[] = [];
    const gaps = [0];
    for (const character of text) {
      if (character === ' ') gaps[gaps.length - 1]++;
      else { characters.push(character); gaps.push(0); }
    }
    return { characters: characters.join(''), gaps };
  };
  const before = split(source);
  const after = split(candidate);
  // Tabs, LF/CRLF, NBSP, punctuation, digits and Unicode composition stay exact.
  if (!before.characters || before.characters !== after.characters) return undefined;
  let added = 0;
  let removed = 0;
  for (let i = 0; i < before.gaps.length; i++) {
    const difference = after.gaps[i] - before.gaps[i];
    if (difference > 0) added += difference;
    else removed -= difference;
  }
  const change = added && removed ? `공백 ${added}개를 추가하고 ${removed}개를 삭제했습니다.`
    : added ? `공백 ${added}개를 추가했습니다.` : `공백 ${removed}개를 삭제했습니다.`;
  return `${change} 원문 비교에서 공백이 바뀐 위치가 의도에 맞는지 확인해 주세요.`;
}
