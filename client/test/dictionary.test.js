import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml,
  getDefaultDictionaryWord,
  getDictionaryEligibleWords,
  getKoreanDictionaryEntry,
} from '../src/dictionary.js';

function createState({ gameOver = false } = {}) {
  return {
    language: 'ko',
    gameOver,
    boards: [
      { targetWord: '기관', guesses: ['기차', '학교'], solved: false },
      { targetWord: '기차', guesses: ['기차', '학교'], solved: true },
      { targetWord: '사과', guesses: ['기차', '학교'], solved: false },
      { targetWord: '학교', guesses: ['기차', '학교'], solved: false },
    ],
  };
}

const entries = {
  '기관': { word: '기관' },
  '기차': { word: '기차' },
  '사과': { word: '사과' },
  '학교': { word: '학교' },
};

test('active dictionary eligibility contains submitted words and solved answers only', () => {
  const eligible = getDictionaryEligibleWords(createState(), entries);
  assert.deepEqual(eligible, ['기차', '학교']);
  assert.equal(eligible.includes('기관'), false);
  assert.equal(eligible.includes('사과'), false);
});

test('eligibility de-duplicates board histories and filters missing metadata', () => {
  const eligible = getDictionaryEligibleWords(createState(), { '기차': entries['기차'] });
  assert.deepEqual(eligible, ['기차']);
});

test('post-game eligibility adds every answer without duplicating guesses', () => {
  const eligible = getDictionaryEligibleWords(createState({ gameOver: true }), entries);
  assert.deepEqual(eligible, ['기차', '학교', '기관', '사과']);
});

test('explicit nearby suggestions are eligible without exposing unrelated answers', () => {
  const eligible = getDictionaryEligibleWords(createState(), entries, ['기관']);
  assert.deepEqual(eligible, ['기차', '학교', '기관']);
  assert.equal(eligible.includes('사과'), false);
});

test('latest eligible submitted word is the default dictionary selection', () => {
  const state = createState({ gameOver: true });
  const eligible = getDictionaryEligibleWords(state, entries);
  assert.equal(getDefaultDictionaryWord(state, eligible), '학교');
});

test('lookup normalizes input and HTML escaping protects generated markup', () => {
  const snapshot = { entries: { '기관': { word: '기관' } } };
  assert.deepEqual(getKoreanDictionaryEntry('기관', snapshot), { word: '기관' });
  assert.equal(escapeHtml('<script>"x" & y</script>'), '&lt;script&gt;&quot;x&quot; &amp; y&lt;/script&gt;');
});
