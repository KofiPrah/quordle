import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KOREAN_REJECTED_GUESS_MESSAGES,
  createKoreanFeedback,
  getFeedbackSuggestionWords,
  isKoreanDiscoveryRequestCurrent,
  toKoreanNearbySuggestions,
} from '../src/rejectedGuessFeedback.js';

test('recognized and unrecognized feedback use distinct bilingual messages', () => {
  const recognized = createKoreanFeedback('recognized-unaccepted', [], '기품');
  const unrecognized = createKoreanFeedback('unrecognized', [], '학일');

  assert.equal(recognized.message, KOREAN_REJECTED_GUESS_MESSAGES['recognized-unaccepted']);
  assert.match(recognized.message, /Valid Korean word/);
  assert.equal(unrecognized.message, KOREAN_REJECTED_GUESS_MESSAGES.unrecognized);
  assert.match(unrecognized.message, /Not found/);
});

test('nearby suggestions are enriched, capped, and expose only display metadata', () => {
  const ranked = [
    { word: '학생', level: 'beginner', score: 10, jamoDistance: 1 },
    { word: '학원', level: 'intermediate', score: 9, jamoDistance: 2 },
    { word: '학기', level: 'beginner', score: 8, jamoDistance: 2 },
    { word: '학습', level: 'advanced', score: 7, jamoDistance: 2 },
  ];
  const entries = Object.fromEntries(ranked.map(({ word }, index) => [word, {
    word,
    romanization: `romanization-${index}`,
    senses: [{ translations: [`gloss-${index}`] }],
  }]));
  const suggestions = toKoreanNearbySuggestions(ranked, entries);

  assert.equal(suggestions.length, 3);
  assert.deepEqual(Object.keys(suggestions[0]).sort(), ['gloss', 'level', 'levelLabel', 'romanization', 'word']);
  assert.deepEqual(getFeedbackSuggestionWords(createKoreanFeedback('unrecognized', suggestions)), ['학생', '학원', '학기']);
});

test('async discovery results are rejected after input, language, game, or request changes', () => {
  const baseline = {
    requestId: 4,
    activeRequestId: 4,
    sourceWord: '기품',
    currentWord: '기품',
    currentLanguage: 'ko',
    gameOver: false,
  };

  assert.equal(isKoreanDiscoveryRequestCurrent(baseline), true);
  assert.equal(isKoreanDiscoveryRequestCurrent({ ...baseline, activeRequestId: 5 }), false);
  assert.equal(isKoreanDiscoveryRequestCurrent({ ...baseline, currentWord: '기차' }), false);
  assert.equal(isKoreanDiscoveryRequestCurrent({ ...baseline, currentLanguage: 'en' }), false);
  assert.equal(isKoreanDiscoveryRequestCurrent({ ...baseline, gameOver: true }), false);
});
