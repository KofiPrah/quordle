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

test('Chinese dictionary eligibility hides unsolved targets until game over', () => {
  const state = {
    language: 'zh',
    gameOver: false,
    boards: [
      { targetWord: '学生', guesses: ['学校'], solved: false },
      { targetWord: '老师', guesses: ['学校'], solved: false },
      { targetWord: '朋友', guesses: ['学校'], solved: false },
      { targetWord: '工作', guesses: ['学校'], solved: false },
    ],
  };
  assert.deepEqual(getDictionaryEligibleWords(state), ['学校']);
  assert.equal(getDictionaryEligibleWords(state).includes('学生'), false);
  assert.deepEqual(getDictionaryEligibleWords({ ...state, gameOver: true }), ['学校', '学生', '老师', '朋友', '工作']);
});

test('Pinyin dictionary and learning identity use targetId without exposing guesses or unsolved targets', () => {
  const state = {
    language: 'zh',
    puzzleVariant: 'pinyin-latin-v2',
    gameOver: false,
    boards: [
      { targetWord: 'xuesheng', targetId: '学生', guesses: ['xuesheng'], solved: true },
      { targetWord: 'laoshi', targetId: '老师', guesses: ['xuesheng'], solved: false },
      { targetWord: 'pengyou', targetId: '朋友', guesses: ['xuesheng'], solved: false },
      { targetWord: 'gongzuo', targetId: '工作', guesses: ['xuesheng'], solved: false },
    ],
  };

  assert.deepEqual(getDictionaryEligibleWords(state), ['学生']);
  assert.equal(getDictionaryEligibleWords(state).includes('xuesheng'), false);
  assert.deepEqual(
    getDictionaryEligibleWords({ ...state, gameOver: true }),
    ['学生', '老师', '朋友', '工作'],
  );
  assert.equal(getDefaultDictionaryWord(state, ['学生']), '学生');
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
