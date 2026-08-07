const HAN_RE = /^\p{Script=Han}{1,2}$/u;
const PINYIN_RE = /^[a-zA-ZüÜāÁáǍǎÀàĒēÉéĚěÈèĪīÍíǏǐÌìŌōÓóǑǒÒòŪūÚúǓǔÙùǕǖǗǘǙǚǛǜ0-5\s:'\-·]+$/u;

export function createChineseInputState() {
  return { draft: '', selectedWord: '', selectedPinyin: '', source: null, error: '' };
}

export function getChineseInputValue(state) {
  return state?.selectedWord || state?.draft || '';
}

export function updateChineseInput(state, value) {
  const input = String(value ?? '').normalize('NFC').slice(0, 32);
  if (!input) return createChineseInputState();
  if (HAN_RE.test(input)) {
    return { draft: '', selectedWord: input, selectedPinyin: '', source: 'hanzi', error: '' };
  }
  if (PINYIN_RE.test(input)) {
    return { draft: input, selectedWord: '', selectedPinyin: '', source: 'pinyin', error: '' };
  }
  return { ...state, error: 'Use either Simplified Chinese characters or pinyin, not a mixed input.' };
}

export function appendChinesePinyinKey(state, key) {
  const current = state?.source === 'pinyin' ? state.draft : '';
  return updateChineseInput(state, `${current}${String(key ?? '').toLowerCase()}`);
}

export function selectChineseCandidate(state, candidate) {
  if (!candidate?.word) return state;
  return {
    ...state,
    selectedWord: candidate.word.normalize('NFC'),
    selectedPinyin: candidate.pinyinMarked || '',
    source: 'pinyin',
    error: '',
  };
}

export function backspaceChineseInput(state) {
  if (state?.selectedWord && state.source === 'pinyin') {
    return { ...state, selectedWord: '', selectedPinyin: '', error: '' };
  }
  const value = getChineseInputValue(state);
  return updateChineseInput(state, Array.from(value).slice(0, -1).join(''));
}
