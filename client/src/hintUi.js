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
    type: 'tone-pattern',
    label: 'Tone pattern',
    description: 'Shows the tones of both syllables without revealing their sounds.',
  },
  {
    type: 'pinyin-initials',
    label: 'Pinyin initials',
    description: 'Shows only the opening sound of each pinyin syllable.',
  },
  {
    type: 'broad-meaning',
    label: 'Broad meaning',
    description: 'Shows a curated English meaning clue.',
  },
  {
    type: 'reveal-first-character',
    label: 'Reveal first character',
    description: 'Shows the answer’s first Simplified Chinese character.',
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
    if (type === 'tone-pattern') {
      const tones = Array.isArray(payload) ? payload : [];
      if (tones.length !== 2 || tones.some((tone) => !['1', '2', '3', '4', '5'].includes(String(tone)))) return '';
      const labels = tones.map((tone) => String(tone) === '5' ? 'neutral tone' : `tone ${tone}`);
      return `Tone pattern: ${labels.join(' + ')}`;
    }
    if (type === 'pinyin-initials') {
      const initials = Array.isArray(payload) ? payload : [];
      if (initials.length !== 2 || initials.some((initial) => typeof initial !== 'string' || !initial)) return '';
      return `Pinyin initials: ${initials.map((initial) => initial === '∅' ? 'no initial' : `${initial}…`).join(' · ')}`;
    }
    if (type === 'broad-meaning') return payload ? `Meaning: ${String(payload)}` : '';
    if (type === 'reveal-first-character') return payload ? `First character: ${String(payload)}` : '';
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
