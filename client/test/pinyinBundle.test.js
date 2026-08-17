import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const clientDirectory = fileURLToPath(new URL('..', import.meta.url));
const configFile = fileURLToPath(new URL('../vite.config.js', import.meta.url));

test('production entry excludes inactive Pinyin guess-key shards', { timeout: 30_000 }, async () => {
  const result = await build({
    root: clientDirectory,
    configFile,
    logLevel: 'silent',
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output ?? []);
  const entryCode = outputs
    .filter((entry) => entry.type === 'chunk' && entry.isEntry)
    .map((entry) => entry.code)
    .join('\n');
  const lazyChunkCode = outputs
    .filter((entry) => entry.type === 'chunk' && !entry.isEntry)
    .map((entry) => entry.code)
    .join('\n');

  assert.ok(entryCode.length > 0);
  assert.equal(entryCode.includes('pinyin-learning-summary'), true, 'solved-card learning markup is not wired into the production entry');
  for (const inactiveSentinel of ['adie', 'anchuang', 'baishuang']) {
    assert.equal(entryCode.includes(`"${inactiveSentinel}"`), false, `${inactiveSentinel} leaked into the entry chunk`);
    assert.equal(lazyChunkCode.includes(`"${inactiveSentinel}"`), true, `${inactiveSentinel} is not lazy-loadable`);
  }
});
