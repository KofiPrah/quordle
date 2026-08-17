const KOREAN_HINT_UI_OPTIONS = Object.freeze([
  {
    type: 'part-of-speech',
    label: 'Part of speech',
    description: 'Possible grammatical roles for this word.',
  },
  {
    type: 'semantic-category',
    label: 'Semantic category',
    description: 'Possible broad meaning categories from KRDICT.',
  },
  {
    type: 'batchim-count',
    label: 'Batchim count',
    description: 'How many syllables end with a final consonant.',
  },
  {
    type: 'reveal-first-syllable',
    label: 'Reveal first syllable',
    description: 'Shows the answer’s first Hangul syllable.',
  },
]);

const CHINESE_HINT_UI_OPTIONS = Object.freeze([
  {
    type: 'syllable-boundary',
    label: 'Syllable boundary',
    description: 'Shows where the first Pinyin syllable ends.',
  },
  {
    type: 'reveal-letter',
    label: 'Reveal a letter',
    description: 'Shows one unresolved letter and its position.',
  },
  {
    type: 'broad-meaning',
    label: 'Broad meaning',
    description: 'Shows a curated English meaning clue.',
  },
]);

export function getHintUiOptions(language) {
  if (language === 'zh') return CHINESE_HINT_UI_OPTIONS;
  if (language === 'ko') return KOREAN_HINT_UI_OPTIONS;
  return [];
}

export function getBoardHintUses(assistance, boardIndex) {
  if (!Array.isArray(assistance?.hints)) return [];
  return assistance.hints.filter((hint) => hint?.boardIndex === boardIndex);
}

export function getBoardHintUse(assistance, boardIndex, type) {
  return getBoardHintUses(assistance, boardIndex).find((hint) => hint.type === type) ?? null;
}

export function formatHintPayload(language, type, payload) {
  if (language === 'zh') {
    if (type === 'syllable-boundary') {
      const boundary = Number(payload);
      return Number.isInteger(boundary) && boundary > 0
        ? `Syllable boundary: after letter ${boundary}`
        : '';
    }
    if (type === 'reveal-letter') {
      const index = Number(payload?.index);
      const letter = typeof payload?.letter === 'string' ? payload.letter : '';
      return Number.isInteger(index) && index >= 0 && /^[a-z]$/iu.test(letter)
        ? `Letter hint: ${letter.toUpperCase()} in position ${index + 1}`
        : '';
    }
    if (type === 'broad-meaning') return payload ? `Meaning: ${String(payload)}` : '';
    return '';
  }
  if (type === 'part-of-speech' || type === 'semantic-category') {
    const values = Array.isArray(payload) ? payload.join(' · ') : String(payload ?? '');
    return values ? `Possible: ${values}` : '';
  }
  if (type === 'batchim-count') {
    const count = Number(payload);
    if (!Number.isInteger(count)) return '';
    return `${count} of 2 syllables ${count === 1 ? 'has' : 'have'} batchim`;
  }
  if (type === 'reveal-first-syllable') return String(payload ?? '');
  return '';
}
