import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHintPayload,
  getBoardGridHintVisuals,
  getBoardHintUse,
  getBoardHintUses,
  getHintUiOptions,
  getHintOptionPresentation,
} from '../src/hintUi.js';

const assistance = {
  scoringVersion: 1,
  hints: [
    { boardIndex: 0, type: 'part-of-speech', payload: ['noun'], cost: 2, usedAt: 1 },
    { boardIndex: 1, type: 'batchim-count', payload: 1, cost: 5, usedAt: 2 },
  ],
};

test('hint UI exposes the Korean and version-2 Pinyin contracts', () => {
  assert.deepEqual(getHintUiOptions('ko').map((option) => option.type), [
    'part-of-speech',
    'semantic-category',
    'batchim-count',
    'reveal-first-syllable',
  ]);
  assert.deepEqual(getHintUiOptions('zh').map((option) => option.type), [
    'syllable-boundary',
    'reveal-letter',
    'broad-meaning',
  ]);
  assert.deepEqual(getHintUiOptions('en'), []);
});

test('board hint lookup never leaks another board payload', () => {
  assert.deepEqual(getBoardHintUses(assistance, 0), [assistance.hints[0]]);
  assert.equal(getBoardHintUse(assistance, 0, 'batchim-count'), null);
});

test('hint payloads receive concise accessible labels', () => {
  assert.equal(formatHintPayload('ko', 'part-of-speech', ['noun', 'adverb']), 'Possible: noun · adverb');
  assert.equal(formatHintPayload('ko', 'semantic-category', ['People > Emotions']), 'Possible: People > Emotions');
  assert.equal(formatHintPayload('ko', 'batchim-count', 1), '1 of 2 syllables has batchim');
  assert.equal(formatHintPayload('ko', 'batchim-count', 2), '2 of 2 syllables have batchim');
  assert.equal(formatHintPayload('ko', 'reveal-first-syllable', '가'), '가');
  assert.equal(formatHintPayload('zh', 'syllable-boundary', 3), 'Syllable boundary: after letter 3');
  assert.equal(formatHintPayload('zh', 'syllable-boundary', 0), '');
  assert.equal(formatHintPayload('zh', 'reveal-letter', { index: 2, letter: 'e' }), 'Hint: letter E in position 3.');
  assert.equal(formatHintPayload('zh', 'reveal-letter', { index: -1, letter: 'e' }), '');
  assert.equal(formatHintPayload('zh', 'broad-meaning', 'a learner'), 'Meaning: a learner');
});

test('used Pinyin boundary and letter hints stay isolated to their target board grid', () => {
  const pinyinAssistance = {
    hints: [
      { boardIndex: 2, type: 'syllable-boundary', payload: 3, cost: 2, usedAt: 1 },
      { boardIndex: 2, type: 'reveal-letter', payload: { index: 4, letter: 'h' }, cost: 5, usedAt: 2 },
    ],
  };

  assert.deepEqual(getBoardGridHintVisuals(pinyinAssistance, 2), {
    boundaryAfter: 3,
    revealLetter: {
      index: 4,
      letter: 'H',
      ariaLabel: 'Hint: letter H in position 5.',
    },
  });
  assert.deepEqual(getBoardGridHintVisuals(pinyinAssistance, 1), {
    boundaryAfter: null,
    revealLetter: null,
  });
});

test('hint option presentation keeps exact costs visible for used and unavailable states', () => {
  const [boundary, letter] = getHintUiOptions('zh');

  assert.deepEqual(getHintOptionPresentation(boundary, {
    used: { payload: 3 },
    available: true,
  }), {
    state: 'used',
    disabled: true,
    costLabel: '−2 points',
    statusLabel: 'Used',
    ariaLabel: 'Syllable boundary, −2 points, Used',
  });
  assert.deepEqual(getHintOptionPresentation(letter, {
    used: null,
    available: false,
  }), {
    state: 'unavailable',
    disabled: true,
    costLabel: '−5 points',
    statusLabel: 'Unavailable',
    ariaLabel: 'Reveal a letter, −5 points, Unavailable',
  });
});
