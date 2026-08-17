import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const clientDirectory = fileURLToPath(new URL('..', import.meta.url));
const configFile = fileURLToPath(new URL('../vite.config.js', import.meta.url));
let productionOutputsPromise;

function getProductionOutputs() {
  productionOutputsPromise ??= build({
    root: clientDirectory,
    configFile,
    logLevel: 'silent',
    build: { write: false },
  }).then((result) => (Array.isArray(result) ? result : [result])
    .flatMap((entry) => entry.output ?? []));
  return productionOutputsPromise;
}

function getCompiledDeclarations(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[{}])${escapedSelector}\\{`).exec(css);
  assert.ok(match, `compiled CSS is missing ${selector}`);
  const start = match.index + (match[0].startsWith(selector) ? 0 : 1);
  const declarationStart = start + selector.length + 1;
  const end = css.indexOf('}', declarationStart);
  assert.notEqual(end, -1, `compiled CSS has an unterminated ${selector} rule`);
  return Object.fromEntries(css
    .slice(declarationStart, end)
    .split(';')
    .filter(Boolean)
    .map((declaration) => {
      const separator = declaration.indexOf(':');
      return [declaration.slice(0, separator), declaration.slice(separator + 1)];
    }));
}

test('production entry excludes inactive Pinyin guess-key shards', { timeout: 30_000 }, async () => {
  const outputs = await getProductionOutputs();
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

test('production CSS gives Chinese solved learning cards a readable full-width flow', { timeout: 30_000 }, async () => {
  const outputs = await getProductionOutputs();
  const css = outputs
    .filter((entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'))
    .map((entry) => String(entry.source))
    .join('\n');
  const baseStrip = getCompiledDeclarations(css, '.solved-boards-strip');
  const chineseStrip = getCompiledDeclarations(css, '.lang-zh .solved-boards-strip');
  const pronunciation = getCompiledDeclarations(css, '.pinyin-learning-pronunciation');

  assert.equal(baseStrip['grid-template-columns'], 'repeat(2,minmax(0,1fr))');
  assert.equal(chineseStrip['grid-template-columns'], 'minmax(0,1fr)');
  assert.notEqual(pronunciation.overflow, 'hidden');
  assert.notEqual(pronunciation['white-space'], 'nowrap');
  assert.equal(pronunciation['overflow-wrap'], 'anywhere');
});
