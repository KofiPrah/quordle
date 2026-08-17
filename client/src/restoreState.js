export function getRestoreLanguageConfig(language, wordLength, getLegacyLanguageConfig) {
  return language === 'zh'
    ? { filterCharRegex: /[^a-z]/giu, wordLength }
    : getLegacyLanguageConfig(language);
}

export function normalizeRestoredCurrentGuess(value, language, wordLength, config) {
  const languageConfig = config ?? getRestoreLanguageConfig(language, wordLength, () => ({
    filterCharRegex: /[^a-z]/giu,
    wordLength,
  }));
  let currentGuess = typeof value === 'string' ? value : '';
  if (language === 'en') currentGuess = currentGuess.toLowerCase();
  else currentGuess = currentGuess.normalize('NFC');
  return currentGuess
    .replace(languageConfig.filterCharRegex, '')
    .slice(0, languageConfig.wordLength);
}
