import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHintPayload,
  getBoardHintUse,
  getBoardHintUses,
  getHintUiOptions,
} from '../src/hintUi.js';

const assistance = {
  scoringVersion: 1,
  hints: [
    { boardIndex: 0, type: 'part-of-speech', payload: ['noun'], cost: 2, usedAt: 1 },
    { boardIndex: 1, type: 'batchim-count', payload: 1, cost: 5, usedAt: 2 },
  ],
};

test('hint UI exposes language-specific graduated options', () => {
  assert.deepEqual(getHintUiOptions('ko').map((option) => option.type), [
    'part-of-speech',
    'semantic-category',
    'batchim-count',
    'reveal-first-syllable',
  ]);
  assert.deepEqual(getHintUiOptions('zh').map((option) => option.type), [
    'tone-pattern',
    'pinyin',
    'broad-meaning',
    'reveal-first-character',
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
  assert.equal(formatHintPayload('zh', 'tone-pattern', ['2', '5']), 'Tone pattern: tone 2 + neutral tone');
  assert.equal(formatHintPayload('zh', 'pinyin', 'xué sheng'), 'Pinyin: xué sheng');
  assert.equal(formatHintPayload('zh', 'broad-meaning', 'a person enrolled in learning'), 'Meaning: a person enrolled in learning');
  assert.equal(formatHintPayload('zh', 'reveal-first-character', '学'), 'First character: 学');
});
