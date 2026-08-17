import test from 'node:test';
import assert from 'node:assert/strict';

const puzzleVariant = 'pinyin-latin-v2';
const catalog = [
  { id: '姐姐', hanzi: '姐姐', key: 'jiejie', pinyinMarked: 'jiě jie', tones: [3, 5], broadMeaning: 'an older female sibling' },
  { id: '公司', hanzi: '公司', key: 'gongsi', pinyinMarked: 'gōng sī', tones: [1, 1], broadMeaning: 'an organization formed to conduct business' },
  { id: '去年', hanzi: '去年', key: 'qunian', pinyinMarked: 'qù nián', tones: [4, 2], broadMeaning: 'the calendar year immediately before this one' },
  { id: '篮球', hanzi: '篮球', key: 'lanqiu', pinyinMarked: 'lán qiú', tones: [2, 2], broadMeaning: 'a team sport centered on shooting into a raised hoop' },
];

function createState({ gameOver = false } = {}) {
  return {
    language: 'zh',
    puzzleVariant,
    gameOver,
    boards: [
      { targetId: '姐姐', targetWord: 'jiejie', solved: true },
      { targetId: '公司', targetWord: 'gongsi', solved: false },
      { targetId: '去年', targetWord: 'qunian', solved: false },
      { targetId: '篮球', targetWord: 'lanqiu', solved: false },
    ],
  };
}

test('a solved Pinyin board immediately renders canonical Hanzi, marked Pinyin, tones, and broad meaning', async () => {
  const learning = await import('../src/pinyinLearning.js');
  const surface = learning.createPinyinLearningSurface(catalog);
  const html = surface.renderPinyinLearningSummary(createState(), 0);
  assert.equal(
    html,
    '<span class="pinyin-learning-summary" data-learning-target="姐姐"><strong class="pinyin-learning-hanzi" lang="zh-Hans">姐姐</strong><span class="pinyin-learning-pronunciation" lang="zh-Latn" aria-label="Pinyin: jiě jie">jiě jie</span><span class="pinyin-learning-tones" aria-label="Tones: 3 and neutral">Tones 3 · neutral</span><span class="pinyin-learning-meaning">an older female sibling</span></span>',
  );
});

test('Pinyin learning lookup reveals solved targets while active and all four targets only after completion', async () => {
  const learning = await import('../src/pinyinLearning.js');
  const surface = learning.createPinyinLearningSurface(catalog);
  const active = surface.getVisiblePinyinLearningEntries(createState());
  assert.deepEqual(active.map((entry) => entry.id), ['姐姐']);
  assert.equal(JSON.stringify(active).includes('公司'), false);
  assert.equal(JSON.stringify(active).includes('gongsi'), false);
  assert.equal(surface.renderPinyinLearningSummary(createState(), 1), '');

  const completed = surface.getVisiblePinyinLearningEntries(createState({ gameOver: true }));
  assert.deepEqual(completed.map((entry) => entry.id), ['姐姐', '公司', '去年', '篮球']);
  assert.deepEqual(completed.map((entry) => entry.broadMeaning), [
    'an older female sibling',
    'an organization formed to conduct business',
    'the calendar year immediately before this one',
    'a team sport centered on shooting into a raised hoop',
  ]);
});

test('a solved or completed board fails closed when canonical learning metadata is missing or contradictory', async () => {
  const learning = await import('../src/pinyinLearning.js');
  const surface = learning.createPinyinLearningSurface(catalog);
  const missing = createState();
  missing.boards[0] = { ...missing.boards[0], targetWord: 'wrongkey' };

  assert.throws(
    () => surface.requirePinyinLearningMetadata(missing, 0),
    /Missing canonical Pinyin learning metadata for solved board 1/,
  );
});
