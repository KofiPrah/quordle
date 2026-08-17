const INTERACTIVE_KEYBOARD_TARGET = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ');

function isInteractiveKeyboardTarget(target) {
  return Boolean(target?.closest?.(INTERACTIVE_KEYBOARD_TARGET));
}

export function handlePhysicalKeyboardEvent(event, {
  activeOverlay = null,
  closeActiveOverlay,
  currentLanguage,
  chineseCompositionActive = false,
  handleKeyPress,
  keyEnter = 'ENTER',
  keyBackspace = 'BACKSPACE',
  qwertyToJamo = {},
  isConsonant = () => false,
  isVowel = () => false,
} = {}) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (activeOverlay) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeActiveOverlay?.();
    }
    return;
  }

  if (currentLanguage === 'zh' && event.target?.matches?.('.chinese-guess-input')) {
    if (event.isComposing || chineseCompositionActive) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      handleKeyPress?.(keyEnter);
    }
    return;
  }

  if (isInteractiveKeyboardTarget(event.target)) return;

  if (event.key === 'Enter') {
    event.preventDefault();
    handleKeyPress?.(keyEnter);
  } else if (event.key === 'Backspace') {
    event.preventDefault();
    handleKeyPress?.(keyBackspace);
  } else if (currentLanguage === 'ko') {
    const character = event.key;
    const mapped = qwertyToJamo[character];
    if (mapped) {
      event.preventDefault();
      handleKeyPress?.(mapped);
    } else if (character.length === 1 && (isConsonant(character) || isVowel(character))) {
      event.preventDefault();
      handleKeyPress?.(character);
    }
  } else if (/^[a-zA-Z]$/.test(event.key)) {
    event.preventDefault();
    handleKeyPress?.(event.key.toUpperCase());
  }
}
