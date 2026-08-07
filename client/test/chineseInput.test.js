import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendChinesePinyinKey,
  backspaceChineseInput,
  createChineseInputState,
  getChineseInputValue,
  selectChineseCandidate,
  updateChineseInput,
} from '../src/chineseInput.js';

test('Chinese input accepts direct Hanzi or pinyin and rejects mixed scripts without losing the draft', () => {
  let state = updateChineseInput(createChineseInputState(), '学生');
  assert.equal(getChineseInputValue(state), '学生');
  state = updateChineseInput(state, 'xuéshēng');
  assert.equal(state.draft, 'xuéshēng');
  const rejected = updateChineseInput(state, '学sheng');
  assert.equal(rejected.draft, 'xuéshēng');
  assert.match(rejected.error, /either Simplified Chinese characters or pinyin/);
});

test('candidate selection is separate from submission and backspace restores the pinyin draft', () => {
  let state = updateChineseInput(createChineseInputState(), 'xuesheng');
  state = selectChineseCandidate(state, { word: '学生', pinyinMarked: 'xué shēng' });
  assert.equal(state.selectedWord, '学生');
  assert.equal(state.draft, 'xuesheng');
  state = backspaceChineseInput(state);
  assert.equal(state.selectedWord, '');
  assert.equal(state.draft, 'xuesheng');
});

test('virtual QWERTY input starts a fresh pinyin draft after direct Hanzi', () => {
  let state = updateChineseInput(createChineseInputState(), '学生');
  state = appendChinesePinyinKey(state, 'X');
  assert.equal(state.draft, 'x');
  assert.equal(state.selectedWord, '');
});
