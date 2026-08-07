import test from 'node:test';
import assert from 'node:assert/strict';
import { getBotCompletionStatus, getBotLanguagePresentation } from '../botPresentation.js';

test('Chinese bot reporting uses the requested label and English status fields', () => {
  assert.deepEqual(getBotLanguagePresentation('zh'), {
    language: 'zh', label: '🇨🇳 Chinese', boardsLabel: 'Boards', guessesLabel: 'Guesses',
  });
  assert.deepEqual(getBotCompletionStatus(true), { emoji: '🏆', label: 'won' });
  assert.deepEqual(getBotCompletionStatus(false), { emoji: '😔', label: 'lost' });
});
