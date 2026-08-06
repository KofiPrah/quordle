export const HINT_UI_OPTIONS = Object.freeze([
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

export function getBoardHintUses(assistance, boardIndex) {
  if (!Array.isArray(assistance?.hints)) return [];
  return assistance.hints.filter((hint) => hint?.boardIndex === boardIndex);
}

export function getBoardHintUse(assistance, boardIndex, type) {
  return getBoardHintUses(assistance, boardIndex).find((hint) => hint.type === type) ?? null;
}

export function formatHintPayload(type, payload) {
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
