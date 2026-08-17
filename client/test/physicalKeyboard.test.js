import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePhysicalKeyboardEvent } from '../src/physicalKeyboard.js';

class DomLikeElement {
  constructor(localName, { attributes = {}, classes = [], parent = null } = {}) {
    this.localName = localName;
    this.attributes = new Map(Object.entries(attributes));
    this.classes = new Set(classes);
    this.parentElement = parent;
  }

  matches(selector) {
    if (selector === '.chinese-guess-input') return this.classes.has('chinese-guess-input');
    if (selector === 'a[href]') return this.localName === 'a' && this.attributes.has('href');
    if (selector === '[contenteditable]:not([contenteditable="false"])') {
      return this.attributes.has('contenteditable')
        && this.attributes.get('contenteditable').toLowerCase() !== 'false';
    }
    return this.localName === selector;
  }

  closest(selectorList) {
    const selectors = selectorList.split(',').map((selector) => selector.trim());
    for (let element = this; element; element = element.parentElement) {
      if (selectors.some((selector) => element.matches(selector))) return element;
    }
    return null;
  }

  get isContentEditable() {
    for (let element = this; element; element = element.parentElement) {
      if (!element.attributes.has('contenteditable')) continue;
      const value = element.attributes.get('contenteditable').trim().toLowerCase();
      if (value === 'false') return false;
      if (value === '' || value === 'true' || value === 'plaintext-only') return true;
    }
    return false;
  }
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
    const button = new DomLikeElement('button');
    const link = new DomLikeElement('a', { attributes: { href: '/help' } });
    const editable = new DomLikeElement('div', { attributes: { contenteditable: 'true' } });
    const targets = [
      ['nested button child', new DomLikeElement('span', { parent: button })],
      ['nested link child', new DomLikeElement('strong', { parent: link })],
      ['input', new DomLikeElement('input')],
      ['select', new DomLikeElement('select')],
      ['textarea', new DomLikeElement('textarea')],
      ['summary', new DomLikeElement('summary')],
      ['inherited contenteditable child', new DomLikeElement('em', { parent: editable })],
    ];

    for (const [label, target] of targets) {
      const { event, submissions } = dispatchEnter(target);
      assert.equal(event.defaultPrevented, false, `${label} Enter was prevented`);
      assert.deepEqual(submissions, [], `${label} Enter submitted a guess`);
    }
  });

  await t.test('a focusable contenteditable=false island stops inherited editability', () => {
    const editable = new DomLikeElement('div', { attributes: { contenteditable: 'true' } });
    const falseIsland = new DomLikeElement('span', {
      attributes: { contenteditable: 'false', tabindex: '0' },
      parent: editable,
    });
    assert.equal(falseIsland.isContentEditable, false);

    const { event, submissions } = dispatchEnter(falseIsland);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(submissions, ['ENTER']);
  });

  await t.test('the game surface submits one guess', () => {
    const { event, submissions } = dispatchEnter(new DomLikeElement('main'));

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(submissions, ['ENTER']);
  });

  await t.test('the Pinyin input submits exactly once', () => {
    const { event, submissions } = dispatchEnter(new DomLikeElement('input', {
      classes: ['chinese-guess-input'],
    }));

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(submissions, ['ENTER']);
  });
});
