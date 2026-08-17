const KOREAN_HINT_UI_OPTIONS = Object.freeze([
  {
    type: 'part-of-speech',
    label: 'Part of speech',
    cost: 2,
    description: 'Possible grammatical roles for this word.',
  },
  {
    type: 'semantic-category',
    label: 'Semantic category',
    cost: 3,
    description: 'Possible broad meaning categories from KRDICT.',
  },
  {
    type: 'batchim-count',
    label: 'Batchim count',
    cost: 5,
    description: 'How many syllables end with a final consonant.',
  },
  {
    type: 'reveal-first-syllable',
    label: 'Reveal first syllable',
    cost: 10,
    description: 'Shows the answer’s first Hangul syllable.',
  },
]);

const CHINESE_HINT_UI_OPTIONS = Object.freeze([
  {
    type: 'syllable-boundary',
    label: 'Syllable boundary',
    cost: 2,
    description: 'Shows where the first Pinyin syllable ends.',
  },
  {
    type: 'reveal-letter',
    label: 'Reveal a letter',
    cost: 5,
    description: 'Shows one unresolved letter and its position.',
  },
  {
    type: 'broad-meaning',
    label: 'Broad meaning',
    cost: 7,
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
        ? `Hint: letter ${letter.toUpperCase()} in position ${index + 1}.`
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

export function getBoardGridHintVisuals(assistance, boardIndex) {
  const boundaryUse = getBoardHintUse(assistance, boardIndex, 'syllable-boundary');
  const boundary = Number(boundaryUse?.payload);
  const letterUse = getBoardHintUse(assistance, boardIndex, 'reveal-letter');
  const index = Number(letterUse?.payload?.index);
  const letter = typeof letterUse?.payload?.letter === 'string' ? letterUse.payload.letter : '';
  const revealLetter = Number.isInteger(index) && index >= 0 && /^[a-z]$/iu.test(letter)
    ? {
        index,
        letter: letter.toUpperCase(),
        ariaLabel: `Hint: letter ${letter.toUpperCase()} in position ${index + 1}.`,
      }
    : null;
  return {
    boundaryAfter: Number.isInteger(boundary) && boundary > 0 ? boundary : null,
    revealLetter,
  };
}

export function getHintOptionPresentation(option, {
  used = null,
  available = false,
  pending = false,
  requestPending = false,
} = {}) {
  const cost = Number(option?.cost);
  const costLabel = `−${Number.isFinite(cost) ? cost : 0} points`;
  const state = used ? 'used' : pending ? 'pending' : available ? 'available' : 'unavailable';
  const statusLabel = state === 'used'
    ? 'Used'
    : state === 'pending'
      ? 'Requesting\u2026'
      : state === 'unavailable'
        ? 'Unavailable'
        : '';
  const accessibleState = statusLabel || 'Available';
  return {
    state,
    disabled: Boolean(used) || !available || Boolean(requestPending),
    costLabel,
    statusLabel,
    ariaLabel: `${option?.label ?? 'Hint'}, ${costLabel}, ${accessibleState}`,
  };
}
