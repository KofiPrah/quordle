import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHintPayload,
  getBoardHintUse,
  getBoardHintUses,
  HINT_UI_OPTIONS,
} from '../src/hintUi.js';

const assistance = {
  scoringVersion: 1,
  hints: [
    { boardIndex: 0, type: 'part-of-speech', payload: ['noun'], cost: 2, usedAt: 1 },
    { boardIndex: 1, type: 'batchim-count', payload: 1, cost: 5, usedAt: 2 },
  ],
};

test('hint UI exposes the four graduated options', () => {
  assert.deepEqual(HINT_UI_OPTIONS.map((option) => option.type), [
    'part-of-speech',
    'semantic-category',
    'batchim-count',
    'reveal-first-syllable',
  ]);
});

test('board hint lookup never leaks another board payload', () => {
  assert.deepEqual(getBoardHintUses(assistance, 0), [assistance.hints[0]]);
  assert.equal(getBoardHintUse(assistance, 0, 'batchim-count'), null);
});

test('hint payloads receive concise accessible labels', () => {
  assert.equal(formatHintPayload('part-of-speech', ['noun', 'adverb']), 'Possible: noun · adverb');
  assert.equal(formatHintPayload('semantic-category', ['People > Emotions']), 'Possible: People > Emotions');
  assert.equal(formatHintPayload('batchim-count', 1), '1 of 2 syllables has batchim');
  assert.equal(formatHintPayload('batchim-count', 2), '2 of 2 syllables have batchim');
  assert.equal(formatHintPayload('reveal-first-syllable', '가'), '가');
});
