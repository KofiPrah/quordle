export const KOREAN_REJECTED_GUESS_MESSAGES = Object.freeze({
  loading: '단어 확인 중… · Checking word…',
  'recognized-unaccepted': '유효한 한국어 단어이지만 현재 게임에서는 허용되지 않습니다. · Valid Korean word, but not accepted in this game.',
  unrecognized: '이 한국어 사전에서 찾을 수 없습니다. · Not found in this Korean dictionary.',
  'load-failure': '단어 목록에 없습니다 · Not in the game word list. Suggestions are temporarily unavailable.',
});

const LEVEL_LABELS = Object.freeze({
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  ungraded: 'Ungraded',
});

export function createKoreanFeedback(kind, suggestions = [], sourceWord = '') {
  return {
    kind,
    message: KOREAN_REJECTED_GUESS_MESSAGES[kind] ?? '',
    sourceWord: typeof sourceWord === 'string' ? sourceWord.normalize('NFC') : '',
    suggestions: Array.isArray(suggestions) ? suggestions.slice(0, 3) : [],
  };
}

export function createMessageFeedback(message, kind = 'error') {
  return {
    kind,
    message: String(message ?? ''),
    sourceWord: '',
    suggestions: [],
  };
}

export function toKoreanNearbySuggestions(rankedSuggestions, entries) {
  if (!Array.isArray(rankedSuggestions) || !entries) return [];
  return rankedSuggestions.slice(0, 3).flatMap((suggestion) => {
    const entry = entries[suggestion.word];
    if (!entry) return [];
    const gloss = entry.senses?.[0]?.translations?.[0] ?? 'Open dictionary';
    return [{
      word: suggestion.word,
      romanization: entry.romanization ?? '',
      gloss,
      level: suggestion.level,
      levelLabel: LEVEL_LABELS[suggestion.level] ?? LEVEL_LABELS.ungraded,
    }];
  });
}

export function getFeedbackSuggestionWords(feedback) {
  if (!Array.isArray(feedback?.suggestions)) return [];
  return feedback.suggestions
    .map((suggestion) => suggestion?.word)
    .filter((word) => typeof word === 'string' && word.length > 0);
}

export function isKoreanDiscoveryRequestCurrent({
  requestId,
  activeRequestId,
  sourceWord,
  currentWord,
  currentLanguage,
  gameOver,
}) {
  return (
    requestId === activeRequestId
    && currentLanguage === 'ko'
    && gameOver !== true
    && typeof sourceWord === 'string'
    && sourceWord.normalize('NFC') === String(currentWord ?? '').normalize('NFC')
  );
}
