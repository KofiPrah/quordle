import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePhysicalKeyboardEvent } from '../src/physicalKeyboard.js';

function createKeyboardTarget({ interactiveSelector = null, chineseInput = false } = {}) {
  return {
    matches: (selector) => chineseInput && selector === '.chinese-guess-input',
    closest: (selector) => selector.split(',').map((part) => part.trim()).includes(interactiveSelector)
      ? true
      : null,
  };
}

function dispatchEnter(target) {
  const boundary = new EventTarget();
  const submissions = [];
  boundary.addEventListener('keydown', (event) => handlePhysicalKeyboardEvent(event, {
    activeOverlay: null,
    currentLanguage: 'zh',
    chineseCompositionActive: false,
    handleKeyPress: (key) => submissions.push(key),
    keyEnter: 'ENTER',
  }));

  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, {
    key: { value: 'Enter' },
    target: { value: target },
    ctrlKey: { value: false },
    metaKey: { value: false },
    altKey: { value: false },
    isComposing: { value: false },
  });
  boundary.dispatchEvent(event);
  return { event, submissions };
}

test('document Enter routing preserves native controls and submits only from game input paths', async (t) => {
  await t.test('interactive controls keep native Enter activation', () => {
    for (const interactiveSelector of [
      'button',
      'a[href]',
      'input',
      'select',
      'textarea',
      'summary',
      '[contenteditable]:not([contenteditable="false"])',
    ]) {
      const { event, submissions } = dispatchEnter(createKeyboardTarget({ interactiveSelector }));
      assert.equal(event.defaultPrevented, false, `${interactiveSelector} Enter was prevented`);
      assert.deepEqual(submissions, [], `${interactiveSelector} Enter submitted a guess`);
    }
  });

  await t.test('the game surface submits one guess', () => {
    const { event, submissions } = dispatchEnter(createKeyboardTarget());

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(submissions, ['ENTER']);
  });

  await t.test('the Pinyin input submits exactly once', () => {
    const { event, submissions } = dispatchEnter(createKeyboardTarget({
      interactiveSelector: 'input',
      chineseInput: true,
    }));

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(submissions, ['ENTER']);
  });
});
