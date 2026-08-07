export function getBotLanguagePresentation(language) {
  if (language === 'ko') {
    return { language: 'ko', label: '🇰🇷 Korean', boardsLabel: '보드', guessesLabel: '추측' };
  }
  if (language === 'zh') {
    return { language: 'zh', label: '🇨🇳 Chinese', boardsLabel: 'Boards', guessesLabel: 'Guesses' };
  }
  return { language: 'en', label: '🇺🇸 English', boardsLabel: 'Boards', guessesLabel: 'Guesses' };
}

export function getBotCompletionStatus(won) {
  return won ? { emoji: '🏆', label: 'won' } : { emoji: '😔', label: 'lost' };
}
