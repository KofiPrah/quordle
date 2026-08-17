import test from 'node:test';
import assert from 'node:assert/strict';

test('Chinese fallback restore keeps a dynamic-length current guess when the dedicated draft is absent', async () => {
  const { normalizeRestoredCurrentGuess } = await import('../src/restoreState.js');
  assert.equal(normalizeRestoredCurrentGuess('JIE3 JIE3', 'zh', 6), 'JIEJIE');
  assert.equal(normalizeRestoredCurrentGuess('GONG-SI-extra', 'zh', 6), 'GONGSI');
});
